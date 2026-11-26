/**
 * E2E co-op 2–4 người: NestJS + Socket.IO THẬT (cổng ngẫu nhiên), 4 client socket.io độc lập.
 * MongoDB được giả lập bằng store trong RAM (cùng hợp đồng với PrisonPersistenceService,
 * có điều kiện version cho checkpoint) — không ghi vào DB thật.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { User } from 'src/users/entities/user.entity';
import { PrisonGateway, type JoinPayload } from './prison.gateway';
import { PrisonPersistenceService } from './prison-persistence.service';
import { PrisonRoomService } from './prison-room.service';
import { PrisonSimulationService } from './prison-simulation';
import type { GameSnapshot, PrivateState } from './shared/view';
import type { WorldState } from './shared/types';

jest.setTimeout(60_000);
const SECRET = 'e2e-secret';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USERS: Record<string, { _id: string; name: string }> = {};
for (let i = 1; i <= 6; i++) {
  const id = new Types.ObjectId().toHexString();
  USERS[`u${i}`] = { _id: id, name: `Tù nhân ${i}` };
}

interface StoredSession {
  _id: string;
  roomCode: string;
  hostId: string;
  memberIds: string[];
  members: { userId: string; name: string; role: string }[];
  status: string;
  checkpointVersion: number;
  world: WorldState | null;
}

/** Thay thế MongoDB: cùng API, cùng điều kiện version */
class FakePersistence {
  writes = 0;
  sessions = new Map<string, StoredSession>();
  events: { eventId: string; type: string }[] = [];
  createSession(input: {
    roomCode: string;
    hostId: string;
    members: StoredSession['members'];
    world: WorldState;
  }) {
    const id = new Types.ObjectId().toHexString();
    this.sessions.set(id, {
      _id: id,
      roomCode: input.roomCode,
      hostId: input.hostId,
      memberIds: input.members.map((m) => m.userId),
      members: input.members,
      status: 'ACTIVE',
      checkpointVersion: 0,
      world: null,
    });
    return Promise.resolve(id);
  }
  saveCheckpoint(
    id: string,
    version: number,
    world: WorldState,
    status: string,
  ) {
    this.writes++;
    const s = this.sessions.get(id);
    if (!s || s.checkpointVersion >= version) return Promise.resolve(false);
    Object.assign(s, {
      checkpointVersion: version,
      world: structuredClone(world),
      status,
    });
    return Promise.resolve(true);
  }
  findResumable(roomCode: string, userId: string) {
    const s = [...this.sessions.values()].find(
      (x) =>
        x.roomCode === roomCode &&
        x.memberIds.includes(userId) &&
        (x.status === 'ACTIVE' || x.status === 'PAUSED') &&
        x.world,
    );
    return Promise.resolve(s ? structuredClone(s) : null);
  }
  queueEvents(
    _id: string | null,
    evs: { id: string; type: string; audit?: boolean }[],
  ) {
    for (const e of evs)
      if (e.audit) this.events.push({ eventId: e.id, type: e.type });
  }
  flush() {
    return Promise.resolve();
  }
}

class Client {
  socket: Socket;
  seen: { ev: string; data: unknown }[] = [];
  seq = 0;
  lastSnap: GameSnapshot | null = null;
  priv: PrivateState | null = null;
  constructor(
    url: string,
    token: string | null,
    readonly key: string,
  ) {
    this.socket = io(`${url}/game`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: token ? { token: `Bearer ${token}` } : {},
    });
    this.socket.onAny((ev: string, data: unknown) => {
      this.seen.push({ ev, data });
      if (ev === 'game:snapshot') this.lastSnap = data as GameSnapshot;
      if (ev === 'inventory:updated') this.priv = data as PrivateState;
    });
  }
  get uid() {
    return USERS[this.key]._id;
  }
  connected() {
    return new Promise<void>((resolve, reject) => {
      if (this.socket.connected) return resolve();
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', reject);
    });
  }
  async emit<T = unknown>(
    ev: string,
    payload?: unknown,
  ): Promise<{ ok: boolean; data?: T; code?: string; message?: string }> {
    return (await this.socket.timeout(5000).emitWithAck(ev, payload)) as {
      ok: boolean;
      data?: T;
      code?: string;
    };
  }
  async waitFor<T = unknown>(
    ev: string,
    pred: (d: T) => boolean = () => true,
    ms = 6000,
  ): Promise<T> {
    const start = Date.now();
    let from = 0;
    while (Date.now() - start < ms) {
      for (let i = from; i < this.seen.length; i++)
        if (this.seen[i].ev === ev && pred(this.seen[i].data as T))
          return this.seen[i].data as T;
      from = 0;
      await sleep(20);
    }
    throw new Error(`[${this.key}] không nhận được ${ev}`);
  }
  count(ev: string) {
    return this.seen.filter((s) => s.ev === ev).length;
  }
  async walk(dx: number, dy: number, steps: number, sprint = false) {
    for (let i = 0; i < steps; i++) {
      this.socket.emit('player:input', {
        sequence: ++this.seq,
        directionX: dx,
        directionY: dy,
        sprint,
      });
      await sleep(50);
    }
  }
  close() {
    this.socket.disconnect();
  }
}

let rid = 0;
const req = () => `req-${Date.now()}-${++rid}`;

async function makeApp(store: FakePersistence) {
  const jwt = new JwtService({ secret: SECRET });
  const userModel = {
    findById: (id: string) => ({
      select: () => ({
        lean: () =>
          Promise.resolve(
            Object.values(USERS).find((u) => u._id === id) ?? null,
          ),
      }),
    }),
  };
  const mod = await Test.createTestingModule({
    providers: [
      PrisonGateway,
      PrisonRoomService,
      PrisonSimulationService,
      { provide: PrisonPersistenceService, useValue: store },
      { provide: JwtService, useValue: jwt },
      { provide: getModelToken(User.name), useValue: userModel },
    ],
  }).compile();
  const app = mod.createNestApplication();
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen(0);
  const url = `http://127.0.0.1:${(app.getHttpServer() as { address(): AddressInfo }).address().port}`;
  return { app, url, jwt };
}

describe('Prison co-op qua WebSocket (4 client thật)', () => {
  let app: INestApplication;
  let url: string;
  let jwt: JwtService;
  const store = new FakePersistence();
  const clients: Client[] = [];
  const connect = async (key: string) => {
    const c = new Client(
      url,
      await jwt.signAsync({ sub: USERS[key]._id }),
      key,
    );
    clients.push(c);
    await c.connected();
    return c;
  };

  beforeAll(async () => {
    ({ app, url, jwt } = await makeApp(store));
  });
  afterAll(async () => {
    for (const c of clients) c.close();
    await app.close();
  });

  it('từ chối socket không có token (UNAUTHORIZED) và ngắt kết nối', async () => {
    const c = new Client(url, null, 'u1');
    clients.push(c);
    await c.connected().catch(() => undefined);
    const err = await c.waitFor<{ code: string }>('game:error');
    expect(err.code).toBe('UNAUTHORIZED');
    await sleep(100);
    expect(c.socket.connected).toBe(false);
  });

  let code = '';
  let A: Client, B: Client, Cc: Client, D: Client;

  it('phòng chờ: tạo, vào bằng mã, đầy 4 người, host & ready, start', async () => {
    [A, B, Cc, D] = await Promise.all(['u1', 'u2', 'u3', 'u4'].map(connect));
    const created = await A.emit<JoinPayload>('room:create', {
      settings: { difficulty: 'NORMAL', privateRoom: false },
    });
    expect(created.ok).toBe(true);
    code = created.data!.room.roomCode;
    // Payload giả mạo hostId bị chặn
    const forged = await B.emit('room:create', {
      settings: { difficulty: 'NORMAL' },
      hostId: A.uid,
    });
    expect(forged.code).toBe('INVALID_PAYLOAD');
    // Join đồng thời 3 người
    const joins = await Promise.all(
      [B, Cc, D].map((c) =>
        c.emit<JoinPayload>('room:join', { roomCode: code.toLowerCase() }),
      ),
    );
    expect(joins.every((j) => j.ok)).toBe(true);
    const E = await connect('u5');
    const full = await E.emit('room:join', { roomCode: code });
    expect(full.code).toBe('ROOM_FULL');
    const list = await E.emit<{ roomCode: string }[]>('room:list');
    expect(list.data?.some((r) => r.roomCode === code)).toBe(false); // phòng đầy không hiện công khai
    // join trùng: không nhân bản
    const dup = await B.emit<JoinPayload>('room:join', { roomCode: code });
    expect(dup.data?.room.members).toHaveLength(4);
    // chỉ host đổi luật / bắt đầu
    expect(
      (
        await B.emit('room:update-settings', {
          settings: { difficulty: 'HARD' },
        })
      ).code,
    ).toBe('FORBIDDEN');
    expect((await B.emit('room:start')).code).toBe('FORBIDDEN');
    expect((await A.emit('room:start')).code).toBe('INVALID_STATE'); // chưa ai ready
    await Promise.all(
      [B, Cc, D].map((c) => c.emit('room:ready', { ready: true })),
    );
    const started = await A.emit<JoinPayload>('room:start');
    expect(started.ok).toBe(true);
    expect(started.data?.state?.players).toHaveLength(4);
    for (const c of [A, B, Cc, D]) {
      const gs = await c.waitFor<JoinPayload>('game:started');
      expect(gs.state?.meta.requiredPlayerIds).toHaveLength(4);
      expect(gs.private?.playerId).toBe(c.uid);
    }
    // start lần 2 bị chặn
    expect((await A.emit('room:start')).code).toBe('INVALID_STATE');
  });

  it('di chuyển: server tính vị trí, mọi client thấy cùng snapshot; input sai miền / trùng bị bỏ', async () => {
    await A.waitFor('game:snapshot');
    const y0 = A.lastSnap!.players.find((p) => p.id === A.uid)!.y;
    await A.walk(0, 1, 10); // đi xuống tường đáy xà lim A-3
    // input trùng sequence (replay) & ngoài miền
    A.socket.emit('player:input', {
      sequence: A.seq,
      directionX: 0,
      directionY: 1,
      sprint: false,
    });
    A.socket.emit('player:input', {
      sequence: ++A.seq,
      directionX: 50,
      directionY: 0,
      sprint: false,
    });
    const err = await A.waitFor<{ code: string }>(
      'game:error',
      (e) => e.code === 'INVALID_PAYLOAD',
    );
    expect(err.code).toBe('INVALID_PAYLOAD');
    await sleep(300);
    const me = A.lastSnap!.players.find((p) => p.id === A.uid)!;
    expect(me.lastSeq).toBe(10);
    expect(me.y).toBeGreaterThan(y0 + 0.5);
    expect(me.y).toBeLessThanOrEqual(41 - 0.25 + 1e-6); // không xuyên tường (y = 41)
    // So khớp: cùng tick -> cùng dữ liệu ở 2 client
    const tick = A.lastSnap!.tick;
    const snapA = A.seen.find(
      (s) => s.ev === 'game:snapshot' && (s.data as GameSnapshot).tick === tick,
    )?.data as GameSnapshot;
    const snapB = await B.waitFor<GameSnapshot>(
      'game:snapshot',
      (s) => s.tick === tick,
    );
    expect(snapB.players).toEqual(snapA.players);
    expect(snapB.changedEntities).toEqual(snapA.changedEntities);
    // lính gác có trong keyframe
    const key = await B.waitFor<GameSnapshot>(
      'game:snapshot',
      (s) => s.keyframe,
      7000,
    );
    expect(
      key.changedEntities.filter((e) => e.kind === 'guard').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('rate limit input: gửi dồn dập -> RATE_LIMITED', async () => {
    for (let i = 0; i < 80; i++)
      D.socket.emit('player:input', {
        sequence: ++D.seq,
        directionX: 0,
        directionY: 0,
        sprint: false,
      });
    const e = await D.waitFor<{ code: string }>(
      'game:error',
      (x) => x.code === 'RATE_LIMITED',
    );
    expect(e.code).toBe('RATE_LIMITED');
  });

  it('payload giả mạo bị từ chối (trường lạ, kết quả do client tự khai)', async () => {
    const r1 = await B.emit('player:interact', {
      requestId: req(),
      targetId: 'desk_1',
      completed: true,
    });
    expect(r1.code).toBe('INVALID_PAYLOAD');
    const r2 = await B.emit('quest:contribute', {
      requestId: req(),
      questId: 't_supplies',
      objectiveId: 'food',
      contribution: 1,
      userId: A.uid,
    });
    expect(r2.code).toBe('INVALID_PAYLOAD');
    const r3 = await B.emit('escape:enter-point', {
      requestId: req(),
      escapePointId: 'exit_truck',
    });
    expect(r3.code).toBe('INVALID_STATE');
    const r4 = await B.emit('rescue:start', {
      requestId: req(),
      targetPlayerId: A.uid,
      rescuePointId: 'sol_door_0',
    });
    expect(r4.code).toBe('INVALID_STATE');
    // sự kiện mới: DTO chặn giá trị ngoài miền, engine chặn thao tác ngoài tầm
    const r6 = await B.emit('tunnel:action', {
      requestId: req(),
      cellIndex: 12,
      op: 'dig',
    });
    expect(r6.code).toBe('INVALID_PAYLOAD');
    const r7 = await B.emit('tunnel:action', {
      requestId: req(),
      cellIndex: 0,
      op: 'explode',
    });
    expect(r7.code).toBe('INVALID_PAYLOAD');
    const r8 = await B.emit('shop:buy', { requestId: req(), itemId: 'food' });
    expect(r8.code).toBe('OUT_OF_RANGE');
    const r9 = await B.emit('player:hide', {
      requestId: req(),
      spotId: 'toilet_1',
      itemId: 'food',
      quantity: 1,
      found: false,
    });
    expect(r9.code).toBe('INVALID_PAYLOAD');
    const r10 = await B.emit('guard:bribe', {
      requestId: req(),
      guardId: 'guard_0',
    });
    expect(['OUT_OF_RANGE', 'INVALID_STATE']).toContain(r10.code);
    await sleep(1200); // để bucket rate-limit (12 thao tác/giây) hồi lại
    const r5 = await B.emit('player:trade-accept', { requestId: 'x' });
    expect(r5.code).toBe('INVALID_PAYLOAD');
  });

  it('tủ & giường qua socket: hai người tranh một ô chỉ một người được; payload giả bị chặn', async () => {
    const sims = app.get(PrisonSimulationService);
    const w = sims.get(code)!.world;
    w.guards = [];
    for (const c of [A, B]) {
      w.players[c.uid].x = 12.5;
      w.players[c.uid].y = 38.5;
    }
    w.containers.desk_0.items = [{ itemId: 'wire', quantity: 2 }];
    const take = (c: Client, extra: Record<string, unknown> = {}) =>
      c.emit('container:take', {
        requestId: req(),
        containerId: 'desk_0',
        index: 0,
        itemId: 'wire',
        quantity: 2,
        ...extra,
      });
    expect((await take(A, { quantity: 0 })).code).toBe('INVALID_PAYLOAD');
    expect((await take(A, { owner: A.uid })).code).toBe('INVALID_PAYLOAD');
    expect((await take(A, { itemId: 'laser' })).code).toBe('INVALID_PAYLOAD');
    expect((await take(A, { index: 9999 })).code).toBe('INVALID_PAYLOAD');
    // tranh nhau cùng một ô
    const [r1, r2] = await Promise.all([take(A), take(B)]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(['CONFLICT', 'INSUFFICIENT_ITEMS']).toContain(
      (r1.ok ? r2 : r1).code,
    );
    const wires = (c: Client) =>
      w.players[c.uid].inventory
        .filter((i) => i.itemId === 'wire')
        .reduce((n, i) => n + i.quantity, 0);
    expect(wires(A) + wires(B)).toBe(2);
    expect(w.containers.desk_0.items).toHaveLength(0);
    // cất lại
    const holder = r1.ok ? A : B;
    const idx = w.players[holder.uid].inventory.findIndex(
      (i) => i.itemId === 'wire',
    );
    const put = await holder.emit('container:put', {
      requestId: req(),
      containerId: 'desk_0',
      index: idx,
      itemId: 'wire',
      quantity: 2,
    });
    expect(put.ok).toBe(true);
    expect(w.containers.desk_0.items[0]).toMatchObject({
      itemId: 'wire',
      quantity: 2,
    });
    // giường: gối / chăn / hình nộm
    expect(
      (
        await A.emit('bed:take', {
          requestId: req(),
          bedId: 'bedrest_0',
          what: 'sword',
        })
      ).code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (
        await A.emit('bed:place', {
          requestId: req(),
          bedId: 'bedrest_0',
          what: 'dummy',
        })
      ).code,
    ).toBe('ITEM_NOT_OWNED');
    expect(
      (
        await A.emit('bed:take', {
          requestId: req(),
          bedId: 'bedrest_0',
          what: 'pillow',
        })
      ).ok,
    ).toBe(true);
    expect(w.beds.bedrest_0.pillow).toBe(false);
    expect(
      (
        await A.emit('bed:place', {
          requestId: req(),
          bedId: 'bedrest_0',
          what: 'pillow',
        })
      ).ok,
    ).toBe(true);
    expect(w.beds.bedrest_0.pillow).toBe(true);
    await sleep(1200);
  });

  it('kiểm tra đêm qua socket: giường trống -> truy nã ★ phát cho cả đội; hình nộm tốt qua mắt; điểm danh đêm đồng đội trả lời thay', async () => {
    const sims = app.get(PrisonSimulationService);
    const w = sims.get(code)!.world;
    w.guards = [];
    const savedInmates = w.inmates;
    w.inmates = [];
    // A và B ra ngoài sân; B có hình nộm hoàn hảo trên giường phòng mình
    w.players[A.uid].x = 30.5;
    w.players[A.uid].y = 8.5;
    w.players[B.uid].x = 31.5;
    w.players[B.uid].y = 8.5;
    w.beds.bedrest_1.dummy = true;
    w.beds.bedrest_1.realism = 100;
    w.totalGameMinutes =
      Math.floor(w.totalGameMinutes / 1440) * 1440 + 22 * 60 - 0.4;
    const wanted = await Cc.waitFor<{
      playerId: string;
      data: { level: number };
    }>('violation:wanted', (e) => e.playerId === A.uid, 8000);
    expect(wanted.data.level).toBe(1);
    await B.waitFor(
      'bed:dummy-fooled',
      (e: { playerId: string }) => e.playerId === B.uid,
    );
    expect(w.players[A.uid].wantedLevel).toBe(1);
    expect(w.players[B.uid].wantedLevel).toBe(0);
    // điểm danh đêm 02:00: C đứng trong xà lim của B và trả lời thay -> hình nộm không lộ
    w.players[A.uid].wantedLevel = 0;
    w.players[Cc.uid].x = 8.5;
    w.players[Cc.uid].y = 38.5;
    w.totalGameMinutes =
      Math.floor(w.totalGameMinutes / 1440) * 1440 + 1440 + 2 * 60 - 0.4;
    await Cc.waitFor(
      'game:night-check',
      (e: { data?: { kind: string } }) => e.data?.kind === 'rollcall',
      8000,
    );
    const ans = await Cc.emit('rollcall:answer', { requestId: req() });
    expect(ans.ok).toBe(true);
    expect(
      (await Cc.emit('rollcall:answer', { requestId: req(), cell: 9 })).code,
    ).toBe('INVALID_PAYLOAD');
    await sleep(10500);
    expect(w.beds.bedrest_1.dummy).toBe(true);
    expect(w.players[B.uid].wantedLevel).toBe(0);
    expect(w.players[A.uid].wantedLevel).toBeGreaterThanOrEqual(1); // A vắng, giường trống, không ai trả lời
    expect(store.events.some((e) => e.type === 'violation:wanted')).toBe(true);
    // dọn trạng thái
    w.inmates = savedInmates;
    w.beds.bedrest_1.dummy = false;
    for (const c of [A, B, Cc]) {
      w.players[c.uid].wantedLevel = 0;
      w.players[c.uid].stats.personalHeat = 0;
    }
    w.teamHeat = 0;
    w.totalGameMinutes =
      Math.floor(w.totalGameMinutes / 1440) * 1440 + 20 * 60 + 10;
    w.players[A.uid].x = 12.5;
    w.players[A.uid].y = 38.5;
    w.players[B.uid].x = 8.5;
    w.players[B.uid].y = 38.5;
    w.players[Cc.uid].x = 16.5;
    w.players[Cc.uid].y = 38.5;
  }, 30000);

  it('đánh nhau qua socket: trang bị vũ khí, đánh trúng tù nhân, hồi chiêu, đồng đội không bị đánh nhầm, payload giả bị chặn', async () => {
    const sims = app.get(PrisonSimulationService);
    const w = sims.get(code)!.world;
    w.guards = [];
    const npc = w.inmates.find((n) => n.defId === 'npc_tu')!;
    w.inmates = [npc];
    npc.path = [];
    npc.goalZone = 'library'; // đúng mục tiêu của giờ tự do -> đứng yên chờ
    npc.waitUntil = 1e9;
    npc.combat = 'idle';
    npc.fightWith = null;
    npc.facing = Math.PI;
    npc.health = 100;
    // A đứng ở hành lang quay sang phải, tù nhân ngay trước mặt; B đứng sát đó
    w.players[A.uid].x = 10.5;
    w.players[A.uid].y = 22.5;
    w.players[A.uid].facing = 0;
    w.players[B.uid].x = 10.5;
    w.players[B.uid].y = 8.9;
    npc.x = 11.4;
    npc.y = 22.5;
    const hpB = w.players[B.uid].stats.health;
    // payload giả
    expect(
      (await A.emit('combat:attack', { requestId: req(), damage: 999 })).code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (await A.emit('combat:attack', { requestId: req(), targetId: npc.id }))
        .code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (await A.emit('combat:equip', { requestId: req(), itemId: 'laser' }))
        .code,
    ).toBe('INVALID_PAYLOAD');
    // trang bị đồ không phải vũ khí / không sở hữu
    expect(
      (await A.emit('combat:equip', { requestId: req(), itemId: 'food' })).code,
    ).toBe('INVALID_STATE');
    expect(
      (await A.emit('combat:equip', { requestId: req(), itemId: 'pipe' })).code,
    ).toBe('ITEM_NOT_OWNED');
    await sleep(1100);
    w.players[A.uid].gear.weapon = {
      itemId: 'pipe',
      quantity: 1,
      durability: 7,
    };
    expect(
      (await A.emit('combat:equip', { requestId: req(), itemId: 'pipe' })).ok,
    ).toBe(true);
    expect(w.players[A.uid].weaponDrawn).toBe(true);
    const swing = A.waitFor(
      'combat:swing',
      (e: { playerId: string }) => e.playerId === A.uid,
    );
    const r1 = await A.emit<{ hit: boolean; damage: number }>('combat:attack', {
      requestId: req(),
    });
    expect(r1.ok).toBe(true);
    expect(r1.data?.hit).toBe(true);
    expect(r1.data?.damage).toBeGreaterThan(15);
    await swing;
    expect(npc.health).toBeLessThan(100);
    // chưa hết hồi chiêu
    expect((await A.emit('combat:attack', { requestId: req() })).code).toBe(
      'RATE_LIMITED',
    );
    // chuyển sang tay không rồi đánh tiếp
    expect((await A.emit('combat:equip', { requestId: req() })).ok).toBe(true);
    expect(w.players[A.uid].weaponDrawn).toBe(false);
    // đồng đội đứng gần không bị đánh nhầm
    expect(w.players[B.uid].stats.health).toBeGreaterThanOrEqual(hpB);
    // B không điều khiển được A: tấn công luôn tính theo người gửi
    const before = npc.health;
    const rB = await B.emit('combat:attack', { requestId: req() });
    expect(rB.ok).toBe(true);
    expect(npc.health).toBeLessThanOrEqual(before);
    await sleep(1200);
    // trả vị trí về phòng
    w.players[A.uid].x = 12.5;
    w.players[A.uid].y = 38.5;
    w.players[B.uid].x = 8.5;
    w.players[B.uid].y = 38.5;
    w.players[A.uid].gear.weapon = null;
    w.players[A.uid].weaponDrawn = false;
  });

  it('lục soát qua socket: chỉ khi mục tiêu ngất, 3 giây mở túi, lấy đồ vào túi chính, payload giả bị chặn', async () => {
    const sims = app.get(PrisonSimulationService);
    const w = sims.get(code)!.world;
    w.guards = [];
    const npc = w.inmates.find((n) => n.defId === 'npc_tu')!;
    w.inmates = [npc];
    npc.path = [];
    npc.goalZone = 'library';
    npc.waitUntil = 1e9;
    npc.x = 11.4;
    npc.y = 22.5;
    npc.bag = [{ itemId: 'food', quantity: 1 }];
    npc.downUntil = 0;
    w.players[A.uid].x = 10.5;
    w.players[A.uid].y = 22.5;
    w.players[A.uid].inventory = [];
    // payload giả
    expect(
      (await A.emit('loot:start', { requestId: req(), targetId: '../x' })).code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (
        await A.emit('loot:take', {
          requestId: req(),
          targetId: npc.id,
          slot: 'hat',
          index: 0,
        })
      ).code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (await A.emit('gear:take-off', { requestId: req(), slot: 'weapon' }))
        .code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (await A.emit('disguise:answer', { requestId: req(), choice: -1 })).code,
    ).toBe('INVALID_PAYLOAD');
    // đang tỉnh -> không lục được
    expect(
      (await A.emit('loot:start', { requestId: req(), targetId: npc.id })).code,
    ).toBe('INVALID_STATE');
    npc.downUntil = w.time + 60;
    npc.health = 0;
    npc.combat = 'knockedOut';
    expect(
      (await A.emit('loot:start', { requestId: req(), targetId: npc.id })).ok,
    ).toBe(true);
    await sleep(3400);
    expect(w.players[A.uid].lootTarget).toBe(npc.id);
    expect(
      (
        await A.emit('loot:take', {
          requestId: req(),
          targetId: npc.id,
          slot: 'bag',
          index: 0,
        })
      ).ok,
    ).toBe(true);
    await sleep(800);
    expect(w.players[A.uid].inventory.some((i) => i.itemId === 'food')).toBe(
      true,
    );
    expect(npc.bag.some((i) => i.itemId === 'food')).toBe(false);
    expect((await A.emit('loot:close', { requestId: req() })).ok).toBe(true);
    expect(w.players[A.uid].lootTarget).toBeNull();
    // không bị cai ngục hỏi thì trả lời không hợp lệ
    expect(
      (await A.emit('disguise:answer', { requestId: req(), choice: 0 })).ok,
    ).toBe(false);
    npc.downUntil = 0;
    npc.health = 100;
    npc.combat = 'idle';
    w.players[A.uid].stats.personalHeat = 0;
    w.players[A.uid].x = 12.5;
    w.players[A.uid].y = 38.5;
  }, 20000);

  it('gym qua socket: chọn máy, bấm xen kẽ được +1 sức mạnh, máy có người thì không vào được, payload giả bị chặn', async () => {
    const sims = app.get(PrisonSimulationService);
    const w = sims.get(code)!.world;
    w.guards = [];
    w.totalGameMinutes =
      Math.floor(w.totalGameMinutes / 1440) * 1440 + 15 * 60 + 5;
    for (const n of w.inmates) {
      n.x = 30.5;
      n.y = 8.5;
      n.goalZone = 'yard';
      n.waitUntil = 1e9;
      n.path = [];
    }
    w.players[A.uid].x = 38.5;
    w.players[A.uid].y = 28.5;
    w.players[B.uid].x = 39.5;
    w.players[B.uid].y = 28.5;
    w.players[A.uid].stats.energy = 100;
    w.players[A.uid].stats.hunger = 0;
    w.players[A.uid].stats.strength = 5;
    expect(
      (await A.emit('gym:start', { requestId: req(), machineId: '../x' })).code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (await A.emit('gym:press', { requestId: req(), side: 2 })).code,
    ).toBe('INVALID_PAYLOAD');
    expect(
      (await A.emit('gym:start', { requestId: req(), machineId: 'press_99' }))
        .code,
    ).toBe('NOT_FOUND');
    expect(
      (await A.emit('gym:start', { requestId: req(), machineId: 'press_0' }))
        .ok,
    ).toBe(true);
    // B bấm cùng máy -> máy đang bận, không vào được, không dùng chung
    const q = await B.emit('gym:start', {
      requestId: req(),
      machineId: 'press_0',
    });
    expect(q.ok).toBe(false);
    expect(q.code).toBe('CONFLICT');
    expect(w.players[B.uid].gym).toBeNull();
    // cùng requestId không tính hai lần
    const dup = req();
    await A.emit('gym:press', { requestId: dup, side: 0 });
    await A.emit('gym:press', { requestId: dup, side: 0 });
    expect(w.players[A.uid].gym?.lastSide).toBe(0);
    let side = 1;
    for (let i = 0; i < 19; i++) {
      const r = await A.emit('gym:press', { requestId: req(), side });
      expect(r.ok).toBe(true);
      side = 1 - side;
      await sleep(70);
    }
    expect(w.players[A.uid].stats.strength).toBe(6);
    expect((await A.emit('gym:stop', { requestId: req() })).ok).toBe(true);
    // máy trống: B vào được ngay
    expect(
      (await B.emit('gym:start', { requestId: req(), machineId: 'press_0' }))
        .ok,
    ).toBe(true);
    expect(w.players[B.uid].gym?.machineId).toBe('press_0');
    await B.emit('gym:stop', { requestId: req() });
    w.players[A.uid].x = 12.5;
    w.players[A.uid].y = 38.5;
    w.players[B.uid].x = 8.5;
    w.players[B.uid].y = 38.5;
    w.totalGameMinutes =
      Math.floor(w.totalGameMinutes / 1440) * 1440 + 20 * 60 + 10;
  }, 20000);

  it('giao dịch giữa 2 socket: chỉ commit khi người nhận chấp nhận; chấp nhận trùng không nhân đôi', async () => {
    // A (phòng 1) và B (phòng 2) cách nhau ~4 ô. Mỗi người có sẵn 1 Bánh mì.
    const sims = app.get(PrisonSimulationService);
    const w = sims.get(code)!.world;
    w.players[A.uid].x = 12.5;
    w.players[A.uid].y = 38.5;
    w.players[B.uid].x = 8.5;
    w.players[B.uid].y = 38.5;
    const offer = await A.emit<{ tradeId: string }>('player:trade-request', {
      requestId: req(),
      targetPlayerId: B.uid,
      offeredItems: [{ itemId: 'food', quantity: 1 }],
    });
    expect(offer.ok).toBe(true);
    const tradeId = offer.data!.tradeId;
    await B.waitFor('player:trade-offer');
    expect(Cc.count('player:trade-offer')).toBe(0); // chỉ hai bên nhận
    expect(
      (await Cc.emit('player:trade-accept', { requestId: req(), tradeId }))
        .code,
    ).toBe('FORBIDDEN');
    const [x1, x2] = await Promise.all([
      B.emit('player:trade-accept', { requestId: req(), tradeId }),
      B.emit('player:trade-accept', { requestId: req(), tradeId }),
    ]);
    expect([x1.ok, x2.ok].filter(Boolean)).toHaveLength(1);
    expect([x1.code, x2.code]).toContain('DUPLICATE_REQUEST');
    await B.waitFor<PrivateState>('inventory:updated', (s) =>
      s.inventory.some((i) => i.itemId === 'food' && i.quantity === 2),
    );
    expect(w.players[A.uid].inventory.some((i) => i.itemId === 'food')).toBe(
      false,
    );
  });

  it('quest nhóm: 3 người góp đồng thời -> đúng 2 (mức yêu cầu), không cộng trùng, thưởng cả đội 1 lần', async () => {
    const sims = app.get(PrisonSimulationService);
    const w = sims.get(code)!.world;
    const rid1 = req();
    const res = await Promise.all([
      B.emit('quest:contribute', {
        requestId: rid1,
        questId: 't_supplies',
        objectiveId: 'food',
        contribution: 1,
      }),
      B.emit('quest:contribute', {
        requestId: rid1,
        questId: 't_supplies',
        objectiveId: 'food',
        contribution: 1,
      }),
      Cc.emit('quest:contribute', {
        requestId: req(),
        questId: 't_supplies',
        objectiveId: 'food',
        contribution: 1,
      }),
      D.emit('quest:contribute', {
        requestId: req(),
        questId: 't_supplies',
        objectiveId: 'food',
        contribution: 1,
      }),
    ]);
    expect(res[1].data).toMatchObject({ duplicate: true });
    expect(w.teamQuests.t_supplies.objectiveProgress.food).toBe(2);
    const foodLeft = [B, Cc, D].reduce(
      (n, c) =>
        n +
        (w.players[c.uid].inventory.find((i) => i.itemId === 'food')
          ?.quantity ?? 0),
      0,
    );
    expect(foodLeft).toBe(2); // B 2 + C 1 + D 1 = 4, góp đúng 2
    const money = Object.values(w.players).map((p) => p.money);
    const [c1, c2] = await Promise.all([
      A.emit('quest:complete', { requestId: req(), questId: 't_supplies' }),
      D.emit('quest:complete', { requestId: req(), questId: 't_supplies' }),
    ]);
    expect([c1.ok, c2.ok].filter(Boolean)).toHaveLength(1);
    expect(Object.values(w.players).map((p) => p.money)).toEqual(
      money.map((m) => m + 25),
    );
  });

  it('mất kết nối & kết nối lại: nhân vật giữ nguyên, nhận lại snapshot đầy đủ; socket cũ hết quyền', async () => {
    const sims = app.get(PrisonSimulationService);
    const w = sims.get(code)!.world;
    const before = {
      x: w.players[D.uid].x,
      y: w.players[D.uid].y,
      inv: JSON.stringify(w.players[D.uid].inventory),
    };
    D.close();
    const dc = await A.waitFor<{ userId: string; graceSeconds: number }>(
      'player:disconnected',
      (d) => d.userId === D.uid,
    );
    expect(dc.graceSeconds).toBe(120);
    expect(w.players[D.uid].connected).toBe(false);
    const D2 = await connect('u4');
    const back = await D2.emit<JoinPayload>('room:join', { roomCode: code });
    expect(back.ok).toBe(true);
    const meState = back.data!.state!.players.find((p) => p.id === D.uid)!;
    expect(meState.x).toBe(before.x);
    expect(JSON.stringify(back.data!.private!.inventory)).toBe(before.inv);
    await A.waitFor(
      'player:reconnected',
      (d: { userId: string }) => d.userId === D.uid,
    );
    // phiên trùng: socket thứ 3 cùng user -> socket thứ 2 mất quyền thao tác
    const D3 = await connect('u4');
    expect((await D3.emit('room:join', { roomCode: code })).ok).toBe(true);
    const stale = await D2.emit('player:interact', {
      requestId: req(),
      targetId: 'desk_3',
    });
    expect(stale.code).toBe('FORBIDDEN');
    // client thật đồng bộ sequence theo lastSeq của server sau khi vào lại
    D3.seq =
      back.data!.state!.players.find((p) => p.id === D.uid)!.lastSeq + 1000;
    D = D3;
  });

  it('đào tẩu 4 người qua socket: một người thoát không thắng; chỉ thắng khi cả 4 ESCAPED', async () => {
    const sims = app.get(PrisonSimulationService);
    const w = sims.get(code)!.world;
    w.guards = [];
    w.routes.ventOpen = true;
    // đã chui ra ngoài tường Tây (dọc bụi cây), lần lượt đi xuống ô thoát Tây-Nam
    [A, B, Cc, D].forEach((c, i) => {
      w.players[c.uid].x = 1.0;
      w.players[c.uid].y = 36.5 - i * 1.6;
    });
    expect(
      (
        await A.emit('escape:prepare', {
          requestId: req(),
          escapeMethod: 'FENCE',
        })
      ).code,
    ).toBe('REQUIREMENTS_NOT_MET');
    expect(
      (
        await A.emit('escape:prepare', {
          requestId: req(),
          escapeMethod: 'VENT',
        })
      ).ok,
    ).toBe(true);
    expect((await A.emit('escape:start', { requestId: req() })).code).toBe(
      'REQUIREMENTS_NOT_MET',
    );
    await Promise.all(
      [A, B, Cc, D].map((c) =>
        c.emit('escape:ready', { requestId: req(), ready: true }),
      ),
    );
    expect((await B.emit('escape:start', { requestId: req() })).ok).toBe(true);
    await A.waitFor('escape:started');
    const order = [A, B, Cc, D];
    for (let i = 0; i < order.length; i++) {
      await order[i].walk(0, 1, 14 + i * 8);
      await A.waitFor(
        'escape:player-escaped',
        (e: { playerId: string }) => e.playerId === order[i].uid,
        4000,
      );
      if (i < 3) {
        await sleep(150);
        expect(A.count('escape:team-victory')).toBe(0);
        expect(w.outcome).toBeNull();
      }
    }
    for (const c of order) await c.waitFor('escape:team-victory');
    expect(w.outcome).toBe('ALL_ESCAPED');
    await sleep(100);
    expect(app.get(PrisonRoomService).get(code)?.status).toBe('COMPLETED');
    expect(store.events.some((e) => e.type === 'escape:team-victory')).toBe(
      true,
    );
  });
});

describe('Grace period & khôi phục sau khi server khởi động lại', () => {
  const store = new FakePersistence();
  const clients: Client[] = [];

  afterAll(() => {
    for (const c of clients) c.close();
  });

  it('hết grace -> người rời bị loại khỏi danh sách bắt buộc, đồ vào kho nhóm', async () => {
    const { app, url, jwt } = await makeApp(store);
    const gw = app.get(PrisonGateway);
    gw.graceMs = 400;
    const mk = async (k: string) => {
      const c = new Client(url, await jwt.signAsync({ sub: USERS[k]._id }), k);
      clients.push(c);
      await c.connected();
      return c;
    };
    const [A, B] = await Promise.all([mk('u1'), mk('u2')]);
    const code = (await A.emit<JoinPayload>('room:create', {})).data!.room
      .roomCode;
    await B.emit('room:join', { roomCode: code });
    await B.emit('room:ready', { ready: true });
    expect((await A.emit('room:start')).ok).toBe(true);
    const w = app.get(PrisonSimulationService).get(code)!.world;
    B.close();
    await A.waitFor('player:disconnected');
    expect(w.requiredPlayerIds).toContain(B.uid);
    await A.waitFor(
      'room:player-left',
      (d: { userId: string }) => d.userId === B.uid,
      3000,
    );
    expect(w.requiredPlayerIds).toEqual([A.uid]);
    expect(w.teamStorage.items.some((i) => i.itemId === 'food')).toBe(true);
    const back = await mk('u2');
    const r = await back.emit('room:join', { roomCode: code });
    expect(r.code).toBe('INVALID_STATE'); // hết grace -> không còn là thành viên, trận không cho late-join
    await app.close();
  });

  it('server khởi động lại: thành viên vào lại bằng mã -> phòng khôi phục từ checkpoint mới nhất', async () => {
    const first = await makeApp(store);
    const mk = async (u: string, k: string, jwt: JwtService) => {
      const c = new Client(u, await jwt.signAsync({ sub: USERS[k]._id }), k);
      clients.push(c);
      await c.connected();
      return c;
    };
    const A = await mk(first.url, 'u5', first.jwt);
    const B = await mk(first.url, 'u6', first.jwt);
    const code = (
      await A.emit<JoinPayload>('room:create', {
        settings: { difficulty: 'HARD' },
      })
    ).data!.room.roomCode;
    await B.emit('room:join', { roomCode: code });
    await B.emit('room:ready', { ready: true });
    await A.emit('room:start');
    await A.walk(0, 1, 6);
    await sleep(200);
    const w1 = first.app.get(PrisonSimulationService).get(code)!.world;
    const pos = { x: w1.players[A.uid].x, y: w1.players[A.uid].y };
    // cả hai mất kết nối -> PAUSED + checkpoint
    A.close();
    B.close();
    await sleep(200);
    const saved = [...store.sessions.values()].find(
      (s) => s.roomCode === code,
    )!;
    expect(saved.status).toBe('PAUSED');
    expect(saved.checkpointVersion).toBeGreaterThanOrEqual(2);
    // checkpoint cũ đến muộn không ghi đè
    expect(await store.saveCheckpoint(saved._id, 1, w1, 'ACTIVE')).toBe(false);
    await first.app.close();

    const second = await makeApp(store);
    const A2 = await mk(second.url, 'u5', second.jwt);
    const res = await A2.emit<JoinPayload>('room:join', { roomCode: code });
    expect(res.ok).toBe(true);
    expect(res.data!.state!.meta.difficulty).toBe('HARD');
    const me = res.data!.state!.players.find((p) => p.id === A2.uid)!;
    expect(me.x).toBe(pos.x);
    expect(me.y).toBe(pos.y);
    expect(res.data!.room.status).toBe('PLAYING');
    // người lạ không khôi phục được phòng của người khác
    const stranger = await mk(second.url, 'u1', second.jwt);
    expect((await stranger.emit('room:join', { roomCode: code })).code).toBe(
      'INVALID_STATE',
    );
    const B2 = await mk(second.url, 'u6', second.jwt);
    expect((await B2.emit('room:join', { roomCode: code })).ok).toBe(true);
    expect(second.app.get(PrisonSimulationService).count()).toBe(1); // vẫn chỉ 1 owner
    await second.app.close();
  });
});
