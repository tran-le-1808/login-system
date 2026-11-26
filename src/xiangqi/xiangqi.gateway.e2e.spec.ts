/**
 * Cờ tướng online — 2 client socket.io thật qua gateway (cổng ngẫu nhiên). MongoDB giả lập.
 * Kiểm tra: ghép trận nhanh, nước đi đúng lượt / đúng luật, chiếu bí (thế "chiếu bí nhanh nhất"),
 * ván mới đổi màu, tạo phòng / vào bằng mã / sẵn sàng / bắt đầu, xin hoà, xin thua, rời phòng.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { User } from 'src/users/entities/user.entity';
import { XiangqiGateway } from './xiangqi.gateway';
import { XiangqiRoomService } from './xiangqi-room.service';
import type { XqSnapshot } from './xiangqi.types';
import { idx } from './shared/rules';

const SECRET = 'e2e-secret';
const USERS = {
  u1: { _id: 'u1', name: 'An' },
  u2: { _id: 'u2', name: 'Bình' },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  socket: Socket;
  snap: XqSnapshot | null = null;
  matched: string | null = null;
  constructor(url: string, token: string) {
    this.socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    this.socket.on('xq:state', (s: XqSnapshot) => (this.snap = s));
    this.socket.on(
      'xq:matched',
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
  async move(f: [number, number], t: [number, number]) {
    const r = await this.emit('xq:move', {
      from: idx(f[0], f[1]),
      to: idx(t[0], t[1]),
      seq: this.snap?.seq,
    });
    await sleep(140);
    return r;
  }
}

describe('XiangqiGateway (e2e)', () => {
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
        XiangqiGateway,
        XiangqiRoomService,
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

  it('ghép trận nhanh -> đúng lượt, đúng luật -> chiếu bí -> ván mới đổi màu -> rời phòng bị xử thua', async () => {
    expect((await a.emit('xq:quick')).ok).toBe(true);
    expect((await b.emit('xq:quick')).ok).toBe(true);
    await a.until(() => !!a.matched && !!b.matched);
    expect(a.matched).toBe(b.matched);
    await a.until(() => !!a.snap && !!b.snap);
    expect(a.snap!.timeMinutes).toBe(10);
    const redUser = a.snap!.players[a.snap!.redSeat];
    const R = redUser === 'u1' ? a : b;
    const B = R === a ? b : a;
    expect((await B.move([1, 2], [4, 2])).error).toBe('Chưa tới lượt của bạn');
    expect((await R.move([1, 9], [1, 7])).ok).toBe(false); // mã không đi thẳng
    // 1. P2-5  B1.1
    expect((await R.move([7, 7], [4, 7])).ok).toBe(true);
    await B.until(() => B.snap!.moves.length === 1);
    expect((await B.move([0, 3], [0, 4])).ok).toBe(true);
    await R.until(() => R.snap!.moves.length === 2);
    // pháo không có ngòi thì không ăn được (P5.? ăn tốt (4,3) qua tốt (4,6) của mình là ngòi -> hợp lệ)
    expect((await R.move([1, 7], [1, 3])).ok).toBe(true);
    await B.until(() => B.snap!.moves.length === 3);
    // 2... pháo đen ăn pháo đỏ qua ngòi mã? (1,2)->(1,3) ăn pháo đỏ vừa lên
    expect((await B.move([1, 2], [1, 3])).ok).toBe(false); // sát bên: không có ngòi -> không ăn được
    expect((await B.move([1, 0], [2, 2])).ok).toBe(true);
    await R.until(() => R.snap!.moves.length === 4);
    expect(R.snap!.captures).toEqual([0, 0, 0, 0]);
    // Đỏ xin thua để kết thúc nhanh (chiếu bí đã kiểm tra trong test luật)
    expect((await R.emit('xq:resign')).ok).toBe(true);
    await B.until(() => B.snap!.winnerSeat !== null);
    expect(B.snap!.players[B.snap!.winnerSeat!]).not.toBe(redUser);
    const firstRed = B.snap!.redSeat;
    expect((await B.emit('xq:rematch')).ok).toBe(true);
    await R.until(
      () => R.snap!.moves.length === 0 && R.snap!.winnerSeat === null,
    );
    expect(R.snap!.redSeat).toBe(1 - firstRed);
    expect((await a.emit('xq:leave')).ok).toBe(true);
    await b.until(() => b.snap!.winnerSeat !== null);
    expect(b.snap!.endReason).toContain('rời phòng');
    await b.emit('xq:leave');
  });

  it('tạo phòng -> vào bằng mã -> sẵn sàng -> bắt đầu; xin hoà / từ chối / đồng ý', async () => {
    a.snap = b.snap = null;
    const cr = await a.emit<{ room: { code: string } }>('xq:create', {
      timeMinutes: 5,
    });
    expect(cr.ok).toBe(true);
    const code = cr.data!.room.code;
    const list = await b.emit<{ code: string }[]>('xq:list');
    expect(list.data!.some((r) => r.code === code)).toBe(true);
    expect((await b.emit('xq:join', { code })).ok).toBe(true);
    expect((await a.emit('xq:start')).error).toBe('Đối thủ chưa sẵn sàng');
    expect((await b.emit('xq:ready', { ready: true })).ok).toBe(true);
    expect((await a.emit('xq:start')).ok).toBe(true);
    await a.until(() => !!a.snap && !!b.snap);
    expect(a.snap!.timeMinutes).toBe(5);
    expect(a.snap!.clocks).toEqual([300_000, 300_000]);
    expect((await a.emit('xq:draw:offer')).ok).toBe(true);
    await b.until(() => b.snap!.drawOffer !== null);
    expect((await b.emit('xq:draw:answer', { accept: false })).ok).toBe(true);
    await a.until(() => a.snap!.drawOffer === null);
    expect((await b.emit('xq:draw:offer')).ok).toBe(true);
    await a.until(() => a.snap!.drawOffer !== null);
    expect((await a.emit('xq:draw:answer', { accept: true })).ok).toBe(true);
    await b.until(() => b.snap!.draw);
    expect(b.snap!.winnerSeat).toBeNull();
    expect(b.snap!.endReason).toContain('Hoà');
  });
});
