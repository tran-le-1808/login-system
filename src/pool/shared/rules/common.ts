// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import type { BallSpot, ShotResult } from '../physics/types';
import { POOL_TABLE } from '../physics/table';
import { defaultCueSpot, spotBall, withCueAt } from './rack';
import type { Group, PlayerIndex, RackState, RuleMessage } from './types';

export const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

export const groupOf = (n: number): Group | null =>
  n >= 1 && n <= 7 ? 'solids' : n >= 9 && n <= 15 ? 'stripes' : null;

export const GROUP_LABEL: Record<Group, string> = {
  solids: 'bi trơn (1–7)',
  stripes: 'bi sọc (9–15)',
};

export const objectBalls = (balls: BallSpot[]) =>
  balls.filter((b) => b.n !== 0).map((b) => b.n);

/** Bi số nhỏ nhất còn trên bàn (9 bi) */
export function lowestBall(balls: BallSpot[]): number | null {
  const obs = objectBalls(balls);
  return obs.length ? Math.min(...obs) : null;
}

/** Người chơi đã sạch nhóm (8 bi) — tính trên vị trí ĐẦU cú đánh */
export function groupCleared(rack: RackState, p: PlayerIndex): boolean {
  const g = rack.groups[p];
  if (!g) return false;
  return !rack.balls.some((b) => groupOf(b.n) === g);
}

/** Bi người chơi được phép chạm đầu tiên ở vị trí hiện tại */
export function legalTargets(
  rack: RackState,
  p: PlayerIndex = rack.turn,
): number[] {
  const obs = objectBalls(rack.balls);
  if (rack.type === 'nine') {
    if (rack.decision) return [];
    const low = lowestBall(rack.balls);
    return low === null ? [] : [low];
  }
  if (rack.isBreak) return obs;
  // Bi trong tay sau vạch (scratch khi phá): chỉ được nhắm bi nằm trước head string
  if (rack.restrictToFrontOfHeadString) {
    const front = new Set(
      rack.balls.filter((b) => b.x > POOL_TABLE.headStringX).map((b) => b.n),
    );
    return legalTargets(
      { ...rack, restrictToFrontOfHeadString: false },
      p,
    ).filter((n) => front.has(n));
  }
  if (rack.openTable) return obs.filter((n) => n !== 8);
  if (groupCleared(rack, p)) return obs.filter((n) => n === 8);
  const g = rack.groups[p];
  return obs.filter((n) => groupOf(n) === g);
}

export const potted = (res: ShotResult) =>
  res.pocketed.map((p) => p.ball).filter((n) => n !== 0);

/** Sau lỗi: bàn sau cú đánh + bi cái (nếu vừa rơi lỗ thì đặt ở vị trí mặc định để kéo thả) */
export function ensureCue(balls: BallSpot[], kitchen: boolean): BallSpot[] {
  if (balls.some((b) => b.n === 0)) return balls;
  const p = defaultCueSpot(balls, kitchen);
  return withCueAt(balls, p.x, p.y);
}

export function respot(balls: BallSpot[], n: number): BallSpot[] {
  return spotBall(balls, n);
}

/** Mô tả bi nào văng khỏi bàn ("Bi cái văng khỏi bàn", "Bi 3, 7 văng khỏi bàn") */
export function offTableText(res: Pick<ShotResult, 'offTable'>): string {
  const cue = res.offTable.includes(0);
  const others = res.offTable.filter((n) => n !== 0);
  const parts: string[] = [];
  if (cue) parts.push('bi cái');
  if (others.length) parts.push(`bi ${others.join(', ')}`);
  const t = parts.join(' và ');
  return `${t.charAt(0).toUpperCase()}${t.slice(1)} văng khỏi bàn`;
}

export const msg = (tone: RuleMessage['tone'], text: string): RuleMessage => ({
  tone,
  text,
});
