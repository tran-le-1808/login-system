/**
 * Kho dữ liệu MongoDB cho xếp hạng / lịch sử / giải đấu Bida Carom.
 * Không ghi gì trong vòng lặp game: chỉ ghi khi bắt đầu / kết thúc trận và khi thao tác giải đấu.
 * Idempotency: kết quả trận chỉ được ghi khi chuyển PLAYING -> COMPLETED (một lần, nguyên tử).
 */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema } from 'mongoose';
import { User, UserDocument } from 'src/users/entities/user.entity';
import type { Bracket } from './bracket';
import {
  newProfile,
  normalizeProfile,
  normalizeSeason,
} from './profile.factory';
import type {
  BilliardProfile,
  Discipline,
  BilliardStore,
  GameMode,
  MatchRecord,
  Page,
  RankHistoryRecord,
  SeasonRecord,
  TournamentRecord,
  TournamentStatus,
} from './store.types';

const Mixed = Schema.Types.Mixed;

export const BILLIARD_PROFILE = 'BilliardProfile';
export const BILLIARD_MATCH = 'BilliardMatchRecord';
export const BILLIARD_RANK_HISTORY = 'BilliardRankHistory';
export const BILLIARD_SEASON = 'BilliardSeason';
export const BILLIARD_TOURNAMENT = 'BilliardTournament';
export const BILLIARD_TOURNAMENT_MATCH = 'BilliardTournamentMatch';

export const BilliardProfileSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true },
    seasonId: { type: String, required: true },
    /** Thang xếp hạng riêng: Libre (free) & 3 băng (three) */
    ladders: Mixed,
    /** Trường phẳng để sắp xếp / lọc bảng xếp hạng có index */
    ratingFree: { type: Number, default: 1000 },
    ratingThree: { type: Number, default: 1000 },
    playedFree: { type: Number, default: 0 },
    playedThree: { type: Number, default: 0 },
    casual: Mixed,
    quick: Mixed,
    tournament: Mixed,
    totalMatches: Number,
    totalWins: Number,
    totalLosses: Number,
    xp: Number,
    updatedAt: Number,
  },
  { collection: 'billiard_profiles', versionKey: false },
);
BilliardProfileSchema.index({ seasonId: 1, playedFree: 1, ratingFree: -1 });
BilliardProfileSchema.index({ seasonId: 1, playedThree: 1, ratingThree: -1 });

/** Trường phẳng theo thể loại */
const RATING_FIELD: Record<Discipline, 'ratingFree' | 'ratingThree'> = {
  free: 'ratingFree',
  three: 'ratingThree',
};
const PLAYED_FIELD: Record<Discipline, 'playedFree' | 'playedThree'> = {
  free: 'playedFree',
  three: 'playedThree',
};
type ProfileDoc = BilliardProfile & {
  ratingFree: number;
  ratingThree: number;
  playedFree: number;
  playedThree: number;
};
const toProfile = (
  d: Doc<Record<string, unknown>> | null,
): BilliardProfile | null => {
  if (!d) return null;
  const {
    _id,
    ratingFree,
    ratingThree,
    playedFree,
    playedThree,
    seasonPlayed,
    ...rest
  } = d;
  void _id;
  void ratingFree;
  void ratingThree;
  void playedFree;
  void playedThree;
  void seasonPlayed;
  return normalizeProfile(rest as Parameters<typeof normalizeProfile>[0]);
};

export const BilliardMatchSchema = new Schema(
  {
    matchId: { type: String, required: true, unique: true },
    roomCode: String,
    gameMode: { type: String, required: true },
    ruleSet: String,
    discipline: { type: String, default: 'free' },
    players: { type: [String], index: true },
    names: [String],
    status: { type: String, required: true },
    winnerId: { type: String, default: null },
    score: [Number],
    ratingBefore: { type: [Number], default: null },
    ratingChanges: { type: [Number], default: null },
    rated: Boolean,
    unratedReason: { type: String, default: null },
    tournamentId: { type: String, default: null, index: true },
    tournamentMatchId: { type: String, default: null },
    seasonId: { type: String, default: null },
    endReason: { type: String, default: null },
    startedAt: Number,
    completedAt: { type: Number, default: null },
    durationMs: { type: Number, default: null },
  },
  { collection: 'billiard_matches', versionKey: false },
);
BilliardMatchSchema.index({ players: 1, status: 1, completedAt: -1 });
BilliardMatchSchema.index({ status: 1, completedAt: -1 });

export const BilliardRankHistorySchema = new Schema(
  {
    userId: { type: String, required: true },
    matchId: { type: String, required: true },
    seasonId: String,
    discipline: { type: String, default: 'free' },
    before: Number,
    after: Number,
    delta: Number,
    rankBefore: String,
    rankAfter: String,
    at: Number,
  },
  { collection: 'billiard_rank_histories', versionKey: false },
);
BilliardRankHistorySchema.index({ userId: 1, matchId: 1 }, { unique: true });
BilliardRankHistorySchema.index({ userId: 1, at: -1 });

export const BilliardSeasonSchema = new Schema(
  {
    seasonId: { type: String, required: true, unique: true },
    name: String,
    number: Number,
    startAt: Number,
    endAt: Number,
    status: { type: String, index: true },
    finalStandings: { type: [Mixed], default: [] },
  },
  { collection: 'billiard_seasons', versionKey: false },
);

export const BilliardTournamentSchema = new Schema(
  {
    tournamentId: { type: String, required: true, unique: true },
    name: String,
    description: String,
    thumbnail: { type: String, default: null },
    organizerId: { type: String, index: true },
    organizerName: String,
    maxParticipants: Number,
    participants: { type: [Mixed], default: [] },
    ruleSet: String,
    format: String,
    seeding: String,
    status: { type: String, index: true },
    startAt: Number,
    registrationDeadline: Number,
    checkInAt: Number,
    matchDurationMinutes: Number,
    visibility: String,
    passwordHash: { type: String, default: null },
    entryFee: { type: Number, default: null },
    prizePool: { type: Number, default: null },
    bracket: { type: Mixed, default: null },
    championId: { type: String, default: null },
    cancelReason: { type: String, default: null },
    createdAt: Number,
    updatedAt: Number,
    version: { type: Number, default: 1 },
  },
  { collection: 'billiard_tournaments', versionKey: false },
);
BilliardTournamentSchema.index({ status: 1, startAt: 1 });

export const BilliardTournamentMatchSchema = new Schema(
  {
    tournamentId: { type: String, required: true },
    matchId: { type: String, required: true },
    round: Number,
    slot: Number,
    playerA: { type: String, default: null },
    playerB: { type: String, default: null },
    winner: { type: String, default: null },
    status: String,
    score: { type: [Number], default: null },
    roomCode: { type: String, default: null },
    startedAt: { type: Number, default: null },
    endedAt: { type: Number, default: null },
  },
  { collection: 'billiard_tournament_matches', versionKey: false },
);
BilliardTournamentMatchSchema.index(
  { tournamentId: 1, matchId: 1 },
  { unique: true },
);

type Doc<T> = T & { _id?: unknown };
const strip = <T>(d: Doc<T> | null): T | null => {
  if (!d) return null;
  const { _id, ...rest } = d as Doc<T> & Record<string, unknown>;
  void _id;
  return rest as T;
};
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class MongoBilliardStore implements BilliardStore {
  constructor(
    @InjectModel(BILLIARD_PROFILE)
    private readonly profiles: Model<ProfileDoc>,
    @InjectModel(BILLIARD_MATCH) private readonly matches: Model<MatchRecord>,
    @InjectModel(BILLIARD_RANK_HISTORY)
    private readonly rankHistory: Model<RankHistoryRecord>,
    @InjectModel(BILLIARD_SEASON)
    private readonly seasonModel: Model<SeasonRecord>,
    @InjectModel(BILLIARD_TOURNAMENT)
    private readonly tournaments: Model<TournamentRecord>,
    @InjectModel(BILLIARD_TOURNAMENT_MATCH)
    private readonly tournamentMatches: Model<
      Bracket['rounds'][number][number] & {
        tournamentId: string;
        matchId: string;
      }
    >,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async getProfile(userId: string) {
    return toProfile(
      await this.profiles
        .findOne({ userId })
        .lean<Doc<Record<string, unknown>>>(),
    );
  }
  async ensureProfile(userId: string, seasonId: string) {
    const fresh = newProfile(userId, seasonId);
    const doc = await this.profiles
      .findOneAndUpdate(
        { userId },
        { $setOnInsert: { ...fresh, ...this.flat(fresh) } },
        { upsert: true, new: true },
      )
      .lean<Doc<Record<string, unknown>>>();
    return toProfile(doc)!;
  }
  private flat(p: BilliardProfile) {
    const played = (d: Discipline) =>
      p.ladders[d].season.wins + p.ladders[d].season.losses;
    return {
      ratingFree: p.ladders.free.rating,
      ratingThree: p.ladders.three.rating,
      playedFree: played('free'),
      playedThree: played('three'),
    };
  }
  async saveProfile(p: BilliardProfile) {
    await this.profiles.replaceOne(
      { userId: p.userId },
      { ...p, ...this.flat(p) },
      { upsert: true },
    );
  }
  async profilesByRating(opts: {
    discipline: Discipline;
    userIds?: string[];
    page: number;
    pageSize: number;
    seasonId: string;
  }) {
    const filter: Record<string, unknown> = {
      seasonId: opts.seasonId,
      [PLAYED_FIELD[opts.discipline]]: { $gt: 0 },
    };
    if (opts.userIds) filter.userId = { $in: opts.userIds };
    const [items, total] = await Promise.all([
      this.profiles
        .find(filter)
        .sort({ [RATING_FIELD[opts.discipline]]: -1, userId: 1 })
        .skip((opts.page - 1) * opts.pageSize)
        .limit(opts.pageSize)
        .lean<Doc<Record<string, unknown>>[]>(),
      this.profiles.countDocuments(filter),
    ]);
    return {
      items: items.map((d) => toProfile(d)!),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }
  async positionOf(userId: string, seasonId: string, d: Discipline) {
    const me = await this.profiles.findOne({ userId }).lean<Doc<ProfileDoc>>();
    const rf = RATING_FIELD[d];
    const pf = PLAYED_FIELD[d];
    if (!me || me.seasonId !== seasonId || !me[pf]) return null;
    const above = await this.profiles.countDocuments({
      seasonId,
      [pf]: { $gt: 0 },
      $or: [
        { [rf]: { $gt: me[rf] } },
        { [rf]: me[rf], userId: { $lt: userId } },
      ],
    });
    return above + 1;
  }
  async allProfiles() {
    return (
      await this.profiles.find().lean<Doc<Record<string, unknown>>[]>()
    ).map((d) => toProfile(d)!);
  }

  async createMatch(m: MatchRecord) {
    try {
      await this.matches.create(m);
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return false;
      throw e;
    }
  }
  async completeMatch(matchId: string, patch: Partial<MatchRecord>) {
    return strip<MatchRecord>(
      await this.matches
        .findOneAndUpdate(
          { matchId, status: 'PLAYING' },
          { $set: patch },
          { new: true },
        )
        .lean<Doc<MatchRecord>>(),
    );
  }
  async getMatch(matchId: string) {
    return strip<MatchRecord>(
      await this.matches.findOne({ matchId }).lean<Doc<MatchRecord>>(),
    );
  }
  async matchesOf(
    userId: string,
    opts: { gameMode?: GameMode; page: number; pageSize: number },
  ): Promise<Page<MatchRecord>> {
    const filter: Record<string, unknown> = {
      players: userId,
      status: 'COMPLETED',
    };
    if (opts.gameMode) filter.gameMode = opts.gameMode;
    const [items, total] = await Promise.all([
      this.matches
        .find(filter)
        .sort({ completedAt: -1 })
        .skip((opts.page - 1) * opts.pageSize)
        .limit(opts.pageSize)
        .lean<Doc<MatchRecord>[]>(),
      this.matches.countDocuments(filter),
    ]);
    return {
      items: items.map((d) => strip<MatchRecord>(d)!),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }
  async recentMatches(limit: number) {
    return (
      await this.matches
        .find({ status: 'COMPLETED' })
        .sort({ completedAt: -1 })
        .limit(limit)
        .lean<Doc<MatchRecord>[]>()
    ).map((d) => strip<MatchRecord>(d)!);
  }
  async countRankedBetween(
    a: string,
    b: string,
    since: number,
    discipline: Discipline,
  ) {
    return this.matches.countDocuments({
      discipline,
      gameMode: 'RANKED',
      status: 'COMPLETED',
      rated: true,
      completedAt: { $gte: since },
      players: { $all: [a, b] },
    });
  }
  async cancelStaleMatches(before: number) {
    const r = await this.matches.updateMany(
      { status: 'PLAYING', startedAt: { $lt: before } },
      { $set: { status: 'CANCELLED', endReason: 'Máy chủ khởi động lại' } },
    );
    return r.modifiedCount;
  }
  async updateMatchRating(
    matchId: string,
    patch: Pick<
      MatchRecord,
      'ratingBefore' | 'ratingChanges' | 'rated' | 'unratedReason'
    >,
  ) {
    await this.matches.updateOne({ matchId }, { $set: patch });
  }
  async addRankHistory(r: RankHistoryRecord) {
    try {
      await this.rankHistory.create(r);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  async activeSeason() {
    const s = strip<SeasonRecord>(
      await this.seasonModel
        .findOne({ status: 'ACTIVE' })
        .sort({ number: -1 })
        .lean<Doc<SeasonRecord>>(),
    );
    return s ? normalizeSeason(s) : null;
  }
  async saveSeason(s: SeasonRecord) {
    await this.seasonModel.replaceOne({ seasonId: s.seasonId }, s, {
      upsert: true,
    });
  }
  async seasons() {
    return (
      await this.seasonModel
        .find()
        .sort({ number: -1 })
        .lean<Doc<SeasonRecord>[]>()
    ).map((d) => normalizeSeason(strip<SeasonRecord>(d)!));
  }
  async saveTournament(t: TournamentRecord, expectedVersion: number | null) {
    if (expectedVersion === null) {
      try {
        await this.tournaments.create({ ...t, version: 1 });
        return true;
      } catch (e) {
        if ((e as { code?: number }).code === 11000) return false;
        throw e;
      }
    }
    const r = await this.tournaments.updateOne(
      { tournamentId: t.tournamentId, version: expectedVersion },
      { $set: { ...t, version: expectedVersion + 1 } },
    );
    return r.modifiedCount === 1;
  }
  async getTournament(id: string) {
    return strip<TournamentRecord>(
      await this.tournaments
        .findOne({ tournamentId: id })
        .lean<Doc<TournamentRecord>>(),
    );
  }
  async listTournaments(opts: {
    statuses?: TournamentStatus[];
    page: number;
    pageSize: number;
    search?: string;
  }) {
    const filter: Record<string, unknown> = {};
    if (opts.statuses) filter.status = { $in: opts.statuses };
    if (opts.search)
      filter.name = { $regex: escapeRegex(opts.search), $options: 'i' };
    const [items, total] = await Promise.all([
      this.tournaments
        .find(filter)
        .sort({ startAt: 1 })
        .skip((opts.page - 1) * opts.pageSize)
        .limit(opts.pageSize)
        .lean<Doc<TournamentRecord>[]>(),
      this.tournaments.countDocuments(filter),
    ]);
    return {
      items: items.map((d) => strip<TournamentRecord>(d)!),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }
  async activeTournaments() {
    return (
      await this.tournaments
        .find({ status: { $nin: ['COMPLETED', 'CANCELLED'] } })
        .lean<Doc<TournamentRecord>[]>()
    ).map((d) => strip<TournamentRecord>(d)!);
  }
  async upsertTournamentMatch(
    tournamentId: string,
    m: Bracket['rounds'][number][number],
  ) {
    await this.tournamentMatches.updateOne(
      { tournamentId, matchId: m.id },
      { $set: { ...m, tournamentId, matchId: m.id } },
      { upsert: true },
    );
  }
  async userNames(userIds: string[]) {
    const ids = userIds.filter((id) => /^[a-f0-9]{24}$/i.test(id));
    const docs = ids.length
      ? await this.users
          .find({ _id: { $in: ids } })
          .select('_id name avatar')
          .lean()
      : [];
    const out: Record<string, { name: string; avatar?: string }> = {};
    for (const d of docs)
      out[String(d._id)] = { name: d.name, avatar: d.avatar };
    return out;
  }
  async searchUserIds(query: string, limit: number) {
    const docs = await this.users
      .find({ name: { $regex: escapeRegex(query), $options: 'i' } })
      .select('_id')
      .limit(limit)
      .lean();
    return docs.map((d) => String(d._id));
  }
}
