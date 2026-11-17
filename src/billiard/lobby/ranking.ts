/** Logic thuần: rank, Elo, level, khoảng ghép trận (test được, không phụ thuộc DB) */
import { RANKING_CONFIG as R, type RankTier } from './ranking.config';

export function rankOf(rating: number): RankTier {
  let cur = R.ranks[0];
  for (const t of R.ranks) if (rating >= t.min) cur = t;
  return cur;
}

export function rankIndex(id: string): number {
  return R.ranks.findIndex((t) => t.id === id);
}

/** Tiến độ tới rank kế tiếp (0..1), null nếu đã cao nhất */
export function rankProgress(rating: number): {
  current: RankTier;
  next: RankTier | null;
  progress: number;
} {
  const current = rankOf(rating);
  const i = rankIndex(current.id);
  const next = R.ranks[i + 1] ?? null;
  if (!next) return { current, next: null, progress: 1 };
  const p = (rating - current.min) / (next.min - current.min);
  return { current, next, progress: Math.max(0, Math.min(1, p)) };
}

/** Điểm kỳ vọng Elo: E_A = 1 / (1 + 10^((R_B − R_A)/400)) */
export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

export function kFactorFor(rankedMatches: number): number {
  return rankedMatches < R.provisionalMatches
    ? R.kFactorProvisional
    : R.kFactor;
}

/** Cập nhật Elo cho cả hai người (scoreA: 1 thắng / 0 thua). Làm tròn số nguyên, không âm. */
export function eloUpdate(
  ra: number,
  rb: number,
  scoreA: 0 | 1,
  kA: number,
  kB: number,
): { a: number; b: number; deltaA: number; deltaB: number } {
  const ea = expectedScore(ra, rb);
  const eb = 1 - ea;
  const a = Math.max(R.minRating, Math.round(ra + kA * (scoreA - ea)));
  const b = Math.max(R.minRating, Math.round(rb + kB * (1 - scoreA - eb)));
  return { a, b, deltaA: a - ra, deltaB: b - rb };
}

export function levelOf(xp: number): {
  level: number;
  xp: number;
  nextAt: number;
} {
  const level = Math.floor(Math.sqrt(Math.max(0, xp) / R.level.xpBase)) + 1;
  return { level, xp, nextAt: level * level * R.level.xpBase };
}

/** Chênh lệch rating tối đa được ghép sau khi chờ `waitSeconds` */
export function searchRange(waitSeconds: number): number {
  const w = R.matchmaking.windows;
  let range = w[0].range;
  for (const step of w)
    if (waitSeconds >= step.afterSeconds) range = step.range;
  const last = w[w.length - 1];
  if (waitSeconds >= last.afterSeconds + 10) {
    const extra =
      Math.floor((waitSeconds - last.afterSeconds) / 10) *
      R.matchmaking.expandPer10Seconds;
    range = last.range + extra;
  }
  return Math.min(R.matchmaking.maxRange, range);
}

/** Reset mềm khi sang mùa mới */
export function softReset(rating: number): number {
  return Math.round(
    R.startRating + (rating - R.startRating) * R.season.softResetFactor,
  );
}

export function winRate(wins: number, losses: number): number {
  const n = wins + losses;
  return n ? Math.round((wins / n) * 1000) / 10 : 0;
}
