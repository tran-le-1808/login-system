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
import { SacMauRoomService } from './sacmau-room.service';
import { SM_MAX_PLAYERS } from './sacmau.types';
import type { SMBotLevel } from './shared/bot';
import type {
  AckResponse,
  PublicRoom,
  Room,
  RoomChatMessage,
  SMRoomSettings,
  SMSnapshot,
} from './sacmau.types';

const LOBBY_GRACE_MS = 15_000;
const GAME_GRACE_MS = 60_000;
const MAX_CHAT_LENGTH = 300;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX_IN_WINDOW = 6;
const MOVE_MIN_INTERVAL_MS = 150;
const BOT_DELAY_MS = [800, 1500];
/** Ghép nhanh: đủ 4 người thì vào ngay; chờ lâu thì thêm máy cho đủ bàn */
const QUICK_FILL_MS = 8000;
const QUICK_ALONE_MS = 15000;
const QUICK_SWEEP_MS = 1500;

interface SocketUser {
  userId: string;
  name: string;
  avatar?: string;
}
interface JoinResult {
  room: PublicRoom;
  snapshot: SMSnapshot | null;
  chat: RoomChatMessage[];
}
interface QueueEntry {
  user: SocketUser;
  socketId: string;
  since: number;
}

const roomKey = (code: string) => `sm:${code}`;
const AUTH = { ok: false, error: 'Bạn cần đăng nhập' } as const;

/**
 * SẮC MÀU ONLINE — server có thẩm quyền: chia bài, lượt, luật đổi màu / cộng dồn / báo, đồng hồ mỗi lượt, điểm.
 * Mỗi người chỉ nhận bài của mình (sm:state gửi riêng từng socket). Máy do server đánh.
 * Giao thức phòng (sm:join / room / chat / ready / settings / start / reset…) giống Caro để dùng chung RoomContext.
 */
@WebSocketGateway({
  cors: { origin: [process.env.WEB_URL ?? ''], credentials: true },
})
export class SacMauGateway implements OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger('SacMau');
  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  private turnTimers = new Map<string, NodeJS.Timeout>();
  /** Thời gian máy "nghĩ" (ms) — test có thể rút ngắn */
  botDelay: [number, number] = [BOT_DELAY_MS[0], BOT_DELAY_MS[1]];
  private lastMove = new Map<string, number>();
  private chatTimes = new Map<string, number[]>();
  private queue: QueueEntry[] = [];
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly rooms: SacMauRoomService,
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {
    this.sweeper = setInterval(() => this.sweepQueue(), QUICK_SWEEP_MS);
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
    for (const t of [
      ...this.turnTimers.values(),
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

  private broadcastRoom(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('sm:room', this.rooms.toPublic(room));
  }
  /** Gửi trạng thái riêng cho từng người (ẩn bài người khác) */
  private broadcastState(room: Room) {
    for (const p of room.players) {
      if (!p.socketId || p.botLevel) continue;
      this.server
        .to(p.socketId)
        .emit('sm:state', this.rooms.snapshotFor(room, p.userId));
    }
  }
  private notice(room: Room, text: string) {
    this.server.to(roomKey(room.code)).emit('sm:notice', { text });
  }
  private joinResult(room: Room, userId: string): JoinResult {
    return {
      room: this.rooms.toPublic(room),
      snapshot: this.rooms.snapshotFor(room, userId),
      chat: room.chat,
    };
  }

  // ===================================================== LƯỢT & MÁY
  private clearTurn(code: string) {
    const t = this.turnTimers.get(code);
    if (t) clearTimeout(t);
    this.turnTimers.delete(code);
  }

  /** Hẹn lượt kế: máy thì nghĩ một chút rồi đánh; người thì chờ tới hết giờ rồi đi thay */
  private schedule(room: Room) {
    this.clearTurn(room.code);
    const m = room.match;
    if (room.status !== 'playing' || !m) return;
    const bot = this.rooms.turnIsBot(room);
    const wait = bot
      ? this.botDelay[0] + Math.random() * (this.botDelay[1] - this.botDelay[0])
      : Math.max(0, m.deadline - Date.now()) + 50;
    const seq = m.seq;
    this.turnTimers.set(
      room.code,
      setTimeout(() => {
        this.turnTimers.delete(room.code);
        const cur = this.rooms.get(room.code);
        if (!cur?.match || cur.match.seq !== seq) return;
        if (this.rooms.autoAct(cur, bot)) this.afterChange(cur);
        else this.schedule(cur);
      }, wait),
    );
  }

  private afterChange(room: Room) {
    if (room.status === 'finished' && room.match) {
      this.clearTurn(room.code);
      const m = room.match;
      const s = m.state;
      if (s.winner !== null)
        this.notice(
          room,
          `🏆 ${m.names[s.winner]} hết bài trước — ăn ${m.lastScores?.[s.winner] ?? 0} điểm`,
        );
      this.broadcastRoom(room);
    }
    this.broadcastState(room);
    this.schedule(room);
  }

  // ===================================================== KẾT NỐI
  handleDisconnect(client: Socket) {
    const user = (client.data as { monoUser?: SocketUser }).monoUser;
    if (!user) return;
    this.leaveQueue(user.userId);
    const room = this.rooms.getRoomOfUser(user.userId);
    if (!room) return;
    const player = this.rooms.findPlayer(room, user.userId);
    if (!player || player.socketId !== client.id) return;
    player.connected = false;
    player.socketId = null;
    if (room.hostId === user.userId) this.rooms.transferHost(room);
    this.notice(
      room,
      room.status === 'playing'
        ? `📴 ${user.name} mất kết nối — hết giờ sẽ tự bốc bài`
        : `📴 ${user.name} mất kết nối`,
    );
    this.broadcastRoom(room);
    this.broadcastState(room);
    const grace = room.status === 'playing' ? GAME_GRACE_MS : LOBBY_GRACE_MS;
    this.clearDisconnectTimer(user.userId);
    this.disconnectTimers.set(
      user.userId,
      setTimeout(() => {
        this.disconnectTimers.delete(user.userId);
        const cur = this.rooms.get(room.code);
        const p = cur && this.rooms.findPlayer(cur, user.userId);
        if (cur && p && !p.connected)
          this.removeFromRoom(cur, user.userId, 'mất kết nối quá lâu');
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
    if (!player) return;
    // đang đánh: máy đánh thay cho hết ván
    this.rooms.replaceWithBot(room, userId);
    if (player.socketId)
      this.server.in(player.socketId).socketsLeave(roomKey(room.code));
    this.clearDisconnectTimer(userId);
    if (this.rooms.removeUser(room, userId)) {
      this.clearTurn(room.code);
      return;
    }
    this.notice(room, `${player.name} ${reason}`);
    this.broadcastRoom(room);
    this.broadcastState(room);
    this.schedule(room);
  }

  // ===================================================== SẢNH & PHÒNG
  @SubscribeMessage('sm:list')
  async handleList(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom[]>> {
    if (!(await this.getUser(client))) return AUTH;
    return { ok: true, data: this.rooms.listPublic() };
  }

  @SubscribeMessage('sm:myRoom')
  async handleMyRoom(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom | null>> {
    const user = await this.getUser(client);
    if (!user) return AUTH;
    const room = this.rooms.getRoomOfUser(user.userId);
    return { ok: true, data: room ? this.rooms.toPublic(room) : null };
  }

  @SubscribeMessage('sm:create')
  async handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: Partial<SMRoomSettings> & { bots?: number },
  ): Promise<AckResponse<JoinResult>> {
    const user = await this.getUser(client);
    if (!user) return AUTH;
    this.leaveQueue(user.userId);
    const current = this.rooms.getRoomOfUser(user.userId);
    if (current) this.removeFromRoom(current, user.userId, 'đã rời phòng');
    const room = this.rooms.create(
      { ...user, socketId: client.id },
      { ...(body ?? {}), quick: false },
    );
    const bots = Math.min(3, Math.max(0, Number(body?.bots) || 0));
    for (let i = 0; i < bots; i++) this.rooms.addBot(room, 'normal');
    await client.join(roomKey(room.code));
    return { ok: true, data: this.joinResult(room, user.userId) };
  }

  @SubscribeMessage('sm:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { code?: string },
  ): Promise<AckResponse<JoinResult>> {
    const user = await this.getUser(client);
    if (!user) return AUTH;
    const room = this.rooms.get(this.rooms.normalizeCode(body?.code));
    if (!room) return { ok: false, error: 'Không tìm thấy phòng với mã này' };
    const existing = this.rooms.findPlayer(room, user.userId);
    if (existing) {
      this.clearDisconnectTimer(user.userId);
      const was = !existing.connected;
      existing.connected = true;
      existing.socketId = client.id;
      existing.name = user.name;
      existing.avatar = user.avatar;
      await client.join(roomKey(room.code));
      if (was) this.notice(room, `🔌 ${user.name} đã kết nối lại`);
      this.broadcastRoom(room);
      this.broadcastState(room);
      return { ok: true, data: this.joinResult(room, user.userId) };
    }
    if (room.status !== 'lobby')
      return { ok: false, error: 'Phòng đang trong ván' };
    if (room.players.length >= SM_MAX_PLAYERS)
      return { ok: false, error: 'Phòng đã đủ 4 người' };
    const other = this.rooms.getRoomOfUser(user.userId);
    if (other) this.removeFromRoom(other, user.userId, 'đã rời phòng');
    this.leaveQueue(user.userId);
    this.rooms.addPlayer(room, { ...user, socketId: client.id });
    await client.join(roomKey(room.code));
    this.notice(room, `👋 ${user.name} đã vào phòng`);
    this.broadcastRoom(room);
    return { ok: true, data: this.joinResult(room, user.userId) };
  }

  @SubscribeMessage('sm:leave')
  async handleLeave(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (!user) return { ok: false };
    const room = this.rooms.getRoomOfUser(user.userId);
    if (room) this.removeFromRoom(room, user.userId, 'đã rời phòng');
    return { ok: true };
  }

  @SubscribeMessage('sm:kick')
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
        error: 'Chỉ chủ phòng mới được mời ra (khi chưa đánh)',
      };
    const target =
      body?.userId && body.userId !== user.userId
        ? this.rooms.findPlayer(room, body.userId)
        : null;
    if (!target) return { ok: false, error: 'Người chơi không hợp lệ' };
    if (target.botLevel) {
      this.rooms.removeUser(room, target.userId);
      this.broadcastRoom(room);
      return { ok: true };
    }
    if (target.socketId)
      this.server.to(target.socketId).emit('sm:kicked', { code: room.code });
    this.removeFromRoom(room, target.userId, 'đã bị chủ phòng mời ra');
    return { ok: true };
  }

  @SubscribeMessage('sm:bot:add')
  async handleAddBot(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { level?: string },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (
      !user ||
      !room ||
      room.hostId !== user.userId ||
      room.status !== 'lobby'
    )
      return { ok: false, error: 'Chỉ chủ phòng mới được thêm máy' };
    const level: SMBotLevel =
      body?.level === 'easy' || body?.level === 'hard' ? body.level : 'normal';
    if (!this.rooms.addBot(room, level))
      return { ok: false, error: 'Phòng đã đủ 4 người' };
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('sm:ready')
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

  @SubscribeMessage('sm:seat')
  handleSeat(): AckResponse {
    return { ok: false, error: 'Không đổi chỗ được' };
  }

  @SubscribeMessage('sm:settings')
  async handleSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: Partial<SMRoomSettings>,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (
      !user ||
      !room ||
      room.hostId !== user.userId ||
      room.status !== 'lobby'
    )
      return { ok: false, error: 'Chỉ chủ phòng mới được đổi cài đặt' };
    this.rooms.updateSettings(room, body ?? {});
    this.broadcastRoom(room);
    return { ok: true };
  }

  private beginMatch(room: Room) {
    this.rooms.startGame(room);
    this.logger.log(
      `[${room.code}] Ván ${room.games} (${room.players.length} người)`,
    );
    const m = room.match!;
    if (!m.state.over)
      this.notice(room, `🎴 Chia bài! ${m.names[m.state.turn]} đi trước`);
    this.broadcastRoom(room);
    this.afterChange(room);
  }

  @SubscribeMessage('sm:start')
  async handleStart(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được bắt đầu' };
    if (room.status === 'playing')
      return { ok: false, error: 'Ván đã bắt đầu' };
    if (room.players.length < 2)
      return { ok: false, error: 'Cần ít nhất 2 người (có thể thêm máy)' };
    if (
      room.players.some(
        (p) =>
          !p.botLevel && p.userId !== room.hostId && (!p.ready || !p.connected),
      )
    )
      return { ok: false, error: 'Còn người chưa sẵn sàng' };
    this.beginMatch(room);
    return { ok: true };
  }

  /** Chia ván mới (người nhất ván trước đi trước) */
  @SubscribeMessage('sm:next')
  async handleNext(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || !this.rooms.findPlayer(room, user.userId))
      return { ok: false, error: 'Bạn không ở trong phòng' };
    if (room.status !== 'finished')
      return { ok: false, error: 'Ván chưa kết thúc' };
    if (room.players.length < 2)
      return { ok: false, error: 'Cần ít nhất 2 người' };
    this.beginMatch(room);
    return { ok: true };
  }

  @SubscribeMessage('sm:reset')
  async handleReset(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được về phòng chờ' };
    if (room.status === 'playing')
      return { ok: false, error: 'Ván đang diễn ra' };
    this.clearTurn(room.code);
    this.rooms.resetToLobby(room);
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('sm:finish')
  handleFinish(): AckResponse {
    return { ok: true };
  }

  // ===================================================== CHAT
  @SubscribeMessage('sm:chat')
  async handleChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { text?: string },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    const player = room && user && this.rooms.findPlayer(room, user.userId);
    if (!user || !room || !player) return { ok: false };
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
    });
    this.server.to(roomKey(room.code)).emit('sm:chat', m);
    return { ok: true };
  }

  // ===================================================== VÁN BÀI
  @SubscribeMessage('sm:sync')
  async handleSync(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<SMSnapshot | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    return { ok: true, data: this.rooms.snapshotFor(room, user.userId) };
  }

  private async act(
    client: Socket,
    body: {
      kind: 'play' | 'draw' | 'pass';
      card?: unknown;
      color?: unknown;
      call?: unknown;
      seq?: unknown;
    },
  ): Promise<AckResponse<SMSnapshot | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    const now = Date.now();
    if (now - (this.lastMove.get(client.id) ?? 0) < MOVE_MIN_INTERVAL_MS)
      return { ok: false, error: 'Thao tác quá nhanh' };
    this.lastMove.set(client.id, now);
    const r = this.rooms.act(room, user.userId, body);
    if (!r.ok)
      return {
        ok: false,
        error: r.error,
        data: this.rooms.snapshotFor(room, user.userId),
      };
    this.afterChange(room);
    return { ok: true };
  }

  @SubscribeMessage('sm:play')
  handlePlay(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: { card?: unknown; color?: unknown; call?: unknown; seq?: unknown },
  ) {
    return this.act(client, {
      kind: 'play',
      card: body?.card,
      color: body?.color,
      call: body?.call,
      seq: body?.seq,
    });
  }

  @SubscribeMessage('sm:draw')
  handleDraw(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { seq?: unknown },
  ) {
    return this.act(client, { kind: 'draw', seq: body?.seq });
  }

  @SubscribeMessage('sm:pass')
  handlePass(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { seq?: unknown },
  ) {
    return this.act(client, { kind: 'pass', seq: body?.seq });
  }

  // ===================================================== GHÉP NHANH
  private leaveQueue(userId: string) {
    this.queue = this.queue.filter((e) => e.user.userId !== userId);
  }

  @SubscribeMessage('sm:quick')
  async handleQuick(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<{ waiting: number }>> {
    const user = await this.getUser(client);
    if (!user) return AUTH;
    const current = this.rooms.getRoomOfUser(user.userId);
    if (current) this.removeFromRoom(current, user.userId, 'đã rời phòng');
    this.leaveQueue(user.userId);
    this.queue.push({ user, socketId: client.id, since: Date.now() });
    this.sweepQueue();
    return { ok: true, data: { waiting: this.queue.length } };
  }

  @SubscribeMessage('sm:quick:cancel')
  async handleQuickCancel(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (user) this.leaveQueue(user.userId);
    return { ok: true };
  }

  /** Ai chờ trước vào trước (không xét trình độ); đủ 4 vào ngay, chờ lâu thì thêm máy */
  private sweepQueue() {
    const now = Date.now();
    let q = this.queue.filter(
      (e) => this.server?.sockets.sockets.get(e.socketId)?.connected,
    );
    q.sort((a, b) => a.since - b.since);
    while (q.length) {
      const waited = now - q[0].since;
      const take =
        q.length >= 4
          ? 4
          : q.length >= 2 && waited >= QUICK_FILL_MS
            ? q.length
            : waited >= QUICK_ALONE_MS
              ? 1
              : 0;
      if (!take) break;
      const group = q.slice(0, take);
      q = q.slice(take);
      void this.createQuick(group);
    }
    this.queue = q;
  }

  private async createQuick(group: QueueEntry[]) {
    const [a, ...rest] = group;
    const room = this.rooms.create(
      { ...a.user, socketId: a.socketId },
      { turnSeconds: 20, isPrivate: true, quick: true },
    );
    for (const e of rest)
      this.rooms.addPlayer(room, { ...e.user, socketId: e.socketId });
    while (room.players.length < 4) this.rooms.addBot(room, 'normal');
    for (const e of group) {
      const s = this.server.sockets.sockets.get(e.socketId);
      if (s) await s.join(roomKey(room.code));
    }
    this.beginMatch(room);
    for (const e of group)
      this.server.to(e.socketId).emit('sm:matched', { code: room.code });
  }
}
