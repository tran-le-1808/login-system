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
import { MonopolyRoomService } from './monopoly-room.service';
import {
  AckResponse,
  MONOPOLY_MAX_PLAYERS,
  MONOPOLY_MIN_PLAYERS,
  PublicRoom,
  Room,
  RoomChatMessage,
  RoomSettings,
} from './monopoly.types';

/** Thời gian chờ người chơi kết nối lại trước khi bị xoá khỏi phòng */
const LOBBY_RECONNECT_GRACE_MS = 15_000;
const GAME_RECONNECT_GRACE_MS = 60_000;
const MAX_CHAT_LENGTH = 300;

interface SocketUser {
  userId: string;
  name: string;
  avatar?: string;
}

interface JoinResult {
  room: PublicRoom;
  snapshot: unknown;
  chat: RoomChatMessage[];
}

interface JwtPayload {
  sub?: string;
  _id?: string;
  userId?: string;
}

const roomKey = (code: string) => `mono:${code}`;

@WebSocketGateway({
  cors: {
    origin: [process.env.WEB_URL ?? ''],
    credentials: true,
  },
})
export class MonopolyGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private disconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly rooms: MonopolyRoomService,
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  // =====================================================
  // AUTH
  // =====================================================
  private async getUser(client: Socket): Promise<SocketUser | null> {
    const cached = (client.data as { monoUser?: SocketUser }).monoUser;
    if (cached) return cached;

    const auth = client.handshake.auth as { token?: unknown };
    if (typeof auth.token !== 'string' || !auth.token) return null;
    const token = auth.token.replace(/^Bearer\s+/i, '');

    try {
      const decoded = await this.jwtService.verifyAsync<JwtPayload>(token);
      const userId = decoded.sub ?? decoded._id ?? decoded.userId;
      if (!userId) return null;

      const user = await this.userModel
        .findById(userId)
        .select('_id name avatar')
        .lean();
      if (!user) return null;

      const socketUser: SocketUser = {
        userId: String(user._id),
        name: user.name,
        avatar: user.avatar,
      };
      (client.data as { monoUser?: SocketUser }).monoUser = socketUser;
      return socketUser;
    } catch {
      return null;
    }
  }

  // =====================================================
  // HELPERS
  // =====================================================
  private broadcastRoom(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('mono:room', this.rooms.toPublic(room));
  }

  private notice(room: Room, text: string) {
    this.server.to(roomKey(room.code)).emit('mono:notice', { text });
  }

  private hostSocketId(room: Room): string | null {
    return this.rooms.findPlayer(room, room.hostId)?.socketId ?? null;
  }

  /** Báo cho host biết 1 người chơi đã rời trận (để host xử lý bỏ cuộc) */
  private notifyPlayerLeft(room: Room, userId: string) {
    if (room.status !== 'playing') return;
    const hostSocket = this.hostSocketId(room);
    if (hostSocket) {
      this.server.to(hostSocket).emit('mono:playerLeft', { userId });
    }
  }

  private clearDisconnectTimer(userId: string) {
    const timer = this.disconnectTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(userId);
    }
  }

  private joinResult(room: Room): JoinResult {
    return {
      room: this.rooms.toPublic(room),
      snapshot: room.snapshot,
      chat: room.chat,
    };
  }

  /** Rời phòng (chủ động, bị kick hoặc hết thời gian kết nối lại) */
  private removeFromRoom(room: Room, userId: string, reason: string) {
    const player = this.rooms.findPlayer(room, userId);
    if (!player) return;

    const wasHost = room.hostId === userId;
    if (player.socketId) {
      this.server.in(player.socketId).socketsLeave(roomKey(room.code));
    }
    this.clearDisconnectTimer(userId);

    const deleted = this.rooms.removePlayer(room, userId);
    if (deleted) return;

    this.notice(room, `${player.name} ${reason}`);
    if (wasHost) {
      const newHost = this.rooms.findPlayer(room, room.hostId);
      if (newHost) this.notice(room, `👑 ${newHost.name} trở thành chủ phòng`);
    }
    this.notifyPlayerLeft(room, userId);
    this.broadcastRoom(room);
  }

  // =====================================================
  // CONNECTION
  // =====================================================
  handleDisconnect(client: Socket) {
    const user = (client.data as { monoUser?: SocketUser }).monoUser;
    if (!user) return;

    const room = this.rooms.getRoomOfUser(user.userId);
    if (!room) return;
    const player = this.rooms.findPlayer(room, user.userId);
    if (!player || player.socketId !== client.id) return;

    player.connected = false;
    player.socketId = null;

    // Trong trận: host mất kết nối -> chuyển host ngay để trận đấu không bị treo
    if (room.status === 'playing' && room.hostId === user.userId) {
      const newHost = this.rooms.transferHost(room);
      if (newHost?.connected) {
        this.notice(
          room,
          `👑 ${user.name} mất kết nối, ${newHost.name} tạm làm chủ phòng`,
        );
      }
    }

    this.notice(room, `📴 ${user.name} mất kết nối`);
    this.broadcastRoom(room);

    const grace =
      room.status === 'playing'
        ? GAME_RECONNECT_GRACE_MS
        : LOBBY_RECONNECT_GRACE_MS;

    this.clearDisconnectTimer(user.userId);
    this.disconnectTimers.set(
      user.userId,
      setTimeout(() => {
        this.disconnectTimers.delete(user.userId);
        const current = this.rooms.get(room.code);
        const p = current && this.rooms.findPlayer(current, user.userId);
        if (current && p && !p.connected) {
          this.removeFromRoom(
            current,
            user.userId,
            'đã rời phòng (mất kết nối)',
          );
        }
      }, grace),
    );
  }

  // =====================================================
  // LOBBY
  // =====================================================
  @SubscribeMessage('mono:list')
  async handleList(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom[]>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    return { ok: true, data: this.rooms.listPublicLobbies() };
  }

  /** Phòng mà người dùng đang ở (để hiện nút quay lại phòng) */
  @SubscribeMessage('mono:myRoom')
  async handleMyRoom(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom | null>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const room = this.rooms.getRoomOfUser(user.userId);
    return { ok: true, data: room ? this.rooms.toPublic(room) : null };
  }

  @SubscribeMessage('mono:create')
  async handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: Partial<RoomSettings>,
  ): Promise<AckResponse<JoinResult>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };

    const current = this.rooms.getRoomOfUser(user.userId);
    if (current) this.removeFromRoom(current, user.userId, 'đã rời phòng');

    const room = this.rooms.create({ ...user, socketId: client.id });
    if (body) this.rooms.updateSettings(room, body);
    await client.join(roomKey(room.code));

    return { ok: true, data: this.joinResult(room) };
  }

  @SubscribeMessage('mono:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { code?: string },
  ): Promise<AckResponse<JoinResult>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };

    const code = this.rooms.normalizeCode(body?.code);
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'Không tìm thấy phòng với mã này' };

    const existing = this.rooms.findPlayer(room, user.userId);

    // Kết nối lại vào phòng đang ở
    if (existing) {
      this.clearDisconnectTimer(user.userId);
      const wasDisconnected = !existing.connected;
      existing.connected = true;
      existing.socketId = client.id;
      existing.name = user.name;
      existing.avatar = user.avatar;
      await client.join(roomKey(room.code));
      if (wasDisconnected) this.notice(room, `🔌 ${user.name} đã kết nối lại`);
      this.broadcastRoom(room);
      return { ok: true, data: this.joinResult(room) };
    }

    if (room.status !== 'lobby') {
      return { ok: false, error: 'Trận đấu trong phòng này đã bắt đầu' };
    }
    if (room.players.length >= MONOPOLY_MAX_PLAYERS) {
      return { ok: false, error: 'Phòng đã đủ 4 người chơi' };
    }

    const other = this.rooms.getRoomOfUser(user.userId);
    if (other) this.removeFromRoom(other, user.userId, 'đã rời phòng');

    this.rooms.addPlayer(room, { ...user, socketId: client.id });
    await client.join(roomKey(room.code));

    this.notice(room, `👋 ${user.name} đã vào phòng`);
    this.broadcastRoom(room);
    return { ok: true, data: this.joinResult(room) };
  }

  @SubscribeMessage('mono:leave')
  async handleLeave(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const room = this.rooms.getRoomOfUser(user.userId);
    if (room) this.removeFromRoom(room, user.userId, 'đã rời phòng');
    return { ok: true };
  }

  @SubscribeMessage('mono:kick')
  async handleKick(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { userId?: string },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const room = this.rooms.getRoomOfUser(user.userId);
    if (!room || room.hostId !== user.userId) {
      return { ok: false, error: 'Chỉ chủ phòng mới được kick' };
    }
    const targetId = body?.userId;
    if (!targetId || targetId === user.userId) {
      return { ok: false, error: 'Người chơi không hợp lệ' };
    }
    const target = this.rooms.findPlayer(room, targetId);
    if (!target)
      return { ok: false, error: 'Người chơi không còn trong phòng' };

    if (target.socketId) {
      this.server.to(target.socketId).emit('mono:kicked', { code: room.code });
    }
    this.removeFromRoom(room, targetId, 'đã bị chủ phòng mời ra');
    return { ok: true };
  }

  @SubscribeMessage('mono:ready')
  async handleReady(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { ready?: boolean },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.status !== 'lobby') return { ok: false };
    const player = this.rooms.findPlayer(room, user.userId);
    if (!player) return { ok: false };
    player.ready = !!body?.ready;
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('mono:seat')
  async handleSeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { seat?: number },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.status !== 'lobby') return { ok: false };
    const changed = this.rooms.changeSeat(
      room,
      user.userId,
      Number(body?.seat),
    );
    if (!changed) return { ok: false, error: 'Ghế này đã có người' };
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('mono:settings')
  async handleSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: Partial<RoomSettings>,
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

  @SubscribeMessage('mono:start')
  async handleStart(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được bắt đầu' };
    if (room.status !== 'lobby')
      return { ok: false, error: 'Trận đấu đã bắt đầu' };
    if (room.players.length < MONOPOLY_MIN_PLAYERS)
      return { ok: false, error: 'Cần ít nhất 2 người chơi' };
    const notReady = room.players.filter(
      (p) => p.userId !== room.hostId && (!p.ready || !p.connected),
    );
    if (notReady.length > 0)
      return { ok: false, error: 'Còn người chơi chưa sẵn sàng' };

    room.status = 'playing';
    room.snapshot = null;
    this.notice(room, '🎲 Trận đấu bắt đầu!');
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('mono:finish')
  async handleFinish(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId) return { ok: false };
    if (room.status === 'playing') {
      room.status = 'finished';
      this.broadcastRoom(room);
    }
    return { ok: true };
  }

  @SubscribeMessage('mono:reset')
  async handleReset(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được tạo ván mới' };
    this.rooms.resetToLobby(room);
    this.notice(room, '🔄 Chủ phòng đã đưa mọi người về phòng chờ');
    this.broadcastRoom(room);
    return { ok: true };
  }

  // =====================================================
  // CHAT
  // =====================================================
  @SubscribeMessage('mono:chat')
  async handleChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { text?: string },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    const player = this.rooms.findPlayer(room, user.userId);
    const text =
      typeof body?.text === 'string'
        ? body.text.trim().slice(0, MAX_CHAT_LENGTH)
        : '';
    if (!player || !text) return { ok: false };

    const message = this.rooms.addChat(room, {
      userId: user.userId,
      name: user.name,
      avatar: user.avatar,
      seat: player.seat,
      text,
    });
    this.server.to(roomKey(room.code)).emit('mono:chat', message);
    return { ok: true };
  }

  // =====================================================
  // GAME (host là nơi chạy luật chơi)
  // =====================================================

  /** Host gửi trạng thái game mới nhất -> lưu lại và phát cho người khác */
  @SubscribeMessage('mono:state')
  async handleState(
    @ConnectedSocket() client: Socket,
    @MessageBody() snapshot: unknown,
  ) {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId) return;
    if (room.status === 'lobby') return;
    if (typeof snapshot !== 'object' || snapshot === null) return;
    // Host chỉ gửi các trường thay đổi -> gộp vào bản lưu đầy đủ
    room.snapshot = {
      ...((room.snapshot as Record<string, unknown> | null) ?? {}),
      ...(snapshot as Record<string, unknown>),
    };
    client.to(roomKey(room.code)).emit('mono:state', snapshot);
  }

  /** Lấy trạng thái game mới nhất (khi vừa vào bàn cờ) */
  @SubscribeMessage('mono:sync')
  async handleSync(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<unknown>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    return { ok: true, data: room.snapshot };
  }

  /** Người chơi gửi thao tác -> chuyển cho host xử lý */
  @SubscribeMessage('mono:action')
  async handleAction(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { type?: string; payload?: unknown },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.status !== 'playing') return { ok: false };
    if (typeof body?.type !== 'string') return { ok: false };

    const hostSocket = this.hostSocketId(room);
    if (!hostSocket) {
      return { ok: false, error: 'Chủ phòng đang mất kết nối' };
    }
    this.server.to(hostSocket).emit('mono:action', {
      userId: user.userId,
      type: body.type,
      payload: body.payload,
    });
    return { ok: true };
  }
}
