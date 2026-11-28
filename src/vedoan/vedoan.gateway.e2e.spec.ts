/**
 * Vẽ Đoán online — 2 client socket.io thật: tạo phòng, vào bằng mã, bắt đầu; người vẽ chọn từ & vẽ,
 * người kia nhận nét vẽ nhưng không thấy đáp án; gần đúng chỉ báo riêng; đoán đúng -> công bố; ghép nhanh.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { User } from 'src/users/entities/user.entity';
import { VeDoanGateway } from './vedoan.gateway';
import { VeDoanRoomService } from './vedoan-room.service';
import type { VDSnapshot } from './vedoan.types';

const SECRET = 'e2e-secret';
const USERS = {
  u1: { _id: 'u1', name: 'An' },
  u2: { _id: 'u2', name: 'Bình' },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  socket: Socket;
  snap: VDSnapshot | null = null;
  matched: string | null = null;
  draws: unknown[] = [];
  chats: { text: string; kind: string }[] = [];
  constructor(url: string, token: string) {
    this.socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    this.socket.on('vd:state', (s: VDSnapshot) => (this.snap = s));
    this.socket.on('vd:draw', (d: unknown) => this.draws.push(d));
    this.socket.on('vd:chat', (m: { text: string; kind: string }) =>
      this.chats.push(m),
    );
    this.socket.on(
      'vd:matched',
      ({ code }: { code: string }) => (this.matched = code),
    );
  }
  emit<T = unknown>(ev: string, body?: unknown) {
    return this.socket.timeout(4000).emitWithAck(ev, body) as Promise<{
      ok: boolean;
      error?: string;
      data?: T;
    }>;
  }
  async until(fn: () => boolean, ms = 8000) {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ');
      await sleep(20);
    }
  }
}

describe('VeDoanGateway (e2e)', () => {
  let app: INestApplication;
  let url: string;
  const jwt = new JwtService({ secret: SECRET });
  let a: Client;
  let b: Client;

  beforeAll(async () => {
    const userModel = {
      findById: (id: string) => ({
        select: () => ({
          lean: () => Promise.resolve(USERS[id as keyof typeof USERS] ?? null),
        }),
      }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        VeDoanGateway,
        VeDoanRoomService,
        { provide: JwtService, useValue: jwt },
        { provide: getModelToken(User.name), useValue: userModel },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer() as { address(): AddressInfo }).address().port}`;
    a = new Client(url, await jwt.signAsync({ sub: 'u1' }));
    b = new Client(url, await jwt.signAsync({ sub: 'u2' }));
    await Promise.all([a, b].map((c) => c.until(() => c.socket.connected)));
  });

  afterAll(async () => {
    a.socket.close();
    b.socket.close();
    await app.close();
  });

  it('vẽ, đoán, giấu đáp án, gần đúng báo riêng, đoán đúng thì công bố rồi sang lượt kế', async () => {
    const cr = await a.emit<{ room: { code: string } }>('vd:create', {
      rounds: 2,
      drawSeconds: 60,
    });
    const code = cr.data!.room.code;
    expect((await b.emit('vd:join', { code })).ok).toBe(true);
    expect((await a.emit('vd:start')).error).toBe('Còn người chưa sẵn sàng');
    await b.emit('vd:ready', { ready: true });
    expect((await a.emit('vd:start')).ok).toBe(true);
    await a.until(() => a.snap?.phase === 'choose' && !!b.snap);
    const drawer = a.snap!.isDrawer ? a : b;
    const guesser = drawer === a ? b : a;
    expect(drawer.snap!.choices).toHaveLength(3);
    expect(guesser.snap!.choices).toEqual([]);
    expect((await guesser.emit('vd:choose', { index: 0 })).ok).toBe(false);
    expect((await drawer.emit('vd:choose', { index: 2 })).ok).toBe(true);
    await guesser.until(() => guesser.snap?.phase === 'draw');
    await drawer.until(() => drawer.snap?.phase === 'draw');
    const word = drawer.snap!.word!;
    expect(word).toBeTruthy();
    expect(guesser.snap!.word).toBeNull();
    expect(guesser.snap!.mask.length).toBe(word.length);

    const op = { k: 'l', g: 1, c: 1, s: 1, p: [100, 100, 300, 300] };
    expect(
      (await drawer.emit('vd:draw', { ops: [op], turnId: drawer.snap!.turnId }))
        .ok,
    ).toBe(true);
    await guesser.until(() => guesser.draws.length > 0);
    expect(drawer.draws).toHaveLength(0);
    expect(
      (await guesser.emit('vd:draw', { ops: [op], turnId: 1 })).error,
    ).toBe('Không phải lượt vẽ của bạn');
    const ops = await guesser.emit<{ ops: unknown[] }>('vd:ops');
    expect(ops.data!.ops).toHaveLength(1);

    // người vẽ nói lộ đáp án -> chặn
    expect((await drawer.emit('vd:chat', { text: word })).ok).toBe(false);
    // gần đúng: chỉ người đoán biết, không ai thấy tin
    const near = word.slice(0, -1) + (word.endsWith('x') ? 'y' : 'x');
    const before = drawer.chats.length;
    const rc = await guesser.emit<{ kind: string }>('vd:chat', { text: near });
    expect(['close', 'chat']).toContain(rc.data!.kind);
    if (rc.data!.kind === 'close') {
      await sleep(100);
      expect(drawer.chats.length).toBe(before);
    }
    const ok = await guesser.emit<{ kind: string; points: number }>('vd:chat', {
      text: word,
    });
    expect(ok.data!.kind).toBe('correct');
    expect(ok.data!.points).toBeGreaterThan(200);
    await drawer.until(() => drawer.snap?.phase === 'reveal');
    expect(guesser.snap!.word).toBe(word);
    expect(drawer.chats.some((c) => c.kind === 'correct')).toBe(true);
    // sau 6 giây công bố -> lượt người kia
    await guesser.until(
      () => guesser.snap?.phase === 'choose' && guesser.snap.isDrawer,
      9000,
    );
    await a.emit('vd:leave');
    await b.emit('vd:leave');
  }, 30000);

  it('ghép nhanh: 2 người chờ một lúc thì mở bàn', async () => {
    a.snap = b.snap = null;
    expect((await a.emit('vd:quick')).ok).toBe(true);
    expect((await b.emit('vd:quick')).ok).toBe(true);
    await a.until(() => !!a.matched && !!b.matched, 15000);
    expect(a.matched).toBe(b.matched);
    await a.until(() => !!a.snap);
    expect(a.snap!.players).toHaveLength(2);
    await a.emit('vd:leave');
    await b.emit('vd:leave');
  }, 30000);
});
