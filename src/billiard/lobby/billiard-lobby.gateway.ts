/**
 * Sảnh Bida Carom: presence, ghép trận (Quick / Ranked), hồ sơ, bảng xếp hạng, lịch sử, giải đấu.
 * Dùng chung kết nối Socket.IO hiện có (namespace mặc định, tiền tố `bida:`).
 * Mọi payload qua DTO; rating / kết quả chỉ server tính.
 */
import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { BilliardGateway, type SocketUser } from '../billiard.gateway';
import { BilliardRoomService } from '../billiard-room.service';
import type { AckResponse } from '../billiard.types';
import {
  DisciplineDto,
  HistoryDto,
  LeaderboardDto,
  MatchmakingJoinDto,
  PendingDto,
  ProfileDto,
  TournamentCreateDto,
  TournamentIdDto,
  TournamentInviteDto,
  TournamentJoinDto,
  TournamentListDto,
  validateDto,
  type DtoClass,
} from './dto/lobby.dto';
import {
  BilliardEventsService,
  LOBBY_ROOM,
  tournamentRoomKey,
  userRoomKey,
} from './events.service';
import { MatchmakingQueue, type PendingMatch } from './matchmaking-queue';
import {
  DEFAULT_MATCH_TARGET,
  makeRuleSet,
  MODE_NAMES,
  RANKING_CONFIG as R,
  RULE_SETS,
} from './ranking.config';
import { DISCIPLINES, type Discipline } from './store.types';
import { levelOf, rankOf, searchRange } from './ranking';
import { BilliardRankingService, disciplineOf } from './ranking.service';
import {
  BilliardTournamentService,
  tournamentView,
} from './tournament.service';

type Ack<T = unknown> = AckResponse<T>;
const fail = (error: string): Ack<never> => ({ ok: false, error });

@WebSocketGateway({
  cors: { origin: [process.env.WEB_URL ?? ''], credentials: true },
})
export class BilliardLobbyGateway
  implements OnGatewayInit, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('BilliardLobby');
  readonly queue = new MatchmakingQueue('mm');
  private timers: NodeJS.Timeout[] = [];
  private dropTimers = new Map<string, NodeJS.Timeout>();
  private rate = new Map<string, number>();
  private queueNames = new Map<string, { name: string; avatar?: string }>();

  constructor(
    private readonly game: BilliardGateway,
    private readonly rooms: BilliardRoomService,
    private readonly ranking: BilliardRankingService,
    private readonly tournaments: BilliardTournamentService,
    private readonly events: BilliardEventsService,
  ) {}

  afterInit(server: Server) {
    this.events.attach(server);
    this.game.matchmakingBusy = (id) => this.matchmakingBusy(id);
    this.timers.push(setInterval(() => this.matchmakingTick(), 1000));
    this.timers.push(setInterval(() => void this.tournamentTick(), 5000));
    this.timers.push(setInterval(() => void this.broadcastSummary(), 10000));
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
    this.dropTimers.forEach(clearTimeout);
  }

  // ===================================================== HELPERS
  private async auth(client: Socket): Promise<SocketUser | null> {
    const u = await this.game.authUser(client);
    if (u) await client.join(userRoomKey(u.userId));
    return u;
  }

  /** Đang tìm trận / chờ xác nhận -> không được tạo phòng riêng hay giải đấu */
  matchmakingBusy(userId: string): string | null {
    if (this.queue.isQueued(userId) || this.queue.pendingFor(userId))
      return 'Bạn đang tìm trận, hãy huỷ tìm trận trước';
    return null;
  }

  /** Chống spam theo người + sự kiện */
  private limited(userId: string, key: string, ms: number): boolean {
    const k = `${userId}:${key}`;
    const now = Date.now();
    if (now - (this.rate.get(k) ?? 0) < ms) return true;
    this.rate.set(k, now);
    if (this.rate.size > 5000) this.rate.clear();
    return false;
  }

  private async withUser<D extends object>(
    client: Socket,
    cls: DtoClass<D> | null,
    body: unknown,
    fn: (u: SocketUser, dto: D) => Promise<Ack<unknown>> | Ack<unknown>,
  ): Promise<Ack<unknown>> {
    const u = await this.auth(client);
    if (!u) return fail('Bạn cần đăng nhập');
    let dto = {} as D;
    if (cls) {
      const v = validateDto(cls, body);
      if (!v.ok) return fail(v.error);
      dto = v.value;
    }
    try {
      return await fn(u, dto);
    } catch (e) {
      this.logger.error(`Lỗi xử lý: ${(e as Error).message}`);
      return fail('Máy chủ đang bận, vui lòng thử lại');
    }
  }

  // ===================================================== PRESENCE / CẤU HÌNH
  @SubscribeMessage('bida:lobby:enter')
  enter(@ConnectedSocket() c: Socket) {
    return this.withUser(c, null, null, async (u) => {
      await c.join(LOBBY_ROOM);
      const t = this.dropTimers.get(u.userId);
      if (t) clearTimeout(t);
      this.dropTimers.delete(u.userId);
      return {
        ok: true,
        data: {
          config: this.publicConfig(),
          profile: await this.ranking.profileView(u.userId),
          matchmaking: this.mmState(u.userId),
          summary: await this.summary(),
        },
      };
    });
  }

  @SubscribeMessage('bida:lobby:leave')
  async leaveLobby(@ConnectedSocket() c: Socket) {
    await c.leave(LOBBY_ROOM);
    return { ok: true };
  }

  @SubscribeMessage('bida:config:get')
  config(@ConnectedSocket() c: Socket) {
    return this.withUser(c, null, null, () => ({
      ok: true,
      data: this.publicConfig(),
    }));
  }

  private publicConfig() {
    return {
      ranks: R.ranks,
      ruleSets: RULE_SETS,
      rankedRuleSets: R.matchmaking.rankedRuleSets,
      defaultTarget: DEFAULT_MATCH_TARGET,
      disciplines: DISCIPLINES.map((id) => ({ id, name: MODE_NAMES[id] })),
      matchmaking: {
        windows: R.matchmaking.windows,
        acceptSeconds: R.matchmaking.acceptSeconds,
        noShowSeconds: R.matchmaking.noShowSeconds,
      },
      tournament: {
        sizes: R.tournament.sizes,
        checkInMinutes: R.tournament.checkInMinutes,
      },
      turnSecondsOptions: R.casual.turnSecondsOptions,
      startRating: R.startRating,
    };
  }

  private async summary() {
    const lobby = await this.server.in(LOBBY_ROOM).fetchSockets();
    const online = new Set(
      lobby
        .map((s) => (s.data as { monoUser?: SocketUser }).monoUser?.userId)
        .filter(Boolean),
    );
    const rs = this.rooms.stats();
    const open = await this.tournaments.list({
      page: 1,
      pageSize: 50,
      filter: 'upcoming',
    });
    const live = await this.tournaments.list({
      page: 1,
      pageSize: 50,
      filter: 'live',
    });
    return {
      online: online.size,
      inRooms: rs.players,
      playing: rs.playing,
      queue: this.queue.counts(),
      tournamentsOpen: open.total,
      tournamentsLive: live.total,
    };
  }

  private async broadcastSummary() {
    try {
      this.events.toLobby('bida:lobby:summary', await this.summary());
    } catch {
      /* bỏ qua */
    }
  }

  @SubscribeMessage('bida:lobby:summary')
  getSummary(@ConnectedSocket() c: Socket) {
    return this.withUser(c, null, null, async () => ({
      ok: true,
      data: await this.summary(),
    }));
  }

  /** Người đang online ở sảnh (tối đa 40, kèm trạng thái) */
  @SubscribeMessage('bida:lobby:online')
  online(@ConnectedSocket() c: Socket) {
    return this.withUser(c, null, null, async () => {
      const sockets = await this.server.in(LOBBY_ROOM).fetchSockets();
      const users = new Map<string, SocketUser>();
      for (const s of sockets) {
        const u = (s.data as { monoUser?: SocketUser }).monoUser;
        if (u && !users.has(u.userId)) users.set(u.userId, u);
        if (users.size >= 40) break;
      }
      const list: {
        userId: string;
        name: string;
        avatar?: string;
        ratings: Record<Discipline, { rating: number; rankId: string }>;
        level: number;
        status: string;
      }[] = [];
      for (const u of users.values()) {
        const p = await this.ranking.profile(u.userId);
        const room = this.rooms.getRoomOfUser(u.userId);
        list.push({
          userId: u.userId,
          name: u.name,
          avatar: u.avatar,
          ratings: {
            free: {
              rating: p.ladders.free.rating,
              rankId: rankOf(p.ladders.free.rating).id,
            },
            three: {
              rating: p.ladders.three.rating,
              rankId: rankOf(p.ladders.three.rating).id,
            },
          },
          level: levelOf(p.xp).level,
          status:
            room?.status === 'playing'
              ? 'playing'
              : this.queue.isQueued(u.userId) || this.queue.pendingFor(u.userId)
                ? 'searching'
                : room
                  ? 'in-room'
                  : 'idle',
        });
      }
      return { ok: true, data: list };
    });
  }

  // ===================================================== GHÉP TRẬN
  private mmState(userId: string) {
    const e = this.queue.entryOf(userId);
    if (e)
      return {
        state: 'searching' as const,
        mode: e.mode,
        ruleSet: e.ruleSet,
        rating: e.rating,
        joinedAt: e.joinedAt,
        range: searchRange((Date.now() - e.joinedAt) / 1000),
      };
    const pm = this.queue.pendingFor(userId);
    if (pm)
      return { state: 'found' as const, ...this.foundPayload(pm, userId) };
    return { state: 'idle' as const };
  }

  private foundPayload(pm: PendingMatch, userId: string) {
    const opp = pm.players.find((p) => p.userId !== userId)!;
    const n = this.queueNames.get(opp.userId);
    return {
      pendingId: pm.id,
      mode: pm.mode,
      ruleSet: pm.ruleSet,
      deadline: pm.deadline,
      accepted: pm.accepted.includes(userId),
      opponent: {
        userId: opp.userId,
        name: n?.name ?? 'Đối thủ',
        avatar: n?.avatar,
        rating: opp.rating,
        rankId: rankOf(opp.rating).id,
      },
    };
  }

  private async busyReason(userId: string): Promise<string | null> {
    const r = this.rooms.busyReason(userId);
    if (r) return r;
    if (await this.tournaments.isInActiveTournamentMatch(userId))
      return 'Bạn đang có trận trong giải đấu';
    return null;
  }

  @SubscribeMessage('bida:matchmaking:join')
  mmJoin(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, MatchmakingJoinDto, body, (u, dto) =>
      this.joinQueue(u, dto.mode, dto.ruleSet),
    );
  }

  /** ranked:find = tìm trận xếp hạng của một thể loại (luật cố định theo cấu hình) */
  @SubscribeMessage('bida:ranked:find')
  rankedFind(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, DisciplineDto, body, (u, dto) =>
      this.joinQueue(u, 'RANKED', undefined, dto.discipline),
    );
  }

  private async joinQueue(
    u: SocketUser,
    mode: 'QUICK' | 'RANKED',
    ruleSet?: string,
    discipline?: Discipline,
  ): Promise<Ack> {
    if (this.limited(u.userId, 'mm-join', 1000))
      return fail('Thao tác quá nhanh');
    // Ranked: luật phải thuộc danh sách xếp hạng của thể loại (15 / 20 điểm); thiếu luật thì lấy 15 điểm
    const d = discipline ?? (ruleSet ? disciplineOf(ruleSet) : 'free');
    const rankedRules = R.matchmaking.rankedRuleSets[d];
    if (mode === 'RANKED' && ruleSet && !rankedRules.includes(ruleSet))
      return fail('Luật xếp hạng không hợp lệ');
    // không gửi luật -> mặc định 15 điểm của thể loại
    const rule = ruleSet ?? makeRuleSet(d, DEFAULT_MATCH_TARGET).id;
    if (mode === 'RANKED' && !rankedRules.includes(rule))
      return fail('Luật xếp hạng không hợp lệ');
    // rating của đúng thể loại, lấy từ DB (không tin client)
    const rating = await this.ranking.rating(u.userId, disciplineOf(rule));
    const res = this.queue.join(
      { userId: u.userId, mode, ruleSet: rule, rating, joinedAt: Date.now() },
      await this.busyReason(u.userId),
    );
    if (!res.ok) return fail(res.error);
    this.queueNames.set(u.userId, { name: u.name, avatar: u.avatar });
    const payload = {
      mode,
      ruleSet: rule,
      rating,
      joinedAt: res.entry.joinedAt,
      range: searchRange(0),
    };
    this.events.toUsers([u.userId], 'bida:matchmaking:queued', payload);
    if (mode === 'RANKED')
      this.events.toUsers([u.userId], 'bida:ranked:queued', payload);
    return { ok: true, data: payload };
  }

  @SubscribeMessage('bida:matchmaking:cancel')
  mmCancel(@ConnectedSocket() c: Socket) {
    return this.withUser(c, null, null, (u) => this.cancelQueue(u.userId));
  }

  @SubscribeMessage('bida:ranked:cancel')
  rankedCancel(@ConnectedSocket() c: Socket) {
    return this.withUser(c, null, null, (u) => this.cancelQueue(u.userId));
  }

  private cancelQueue(userId: string): Ack {
    const removed = this.queue.cancel(userId);
    if (removed)
      this.events.toUsers([userId], 'bida:matchmaking:cancelled', {
        reason: 'Đã huỷ tìm trận',
        requeued: false,
      });
    return { ok: true, data: { removed } };
  }

  @SubscribeMessage('bida:matchmaking:status')
  mmStatus(@ConnectedSocket() c: Socket) {
    return this.withUser(c, null, null, (u) => ({
      ok: true,
      data: this.mmState(u.userId),
    }));
  }

  @SubscribeMessage('bida:matchmaking:accept')
  mmAccept(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, PendingDto, body, (u, dto) => {
      const r = this.queue.accept(u.userId, dto.pendingId);
      if (!r.ok) return fail(r.error);
      if (!r.complete) {
        const pm = this.queue.pendingFor(u.userId);
        if (pm)
          this.events.toUsers(
            pm.players.map((p) => p.userId),
            'bida:matchmaking:accepted',
            { pendingId: pm.id, userId: u.userId },
          );
        return { ok: true, data: { waiting: true } };
      }
      this.createMatch(r.complete);
      return { ok: true, data: { waiting: false } };
    });
  }

  @SubscribeMessage('bida:matchmaking:decline')
  mmDecline(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, PendingDto, body, (u, dto) => {
      const pm = this.queue.pendingFor(u.userId);
      if (!pm || pm.id !== dto.pendingId)
        return fail('Trận không còn hiệu lực');
      this.handleRejected(
        this.queue.reject(pm.id, Date.now(), u.userId),
        'Đối thủ đã từ chối trận',
      );
      return { ok: true };
    });
  }

  private handleRejected(
    r: ReturnType<MatchmakingQueue['reject']>,
    reasonForOthers: string,
  ) {
    if (!r) return;
    for (const id of r.requeued) {
      this.events.toUsers([id], 'bida:matchmaking:cancelled', {
        reason: `${reasonForOthers} — tiếp tục tìm trận`,
        requeued: true,
      });
      const e = this.queue.entryOf(id);
      if (e)
        this.events.toUsers([id], 'bida:matchmaking:queued', {
          mode: e.mode,
          ruleSet: e.ruleSet,
          rating: e.rating,
          joinedAt: e.joinedAt,
          range: searchRange((Date.now() - e.joinedAt) / 1000),
        });
    }
    for (const id of r.penalized)
      this.events.toUsers([id], 'bida:matchmaking:expired', {
        reason: 'Bạn đã từ chối / không xác nhận trận',
        lockSeconds: R.matchmaking.declineLockSeconds,
      });
  }

  /** Cả hai xác nhận: kiểm tra lại không ai bận rồi mở phòng trận (đúng 1 phòng / 1 trận) */
  private createMatch(pm: PendingMatch) {
    const now = Date.now();
    for (const p of pm.players) {
      const busy = this.rooms.busyReason(p.userId);
      if (busy) {
        // người bận bị coi như từ chối, người kia quay lại hàng chờ
        this.queue.join(
          { ...pm.players.find((x) => x.userId !== p.userId)!, joinedAt: now },
          null,
        );
        this.events.toUsers([p.userId], 'bida:matchmaking:failed', {
          reason: busy,
        });
        const other = pm.players.find((x) => x.userId !== p.userId)!;
        this.events.toUsers([other.userId], 'bida:matchmaking:cancelled', {
          reason: 'Đối thủ không còn sẵn sàng — tiếp tục tìm trận',
          requeued: true,
        });
        return;
      }
    }
    const users = pm.players.map((p) => ({
      userId: p.userId,
      ...(this.queueNames.get(p.userId) ?? { name: 'Người chơi' }),
    }));
    const room = this.game.openMatchRoom(
      pm.mode === 'RANKED' ? 'ranked' : 'quick',
      users,
      pm.ruleSet,
      { matchId: pm.id },
    );
    const ids = pm.players.map((p) => p.userId);
    this.events.toUsers(ids, 'bida:matchmaking:matched', {
      code: room.code,
      mode: pm.mode,
      matchId: pm.id,
    });
    if (pm.mode === 'RANKED')
      this.events.toUsers(ids, 'bida:ranked:match-created', {
        code: room.code,
        matchId: pm.id,
      });
  }

  private matchmakingTick() {
    const now = Date.now();
    for (const pm of this.queue.tick(now)) {
      for (const p of pm.players) {
        this.events.toUsers(
          [p.userId],
          'bida:matchmaking:found',
          this.foundPayload(pm, p.userId),
        );
        if (pm.mode === 'RANKED')
          this.events.toUsers(
            [p.userId],
            'bida:ranked:opponent-found',
            this.foundPayload(pm, p.userId),
          );
      }
    }
    for (const pm of this.queue.expired(now))
      this.handleRejected(
        this.queue.reject(pm.id, now, null),
        'Đối thủ không xác nhận',
      );
    // cập nhật thời gian chờ / khoảng tìm (mỗi 5 giây, chỉ gửi cho chính người đang chờ)
    if (Math.floor(now / 1000) % 5 === 0)
      for (const id of this.queue.queuedIds()) {
        const e = this.queue.entryOf(id)!;
        const wait = (now - e.joinedAt) / 1000;
        this.events.toUsers([id], 'bida:matchmaking:searching', {
          waitSeconds: Math.floor(wait),
          range: searchRange(wait),
        });
      }
    for (const id of this.queue.pendingIds()) {
      const pm = this.queue.pendingFor(id);
      if (pm)
        this.events.toUsers([id], 'bida:matchmaking:countdown', {
          pendingId: pm.id,
          remaining: Math.max(0, Math.ceil((pm.deadline - now) / 1000)),
        });
    }
  }

  /** Mất kết nối hẳn (không còn socket nào) 15 giây: rời hàng chờ / coi như từ chối trận chờ xác nhận */
  handleDisconnect(client: Socket) {
    const u = (client.data as { monoUser?: SocketUser }).monoUser;
    if (
      !u ||
      (!this.queue.isQueued(u.userId) && !this.queue.pendingFor(u.userId))
    )
      return;
    const old = this.dropTimers.get(u.userId);
    if (old) clearTimeout(old);
    this.dropTimers.set(
      u.userId,
      setTimeout(() => {
        this.dropTimers.delete(u.userId);
        void this.events.isOnline(u.userId).then((on) => {
          if (on) return;
          this.handleRejected(
            this.queue.drop(u.userId, Date.now()),
            'Đối thủ mất kết nối',
          );
        });
      }, 15_000),
    );
  }

  // ===================================================== HỒ SƠ / XẾP HẠNG / LỊCH SỬ
  @SubscribeMessage('bida:ranked:get-profile')
  getProfile(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, ProfileDto, body, async (u, dto) => ({
      ok: true,
      data: await this.ranking.profileView(dto.userId ?? u.userId),
    }));
  }

  @SubscribeMessage('bida:ranked:get-leaderboard')
  getLeaderboard(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, LeaderboardDto, body, async (u, dto) => {
      const discipline = dto.discipline ?? 'free';
      const page = await this.ranking.leaderboard({
        discipline,
        page: dto.page,
        pageSize: dto.pageSize ?? 20,
        search: dto.search,
        seasonId: dto.seasonId,
      });
      const me = await this.ranking.profileView(u.userId);
      return {
        ok: true,
        data: {
          ...page,
          me: {
            position: me.ladders[discipline].position,
            rating: me.ladders[discipline].rating,
            rankId: me.ladders[discipline].rankId,
          },
          seasons: await this.ranking.seasons(),
        },
      };
    });
  }

  @SubscribeMessage('bida:match:history')
  history(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, HistoryDto, body, async (u, dto) => ({
      ok: true,
      data: await this.ranking.history(dto.userId ?? u.userId, {
        gameMode: dto.gameMode,
        page: dto.page,
        pageSize: 15,
      }),
    }));
  }

  @SubscribeMessage('bida:match:recent')
  recent(@ConnectedSocket() c: Socket) {
    return this.withUser(c, null, null, async () => ({
      ok: true,
      data: await this.ranking.recentMatches(8),
    }));
  }

  // ===================================================== GIẢI ĐẤU
  @SubscribeMessage('bida:tournament:create')
  tCreate(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentCreateDto, body, async (u, dto) => {
      if (this.limited(u.userId, 't-create', 3000))
        return fail('Thao tác quá nhanh');
      const mmBusy = this.matchmakingBusy(u.userId);
      if (mmBusy) return fail(mmBusy);
      const r = await this.tournaments.create(
        { userId: u.userId, name: u.name, avatar: u.avatar },
        dto,
      );
      if (!r.ok) return fail(r.error);
      await c.join(tournamentRoomKey(r.data.tournamentId));
      this.events.toUsers([u.userId], 'bida:tournament:created', {
        tournament: tournamentView(r.data),
      });
      return { ok: true, data: tournamentView(r.data) };
    });
  }

  @SubscribeMessage('bida:tournament:list')
  tList(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentListDto, body, async (_u, dto) => ({
      ok: true,
      data: await this.tournaments.list({
        page: dto.page,
        pageSize: dto.pageSize ?? 12,
        search: dto.search,
        filter: dto.filter ?? 'all',
      }),
    }));
  }

  /** Chi tiết + theo dõi realtime (vào phòng socket của giải) */
  @SubscribeMessage('bida:tournament:get-detail')
  tDetail(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentIdDto, body, async (_u, dto) => {
      const t = await this.tournaments.get(dto.tournamentId);
      if (!t) return fail('Không tìm thấy giải đấu');
      await c.join(tournamentRoomKey(t.tournamentId));
      return { ok: true, data: tournamentView(t) };
    });
  }

  @SubscribeMessage('bida:tournament:unwatch')
  async tUnwatch(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    const v = validateDto(TournamentIdDto, body);
    if (v.ok) await c.leave(tournamentRoomKey(v.value.tournamentId));
    return { ok: true };
  }

  @SubscribeMessage('bida:tournament:get-bracket')
  tBracket(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentIdDto, body, async (_u, dto) => {
      const t = await this.tournaments.get(dto.tournamentId);
      if (!t) return fail('Không tìm thấy giải đấu');
      return {
        ok: true,
        data: { bracket: t.bracket, roundNames: tournamentView(t).roundNames },
      };
    });
  }

  @SubscribeMessage('bida:tournament:join')
  tJoin(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentJoinDto, body, async (u, dto) => {
      if (this.limited(u.userId, 't-join', 800))
        return fail('Thao tác quá nhanh');
      const r = await this.tournaments.join(
        dto.tournamentId,
        { userId: u.userId, name: u.name, avatar: u.avatar },
        dto.password,
      );
      return r.ok ? { ok: true, data: tournamentView(r.data) } : fail(r.error);
    });
  }

  @SubscribeMessage('bida:tournament:leave')
  tLeave(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentIdDto, body, async (u, dto) => {
      const r = await this.tournaments.leave(dto.tournamentId, u.userId);
      return r.ok ? { ok: true, data: tournamentView(r.data) } : fail(r.error);
    });
  }

  @SubscribeMessage('bida:tournament:check-in')
  tCheckIn(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentIdDto, body, async (u, dto) => {
      const r = await this.tournaments.checkIn(dto.tournamentId, u.userId);
      return r.ok ? { ok: true, data: tournamentView(r.data) } : fail(r.error);
    });
  }

  @SubscribeMessage('bida:tournament:cancel')
  tCancel(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentIdDto, body, async (u, dto) => {
      const r = await this.tournaments.cancel(
        dto.tournamentId,
        u.userId,
        'Người tổ chức đã huỷ giải',
      );
      return r.ok ? { ok: true, data: tournamentView(r.data) } : fail(r.error);
    });
  }

  @SubscribeMessage('bida:tournament:open-check-in')
  tOpenCheckIn(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentIdDto, body, async (u, dto) => {
      const r = await this.tournaments.openCheckIn(dto.tournamentId, u.userId);
      return r.ok ? { ok: true, data: tournamentView(r.data) } : fail(r.error);
    });
  }

  @SubscribeMessage('bida:tournament:start')
  tStart(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentIdDto, body, async (u, dto) => {
      const r = await this.tournaments.begin(dto.tournamentId, u.userId);
      if (!r.ok) return fail(r.error);
      await this.game.openTournamentMatches(
        r.data.ready.map((m) => ({ tournamentId: dto.tournamentId, match: m })),
      );
      const t = await this.tournaments.get(dto.tournamentId);
      return { ok: true, data: t ? tournamentView(t) : null };
    });
  }

  /** Mời một người (đang online) vào giải — chỉ người tham gia / tổ chức */
  @SubscribeMessage('bida:tournament:invite')
  tInvite(@ConnectedSocket() c: Socket, @MessageBody() body: unknown) {
    return this.withUser(c, TournamentInviteDto, body, async (u, dto) => {
      if (this.limited(u.userId, 't-invite', 2000))
        return fail('Thao tác quá nhanh');
      const t = await this.tournaments.get(dto.tournamentId);
      if (!t) return fail('Không tìm thấy giải đấu');
      if (
        t.organizerId !== u.userId &&
        !t.participants.some((p) => p.userId === u.userId)
      )
        return fail('Bạn không tham gia giải này');
      if (!(await this.events.isOnline(dto.userId)))
        return fail('Người này đang không online');
      this.events.toUsers([dto.userId], 'bida:tournament:invited', {
        tournament: tournamentView(t),
        from: { userId: u.userId, name: u.name },
      });
      return { ok: true };
    });
  }

  private async tournamentTick() {
    try {
      const ready = await this.tournaments.tick();
      // trận đang "PLAYING" mà phòng game đã mất (máy chủ khởi động lại) -> mở lại
      for (const t of await this.tournaments
        .list({ page: 1, pageSize: 50, filter: 'live' })
        .then((p) => p.items))
        for (const m of t.bracket?.rounds.flat() ?? [])
          if (
            m.status === 'PLAYING' &&
            m.roomCode &&
            !this.rooms.get(m.roomCode)
          )
            await this.tournaments.resetLostMatch(t.tournamentId, m.id);
      if (ready.length) await this.game.openTournamentMatches(ready);
    } catch (e) {
      this.logger.error(`Lỗi lịch giải đấu: ${(e as Error).message}`);
    }
  }
}
