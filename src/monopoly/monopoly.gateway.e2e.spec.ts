/**
 * Cờ Tỷ Phú — phòng chờ có bot: client socket.io thật qua gateway (cổng ngẫu nhiên).
 * Kiểm tra: chỉ chủ phòng thêm bot, bot luôn sẵn sàng, 1 người + bot bắt đầu được,
 * đổi độ khó, xoá bot (kick), không thêm bot khi trận đã bắt đầu.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { User } from 'src/users/entities/user.entity';
import { MonopolyGateway } from './monopoly.gateway';
import { MonopolyRoomService } from './monopoly-room.service';
import type { PublicRoom } from './monopoly.types';

const SECRET = 'e2e-secret';
const USERS = {
  u1: { _id: 'u1', name: 'An' },
  u2: { _id: 'u2', name: 'Bình' },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  socket: Socket;
  room: PublicRoom | null = null;
  constructor(url: string, token: string) {
    this.socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    this.socket.on('mono:room', (r: PublicRoom) => (this.room = r));
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
}

describe('MonopolyGateway bots (e2e)', () => {
  let app: INestApplication;
  let a: Client;
  let b: Client;

  beforeAll(async () => {
    const jwt = new JwtService({ secret: SECRET });
    const userModel = {
      findById: (id: string) => ({
        select: () => ({
          lean: () => Promise.resolve(USERS[id as keyof typeof USERS] ?? null),
        }),
      }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        MonopolyGateway,
        MonopolyRoomService,
        { provide: JwtService, useValue: jwt },
        { provide: getModelToken(User.name), useValue: userModel },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    const url = `http://127.0.0.1:${(app.getHttpServer() as { address(): AddressInfo }).address().port}`;
    a = new Client(url, await jwt.signAsync({ sub: 'u1' }));
    b = new Client(url, await jwt.signAsync({ sub: 'u2' }));
    await Promise.all([a, b].map((c) => c.until(() => c.socket.connected)));
  });

  afterAll(async () => {
    a.socket.close();
    b.socket.close();
    await app.close();
  });

  it('chủ phòng thêm bot, đổi độ khó, xoá bot và bắt đầu trận với bot', async () => {
    const created = await a.emit<{ room: PublicRoom }>('mono:create');
    const code = created.data!.room.code;
    expect((await b.emit('mono:join', { code })).ok).toBe(true);

    // người không phải chủ phòng không thêm được bot
    expect((await b.emit('mono:bot:add', {})).ok).toBe(false);

    expect((await a.emit('mono:bot:add', { level: 'hard', seat: 3 })).ok).toBe(
      true,
    );
    await a.until(() => a.room?.players.length === 3);
    const bot = a.room!.players.find((p) => p.botLevel)!;
    expect(bot).toMatchObject({ seat: 3, ready: true, botLevel: 'hard' });

    expect(
      (await a.emit('mono:bot:level', { userId: bot.userId, level: 'easy' }))
        .ok,
    ).toBe(true);
    await a.until(
      () => a.room!.players.find((p) => p.botLevel)?.botLevel === 'easy',
    );

    // xoá bot bằng kick
    expect((await a.emit('mono:kick', { userId: bot.userId })).ok).toBe(true);
    await a.until(() => a.room!.players.length === 2);

    // B rời phòng -> A + 1 bot vẫn bắt đầu được
    expect((await b.emit('mono:leave')).ok).toBe(true);
    expect((await a.emit('mono:bot:add', { level: 'normal' })).ok).toBe(true);
    await a.until(() => a.room?.players.length === 2);
    expect((await a.emit('mono:start')).ok).toBe(true);
    await a.until(() => a.room?.status === 'playing');
    expect((await a.emit('mono:bot:add', {})).ok).toBe(false);

    // A rời -> chỉ còn bot -> phòng bị xoá
    expect((await a.emit('mono:leave')).ok).toBe(true);
    expect((await b.emit('mono:join', { code })).ok).toBe(false);
  });
});
