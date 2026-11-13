import { Injectable } from '@nestjs/common';
import {
  POOL_MAX_PLAYERS,
  POOL_RACE_OPTIONS,
  PoolGame,
  PoolRoomSettings,
  PoolSnapshot,
  PublicRoom,
  Room,
  RoomChatMessage,
  RoomPlayer,
  ShotRecord,
} from './pool.types';
import { configForPreset, POCKET_PRESETS } from './shared/physics/config';
import { simulateShot } from './shared/physics/simulator';
import { liftShot } from './shared/physics/clearance';
import {
  applyDecision,
  applyTimeoutFoul,
  decisionOptions,
  nextRack,
  recordRackWin,
  resolveShot,
  startMatch,
} from './shared/rules/engine';
import { isValidCuePlacement, withCueAt } from './shared/rules/rack';
import type { MatchConfig, PlayerIndex } from './shared/rules/types';
import {
  ballsHash,
  POOL_PROTOCOL_VERSION,
  PoolErrorCode,
  SHOT_CLOCK,
  shotCommandFromInput,
  validateOption,
  validatePlace,
  validateShotInput,
} from './shared/protocol';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAT_HISTORY = 50;
const MAX_PROCESSED_SHOTS = 300;
/** Hoạt cảnh đẩy cơ + chờ bi dừng hẳn trước khi được thao tác tiếp (ms) */
const STROKE_MS = 160;
const SETTLE_MS = 500;

export const DEFAULT_SETTINGS: PoolRoomSettings = {
  isPrivate: false,
  type: 'eight',
  raceTo: 3,
  breakRule: 'alternate',
  pocketPreset: 'wpa',
  shotClock: true,
  allowFullGuide: false,
  autoCall: true,
  ranked: false,
  spectators: true,
};

export type ActionResult<T = PoolGame> =
  | { ok: true; game: T }
  | { ok: false; code: PoolErrorCode; game?: PoolGame }
  | { ok: true; duplicate: true };

export type ShootResult =
  | { ok: true; game: PoolGame; shot: ShotRecord }
  | { ok: false; code: PoolErrorCode; game?: PoolGame }
  | { ok: true; duplicate: true };

const err = (code: PoolErrorCode, game?: PoolGame) =>
  ({ ok: false, code, game }) as const;

/** Phòng bida lỗ (bộ nhớ trong). Server chạy vật lý + luật, client chỉ gửi input. */
@Injectable()
export class PoolRoomService {
  private rooms = new Map<string, Room>();
  private userRoom = new Map<string, string>();
  /** Giờ hệ thống (ghi đè trong test) */
  now: () => number = () => Date.now();
  /** Hệ số thời gian chờ bi lăn trước khi được thao tác tiếp (test e2e đặt 0 để chạy nhanh) */
  busyScale = 1;

  private generateCode(): string {
    let code = '';
    do {
      code = Array.from(
        { length: 6 },
        () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  normalizeCode(code: unknown): string {
    return typeof code === 'string' ? code.trim().toUpperCase() : '';
  }
  get(code: string) {
    return this.rooms.get(this.normalizeCode(code));
  }
  all() {
    return Array.from(this.rooms.values());
  }
  getRoomOfUser(userId: string) {
    const code = this.userRoom.get(userId);
    return code ? this.rooms.get(code) : undefined;
  }
  findPlayer(room: Room, userId: string) {
    return room.players.find((p) => p.userId === userId);
  }
  findSpectator(room: Room, userId: string) {
    return room.spectators.find((s) => s.userId === userId);
  }

  toPublic(room: Room): PublicRoom {
    return {
      code: room.code,
      hostId: room.hostId,
      status: room.status,
      settings: room.settings,
      createdAt: room.createdAt,
      spectators: room.spectators.length,
      players: room.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          userId: p.userId,
          name: p.name,
          avatar: p.avatar,
          seat: p.seat,
          ready: p.ready,
          connected: p.connected,
          joinedAt: p.joinedAt,
          elo: p.elo,
        })),
    };
  }

  /** Phòng công khai: đang chờ người (để vào chơi) hoặc đang đấu (để xem) */
  listPublic(): PublicRoom[] {
    return this.all()
      .filter(
        (r) =>
          !r.settings.isPrivate &&
          ((r.status === 'lobby' && r.players.length < POOL_MAX_PLAYERS) ||
            (r.status === 'playing' && r.settings.spectators)),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 40)
      .map((r) => this.toPublic(r));
  }

  create(
    user: Pick<RoomPlayer, 'userId' | 'name' | 'avatar' | 'socketId'>,
    settings?: Partial<PoolRoomSettings>,
  ): Room {
    const room: Room = {
      code: this.generateCode(),
      hostId: user.userId,
      status: 'lobby',
      settings: { ...DEFAULT_SETTINGS },
      players: [],
      spectators: [],
      game: null,
      chat: [],
      voice: {},
      processedShots: new Set(),
      createdAt: this.now(),
    };
    this.rooms.set(room.code, room);
    this.addPlayer(room, user);
    if (settings) this.updateSettings(room, settings);
    return room;
  }

  addPlayer(
    room: Room,
    user: Pick<RoomPlayer, 'userId' | 'name' | 'avatar' | 'socketId'>,
  ): RoomPlayer {
    const taken = new Set(room.players.map((p) => p.seat));
    const seat = [0, 1].find((s) => !taken.has(s)) ?? 0;
    const player: RoomPlayer = {
      ...user,
      seat,
      ready: false,
      connected: true,
      joinedAt: this.now(),
    };
    room.players.push(player);
    room.spectators = room.spectators.filter((s) => s.userId !== user.userId);
    this.userRoom.set(user.userId, room.code);
    return player;
  }

  addSpectator(
    room: Room,
    user: { userId: string; name: string; socketId: string | null },
  ) {
    room.spectators = room.spectators.filter((s) => s.userId !== user.userId);
    room.spectators.push({ ...user });
    this.userRoom.set(user.userId, room.code);
  }

  /** Xoá người khỏi phòng. Trả về true nếu phòng bị xoá vì trống. */
  removeUser(room: Room, userId: string): boolean {
    room.players = room.players.filter((p) => p.userId !== userId);
    room.spectators = room.spectators.filter((s) => s.userId !== userId);
    if (this.userRoom.get(userId) === room.code) this.userRoom.delete(userId);
    if (room.players.length === 0) {
      for (const s of room.spectators) this.userRoom.delete(s.userId);
      this.rooms.delete(room.code);
      return true;
    }
    if (room.hostId === userId) this.transferHost(room);
    return false;
  }

  transferHost(room: Room): RoomPlayer | undefined {
    const next = room.players
      .filter((p) => p.userId !== room.hostId)
      .sort(
        (a, b) => Number(b.connected) - Number(a.connected) || a.seat - b.seat,
      )[0];
    if (next) {
      room.hostId = next.userId;
      next.ready = false;
    }
    return next;
  }

  changeSeat(room: Room, userId: string, seat: number): boolean {
    if (seat !== 0 && seat !== 1) return false;
    if (room.players.some((p) => p.seat === seat)) return false;
    const p = this.findPlayer(room, userId);
    if (!p) return false;
    p.seat = seat;
    return true;
  }

  updateSettings(room: Room, patch: Partial<PoolRoomSettings>) {
    const n = { ...room.settings };
    if (typeof patch.isPrivate === 'boolean') n.isPrivate = patch.isPrivate;
    if (patch.type === 'eight' || patch.type === 'nine') n.type = patch.type;
    if (
      typeof patch.raceTo === 'number' &&
      POOL_RACE_OPTIONS.includes(patch.raceTo)
    )
      n.raceTo = patch.raceTo;
    if (patch.breakRule === 'alternate' || patch.breakRule === 'winner')
      n.breakRule = patch.breakRule;
    if (patch.pocketPreset && patch.pocketPreset in POCKET_PRESETS)
      n.pocketPreset = patch.pocketPreset;
    for (const k of [
      'shotClock',
      'allowFullGuide',
      'autoCall',
      'spectators',
    ] as const)
      if (typeof patch[k] === 'boolean') n[k] = patch[k];
    if (typeof patch.ranked === 'boolean') n.ranked = patch.ranked;
    // Xếp hạng: khoá preset WPA Thi đấu, tắt đường dự đoán đầy đủ, bật đồng hồ
    if (n.ranked) {
      n.pocketPreset = 'wpa';
      n.allowFullGuide = false;
      n.shotClock = true;
    }
    room.settings = n;
  }

  addChat(room: Room, msg: Omit<RoomChatMessage, 'id' | 'createdAt'>) {
    const m: RoomChatMessage = {
      ...msg,
      id: `${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: this.now(),
    };
    room.chat = [...room.chat.slice(-(MAX_CHAT_HISTORY - 1)), m];
    return m;
  }

  // ===================================================== TRẬN ĐẤU

  private matchConfig(room: Room, names: [string, string]): MatchConfig {
    const s = room.settings;
    return {
      type: s.type,
      players: [
        { name: names[0], ai: null },
        { name: names[1], ai: null },
      ],
      raceTo: s.raceTo,
      breakRule: s.breakRule,
      autoCall: s.autoCall,
      seed: Math.floor(Math.random() * 1e9),
      pocketPreset: s.pocketPreset,
      allowFullGuide: s.allowFullGuide,
    };
  }

  /** Bắt đầu trận: tung đồng xu chọn người phá */
  startGame(room: Room, coin = Math.random() < 0.5 ? 0 : 1): PoolGame {
    const bySeat = room.players.slice().sort((a, b) => a.seat - b.seat);
    const players: [string, string] = [bySeat[0].userId, bySeat[1].userId];
    const names: [string, string] = [bySeat[0].name, bySeat[1].name];
    const breaker = coin as PlayerIndex;
    const match = startMatch(this.matchConfig(room, names), breaker);
    const now = this.now();
    const game: PoolGame = {
      seq: 1,
      match,
      players,
      names,
      clock: { deadline: 0, pausedAt: null, extensions: [1, 1] },
      busyUntil: now,
      lastShot: null,
      rackOver: null,
      stats: [0, 1].map(() => ({
        shots: 0,
        pots: 0,
        fouls: 0,
        breakAndRuns: 0,
      })) as PoolGame['stats'],
      replay: [{ rackNo: 1, seed: match.rack.seed, breaker, actions: [] }],
      rackShooters: [],
      startedAt: now,
    };
    room.game = game;
    room.status = 'playing';
    room.processedShots.clear();
    this.resetClock(room);
    return game;
  }

  snapshot(room: Room): PoolSnapshot | null {
    const g = room.game;
    if (!g) return null;
    return {
      v: POOL_PROTOCOL_VERSION,
      seq: g.seq,
      match: g.match,
      players: g.players,
      names: g.names,
      clock: { ...g.clock, serverNow: this.now() },
      busyUntil: g.busyUntil,
      lastShot: g.lastShot,
      rackOver: g.rackOver,
      stats: g.stats,
      settings: room.settings,
      endReason: g.endReason,
      eloChange: g.eloChange,
    };
  }

  /** Ai đang phải thao tác (đánh hoặc chọn theo luật) */
  actor(g: PoolGame): PlayerIndex {
    return g.match.rack.decision?.by ?? g.match.rack.turn;
  }

  /** Đặt lại đồng hồ cho lượt mới: 30 s, hoặc 60 s cho cú đầu sau phá / có bi trong tay / cú phá */
  resetClock(room: Room) {
    const g = room.game;
    if (!g) return;
    if (!room.settings.shotClock || g.match.matchWinner !== null) {
      g.clock.deadline = 0;
      return;
    }
    const r = g.match.rack;
    const long = r.isBreak || r.shotNo === 1 || !!r.ballInHand;
    const start = Math.max(this.now(), g.busyUntil);
    g.clock.deadline =
      start + (long ? SHOT_CLOCK.long : SHOT_CLOCK.normal) * 1000;
    g.clock.pausedAt = null;
    // Người thao tác đang mất kết nối -> tạm dừng ngay
    const actor = room.players.find(
      (p) => p.userId === g.players[this.actor(g)],
    );
    if (actor && !actor.connected) g.clock.pausedAt = this.now();
  }

  pauseClock(room: Room) {
    const g = room.game;
    if (g && g.clock.deadline && g.clock.pausedAt === null)
      g.clock.pausedAt = this.now();
  }

  /** Tiếp tục đồng hồ: cộng thời gian đã dừng (tối đa 60 s) */
  resumeClock(room: Room) {
    const g = room.game;
    if (!g || g.clock.pausedAt === null) return;
    const paused = Math.min(60_000, this.now() - g.clock.pausedAt);
    g.clock.deadline += paused;
    g.clock.pausedAt = null;
  }

  private seatOf(room: Room, userId: string): PlayerIndex | -1 {
    const g = room.game;
    if (!g) return -1;
    const i = g.players.indexOf(userId);
    return i === 0 || i === 1 ? i : -1;
  }

  /** Kiểm tra chung: trong trận, đúng người thao tác, bi đã dừng */
  private guard(
    room: Room,
    userId: string,
  ): { g: PoolGame; seat: PlayerIndex } | { code: PoolErrorCode } {
    const g = room.game;
    if (room.status !== 'playing' || !g) return { code: 'WRONG_PHASE' };
    const seat = this.seatOf(room, userId);
    if (seat < 0)
      return {
        code: this.findSpectator(room, userId) ? 'SPECTATOR' : 'NOT_IN_ROOM',
      };
    if (g.match.matchWinner !== null) return { code: 'WRONG_PHASE' };
    if (this.now() < g.busyUntil) return { code: 'WRONG_PHASE' };
    if (this.actor(g) !== seat) return { code: 'NOT_YOUR_TURN' };
    return { g, seat };
  }

  private log(g: PoolGame, a: PoolGame['replay'][number]['actions'][number]) {
    g.replay[g.replay.length - 1].actions.push(a);
  }

  /** Bi trong tay: đặt bi cái (kiểm tra kitchen, không chồng bi, trong bàn) */
  placeCue(room: Room, userId: string, raw: unknown): ActionResult {
    const v = validatePlace(raw);
    if (!v.ok) return err(v.code);
    const res = this.guard(room, userId);
    if ('code' in res) return err(res.code);
    const { g, seat } = res;
    const r = g.match.rack;
    if (v.value.seq !== g.seq) return err('STALE_SEQ', g);
    if (!r.ballInHand || r.decision) return err('WRONG_PHASE');
    const others = r.balls.filter((b) => b.n !== 0);
    if (
      !isValidCuePlacement(
        others,
        v.value.x,
        v.value.y,
        r.ballInHand === 'kitchen',
      )
    )
      return err('INVALID_PLACEMENT');
    g.match = {
      ...g.match,
      rack: { ...r, balls: withCueAt(r.balls, v.value.x, v.value.y) },
    };
    g.seq++;
    this.log(g, {
      kind: 'place',
      seq: g.seq,
      by: seat,
      x: v.value.x,
      y: v.value.y,
    });
    return { ok: true, game: g };
  }

  /** Lựa chọn theo luật (phá lỗi, bi 8 khi phá, push out) */
  option(room: Room, userId: string, raw: unknown): ActionResult {
    const v = validateOption(raw);
    if (!v.ok) return err(v.code);
    const res = this.guard(room, userId);
    if ('code' in res) return err(res.code);
    const { g, seat } = res;
    if (v.value.seq !== g.seq) return err('STALE_SEQ', g);
    const r = g.match.rack;
    if (!r.decision) return err('WRONG_PHASE');
    if (!decisionOptions(r).some((o) => o.choice === v.value.choice))
      return err('INVALID_OPTION');
    const out = applyDecision(r, v.value.choice, g.names);
    g.timeoutMessages = out.messages;
    if (out.rack.isBreak && !r.isBreak)
      this.startRackLog(g, out.rack.seed, out.rack.breaker);
    g.match = { ...g.match, rack: out.rack };
    g.seq++;
    this.log(g, {
      kind: 'option',
      seq: g.seq,
      by: seat,
      choice: v.value.choice,
    });
    this.resetClock(room);
    return { ok: true, game: g };
  }

  private startRackLog(g: PoolGame, seed: number, breaker: number) {
    g.replay.push({ rackNo: g.match.rackNo, seed, breaker, actions: [] });
    g.rackShooters = [];
  }

  /**
   * SHOT: kiểm tra lượt, phase, seq, phạm vi giá trị, hash trạng thái;
   * server mô phỏng -> ShotResult -> trọng tài -> trạng thái mới.
   */
  shoot(room: Room, userId: string, raw: unknown): ShootResult {
    const cfg = configForPreset(room.settings.pocketPreset);
    const v = validateShotInput(raw, cfg);
    if (!v.ok) return err(v.code);
    const input = v.value;
    if (room.processedShots.has(input.shotId))
      return { ok: true, duplicate: true };
    const res = this.guard(room, userId);
    if ('code' in res) return err(res.code);
    const { g, seat } = res;
    const r = g.match.rack;
    if (input.seq !== g.seq) return err('STALE_SEQ', g);
    if (r.decision) return err('WRONG_PHASE');
    if (!r.balls.some((b) => b.n === 0)) return err('WRONG_PHASE');
    if (input.clientStateHash !== ballsHash(r.balls))
      return err('STATE_MISMATCH', g);

    const cmd = shotCommandFromInput(input);
    const decl = {
      call:
        r.type === 'eight' && !r.isBreak && !input.safety ? input.call : null,
      safety: r.type === 'eight' && !r.isBreak && input.safety === true,
      pushOut:
        r.type === 'nine' &&
        r.pushOutAvailable &&
        !r.isBreak &&
        input.pushOut === true,
    };
    // Cơ không được xuyên bi / thành băng; chỉ vướng băng nhẹ thì tự nâng đuôi cơ (giống client)
    const lift = liftShot(r.balls, cmd, cfg);
    if (!lift.clearance.ok) return err('CUE_BLOCKED');
    const trace = simulateShot(r.balls, lift.shot, { config: cfg });
    const verdict = resolveShot(r, decl, trace.result, g.names);
    const now = this.now();

    // Thống kê
    const st = g.stats[seat];
    st.shots++;
    if (verdict.foul) st.fouls++;
    else st.pots += trace.result.pocketed.filter((p) => p.ball !== 0).length;
    if (!g.rackShooters.includes(seat)) g.rackShooters.push(seat);

    const shot: ShotRecord = {
      seq: g.seq + 1,
      shotId: input.shotId,
      by: seat,
      input: {
        aimAngle: input.aimAngle,
        power: input.power,
        tipX: input.tipX,
        tipY: input.tipY,
        elevation: input.elevation,
        call: decl.call ?? null,
        safety: decl.safety,
        pushOut: decl.pushOut,
      },
      start: r.balls,
      events: trace.events,
      final: trace.result.final,
      pocketed: trace.result.pocketed,
      hash: trace.hash,
      foul: verdict.foul,
      messages: verdict.messages,
      duration: trace.result.duration,
      at: now,
    };
    g.lastShot = shot;
    g.seq++;
    g.busyUntil =
      now +
      (STROKE_MS + trace.result.duration * 1000 + SETTLE_MS) * this.busyScale;
    this.log(g, { kind: 'shot', seq: g.seq, by: seat, input: shot.input });
    room.processedShots.add(input.shotId);
    if (room.processedShots.size > MAX_PROCESSED_SHOTS) {
      const first = room.processedShots.values().next().value as
        | string
        | undefined;
      if (first) room.processedShots.delete(first);
    }

    this.applyRack(room, verdict.rack);
    return { ok: true, game: g, shot };
  }

  /** Áp trạng thái ván mới; ván kết thúc -> cộng điểm, xếp ván kế tiếp hoặc kết thúc trận */
  private applyRack(room: Room, rack: PoolGame['match']['rack']) {
    const g = room.game!;
    g.rackOver = null;
    if (rack.winner === null) {
      g.match = { ...g.match, rack };
      this.resetClock(room);
      return;
    }
    const winner = rack.winner;
    if (
      rack.breaker === winner &&
      g.rackShooters.length === 1 &&
      g.rackShooters[0] === winner
    )
      g.stats[winner].breakAndRuns++;
    g.rackOver = {
      winner,
      reason: rack.winReason ?? '',
      rackNo: g.match.rackNo,
    };
    g.match = recordRackWin({ ...g.match, rack }, winner);
    if (g.match.matchWinner !== null) {
      g.endedAt = this.now();
      g.endReason = `${g.names[winner]} thắng ${g.match.score.join('–')}`;
      g.clock.deadline = 0;
      room.status = 'finished';
      return;
    }
    g.match = nextRack(g.match);
    g.clock.extensions = [1, 1];
    this.startRackLog(g, g.match.rack.seed, g.match.rack.breaker);
    this.resetClock(room);
  }

  /** Hết giờ: lỗi theo luật shot clock */
  timeout(room: Room): boolean {
    const g = room.game;
    if (
      room.status !== 'playing' ||
      !g ||
      !g.clock.deadline ||
      g.clock.pausedAt !== null
    )
      return false;
    if (this.now() < g.clock.deadline) return false;
    const by = this.actor(g);
    const out = applyTimeoutFoul(g.match.rack, g.names);
    g.seq++;
    this.log(g, { kind: 'timeout', seq: g.seq, by });
    if (!g.match.rack.decision) g.stats[by].fouls++;
    g.lastShot = null;
    g.timeoutMessages = out.messages;
    this.applyRack(room, out.rack);
    return true;
  }

  /** Gia hạn +30 s (1 lần mỗi ván) */
  extend(room: Room, userId: string): ActionResult {
    const res = this.guard(room, userId);
    if ('code' in res) return err(res.code);
    const { g, seat } = res;
    if (!g.clock.deadline || g.clock.extensions[seat] <= 0)
      return err('NO_EXTENSION');
    g.clock.extensions[seat]--;
    g.clock.deadline += SHOT_CLOCK.extension * 1000;
    return { ok: true, game: g };
  }

  /** Xin thua / rời trận / quá thời gian kết nối lại -> đối thủ thắng trận */
  forfeit(room: Room, userId: string, reason: string): boolean {
    const g = room.game;
    if (room.status !== 'playing' || !g || g.match.matchWinner !== null)
      return false;
    const seat = this.seatOf(room, userId);
    if (seat < 0) return false;
    const winner = (1 - seat) as PlayerIndex;
    g.seq++;
    this.log(g, { kind: 'resign', seq: g.seq, by: seat });
    g.match = { ...g.match, matchWinner: winner };
    g.endedAt = this.now();
    g.endReason = reason;
    g.clock.deadline = 0;
    g.lastShot = null;
    room.status = 'finished';
    return true;
  }

  resetToLobby(room: Room) {
    room.status = 'lobby';
    room.game = null;
    room.players.forEach((p) => (p.ready = false));
  }
}
