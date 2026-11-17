/** Kiểu dữ liệu lưu trữ của hệ thống xếp hạng / giải đấu Bida Carom */
import type { Bracket, BracketFormat } from './bracket';

export type GameMode = 'RANKED' | 'CASUAL' | 'TOURNAMENT' | 'QUICK';
export type MatchStatus = 'WAITING' | 'PLAYING' | 'COMPLETED' | 'CANCELLED';
export type TournamentStatus =
  | 'DRAFT'
  | 'REGISTRATION'
  | 'FULL'
  | 'CHECK_IN'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

export interface WL {
  wins: number;
  losses: number;
}

/** Thể loại bida = chế độ engine: free = Libre (phăng), three = 3 băng — mỗi thể loại một thang xếp hạng riêng */
export type Discipline = 'free' | 'three';
export const DISCIPLINES: Discipline[] = ['free', 'three'];

export interface SeasonHistoryEntry {
  seasonId: string;
  name: string;
  rating: number;
  rankId: string;
  wins: number;
  losses: number;
  position: number | null;
}

/** Thang xếp hạng của một thể loại */
export interface Ladder {
  rating: number;
  peakRating: number;
  bestRankId: string;
  /** Thắng / thua xếp hạng trong mùa hiện tại */
  season: WL;
  /** Thắng / thua xếp hạng mọi mùa */
  ranked: WL;
  seasonHistory: SeasonHistoryEntry[];
}

export interface BilliardProfile {
  userId: string;
  seasonId: string;
  ladders: Record<Discipline, Ladder>;
  casual: WL;
  quick: WL;
  tournament: WL & { titles: number; played: number };
  totalMatches: number;
  totalWins: number;
  totalLosses: number;
  xp: number;
  updatedAt: number;
}

export interface SeasonStanding {
  position: number;
  userId: string;
  rating: number;
  rankId: string;
  wins: number;
  losses: number;
}

export interface MatchRecord {
  matchId: string;
  roomCode: string;
  gameMode: GameMode;
  ruleSet: string;
  /** Thể loại bida của trận (theo luật) */
  discipline: Discipline;
  players: [string, string];
  names: [string, string];
  status: MatchStatus;
  winnerId: string | null;
  score: [number, number];
  ratingBefore: [number, number] | null;
  ratingChanges: [number, number] | null;
  rated: boolean;
  unratedReason: string | null;
  tournamentId: string | null;
  tournamentMatchId: string | null;
  seasonId: string | null;
  endReason: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
}

export interface RankHistoryRecord {
  userId: string;
  matchId: string;
  seasonId: string;
  discipline: Discipline;
  before: number;
  after: number;
  delta: number;
  rankBefore: string;
  rankAfter: string;
  at: number;
}

export interface SeasonRecord {
  seasonId: string;
  name: string;
  number: number;
  startAt: number;
  endAt: number;
  status: 'ACTIVE' | 'ENDED';
  /** Thứ hạng cuối mùa theo từng thể loại */
  finalStandings: Record<Discipline, SeasonStanding[]>;
}

export interface TournamentParticipant {
  userId: string;
  name: string;
  avatar?: string;
  rating: number;
  checkedIn: boolean;
  joinedAt: number;
}

export interface TournamentRecord {
  tournamentId: string;
  name: string;
  description: string;
  thumbnail: string | null;
  organizerId: string;
  organizerName: string;
  maxParticipants: number;
  participants: TournamentParticipant[];
  ruleSet: string;
  format: BracketFormat;
  seeding: 'random' | 'rating';
  status: TournamentStatus;
  startAt: number;
  registrationDeadline: number;
  checkInAt: number;
  matchDurationMinutes: number;
  visibility: 'PUBLIC' | 'PRIVATE';
  passwordHash: string | null;
  entryFee: number | null;
  prizePool: number | null;
  bracket: Bracket | null;
  championId: string | null;
  cancelReason: string | null;
  createdAt: number;
  updatedAt: number;
  /** Tăng mỗi lần lưu (chống ghi đè) */
  version: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Lớp lưu trữ — bản Mongo cho production, bản bộ nhớ cho test */
export interface BilliardStore {
  getProfile(userId: string): Promise<BilliardProfile | null>;
  /** Tạo hồ sơ nếu chưa có (nguyên tử: upsert) */
  ensureProfile(userId: string, seasonId: string): Promise<BilliardProfile>;
  saveProfile(p: BilliardProfile): Promise<void>;
  profilesByRating(opts: {
    discipline: Discipline;
    userIds?: string[];
    page: number;
    pageSize: number;
    seasonId: string;
  }): Promise<Page<BilliardProfile>>;
  /** Vị trí (1-based) theo rating trong mùa hiện tại */
  positionOf(
    userId: string,
    seasonId: string,
    discipline: Discipline,
  ): Promise<number | null>;
  allProfiles(): Promise<BilliardProfile[]>;

  createMatch(m: MatchRecord): Promise<boolean>;
  /** Cửa idempotency: chỉ chuyển PLAYING -> COMPLETED/CANCELLED một lần. Trả về bản ghi nếu thành công. */
  completeMatch(
    matchId: string,
    patch: Partial<MatchRecord>,
  ): Promise<MatchRecord | null>;
  getMatch(matchId: string): Promise<MatchRecord | null>;
  matchesOf(
    userId: string,
    opts: { gameMode?: GameMode; page: number; pageSize: number },
  ): Promise<Page<MatchRecord>>;
  recentMatches(limit: number): Promise<MatchRecord[]>;
  countRankedBetween(
    a: string,
    b: string,
    since: number,
    discipline: Discipline,
  ): Promise<number>;
  cancelStaleMatches(before: number): Promise<number>;
  updateMatchRating(
    matchId: string,
    patch: Pick<
      MatchRecord,
      'ratingBefore' | 'ratingChanges' | 'rated' | 'unratedReason'
    >,
  ): Promise<void>;

  addRankHistory(r: RankHistoryRecord): Promise<void>;

  activeSeason(): Promise<SeasonRecord | null>;
  saveSeason(s: SeasonRecord): Promise<void>;
  seasons(): Promise<SeasonRecord[]>;

  saveTournament(
    t: TournamentRecord,
    expectedVersion: number | null,
  ): Promise<boolean>;
  getTournament(id: string): Promise<TournamentRecord | null>;
  listTournaments(opts: {
    statuses?: TournamentStatus[];
    page: number;
    pageSize: number;
    search?: string;
  }): Promise<Page<TournamentRecord>>;
  activeTournaments(): Promise<TournamentRecord[]>;
  upsertTournamentMatch(
    tournamentId: string,
    m: Bracket['rounds'][number][number],
  ): Promise<void>;

  userNames(
    userIds: string[],
  ): Promise<Record<string, { name: string; avatar?: string }>>;
  searchUserIds(query: string, limit: number): Promise<string[]>;
}
