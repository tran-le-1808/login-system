/**
 * Giải đấu: vòng đời REGISTRATION -> FULL -> CHECK_IN -> IN_PROGRESS -> COMPLETED (hoặc CANCELLED).
 * Nhánh đấu & kết quả chỉ server sửa. Mọi thao tác trên một giải được xếp hàng tuần tự (mutex) + kiểm tra version khi lưu.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { checkPassword, hashPassword } from '../billiard-room.service';
import { CloudinaryService } from 'src/common/cloudinary/cloudinary.service';
import {
  createBracket,
  findMatch,
  readyMatches,
  reportWinner,
  roundName,
  seedPlayers,
  type BracketMatch,
} from './bracket';
import {
  makeRuleSet,
  RANKING_CONFIG as R,
  ruleSetById,
  TOURNAMENT_TARGET,
} from './ranking.config';
import { rankOf } from './ranking';
import { BilliardRankingService, disciplineOf } from './ranking.service';
import { BilliardEventsService } from './events.service';
import { BILLIARD_STORE } from './tokens';
import type {
  BilliardStore,
  TournamentRecord,
  TournamentStatus,
} from './store.types';

export interface CreateTournamentInput {
  name: string;
  description?: string;
  thumbnail?: string;
  maxParticipants: number;
  /** Loại bida: free = Libre (phăng), three = 3 băng */
  mode: 'free' | 'three';
  /** Số điểm để thắng (5–30) */
  target: number;
  startAt: number;
  registrationDeadline: number;
  format: 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION';
  seeding?: 'random' | 'rating';
  matchDurationMinutes?: number;
  visibility: 'PUBLIC' | 'PRIVATE';
  password?: string;
  entryFee?: number;
  prizePool?: number;
  joinAsPlayer?: boolean;
}

export interface TournamentUser {
  userId: string;
  name: string;
  avatar?: string;
}

type Result<T = TournamentRecord> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const ACTIVE: TournamentStatus[] = [
  'DRAFT',
  'REGISTRATION',
  'FULL',
  'CHECK_IN',
  'IN_PROGRESS',
];
const OPEN: TournamentStatus[] = ['REGISTRATION', 'FULL', 'CHECK_IN'];

/** Dữ liệu giải gửi client (không có mật khẩu) */
export function tournamentView(t: TournamentRecord) {
  const { passwordHash, ...rest } = t;
  const rounds = t.bracket?.rounds.length ?? 0;
  return {
    ...rest,
    hasPassword: !!passwordHash,
    ruleName: ruleSetById(t.ruleSet)?.name ?? t.ruleSet,
    participants: t.participants.map((p) => ({
      ...p,
      rankId: rankOf(p.rating).id,
    })),
    roundNames: Array.from({ length: rounds }, (_, i) => roundName(i, rounds)),
  };
}
export type TournamentView = ReturnType<typeof tournamentView>;

@Injectable()
export class BilliardTournamentService {
  private readonly logger = new Logger('BilliardTournament');
  private locks = new Map<string, Promise<unknown>>();
  private lastCreate = new Map<string, number>();

  /** Chỉ nhận ảnh do hệ thống tải lên Cloudinary (thay được trong test) */
  isAllowedThumbnail: (url: string) => boolean = (url) =>
    CloudinaryService.isTournamentThumbnailUrl(url);

  constructor(
    @Inject(BILLIARD_STORE) private readonly store: BilliardStore,
    private readonly ranking: BilliardRankingService,
    private readonly events: BilliardEventsService,
    @Optional()
    @Inject('BILLIARD_NOW')
    private readonly nowFn: () => number = Date.now,
    @Optional()
    @Inject('BILLIARD_RNG')
    private readonly rng: () => number = Math.random,
  ) {}

  private now() {
    return this.nowFn();
  }

  /** Xếp hàng thao tác trên cùng một giải (tránh hai người cùng đăng ký vào chỗ cuối) */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  /** Đọc - sửa - lưu có kiểm tra version (thử lại nếu bị ghi chen) */
  private async mutate(
    id: string,
    fn: (
      t: TournamentRecord,
    ) => Result<TournamentRecord> | Promise<Result<TournamentRecord>>,
  ): Promise<Result> {
    return this.withLock(id, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const t = await this.store.getTournament(id);
        if (!t) return { ok: false, error: 'Không tìm thấy giải đấu' } as const;
        const version = t.version;
        const r = await fn(t);
        if (!r.ok) return r;
        r.data.updatedAt = this.now();
        if (await this.store.saveTournament(r.data, version))
          return {
            ok: true,
            data: { ...r.data, version: version + 1 },
          } as const;
      }
      return {
        ok: false,
        error: 'Giải đấu vừa được cập nhật, vui lòng thử lại',
      } as const;
    });
  }

  private emitUpdate(
    t: TournamentRecord,
    event = 'bida:tournament:updated',
    extra: Record<string, unknown> = {},
  ) {
    const view = tournamentView(t);
    this.events.toTournament(t.tournamentId, event, {
      tournament: view,
      ...extra,
    });
    if (event !== 'bida:tournament:updated')
      this.events.toTournament(t.tournamentId, 'bida:tournament:updated', {
        tournament: view,
      });
  }

  // ===================================================== TẠO / DANH SÁCH
  async create(
    user: TournamentUser,
    input: CreateTournamentInput,
  ): Promise<Result> {
    const now = this.now();
    const T = R.tournament;
    if (!T.sizes.includes(input.maxParticipants))
      return { ok: false, error: 'Số người tham gia không hợp lệ' };
    if (input.mode !== 'free' && input.mode !== 'three')
      return { ok: false, error: 'Loại bida không hợp lệ' };
    if (
      !Number.isInteger(input.target) ||
      input.target < TOURNAMENT_TARGET.min ||
      input.target > TOURNAMENT_TARGET.max
    )
      return {
        ok: false,
        error: `Số điểm phải từ ${TOURNAMENT_TARGET.min} đến ${TOURNAMENT_TARGET.max}`,
      };
    const ruleSet = makeRuleSet(input.mode, input.target).id;
    if (input.format !== 'SINGLE_ELIMINATION')
      return {
        ok: false,
        error: 'Hiện chỉ hỗ trợ loại trực tiếp (Single Elimination)',
      };
    if (input.startAt < now + 60_000)
      return {
        ok: false,
        error: 'Giờ bắt đầu phải sau thời điểm hiện tại ít nhất 1 phút',
      };
    if (input.registrationDeadline > input.startAt)
      return { ok: false, error: 'Hạn đăng ký phải trước giờ bắt đầu' };
    if (input.registrationDeadline < now)
      return { ok: false, error: 'Hạn đăng ký đã qua' };
    if (input.thumbnail && !this.isAllowedThumbnail(input.thumbnail))
      return {
        ok: false,
        error: 'Ảnh giải đấu không hợp lệ — hãy tải ảnh lên từ máy',
      };
    if (input.visibility === 'PRIVATE' && !input.password)
      return { ok: false, error: 'Giải riêng tư cần mật khẩu' };
    const last = this.lastCreate.get(user.userId) ?? 0;
    if (now - last < T.createCooldownSeconds * 1000)
      return {
        ok: false,
        error: `Vui lòng chờ ${Math.ceil((T.createCooldownSeconds * 1000 - (now - last)) / 1000)} giây trước khi tạo giải mới`,
      };
    const mine = (await this.store.activeTournaments()).filter(
      (t) => t.organizerId === user.userId,
    );
    if (mine.length >= T.maxActivePerOrganizer)
      return {
        ok: false,
        error: `Bạn chỉ được tổ chức tối đa ${T.maxActivePerOrganizer} giải cùng lúc`,
      };
    // check-in mở trước giờ bắt đầu, nhưng không sớm hơn hạn đăng ký
    const checkInAt = Math.max(
      input.registrationDeadline,
      input.startAt - T.checkInMinutes * 60_000,
    );
    const t: TournamentRecord = {
      tournamentId:
        `T${now.toString(36)}${randomBytes(3).toString('hex')}`.toUpperCase(),
      name: input.name.trim(),
      description: (input.description ?? '').trim(),
      thumbnail: input.thumbnail ?? null,
      organizerId: user.userId,
      organizerName: user.name,
      maxParticipants: input.maxParticipants,
      participants: [],
      ruleSet,
      format: input.format,
      seeding: input.seeding ?? 'random',
      status: 'REGISTRATION',
      startAt: input.startAt,
      registrationDeadline: input.registrationDeadline,
      checkInAt,
      matchDurationMinutes: input.matchDurationMinutes ?? 20,
      visibility: input.visibility,
      passwordHash:
        input.visibility === 'PRIVATE' && input.password
          ? hashPassword(input.password)
          : null,
      entryFee: input.entryFee ?? null,
      prizePool: input.prizePool ?? null,
      bracket: null,
      championId: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    if (input.joinAsPlayer !== false)
      t.participants.push({
        ...user,
        rating: await this.ranking.rating(user.userId, disciplineOf(ruleSet)),
        checkedIn: false,
        joinedAt: now,
      });
    if (!(await this.store.saveTournament(t, null)))
      return { ok: false, error: 'Không tạo được giải đấu' };
    this.lastCreate.set(user.userId, now);
    if (t.visibility === 'PUBLIC')
      this.events.toLobby('bida:tournament:created', {
        tournament: tournamentView(t),
      });
    return { ok: true, data: t };
  }

  async list(opts: {
    page: number;
    pageSize: number;
    search?: string;
    filter?: 'upcoming' | 'live' | 'finished' | 'all';
  }) {
    const statuses: TournamentStatus[] | undefined =
      opts.filter === 'upcoming'
        ? OPEN
        : opts.filter === 'live'
          ? ['IN_PROGRESS']
          : opts.filter === 'finished'
            ? ['COMPLETED', 'CANCELLED']
            : undefined;
    const page = await this.store.listTournaments({
      statuses,
      page: opts.page,
      pageSize: opts.pageSize,
      search: opts.search,
    });
    return {
      ...page,
      items: page.items
        .filter((t) => t.visibility === 'PUBLIC')
        .map(tournamentView),
    };
  }

  async get(id: string): Promise<TournamentRecord | null> {
    return this.store.getTournament(id);
  }

  async isInActiveTournamentMatch(userId: string): Promise<boolean> {
    return (await this.store.activeTournaments()).some(
      (t) =>
        t.status === 'IN_PROGRESS' &&
        t.bracket?.rounds
          .flat()
          .some(
            (m) =>
              (m.status === 'READY' || m.status === 'PLAYING') &&
              (m.playerA === userId || m.playerB === userId),
          ),
    );
  }

  // ===================================================== ĐĂNG KÝ
  async join(
    id: string,
    user: TournamentUser,
    password?: string,
  ): Promise<Result> {
    const t0 = await this.store.getTournament(id);
    const rating = await this.ranking.rating(
      user.userId,
      disciplineOf(t0?.ruleSet ?? 'free-10'),
    );
    const r = await this.mutate(id, (t) => {
      if (t.status === 'FULL')
        return { ok: false, error: 'Giải đấu đã đủ người' };
      if (t.status !== 'REGISTRATION')
        return { ok: false, error: 'Giải đấu đã đóng đăng ký' };
      if (this.now() >= t.registrationDeadline)
        return { ok: false, error: 'Đã hết hạn đăng ký' };
      if (t.participants.some((p) => p.userId === user.userId))
        return { ok: false, error: 'Bạn đã đăng ký giải này' };
      if (t.participants.length >= t.maxParticipants)
        return { ok: false, error: 'Giải đấu đã đủ người' };
      if (t.passwordHash && !checkPassword(password ?? '', t.passwordHash))
        return { ok: false, error: 'Mật khẩu giải đấu không đúng' };
      t.participants.push({
        ...user,
        rating,
        checkedIn: false,
        joinedAt: this.now(),
      });
      if (t.participants.length >= t.maxParticipants) t.status = 'FULL';
      return { ok: true, data: t };
    });
    if (r.ok) {
      this.emitUpdate(r.data, 'bida:tournament:participant-joined', {
        userId: user.userId,
      });
      if (r.data.status === 'FULL')
        this.emitUpdate(r.data, 'bida:tournament:registration-closed');
    }
    return r;
  }

  async leave(id: string, userId: string): Promise<Result> {
    const r = await this.mutate(id, (t) => {
      if (!OPEN.includes(t.status))
        return { ok: false, error: 'Giải đấu đã bắt đầu, không thể rời' };
      if (!t.participants.some((p) => p.userId === userId))
        return { ok: false, error: 'Bạn chưa đăng ký giải này' };
      t.participants = t.participants.filter((p) => p.userId !== userId);
      if (t.status === 'FULL' && this.now() < t.registrationDeadline)
        t.status = 'REGISTRATION';
      return { ok: true, data: t };
    });
    if (r.ok)
      this.emitUpdate(r.data, 'bida:tournament:participant-left', { userId });
    return r;
  }

  async checkIn(id: string, userId: string): Promise<Result> {
    const r = await this.mutate(id, (t) => {
      if (t.status !== 'CHECK_IN')
        return { ok: false, error: 'Chưa tới giờ check-in' };
      const p = t.participants.find((x) => x.userId === userId);
      if (!p) return { ok: false, error: 'Bạn không tham gia giải này' };
      p.checkedIn = true;
      return { ok: true, data: t };
    });
    if (r.ok) this.emitUpdate(r.data);
    return r;
  }

  async cancel(
    id: string,
    userId: string | null,
    reason: string,
  ): Promise<Result> {
    const r = await this.mutate(id, (t) => {
      if (userId && t.organizerId !== userId)
        return { ok: false, error: 'Chỉ người tổ chức mới được huỷ giải' };
      if (!OPEN.includes(t.status) && t.status !== 'DRAFT')
        return {
          ok: false,
          error: 'Không thể huỷ giải đã bắt đầu hoặc đã kết thúc',
        };
      t.status = 'CANCELLED';
      t.cancelReason = reason;
      return { ok: true, data: t };
    });
    if (r.ok) {
      this.emitUpdate(r.data, 'bida:tournament:cancelled', { reason });
      this.events.toUsers(
        r.data.participants.map((p) => p.userId),
        'bida:tournament:cancelled',
        { tournament: tournamentView(r.data), reason },
      );
    }
    return r;
  }

  /** Người tổ chức mở check-in sớm */
  async openCheckIn(id: string, userId: string | null): Promise<Result> {
    const r = await this.mutate(id, (t) => {
      if (userId && t.organizerId !== userId)
        return { ok: false, error: 'Chỉ người tổ chức mới được mở check-in' };
      if (t.status !== 'REGISTRATION' && t.status !== 'FULL')
        return { ok: false, error: 'Không thể mở check-in lúc này' };
      if (t.participants.length < 2)
        return { ok: false, error: 'Cần ít nhất 2 người đăng ký' };
      t.status = 'CHECK_IN';
      t.checkInAt = Math.min(t.checkInAt, this.now());
      return { ok: true, data: t };
    });
    if (r.ok) {
      this.emitUpdate(r.data, 'bida:tournament:check-in-started');
      this.events.toUsers(
        r.data.participants.map((p) => p.userId),
        'bida:tournament:check-in-started',
        { tournament: tournamentView(r.data) },
      );
    }
    return r;
  }

  /** Bắt đầu giải: người chưa check-in bị loại, tạo nhánh đấu. Trả về các trận cần mở phòng. */
  async begin(
    id: string,
    userId: string | null,
  ): Promise<Result<{ tournament: TournamentRecord; ready: BracketMatch[] }>> {
    let cancelled = false;
    const r = await this.mutate(id, async (t) => {
      if (userId && t.organizerId !== userId)
        return { ok: false, error: 'Chỉ người tổ chức mới được bắt đầu giải' };
      if (t.status !== 'CHECK_IN')
        return { ok: false, error: 'Giải chưa ở giai đoạn check-in' };
      const players = t.participants.filter((p) => p.checkedIn);
      if (players.length < 2) {
        t.status = 'CANCELLED';
        t.cancelReason = 'Không đủ người check-in';
        cancelled = true;
        return { ok: true, data: t };
      }
      t.participants = players;
      for (const p of players)
        p.rating = await this.ranking.rating(p.userId, disciplineOf(t.ruleSet));
      t.bracket = createBracket(
        seedPlayers(players, t.seeding, this.rng),
        t.format,
      );
      t.status = 'IN_PROGRESS';
      return { ok: true, data: t };
    });
    if (!r.ok) return r;
    const t = r.data;
    if (cancelled) {
      this.emitUpdate(t, 'bida:tournament:cancelled', {
        reason: t.cancelReason,
      });
      return { ok: true, data: { tournament: t, ready: [] } };
    }
    for (const m of t.bracket!.rounds.flat())
      await this.store.upsertTournamentMatch(t.tournamentId, m);
    this.emitUpdate(t, 'bida:tournament:started');
    this.events.toUsers(
      t.participants.map((p) => p.userId),
      'bida:tournament:started',
      { tournament: tournamentView(t) },
    );
    this.logger.log(
      `Giải ${t.name} bắt đầu với ${t.participants.length} người`,
    );
    return {
      ok: true,
      data: { tournament: t, ready: readyMatches(t.bracket!) },
    };
  }

  /** Gắn phòng game cho một trận vừa mở */
  async assignRoom(
    id: string,
    matchId: string,
    roomCode: string,
  ): Promise<Result> {
    const r = await this.mutate(id, (t) => {
      const m = t.bracket && findMatch(t.bracket, matchId);
      if (!m || m.status !== 'READY' || m.roomCode)
        return { ok: false, error: 'Trận không ở trạng thái chờ' };
      m.roomCode = roomCode;
      m.status = 'PLAYING';
      m.startedAt = this.now();
      return { ok: true, data: t };
    });
    if (r.ok) {
      const m = findMatch(r.data.bracket!, matchId)!;
      await this.store.upsertTournamentMatch(id, m);
      this.emitUpdate(r.data, 'bida:tournament:match-created', { match: m });
      this.events.toUsers(
        [m.playerA!, m.playerB!],
        'bida:tournament:match-created',
        { tournament: tournamentView(r.data), match: m },
      );
      this.emitUpdate(r.data, 'bida:tournament:bracket-updated');
    }
    return r;
  }

  /** Kết quả một trận (chỉ server gọi sau khi trận game xác thực xong) */
  async reportResult(
    id: string,
    matchId: string,
    winnerId: string,
    score: [number, number] | null,
  ): Promise<
    Result<{
      tournament: TournamentRecord;
      ready: BracketMatch[];
      champion: string | null;
    }>
  > {
    let ready: BracketMatch[] = [];
    let champion: string | null = null;
    const r = await this.mutate(id, (t) => {
      if (t.status !== 'IN_PROGRESS' || !t.bracket)
        return { ok: false, error: 'Giải không ở trạng thái thi đấu' };
      const res = reportWinner(t.bracket, matchId, winnerId, score, this.now());
      if (!res.ok) return res;
      ready = res.ready;
      champion = res.champion;
      if (champion) {
        t.status = 'COMPLETED';
        t.championId = champion;
      }
      return { ok: true, data: t };
    });
    if (!r.ok) return r;
    const t = r.data;
    const m = findMatch(t.bracket!, matchId)!;
    await this.store.upsertTournamentMatch(id, m);
    for (const x of ready) await this.store.upsertTournamentMatch(id, x);
    this.emitUpdate(t, 'bida:tournament:match-completed', { match: m });
    this.emitUpdate(t, 'bida:tournament:bracket-updated');
    if (champion) {
      await this.ranking.recordTournamentFinish(
        t.participants.map((p) => p.userId),
        champion,
      );
      this.emitUpdate(t, 'bida:tournament:completed', { championId: champion });
      this.events.toUsers(
        t.participants.map((p) => p.userId),
        'bida:tournament:completed',
        { tournament: tournamentView(t), championId: champion },
      );
    }
    return { ok: true, data: { tournament: t, ready, champion } };
  }

  // ===================================================== LỊCH (gọi định kỳ)
  /** Đóng đăng ký / mở check-in / bắt đầu đúng giờ. Trả về các trận cần mở phòng. */
  async tick(): Promise<{ tournamentId: string; match: BracketMatch }[]> {
    const now = this.now();
    const out: { tournamentId: string; match: BracketMatch }[] = [];
    for (const t of await this.store.activeTournaments()) {
      try {
        if (
          (t.status === 'REGISTRATION' || t.status === 'FULL') &&
          now >= t.checkInAt
        ) {
          if (t.participants.length < 2)
            await this.cancel(t.tournamentId, null, 'Không đủ người đăng ký');
          else await this.openCheckIn(t.tournamentId, null);
        } else if (
          t.status === 'REGISTRATION' &&
          now >= t.registrationDeadline
        ) {
          const r = await this.mutate(t.tournamentId, (x) =>
            x.status === 'REGISTRATION'
              ? ((x.status = 'FULL'), { ok: true, data: x })
              : { ok: false, error: 'skip' },
          );
          if (r.ok)
            this.emitUpdate(r.data, 'bida:tournament:registration-closed');
        } else if (t.status === 'CHECK_IN' && now >= t.startAt) {
          const r = await this.begin(t.tournamentId, null);
          if (r.ok)
            for (const m of r.data.ready)
              out.push({ tournamentId: t.tournamentId, match: m });
        } else if (t.status === 'IN_PROGRESS' && t.bracket) {
          // trận sẵn sàng mà chưa có phòng (vd. máy chủ vừa khởi động lại)
          for (const m of readyMatches(t.bracket))
            out.push({ tournamentId: t.tournamentId, match: m });
        }
      } catch (e) {
        this.logger.error(
          `Lỗi lịch giải ${t.tournamentId}: ${(e as Error).message}`,
        );
      }
    }
    return out;
  }

  /** Trận đang PLAYING mà phòng game đã mất (máy chủ khởi động lại): mở lại trận */
  async resetLostMatch(id: string, matchId: string): Promise<void> {
    await this.mutate(id, (t) => {
      const m = t.bracket && findMatch(t.bracket, matchId);
      if (!m || m.status !== 'PLAYING') return { ok: false, error: 'skip' };
      m.status = 'READY';
      m.roomCode = null;
      return { ok: true, data: t };
    });
  }

  activeStatuses() {
    return ACTIVE;
  }
}
