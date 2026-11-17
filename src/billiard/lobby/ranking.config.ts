/**
 * Cấu hình xếp hạng / mùa giải / tìm trận của Bida Carom.
 * Frontend lấy qua `bida:config:get` — không viết cứng mốc rank ở client.
 */
import type { CaromMode } from '../physics';

export interface RankTier {
  id: string;
  name: string;
  /** Rating tối thiểu (bao gồm) */
  min: number;
  color: string;
  icon: string;
}

export interface RuleSet {
  id: string;
  name: string;
  mode: CaromMode;
  target: number;
}

/** Tên loại bida theo chế độ engine */
export const MODE_NAMES: Record<CaromMode, string> = {
  free: 'Libre (phăng)',
  three: '3 băng',
};

/** Số điểm cho phép khi tạo giải đấu */
export const TOURNAMENT_TARGET = { min: 5, max: 30 } as const;

/** Bộ luật = loại bida + số điểm (mã dạng `free-10`, `three-5`) */
export function makeRuleSet(mode: CaromMode, target: number): RuleSet {
  return {
    id: `${mode}-${target}`,
    name: `${MODE_NAMES[mode]} ${target} điểm`,
    mode,
    target,
  };
}

/** Quick / Ranked chỉ đánh 15 điểm (cả Libre và 3 băng) */
export const MATCHMAKING_TARGETS = [15] as const;
/** Số điểm mặc định của Quick / Ranked */
export const DEFAULT_MATCH_TARGET = 15;

/** Bộ luật cố định cho Quick / Ranked: Libre & 3 băng × 15 / 20 điểm */
export const RULE_SETS: RuleSet[] = (['free', 'three'] as const).flatMap(
  (mode) => MATCHMAKING_TARGETS.map((t) => makeRuleSet(mode, t)),
);
export const RULE_SET_IDS = RULE_SETS.map((r) => r.id);

/** Đọc bộ luật từ mã (bộ luật cố định hoặc bộ luật giải đấu tuỳ chỉnh số điểm) */
export function ruleSetById(id: string): RuleSet | undefined {
  const fixed = RULE_SETS.find((r) => r.id === id);
  if (fixed) return fixed;
  const m = /^(free|three)-(\d{1,2})$/.exec(id);
  if (!m) return undefined;
  const target = Number(m[2]);
  if (target < TOURNAMENT_TARGET.min || target > TOURNAMENT_TARGET.max)
    return undefined;
  return makeRuleSet(m[1] as CaromMode, target);
}

export const RANKING_CONFIG = {
  startRating: 1000,
  /** Hệ số K: người mới (ít hơn provisionalMatches trận) biến động mạnh hơn */
  kFactor: 32,
  kFactorProvisional: 48,
  provisionalMatches: 10,
  minRating: 0,
  ranks: [
    { id: 'BRONZE', name: 'Bronze', min: 0, color: '#cd7f32', icon: '🥉' },
    { id: 'SILVER', name: 'Silver', min: 1000, color: '#c0c7d2', icon: '🥈' },
    { id: 'GOLD', name: 'Gold', min: 1200, color: '#f4b942', icon: '🥇' },
    {
      id: 'PLATINUM',
      name: 'Platinum',
      min: 1400,
      color: '#5eead4',
      icon: '💠',
    },
    { id: 'DIAMOND', name: 'Diamond', min: 1600, color: '#60a5fa', icon: '💎' },
    { id: 'MASTER', name: 'Master', min: 1800, color: '#c084fc', icon: '👑' },
    {
      id: 'GRANDMASTER',
      name: 'Grandmaster',
      min: 2000,
      color: '#f87171',
      icon: '🔥',
    },
  ] as RankTier[],
  matchmaking: {
    /** Khoảng rating theo thời gian chờ: [từ giây thứ, chênh lệch tối đa] */
    windows: [
      { afterSeconds: 0, range: 50 },
      { afterSeconds: 10, range: 100 },
      { afterSeconds: 20, range: 150 },
    ],
    /** Sau mốc cuối: mỗi 10 giây nới thêm, tới tối đa */
    expandPer10Seconds: 50,
    maxRange: 800,
    /** Thời gian xác nhận Accept */
    acceptSeconds: 15,
    /** Từ chối / không xác nhận: khoá tìm trận (giây) */
    declineLockSeconds: 30,
    /** Không vào phòng trận trong thời gian này: xử thua (nếu đối thủ có mặt) / huỷ */
    noShowSeconds: 90,
    /**
     * Luật đấu xếp hạng theo thể loại: chạm 15 điểm; mỗi thể loại một thang hạng riêng.
     */
    rankedRuleSets: {
      free: RULE_SETS.filter((r) => r.mode === 'free').map((r) => r.id),
      three: RULE_SETS.filter((r) => r.mode === 'three').map((r) => r.id),
    } as Record<CaromMode, string[]>,
    quickRuleSets: RULE_SET_IDS,
  },
  antiAbuse: {
    /** Quá số trận ranked với cùng đối thủ trong 24h thì không tính rating */
    maxRankedVsSameOpponentPerDay: 5,
  },
  season: {
    lengthDays: 30,
    /** Reset mềm: rating mới = start + (rating − start) × hệ số */
    softResetFactor: 0.5,
    finalStandingsSize: 100,
  },
  level: {
    xpPerMatch: 10,
    xpPerWin: 15,
    /** level = floor(sqrt(xp / xpBase)) + 1 */
    xpBase: 50,
  },
  tournament: {
    sizes: [4, 8, 16, 32, 64],
    checkInMinutes: 10,
    targetMin: TOURNAMENT_TARGET.min,
    targetMax: TOURNAMENT_TARGET.max,
    maxActivePerOrganizer: 3,
    createCooldownSeconds: 60,
  },
  casual: {
    turnSecondsOptions: [30, 45, 60, 90],
  },
};

export type RankingConfig = typeof RANKING_CONFIG;
