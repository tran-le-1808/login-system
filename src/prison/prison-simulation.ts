import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { applyAction } from './shared/actions';
import { PRISON_CONFIG as C } from './shared/config';
import {
  buildFullState,
  buildMeta,
  buildPrivate,
  buildTeamStorage,
  SnapshotDelta,
  type FullState,
  type GameSnapshot,
  type PrivateState,
  type TeamStorageView,
  type WorldMeta,
} from './shared/view';
import {
  addPlayerToWorld,
  removePlayerFromWorld,
  runTick,
  setPlayerConnected,
  type PlayerInfo,
} from './shared/world';
import {
  createOutbox,
  type ActionResult,
  type EngineEvent,
  type MoveInput,
  type Outbox,
  type PlayerAction,
  type WorldState,
} from './shared/types';

/** Đầu ra của mô phỏng — gateway (transport) cài đặt; mô phỏng không biết gì về Socket.IO */
export interface SimulationHooks {
  snapshot(s: GameSnapshot): void;
  events(events: EngineEvent[]): void;
  privateState(playerId: string, s: PrivateState): void;
  teamStorage(s: TeamStorageView): void;
  meta(m: WorldMeta): void;
  checkpoint(world: WorldState, reason: string): void;
  outcome(world: WorldState): void;
  fatal(error: unknown): void;
}

export interface SimulationClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

const realClock: SimulationClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

/**
 * Chủ mô phỏng có thẩm quyền của MỘT phòng. Toàn bộ trạng thái nằm trong RAM;
 * không truy vấn / ghi MongoDB trong tick (checkpoint giao cho hook, ghi bất đồng bộ bên ngoài).
 */
export class RoomSimulation {
  private timer: unknown = null;
  private inputs = new Map<string, MoveInput[]>();
  private lastQueuedSeq = new Map<string, number>();
  private delta = new SnapshotDelta();
  private lastCheckpointAt = 0;
  private lastKeyframeAt = -Infinity;
  private consecutiveErrors = 0;
  private finished = false;
  paused = false;
  /** Thời lượng tick gần nhất (ms) — để đo hiệu năng */
  lastTickMs = 0;
  maxTickMs = 0;

  constructor(
    readonly roomCode: string,
    readonly world: WorldState,
    private readonly hooks: SimulationHooks,
    private readonly clock: SimulationClock = realClock,
  ) {
    this.lastCheckpointAt = world.time;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null || this.finished) return;
    this.timer = this.clock.setInterval(
      () => this.tick(),
      1000 / C.net.tickRate,
    );
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearInterval(this.timer);
    this.timer = null;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Xếp hàng input; bỏ input trùng / cũ ngay ở cửa (out-of-order, replay) */
  enqueueInput(playerId: string, input: MoveInput): boolean {
    const p = this.world.players[playerId];
    if (!p) return false;
    const last = Math.max(p.lastSeq, this.lastQueuedSeq.get(playerId) ?? 0);
    if (input.sequence <= last) return false;
    this.lastQueuedSeq.set(playerId, input.sequence);
    let q = this.inputs.get(playerId);
    if (!q) this.inputs.set(playerId, (q = []));
    q.push(input);
    if (q.length > C.net.inputQueueMax)
      q.splice(0, q.length - C.net.inputQueueMax);
    return true;
  }

  /** Thao tác (ngoài vòng tick, cùng luồng): commit rồi mới phát sự kiện */
  action(
    playerId: string,
    action: PlayerAction,
    requestId: string,
  ): ActionResult {
    const out = createOutbox();
    const res = applyAction(this.world, out, playerId, action, requestId);
    this.flush(out);
    return res;
  }

  addPlayer(info: PlayerInfo): boolean {
    const out = createOutbox();
    const p = addPlayerToWorld(this.world, info);
    out.dirtyMeta = true;
    if (p) out.dirtyInventories.add(p.id);
    this.flush(out);
    return !!p;
  }

  removePlayer(playerId: string, reason: string): void {
    const out = createOutbox();
    removePlayerFromWorld(this.world, out, playerId, reason);
    this.inputs.delete(playerId);
    this.lastQueuedSeq.delete(playerId);
    this.flush(out);
    this.hooks.checkpoint(this.world, 'player-removed');
  }

  setConnected(playerId: string, connected: boolean): void {
    const out = createOutbox();
    setPlayerConnected(this.world, out, playerId, connected);
    if (!connected) this.inputs.delete(playerId);
    this.flush(out);
  }

  fullState(): FullState {
    return buildFullState(this.world, this.roomCode, this.clock.now());
  }

  privateOf(playerId: string): PrivateState | null {
    return buildPrivate(this.world, playerId);
  }

  /** Một tick: lỗi bị cô lập trong phòng này (không làm sập phòng khác) */
  tick(): void {
    if (this.paused || this.finished) return;
    const t0 = performance.now();
    try {
      const batch = new Map<string, MoveInput[]>();
      for (const [pid, q] of this.inputs) {
        if (!q.length) continue;
        batch.set(pid, q.splice(0, C.net.maxInputsPerTick));
      }
      const out = createOutbox();
      runTick(this.world, out, batch);
      this.flush(out);
      const snapEvery = Math.max(
        1,
        Math.round(C.net.tickRate / C.net.snapshotRate),
      );
      if (this.world.tick % snapEvery === 0) {
        const keyframe =
          this.world.time - this.lastKeyframeAt >= C.net.keyframeSeconds;
        if (keyframe) this.lastKeyframeAt = this.world.time;
        this.hooks.snapshot(
          this.delta.build(
            this.world,
            this.roomCode,
            this.clock.now(),
            keyframe,
          ),
        );
      }
      if (
        this.world.time - this.lastCheckpointAt >=
        C.persistence.checkpointSeconds
      ) {
        this.lastCheckpointAt = this.world.time;
        this.hooks.checkpoint(this.world, 'interval');
      }
      if (this.world.outcome) {
        this.finished = true;
        this.stop();
        this.hooks.snapshot(
          this.delta.build(this.world, this.roomCode, this.clock.now(), true),
        );
        this.hooks.checkpoint(this.world, 'outcome');
        this.hooks.outcome(this.world);
      }
      this.consecutiveErrors = 0;
    } catch (e) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= 5) {
        this.paused = true;
        this.hooks.fatal(e);
      }
    } finally {
      this.lastTickMs = performance.now() - t0;
      this.maxTickMs = Math.max(this.maxTickMs, this.lastTickMs);
    }
  }

  private flush(out: Outbox): void {
    if (out.events.length) this.hooks.events(out.events);
    const priv = new Set<string>([...out.dirtyInventories, ...out.dirtyTrades]);
    for (const k of out.dirtyQuests) if (k !== 'team') priv.add(k);
    for (const pid of priv) {
      const s = buildPrivate(this.world, pid);
      if (s) this.hooks.privateState(pid, s);
    }
    if (out.dirtyTeamStorage)
      this.hooks.teamStorage(buildTeamStorage(this.world));
    if (out.dirtyMeta || out.dirtyQuests.has('team'))
      this.hooks.meta(buildMeta(this.world));
  }
}

/** Sổ đăng ký chủ mô phỏng: đảm bảo mỗi phòng chỉ có MỘT simulation owner */
@Injectable()
export class PrisonSimulationService implements OnModuleDestroy {
  private readonly logger = new Logger('PrisonSimulation');
  private sims = new Map<string, RoomSimulation>();

  create(
    roomCode: string,
    world: WorldState,
    hooks: SimulationHooks,
    clock?: SimulationClock,
  ): RoomSimulation {
    if (this.sims.has(roomCode))
      throw new Error(`Phòng ${roomCode} đã có simulation owner`);
    const sim = new RoomSimulation(roomCode, world, hooks, clock);
    this.sims.set(roomCode, sim);
    return sim;
  }

  get(roomCode: string): RoomSimulation | undefined {
    return this.sims.get(roomCode);
  }

  destroy(roomCode: string): void {
    const sim = this.sims.get(roomCode);
    if (!sim) return;
    sim.stop();
    this.sims.delete(roomCode);
  }

  count(): number {
    return this.sims.size;
  }

  stats(): { rooms: number; maxTickMs: number } {
    let maxTickMs = 0;
    for (const s of this.sims.values())
      maxTickMs = Math.max(maxTickMs, s.maxTickMs);
    return { rooms: this.sims.size, maxTickMs };
  }

  onModuleDestroy(): void {
    for (const s of this.sims.values()) s.stop();
    this.logger.log(`Dừng ${this.sims.size} mô phỏng`);
    this.sims.clear();
  }
}
