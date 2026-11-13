import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Server, Socket } from 'socket.io';
import { User, UserDocument } from 'src/users/entities/user.entity';
import { getIceServers } from '../realtime/ice-servers';
import { PoolRoomService } from './pool-room.service';
import { PoolStatsService } from './pool-stats.service';
import {
  AckResponse,
  POOL_MAX_PLAYERS,
  PoolRoomSettings,
  PoolSnapshot,
  PublicRoom,
  Room,
  RoomChatMessage,
} from './pool.types';
import {
  AIM_MIN_INTERVAL_MS,
  ERROR_MESSAGES,
  PoolErrorCode,
  RECONNECT_GRACE_MS,
  validateAim,
} from './shared/protocol';
import type { GameType } from './shared/rules/types';

const LOBBY_GRACE_MS = 15_000;
const MAX_CHAT_LENGTH = 300;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX_IN_WINDOW = 6;
/** Giới hạn tần suất thao tác trận (đặt bi / đánh / chọn) mỗi kết nối */
const ACTION_MIN_INTERVAL_MS = 150;
const QUICK_SWEEP_MS = 2000;

interface SocketUser {
  userId: string;
  name: string;
  avatar?: string;
}
interface JoinResult {
  room: PublicRoom;
  snapshot: PoolSnapshot | null;
  chat: RoomChatMessage[];
  spectator: boolean;
}
interface QueueEntry {
  user: SocketUser;
  socketId: string;
  elo: number;
  since: number;
}

const roomKey = (code: string) => `pool:${code}`;
const fail = <T = undefined>(code: PoolErrorCode): AckResponse<T> => ({
  ok: false,
  code,
  error: ERROR_MESSAGES[code],
});

/**
 * BIDA LỖ ONLINE — server có thẩm quyền: vật lý, luật, vị trí bi, đồng hồ đều tính ở đây.
 * Client chỉ gửi input (ngắm, đặt bi, chọn, đánh) và phát lại kết quả.
 */
@WebSocketGateway({
  cors: { origin: [process.env.WEB_URL ?? ''], credentials: true },
})
export class PoolGateway implements OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger('Pool');
  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  private clockTimers = new Map<string, NodeJS.Timeout>();
  private lastAction = new Map<string, number>();
  private lastAim = new Map<string, number>();
  private chatTimes = new Map<string, number[]>();
  private queue: Record<GameType, QueueEntry[]> = { eight: [], nine: [] };
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly rooms: PoolRoomService,
    private readonly stats: PoolStatsService,
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {
    this.sweeper = setInterval(() => this.sweepQueue(), QUICK_SWEEP_MS);
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
    for (const t of [
      ...this.clockTimers.values(),
      ...this.disconnectTimers.values(),
    ])
      clearTimeout(t);
  }

  // ===================================================== AUTH & TIỆN ÍCH
  private async getUser(client: Socket): Promise<SocketUser | null> {
    const cached = (client.data as { monoUser?: SocketUser }).monoUser;
    if (cached) return cached;
    const auth = client.handshake.auth as { token?: unknown };
    if (typeof auth.token !== 'string' || !auth.token) return null;
    try {
      const decoded = await this.jwtService.verifyAsync<{
        sub?: string;
        _id?: string;
        userId?: string;
      }>(auth.token.replace(/^Bearer\s+/i, ''));
      const userId = decoded.sub ?? decoded._id ?? decoded.userId;
      if (!userId) return null;
      const user = await this.userModel
        .findById(userId)
        .select('_id name avatar')
        .lean();
      if (!user) return null;
      const u: SocketUser = {
        userId: String(user._id),
        name: user.name,
        avatar: user.avatar,
      };
      (client.data as { monoUser?: SocketUser }).monoUser = u;
      return u;
    } catch {
      return null;
    }
  }

  private throttle(map: Map<string, number>, key: string, ms: number) {
    const now = Date.now();
    if (now - (map.get(key) ?? 0) < ms) return false;
    map.set(key, now);
    return true;
  }

  private broadcastRoom(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('pool:room', this.rooms.toPublic(room));
  }
  private broadcastState(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('pool:state', this.rooms.snapshot(room));
  }
  private notice(room: Room, text: string) {
    this.server.to(roomKey(room.code)).emit('pool:notice', { text });
  }
  private joinResult(room: Room, spectator: boolean): JoinResult {
    return {
      room: this.rooms.toPublic(room),
      snapshot: this.rooms.snapshot(room),
      chat: room.chat,
      spectator,
    };
  }

  // ===================================================== ĐỒNG HỒ
  private clearClock(code: string) {
    const t = this.clockTimers.get(code);
    if (t) clearTimeout(t);
    this.clockTimers.delete(code);
  }

  private scheduleClock(room: Room) {
    this.clearClock(room.code);
    const g = room.game;
    if (
      room.status !== 'playing' ||
      !g ||
      !g.clock.deadline ||
      g.clock.pausedAt !== null
    )
      return;
    const wait = Math.max(0, g.clock.deadline - Date.now()) + 50;
    this.clockTimers.set(
      room.code,
      setTimeout(() => {
        this.clockTimers.delete(room.code);
        const cur = this.rooms.get(room.code);
        if (!cur) return;
        if (this.rooms.timeout(cur)) {
          for (const m of cur.game?.timeoutMessages ?? [])
            this.notice(cur, m.text);
          void this.afterChange(cur);
        } else this.scheduleClock(cur);
      }, wait),
    );
  }

  /** Sau mọi thay đổi trạng thái: gửi state, hẹn đồng hồ, lưu trận nếu đã xong */
  private async afterChange(room: Room) {
    const g = room.game;
    if (
      g &&
      g.match.matchWinner !== null &&
      room.status === 'finished' &&
      !g.eloChange &&
      g.endedAt
    ) {
      this.clearClock(room.code);
      g.eloChange = (await this.stats.recordMatch(room)) ?? [0, 0];
      this.notice(room, `🏆 ${g.endReason ?? 'Trận đấu kết thúc'}`);
      this.broadcastRoom(room);
    }
    this.broadcastState(room);
    this.scheduleClock(room);
  }

  // ===================================================== KẾT NỐI
  handleDisconnect(client: Socket) {
    const user = (client.data as { monoUser?: SocketUser }).monoUser;
    if (!user) return;
    this.leaveQueue(user.userId);
    const room = this.rooms.getRoomOfUser(user.userId);
    if (!room) return;
    const spec = this.rooms.findSpectator(room, user.userId);
    if (spec && spec.socketId === client.id) {
      this.rooms.removeUser(room, user.userId);
      this.broadcastRoom(room);
      return;
    }
    const player = this.rooms.findPlayer(room, user.userId);
    if (!player || player.socketId !== client.id) return;
    player.connected = false;
    player.socketId = null;
    this.leaveVoice(room, user.userId);

    const g = room.game;
    if (room.status === 'playing' && g) {
      // Người đang phải thao tác mất kết nối -> tạm dừng đồng hồ (tối đa 60 s)
      if (g.players[this.rooms.actor(g)] === user.userId) {
        this.rooms.pauseClock(room);
        this.clearClock(room.code);
      }
      if (room.hostId === user.userId) this.rooms.transferHost(room);
      this.notice(
        room,
        `📴 ${user.name} mất kết nối — đang chờ kết nối lại (60 giây)`,
      );
      this.broadcastState(room);
    } else this.notice(room, `📴 ${user.name} mất kết nối`);
    this.broadcastRoom(room);

    const grace =
      room.status === 'playing' ? RECONNECT_GRACE_MS : LOBBY_GRACE_MS;
    this.clearDisconnectTimer(user.userId);
    this.disconnectTimers.set(
      user.userId,
      setTimeout(() => {
        this.disconnectTimers.delete(user.userId);
        const cur = this.rooms.get(room.code);
        const p = cur && this.rooms.findPlayer(cur, user.userId);
        if (cur && p && !p.connected)
          this.removeFromRoom(cur, user.userId, 'mất kết nối quá 60 giây');
      }, grace),
    );
  }

  private clearDisconnectTimer(userId: string) {
    const t = this.disconnectTimers.get(userId);
    if (t) clearTimeout(t);
    this.disconnectTimers.delete(userId);
  }

  private removeFromRoom(room: Room, userId: string, reason: string) {
    const player = this.rooms.findPlayer(room, userId);
    const spec = this.rooms.findSpectator(room, userId);
    if (!player && !spec) return;
    const name = player?.name ?? spec?.name ?? 'Người chơi';
    const socketId = player?.socketId ?? spec?.socketId;
    this.leaveVoice(room, userId);
    if (
      player &&
      this.rooms.forfeit(room, userId, `${name} ${reason} — xử thua`)
    )
      void this.afterChange(room);
    if (socketId) this.server.in(socketId).socketsLeave(roomKey(room.code));
    this.clearDisconnectTimer(userId);
    const deleted = this.rooms.removeUser(room, userId);
    if (deleted) {
      this.clearClock(room.code);
      return;
    }
    if (player) this.notice(room, `${name} ${reason}`);
    this.broadcastRoom(room);
  }

  // ===================================================== SẢNH & PHÒNG
  @SubscribeMessage('pool:list')
  async handleList(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom[]>> {
    if (!(await this.getUser(client))) return fail('NOT_IN_ROOM');
    return { ok: true, data: this.rooms.listPublic() };
  }

  @SubscribeMessage('pool:myRoom')
  async handleMyRoom(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom | null>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const room = this.rooms.getRoomOfUser(user.userId);
    return {
      ok: true,
      data:
        room && this.rooms.findPlayer(room, user.userId)
          ? this.rooms.toPublic(room)
          : null,
    };
  }

  @SubscribeMessage('pool:create')
  async handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: Partial<PoolRoomSettings>,
  ): Promise<AckResponse<JoinResult>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    this.leaveQueue(user.userId);
    const current = this.rooms.getRoomOfUser(user.userId);
    if (current) this.removeFromRoom(current, user.userId, 'đã rời phòng');
    // Phòng tự tạo không phải xếp hạng (xếp hạng chỉ qua ghép trận nhanh)
    const room = this.rooms.create(
      { ...user, socketId: client.id },
      { ...(body ?? {}), ranked: false },
    );
    await client.join(roomKey(room.code));
    return { ok: true, data: this.joinResult(room, false) };
  }

  /** Vào phòng bằng mã: ghế trống -> người chơi; phòng đầy / đang đấu -> khán giả */
  @SubscribeMessage('pool:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { code?: string },
  ): Promise<AckResponse<JoinResult>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const room = this.rooms.get(this.rooms.normalizeCode(body?.code));
    if (!room) return { ok: false, error: 'Không tìm thấy phòng với mã này' };

    const existing = this.rooms.findPlayer(room, user.userId);
    if (existing) {
      // Kết nối lại: nhận ROOM_STATE đầy đủ, đồng hồ chạy tiếp
      this.clearDisconnectTimer(user.userId);
      const was = !existing.connected;
      existing.connected = true;
      existing.socketId = client.id;
      existing.name = user.name;
      existing.avatar = user.avatar;
      await client.join(roomKey(room.code));
      if (was) {
        this.rooms.resumeClock(room);
        this.notice(room, `🔌 ${user.name} đã kết nối lại`);
        this.broadcastState(room);
        this.scheduleClock(room);
      }
      this.broadcastRoom(room);
      return { ok: true, data: this.joinResult(room, false) };
    }

    const other = this.rooms.getRoomOfUser(user.userId);
    if (other && other !== room)
      this.removeFromRoom(other, user.userId, 'đã rời phòng');

    if (
      room.status === 'lobby' &&
      room.players.length < POOL_MAX_PLAYERS &&
      !room.settings.ranked
    ) {
      this.rooms.addPlayer(room, { ...user, socketId: client.id });
      await client.join(roomKey(room.code));
      this.notice(room, `👋 ${user.name} đã vào phòng`);
      this.broadcastRoom(room);
      return { ok: true, data: this.joinResult(room, false) };
    }
    if (!room.settings.spectators)
      return { ok: false, error: 'Phòng đã đủ người và không cho khán giả' };
    this.rooms.addSpectator(room, {
      userId: user.userId,
      name: user.name,
      socketId: client.id,
    });
    await client.join(roomKey(room.code));
    this.broadcastRoom(room);
    return { ok: true, data: this.joinResult(room, true) };
  }

  @SubscribeMessage('pool:leave')
  async handleLeave(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (!user) return { ok: false };
    const room = this.rooms.getRoomOfUser(user.userId);
    if (room) this.removeFromRoom(room, user.userId, 'đã rời phòng');
    return { ok: true };
  }

  @SubscribeMessage('pool:kick')
  async handleKick(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { userId?: string },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (
      !user ||
      !room ||
      room.hostId !== user.userId ||
      room.status !== 'lobby'
    )
      return {
        ok: false,
        error: 'Chỉ chủ phòng mới được mời ra (khi chưa bắt đầu)',
      };
    const target =
      body?.userId && body.userId !== user.userId
        ? this.rooms.findPlayer(room, body.userId)
        : null;
    if (!target) return { ok: false, error: 'Người chơi không hợp lệ' };
    if (target.socketId)
      this.server.to(target.socketId).emit('pool:kicked', { code: room.code });
    this.removeFromRoom(room, target.userId, 'đã bị chủ phòng mời ra');
    return { ok: true };
  }

  @SubscribeMessage('pool:ready')
  async handleReady(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { ready?: boolean },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    const p = room && user && this.rooms.findPlayer(room, user.userId);
    if (!room || !p || room.status !== 'lobby') return { ok: false };
    p.ready = !!body?.ready;
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('pool:seat')
  async handleSeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { seat?: number },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.status !== 'lobby') return { ok: false };
    if (!this.rooms.changeSeat(room, user.userId, Number(body?.seat)))
      return { ok: false, error: 'Ghế này đã có người' };
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('pool:settings')
  async handleSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: Partial<PoolRoomSettings>,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (
      !user ||
      !room ||
      room.hostId !== user.userId ||
      room.status !== 'lobby' ||
      room.settings.ranked
    )
      return { ok: false, error: 'Chỉ chủ phòng mới được đổi cài đặt' };
    this.rooms.updateSettings(room, { ...(body ?? {}), ranked: false });
    this.broadcastRoom(room);
    return { ok: true };
  }

  private beginMatch(room: Room) {
    const g = this.rooms.startGame(room);
    const breaker = g.names[g.match.rack.breaker];
    this.logger.log(
      `[${room.code}] Bắt đầu ${room.settings.type === 'eight' ? '8' : '9'} bi, chạm ${room.settings.raceTo}`,
    );
    this.notice(room, `🪙 Tung đồng xu: ${breaker} phá bi trước`);
    this.broadcastRoom(room);
    this.broadcastState(room);
    this.scheduleClock(room);
  }

  @SubscribeMessage('pool:start')
  async handleStart(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được bắt đầu' };
    if (room.status !== 'lobby')
      return { ok: false, error: 'Trận đấu đã bắt đầu' };
    if (room.players.length < 2)
      return { ok: false, error: 'Cần đủ 2 người chơi' };
    if (
      room.players.some(
        (p) => p.userId !== room.hostId && (!p.ready || !p.connected),
      )
    )
      return { ok: false, error: 'Còn người chơi chưa sẵn sàng' };
    this.beginMatch(room);
    return { ok: true };
  }

  /** Đấu lại / về phòng chờ (REMATCH) */
  @SubscribeMessage('pool:reset')
  async handleReset(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được tạo ván mới' };
    if (room.status === 'playing')
      return { ok: false, error: 'Trận đang diễn ra' };
    this.clearClock(room.code);
    this.rooms.resetToLobby(room);
    this.notice(room, '🔄 Về phòng chờ — sẵn sàng để đấu lại');
    this.broadcastRoom(room);
    return { ok: true };
  }

  // ===================================================== CHAT
  @SubscribeMessage('pool:chat')
  async handleChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { text?: string },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    const player = this.rooms.findPlayer(room, user.userId);
    if (!player) return { ok: false, error: 'Khán giả không thể chat' };
    const text =
      typeof body?.text === 'string'
        ? body.text.trim().slice(0, MAX_CHAT_LENGTH)
        : '';
    if (!text) return { ok: false };
    const now = Date.now();
    const recent = (this.chatTimes.get(user.userId) ?? []).filter(
      (t) => now - t < CHAT_WINDOW_MS,
    );
    if (recent.length >= CHAT_MAX_IN_WINDOW)
      return { ok: false, error: 'Bạn gửi tin nhắn quá nhanh' };
    this.chatTimes.set(user.userId, [...recent, now]);
    const m = this.rooms.addChat(room, {
      userId: user.userId,
      name: user.name,
      avatar: user.avatar,
      seat: player.seat,
      text,
      messageType: 'player',
    });
    this.server.to(roomKey(room.code)).emit('pool:chat', m);
    return { ok: true };
  }

  // ===================================================== TRẬN ĐẤU
  @SubscribeMessage('pool:sync')
  async handleSync(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PoolSnapshot | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!room) return fail('NOT_IN_ROOM');
    return { ok: true, data: this.rooms.snapshot(room) };
  }

  @SubscribeMessage('pool:ping')
  handlePing(@MessageBody() body: { t?: number }) {
    return { ok: true, data: { t: body?.t ?? 0, serverNow: Date.now() } };
  }

  /** AIM_UPDATE (10–15 Hz): chuyển tiếp cho đối thủ & khán giả để thấy cơ di chuyển */
  @SubscribeMessage('pool:aim')
  async handleAim(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    const g = room?.game;
    if (!user || !room || !g) return fail('NOT_IN_ROOM');
    if (!this.throttle(this.lastAim, user.userId, AIM_MIN_INTERVAL_MS))
      return fail('RATE_LIMIT');
    if (g.players[g.match.rack.turn] !== user.userId)
      return fail('NOT_YOUR_TURN');
    const v = validateAim(body);
    if (!v.ok) return fail(v.code);
    client
      .to(roomKey(room.code))
      .emit('pool:aim', { seq: g.seq, aim: v.value });
    return { ok: true };
  }

  private async act(
    client: Socket,
    run: (
      room: Room,
      userId: string,
    ) => {
      ok: boolean;
      code?: PoolErrorCode;
      game?: unknown;
      duplicate?: true;
    },
  ): Promise<AckResponse<PoolSnapshot | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return fail('NOT_IN_ROOM');
    if (!this.throttle(this.lastAction, client.id, ACTION_MIN_INTERVAL_MS))
      return fail('RATE_LIMIT');
    const r = run(room, user.userId);
    if (!r.ok)
      return {
        ...fail(r.code ?? 'BAD_INPUT'),
        data:
          r.code === 'STALE_SEQ' || r.code === 'STATE_MISMATCH'
            ? this.rooms.snapshot(room)
            : undefined,
      };
    if (!r.duplicate) await this.afterChange(room);
    return { ok: true };
  }

  @SubscribeMessage('pool:place')
  handlePlace(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    return this.act(client, (room, uid) =>
      this.rooms.placeCue(room, uid, body),
    );
  }

  @SubscribeMessage('pool:option')
  handleOption(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.act(client, (room, uid) => {
      const r = this.rooms.option(room, uid, body);
      if (r.ok && 'game' in r)
        for (const m of r.game.timeoutMessages ?? []) this.notice(room, m.text);
      return r;
    });
  }

  @SubscribeMessage('pool:extend')
  handleExtend(@ConnectedSocket() client: Socket) {
    return this.act(client, (room, uid) => {
      const r = this.rooms.extend(room, uid);
      if (r.ok) this.notice(room, '⏱️ Gia hạn +30 giây');
      return r;
    });
  }

  @SubscribeMessage('pool:resign')
  async handleResign(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return fail('NOT_IN_ROOM');
    if (!this.rooms.forfeit(room, user.userId, `${user.name} xin thua`))
      return fail('WRONG_PHASE');
    await this.afterChange(room);
    return { ok: true };
  }

  /** SHOT -> server mô phỏng & phán quyết -> SHOT_RESULT cho mọi người trong phòng */
  @SubscribeMessage('pool:shoot')
  async handleShoot(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<AckResponse<PoolSnapshot | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return fail('NOT_IN_ROOM');
    if (!this.throttle(this.lastAction, client.id, ACTION_MIN_INTERVAL_MS))
      return fail('RATE_LIMIT');
    const t0 = performance.now();
    const r = this.rooms.shoot(room, user.userId, body);
    if (!r.ok) {
      const resync = r.code === 'STALE_SEQ' || r.code === 'STATE_MISMATCH';
      return {
        ...fail(r.code),
        data: resync ? this.rooms.snapshot(room) : undefined,
      };
    }
    if ('duplicate' in r) return { ok: true };
    const ms = performance.now() - t0;
    this.logger.log(
      `[${room.code}] ${user.name} đánh #${r.shot.seq} (${ms.toFixed(1)} ms): ${r.shot.messages.map((m) => m.text).join(' | ')}`,
    );
    this.server
      .to(roomKey(room.code))
      .emit('pool:shot', { shot: r.shot, state: this.rooms.snapshot(room) });
    await this.afterChange(room);
    return { ok: true };
  }

  // ===================================================== GHÉP TRẬN NHANH (ELO)
  private leaveQueue(userId: string) {
    for (const t of ['eight', 'nine'] as GameType[])
      this.queue[t] = this.queue[t].filter((e) => e.user.userId !== userId);
  }

  @SubscribeMessage('pool:quick')
  async handleQuick(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { type?: GameType },
  ): Promise<AckResponse<{ elo: number; waiting: number }>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const type: GameType = body?.type === 'nine' ? 'nine' : 'eight';
    const current = this.rooms.getRoomOfUser(user.userId);
    if (current) this.removeFromRoom(current, user.userId, 'đã rời phòng');
    this.leaveQueue(user.userId);
    const elo = await this.stats.getElo(user.userId, type);
    this.queue[type].push({
      user,
      socketId: client.id,
      elo,
      since: Date.now(),
    });
    this.sweepQueue();
    return { ok: true, data: { elo, waiting: this.queue[type].length } };
  }

  @SubscribeMessage('pool:quick:cancel')
  async handleQuickCancel(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (user) this.leaveQueue(user.userId);
    return { ok: true };
  }

  /** Ghép cặp: chênh ELO cho phép mở rộng dần theo thời gian chờ (100 + 25/giây) */
  private sweepQueue() {
    const now = Date.now();
    for (const type of ['eight', 'nine'] as GameType[]) {
      const q = this.queue[type].filter(
        (e) => this.server?.sockets.sockets.get(e.socketId)?.connected,
      );
      q.sort((a, b) => a.since - b.since);
      const used = new Set<string>();
      for (const a of q) {
        if (used.has(a.user.userId)) continue;
        const win = (e: QueueEntry) => 100 + 25 * ((now - e.since) / 1000);
        const b = q.find(
          (e) =>
            e !== a &&
            !used.has(e.user.userId) &&
            Math.abs(e.elo - a.elo) <= Math.min(win(a), win(e)),
        );
        if (!b) continue;
        used.add(a.user.userId);
        used.add(b.user.userId);
        void this.createRanked(type, a, b);
      }
      this.queue[type] = q.filter((e) => !used.has(e.user.userId));
    }
  }

  private async createRanked(type: GameType, a: QueueEntry, b: QueueEntry) {
    const room = this.rooms.create(
      { ...a.user, socketId: a.socketId },
      { type, raceTo: 3, isPrivate: true, ranked: true, spectators: true },
    );
    this.rooms.addPlayer(room, { ...b.user, socketId: b.socketId });
    room.players.forEach((p, i) => (p.elo = [a.elo, b.elo][i]));
    for (const e of [a, b]) {
      const s = this.server.sockets.sockets.get(e.socketId);
      if (s) await s.join(roomKey(room.code));
    }
    this.beginMatch(room);
    for (const e of [a, b])
      this.server.to(e.socketId).emit('pool:matched', { code: room.code });
  }

  // ===================================================== VOICE (giống Bida Carom)
  private voiceUsers(room: Room) {
    return Object.entries(room.voice).map(([userId, v]) => ({
      userId,
      muted: v.muted,
    }));
  }
  private broadcastVoice(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('pool:voice:users', { users: this.voiceUsers(room) });
  }
  private leaveVoice(room: Room, userId: string) {
    if (!room.voice[userId]) return;
    delete room.voice[userId];
    this.server.to(roomKey(room.code)).emit('pool:voice:left', { userId });
    this.broadcastVoice(room);
  }

  @SubscribeMessage('pool:voice:config')
  async handleVoiceConfig(@ConnectedSocket() client: Socket) {
    if (!(await this.getUser(client)))
      return { ok: false, error: 'Bạn cần đăng nhập' };
    return { ok: true, data: { iceServers: getIceServers() } };
  }

  @SubscribeMessage('pool:voice:join')
  async handleVoiceJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { muted?: boolean },
  ) {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || !this.rooms.findPlayer(room, user.userId))
      return { ok: false };
    const peers = Object.keys(room.voice).filter((id) => id !== user.userId);
    room.voice[user.userId] = { muted: !!body?.muted };
    this.broadcastVoice(room);
    return { ok: true, data: { peers } };
  }

  @SubscribeMessage('pool:voice:leave')
  async handleVoiceLeave(@ConnectedSocket() client: Socket) {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    this.leaveVoice(room, user.userId);
    return { ok: true };
  }

  @SubscribeMessage('pool:voice:mute')
  async handleVoiceMute(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { muted?: boolean },
  ) {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || !room.voice[user.userId]) return { ok: false };
    room.voice[user.userId].muted = !!body?.muted;
    this.broadcastVoice(room);
    return { ok: true };
  }

  @SubscribeMessage('pool:voice:list')
  async handleVoiceList(@ConnectedSocket() client: Socket) {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    return { ok: true, data: { users: this.voiceUsers(room) } };
  }

  @SubscribeMessage('pool:voice:signal')
  async handleVoiceSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { to?: string; data?: unknown },
  ) {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || typeof body?.to !== 'string') return { ok: false };
    if (!room.voice[user.userId] || !room.voice[body.to]) return { ok: false };
    const target = this.rooms.findPlayer(room, body.to);
    if (!target?.socketId) return { ok: false };
    this.server
      .to(target.socketId)
      .emit('pool:voice:signal', { from: user.userId, data: body.data });
    return { ok: true };
  }
}
