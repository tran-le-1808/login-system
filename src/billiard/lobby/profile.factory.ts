import { RANKING_CONFIG as R } from './ranking.config';
import { rankOf } from './ranking';
import type {
  BilliardProfile,
  Discipline,
  Ladder,
  SeasonRecord,
  SeasonStanding,
} from './store.types';

export function newLadder(): Ladder {
  return {
    rating: R.startRating,
    peakRating: R.startRating,
    bestRankId: rankOf(R.startRating).id,
    season: { wins: 0, losses: 0 },
    ranked: { wins: 0, losses: 0 },
    seasonHistory: [],
  };
}

export function newProfile(userId: string, seasonId: string): BilliardProfile {
  return {
    userId,
    seasonId,
    ladders: { free: newLadder(), three: newLadder() },
    casual: { wins: 0, losses: 0 },
    quick: { wins: 0, losses: 0 },
    tournament: { wins: 0, losses: 0, titles: 0, played: 0 },
    totalMatches: 0,
    totalWins: 0,
    totalLosses: 0,
    xp: 0,
    updatedAt: Date.now(),
  };
}

type LegacyProfile = Partial<BilliardProfile> & {
  rating?: number;
  peakRating?: number;
  bestRankId?: string;
  season?: { wins: number; losses: number };
  ranked?: { wins: number; losses: number };
  seasonHistory?: Ladder['seasonHistory'];
};

/** Hồ sơ dạng cũ (một rating chung) -> thang Libre; thang 3 băng bắt đầu mới */
export function normalizeProfile(
  raw: LegacyProfile & { userId: string; seasonId: string },
): BilliardProfile {
  const base = newProfile(raw.userId, raw.seasonId);
  const ladders = raw.ladders ?? {
    free: {
      ...newLadder(),
      ...(raw.rating !== undefined ? { rating: raw.rating } : {}),
      ...(raw.peakRating !== undefined ? { peakRating: raw.peakRating } : {}),
      ...(raw.bestRankId ? { bestRankId: raw.bestRankId } : {}),
      ...(raw.season ? { season: raw.season } : {}),
      ...(raw.ranked ? { ranked: raw.ranked } : {}),
      ...(raw.seasonHistory ? { seasonHistory: raw.seasonHistory } : {}),
    },
    three: newLadder(),
  };
  return {
    userId: raw.userId,
    seasonId: raw.seasonId,
    ladders: {
      free: ladders.free ?? newLadder(),
      three: ladders.three ?? newLadder(),
    },
    casual: raw.casual ?? base.casual,
    quick: raw.quick ?? base.quick,
    tournament: raw.tournament ?? base.tournament,
    totalMatches: raw.totalMatches ?? 0,
    totalWins: raw.totalWins ?? 0,
    totalLosses: raw.totalLosses ?? 0,
    xp: raw.xp ?? 0,
    updatedAt: raw.updatedAt ?? Date.now(),
  };
}

/** Mùa dạng cũ (một bảng thứ hạng) -> bảng Libre */
export function normalizeSeason(
  s: Omit<SeasonRecord, 'finalStandings'> & { finalStandings: unknown },
): SeasonRecord {
  const fs = s.finalStandings;
  const standings: Record<Discipline, SeasonStanding[]> = Array.isArray(fs)
    ? { free: fs as SeasonStanding[], three: [] }
    : {
        free: [],
        three: [],
        ...((fs ?? {}) as Partial<Record<Discipline, SeasonStanding[]>>),
      };
  return { ...s, finalStandings: standings };
}
