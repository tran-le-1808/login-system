/**
 * Sắc Màu online — 2 client socket.io thật + 2 máy. Kiểm tra: tạo phòng, thêm máy, vào bằng mã, sẵn sàng,
 * bắt đầu; mỗi người chỉ thấy bài mình; đánh tới hết ván (người: đánh lá đầu tiên đánh được, không có thì bốc);
 * ván mới; rời giữa ván -> máy đánh thay; ghép nhanh một mình -> thêm máy cho đủ bàn.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { User } from 'src/users/entities/user.entity';
import { SacMauGateway } from './sacmau.gateway';
import { SacMauRoomService } from './sacmau-room.service';
import type { SMSnapshot } from './sacmau.types';

const SECRET = 'e2e-secret';
const USERS = {
  u1: { _id: 'u1', name: 'An' },
  u2: { _id: 'u2', name: 'Bình' },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  socket: Socket;
  snap: SMSnapshot | null = null;
  matched: string | null = null;
  auto = false;
  constructor(url: string, token: string) {
    this.socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    this.socket.on('sm:state', (s: SMSnapshot) => {
      this.snap = s;
      if (this.auto) void this.autoPlay();
    });
    this.socket.on(
      'sm:matched',
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
  private busy = false;
  async autoPlay() {
    const s = this.snap;
    if (this.busy || !s || s.over || s.turn !== s.mySeat) return;
    this.busy = true;
    await sleep(160);
    if (s.playable.length)
      await this.emit('sm:play', {
        card: s.playable[0],
        color: 0,
        call: true,
        seq: s.seq,
      });
    else if (s.drawn !== null) await this.emit('sm:pass', { seq: s.seq });
    else await this.emit('sm:draw', { seq: s.seq });
    this.busy = false;
    void this.autoPlay();
  }
}

describe('SacMauGateway (e2e)', () => {
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
        SacMauGateway,
        SacMauRoomService,
        { provide: JwtService, useValue: jwt },
        { provide: getModelToken(User.name), useValue: userModel },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    app.get(SacMauGateway).botDelay = [5, 10];
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

  it('phòng 2 người + 2 máy: đánh tới hết ván, chỉ thấy bài mình, ván mới, rời giữa ván -> máy thay', async () => {
    const cr = await a.emit<{ room: { code: string } }>('sm:create', {
      turnSeconds: 15,
    });
    const code = cr.data!.room.code;
    expect((await a.emit('sm:bot:add', { level: 'hard' })).ok).toBe(true);
    expect((await a.emit('sm:bot:add', { level: 'easy' })).ok).toBe(true);
    expect((await b.emit('sm:join', { code })).ok).toBe(true);
    expect((await a.emit('sm:start')).error).toBe('Còn người chưa sẵn sàng');
    expect((await b.emit('sm:ready', { ready: true })).ok).toBe(true);
    a.auto = b.auto = true;
    expect((await a.emit('sm:start')).ok).toBe(true);
    await a.until(() => !!a.snap && !!b.snap);
    expect(a.snap!.n).toBe(4);
    expect(a.snap!.hand).toHaveLength(7);
    expect(a.snap!.hand).not.toEqual(b.snap!.hand);
    expect(a.snap!.revealed).toBeNull();
    await a.until(() => !!a.snap?.over && !!b.snap?.over, 30000);
    expect(a.snap!.lastScores!.reduce((x, y) => x + y, 0)).toBe(0);
    expect(a.snap!.revealed).not.toBeNull();
    const firstGames = a.snap!.games;
    expect((await b.emit('sm:next')).ok).toBe(true);
    await a.until(() => a.snap!.games === firstGames + 1);
    // b rời giữa ván -> máy đánh thay, ván vẫn tiếp tục tới hết
    b.auto = false;
    expect((await b.emit('sm:leave')).ok).toBe(true);
    await a.until(() => a.snap!.names.some((n) => n.includes('máy đánh thay')));
    await a.until(() => !!a.snap?.over, 30000);
    a.auto = false;
    await a.emit('sm:leave');
  }, 60000);

  it('ghép nhanh: 2 người chờ -> sau một lúc thêm máy cho đủ 4', async () => {
    a.snap = b.snap = null;
    expect((await a.emit('sm:quick')).ok).toBe(true);
    expect((await b.emit('sm:quick')).ok).toBe(true);
    await a.until(() => !!a.matched && !!b.matched, 15000);
    expect(a.matched).toBe(b.matched);
    await a.until(() => !!a.snap);
    expect(a.snap!.n).toBe(4);
    expect(a.snap!.bots.filter(Boolean)).toHaveLength(2);
    await a.emit('sm:leave');
    await b.emit('sm:leave');
  }, 30000);
});
