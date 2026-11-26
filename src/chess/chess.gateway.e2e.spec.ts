/**
 * Cờ vua online — 2 client socket.io thật qua gateway (cổng ngẫu nhiên). MongoDB giả lập.
 * Kiểm tra: ghép trận nhanh, nước đi đúng lượt / đúng luật, chiếu hết nhanh,
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
import { ChessGateway } from './chess.gateway';
import { ChessRoomService } from './chess-room.service';
import type { ChessSnapshot } from './chess.types';
import { sq as idx } from './shared/rules';

const SECRET = 'e2e-secret';
const USERS = {
  u1: { _id: 'u1', name: 'An' },
  u2: { _id: 'u2', name: 'Bình' },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  socket: Socket;
  snap: ChessSnapshot | null = null;
  matched: string | null = null;
  constructor(url: string, token: string) {
    this.socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    this.socket.on('chess:state', (s: ChessSnapshot) => (this.snap = s));
    this.socket.on(
      'chess:matched',
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
    const r = await this.emit('chess:move', {
      from: idx(f[0], f[1]),
      to: idx(t[0], t[1]),
      seq: this.snap?.seq,
    });
    await sleep(140);
    return r;
  }
}

describe('ChessGateway (e2e)', () => {
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
        ChessGateway,
        ChessRoomService,
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

  it('ghép trận nhanh -> đúng lượt, đúng luật -> chiếu hết (mạt Học trò) -> ván mới đổi màu -> rời phòng bị xử thua', async () => {
    expect((await a.emit('chess:quick')).ok).toBe(true);
    expect((await b.emit('chess:quick')).ok).toBe(true);
    await a.until(() => !!a.matched && !!b.matched);
    expect(a.matched).toBe(b.matched);
    await a.until(() => !!a.snap && !!b.snap);
    expect(a.snap!.timeMinutes).toBe(10);
    const whiteUser = a.snap!.players[a.snap!.whiteSeat];
    const R = whiteUser === 'u1' ? a : b;
    const B = R === a ? b : a;
    expect((await B.move([4, 1], [4, 3])).error).toBe('Chưa tới lượt của bạn');
    expect((await R.move([0, 7], [0, 4])).ok).toBe(false); // xe bị tốt chặn
    // Chiếu hết nhanh nhất cho Đen (Fool's mate) đảo vai: Trắng đi f3, g4 -> Đen Qh4#
    // ở đây Trắng là R: 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#
    const line: [[number, number], [number, number]][] = [
      [
        [4, 6],
        [4, 4],
      ],
      [
        [4, 1],
        [4, 3],
      ],
      [
        [5, 7],
        [2, 4],
      ],
      [
        [1, 0],
        [2, 2],
      ],
      [
        [3, 7],
        [7, 3],
      ],
      [
        [6, 0],
        [5, 2],
      ],
      [
        [7, 3],
        [5, 1],
      ],
    ];
    for (let i = 0; i < line.length; i++) {
      const P = i % 2 === 0 ? R : B;
      const O = P === R ? B : R;
      expect((await P.move(...line[i])).ok).toBe(true);
      await O.until(() => O.snap!.moves.length === i + 1);
    }
    expect(B.snap!.san.at(-1)).toBe('Qxf7#');
    expect(B.snap!.players[B.snap!.winnerSeat!]).toBe(whiteUser);
    const firstRed = B.snap!.whiteSeat;
    expect((await B.emit('chess:rematch')).ok).toBe(true);
    await R.until(
      () => R.snap!.moves.length === 0 && R.snap!.winnerSeat === null,
    );
    expect(R.snap!.whiteSeat).toBe(1 - firstRed);
    expect((await a.emit('chess:leave')).ok).toBe(true);
    await b.until(() => b.snap!.winnerSeat !== null);
    expect(b.snap!.endReason).toContain('rời phòng');
    await b.emit('chess:leave');
  });

  it('tạo phòng -> vào bằng mã -> sẵn sàng -> bắt đầu; xin hoà / từ chối / đồng ý', async () => {
    a.snap = b.snap = null;
    const cr = await a.emit<{ room: { code: string } }>('chess:create', {
      timeMinutes: 3,
    });
    expect(cr.ok).toBe(true);
    const code = cr.data!.room.code;
    const list = await b.emit<{ code: string }[]>('chess:list');
    expect(list.data!.some((r) => r.code === code)).toBe(true);
    expect((await b.emit('chess:join', { code })).ok).toBe(true);
    expect((await a.emit('chess:start')).error).toBe('Đối thủ chưa sẵn sàng');
    expect((await b.emit('chess:ready', { ready: true })).ok).toBe(true);
    expect((await a.emit('chess:start')).ok).toBe(true);
    await a.until(() => !!a.snap && !!b.snap);
    expect(a.snap!.timeMinutes).toBe(3);
    expect(a.snap!.clocks).toEqual([180_000, 180_000]);
    expect((await a.emit('chess:draw:offer')).ok).toBe(true);
    await b.until(() => b.snap!.drawOffer !== null);
    expect((await b.emit('chess:draw:answer', { accept: false })).ok).toBe(
      true,
    );
    await a.until(() => a.snap!.drawOffer === null);
    expect((await b.emit('chess:draw:offer')).ok).toBe(true);
    await a.until(() => a.snap!.drawOffer !== null);
    expect((await a.emit('chess:draw:answer', { accept: true })).ok).toBe(true);
    await b.until(() => b.snap!.draw);
    expect(b.snap!.winnerSeat).toBeNull();
    expect(b.snap!.endReason).toContain('Hoà');
  });
});
