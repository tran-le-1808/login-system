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
import { MaSoiRoomService } from './masoi-room.service';
import { MS_MAX_PLAYERS } from './masoi.types';
import { MS_MIN } from './shared/game';
import { getIceServers } from '../realtime/ice-servers';
import type { MSBotLevel } from './shared/bot';
import type {
  AckResponse,
  PublicRoom,
  Room,
  RoomChatMessage,
  MSRoomSettings,
  MSSnapshot,
} from './masoi.types';

const LOBBY_GRACE_MS = 15_000;
const GAME_GRACE_MS = 60_000;
const MAX_CHAT_LENGTH = 300;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX_IN_WINDOW = 6;
const MOVE_MIN_INTERVAL_MS = 150;
/** Máy "nghĩ" theo giai đoạn (ms) */
const BOT_DELAY_MS: Record<string, [number, number]> = {
  night: [1500, 4000],
  witch: [1500, 3500],
  day: [3000, 7000],
  vote: [1500, 4000],
  hunter: [2000, 3500],
};
/** Ghép nhanh: đủ 8 người thì vào ngay; chờ lâu thì thêm máy cho đủ làng */
const QUICK_SIZE = 8;
const QUICK_FILL_MS = 10000;
const QUICK_ALONE_MS = 15000;
const QUICK_SWEEP_MS = 1500;

interface SocketUser {
  userId: string;
  name: string;
  avatar?: string;
}
interface JoinResult {
  room: PublicRoom;
  snapshot: MSSnapshot | null;
  chat: RoomChatMessage[];
}
interface QueueEntry {
  user: SocketUser;
  socketId: string;
  since: number;
}

const roomKey = (code: string) => `ms:${code}`;
const AUTH = { ok: false, error: 'Bạn cần đăng nhập' } as const;

/**
 * MA SÓI ONLINE — server có thẩm quyền: chia vai, đêm (Sói / Tiên Tri / Bảo Vệ / Phù Thuỷ), bình minh, thảo luận, bỏ phiếu, Thợ Săn.
 * Mỗi người chỉ nhận góc nhìn của mình (ms:state gửi riêng từng socket). Chat theo kênh: cả làng / bầy Sói (ban đêm) / người chết.
 * Giao thức phòng (ms:join / room / chat / ready / settings / start / reset…) giống Caro để dùng chung RoomContext.
 */
@WebSocketGateway({
  cors: { origin: [process.env.WEB_URL ?? ''], credentials: true },
})
export class MaSoiGateway implements OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger('MaSoi');
  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  private phaseTimers = new Map<string, NodeJS.Timeout>();
  private botTimers = new Map<string, NodeJS.Timeout>();
  /** Hệ số thời gian máy "nghĩ" — test có thể rút ngắn */
  botDelayScale = 1;
  private lastMove = new Map<string, number>();
  private chatTimes = new Map<string, number[]>();
  private queue: QueueEntry[] = [];
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly rooms: MaSoiRoomService,
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {
    this.sweeper = setInterval(() => this.sweepQueue(), QUICK_SWEEP_MS);
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
    for (const t of [
      ...this.phaseTimers.values(),
      ...this.botTimers.values(),
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
      .emit('ms:room', this.rooms.toPublic(room));
  }
  /** Gửi trạng thái riêng cho từng người (ẩn vai người khác) */
  private broadcastState(room: Room) {
    for (const p of room.players) {
      if (!p.socketId || p.botLevel) continue;
      this.server
        .to(p.socketId)
        .emit('ms:state', this.rooms.snapshotFor(room, p.userId));
    }
  }
  private notice(room: Room, text: string) {
    this.server.to(roomKey(room.code)).emit('ms:notice', { text });
  }
  private joinResult(room: Room, userId: string): JoinResult {
    return {
      room: this.rooms.toPublic(room),
      snapshot: this.rooms.snapshotFor(room, userId),
      chat: this.rooms.chatFor(room, userId),
    };
  }

  // ===================================================== GIAI ĐOẠN & MÁY
  private clearTurn(code: string) {
    for (const map of [this.phaseTimers, this.botTimers]) {
      const t = map.get(code);
      if (t) clearTimeout(t);
      map.delete(code);
    }
  }

  /** Hẹn hết giờ giai đoạn + một máy hành động kế tiếp */
  private schedule(room: Room) {
    this.clearTurn(room.code);
    const m = room.match;
    if (room.status !== 'playing' || !m) return;
    const pid = m.state.pid;
    this.phaseTimers.set(
      room.code,
      setTimeout(
        () => {
          this.phaseTimers.delete(room.code);
          const cur = this.rooms.get(room.code);
          if (cur && this.rooms.expire(cur, pid)) this.afterChange(cur);
        },
        Math.max(0, m.deadline - Date.now()) + 50,
      ),
    );
    const bots = this.rooms.pendingBots(room);
    if (!bots.length) return;
    const seat = bots[Math.floor(Math.random() * bots.length)];
    const [a, b] = BOT_DELAY_MS[m.state.phase] ?? [1500, 3000];
    const seq = m.seq;
    this.botTimers.set(
      room.code,
      setTimeout(
        () => {
          this.botTimers.delete(room.code);
          const cur = this.rooms.get(room.code);
          if (!cur?.match || cur.match.seq !== seq) return;
          if (this.rooms.botStep(cur, seat)) this.afterChange(cur);
        },
        (a + Math.random() * (b - a)) * this.botDelayScale,
      ),
    );
  }

  private afterChange(room: Room) {
    if (room.status === 'finished' && room.match) {
      this.clearTurn(room.code);
      const w = room.match.state.winner;
      this.notice(
        room,
        w === 'wolf' ? '🐺 Phe Sói thắng!' : '🏆 Dân Làng thắng!',
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
    // mất kết nối -> rời voice (client tự vào lại khi kết nối lại)
    this.leaveVoice(room, user.userId);
    if (room.hostId === user.userId) this.rooms.transferHost(room);
    this.notice(
      room,
      room.status === 'playing'
        ? `📴 ${user.name} mất kết nối — hết giờ coi như bỏ qua`
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
    this.leaveVoice(room, userId);
    // đang chơi: máy chơi thay cho hết ván
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
  @SubscribeMessage('ms:list')
  async handleList(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom[]>> {
    if (!(await this.getUser(client))) return AUTH;
    return { ok: true, data: this.rooms.listPublic() };
  }

  @SubscribeMessage('ms:myRoom')
  async handleMyRoom(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom | null>> {
    const user = await this.getUser(client);
    if (!user) return AUTH;
    const room = this.rooms.getRoomOfUser(user.userId);
    return { ok: true, data: room ? this.rooms.toPublic(room) : null };
  }

  @SubscribeMessage('ms:create')
  async handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: Partial<MSRoomSettings> & { bots?: number },
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
    const bots = Math.min(
      MS_MAX_PLAYERS - 1,
      Math.max(0, Number(body?.bots) || 0),
    );
    for (let i = 0; i < bots; i++) this.rooms.addBot(room, 'normal');
    await client.join(roomKey(room.code));
    return { ok: true, data: this.joinResult(room, user.userId) };
  }

  @SubscribeMessage('ms:join')
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
    if (room.players.length >= MS_MAX_PLAYERS)
      return { ok: false, error: 'Phòng đã đủ 12 người' };
    const other = this.rooms.getRoomOfUser(user.userId);
    if (other) this.removeFromRoom(other, user.userId, 'đã rời phòng');
    this.leaveQueue(user.userId);
    this.rooms.addPlayer(room, { ...user, socketId: client.id });
    await client.join(roomKey(room.code));
    this.notice(room, `👋 ${user.name} đã vào phòng`);
    this.broadcastRoom(room);
    return { ok: true, data: this.joinResult(room, user.userId) };
  }

  @SubscribeMessage('ms:leave')
  async handleLeave(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (!user) return { ok: false };
    const room = this.rooms.getRoomOfUser(user.userId);
    if (room) this.removeFromRoom(room, user.userId, 'đã rời phòng');
    return { ok: true };
  }

  @SubscribeMessage('ms:kick')
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
      this.server.to(target.socketId).emit('ms:kicked', { code: room.code });
    this.removeFromRoom(room, target.userId, 'đã bị chủ phòng mời ra');
    return { ok: true };
  }

  @SubscribeMessage('ms:bot:add')
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
    const level: MSBotLevel =
      body?.level === 'easy' || body?.level === 'hard' ? body.level : 'normal';
    if (!this.rooms.addBot(room, level))
      return { ok: false, error: 'Phòng đã đủ 12 người' };
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('ms:ready')
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

  @SubscribeMessage('ms:seat')
  handleSeat(): AckResponse {
    return { ok: false, error: 'Không đổi chỗ được' };
  }

  @SubscribeMessage('ms:settings')
  async handleSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: Partial<MSRoomSettings>,
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
    if (!this.rooms.startGame(room)) return false;
    this.logger.log(
      `[${room.code}] Ván ${room.games} (${room.players.length} người)`,
    );
    this.notice(room, '🌙 Màn đêm buông xuống… Hãy xem vai của bạn!');
    this.broadcastRoom(room);
    this.afterChange(room);
    return true;
  }

  @SubscribeMessage('ms:start')
  async handleStart(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được bắt đầu' };
    if (room.status === 'playing')
      return { ok: false, error: 'Ván đã bắt đầu' };
    if (room.players.length < MS_MIN)
      return {
        ok: false,
        error: `Cần ít nhất ${MS_MIN} người (có thể thêm máy)`,
      };
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

  /** Ván mới: chia lại vai */
  @SubscribeMessage('ms:next')
  async handleNext(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || !this.rooms.findPlayer(room, user.userId))
      return { ok: false, error: 'Bạn không ở trong phòng' };
    if (room.status !== 'finished')
      return { ok: false, error: 'Ván chưa kết thúc' };
    if (room.players.length < MS_MIN)
      return { ok: false, error: `Cần ít nhất ${MS_MIN} người` };
    this.beginMatch(room);
    return { ok: true };
  }

  @SubscribeMessage('ms:reset')
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

  @SubscribeMessage('ms:finish')
  handleFinish(): AckResponse {
    return { ok: true };
  }

  // ===================================================== CHAT
  @SubscribeMessage('ms:chat')
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
    const channel = this.rooms.channelFor(room, user.userId);
    if (!channel)
      return { ok: false, error: 'Ban đêm chỉ bầy Sói được nói chuyện' };
    this.chatTimes.set(user.userId, [...recent, now]);
    const seat = this.rooms.seatOf(room, user.userId);
    const m = this.rooms.addChat(room, {
      userId: user.userId,
      name: user.name,
      avatar: user.avatar,
      seat: seat >= 0 ? seat : player.seat,
      text,
      channel,
    });
    if (channel === 'all')
      this.server.to(roomKey(room.code)).emit('ms:chat', m);
    else
      for (const p of room.players)
        if (p.socketId && this.rooms.canRead(room, p.userId, channel))
          this.server.to(p.socketId).emit('ms:chat', m);
    return { ok: true };
  }

  // ===================================================== VÁN CHƠI
  @SubscribeMessage('ms:sync')
  async handleSync(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<MSSnapshot | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    return { ok: true, data: this.rooms.snapshotFor(room, user.userId) };
  }

  @SubscribeMessage('ms:act')
  async handleAct(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { action?: unknown },
  ): Promise<AckResponse<MSSnapshot | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    const now = Date.now();
    if (now - (this.lastMove.get(client.id) ?? 0) < MOVE_MIN_INTERVAL_MS)
      return { ok: false, error: 'Thao tác quá nhanh' };
    this.lastMove.set(client.id, now);
    const r = this.rooms.act(room, user.userId, body?.action);
    if (!r.ok)
      return {
        ok: false,
        error: r.error,
        data: this.rooms.snapshotFor(room, user.userId),
      };
    this.afterChange(room);
    return { ok: true };
  }

  // ===================================================== VOICE (WebRTC mesh — server chỉ chuyển tín hiệu)
  // Luật ai nghe ai (đêm chỉ Sói, người chết…) do client lọc ở cả hai đầu theo góc nhìn của mình.
  private voiceUsers(room: Room) {
    return Object.entries(room.voice).map(([userId, v]) => ({
      userId,
      muted: v.muted,
    }));
  }

  private broadcastVoice(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('ms:voice:users', { users: this.voiceUsers(room) });
  }

  private leaveVoice(room: Room, userId: string) {
    if (!room.voice[userId]) return;
    delete room.voice[userId];
    this.server.to(roomKey(room.code)).emit('ms:voice:left', { userId });
    this.broadcastVoice(room);
  }

  @SubscribeMessage('ms:voice:config')
  async handleVoiceConfig(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<{ iceServers: ReturnType<typeof getIceServers> }>> {
    if (!(await this.getUser(client))) return AUTH;
    return { ok: true, data: { iceServers: getIceServers() } };
  }

  /** Bật voice: trả về những người đang trong voice để người mới gửi offer tới họ */
  @SubscribeMessage('ms:voice:join')
  async handleVoiceJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { muted?: boolean },
  ): Promise<AckResponse<{ peers: string[] }>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || !this.rooms.findPlayer(room, user.userId))
      return { ok: false, error: 'Bạn không ở trong phòng' };
    const peers = Object.keys(room.voice).filter((id) => id !== user.userId);
    room.voice[user.userId] = { muted: !!body?.muted };
    this.broadcastVoice(room);
    return { ok: true, data: { peers } };
  }

  @SubscribeMessage('ms:voice:leave')
  async handleVoiceLeave(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    this.leaveVoice(room, user.userId);
    return { ok: true };
  }

  @SubscribeMessage('ms:voice:mute')
  async handleVoiceMute(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { muted?: boolean },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || !room.voice[user.userId]) return { ok: false };
    room.voice[user.userId].muted = !!body?.muted;
    this.broadcastVoice(room);
    return { ok: true };
  }

  @SubscribeMessage('ms:voice:list')
  async handleVoiceList(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<{ users: { userId: string; muted: boolean }[] }>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    return { ok: true, data: { users: this.voiceUsers(room) } };
  }

  /** Chuyển tín hiệu WebRTC (offer / answer / ICE) tới đúng 1 người trong cùng phòng */
  @SubscribeMessage('ms:voice:signal')
  async handleVoiceSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { to?: string; data?: unknown },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || typeof body?.to !== 'string') return { ok: false };
    if (!room.voice[user.userId] || !room.voice[body.to]) return { ok: false };
    const target = this.rooms.findPlayer(room, body.to);
    if (!target?.socketId) return { ok: false };
    this.server
      .to(target.socketId)
      .emit('ms:voice:signal', { from: user.userId, data: body.data });
    return { ok: true };
  }

  // ===================================================== GHÉP NHANH
  private leaveQueue(userId: string) {
    this.queue = this.queue.filter((e) => e.user.userId !== userId);
  }

  @SubscribeMessage('ms:quick')
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

  @SubscribeMessage('ms:quick:cancel')
  async handleQuickCancel(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (user) this.leaveQueue(user.userId);
    return { ok: true };
  }

  /** Ai chờ trước vào trước; đủ 8 vào ngay, chờ lâu thì thêm máy cho đủ làng */
  private sweepQueue() {
    const now = Date.now();
    let q = this.queue.filter(
      (e) => this.server?.sockets.sockets.get(e.socketId)?.connected,
    );
    q.sort((a, b) => a.since - b.since);
    while (q.length) {
      const waited = now - q[0].since;
      const take =
        q.length >= QUICK_SIZE
          ? QUICK_SIZE
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
      { discussSeconds: 90, isPrivate: true, quick: true },
    );
    for (const e of rest)
      this.rooms.addPlayer(room, { ...e.user, socketId: e.socketId });
    while (room.players.length < QUICK_SIZE) this.rooms.addBot(room, 'normal');
    for (const e of group) {
      const s = this.server.sockets.sockets.get(e.socketId);
      if (s) await s.join(roomKey(room.code));
    }
    this.beginMatch(room);
    for (const e of group)
      this.server.to(e.socketId).emit('ms:matched', { code: room.code });
  }
}
