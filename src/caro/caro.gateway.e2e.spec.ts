/**
 * Cờ caro online — 2 client socket.io thật qua gateway (cổng ngẫu nhiên). MongoDB giả lập.
 * Kiểm tra: ghép trận nhanh, tạo phòng / vào bằng mã / sẵn sàng / bắt đầu, nước đi đúng lượt,
 * thắng 5 quân, luật chặn 2 đầu, xin thua, ván mới đổi người đi trước.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { User } from 'src/users/entities/user.entity';
import { CaroGateway } from './caro.gateway';
import { CaroRoomService } from './caro-room.service';
import { CaroBookService, MemoryCaroBookStore } from './caro-book.service';
import type { CaroSnapshot } from './caro.types';

const SECRET = 'e2e-secret';
const USERS = {
  u1: { _id: 'u1', name: 'An' },
  u2: { _id: 'u2', name: 'Bình' },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  socket: Socket;
  snap: CaroSnapshot | null = null;
  matched: string | null = null;
  constructor(url: string, token: string) {
    this.socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    this.socket.on('caro:state', (s: CaroSnapshot) => (this.snap = s));
    this.socket.on(
      'caro:matched',
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
  async until(fn: () => boolean, ms = 3000) {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ');
      await sleep(20);
    }
  }
  async move(x: number, y: number) {
    const r = await this.emit('caro:move', { x, y, seq: this.snap?.seq });
    await sleep(140); // giới hạn tần suất nước đi
    return r;
  }
}

describe('CaroGateway (e2e)', () => {
  let app: INestApplication;
  let url: string;
  const jwt = new JwtService({ secret: SECRET });
  let a: Client;
  let b: Client;
  const store = new MemoryCaroBookStore();

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
        CaroGateway,
        CaroRoomService,
        { provide: CaroBookService, useValue: new CaroBookService(store) },
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

  it('ghép trận nhanh cùng luật -> vào phòng, ván bắt đầu; đi đúng lượt; 5 quân liền thắng; ván mới đổi người cầm X', async () => {
    expect((await a.emit('caro:quick', { rule: 'free' })).ok).toBe(true);
    expect((await b.emit('caro:quick', { rule: 'free' })).ok).toBe(true);
    await a.until(() => !!a.matched && !!b.matched);
    expect(a.matched).toBe(b.matched);
    await a.until(() => !!a.snap && !!b.snap);
    const s = a.snap!;
    expect(s.rule).toBe('free');
    const xUser = s.players[s.xSeat];
    const X = xUser === 'u1' ? a : b;
    const O = X === a ? b : a;
    expect((await O.move(0, 0)).error).toBe('Chưa tới lượt bạn');
    for (let i = 0; i < 4; i++) {
      expect((await X.move(i, 5)).ok).toBe(true);
      await O.until(() => O.snap!.moves.length === 2 * i + 1);
      expect((await O.move(i, 7)).ok).toBe(true);
      await X.until(() => X.snap!.moves.length === 2 * i + 2);
    }
    expect((await O.move(9, 9)).error).toBe('Chưa tới lượt bạn');
    expect((await X.move(0, 7)).error).toBe('Ô này đã có quân');
    expect((await X.move(4, 5)).ok).toBe(true);
    await O.until(() => O.snap!.winnerSeat !== null);
    expect(O.snap!.players[O.snap!.winnerSeat!]).toBe(xUser);
    expect(O.snap!.winLine).toHaveLength(5);
    expect(O.snap!.score[O.snap!.xSeat]).toBe(1);
    // ván online vừa xong được đưa vào sách khai cuộc
    await sleep(50);
    expect([...store.data.keys()].some((k) => k.startsWith('free|'))).toBe(
      true,
    );
    const firstX = O.snap!.xSeat;
    expect((await O.emit('caro:rematch')).ok).toBe(true);
    await X.until(
      () => X.snap!.moves.length === 0 && X.snap!.winnerSeat === null,
    );
    expect(X.snap!.xSeat).toBe(1 - firstX);
    // rời phòng giữa ván -> xử thua
    expect((await a.emit('caro:leave')).ok).toBe(true);
    await b.until(() => b.snap!.winnerSeat !== null);
    expect(b.snap!.endReason).toContain('rời phòng');
    await b.emit('caro:leave');
  });

  it('tạo phòng (chặn 2 đầu) -> vào bằng mã -> sẵn sàng -> chủ phòng bắt đầu; 5 quân bị chặn hai đầu không thắng; xin thua', async () => {
    a.snap = b.snap = null;
    const cr = await a.emit<{ room: { code: string } }>('caro:create', {
      rule: 'block2',
      turnSeconds: 60,
    });
    expect(cr.ok).toBe(true);
    const code = cr.data!.room.code;
    const list = await b.emit<{ code: string }[]>('caro:list');
    expect(list.data!.some((r) => r.code === code)).toBe(true);
    expect((await b.emit('caro:join', { code })).ok).toBe(true);
    expect((await b.emit('caro:start')).error).toBe(
      'Chỉ chủ phòng mới được bắt đầu',
    );
    expect((await a.emit('caro:start')).error).toBe('Đối thủ chưa sẵn sàng');
    expect((await b.emit('caro:ready', { ready: true })).ok).toBe(true);
    expect((await a.emit('caro:start')).ok).toBe(true);
    await a.until(() => !!a.snap && !!b.snap);
    const X = a.snap!.players[a.snap!.xSeat] === 'u1' ? a : b;
    const O = X === a ? b : a;
    // X: (3..7,5); O chặn (2,5), (8,5)
    const xs = [
      [3, 5],
      [4, 5],
      [5, 5],
      [6, 5],
    ];
    const os = [
      [2, 5],
      [8, 5],
      [0, 0],
      [0, 2],
    ];
    for (let i = 0; i < 4; i++) {
      expect((await X.move(xs[i][0], xs[i][1])).ok).toBe(true);
      await O.until(() => O.snap!.moves.length === 2 * i + 1);
      expect((await O.move(os[i][0], os[i][1])).ok).toBe(true);
      await X.until(() => X.snap!.moves.length === 2 * i + 2);
    }
    expect((await X.move(7, 5)).ok).toBe(true);
    await O.until(() => O.snap!.moves.length === 9);
    expect(O.snap!.winnerSeat).toBeNull();
    expect((await O.emit('caro:resign')).ok).toBe(true);
    await X.until(() => X.snap!.winnerSeat !== null);
    expect(X.snap!.endReason).toContain('xin thua');
  });
});
