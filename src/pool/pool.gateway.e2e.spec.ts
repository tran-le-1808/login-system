/**
 * 3.10.2 — Bot 2 client chơi trọn các ván qua WebSocket (gateway + socket.io thật, cổng ngẫu nhiên).
 * MongoDB được giả lập (không ghi dữ liệu). Mỗi bot tự mô phỏng lại mọi cú đánh từ input để
 * kiểm tra hash khớp server. Số ván: POOL_SOAK_RACKS (mặc định 3 ván mỗi thể loại).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { User } from 'src/users/entities/user.entity';
import { PoolGateway } from './pool.gateway';
import { PoolRoomService } from './pool-room.service';
import { PoolStatsService } from './pool-stats.service';
import type { PoolSnapshot, ShotRecord } from './pool.types';
import { simulateShot } from './shared/physics/simulator';
import { liftShot } from './shared/physics/clearance';
import { configForPreset } from './shared/physics/config';
import { POOL_TABLE } from './shared/physics/table';
import { legalTargets } from './shared/rules/common';
import { decisionOptions } from './shared/rules/engine';
import type { RackState } from './shared/rules/types';
import {
  ballsHash,
  POOL_PROTOCOL_VERSION,
  shotCommandFromInput,
} from './shared/protocol';

const SECRET = 'e2e-secret';
const USERS = {
  u1: { _id: 'u1', name: 'Bot A' },
  u2: { _id: 'u2', name: 'Bot B' },
};
const RACKS = Number(process.env.POOL_SOAK_RACKS ?? 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chọn cú: bi hợp lệ + lỗ có góc cắt nhỏ nhất (bóng ma) */
function chooseAim(rack: RackState) {
  const cue = rack.balls.find((b) => b.n === 0)!;
  const targets = legalTargets(rack);
  const R = 0.028575;
  let best = { angle: 0, cut: 999, ball: targets[0] ?? 1, pocket: 0 };
  for (const t of targets) {
    const b = rack.balls.find((x) => x.n === t);
    if (!b) continue;
    for (const p of POOL_TABLE.pockets) {
      const ox = p.mouthX - b.x;
      const oy = p.mouthY - b.y;
      const l = Math.hypot(ox, oy);
      const gx = b.x - (ox / l) * 2 * R;
      const gy = b.y - (oy / l) * 2 * R;
      const ang = Math.atan2(gy - cue.y, gx - cue.x);
      const cut = Math.abs(
        Math.atan2(
          Math.sin(ang - Math.atan2(oy, ox)),
          Math.cos(ang - Math.atan2(oy, ox)),
        ),
      );
      if (cut < best.cut) best = { angle: ang, cut, ball: t, pocket: p.id };
    }
  }
  if (best.cut > 1.2 && targets.length) {
    const b = rack.balls.find((x) => x.n === targets[0])!;
    best.angle = Math.atan2(b.y - cue.y, b.x - cue.x);
  }
  return best;
}

class Bot {
  socket: Socket;
  snap: PoolSnapshot | null = null;
  acting = false;
  errors: string[] = [];
  mismatches = 0;
  verified = 0;
  timeouts = 0;
  retry = 0;
  constructor(
    url: string,
    token: string,
    readonly userId: string,
  ) {
    this.socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    this.socket.on('pool:state', (s: PoolSnapshot) => this.update(s));
    this.socket.on('exception', (e: unknown) =>
      this.errors.push(`exception: ${JSON.stringify(e)}`),
    );
    this.socket.on(
      'pool:shot',
      ({ shot, state }: { shot: ShotRecord; state: PoolSnapshot }) => {
        const cfg = configForPreset(state.settings.pocketPreset);
        // Giống client thật: dựng lại cú đánh với góc cơ đã tự nâng qua băng
        const cmd = liftShot(
          shot.start,
          shotCommandFromInput(shot.input),
          cfg,
        ).shot;
        const tr = simulateShot(shot.start, cmd, { config: cfg });
        this.verified++;
        if (tr.hash !== shot.hash) this.mismatches++;
        this.update(state);
      },
    );
  }
  emit<T = unknown>(
    ev: string,
    body?: unknown,
  ): Promise<{ ok: boolean; error?: string; code?: string; data?: T }> {
    return this.socket.timeout(30000).emitWithAck(ev, body);
  }
  update(s: PoolSnapshot | null) {
    if (!s) return;
    if (
      this.snap &&
      s.seq < this.snap.seq &&
      s.match.rackNo === this.snap.match.rackNo
    )
      return;
    this.snap = s;
    void this.act();
  }
  async act() {
    const s = this.snap;
    if (!s || this.acting || s.match.matchWinner !== null) return;
    const seat = s.players.indexOf(this.userId);
    const r = s.match.rack;
    const actor = r.decision?.by ?? r.turn;
    if (seat < 0 || actor !== seat) return;
    this.acting = true;
    await sleep(170); // tôn trọng giới hạn tần suất của server
    try {
      let res: Awaited<ReturnType<Bot['emit']>>;
      if (r.decision) {
        res = await this.emit<PoolSnapshot>('pool:option', {
          v: POOL_PROTOCOL_VERSION,
          seq: s.seq,
          choice: decisionOptions(r)[0].choice,
        });
      } else {
        const aim = chooseAim(r);
        // Như người chơi thật: nâng cơ khi bị vướng bi / thành băng (nếu vẫn vướng thì xoay hướng ngắm)
        let angle = aim.angle + this.retry * 0.5;
        let elevation = 2;
        const lift = liftShot(
          r.balls,
          shotCommandFromInput({
            aimAngle: angle,
            power: 0.4,
            tipX: 0,
            tipY: 0,
            elevation,
          }),
          configForPreset(s.settings.pocketPreset),
        );
        if (!lift.clearance.ok) elevation = lift.clearance.minElevation ?? 80;
        angle = Math.atan2(Math.sin(angle), Math.cos(angle));
        res = await this.emit<PoolSnapshot>('pool:shoot', {
          v: POOL_PROTOCOL_VERSION,
          seq: s.seq,
          shotId: `${this.userId}-${s.seq}`,
          aimAngle: angle,
          power: r.isBreak ? 0.9 : 0.42,
          tipX: 0,
          tipY: 0,
          elevation,
          call:
            r.type === 'eight' && !r.isBreak
              ? { ball: aim.ball, pocket: aim.pocket }
              : null,
          clientStateHash: ballsHash(r.balls),
        });
      }
      if (!res.ok && res.code === 'CUE_BLOCKED') {
        this.retry++; // cơ vẫn vướng: đổi hướng ngắm ở lần sau
      } else if (!res.ok) {
        this.errors.push(`${res.code}: ${res.error}`);
        if (res.data) this.snap = res.data as PoolSnapshot;
      }
      if (res.ok) this.retry = 0;
    } catch {
      // Quá hạn ack (máy quá tải): như client thật — đồng bộ lại trạng thái rồi đánh tiếp
      this.timeouts++;
      try {
        const sync = await this.emit<PoolSnapshot>('pool:sync');
        if (sync.ok && sync.data) this.snap = sync.data;
      } catch {
        /* thử lại ở lượt sau */
      }
    } finally {
      this.acting = false;
    }
    void this.act();
  }
}

describe('PoolGateway e2e — 2 bot chơi qua WebSocket', () => {
  let app: INestApplication;
  let url: string;
  let rooms: PoolRoomService;
  const jwt = new JwtService({ secret: SECRET });

  beforeAll(async () => {
    const userModel = {
      findById: (id: string) => ({
        select: () => ({
          lean: () => Promise.resolve(USERS[id as keyof typeof USERS] ?? null),
        }),
      }),
    };
    const stats = {
      getElo: () => Promise.resolve(1200),
      getRating: () =>
        Promise.resolve({ eight: { elo: 1200 }, nine: { elo: 1200 } }),
      recordMatch: () => Promise.resolve([16, -16]),
    };
    const mod = await Test.createTestingModule({
      providers: [
        PoolGateway,
        PoolRoomService,
        { provide: PoolStatsService, useValue: stats },
        { provide: JwtService, useValue: jwt },
        { provide: getModelToken(User.name), useValue: userModel },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer() as { address(): AddressInfo }).address().port}`;
    rooms = app.get(PoolRoomService);
    rooms.busyScale = 0; // không chờ hoạt cảnh bi lăn
  });

  afterAll(async () => {
    await app.close();
  });

  const play = async (type: 'eight' | 'nine') => {
    const a = new Bot(url, await jwt.signAsync({ sub: 'u1' }), 'u1');
    const b = new Bot(url, await jwt.signAsync({ sub: 'u2' }), 'u2');
    await Promise.all(
      [a, b].map(
        (x) => new Promise<void>((r) => x.socket.on('connect', () => r())),
      ),
    );
    let racks = 0;
    let shots = 0;
    while (racks < RACKS) {
      const raceTo = [1, 3, 5, 7, 9].find((n) => n >= RACKS - racks) ?? 9;
      const created = await a.emit<{ room: { code: string } }>('pool:create', {
        type,
        raceTo,
        shotClock: false,
        pocketPreset: 'wpa',
      });
      expect(created.ok).toBe(true);
      const code = created.data!.room.code;
      expect((await b.emit('pool:join', { code })).ok).toBe(true);
      expect((await b.emit('pool:ready', { ready: true })).ok).toBe(true);
      expect((await a.emit('pool:start')).ok).toBe(true);
      const deadline =
        Date.now() + Number(process.env.POOL_MATCH_TIMEOUT ?? 10 * 60_000);
      while (Date.now() < deadline) {
        const s = a.snap;
        if (s && s.match.matchWinner !== null && b.snap?.seq === s.seq) break;
        await sleep(50);
      }
      const final = a.snap!;
      if (final.match.matchWinner === null) {
        // eslint-disable-next-line no-console
        console.log('KẸT', {
          seq: final.seq,
          turn: final.match.rack.turn,
          decision: final.match.rack.decision,
          busyUntil: final.busyUntil - Date.now(),
          errorsA: a.errors.slice(-5),
          errorsB: b.errors.slice(-5),
          actingA: a.acting,
          actingB: b.acting,
        });
      }
      expect(final.match.matchWinner).not.toBeNull();
      // 2 client nhận cùng 1 trạng thái
      expect(ballsHash(a.snap!.match.rack.balls)).toBe(
        ballsHash(b.snap!.match.rack.balls),
      );
      racks += final.match.score[0] + final.match.score[1];
      const room = rooms.get(code)!;
      shots += room.game!.replay.reduce(
        (n, r) => n + r.actions.filter((x) => x.kind === 'shot').length,
        0,
      );
      await a.emit('pool:leave');
      await b.emit('pool:leave');
      a.snap = b.snap = null;
    }
    a.socket.close();
    b.socket.close();
    return { racks, shots, a, b };
  };

  it.each(['eight', 'nine'] as const)(
    '%s: chơi trọn các ván, không lỗi, không lệch trạng thái',
    async (type) => {
      const t0 = Date.now();
      const { racks, shots, a, b } = await play(type);
      // eslint-disable-next-line no-console
      console.log(
        `${type}: ${racks} ván, ${shots} cú, kiểm tra hash ${a.verified + b.verified} lần, lệch ${a.mismatches + b.mismatches}, lỗi ${a.errors.length + b.errors.length}, ack quá hạn ${a.timeouts + b.timeouts}, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
      );
      expect(racks).toBeGreaterThanOrEqual(RACKS);
      expect(a.mismatches + b.mismatches).toBe(0);
      expect([...a.errors, ...b.errors]).toEqual([]);
    },
    30 * 60_000,
  );
});
