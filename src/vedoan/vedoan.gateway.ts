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
import { VeDoanRoomService } from './vedoan-room.service';
import { VD_MAX_PLAYERS } from './vedoan.types';
import type {
  AckResponse,
  ChatKind,
  PublicRoom,
  Room,
  RoomChatMessage,
  VDRoomSettings,
  VDSnapshot,
} from './vedoan.types';
import type { DrawOp } from './shared/draw';

const LOBBY_GRACE_MS = 15_000;
const GAME_GRACE_MS = 45_000;
const MAX_CHAT_LENGTH = 120;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX_IN_WINDOW = 8;
/** Ghép nhanh: chỉ người thật (máy không đoán được tranh) */
const QUICK_SIZE = 8;
const QUICK_START_AT = 4;
const QUICK_FILL_MS = 8000;
const QUICK_SWEEP_MS = 1500;

interface SocketUser {
  userId: string;
  name: string;
  avatar?: string;
}
interface JoinResult {
  room: PublicRoom;
  snapshot: VDSnapshot | null;
  chat: RoomChatMessage[];
}
interface QueueEntry {
  user: SocketUser;
  socketId: string;
  since: number;
}

const roomKey = (code: string) => `vd:${code}`;
const AUTH = { ok: false, error: 'Bạn cần đăng nhập' } as const;

/**
 * VẼ ĐOÁN ONLINE — một người chọn từ & vẽ, những người khác gõ đáp án.
 * Server giữ đáp án (chỉ gửi cho người vẽ & người đã đoán đúng), chấm đoán, đồng hồ, gợi ý chữ, điểm;
 * nét vẽ của người vẽ được kiểm tra rồi chuyển cho cả phòng (vd:draw) và lưu lại cho người vào sau.
 * Giao thức phòng (vd:join / room / chat / ready / settings / start / reset…) giống Caro để dùng chung RoomContext.
 */
@WebSocketGateway({
  cors: { origin: [process.env.WEB_URL ?? ''], credentials: true },
})
export class VeDoanGateway implements OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger('VeDoan');
  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  private phaseTimers = new Map<string, NodeJS.Timeout[]>();
  private chatTimes = new Map<string, number[]>();
  private queue: QueueEntry[] = [];
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly rooms: VeDoanRoomService,
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {
    this.sweeper = setInterval(() => this.sweepQueue(), QUICK_SWEEP_MS);
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
    for (const list of this.phaseTimers.values()) list.forEach(clearTimeout);
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
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

  private async ctx(client: Socket) {
    const user = await this.getUser(client);
    const room = user ? this.rooms.getRoomOfUser(user.userId) : undefined;
    return { user, room };
  }

  private broadcastRoom(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('vd:room', this.rooms.toPublic(room));
  }
  private broadcastState(room: Room) {
    for (const p of room.players) {
      if (!p.socketId) continue;
      this.server
        .to(p.socketId)
        .emit('vd:state', this.rooms.snapshotFor(room, p.userId));
    }
  }
  /** Tin hệ thống trong khung chat (đoán đúng, ai vẽ…) */
  private system(room: Room, text: string, kind: ChatKind = 'system') {
    const m = this.rooms.addChat(room, {
      userId: 'system',
      name: '',
      seat: -1,
      text,
      kind,
    });
    this.server.to(roomKey(room.code)).emit('vd:chat', m);
  }
  private notice(room: Room, text: string) {
    this.server.to(roomKey(room.code)).emit('vd:notice', { text });
  }
  private joinResult(room: Room, userId: string): JoinResult {
    return {
      room: this.rooms.toPublic(room),
      snapshot: this.rooms.snapshotFor(room, userId),
      chat: this.rooms.chatFor(room, userId),
    };
  }

  // ===================================================== ĐỒNG HỒ LƯỢT
  private clearTimers(code: string) {
    this.phaseTimers.get(code)?.forEach(clearTimeout);
    this.phaseTimers.delete(code);
  }

  /** Hẹn hết giờ giai đoạn + các mốc lộ chữ (50% / 75% thời gian vẽ) */
  private schedule(room: Room) {
    this.clearTimers(room.code);
    const m = room.match;
    if (room.status !== 'playing' || !m) return;
    const t = m.turn;
    const id = t.id;
    const list: NodeJS.Timeout[] = [];
    list.push(
      setTimeout(
        () => {
          const cur = this.rooms.get(room.code);
          if (cur && this.rooms.expire(cur, id)) this.afterChange(cur);
        },
        Math.max(0, t.deadline - Date.now()) + 50,
      ),
    );
    if (t.phase === 'draw' && room.settings.hints) {
      const total = room.settings.drawSeconds * 1000;
      for (const frac of [0.5, 0.75]) {
        const at = t.drawStart + total * frac - Date.now();
        if (at > 0)
          list.push(
            setTimeout(() => {
              const cur = this.rooms.get(room.code);
              if (cur && this.rooms.hint(cur, id)) this.broadcastState(cur);
            }, at),
          );
      }
    }
    this.phaseTimers.set(room.code, list);
  }

  private lastPhase = new Map<string, string>();

  /** Sau mỗi thay đổi: thông báo chuyển giai đoạn, gửi trạng thái, hẹn giờ */
  private afterChange(room: Room) {
    const m = room.match;
    if (m) {
      const key = `${m.turn.id}:${m.over ? 'over' : m.turn.phase}`;
      if (this.lastPhase.get(room.code) !== key) {
        this.lastPhase.set(room.code, key);
        const t = m.turn;
        const name = m.names[t.drawer] ?? '?';
        if (m.over) {
          const top = Object.entries(m.scores).sort((a, b) => b[1] - a[1])[0];
          this.system(
            room,
            `🏆 Hết ván! ${top ? `${m.names[top[0]] ?? '?'} thắng với ${top[1]} điểm` : ''}`,
          );
          this.broadcastRoom(room);
        } else if (t.phase === 'choose')
          this.system(room, `✏️ Vòng ${m.round}: ${name} đang chọn từ…`);
        else if (t.phase === 'draw')
          this.system(room, `🎨 ${name} bắt đầu vẽ!`);
        else if (t.phase === 'reveal')
          this.system(room, `💡 Đáp án là: ${t.word ?? ''}`);
      }
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
    this.leaveVoice(room, user.userId);
    if (room.hostId === user.userId) this.rooms.transferHost(room);
    this.notice(room, `📴 ${user.name} mất kết nối`);
    this.broadcastRoom(room);
    // người vẽ mất kết nối: lượt kết thúc luôn; người khác: có thể ai cũng đoán xong rồi
    const m = room.match;
    if (m && room.status === 'playing') {
      if (m.turn.drawer === user.userId && m.turn.phase !== 'reveal')
        this.rooms.endTurn(room);
      this.afterChange(room);
    }
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
    if (player.socketId)
      this.server.in(player.socketId).socketsLeave(roomKey(room.code));
    this.clearDisconnectTimer(userId);
    if (this.rooms.removeUser(room, userId)) {
      this.clearTimers(room.code);
      this.lastPhase.delete(room.code);
      return;
    }
    this.notice(room, `${player.name} ${reason}`);
    this.rooms.onLeave(room, userId);
    this.broadcastRoom(room);
    this.afterChange(room);
  }

  // ===================================================== SẢNH & PHÒNG
  @SubscribeMessage('vd:list')
  async handleList(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom[]>> {
    if (!(await this.getUser(client))) return AUTH;
    return { ok: true, data: this.rooms.listPublic() };
  }

  @SubscribeMessage('vd:myRoom')
  async handleMyRoom(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom | null>> {
    const { user, room } = await this.ctx(client);
    if (!user) return AUTH;
    return { ok: true, data: room ? this.rooms.toPublic(room) : null };
  }

  @SubscribeMessage('vd:create')
  async handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: Partial<VDRoomSettings> & { customText?: string },
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
    if (body?.customText)
      this.rooms.updateSettings(room, { customText: body.customText });
    await client.join(roomKey(room.code));
    return { ok: true, data: this.joinResult(room, user.userId) };
  }

  @SubscribeMessage('vd:join')
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
    if (room.players.length >= VD_MAX_PLAYERS)
      return { ok: false, error: `Phòng đã đủ ${VD_MAX_PLAYERS} người` };
    const other = this.rooms.getRoomOfUser(user.userId);
    if (other) this.removeFromRoom(other, user.userId, 'đã rời phòng');
    this.leaveQueue(user.userId);
    this.rooms.addPlayer(room, { ...user, socketId: client.id });
    await client.join(roomKey(room.code));
    this.system(room, `👋 ${user.name} đã vào phòng`);
    this.broadcastRoom(room);
    this.broadcastState(room);
    return { ok: true, data: this.joinResult(room, user.userId) };
  }

  @SubscribeMessage('vd:leave')
  async handleLeave(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user) return { ok: false };
    if (room) this.removeFromRoom(room, user.userId, 'đã rời phòng');
    return { ok: true };
  }

  @SubscribeMessage('vd:kick')
  async handleKick(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { userId?: string },
  ): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được mời ra' };
    const target =
      body?.userId && body.userId !== user.userId
        ? this.rooms.findPlayer(room, body.userId)
        : null;
    if (!target) return { ok: false, error: 'Người chơi không hợp lệ' };
    if (target.socketId)
      this.server.to(target.socketId).emit('vd:kicked', { code: room.code });
    this.removeFromRoom(room, target.userId, 'đã bị chủ phòng mời ra');
    return { ok: true };
  }

  @SubscribeMessage('vd:ready')
  async handleReady(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { ready?: boolean },
  ): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    const p = room && user && this.rooms.findPlayer(room, user.userId);
    if (!room || !p || room.status !== 'lobby') return { ok: false };
    p.ready = !!body?.ready;
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('vd:seat')
  handleSeat(): AckResponse {
    return { ok: false, error: 'Không đổi chỗ được' };
  }

  @SubscribeMessage('vd:settings')
  async handleSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: Partial<VDRoomSettings> & { customText?: string },
  ): Promise<AckResponse<{ customWords: string[] }>> {
    const { user, room } = await this.ctx(client);
    if (
      !user ||
      !room ||
      room.hostId !== user.userId ||
      room.status !== 'lobby'
    )
      return { ok: false, error: 'Chỉ chủ phòng mới được đổi cài đặt' };
    this.rooms.updateSettings(room, body ?? {});
    this.broadcastRoom(room);
    return { ok: true, data: { customWords: room.settings.customWords } };
  }

  /** Chủ phòng xem lại danh sách từ tự nhập */
  @SubscribeMessage('vd:words')
  async handleWords(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<{ customWords: string[] }>> {
    const { user, room } = await this.ctx(client);
    if (!user || !room || room.hostId !== user.userId) return { ok: false };
    return { ok: true, data: { customWords: room.settings.customWords } };
  }

  private beginMatch(room: Room) {
    if (!this.rooms.startGame(room)) return false;
    this.logger.log(
      `[${room.code}] Ván ${room.games} (${room.players.length} người)`,
    );
    this.broadcastRoom(room);
    this.afterChange(room);
    return true;
  }

  @SubscribeMessage('vd:start')
  async handleStart(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được bắt đầu' };
    if (room.status === 'playing')
      return { ok: false, error: 'Ván đã bắt đầu' };
    if (room.players.length < 2)
      return { ok: false, error: 'Cần ít nhất 2 người' };
    if (
      room.players.some(
        (p) => p.userId !== room.hostId && (!p.ready || !p.connected),
      )
    )
      return { ok: false, error: 'Còn người chưa sẵn sàng' };
    this.beginMatch(room);
    return { ok: true };
  }

  /** Chơi lại ván mới (ai trong phòng cũng bấm được khi ván đã xong) */
  @SubscribeMessage('vd:next')
  async handleNext(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    if (room.status !== 'finished')
      return { ok: false, error: 'Ván chưa kết thúc' };
    if (room.players.length < 2)
      return { ok: false, error: 'Cần ít nhất 2 người' };
    this.beginMatch(room);
    return { ok: true };
  }

  @SubscribeMessage('vd:reset')
  async handleReset(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được về phòng chờ' };
    if (room.status === 'playing')
      return { ok: false, error: 'Ván đang diễn ra' };
    this.clearTimers(room.code);
    this.rooms.resetToLobby(room);
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('vd:finish')
  handleFinish(): AckResponse {
    return { ok: true };
  }

  // ===================================================== CHAT = ĐOÁN
  @SubscribeMessage('vd:chat')
  async handleChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { text?: string },
  ): Promise<AckResponse<{ kind: string; points?: number }>> {
    const { user, room } = await this.ctx(client);
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
      return { ok: false, error: 'Bạn gửi quá nhanh' };
    this.chatTimes.set(user.userId, [...recent, now]);

    const r = this.rooms.guess(room, user.userId, text);
    if (r.kind === 'blocked') return { ok: false, error: r.error };
    if (r.kind === 'correct') {
      this.system(
        room,
        `✅ ${user.name} đã đoán đúng! (+${r.points})`,
        'correct',
      );
      this.afterChange(room);
      return { ok: true, data: { kind: 'correct', points: r.points } };
    }
    if (r.kind === 'close') return { ok: true, data: { kind: 'close' } };
    const m = this.rooms.addChat(room, {
      userId: user.userId,
      name: user.name,
      avatar: user.avatar,
      seat: player.seat,
      text,
      kind: r.kind,
    });
    if (r.kind === 'chat')
      this.server.to(roomKey(room.code)).emit('vd:chat', m);
    else
      for (const p of room.players)
        if (p.socketId && this.rooms.canRead(room, p.userId, 'guessed'))
          this.server.to(p.socketId).emit('vd:chat', m);
    return { ok: true, data: { kind: r.kind } };
  }

  // ===================================================== VẼ
  @SubscribeMessage('vd:sync')
  async handleSync(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<VDSnapshot | null>> {
    const { user, room } = await this.ctx(client);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    return { ok: true, data: this.rooms.snapshotFor(room, user.userId) };
  }

  @SubscribeMessage('vd:ops')
  async handleOps(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<{ turnId: number; ops: DrawOp[] } | null>> {
    const { user, room } = await this.ctx(client);
    if (!user || !room) return { ok: false };
    return { ok: true, data: this.rooms.opsFor(room) };
  }

  @SubscribeMessage('vd:choose')
  async handleChoose(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { index?: unknown },
  ): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user || !room) return { ok: false, error: 'Bạn không ở trong phòng' };
    const r = this.rooms.choose(room, user.userId, body?.index);
    if (!r.ok) return r;
    this.afterChange(room);
    return { ok: true };
  }

  @SubscribeMessage('vd:draw')
  async handleDraw(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { ops?: unknown; turnId?: unknown },
  ): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user || !room) return { ok: false };
    const r = this.rooms.draw(room, user.userId, body?.ops, body?.turnId);
    if (typeof r === 'string') return { ok: false, error: r };
    client
      .to(roomKey(room.code))
      .emit('vd:draw', { turnId: room.match!.turn.id, ops: r });
    return { ok: true };
  }

  // ===================================================== VOICE (WebRTC mesh — server chỉ chuyển tín hiệu)
  private voiceUsers(room: Room) {
    return Object.entries(room.voice).map(([userId, v]) => ({
      userId,
      muted: v.muted,
    }));
  }
  private broadcastVoice(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('vd:voice:users', { users: this.voiceUsers(room) });
  }
  private leaveVoice(room: Room, userId: string) {
    if (!room.voice[userId]) return;
    delete room.voice[userId];
    this.server.to(roomKey(room.code)).emit('vd:voice:left', { userId });
    this.broadcastVoice(room);
  }

  @SubscribeMessage('vd:voice:config')
  async handleVoiceConfig(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<{ iceServers: ReturnType<typeof getIceServers> }>> {
    if (!(await this.getUser(client))) return AUTH;
    return { ok: true, data: { iceServers: getIceServers() } };
  }

  @SubscribeMessage('vd:voice:join')
  async handleVoiceJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { muted?: boolean },
  ): Promise<AckResponse<{ peers: string[] }>> {
    const { user, room } = await this.ctx(client);
    if (!user || !room || !this.rooms.findPlayer(room, user.userId))
      return { ok: false, error: 'Bạn không ở trong phòng' };
    const peers = Object.keys(room.voice).filter((id) => id !== user.userId);
    room.voice[user.userId] = { muted: !!body?.muted };
    this.broadcastVoice(room);
    return { ok: true, data: { peers } };
  }

  @SubscribeMessage('vd:voice:leave')
  async handleVoiceLeave(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user || !room) return { ok: false };
    this.leaveVoice(room, user.userId);
    return { ok: true };
  }

  @SubscribeMessage('vd:voice:mute')
  async handleVoiceMute(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { muted?: boolean },
  ): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user || !room || !room.voice[user.userId]) return { ok: false };
    room.voice[user.userId].muted = !!body?.muted;
    this.broadcastVoice(room);
    return { ok: true };
  }

  @SubscribeMessage('vd:voice:list')
  async handleVoiceList(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<{ users: { userId: string; muted: boolean }[] }>> {
    const { user, room } = await this.ctx(client);
    if (!user || !room) return { ok: false };
    return { ok: true, data: { users: this.voiceUsers(room) } };
  }

  @SubscribeMessage('vd:voice:signal')
  async handleVoiceSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { to?: string; data?: unknown },
  ): Promise<AckResponse> {
    const { user, room } = await this.ctx(client);
    if (!user || !room || typeof body?.to !== 'string') return { ok: false };
    if (!room.voice[user.userId] || !room.voice[body.to]) return { ok: false };
    const target = this.rooms.findPlayer(room, body.to);
    if (!target?.socketId) return { ok: false };
    this.server
      .to(target.socketId)
      .emit('vd:voice:signal', { from: user.userId, data: body.data });
    return { ok: true };
  }

  // ===================================================== GHÉP NHANH
  private leaveQueue(userId: string) {
    this.queue = this.queue.filter((e) => e.user.userId !== userId);
  }

  @SubscribeMessage('vd:quick')
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

  @SubscribeMessage('vd:quick:cancel')
  async handleQuickCancel(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (user) this.leaveQueue(user.userId);
    return { ok: true };
  }

  /**
   * Ghép nhanh (chỉ người thật): ưu tiên vào bàn ghép nhanh đang chơi còn chỗ;
   * không có thì đủ 4 người là mở bàn, hoặc ≥ 2 người chờ lâu.
   */
  private sweepQueue() {
    const now = Date.now();
    let q = this.queue.filter(
      (e) => this.server?.sockets.sockets.get(e.socketId)?.connected,
    );
    q.sort((a, b) => a.since - b.since);
    const open = this.rooms
      .all()
      .filter(
        (r) =>
          r.settings.quick &&
          r.status === 'playing' &&
          r.players.length < QUICK_SIZE,
      );
    for (const r of open) {
      while (q.length && r.players.length < QUICK_SIZE) {
        const e = q.shift()!;
        void this.addToQuick(r, e);
      }
    }
    while (q.length) {
      const waited = now - q[0].since;
      const take =
        q.length >= QUICK_START_AT
          ? Math.min(QUICK_SIZE, q.length)
          : q.length >= 2 && waited >= QUICK_FILL_MS
            ? q.length
            : 0;
      if (!take) break;
      const group = q.slice(0, take);
      q = q.slice(take);
      void this.createQuick(group);
    }
    this.queue = q;
  }

  private async addToQuick(room: Room, e: QueueEntry) {
    this.rooms.addPlayer(room, { ...e.user, socketId: e.socketId });
    const s = this.server.sockets.sockets.get(e.socketId);
    if (s) await s.join(roomKey(room.code));
    this.system(room, `👋 ${e.user.name} đã vào phòng`);
    this.broadcastRoom(room);
    this.broadcastState(room);
    this.server.to(e.socketId).emit('vd:matched', { code: room.code });
  }

  private async createQuick(group: QueueEntry[]) {
    const [a, ...rest] = group;
    const room = this.rooms.create(
      { ...a.user, socketId: a.socketId },
      { isPrivate: true, quick: true },
    );
    for (const e of rest)
      this.rooms.addPlayer(room, { ...e.user, socketId: e.socketId });
    for (const e of group) {
      const s = this.server.sockets.sockets.get(e.socketId);
      if (s) await s.join(roomKey(room.code));
    }
    this.beginMatch(room);
    for (const e of group)
      this.server.to(e.socketId).emit('vd:matched', { code: room.code });
  }
}
