/* eslint-disable @typescript-eslint/require-await -- kho bộ nhớ cho test: cùng giao diện async với bản Mongo */
/** Kho dữ liệu trong bộ nhớ — cho test (cùng hành vi idempotency với bản Mongo) */
import type { Bracket } from './bracket';
import type {
  BilliardProfile,
  BilliardStore,
  GameMode,
  MatchRecord,
  Page,
  RankHistoryRecord,
  SeasonRecord,
  TournamentRecord,
  TournamentStatus,
} from './store.types';
import { newProfile } from './profile.factory';
import type { Discipline } from './store.types';

const clone = <T>(v: T): T => structuredClone(v);
const paginate = <T>(all: T[], page: number, pageSize: number): Page<T> => ({
  items: all.slice((page - 1) * pageSize, page * pageSize),
  total: all.length,
  page,
  pageSize,
});

export class MemoryBilliardStore implements BilliardStore {
  profiles = new Map<string, BilliardProfile>();
  matches = new Map<string, MatchRecord>();
  rankHistory: RankHistoryRecord[] = [];
  seasonList: SeasonRecord[] = [];
  tournaments = new Map<string, TournamentRecord>();
  tournamentMatches = new Map<string, Bracket['rounds'][number][number]>();
  users = new Map<string, { name: string; avatar?: string }>();

  async getProfile(userId: string) {
    const p = this.profiles.get(userId);
    return p ? clone(p) : null;
  }
  async ensureProfile(userId: string, seasonId: string) {
    if (!this.profiles.has(userId))
      this.profiles.set(userId, newProfile(userId, seasonId));
    return clone(this.profiles.get(userId)!);
  }
  async saveProfile(p: BilliardProfile) {
    this.profiles.set(p.userId, clone(p));
  }
  private ranked(seasonId: string, d: Discipline) {
    return [...this.profiles.values()]
      .filter(
        (p) =>
          p.seasonId === seasonId &&
          p.ladders[d].season.wins + p.ladders[d].season.losses > 0,
      )
      .sort(
        (a, b) =>
          b.ladders[d].rating - a.ladders[d].rating ||
          a.userId.localeCompare(b.userId),
      );
  }
  async profilesByRating(opts: {
    discipline: Discipline;
    userIds?: string[];
    page: number;
    pageSize: number;
    seasonId: string;
  }) {
    let all = this.ranked(opts.seasonId, opts.discipline);
    if (opts.userIds) all = all.filter((p) => opts.userIds!.includes(p.userId));
    return clone(paginate(all, opts.page, opts.pageSize));
  }
  async positionOf(userId: string, seasonId: string, d: Discipline) {
    const i = this.ranked(seasonId, d).findIndex((p) => p.userId === userId);
    return i < 0 ? null : i + 1;
  }
  async allProfiles() {
    return [...this.profiles.values()].map(clone);
  }

  async createMatch(m: MatchRecord) {
    if (this.matches.has(m.matchId)) return false;
    this.matches.set(m.matchId, clone(m));
    return true;
  }
  async completeMatch(matchId: string, patch: Partial<MatchRecord>) {
    const m = this.matches.get(matchId);
    if (!m || m.status !== 'PLAYING') return null;
    Object.assign(m, clone(patch));
    return clone(m);
  }
  async getMatch(matchId: string) {
    const m = this.matches.get(matchId);
    return m ? clone(m) : null;
  }
  async matchesOf(
    userId: string,
    opts: { gameMode?: GameMode; page: number; pageSize: number },
  ) {
    const all = [...this.matches.values()]
      .filter(
        (m) =>
          m.players.includes(userId) &&
          m.status === 'COMPLETED' &&
          (!opts.gameMode || m.gameMode === opts.gameMode),
      )
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    return clone(paginate(all, opts.page, opts.pageSize));
  }
  async recentMatches(limit: number) {
    return [...this.matches.values()]
      .filter((m) => m.status === 'COMPLETED')
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, limit)
      .map(clone);
  }
  async countRankedBetween(a: string, b: string, since: number, d: Discipline) {
    return [...this.matches.values()].filter(
      (m) =>
        m.discipline === d &&
        m.gameMode === 'RANKED' &&
        m.status === 'COMPLETED' &&
        m.rated &&
        (m.completedAt ?? 0) >= since &&
        m.players.includes(a) &&
        m.players.includes(b),
    ).length;
  }
  async cancelStaleMatches(before: number) {
    let n = 0;
    for (const m of this.matches.values())
      if (m.status === 'PLAYING' && m.startedAt < before) {
        m.status = 'CANCELLED';
        m.endReason = 'Máy chủ khởi động lại';
        n++;
      }
    return n;
  }
  async updateMatchRating(
    matchId: string,
    patch: Pick<
      MatchRecord,
      'ratingBefore' | 'ratingChanges' | 'rated' | 'unratedReason'
    >,
  ) {
    const m = this.matches.get(matchId);
    if (m) Object.assign(m, clone(patch));
  }
  async addRankHistory(r: RankHistoryRecord) {
    this.rankHistory.push(clone(r));
  }
  async activeSeason() {
    const s = this.seasonList.find((x) => x.status === 'ACTIVE');
    return s ? clone(s) : null;
  }
  async saveSeason(s: SeasonRecord) {
    const i = this.seasonList.findIndex((x) => x.seasonId === s.seasonId);
    if (i >= 0) this.seasonList[i] = clone(s);
    else this.seasonList.push(clone(s));
  }
  async seasons() {
    return this.seasonList.map(clone).sort((a, b) => b.number - a.number);
  }
  async saveTournament(t: TournamentRecord, expectedVersion: number | null) {
    const cur = this.tournaments.get(t.tournamentId);
    if (
      expectedVersion === null ? !!cur : !cur || cur.version !== expectedVersion
    )
      return false;
    this.tournaments.set(
      t.tournamentId,
      clone({ ...t, version: (expectedVersion ?? 0) + 1 }),
    );
    return true;
  }
  async getTournament(id: string) {
    const t = this.tournaments.get(id);
    return t ? clone(t) : null;
  }
  async listTournaments(opts: {
    statuses?: TournamentStatus[];
    page: number;
    pageSize: number;
    search?: string;
  }) {
    const q = opts.search?.toLowerCase();
    const all = [...this.tournaments.values()]
      .filter(
        (t) =>
          (!opts.statuses || opts.statuses.includes(t.status)) &&
          (!q || t.name.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.startAt - b.startAt);
    return clone(paginate(all, opts.page, opts.pageSize));
  }
  async activeTournaments() {
    return [...this.tournaments.values()]
      .filter((t) => !['COMPLETED', 'CANCELLED'].includes(t.status))
      .map(clone);
  }
  async upsertTournamentMatch(
    tournamentId: string,
    m: Bracket['rounds'][number][number],
  ) {
    this.tournamentMatches.set(`${tournamentId}:${m.id}`, clone(m));
  }
  async userNames(userIds: string[]) {
    const out: Record<string, { name: string; avatar?: string }> = {};
    for (const id of userIds) out[id] = this.users.get(id) ?? { name: id };
    return out;
  }
  async searchUserIds(query: string, limit: number) {
    const q = query.toLowerCase();
    return [...this.users.entries()]
      .filter(([, u]) => u.name.toLowerCase().includes(q))
      .slice(0, limit)
      .map(([id]) => id);
  }
}
