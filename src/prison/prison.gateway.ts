import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Model } from 'mongoose';
import { Namespace, Socket } from 'socket.io';
import { User, UserDocument } from 'src/users/entities/user.entity';
import {
  AssistDto,
  BedDto,
  ContainerMoveDto,
  CraftDto,
  EquipDto,
  CreateRoomDto,
  EmptyDto,
  ChallengeAnswerDto,
  GymAnswerDto,
  GymPressDto,
  GymStartDto,
  EscapeCancelDto,
  LootStartDto,
  LootTakeDto,
  TakeOffDto,
  WearDto,
  EscapePointDto,
  EscapePrepareDto,
  EscapeReadyDto,
  GuardDto,
  HideDto,
  InteractDto,
  ItemRequestDto,
  NpcBuyDto,
  NpcDto,
  SpotDto,
  TunnelDto,
  TileDto,
  DecorPlaceDto,
  ThrowItemDto,
  InviteDto,
  ItemQuantityRequestDto,
  JoinRoomDto,
  PlayerInputDto,
  QuestContributeDto,
  QuestIdDto,
  ReadyDto,
  RequestMetaDto,
  RescueCancelDto,
  RescueStartDto,
  RoleDto,
  TargetPlayerDto,
  TradeIdDto,
  TradeRequestDto,
  UpdateSettingsDto,
  UseItemDto,
  validateDto,
  type DtoClass,
} from './dto/prison.dto';
import { PrisonPersistenceService } from './prison-persistence.service';
import {
  DEFAULT_SETTINGS,
  PrisonRoomService,
  type PrisonRoom,
  type RoomUser,
} from './prison-room.service';
import {
  PrisonSimulationService,
  type RoomSimulation,
  type SimulationHooks,
} from './prison-simulation';
import { PRISON_CONFIG as C } from './shared/config';
import { GYM } from './shared/gymStats';
import {
  ackFromResult,
  ERROR_MESSAGES,
  PRISON_NAMESPACE,
  roomChannel,
  type Ack,
  type RoomView,
} from './shared/protocol';
import type { FullState, PrivateState, TeamStorageView } from './shared/view';
import { createWorld } from './shared/world';
import { migrateWorld } from './shared/migrate';
import {
  WORLD_SCHEMA_VERSION,
  type ErrorCode,
  type PlayerAction,
  type WorldState,
} from './shared/types';

interface SocketData {
  user?: RoomUser;
  auth?: Promise<RoomUser | null>;
}

interface Bucket {
  tokens: number;
  at: number;
}

export interface JoinPayload {
  room: RoomView;
  state: FullState | null;
  private: PrivateState | null;
  teamStorage: TeamStorageView | null;
}

/** Sự kiện không bắt buộc payload: null / undefined -> {} */
const asObject = (body: unknown): unknown =>
  body === null || body === undefined || typeof body === 'function' ? {} : body;

const fail = <T = undefined>(code: ErrorCode, message?: string): Ack<T> => ({
  ok: false,
  code,
  message: message ?? ERROR_MESSAGES[code],
});

/**
 * PRISON BREAK co-op (namespace /game). Gateway chỉ lo transport: xác thực, DTO, rate limit,
 * membership, phát sự kiện. Luật chơi nằm trong engine dùng chung + RoomSimulation.
 */
@WebSocketGateway({
  namespace: PRISON_NAMESPACE,
  cors: { origin: [process.env.WEB_URL ?? ''], credentials: true },
})
export class PrisonGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server!: Namespace;

  private readonly logger = new Logger('Prison');
  private graceTimers = new Map<string, NodeJS.Timeout>();
  private inputBuckets = new Map<string, Bucket>();
  private actionBuckets = new Map<string, Bucket>();
  /** Bấm nhịp gym nhanh hơn thao tác thường: giỏ riêng */
  private gymBuckets = new Map<string, Bucket>();
  private errorNoticeAt = new Map<string, number>();
  private checkpointVersion = new Map<string, number>();
  private restoring = new Map<string, Promise<PrisonRoom | null>>();
  private userSockets = new Map<string, Set<string>>();
  /** Có thể chỉnh trong test */
  graceMs = C.reconnect.graceSeconds * 1000;
  lobbyGraceMs = C.reconnect.lobbyGraceSeconds * 1000;

  constructor(
    private readonly rooms: PrisonRoomService,
    private readonly sims: PrisonSimulationService,
    private readonly persistence: PrisonPersistenceService,
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  onModuleDestroy(): void {
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
  }

  // ===================================================== XÁC THỰC
  private getUser(client: Socket): Promise<RoomUser | null> {
    const data = client.data as SocketData;
    if (data.user) return Promise.resolve(data.user);
    data.auth ??= this.authenticate(client).then((u) => {
      if (u) data.user = u;
      return u;
    });
    return data.auth;
  }

  private async authenticate(client: Socket): Promise<RoomUser | null> {
    const auth = client.handshake.auth as { token?: unknown };
    if (typeof auth?.token !== 'string' || !auth.token) return null;
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
      return { userId: String(user._id), name: user.name, avatar: user.avatar };
    } catch {
      return null;
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    const user = await this.getUser(client);
    if (!user) {
      client.emit('game:error', fail('UNAUTHORIZED'));
      client.disconnect(true);
      return;
    }
    let set = this.userSockets.get(user.userId);
    if (!set) this.userSockets.set(user.userId, (set = new Set()));
    set.add(client.id);
  }

  // ===================================================== TIỆN ÍCH
  private take(
    map: Map<string, Bucket>,
    key: string,
    perSecond: number,
  ): boolean {
    const now = Date.now();
    const b = map.get(key) ?? { tokens: perSecond, at: now };
    b.tokens = Math.min(
      perSecond,
      b.tokens + ((now - b.at) / 1000) * perSecond,
    );
    b.at = now;
    map.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private softError(client: Socket, code: ErrorCode): void {
    const now = Date.now();
    if (now - (this.errorNoticeAt.get(client.id) ?? 0) < 2000) return;
    this.errorNoticeAt.set(client.id, now);
    client.emit('game:error', fail(code));
  }

  private broadcastRoom(room: PrisonRoom): void {
    this.server
      .to(roomChannel(room.roomCode))
      .emit('room:updated', this.rooms.toView(room));
  }

  private toSocket(room: PrisonRoom, userId: string): string | null {
    return this.rooms.member(room, userId)?.socketId ?? null;
  }

  private joinPayload(room: PrisonRoom, userId: string): JoinPayload {
    const sim = this.sims.get(room.roomCode);
    return {
      room: this.rooms.toView(room),
      state: sim ? sim.fullState() : null,
      private: sim ? sim.privateOf(userId) : null,
      teamStorage: sim ? sim.fullState().teamStorage : null,
    };
  }

  private clearGrace(userId: string): void {
    const t = this.graceTimers.get(userId);
    if (t) clearTimeout(t);
    this.graceTimers.delete(userId);
  }

  private checkpoint(
    room: PrisonRoom,
    world: WorldState,
    status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED',
  ): void {
    if (!room.sessionId) return;
    const v = (this.checkpointVersion.get(room.roomCode) ?? 0) + 1;
    this.checkpointVersion.set(room.roomCode, v);
    // Sao chép đồng bộ (nhỏ), ghi DB bất đồng bộ ngoài vòng tick
    const copy = structuredClone(world);
    const st =
      status ??
      (world.outcome
        ? 'COMPLETED'
        : room.status === 'PAUSED'
          ? 'PAUSED'
          : 'ACTIVE');
    void this.persistence.saveCheckpoint(room.sessionId, v, copy, st);
  }

  private hooks(room: PrisonRoom): SimulationHooks {
    const ch = () => this.server.to(roomChannel(room.roomCode));
    return {
      snapshot: (s) => ch().emit('game:snapshot', s),
      events: (events) => {
        for (const ev of events) {
          const payload = {
            id: ev.id,
            type: ev.type,
            playerId: ev.playerId,
            targetId: ev.targetId,
            text: ev.text,
            data: ev.data,
          };
          // Đề nghị giao dịch chỉ gửi cho hai bên; còn lại gửi cả đội
          if (ev.type === 'player:trade-offer') {
            for (const uid of [ev.playerId, ev.targetId]) {
              const sid = uid && this.toSocket(room, uid);
              if (sid) this.server.to(sid).emit(ev.type, payload);
            }
          } else ch().emit(ev.type, payload);
        }
        this.persistence.queueEvents(room.sessionId, events);
      },
      privateState: (pid, s) => {
        const sid = this.toSocket(room, pid);
        if (sid) this.server.to(sid).emit('inventory:updated', s);
      },
      teamStorage: (s) => ch().emit('team-storage:updated', s),
      meta: (m) => ch().emit('game:meta', m),
      checkpoint: (world) => this.checkpoint(room, world),
      outcome: (world) => {
        this.rooms.setStatus(room, 'COMPLETED');
        this.checkpoint(room, world, 'COMPLETED');
        this.broadcastRoom(room);
      },
      fatal: (e) => {
        this.logger.error(`Phòng ${room.roomCode} lỗi mô phỏng: ${String(e)}`);
        this.rooms.setStatus(room, 'PAUSED');
        ch().emit(
          'game:error',
          fail('CONFLICT', 'Lỗi máy chủ — trận tạm dừng'),
        );
        this.broadcastRoom(room);
      },
    };
  }

  // ===================================================== VÒNG ĐỜI KẾT NỐI
  handleDisconnect(client: Socket): void {
    this.inputBuckets.delete(client.id);
    this.actionBuckets.delete(client.id);
    this.gymBuckets.delete(client.id);
    this.errorNoticeAt.delete(client.id);
    const user = (client.data as SocketData).user;
    if (!user) return;
    this.userSockets.get(user.userId)?.delete(client.id);
    const room = this.rooms.roomOf(user.userId);
    const m = room && this.rooms.member(room, user.userId);
    // Socket cũ (đã bị phiên mới thay thế) ngắt -> bỏ qua
    if (!room || !m || m.socketId !== client.id) return;
    this.rooms.setConnected(user.userId, null, false);
    const sim = this.sims.get(room.roomCode);
    const inGame = room.status === 'PLAYING' || room.status === 'PAUSED';
    if (inGame && sim) {
      sim.setConnected(user.userId, false);
      this.server.to(roomChannel(room.roomCode)).emit('player:disconnected', {
        userId: user.userId,
        graceSeconds: Math.round(this.graceMs / 1000),
      });
      if (room.hostId === user.userId && this.rooms.transferHost(room))
        this.server
          .to(roomChannel(room.roomCode))
          .emit('room:host-changed', { hostId: room.hostId });
      if (!room.members.some((x) => x.connected)) {
        sim.pause();
        this.rooms.setStatus(room, 'PAUSED');
        this.checkpoint(room, sim.world, 'PAUSED');
      }
    }
    this.broadcastRoom(room);
    const grace = inGame ? this.graceMs : this.lobbyGraceMs;
    this.clearGrace(user.userId);
    this.graceTimers.set(
      user.userId,
      setTimeout(() => {
        this.graceTimers.delete(user.userId);
        const cur = this.rooms.roomOf(user.userId);
        const mm = cur && this.rooms.member(cur, user.userId);
        if (cur && mm && !mm.connected)
          this.leaveInternal(
            user.userId,
            `mất kết nối quá ${Math.round(grace / 1000)} giây`,
          );
      }, grace),
    );
  }

  private leaveInternal(userId: string, reason: string): void {
    const room = this.rooms.roomOf(userId);
    if (!room) return;
    const code = room.roomCode;
    const sim = this.sims.get(code);
    const sid = this.toSocket(room, userId);
    if (sim && sim.world.players[userId]) sim.removePlayer(userId, reason);
    if (sid) this.server.in(sid).socketsLeave(roomChannel(code));
    this.clearGrace(userId);
    const res = this.rooms.leave(userId);
    if (!res) return;
    if (res.closed) {
      if (sim) {
        this.checkpoint(
          room,
          sim.world,
          sim.world.outcome ? 'COMPLETED' : 'ABANDONED',
        );
        this.sims.destroy(code);
      }
      this.checkpointVersion.delete(code);
      this.server.to(roomChannel(code)).emit('room:closed', { roomCode: code });
      return;
    }
    this.server
      .to(roomChannel(code))
      .emit('room:player-left', { userId, reason });
    if (res.hostChanged)
      this.server
        .to(roomChannel(code))
        .emit('room:host-changed', { hostId: room.hostId });
    if (
      sim &&
      room.status === 'PLAYING' &&
      !room.members.some((m) => m.connected)
    ) {
      sim.pause();
      this.rooms.setStatus(room, 'PAUSED');
    }
    this.broadcastRoom(room);
  }

  /** Khôi phục phòng đang chơi dở từ checkpoint (sau khi server khởi động lại) */
  private restoreRoom(
    code: string,
    user: RoomUser,
  ): Promise<PrisonRoom | null> {
    const pending = this.restoring.get(code);
    if (pending) return pending;
    const job = (async () => {
      const doc = await this.persistence.findResumable(code, user.userId);
      const existing = this.rooms.get(code);
      if (existing) return existing;
      // checkpoint cấu trúc cũ: nâng cấp nếu được (vd. áo + quần -> bộ đồ), không thì bỏ
      if (!doc?.world) return null;
      const world =
        doc.world.schemaVersion === WORLD_SCHEMA_VERSION
          ? doc.world
          : migrateWorld(doc.world);
      if (!world) return null;
      for (const p of Object.values(world.players)) p.connected = false;
      const memberIds = Object.keys(world.players);
      const members = doc.members.filter((m) => memberIds.includes(m.userId));
      if (!members.length) return null;
      const now = Date.now();
      const room: PrisonRoom = {
        roomCode: code,
        hostId: members.some((m) => m.userId === doc.hostId)
          ? doc.hostId
          : members[0].userId,
        status: 'PAUSED',
        settings: { ...DEFAULT_SETTINGS, difficulty: world.difficulty },
        members: members.map((m, i) => ({
          userId: m.userId,
          name: m.name,
          role: world.players[m.userId].role,
          ready: true,
          connected: false,
          socketId: null,
          joinedAt: now + i,
        })),
        createdAt: now,
        updatedAt: now,
        sessionId: String(doc._id),
      };
      this.rooms.restore(room);
      this.checkpointVersion.set(code, doc.checkpointVersion);
      const sim = this.sims.create(code, world, this.hooks(room));
      sim.pause();
      sim.start();
      for (const m of room.members)
        if (m.userId !== user.userId)
          this.graceTimers.set(
            m.userId,
            setTimeout(() => {
              this.graceTimers.delete(m.userId);
              const mm = this.rooms.member(room, m.userId);
              if (mm && !mm.connected)
                this.leaveInternal(
                  m.userId,
                  'không quay lại sau khi máy chủ khởi động lại',
                );
            }, this.graceMs),
          );
      this.logger.log(
        `Khôi phục phòng ${code} từ checkpoint v${doc.checkpointVersion}`,
      );
      return room;
    })().finally(() => this.restoring.delete(code));
    this.restoring.set(code, job);
    return job;
  }

  // ===================================================== PHÒNG CHỜ
  @SubscribeMessage('room:list')
  async handleList(
    @ConnectedSocket() client: Socket,
  ): Promise<Ack<RoomView[]>> {
    if (!(await this.getUser(client))) return fail('UNAUTHORIZED');
    return { ok: true, data: this.rooms.listPublic() };
  }

  @SubscribeMessage('room:mine')
  async handleMine(
    @ConnectedSocket() client: Socket,
  ): Promise<Ack<RoomView | null>> {
    const user = await this.getUser(client);
    if (!user) return fail('UNAUTHORIZED');
    const room = this.rooms.roomOf(user.userId);
    return { ok: true, data: room ? this.rooms.toView(room) : null };
  }

  @SubscribeMessage('room:create')
  async handleCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack<JoinPayload>> {
    const user = await this.getUser(client);
    if (!user) return fail('UNAUTHORIZED');
    if (!this.take(this.actionBuckets, client.id, C.net.actionMaxPerSecond))
      return fail('RATE_LIMITED');
    const v = validateDto(CreateRoomDto, asObject(body));
    if (!v.ok) return fail('INVALID_PAYLOAD', v.errors.join(', '));
    if (this.rooms.roomOf(user.userId))
      this.leaveInternal(user.userId, 'đã rời phòng');
    const res = this.rooms.create(user, client.id, {
      ...(v.value.settings ?? {}),
    });
    if (!res.ok) return fail(res.code, res.message);
    await client.join(roomChannel(res.value.roomCode));
    client.emit('room:created', this.rooms.toView(res.value));
    return { ok: true, data: this.joinPayload(res.value, user.userId) };
  }

  /** Vào phòng bằng mã. Thành viên cũ gọi lại = kết nối lại (khôi phục trạng thái + snapshot). */
  @SubscribeMessage('room:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack<JoinPayload>> {
    const user = await this.getUser(client);
    if (!user) return fail('UNAUTHORIZED');
    if (!this.take(this.actionBuckets, client.id, C.net.actionMaxPerSecond))
      return fail('RATE_LIMITED');
    const v = validateDto(JoinRoomDto, {
      roomCode: this.rooms.normalizeCode(
        (body as { roomCode?: unknown })?.roomCode,
      ),
    });
    if (!v.ok) return fail('INVALID_PAYLOAD');
    const code = v.value.roomCode;
    const room = this.rooms.get(code) ?? (await this.restoreRoom(code, user));
    if (!room) return fail('ROOM_NOT_FOUND');
    const other = this.rooms.roomOf(user.userId);
    if (other && other !== room)
      this.leaveInternal(user.userId, 'đã rời phòng');
    const prevSocket = this.toSocket(room, user.userId);
    const res = this.rooms.join(user, client.id, code);
    if (!res.ok) return fail(res.code, res.message);
    this.clearGrace(user.userId);
    if (prevSocket && prevSocket !== client.id)
      this.server.in(prevSocket).socketsLeave(roomChannel(code));
    await client.join(roomChannel(code));
    const sim = this.sims.get(code);
    if (sim) {
      if (res.value.lateJoin) {
        const m = this.rooms.member(room, user.userId)!;
        if (
          !sim.addPlayer({ id: user.userId, name: user.name, role: m.role })
        ) {
          this.rooms.leave(user.userId);
          return fail('ROOM_FULL');
        }
      } else if (sim.world.players[user.userId])
        sim.setConnected(user.userId, true);
      if (room.status === 'PAUSED' && sim.paused) {
        sim.resume();
        this.rooms.setStatus(room, 'PLAYING');
        this.server
          .to(roomChannel(code))
          .emit('game:resumed', { roomCode: code });
      }
      this.server
        .to(roomChannel(code))
        .emit('player:reconnected', { userId: user.userId });
    }
    if (!res.value.rejoined)
      this.server
        .to(roomChannel(code))
        .emit('room:player-joined', { userId: user.userId, name: user.name });
    this.broadcastRoom(room);
    return { ok: true, data: this.joinPayload(room, user.userId) };
  }

  @SubscribeMessage('room:leave')
  async handleLeave(@ConnectedSocket() client: Socket): Promise<Ack> {
    const user = await this.getUser(client);
    if (!user) return fail('UNAUTHORIZED');
    if (!this.rooms.roomOf(user.userId)) return fail('NOT_ROOM_MEMBER');
    this.leaveInternal(user.userId, 'đã rời phòng');
    return { ok: true };
  }

  private async lobbyOp(
    client: Socket,
    op: (
      userId: string,
    ) =>
      | { ok: true; value: PrisonRoom }
      | { ok: false; code: ErrorCode; message: string },
  ): Promise<Ack<RoomView>> {
    const user = await this.getUser(client);
    if (!user) return fail('UNAUTHORIZED');
    if (!this.take(this.actionBuckets, client.id, C.net.actionMaxPerSecond))
      return fail('RATE_LIMITED');
    const res = op(user.userId);
    if (!res.ok) return fail(res.code, res.message);
    this.broadcastRoom(res.value);
    return { ok: true, data: this.rooms.toView(res.value) };
  }

  @SubscribeMessage('room:ready')
  handleReady(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const v = validateDto(ReadyDto, body);
    if (!v.ok) return fail('INVALID_PAYLOAD');
    return this.lobbyOp(client, (uid) => {
      const r = this.rooms.setReady(uid, v.value.ready);
      if (r.ok)
        this.server
          .to(roomChannel(r.value.roomCode))
          .emit('room:player-ready', { userId: uid, ready: v.value.ready });
      return r;
    });
  }

  @SubscribeMessage('room:role')
  handleRole(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const v = validateDto(RoleDto, body);
    if (!v.ok) return fail('INVALID_PAYLOAD');
    return this.lobbyOp(client, (uid) => this.rooms.setRole(uid, v.value.role));
  }

  @SubscribeMessage('room:update-settings')
  handleSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    const v = validateDto(UpdateSettingsDto, body);
    if (!v.ok) return fail('INVALID_PAYLOAD', v.errors.join(', '));
    return this.lobbyOp(client, (uid) => {
      const r = this.rooms.updateSettings(uid, { ...v.value.settings });
      if (r.ok)
        this.server
          .to(roomChannel(r.value.roomCode))
          .emit('room:settings-updated', r.value.settings);
      return r;
    });
  }

  @SubscribeMessage('room:invite')
  async handleInvite(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const user = await this.getUser(client);
    if (!user) return fail('UNAUTHORIZED');
    if (!this.take(this.actionBuckets, client.id, 2))
      return fail('RATE_LIMITED');
    const v = validateDto(InviteDto, body);
    if (!v.ok) return fail('INVALID_PAYLOAD');
    const room = this.rooms.roomOf(user.userId);
    if (!room) return fail('NOT_ROOM_MEMBER');
    const targets = this.userSockets.get(v.value.targetUserId);
    if (!targets?.size) return fail('NOT_FOUND', 'Người này không trực tuyến');
    for (const sid of targets)
      this.server.to(sid).emit('room:invite-received', {
        roomCode: room.roomCode,
        from: user.name,
      });
    return { ok: true };
  }

  @SubscribeMessage('room:start')
  async handleStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack<JoinPayload>> {
    const user = await this.getUser(client);
    if (!user) return fail('UNAUTHORIZED');
    if (!validateDto(EmptyDto, asObject(body)).ok)
      return fail('INVALID_PAYLOAD');
    const room = this.rooms.roomOf(user.userId);
    if (!room) return fail('NOT_ROOM_MEMBER');
    const check = this.rooms.startCheck(room, user.userId);
    if (!check.ok) return fail(check.code, check.message);
    // Khoá trạng thái đồng bộ trước mọi await -> chặn start hai lần
    this.rooms.setStatus(room, 'STARTING');
    this.broadcastRoom(room);
    let sim: RoomSimulation;
    try {
      const world = createWorld({
        seed: Math.floor(Math.random() * 2 ** 31),
        difficulty: room.settings.difficulty,
        mode: 'multi',
        players: room.members.map((m) => ({
          id: m.userId,
          name: m.name,
          role: m.role,
        })),
      });
      sim = this.sims.create(room.roomCode, world, this.hooks(room));
    } catch (e) {
      this.rooms.setStatus(room, 'WAITING');
      this.broadcastRoom(room);
      this.logger.error(String(e));
      return fail('CONFLICT', 'Không thể khởi tạo trận');
    }
    room.sessionId = await this.persistence.createSession({
      roomCode: room.roomCode,
      hostId: room.hostId,
      members: room.members.map((m) => ({
        userId: m.userId,
        name: m.name,
        role: m.role,
      })),
      world: sim.world,
    });
    if (this.rooms.get(room.roomCode) !== room) {
      // phòng bị đóng trong lúc chờ DB
      this.sims.destroy(room.roomCode);
      return fail('ROOM_NOT_FOUND');
    }
    this.rooms.setStatus(room, 'PLAYING');
    sim.start();
    this.broadcastRoom(room);
    for (const m of room.members)
      if (m.socketId)
        this.server
          .to(m.socketId)
          .emit('game:started', this.joinPayload(room, m.userId));
    this.checkpoint(room, sim.world);
    return { ok: true, data: this.joinPayload(room, user.userId) };
  }

  // ===================================================== TRONG TRẬN
  private activeSim(
    client: Socket,
    userId: string,
  ): { room: PrisonRoom; sim: RoomSimulation } | ErrorCode {
    const room = this.rooms.roomOf(userId);
    if (!room) return 'NOT_ROOM_MEMBER';
    const m = this.rooms.member(room, userId);
    if (!m || m.socketId !== client.id) return 'FORBIDDEN';
    const sim = this.sims.get(room.roomCode);
    if (!sim || !sim.world.players[userId]) return 'NOT_ROOM_MEMBER';
    if (room.status !== 'PLAYING') return 'INVALID_STATE';
    return { room, sim };
  }

  @SubscribeMessage('player:input')
  async handleInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const user = await this.getUser(client);
    if (!user) return this.softError(client, 'UNAUTHORIZED');
    if (!this.take(this.inputBuckets, client.id, C.net.inputMaxPerSecond))
      return this.softError(client, 'RATE_LIMITED');
    const v = validateDto(PlayerInputDto, body);
    if (!v.ok) return this.softError(client, 'INVALID_PAYLOAD');
    const ctx = this.activeSim(client, user.userId);
    if (typeof ctx === 'string') return;
    ctx.sim.enqueueInput(user.userId, {
      sequence: v.value.sequence,
      directionX: v.value.directionX,
      directionY: v.value.directionY,
      sprint: v.value.sprint,
    });
  }

  @SubscribeMessage('game:state')
  async handleState(
    @ConnectedSocket() client: Socket,
  ): Promise<Ack<JoinPayload>> {
    const user = await this.getUser(client);
    if (!user) return fail('UNAUTHORIZED');
    const room = this.rooms.roomOf(user.userId);
    if (!room) return fail('NOT_ROOM_MEMBER');
    return { ok: true, data: this.joinPayload(room, user.userId) };
  }

  @SubscribeMessage('game:ping')
  handlePing(): Ack<{ serverTime: number }> {
    return { ok: true, data: { serverTime: Date.now() } };
  }

  private async act<T extends RequestMetaDto>(
    client: Socket,
    cls: DtoClass<T>,
    body: unknown,
    toAction: (dto: T) => PlayerAction,
    limit: { map: Map<string, Bucket>; perSecond: number } = {
      map: this.actionBuckets,
      perSecond: C.net.actionMaxPerSecond,
    },
  ): Promise<Ack<Record<string, string | number | boolean>>> {
    const user = await this.getUser(client);
    if (!user) return fail('UNAUTHORIZED');
    if (!this.take(limit.map, client.id, limit.perSecond))
      return fail('RATE_LIMITED');
    const v = validateDto(cls, body);
    if (!v.ok) return fail('INVALID_PAYLOAD', v.errors.join(', '));
    const ctx = this.activeSim(client, user.userId);
    if (typeof ctx === 'string') return fail(ctx);
    const res = ctx.sim.action(
      user.userId,
      toAction(v.value),
      v.value.requestId,
    );
    return ackFromResult(res, v.value.requestId);
  }

  @SubscribeMessage('player:interact')
  interact(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, InteractDto, b, (d) => ({
      type: 'interact',
      targetId: d.targetId,
    }));
  }
  @SubscribeMessage('player:cancel')
  cancel(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'cancelChannel' }));
  }
  @SubscribeMessage('player:use-item')
  useItem(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, UseItemDto, b, (d) => ({
      type: 'useItem',
      itemId: d.itemId,
    }));
  }
  @SubscribeMessage('player:drop-item')
  dropItem(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, ItemQuantityRequestDto, b, (d) => ({
      type: 'dropItem',
      itemId: d.itemId,
      quantity: d.quantity,
    }));
  }
  @SubscribeMessage('player:throw-item')
  throwItem(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, ThrowItemDto, b, (d) => ({
      type: 'throwItem',
      itemId: d.itemId,
      dirX: d.dirX,
      dirY: d.dirY,
    }));
  }
  @SubscribeMessage('player:pickup-all')
  pickupAll(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'pickupAll' }));
  }
  @SubscribeMessage('player:assist')
  assist(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, AssistDto, b, (d) => ({
      type: 'assist',
      assistType: d.assistType,
    }));
  }
  @SubscribeMessage('player:revive')
  revive(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, TargetPlayerDto, b, (d) => ({
      type: 'revive',
      targetPlayerId: d.targetPlayerId,
    }));
  }
  @SubscribeMessage('crafting:craft')
  craft(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, CraftDto, b, (d) => ({
      type: 'craft',
      recipeId: d.recipeId,
      quantity: d.quantity ?? 1,
    }));
  }
  @SubscribeMessage('team-storage:deposit')
  deposit(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, ItemQuantityRequestDto, b, (d) => ({
      type: 'deposit',
      itemId: d.itemId,
      quantity: d.quantity,
    }));
  }
  @SubscribeMessage('team-storage:withdraw')
  withdraw(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, ItemQuantityRequestDto, b, (d) => ({
      type: 'withdraw',
      itemId: d.itemId,
      quantity: d.quantity,
    }));
  }
  @SubscribeMessage('player:trade-request')
  tradeRequest(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, TradeRequestDto, b, (d) => ({
      type: 'tradeRequest',
      targetPlayerId: d.targetPlayerId,
      offered: d.offeredItems.map((x) => ({
        itemId: x.itemId,
        quantity: x.quantity,
      })),
      requested: (d.requestedItems ?? []).map((x) => ({
        itemId: x.itemId,
        quantity: x.quantity,
      })),
    }));
  }
  @SubscribeMessage('player:trade-accept')
  tradeAccept(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, TradeIdDto, b, (d) => ({
      type: 'tradeAccept',
      tradeId: d.tradeId,
    }));
  }
  @SubscribeMessage('player:trade-decline')
  tradeDecline(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, TradeIdDto, b, (d) => ({
      type: 'tradeDecline',
      tradeId: d.tradeId,
    }));
  }
  @SubscribeMessage('quest:accept')
  questAccept(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, QuestIdDto, b, (d) => ({
      type: 'questAccept',
      questId: d.questId,
    }));
  }
  @SubscribeMessage('quest:complete')
  questComplete(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, QuestIdDto, b, (d) => ({
      type: 'questComplete',
      questId: d.questId,
    }));
  }
  @SubscribeMessage('quest:abandon')
  questAbandon(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, QuestIdDto, b, (d) => ({
      type: 'questAbandon',
      questId: d.questId,
    }));
  }
  @SubscribeMessage('quest:contribute')
  questContribute(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, QuestContributeDto, b, (d) => ({
      type: 'questContribute',
      questId: d.questId,
      objectiveId: d.objectiveId,
      quantity: d.contribution,
    }));
  }
  @SubscribeMessage('rescue:start')
  rescueStart(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RescueStartDto, b, (d) => ({
      type: 'rescueStart',
      targetPlayerId: d.targetPlayerId,
      rescuePointId: d.rescuePointId,
    }));
  }
  @SubscribeMessage('rescue:cancel')
  rescueCancel(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RescueCancelDto, b, () => ({ type: 'rescueCancel' }));
  }
  @SubscribeMessage('escape:prepare')
  escapePrepare(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, EscapePrepareDto, b, (d) => ({
      type: 'escapePrepare',
      escapeMethod: d.escapeMethod,
    }));
  }
  @SubscribeMessage('escape:ready')
  escapeReady(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, EscapeReadyDto, b, (d) => ({
      type: 'escapeReady',
      ready: d.ready,
    }));
  }
  @SubscribeMessage('escape:start')
  escapeStart(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'escapeStart' }));
  }
  @SubscribeMessage('escape:enter-point')
  escapeEnter(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, EscapePointDto, b, (d) => ({
      type: 'escapeEnterPoint',
      escapePointId: d.escapePointId,
    }));
  }
  @SubscribeMessage('escape:cancel')
  escapeCancel(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, EscapeCancelDto, b, () => ({ type: 'escapeCancel' }));
  }

  @SubscribeMessage('combat:attack')
  attack(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'attack' }));
  }
  @SubscribeMessage('npc:report')
  reportNpc(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, NpcDto, b, (d) => ({ type: 'report', npcId: d.npcId }));
  }
  @SubscribeMessage('rollcall:answer')
  answerRollcall(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'answerRollcall' }));
  }
  @SubscribeMessage('combat:equip')
  equip(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, EquipDto, b, (d) => ({
      type: 'equip',
      itemId: d.itemId ?? null,
    }));
  }
  @SubscribeMessage('loot:start')
  lootStart(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, LootStartDto, b, (d) => ({
      type: 'lootStart',
      targetId: d.targetId,
    }));
  }
  @SubscribeMessage('loot:take')
  lootTake(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, LootTakeDto, b, (d) => ({
      type: 'lootTake',
      targetId: d.targetId,
      slot: d.slot,
      index: d.index,
    }));
  }
  @SubscribeMessage('loot:close')
  lootClose(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'lootClose' }));
  }
  @SubscribeMessage('gear:wear')
  wear(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, WearDto, b, (d) => ({ type: 'wear', index: d.index }));
  }
  @SubscribeMessage('gear:take-off')
  takeOff(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, TakeOffDto, b, (d) => ({
      type: 'takeOff',
      slot: d.slot,
    }));
  }
  @SubscribeMessage('gear:drop-weapon')
  dropWeapon(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'dropWeapon' }));
  }
  @SubscribeMessage('disguise:answer')
  answerChallenge(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, ChallengeAnswerDto, b, (d) => ({
      type: 'answerChallenge',
      choice: d.choice,
    }));
  }
  @SubscribeMessage('gym:start')
  gymStart(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, GymStartDto, b, (d) => ({
      type: 'gymStart',
      machineId: d.machineId,
    }));
  }
  @SubscribeMessage('gym:press')
  gymPress(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(
      c,
      GymPressDto,
      b,
      (d) => ({ type: 'gymPress', side: d.side }),
      { map: this.gymBuckets, perSecond: GYM.net.pressMaxPerSecond },
    );
  }
  @SubscribeMessage('gym:stop')
  gymStop(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'gymStop' }));
  }
  @SubscribeMessage('gym:answer')
  gymAnswer(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, GymAnswerDto, b, (d) => ({
      type: 'gymAnswer',
      yield: d.yield,
    }));
  }
  @SubscribeMessage('container:take')
  containerTake(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, ContainerMoveDto, b, (d) => ({
      type: 'containerTake',
      containerId: d.containerId,
      index: d.index,
      itemId: d.itemId,
      quantity: d.quantity,
    }));
  }
  @SubscribeMessage('container:put')
  containerPut(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, ContainerMoveDto, b, (d) => ({
      type: 'containerPut',
      containerId: d.containerId,
      index: d.index,
      itemId: d.itemId,
      quantity: d.quantity,
    }));
  }
  @SubscribeMessage('bed:take')
  bedTake(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, BedDto, b, (d) => ({
      type: 'bedTake',
      bedId: d.bedId,
      what: d.what,
    }));
  }
  @SubscribeMessage('bed:place')
  bedPlace(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, BedDto, b, (d) => ({
      type: 'bedPlace',
      bedId: d.bedId,
      what: d.what,
    }));
  }
  @SubscribeMessage('player:hide')
  hide(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, HideDto, b, (d) => ({
      type: 'hide',
      spotId: d.spotId,
      itemId: d.itemId,
      quantity: d.quantity,
    }));
  }
  @SubscribeMessage('player:retrieve')
  retrieve(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, HideDto, b, (d) => ({
      type: 'retrieve',
      spotId: d.spotId,
      itemId: d.itemId,
      quantity: d.quantity,
    }));
  }
  @SubscribeMessage('player:flush')
  flush(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, SpotDto, b, (d) => ({
      type: 'flush',
      spotId: d.spotId,
    }));
  }
  @SubscribeMessage('tunnel:action')
  tunnel(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, TunnelDto, b, (d) => ({
      type: 'tunnel',
      cellIndex: d.cellIndex,
      op: d.op,
    }));
  }
  @SubscribeMessage('player:wake')
  wake(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'wake' }));
  }
  @SubscribeMessage('dig:tile')
  digTile(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, TileDto, b, (d) => ({ type: 'dig', x: d.x, y: d.y }));
  }
  @SubscribeMessage('dig:hatch')
  digHatch(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, RequestMetaDto, b, () => ({ type: 'hatch' }));
  }
  @SubscribeMessage('decor:place')
  decorPlace(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, DecorPlaceDto, b, (d) => ({
      type: 'placeDecor',
      itemId: d.itemId,
      x: d.x,
      y: d.y,
    }));
  }
  @SubscribeMessage('decor:take')
  decorTake(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, TileDto, b, (d) => ({
      type: 'takeDecor',
      x: d.x,
      y: d.y,
    }));
  }
  @SubscribeMessage('shop:buy')
  shopBuy(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, ItemRequestDto, b, (d) => ({
      type: 'buy',
      itemId: d.itemId,
    }));
  }
  @SubscribeMessage('shop:sell')
  shopSell(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, ItemRequestDto, b, (d) => ({
      type: 'sell',
      itemId: d.itemId,
    }));
  }
  @SubscribeMessage('npc:talk')
  npcTalk(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, NpcDto, b, (d) => ({ type: 'npcTalk', npcId: d.npcId }));
  }
  @SubscribeMessage('npc:buy')
  npcBuy(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, NpcBuyDto, b, (d) => ({
      type: 'npcBuy',
      npcId: d.npcId,
      itemId: d.itemId,
    }));
  }
  @SubscribeMessage('guard:reclaim')
  reclaimConfiscated(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, GuardDto, b, (d) => ({
      type: 'reclaimConfiscated',
      guardId: d.guardId,
    }));
  }
  @SubscribeMessage('guard:bribe')
  bribe(@ConnectedSocket() c: Socket, @MessageBody() b: unknown) {
    return this.act(c, GuardDto, b, (d) => ({
      type: 'bribe',
      guardId: d.guardId,
    }));
  }

  /** Số liệu vận hành (rooms, sockets, tick, ghi DB) */
  metrics() {
    return {
      ...this.sims.stats(),
      sockets: this.server?.sockets?.size ?? 0,
      lobbies: this.rooms.all().length,
      dbWrites: this.persistence.writes,
    };
  }
}
