/**
 * Hồ sơ thi đấu, mùa giải, bảng xếp hạng, lịch sử trận và ghi kết quả (Elo).
 * Mỗi thể loại bida (Libre / 3 băng) có thang xếp hạng riêng: rating, rank, mùa, bảng xếp hạng.
 * Mọi rating chỉ tính ở server — client không gửi được rating / kết quả.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { MODE_NAMES, RANKING_CONFIG as R, ruleSetById } from './ranking.config';
import {
  eloUpdate,
  kFactorFor,
  levelOf,
  rankIndex,
  rankOf,
  rankProgress,
  softReset,
  winRate,
} from './ranking';
import { normalizeProfile } from './profile.factory';
import { BILLIARD_STORE } from './tokens';
import {
  DISCIPLINES,
  type BilliardProfile,
  type BilliardStore,
  type Discipline,
  type GameMode,
  type MatchRecord,
  type Page,
  type SeasonRecord,
} from './store.types';

export interface PlayerRatingResult {
  userId: string;
  won: boolean;
  before: number;
  after: number;
  delta: number;
  rankBefore: string;
  rankAfter: string;
  promoted: boolean;
  demoted: boolean;
}

export interface MatchResultInput {
  matchId: string;
  roomCode: string;
  gameMode: GameMode;
  ruleSet: string;
  players: [string, string];
  names: [string, string];
  winnerIndex: 0 | 1;
  score: [number, number];
  endReason: string | null;
  startedAt: number;
  endedAt: number;
  tournamentId: string | null;
  tournamentMatchId: string | null;
}

export interface MatchResultOutput {
  match: MatchRecord;
  discipline: Discipline;
  rated: boolean;
  unratedReason: string | null;
  players: [PlayerRatingResult, PlayerRatingResult];
}

/** Thang xếp hạng của một thể loại gửi cho client */
export interface LadderView {
  discipline: Discipline;
  name: string;
  rating: number;
  peakRating: number;
  rankId: string;
  bestRankId: string;
  nextRankId: string | null;
  rankProgress: number;
  position: number | null;
  ranked: { wins: number; losses: number; winRate: number };
  season: { wins: number; losses: number };
  seasonHistory: BilliardProfile['ladders'][Discipline]['seasonHistory'];
  /** Các luật đấu xếp hạng của thể loại (15 / 20 điểm) */
  rankedRuleSets: string[];
}

export interface ProfileView {
  userId: string;
  name: string;
  avatar?: string;
  level: number;
  xp: number;
  nextLevelXp: number;
  ladders: Record<Discipline, LadderView>;
  totalMatches: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  casual: { wins: number; losses: number };
  quick: { wins: number; losses: number };
  tournament: { wins: number; losses: number; titles: number; played: number };
  season: { seasonId: string; name: string; endAt: number };
}

export interface LeaderboardRow {
  position: number;
  userId: string;
  name: string;
  avatar?: string;
  rating: number;
  rankId: string;
  wins: number;
  losses: number;
  winRate: number;
}

const DAY = 24 * 3600 * 1000;

/** Thể loại của một bộ luật (`free-10` -> free) */
export function disciplineOf(ruleSet: string): Discipline {
  return (
    ruleSetById(ruleSet)?.mode ??
    (ruleSet.startsWith('three') ? 'three' : 'free')
  );
}

@Injectable()
export class BilliardRankingService implements OnModuleInit {
  private readonly logger = new Logger('BilliardRanking');
  private season: SeasonRecord | null = null;
  private lbCache = new Map<
    string,
    { at: number; data: Page<LeaderboardRow> }
  >();

  constructor(
    @Inject(BILLIARD_STORE) private readonly store: BilliardStore,
    @Optional()
    @Inject('BILLIARD_NOW')
    private readonly nowFn: () => number = Date.now,
  ) {}

  private now(): number {
    return this.nowFn();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.currentSeason();
      // trận đang chơi khi máy chủ tắt: huỷ, không tính rating
      const n = await this.store.cancelStaleMatches(this.now());
      if (n) this.logger.warn(`Huỷ ${n} trận dở dang do máy chủ khởi động lại`);
    } catch (e) {
      this.logger.error(
        `Không khởi tạo được mùa giải: ${(e as Error).message}`,
      );
    }
  }

  // ===================================================== MÙA GIẢI
  async currentSeason(): Promise<SeasonRecord> {
    if (
      this.season &&
      this.season.status === 'ACTIVE' &&
      this.now() < this.season.endAt
    )
      return this.season;
    let s = await this.store.activeSeason();
    if (!s) {
      s = this.makeSeason(1, this.now());
      await this.store.saveSeason(s);
    } else if (this.now() >= s.endAt) {
      s = await this.endSeason(s);
    }
    this.season = s;
    return s;
  }

  private makeSeason(number: number, startAt: number): SeasonRecord {
    return {
      seasonId: `S${number}`,
      name: `Mùa ${number}`,
      number,
      startAt,
      endAt: startAt + R.season.lengthDays * DAY,
      status: 'ACTIVE',
      finalStandings: { free: [], three: [] },
    };
  }

  /** Kết thúc mùa: khoá kết quả, lưu thứ hạng cuối mùa từng thể loại, reset mềm rating, mở mùa mới */
  async endSeason(old: SeasonRecord): Promise<SeasonRecord> {
    const all = (await this.store.allProfiles()).filter(
      (p) => p.seasonId === old.seasonId,
    );
    const positions = {} as Record<Discipline, Map<string, number>>;
    for (const d of DISCIPLINES) {
      const ranked = all
        .filter(
          (p) => p.ladders[d].season.wins + p.ladders[d].season.losses > 0,
        )
        .sort(
          (a, b) =>
            b.ladders[d].rating - a.ladders[d].rating ||
            a.userId.localeCompare(b.userId),
        );
      positions[d] = new Map(ranked.map((p, i) => [p.userId, i + 1]));
      old.finalStandings[d] = ranked
        .slice(0, R.season.finalStandingsSize)
        .map((p, i) => ({
          position: i + 1,
          userId: p.userId,
          rating: p.ladders[d].rating,
          rankId: rankOf(p.ladders[d].rating).id,
          wins: p.ladders[d].season.wins,
          losses: p.ladders[d].season.losses,
        }));
    }
    old.status = 'ENDED';
    await this.store.saveSeason(old);
    const next = this.makeSeason(
      old.number + 1,
      Math.max(old.endAt, this.now()),
    );
    await this.store.saveSeason(next);
    for (const p of all) {
      this.rollSeason(p, old, next, (d) => positions[d].get(p.userId) ?? null);
      await this.store.saveProfile(p);
    }
    this.lbCache.clear();
    this.logger.log(`Kết thúc ${old.name}, bắt đầu ${next.name}`);
    return next;
  }

  private rollSeason(
    p: BilliardProfile,
    old: SeasonRecord,
    next: SeasonRecord,
    position: (d: Discipline) => number | null,
  ): void {
    for (const d of DISCIPLINES) {
      const l = p.ladders[d];
      if (l.season.wins + l.season.losses > 0)
        l.seasonHistory.push({
          seasonId: old.seasonId,
          name: old.name,
          rating: l.rating,
          rankId: rankOf(l.rating).id,
          wins: l.season.wins,
          losses: l.season.losses,
          position: position(d),
        });
      l.rating = softReset(l.rating);
      l.season = { wins: 0, losses: 0 };
    }
    p.seasonId = next.seasonId;
  }

  /** Hồ sơ đúng mùa hiện tại (lỡ một lần chuyển mùa thì cập nhật luôn) */
  async profile(userId: string): Promise<BilliardProfile> {
    const season = await this.currentSeason();
    const p = normalizeProfile(
      await this.store.ensureProfile(userId, season.seasonId),
    );
    if (p.seasonId !== season.seasonId) {
      const old = (await this.store.seasons()).find(
        (s) => s.seasonId === p.seasonId,
      );
      if (old)
        this.rollSeason(
          p,
          old,
          season,
          (d) =>
            old.finalStandings[d]?.find((x) => x.userId === userId)?.position ??
            null,
        );
      else p.seasonId = season.seasonId;
      await this.store.saveProfile(p);
    }
    return p;
  }

  /** Rating của một thể loại */
  async rating(userId: string, discipline: Discipline): Promise<number> {
    return (await this.profile(userId)).ladders[discipline].rating;
  }

  async profileView(userId: string): Promise<ProfileView> {
    const [p, season] = [
      await this.profile(userId),
      await this.currentSeason(),
    ];
    const names = await this.store.userNames([userId]);
    const lv = levelOf(p.xp);
    const ladders = {} as Record<Discipline, LadderView>;
    for (const d of DISCIPLINES) {
      const l = p.ladders[d];
      const prog = rankProgress(l.rating);
      ladders[d] = {
        discipline: d,
        name: MODE_NAMES[d],
        rating: l.rating,
        peakRating: l.peakRating,
        rankId: prog.current.id,
        bestRankId: l.bestRankId,
        nextRankId: prog.next?.id ?? null,
        rankProgress: Math.round(prog.progress * 1000) / 1000,
        position: await this.store.positionOf(userId, season.seasonId, d),
        ranked: {
          ...l.ranked,
          winRate: winRate(l.ranked.wins, l.ranked.losses),
        },
        season: l.season,
        seasonHistory: l.seasonHistory,
        rankedRuleSets: R.matchmaking.rankedRuleSets[d],
      };
    }
    return {
      userId,
      name: names[userId]?.name ?? 'Người chơi',
      avatar: names[userId]?.avatar,
      level: lv.level,
      xp: p.xp,
      nextLevelXp: lv.nextAt,
      ladders,
      totalMatches: p.totalMatches,
      totalWins: p.totalWins,
      totalLosses: p.totalLosses,
      winRate: winRate(p.totalWins, p.totalLosses),
      casual: p.casual,
      quick: p.quick,
      tournament: p.tournament,
      season: {
        seasonId: season.seasonId,
        name: season.name,
        endAt: season.endAt,
      },
    };
  }

  /** Bảng xếp hạng một thể loại (phân trang ở DB, cache ngắn cho mùa hiện tại) */
  async leaderboard(opts: {
    discipline: Discipline;
    page: number;
    pageSize: number;
    search?: string;
    seasonId?: string;
    userIds?: string[];
  }): Promise<
    Page<LeaderboardRow> & { seasonId: string; discipline: Discipline }
  > {
    const d = opts.discipline;
    const season = await this.currentSeason();
    const seasonId = opts.seasonId ?? season.seasonId;
    if (seasonId !== season.seasonId) {
      const old = (await this.store.seasons()).find(
        (s) => s.seasonId === seasonId,
      );
      let rows = old?.finalStandings[d] ?? [];
      if (opts.search) {
        const ids = new Set(await this.store.searchUserIds(opts.search, 200));
        rows = rows.filter((r) => ids.has(r.userId));
      }
      const pageRows = rows.slice(
        (opts.page - 1) * opts.pageSize,
        opts.page * opts.pageSize,
      );
      const names = await this.store.userNames(pageRows.map((r) => r.userId));
      return {
        seasonId,
        discipline: d,
        total: rows.length,
        page: opts.page,
        pageSize: opts.pageSize,
        items: pageRows.map((r) => ({
          ...r,
          name: names[r.userId]?.name ?? 'Người chơi',
          avatar: names[r.userId]?.avatar,
          winRate: winRate(r.wins, r.losses),
        })),
      };
    }
    const key = JSON.stringify([
      d,
      seasonId,
      opts.page,
      opts.pageSize,
      opts.search ?? '',
      opts.userIds ?? null,
    ]);
    const hit = this.lbCache.get(key);
    if (hit && this.now() - hit.at < 15_000)
      return { ...hit.data, seasonId, discipline: d };
    let userIds = opts.userIds;
    if (opts.search) {
      const found = await this.store.searchUserIds(opts.search, 200);
      userIds = userIds ? userIds.filter((id) => found.includes(id)) : found;
    }
    const page = await this.store.profilesByRating({
      discipline: d,
      seasonId,
      page: opts.page,
      pageSize: opts.pageSize,
      userIds,
    });
    const names = await this.store.userNames(page.items.map((p) => p.userId));
    const items: LeaderboardRow[] = [];
    for (const [i, raw] of page.items.entries()) {
      const p = normalizeProfile(raw);
      const l = p.ladders[d];
      // khi lọc theo tìm kiếm, vị trí vẫn là vị trí thật trên bảng toàn cục
      const position = userIds
        ? ((await this.store.positionOf(p.userId, seasonId, d)) ?? 0)
        : (opts.page - 1) * opts.pageSize + i + 1;
      items.push({
        position,
        userId: p.userId,
        name: names[p.userId]?.name ?? 'Người chơi',
        avatar: names[p.userId]?.avatar,
        rating: l.rating,
        rankId: rankOf(l.rating).id,
        wins: l.season.wins,
        losses: l.season.losses,
        winRate: winRate(l.season.wins, l.season.losses),
      });
    }
    const data = { ...page, items };
    this.lbCache.set(key, { at: this.now(), data });
    if (this.lbCache.size > 200)
      for (const k of this.lbCache.keys()) {
        this.lbCache.delete(k);
        break;
      }
    return { ...data, seasonId, discipline: d };
  }

  async history(
    userId: string,
    opts: { gameMode?: GameMode; page: number; pageSize: number },
  ) {
    return this.store.matchesOf(userId, opts);
  }

  async names(ids: string[]) {
    return this.store.userNames(ids);
  }

  async recentMatches(limit = 8) {
    return this.store.recentMatches(limit);
  }

  async seasons() {
    return (await this.store.seasons()).map(({ finalStandings, ...s }) => ({
      ...s,
      standings: finalStandings.free.length + finalStandings.three.length,
    }));
  }

  // ===================================================== GHI TRẬN
  /** Trận bắt đầu: tạo bản ghi PLAYING (idempotent — gọi lại không tạo thêm) */
  async recordStart(
    m: Omit<
      MatchRecord,
      | 'status'
      | 'winnerId'
      | 'score'
      | 'ratingBefore'
      | 'ratingChanges'
      | 'rated'
      | 'unratedReason'
      | 'seasonId'
      | 'endReason'
      | 'completedAt'
      | 'durationMs'
      | 'discipline'
    >,
  ): Promise<void> {
    const season = await this.currentSeason();
    await this.store.createMatch({
      ...m,
      discipline: disciplineOf(m.ruleSet),
      status: 'PLAYING',
      winnerId: null,
      score: [0, 0],
      ratingBefore: null,
      ratingChanges: null,
      rated: false,
      unratedReason: null,
      seasonId: season.seasonId,
      endReason: null,
      completedAt: null,
      durationMs: null,
    });
  }

  /** Huỷ trận (không ai vào): không tính gì */
  async cancelMatch(matchId: string, reason: string): Promise<boolean> {
    return !!(await this.store.completeMatch(matchId, {
      status: 'CANCELLED',
      endReason: reason,
      completedAt: this.now(),
    }));
  }

  /**
   * Ghi kết quả đúng 1 lần (cửa idempotency: PLAYING -> COMPLETED nguyên tử).
   * Trận xếp hạng chỉ cộng / trừ điểm ở thang của đúng thể loại trận đó.
   * Trả về null nếu trận đã được ghi trước đó.
   */
  async recordResult(
    input: MatchResultInput,
  ): Promise<MatchResultOutput | null> {
    const season = await this.currentSeason();
    const [a, b] = input.players;
    if (a === b) return null;
    const d = disciplineOf(input.ruleSet);
    // trận chưa có bản ghi (DB lỗi lúc bắt đầu) -> tạo bổ sung trước khi chốt
    await this.recordStart({
      matchId: input.matchId,
      roomCode: input.roomCode,
      gameMode: input.gameMode,
      ruleSet: input.ruleSet,
      players: input.players,
      names: input.names,
      tournamentId: input.tournamentId,
      tournamentMatchId: input.tournamentMatchId,
      startedAt: input.startedAt,
    });
    const completed = await this.store.completeMatch(input.matchId, {
      status: 'COMPLETED',
      winnerId: input.players[input.winnerIndex],
      score: input.score,
      endReason: input.endReason,
      completedAt: input.endedAt,
      durationMs: Math.max(0, input.endedAt - input.startedAt),
      seasonId: season.seasonId,
    });
    if (!completed) return null;

    const pa = await this.profile(a);
    const pb = await this.profile(b);
    const la = pa.ladders[d];
    const lb = pb.ladders[d];
    let rated = input.gameMode === 'RANKED';
    let unratedReason: string | null = null;
    if (rated) {
      const recent = await this.store.countRankedBetween(
        a,
        b,
        this.now() - DAY,
        d,
      );
      if (recent >= R.antiAbuse.maxRankedVsSameOpponentPerDay) {
        rated = false;
        unratedReason = `Đã đấu xếp hạng ${MODE_NAMES[d]} với nhau ${recent} trận trong 24 giờ — trận này không tính điểm`;
      }
    }
    const before: [number, number] = [la.rating, lb.rating];
    let after: [number, number] = [...before];
    if (rated) {
      const e = eloUpdate(
        la.rating,
        lb.rating,
        input.winnerIndex === 0 ? 1 : 0,
        kFactorFor(la.ranked.wins + la.ranked.losses),
        kFactorFor(lb.ranked.wins + lb.ranked.losses),
      );
      after = [e.a, e.b];
    }
    const results = [pa, pb].map((p, i): PlayerRatingResult => {
      const won = i === input.winnerIndex;
      const l = p.ladders[d];
      const rankBefore = rankOf(before[i]).id;
      const rankAfter = rankOf(after[i]).id;
      p.totalMatches += 1;
      if (won) p.totalWins += 1;
      else p.totalLosses += 1;
      p.xp += R.level.xpPerMatch + (won ? R.level.xpPerWin : 0);
      if (input.gameMode === 'RANKED') {
        if (won) l.ranked.wins += 1;
        else l.ranked.losses += 1;
      } else {
        const bucket =
          input.gameMode === 'QUICK'
            ? p.quick
            : input.gameMode === 'TOURNAMENT'
              ? p.tournament
              : p.casual;
        if (won) bucket.wins += 1;
        else bucket.losses += 1;
      }
      if (rated) {
        l.rating = after[i];
        l.peakRating = Math.max(l.peakRating, l.rating);
        if (rankIndex(rankAfter) > rankIndex(l.bestRankId))
          l.bestRankId = rankAfter;
        if (won) l.season.wins += 1;
        else l.season.losses += 1;
      }
      p.updatedAt = this.now();
      return {
        userId: p.userId,
        won,
        before: before[i],
        after: after[i],
        delta: after[i] - before[i],
        rankBefore,
        rankAfter,
        promoted: rankIndex(rankAfter) > rankIndex(rankBefore),
        demoted: rankIndex(rankAfter) < rankIndex(rankBefore),
      };
    }) as [PlayerRatingResult, PlayerRatingResult];
    await this.store.saveProfile(pa);
    await this.store.saveProfile(pb);
    const ratingPatch = {
      ratingBefore: input.gameMode === 'RANKED' ? before : null,
      ratingChanges: rated
        ? ([after[0] - before[0], after[1] - before[1]] as [number, number])
        : null,
      rated,
      unratedReason,
    };
    await this.store.updateMatchRating(input.matchId, ratingPatch);
    if (rated)
      for (const r of results)
        await this.store.addRankHistory({
          userId: r.userId,
          matchId: input.matchId,
          seasonId: season.seasonId,
          discipline: d,
          before: r.before,
          after: r.after,
          delta: r.delta,
          rankBefore: r.rankBefore,
          rankAfter: r.rankAfter,
          at: this.now(),
        });
    this.lbCache.clear();
    return {
      match: { ...completed, ...ratingPatch },
      discipline: d,
      rated,
      unratedReason,
      players: results,
    };
  }

  /** Ghi nhận vô địch / tham gia giải */
  async recordTournamentFinish(
    participants: string[],
    championId: string | null,
  ): Promise<void> {
    for (const id of participants) {
      const p = await this.profile(id);
      p.tournament.played += 1;
      if (id === championId) p.tournament.titles += 1;
      await this.store.saveProfile(p);
    }
  }
}
