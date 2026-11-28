/**
 * Ma Sói online — 2 client socket.io thật + máy. Kiểm tra: tạo phòng, thêm máy, vào bằng mã, sẵn sàng, bắt đầu;
 * mỗi người chỉ thấy vai mình; chat ban đêm của dân bị chặn; chơi tới hết ván; ván mới;
 * rời giữa ván -> máy thay; ghép nhanh -> thêm máy cho đủ 8.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { User } from 'src/users/entities/user.entity';
import { MaSoiGateway } from './masoi.gateway';
import { MaSoiRoomService } from './masoi-room.service';
import type { MSSnapshot } from './masoi.types';

const SECRET = 'e2e-secret';
const USERS = {
  u1: { _id: 'u1', name: 'An' },
  u2: { _id: 'u2', name: 'Bình' },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  socket: Socket;
  snap: MSSnapshot | null = null;
  matched: string | null = null;
  auto = false;
  chats: { text: string; channel: string }[] = [];
  constructor(url: string, token: string) {
    this.socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    this.socket.on('ms:state', (s: MSSnapshot) => {
      this.snap = s;
      if (this.auto) void this.autoPlay();
    });
    this.socket.on('ms:chat', (m: { text: string; channel: string }) =>
      this.chats.push(m),
    );
    this.socket.on(
      'ms:matched',
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
  /** Người chơi đơn giản: chọn người còn sống đầu tiên hợp lệ */
  async autoPlay() {
    const s = this.snap;
    if (this.busy || !s || s.phase === 'over') return;
    const me = s.mySeat;
    const hunter = s.phase === 'hunter' && s.hunterSeat === me;
    if ((!s.alive[me] && !hunter) || (s.done && !hunter)) return;
    const others = s.alive
      .map((a, i) => (a && i !== me ? i : -1))
      .filter((i) => i >= 0);
    let action: Record<string, unknown> | null = null;
    if (s.phase === 'night') {
      if (s.myRole === 'wolf' && (s.wolfVotes?.[me] ?? -1) < 0)
        action = {
          k: 'kill',
          target: others.find((i) => s.roles[i] !== 'wolf'),
        };
      else if (s.myRole === 'seer') action = { k: 'see', target: others[0] };
      else if (s.myRole === 'guard')
        action = { k: 'guard', target: others.find((i) => i !== s.lastGuard) };
    } else if (s.phase === 'witch' && s.myRole === 'witch')
      action = { k: 'witch', save: false, poison: -1 };
    else if (s.phase === 'day') action = { k: 'ready' };
    else if (s.phase === 'vote') action = { k: 'vote', target: others[0] };
    else if (hunter) action = { k: 'shoot', target: -1 };
    if (!action) return;
    this.busy = true;
    await sleep(160);
    await this.emit('ms:act', { action });
    this.busy = false;
  }
}

describe('MaSoiGateway (e2e)', () => {
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
        MaSoiGateway,
        MaSoiRoomService,
        { provide: JwtService, useValue: jwt },
        { provide: getModelToken(User.name), useValue: userModel },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    app.get(MaSoiGateway).botDelayScale = 0.003;
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

  it('làng 2 người + 5 máy: chơi hết ván, vai riêng tư, chat đêm theo kênh, ván mới, rời -> máy thay', async () => {
    const cr = await a.emit<{ room: { code: string } }>('ms:create', {
      discussSeconds: 60,
      bots: 4,
    });
    const code = cr.data!.room.code;
    expect((await a.emit('ms:bot:add', { level: 'hard' })).ok).toBe(true);
    expect((await b.emit('ms:join', { code })).ok).toBe(true);
    expect((await a.emit('ms:start')).error).toBe('Còn người chưa sẵn sàng');
    expect((await b.emit('ms:ready', { ready: true })).ok).toBe(true);
    expect((await a.emit('ms:start')).ok).toBe(true);
    await a.until(() => !!a.snap && !!b.snap);
    const sa = a.snap!;
    const sb = b.snap!;
    expect(sa.n).toBe(7);
    expect(sa.phase).toBe('night');
    expect(sa.myRole).not.toBeNull();
    // không thấy vai của nhau, trừ khi cả hai là Sói
    if (!(sa.myRole === 'wolf' && sb.myRole === 'wolf')) {
      expect(sa.roles[sb.mySeat]).toBeNull();
      expect(sb.roles[sa.mySeat]).toBeNull();
    }
    // chat ban đêm: dân bị chặn, Sói nói trong kênh Sói (người kia không nhận nếu không phải Sói)
    const ra = await a.emit('ms:chat', { text: 'đêm nay ai?' });
    if (sa.myRole === 'wolf') {
      expect(ra.ok).toBe(true);
      await sleep(100);
      expect(b.chats.some((c) => c.text === 'đêm nay ai?')).toBe(
        sb.myRole === 'wolf',
      );
    } else expect(ra.error).toBe('Ban đêm chỉ bầy Sói được nói chuyện');

    a.auto = b.auto = true;
    void a.autoPlay();
    void b.autoPlay();
    await a.until(
      () => a.snap?.phase === 'over' && b.snap?.phase === 'over',
      40000,
    );
    expect(a.snap!.winner).not.toBeNull();
    expect(a.snap!.roles.every((r) => r !== null)).toBe(true);
    const firstGames = a.snap!.games;
    expect((await b.emit('ms:next')).ok).toBe(true);
    await a.until(() => a.snap!.games === firstGames + 1);
    // b rời giữa ván -> máy chơi thay, ván vẫn tiếp tục tới hết
    b.auto = false;
    expect((await b.emit('ms:leave')).ok).toBe(true);
    await a.until(() => a.snap!.names.some((n) => n.includes('máy thay')));
    void a.autoPlay();
    await a.until(() => a.snap?.phase === 'over', 40000);
    a.auto = false;
    await a.emit('ms:leave');
  }, 90000);

  it('ghép nhanh: 2 người chờ -> sau một lúc thêm máy cho đủ 8', async () => {
    a.snap = b.snap = null;
    expect((await a.emit('ms:quick')).ok).toBe(true);
    expect((await b.emit('ms:quick')).ok).toBe(true);
    await a.until(() => !!a.matched && !!b.matched, 15000);
    expect(a.matched).toBe(b.matched);
    await a.until(() => !!a.snap);
    expect(a.snap!.n).toBe(8);
    expect(a.snap!.bots.filter(Boolean)).toHaveLength(6);
    await a.emit('ms:leave');
    await b.emit('ms:leave');
  }, 30000);

  it('voice: bật voice, nhận danh sách peer, chuyển tín hiệu đúng người, rời voice', async () => {
    const cr = await a.emit<{ room: { code: string } }>('ms:create', {});
    const code = cr.data!.room.code;
    expect((await b.emit('ms:join', { code })).ok).toBe(true);
    const cfg = await a.emit<{ iceServers: unknown[] }>('ms:voice:config');
    expect(cfg.data!.iceServers.length).toBeGreaterThan(0);
    expect(
      (await a.emit<{ peers: string[] }>('ms:voice:join')).data!.peers,
    ).toEqual([]);
    // b chưa bật voice -> không gửi tín hiệu tới b được
    expect((await a.emit('ms:voice:signal', { to: 'u2', data: {} })).ok).toBe(
      false,
    );
    const got: unknown[] = [];
    a.socket.on('ms:voice:signal', (m: unknown) => got.push(m));
    const jb = await b.emit<{ peers: string[] }>('ms:voice:join', {
      muted: true,
    });
    expect(jb.data!.peers).toEqual(['u1']);
    expect(
      (await b.emit('ms:voice:signal', { to: 'u1', data: { type: 'offer' } }))
        .ok,
    ).toBe(true);
    await a.until(() => got.length > 0);
    expect(got[0]).toEqual({ from: 'u2', data: { type: 'offer' } });
    const list = await a.emit<{ users: { userId: string; muted: boolean }[] }>(
      'ms:voice:list',
    );
    expect(list.data!.users).toEqual(
      expect.arrayContaining([{ userId: 'u2', muted: true }]),
    );
    const left: string[] = [];
    a.socket.on('ms:voice:left', ({ userId }: { userId: string }) =>
      left.push(userId),
    );
    await b.emit('ms:leave');
    await a.until(() => left.includes('u2'));
    await a.emit('ms:leave');
  }, 20000);
});
