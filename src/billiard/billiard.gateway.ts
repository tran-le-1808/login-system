import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Server, Socket } from 'socket.io';
import { User, UserDocument } from 'src/users/entities/user.entity';
import { BilliardRoomService } from './billiard-room.service';
import {
  AckResponse,
  BILLIARD_MAX_PLAYERS,
  BILLIARD_MIN_PLAYERS,
  BilliardMatch,
  PublicRoom,
  Room,
  RoomChatMessage,
  RoomSettings,
} from './billiard.types';
import { getIceServers } from '../realtime/ice-servers';
import { checkPassword } from './billiard-room.service';
import {
  CreateRoomDto,
  JoinRoomDto,
  RoomListDto,
  validateDto,
} from './lobby/dto/lobby.dto';
import { BilliardEventsService, userRoomKey } from './lobby/events.service';
import {
  BilliardMatchFlowService,
  type FinishOutcome,
} from './lobby/match-flow.service';
import { RANKING_CONFIG, ruleSetById } from './lobby/ranking.config';
import { BilliardTournamentService } from './lobby/tournament.service';
import type { BracketMatch } from './lobby/bracket';
import type { RoomKind } from './billiard.types';

/** Thời gian chờ người chơi kết nối lại trước khi bị xoá khỏi phòng */
const LOBBY_RECONNECT_GRACE_MS = 15_000;
const GAME_RECONNECT_GRACE_MS = 60_000;
const MAX_CHAT_LENGTH = 300;
/** Chống spam: tối thiểu giữa 2 lần gửi cú đánh / tối đa tin nhắn trong cửa sổ thời gian */
const SHOT_MIN_INTERVAL_MS = 400;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX_IN_WINDOW = 6;

export interface SocketUser {
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

const roomKey = (code: string) => `bida:${code}`;

@WebSocketGateway({
  cors: {
    origin: [process.env.WEB_URL ?? ''],
    credentials: true,
  },
})
export class BilliardGateway implements OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server!: Server;

  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly logger = new Logger('Billiard');
  /** userId -> thời điểm gửi cú đánh gần nhất / các lần chat gần đây */
  private lastShotAt = new Map<string, number>();
  private chatTimes = new Map<string, number[]>();

  /** Hẹn giờ "không vào trận" của phòng ghép trận / giải đấu */
  private noShowTimers = new Map<string, NodeJS.Timeout>();

  /** Gateway sảnh gắn vào: người đang tìm / chờ xác nhận trận ghép thì không được tạo phòng */
  matchmakingBusy: (userId: string) => string | null = () => null;

  constructor(
    private readonly rooms: BilliardRoomService,
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly flow: BilliardMatchFlowService,
    private readonly tournaments: BilliardTournamentService,
    private readonly events: BilliardEventsService,
  ) {}

  afterInit(server: Server) {
    this.events.attach(server);
  }

  /** Xác thực socket (dùng chung cho gateway sảnh) */
  authUser(client: Socket): Promise<SocketUser | null> {
    return this.getUser(client);
  }

  // =====================================================
  // TRẬN GHÉP / GIẢI ĐẤU
  // =====================================================
  /**
   * Mở phòng cho một trận ghép tự động / giải đấu và báo cho đúng 2 người.
   * Đủ 2 người vào phòng -> tự bắt đầu; quá hạn mà vắng -> người vắng bị xử thua (hoặc huỷ nếu cả hai vắng).
   */
  openMatchRoom(
    kind: Exclude<RoomKind, 'casual'>,
    users: { userId: string; name: string; avatar?: string }[],
    ruleSetId: string,
    meta: {
      matchId: string;
      tournamentId?: string | null;
      tournamentMatchId?: string | null;
    },
  ): Room {
    const rule =
      ruleSetById(ruleSetId) ??
      ruleSetById(RANKING_CONFIG.matchmaking.rankedRuleSets.three[0])!;
    const deadline =
      Date.now() + RANKING_CONFIG.matchmaking.noShowSeconds * 1000;
    const room = this.rooms.createMatchRoom(kind, users, rule, {
      matchId: meta.matchId,
      ruleSet: rule.id,
      tournamentId: meta.tournamentId ?? null,
      tournamentMatchId: meta.tournamentMatchId ?? null,
      joinDeadline: deadline,
    });
    this.noShowTimers.set(
      room.code,
      setTimeout(
        () => void this.resolveNoShow(room.code),
        deadline - Date.now(),
      ),
    );
    this.events.toUsers(
      users.map((u) => u.userId),
      'bida:match:ready',
      {
        code: room.code,
        kind,
        ruleSet: rule.id,
        matchId: meta.matchId,
        tournamentId: meta.tournamentId ?? null,
        joinDeadline: deadline,
      },
    );
    this.logger.log(
      `[${room.code}] Mở phòng trận ${kind} ${users.map((u) => u.name).join(' vs ')}`,
    );
    return room;
  }

  /** Mở phòng cho các trận giải đấu vừa sẵn sàng */
  async openTournamentMatches(
    list: { tournamentId: string; match: BracketMatch }[],
  ): Promise<void> {
    for (const { tournamentId, match } of list) {
      if (!match.playerA || !match.playerB) continue;
      const t = await this.tournaments.get(tournamentId);
      if (!t) continue;
      const users = [match.playerA, match.playerB].map((id) => {
        const p = t.participants.find((x) => x.userId === id);
        return { userId: id, name: p?.name ?? 'Người chơi', avatar: p?.avatar };
      });
      // người chơi đang bận trận khác (hiếm): để lần quét sau
      if (
        users.some(
          (u) => this.rooms.getRoomOfUser(u.userId)?.status === 'playing',
        )
      )
        continue;
      const matchId = `t-${tournamentId}-${match.id}`;
      const room = this.openMatchRoom('tournament', users, t.ruleSet, {
        matchId,
        tournamentId,
        tournamentMatchId: match.id,
      });
      const ok = await this.tournaments.assignRoom(
        tournamentId,
        match.id,
        room.code,
      );
      if (!ok.ok) {
        this.clearNoShow(room.code);
        this.rooms.closeRoom(room);
      }
    }
  }

  private clearNoShow(code: string) {
    const t = this.noShowTimers.get(code);
    if (t) clearTimeout(t);
    this.noShowTimers.delete(code);
  }

  /** Bắt đầu trận ghép khi cả hai đã vào phòng */
  private autoStartIfReady(room: Room) {
    if (room.kind === 'casual' || room.status !== 'lobby') return;
    if (room.players.length < 2 || room.players.some((p) => !p.connected))
      return;
    this.clearNoShow(room.code);
    this.rooms.startGame(room);
    this.notice(room, '🎱 Trận đấu bắt đầu! Bi trắng khai cuộc');
    this.broadcastRoom(room);
    this.broadcastGame(room);
    this.scheduleTurnTimer(room);
    void this.flow
      .onStarted(room)
      .catch((e: Error) =>
        this.logger.error(`Không ghi được trận bắt đầu: ${e.message}`),
      );
  }

  /** Hết hạn vào phòng: một người vắng -> người đó thua; cả hai vắng -> huỷ trận */
  private async resolveNoShow(code: string) {
    this.noShowTimers.delete(code);
    const room = this.rooms.get(code);
    if (!room || room.status !== 'lobby' || room.kind === 'casual') return;
    const present = room.players.filter((p) => p.connected);
    if (present.length === room.players.length)
      return this.autoStartIfReady(room);
    if (present.length === 0) {
      const out = await this.flow.onCancelled(
        room,
        'Cả hai người chơi không vào trận',
      );
      this.rooms.closeRoom(room);
      await this.openTournamentMatches(out.ready);
      return;
    }
    const absent = room.players.find((p) => !p.connected)!;
    this.rooms.startGame(room);
    this.rooms.forfeit(room, absent.userId, `${absent.name} không vào trận`);
    this.broadcastRoom(room);
    this.broadcastGame(room);
    await this.handleFinished(room);
  }

  /** Trận có người thắng: ghi kết quả (đúng 1 lần) và mở trận giải đấu kế tiếp */
  private async handleFinished(room: Room): Promise<void> {
    this.clearNoShow(room.code);
    let out: FinishOutcome;
    try {
      out = await this.flow.onFinished(room);
    } catch (e) {
      this.logger.error(
        `[${room.code}] Không ghi được kết quả trận: ${(e as Error).message}`,
      );
      return;
    }
    if (out.result && room.kind === 'ranked') {
      for (const r of out.result.players) {
        const p = room.players.find((x) => x.userId === r.userId);
        if (p && r.delta)
          this.notice(
            room,
            `📈 ${p.name}: ${r.delta > 0 ? '+' : ''}${r.delta} điểm xếp hạng (${r.after})`,
          );
      }
    }
    await this.openTournamentMatches(out.ready);
  }

  /** Ra khỏi phòng trận ghép / giải đấu trước khi bắt đầu = bỏ trận (không lợi dụng để tránh mất điểm) */
  private forfeitBeforeStart(room: Room) {
    if (
      room.kind === 'casual' ||
      room.status !== 'lobby' ||
      room.players.length < 2
    )
      return;
    this.clearNoShow(room.code);
    this.rooms.startGame(room);
  }

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
      .emit('bida:room', this.rooms.toPublic(room));
  }

  private notice(room: Room, text: string) {
    this.server.to(roomKey(room.code)).emit('bida:notice', { text });
  }

  // ===================== GAME =====================
  private turnTimers = new Map<string, NodeJS.Timeout>();

  private withServerTime(match: BilliardMatch | null) {
    return match ? { ...match, serverNow: Date.now() } : null;
  }

  private broadcastGame(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('bida:state', this.withServerTime(room.snapshot));
  }

  private allowChat(userId: string): boolean {
    const now = Date.now();
    const recent = (this.chatTimes.get(userId) ?? []).filter(
      (t) => now - t < CHAT_WINDOW_MS,
    );
    if (recent.length >= CHAT_MAX_IN_WINDOW) return false;
    recent.push(now);
    this.chatTimes.set(userId, recent);
    return true;
  }

  private clearTurnTimer(code: string) {
    const t = this.turnTimers.get(code);
    if (t) clearTimeout(t);
    this.turnTimers.delete(code);
  }

  /** Hẹn giờ hết lượt: quá giờ chưa đánh -> mất lượt */
  private scheduleTurnTimer(room: Room) {
    this.clearTurnTimer(room.code);
    const game = room.snapshot;
    if (room.status !== 'playing' || !game || game.winner !== null) return;
    const wait = Math.max(0, game.turnDeadline - Date.now()) + 50;
    this.turnTimers.set(
      room.code,
      setTimeout(() => {
        this.turnTimers.delete(room.code);
        const current = this.rooms.get(room.code);
        if (!current || current.snapshot !== game) return;
        const loser = current.players.find(
          (p) => p.userId === game.players[game.turn],
        );
        if (this.rooms.timeoutTurn(current)) {
          this.notice(
            current,
            `⏰ ${loser?.name ?? 'Người chơi'} hết giờ, mất lượt`,
          );
          this.broadcastGame(current);
        }
        this.scheduleTurnTimer(current);
      }, wait),
    );
  }

  // ===================== VOICE =====================
  private voiceUsers(room: Room) {
    return Object.entries(room.voice).map(([userId, v]) => ({
      userId,
      muted: v.muted,
    }));
  }

  private broadcastVoice(room: Room) {
    this.server
      .to(roomKey(room.code))
      .emit('bida:voice:users', { users: this.voiceUsers(room) });
  }

  /** Bỏ 1 người khỏi voice (rời voice / mất kết nối / rời phòng) */
  private leaveVoice(room: Room, userId: string) {
    if (!room.voice[userId]) return;
    delete room.voice[userId];
    this.server.to(roomKey(room.code)).emit('bida:voice:left', { userId });
    this.broadcastVoice(room);
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
    this.leaveVoice(room, userId);
    this.forfeitBeforeStart(room);
    // Rời giữa trận -> xử thua, người còn lại thắng
    if (this.rooms.forfeit(room, userId, `${player.name} ${reason}`)) {
      this.clearTurnTimer(room.code);
      this.broadcastGame(room);
      void this.handleFinished(room);
    }
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
    // Mất kết nối -> rời voice (client tự vào lại khi kết nối lại)
    this.leaveVoice(room, user.userId);

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
  @SubscribeMessage('bida:list')
  async handleList(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: unknown,
  ): Promise<AckResponse<PublicRoom[]>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const q = validateDto(RoomListDto, body);
    if (!q.ok) return { ok: false, error: q.error };
    return { ok: true, data: this.rooms.listPublicLobbies(q.value) };
  }

  /** Phòng mà người dùng đang ở (để hiện nút quay lại phòng) */
  @SubscribeMessage('bida:myRoom')
  async handleMyRoom(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<PublicRoom | null>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const room = this.rooms.getRoomOfUser(user.userId);
    return { ok: true, data: room ? this.rooms.toPublic(room) : null };
  }

  @SubscribeMessage('bida:create')
  async handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: unknown,
  ): Promise<AckResponse<JoinResult>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const dto = validateDto(CreateRoomDto, body);
    if (!dto.ok) return { ok: false, error: dto.error };
    const busy =
      this.rooms.busyReason(user.userId) ?? this.matchmakingBusy(user.userId);
    if (busy) return { ok: false, error: busy };

    const current = this.rooms.getRoomOfUser(user.userId);
    if (current) this.removeFromRoom(current, user.userId, 'đã rời phòng');

    const room = this.rooms.create({ ...user, socketId: client.id });
    const { password, ...settings } = dto.value;
    this.rooms.updateSettings(room, {
      ...settings,
      name: settings.name || `Phòng của ${user.name}`,
    });
    if (room.settings.isPrivate && password)
      this.rooms.setPassword(room, password);
    await client.join(roomKey(room.code));
    await client.join(userRoomKey(user.userId));

    return { ok: true, data: this.joinResult(room) };
  }

  @SubscribeMessage('bida:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<AckResponse<JoinResult>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const dto = validateDto(JoinRoomDto, {
      ...(body && typeof body === 'object' ? body : {}),
      code: this.rooms.normalizeCode(
        (body as { code?: unknown } | undefined)?.code,
      ),
    });
    if (!dto.ok) return { ok: false, error: 'Mã phòng không hợp lệ' };
    await client.join(userRoomKey(user.userId));

    const code = dto.value.code;
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
      this.autoStartIfReady(room);
      return { ok: true, data: this.joinResult(room) };
    }

    if (room.kind !== 'casual') {
      return {
        ok: false,
        error: 'Đây là phòng trận đấu dành riêng cho 2 người chơi',
      };
    }
    if (
      room.passwordHash &&
      !checkPassword(dto.value.password ?? '', room.passwordHash)
    ) {
      return dto.value.password
        ? {
            ok: false,
            error: 'Mật khẩu phòng không đúng',
            code: 'WRONG_PASSWORD',
          }
        : {
            ok: false,
            error: 'Phòng này cần mật khẩu',
            code: 'PASSWORD_REQUIRED',
          };
    }
    const busy = this.rooms.busyReason(user.userId);
    if (busy) return { ok: false, error: busy };

    if (room.status !== 'lobby') {
      return { ok: false, error: 'Trận đấu trong phòng này đã bắt đầu' };
    }
    if (room.players.length >= BILLIARD_MAX_PLAYERS) {
      return { ok: false, error: 'Phòng đã đủ 2 người chơi' };
    }

    const other = this.rooms.getRoomOfUser(user.userId);
    if (other) this.removeFromRoom(other, user.userId, 'đã rời phòng');

    this.rooms.addPlayer(room, { ...user, socketId: client.id });
    await client.join(roomKey(room.code));

    this.notice(room, `👋 ${user.name} đã vào phòng`);
    this.broadcastRoom(room);
    return { ok: true, data: this.joinResult(room) };
  }

  @SubscribeMessage('bida:leave')
  async handleLeave(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    const room = this.rooms.getRoomOfUser(user.userId);
    if (room) this.removeFromRoom(room, user.userId, 'đã rời phòng');
    return { ok: true };
  }

  @SubscribeMessage('bida:kick')
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
    if (room.kind !== 'casual') {
      return {
        ok: false,
        error: 'Không thể kick trong phòng trận xếp cặp / giải đấu',
      };
    }
    // Chỉ được kick khi đang ở phòng chờ, trận đã bắt đầu thì không
    if (room.status !== 'lobby') {
      return { ok: false, error: 'Không thể kick khi trận đấu đã bắt đầu' };
    }
    const targetId = body?.userId;
    if (!targetId || targetId === user.userId) {
      return { ok: false, error: 'Người chơi không hợp lệ' };
    }
    const target = this.rooms.findPlayer(room, targetId);
    if (!target)
      return { ok: false, error: 'Người chơi không còn trong phòng' };

    if (target.socketId) {
      this.server.to(target.socketId).emit('bida:kicked', { code: room.code });
    }
    this.removeFromRoom(room, targetId, 'đã bị chủ phòng mời ra');
    return { ok: true };
  }

  @SubscribeMessage('bida:ready')
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

  @SubscribeMessage('bida:seat')
  async handleSeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { seat?: number },
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.status !== 'lobby' || room.kind !== 'casual')
      return { ok: false };
    const changed = this.rooms.changeSeat(
      room,
      user.userId,
      Number(body?.seat),
    );
    if (!changed) return { ok: false, error: 'Ghế này đã có người' };
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('bida:settings')
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
      room.status !== 'lobby' ||
      room.kind !== 'casual'
    )
      return { ok: false, error: 'Chỉ chủ phòng mới được đổi cài đặt' };
    const { password, ...patch } = (body ?? {}) as Partial<RoomSettings> & {
      password?: unknown;
    };
    this.rooms.updateSettings(room, patch);
    if (password !== undefined) {
      if (
        password !== null &&
        (typeof password !== 'string' ||
          password.length < 3 ||
          password.length > 32)
      )
        return { ok: false, error: 'Mật khẩu 3–32 ký tự' };
      this.rooms.setPassword(room, room.settings.isPrivate ? password : null);
    }
    if (!room.settings.isPrivate) this.rooms.setPassword(room, null);
    this.broadcastRoom(room);
    return { ok: true };
  }

  @SubscribeMessage('bida:start')
  async handleStart(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được bắt đầu' };
    if (room.status !== 'lobby')
      return { ok: false, error: 'Trận đấu đã bắt đầu' };
    if (room.players.length < BILLIARD_MIN_PLAYERS)
      return { ok: false, error: 'Cần ít nhất 2 người chơi' };
    const notReady = room.players.filter(
      (p) => p.userId !== room.hostId && (!p.ready || !p.connected),
    );
    if (notReady.length > 0)
      return { ok: false, error: 'Còn người chơi chưa sẵn sàng' };

    if (room.kind !== 'casual')
      return { ok: false, error: 'Trận xếp cặp tự bắt đầu khi đủ người' };
    this.rooms.startGame(room);
    void this.flow
      .onStarted(room)
      .catch((e: Error) =>
        this.logger.error(`Không ghi được trận bắt đầu: ${e.message}`),
      );
    this.logger.log(
      `[${room.code}] Bắt đầu trận ${room.settings.mode === 'free' ? 'phăng' : '3 băng'} ${room.settings.target} điểm`,
    );
    this.notice(room, '🎱 Trận đấu bắt đầu! Bi trắng khai cuộc');
    this.broadcastRoom(room);
    this.broadcastGame(room);
    this.scheduleTurnTimer(room);
    return { ok: true };
  }

  @SubscribeMessage('bida:reset')
  async handleReset(@ConnectedSocket() client: Socket): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || room.hostId !== user.userId)
      return { ok: false, error: 'Chỉ chủ phòng mới được tạo ván mới' };
    if (room.kind !== 'casual')
      return { ok: false, error: 'Trận xếp cặp / giải đấu chỉ đấu một ván' };
    // ván đang dở bị huỷ: ghi là CANCELLED (không tính thắng thua)
    if (room.status === 'playing' && room.snapshot?.winner === null)
      void this.flow
        .onCancelled(room, 'Chủ phòng huỷ ván')
        .catch(() => undefined);
    this.clearTurnTimer(room.code);
    this.rooms.resetToLobby(room);
    this.notice(room, '🔄 Chủ phòng đã đưa mọi người về phòng chờ');
    this.broadcastRoom(room);
    return { ok: true };
  }

  // =====================================================
  // CHAT
  // =====================================================
  @SubscribeMessage('bida:chat')
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
    if (!this.allowChat(user.userId))
      return { ok: false, error: 'Bạn gửi tin nhắn quá nhanh' };

    const message = this.rooms.addChat(room, {
      userId: user.userId,
      name: user.name,
      avatar: user.avatar,
      seat: player.seat,
      text,
      messageType: 'player',
    });
    this.server.to(roomKey(room.code)).emit('bida:chat', message);
    return { ok: true };
  }

  // =====================================================
  // GAME (server chạy luật chơi & vật lý)
  // =====================================================

  /** Lấy trạng thái ván mới nhất (khi vừa vào bàn / kết nối lại) */
  @SubscribeMessage('bida:sync')
  async handleSync(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<BilliardMatch | null>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    return { ok: true, data: this.withServerTime(room.snapshot) };
  }

  /** Người tới lượt đánh: gửi hướng, lực, xoáy -> server mô phỏng & chấm điểm */
  @SubscribeMessage('bida:shoot')
  async handleShoot(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: Record<string, unknown>,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || !this.rooms.findPlayer(room, user.userId))
      return { ok: false, error: 'Bạn không ở trong phòng' };
    const now = Date.now();
    if (now - (this.lastShotAt.get(user.userId) ?? 0) < SHOT_MIN_INTERVAL_MS)
      return { ok: false, error: 'Thao tác quá nhanh' };
    this.lastShotAt.set(user.userId, now);

    const outcome = this.rooms.shoot(room, user.userId, body ?? {});
    // Gửi lặp (mạng chập chờn / reconnect) -> xác nhận lại, không xử lý lần 2
    if ('duplicate' in outcome) return { ok: true };
    if ('error' in outcome) return { ok: false, error: outcome.error };
    const res = outcome.match;

    const last = res.lastShot;
    this.logger.log(
      `[${room.code}] ${user.name} đánh #${res.seq}: ${last?.verdict.reason} (${last?.duration.toFixed(1)}s) — tỉ số ${res.scores.join('-')}`,
    );
    this.broadcastGame(room);
    if (res.winner !== null) {
      this.clearTurnTimer(room.code);
      const winner = room.players.find(
        (p) => p.userId === res.players[res.winner ?? 0],
      );
      this.logger.log(
        `[${room.code}] ${winner?.name} thắng ${res.scores.join('-')}`,
      );
      this.broadcastRoom(room);
      void this.handleFinished(room);
    } else {
      this.scheduleTurnTimer(room);
    }
    return { ok: true };
  }

  // =====================================================
  // VOICE CHAT (WebRTC mesh — server chỉ chuyển tín hiệu)
  // =====================================================

  /** Cấu hình STUN / TURN (lấy từ biến môi trường của server, không để ở frontend) */
  @SubscribeMessage('bida:voice:config')
  async handleVoiceConfig(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<{ iceServers: ReturnType<typeof getIceServers> }>> {
    const user = await this.getUser(client);
    if (!user) return { ok: false, error: 'Bạn cần đăng nhập' };
    return { ok: true, data: { iceServers: getIceServers() } };
  }

  /** Bật voice: trả về những người đang trong voice để người mới gửi offer tới họ */
  @SubscribeMessage('bida:voice:join')
  async handleVoiceJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { muted?: boolean },
  ): Promise<AckResponse<{ peers: string[] }>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room || !this.rooms.findPlayer(room, user.userId))
      return { ok: false };
    const peers = Object.keys(room.voice).filter((id) => id !== user.userId);
    room.voice[user.userId] = { muted: !!body?.muted };
    this.broadcastVoice(room);
    return { ok: true, data: { peers } };
  }

  @SubscribeMessage('bida:voice:leave')
  async handleVoiceLeave(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    this.leaveVoice(room, user.userId);
    return { ok: true };
  }

  /** Bật / tắt mic (để mọi người thấy biểu tượng 🔇) */
  @SubscribeMessage('bida:voice:mute')
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

  /** Danh sách người đang bật voice (khi vừa vào phòng) */
  @SubscribeMessage('bida:voice:list')
  async handleVoiceList(
    @ConnectedSocket() client: Socket,
  ): Promise<AckResponse<{ users: { userId: string; muted: boolean }[] }>> {
    const user = await this.getUser(client);
    const room = user && this.rooms.getRoomOfUser(user.userId);
    if (!user || !room) return { ok: false };
    return { ok: true, data: { users: this.voiceUsers(room) } };
  }

  /** Chuyển tín hiệu WebRTC (offer / answer / ICE) tới đúng 1 người trong cùng phòng */
  @SubscribeMessage('bida:voice:signal')
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
      .emit('bida:voice:signal', { from: user.userId, data: body.data });
    return { ok: true };
  }
}
