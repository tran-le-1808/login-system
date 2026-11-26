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
import { ChessRoomService } from './chess-room.service';
import { CHESS_MAX_PLAYERS } from './chess.types';
import type {
  AckResponse,
  PublicRoom,
  Room,
  RoomChatMessage,
  ChessRoomSettings,
  ChessSnapshot,
} from './chess.types';

const LOBBY_GRACE_MS = 15_000;
const GAME_GRACE_MS = 60_000;
const MAX_CHAT_LENGTH = 300;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX_IN_WINDOW = 6;
const MOVE_MIN_INTERVAL_MS = 120;
const QUICK_MINUTES = 10;
const QUICK_SWEEP_MS = 1500;

interface SocketUser {
  userId: string;
  name: string;
  avatar?: string;
}
interface JoinResult {
  room: PublicRoom;
  snapshot: ChessSnapshot | null;
  chat: RoomChatMessage[];
}
interface QueueEntry {
  user: SocketUser;
  socketId: string;
  since: number;
}

const roomKey = (code: string) => `chess:${code}`;
const AUTH = { ok: false, error: 'Bạn cần đăng nhập' } as const;

/**
 * CỜ VUA ONLINE — server có thẩm quyền: nước đi, lượt, đồng hồ mỗi bên, chiếu hết / hoà, xin hoà.
 * Giao thức phòng (chess:join / room / chat / ready / seat / settings / start / reset…) giống Caro
 * để dùng chung RoomContext phía client.
 */
@WebSocketGateway({
  cors: { origin: [process.env.WEB_URL ?? ''], credentials: true },
})
export class ChessGateway implements OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger('Chess');
  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  private clockTimers = new Map<string, NodeJS.Timeout>();
  private lastMove = new Map<string, number>();
  private chatTimes = new Map<string, number[]>();
  private queue: QueueEntry[] = [];
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly rooms: ChessRoomService,
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

  private broadcastRoom(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('chess:room', this.rooms.toPublic(room));
  }
  private broadcastState(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('chess:state', this.rooms.snapshot(room));
  }
  private notice(room: Room, text: string) {
    this.server.to(roomKey(room.code)).emit('chess:notice', { text });
  }
  private joinResult(room: Room): JoinResult {
    return {
      room: this.rooms.toPublic(room),
      snapshot: this.rooms.snapshot(room),
      chat: room.chat,
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
    const m = room.match;
    if (room.status !== 'playing' || !m || m.pausedAt !== null) return;
    const wait = Math.max(0, this.rooms.deadline(room) - Date.now()) + 50;
    this.clockTimers.set(
      room.code,
      setTimeout(() => {
        this.clockTimers.delete(room.code);
        const cur = this.rooms.get(room.code);
        if (!cur) return;
        if (this.rooms.timeout(cur)) this.afterChange(cur);
        else this.scheduleClock(cur);
      }, wait),
    );
  }

  /** Sau mọi thay đổi ván: gửi trạng thái, hẹn đồng hồ, báo kết quả */
  private afterChange(room: Room) {
    if (room.status === 'finished' && room.match?.endReason) {
      this.clearClock(room.code);
      this.notice(room, `🏆 ${room.match.endReason}`);
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
    const player = this.rooms.findPlayer(room, user.userId);
    if (!player || player.socketId !== client.id) return;
    player.connected = false;
    player.socketId = null;
    const m = room.match;
    if (room.status === 'playing' && m) {
      // người đang đến lượt mất kết nối -> dừng đồng hồ trong thời gian chờ
      if (this.rooms.turnSeat(room) === this.rooms.seatOf(room, user.userId)) {
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
    if (this.rooms.forfeit(room, userId, `${player.name} ${reason} — xử thua`))
      this.afterChange(room);
    if (player.socketId)
      this.server.in(player.socketId).socketsLeave(roomKey(room.code));
    this.clearDisconnectTimer(userId);
    if (this.rooms.removeUser(room, userId)) {
      this.clearClock(room.code);
      return;
    }
    // trận ghép nhanh: người còn lại về phòng chờ
    if (room.status === 'finished') this.rooms.resetToLobby(room);
    this.notice(room, `${player.name} ${reason}`);
    this.broadcastRoom(room);
  }

  // ===================================================== SẢNH & PHÒNG
  @SubscribeMessage('chess:list')
  async handleList(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom[]>> {
    if (!(await this.getUser(client))) return AUTH;
    return { ok: true, data: this.rooms.listPublic() };
  }

  @SubscribeMessage('chess:myRoom')
  async handleMyRoom(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom | null>> {
    const user = await this.getUser(client);
    if (!user) return AUTH;
    const room = this.rooms.getRoomOfUser(user.userId);
    return { ok: true, data: room ? this.rooms.toPublic(room) : null };
  }

  @SubscribeMessage('chess:create')
  async handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: Partial<ChessRoomSettings>,
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
    await client.join(roomKey(room.code));
    return { ok: true, data: this.joinResult(room) };
  }

  @SubscribeMessage('chess:join')
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
      // vào lại (tải lại trang / mạng chập chờn)
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
      return { ok: true, data: this.joinResult(room) };
    }
    if (room.status !== 'lobby')
      return { ok: false, error: 'Phòng đang trong ván đấu' };
    if (room.players.length >= CHESS_MAX_PLAYERS)
      return { ok: false, error: 'Phòng đã đủ 2 người' };
    const other = this.rooms.getRoomOfUser(user.userId);
    if (other) this.removeFromRoom(other, user.userId, 'đã rời phòng');
    this.leaveQueue(user.userId);
    this.rooms.addPlayer(room, { ...user, socketId: client.id });
    await client.join(roomKey(room.code));
    this.notice(room, `👋 ${user.name} đã vào phòng`);
    this.broadcastRoom(room);
    return { ok: true, data: this.joinResult(room) };
  }

  @SubscribeMessage('chess:leave')
  async handleLeave(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (!user) return { ok: false };
    const room = this.rooms.getRoomOfUser(user.userId);
    if (room) this.removeFromRoom(room, user.userId, 'đã rời phòng');
    return { ok: true };
  }

  @SubscribeMessage('chess:kick')
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
      room.status === 'playing'
    )
      return {
        ok: false,
        error: 'Chỉ chủ phòng mới được mời ra (khi chưa đấu)',
      };
    const target =
      body?.userId && body.userId !== user.userId
        ? this.rooms.findPlayer(room, body.userId)
        : null;
    if (!target) return { ok: false, error: 'Người chơi không hợp lệ' };
    if (target.socketId)
      this.server.to(target.socketId).emit('chess:kicked', { code: room.code });
    this.removeFromRoom(room, target.userId, 'đã bị chủ phòng mời ra');
    return { ok: true };
  }

  @SubscribeMessage('chess:ready')
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

  @SubscribeMessage('chess:seat')
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

  @SubscribeMessage('chess:settings')
  async handleSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: Partial<ChessRoomSettings>,
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
    const m = room.match!;
    this.logger.log(
      `[${room.code}] Bắt đầu ván ${room.games} (${room.settings.timeMinutes} phút)`,
    );
    this.notice(room, `⚪ ${m.names[m.whiteSeat]} cầm quân Trắng, đi trước`);
    this.broadcastRoom(room);
    this.broadcastState(room);
    this.scheduleClock(room);
  }

  @SubscribeMessage('chess:start')
  async handleStart(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được bắt đầu' };
    if (room.status === 'playing')
      return { ok: false, error: 'Ván đấu đã bắt đầu' };
    if (room.players.length < 2)
      return { ok: false, error: 'Cần đủ 2 người chơi' };
    if (
      room.players.some(
        (p) => p.userId !== room.hostId && (!p.ready || !p.connected),
      )
    )
      return { ok: false, error: 'Đối thủ chưa sẵn sàng' };
    this.beginMatch(room);
    return { ok: true };
  }

  /** Ván mới ngay (đổi người đi trước) — cả hai đều đang trong phòng */
  @SubscribeMessage('chess:rematch')
  async handleRematch(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || !this.rooms.findPlayer(room, user.userId))
      return { ok: false, error: 'Bạn không ở trong phòng' };
    if (room.status !== 'finished')
      return { ok: false, error: 'Ván đấu chưa kết thúc' };
    if (room.players.length < 2 || room.players.some((p) => !p.connected))
      return { ok: false, error: 'Đối thủ đã rời phòng' };
    this.notice(room, `🔁 ${user.name} bắt đầu ván mới`);
    this.beginMatch(room);
    return { ok: true };
  }

  @SubscribeMessage('chess:reset')
  async handleReset(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được về phòng chờ' };
    if (room.status === 'playing')
      return { ok: false, error: 'Ván đang diễn ra' };
    this.clearClock(room.code);
    this.rooms.resetToLobby(room);
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('chess:finish')
  handleFinish(): AckResponse {
    return { ok: true };
  }

  // ===================================================== CHAT
  @SubscribeMessage('chess:chat')
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
    this.server.to(roomKey(room.code)).emit('chess:chat', m);
    return { ok: true };
  }

  // ===================================================== VÁN ĐẤU
  @SubscribeMessage('chess:sync')
  async handleSync(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<ChessSnapshot | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!room) return { ok: false, error: 'Bạn không ở trong phòng' };
    return { ok: true, data: this.rooms.snapshot(room) };
  }

  @SubscribeMessage('chess:move')
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<AckResponse<ChessSnapshot | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    const now = Date.now();
    if (now - (this.lastMove.get(client.id) ?? 0) < MOVE_MIN_INTERVAL_MS)
      return { ok: false, error: 'Thao tác quá nhanh' };
    this.lastMove.set(client.id, now);
    const r = this.rooms.move(room, user.userId, body);
    // lỗi: gửi kèm trạng thái mới nhất để client đồng bộ lại
    if (!r.ok)
      return { ok: false, error: r.error, data: this.rooms.snapshot(room) };
    this.afterChange(room);
    return { ok: true };
  }

  @SubscribeMessage('chess:resign')
  async handleResign(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    if (!this.rooms.forfeit(room, user.userId, `${user.name} xin thua`))
      return { ok: false, error: 'Không có ván nào đang diễn ra' };
    this.afterChange(room);
    return { ok: true };
  }

  @SubscribeMessage('chess:draw:offer')
  async handleDrawOffer(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    const r = this.rooms.offerDraw(room, user.userId);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.agreed) this.afterChange(room);
    else {
      this.notice(room, `🤝 ${user.name} xin hoà`);
      this.broadcastState(room);
    }
    return { ok: true };
  }

  @SubscribeMessage('chess:draw:answer')
  async handleDrawAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { accept?: boolean },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    const accept = !!body?.accept;
    if (!this.rooms.answerDraw(room, user.userId, accept))
      return { ok: false, error: 'Không có lời xin hoà nào' };
    if (accept) this.afterChange(room);
    else {
      this.notice(room, `${user.name} từ chối hoà`);
      this.broadcastState(room);
    }
    return { ok: true };
  }

  // ===================================================== GHÉP TRẬN NHANH
  private leaveQueue(userId: string) {
    this.queue = this.queue.filter((e) => e.user.userId !== userId);
  }

  @SubscribeMessage('chess:quick')
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

  @SubscribeMessage('chess:quick:cancel')
  async handleQuickCancel(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (user) this.leaveQueue(user.userId);
    return { ok: true };
  }

  /** Ghép theo thứ tự chờ (không xét trình độ) */
  private sweepQueue() {
    const q = this.queue.filter(
      (e) => this.server?.sockets.sockets.get(e.socketId)?.connected,
    );
    q.sort((a, b) => a.since - b.since);
    while (q.length >= 2) {
      const a = q.shift()!;
      const b = q.shift()!;
      if (a.user.userId === b.user.userId) {
        q.unshift(b);
        continue;
      }
      void this.createQuick(a, b);
    }
    this.queue = q;
  }

  private async createQuick(a: QueueEntry, b: QueueEntry) {
    const room = this.rooms.create(
      { ...a.user, socketId: a.socketId },
      { timeMinutes: QUICK_MINUTES, isPrivate: true, quick: true },
    );
    this.rooms.addPlayer(room, { ...b.user, socketId: b.socketId });
    for (const e of [a, b]) {
      const s = this.server.sockets.sockets.get(e.socketId);
      if (s) await s.join(roomKey(room.code));
    }
    // xếp ngẫu nhiên người cầm Trắng ở ván đầu
    if (Math.random() < 0.5) room.games = 1;
    this.beginMatch(room);
    for (const e of [a, b])
      this.server.to(e.socketId).emit('chess:matched', { code: room.code });
  }
}
