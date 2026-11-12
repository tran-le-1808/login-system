import type { BallId, PhysicsEvent } from './types';

/**
 * RULE ENGINE CAROM — tách biệt khỏi physics: chỉ đọc chuỗi sự kiện va chạm.
 * Thêm biến thể luật = thêm 1 nhánh ở đây, không phải sửa thuật toán va chạm.
 */
export type CaromMode = 'free' | 'three';

export interface CaromRuleOptions {
  mode: CaromMode;
  /**
   * 3 băng: luật UMB tính MỌI lần chạm băng của bi cái trước khi chạm bi mục tiêu thứ hai
   * (kể cả trước bi thứ nhất). Đặt true để chỉ tính các băng SAU khi chạm bi thứ nhất.
   */
  cushionsAfterFirstBallOnly?: boolean;
  /** Số băng tối thiểu cho 3 băng */
  requiredCushions?: number;
}

export interface ShotVerdict {
  scored: boolean;
  /** Bi mục tiêu chạm đầu tiên / thứ hai (null nếu không chạm) */
  firstBall: BallId | null;
  secondBall: BallId | null;
  /** Số lần chạm băng của bi cái trước khi chạm bi thứ hai (hoặc cả cú nếu không chạm) */
  cushionsBeforeSecond: number;
  /** Tổng số lần bi cái chạm băng */
  cueCushions: number;
  /** Bi cái không chạm bi nào */
  missedAll: boolean;
  reason: string;
}

export function judgeShot(
  events: PhysicsEvent[],
  cue: BallId,
  opts: CaromRuleOptions,
): ShotVerdict {
  const required = opts.requiredCushions ?? 3;
  let firstBall: BallId | null = null;
  let secondBall: BallId | null = null;
  let cushionsTotal = 0;
  let cushionsAfterFirst = 0;
  let cushionsBeforeSecond = -1;

  for (const e of events) {
    if (e.type === 'cushion') {
      if (e.ball !== cue) continue;
      cushionsTotal++;
      if (firstBall !== null && secondBall === null) cushionsAfterFirst++;
      continue;
    }
    if (e.type !== 'ball' || (e.a !== cue && e.b !== cue)) continue;
    const other = e.a === cue ? e.b : e.a;
    if (firstBall === null) {
      firstBall = other;
    } else if (secondBall === null && other !== firstBall) {
      secondBall = other;
      cushionsBeforeSecond = opts.cushionsAfterFirstBallOnly
        ? cushionsAfterFirst
        : cushionsTotal;
    }
  }

  const counted =
    cushionsBeforeSecond >= 0
      ? cushionsBeforeSecond
      : opts.cushionsAfterFirstBallOnly
        ? cushionsAfterFirst
        : cushionsTotal;
  const touchedBoth = firstBall !== null && secondBall !== null;

  let scored = false;
  let reason: string;
  if (firstBall === null) reason = 'Bi cái không chạm bi nào';
  else if (!touchedBoth) reason = 'Bi cái chỉ chạm 1 bi';
  else if (opts.mode === 'free') {
    scored = true;
    reason = 'Chạm đủ 2 bi';
  } else if (counted >= required) {
    scored = true;
    reason = `${counted} băng trước bi thứ hai`;
  } else {
    reason = `Chỉ ${counted} băng trước bi thứ hai (cần ${required})`;
  }

  return {
    scored,
    firstBall,
    secondBall,
    cushionsBeforeSecond: counted,
    cueCushions: cushionsTotal,
    missedAll: firstBall === null,
    reason,
  };
}
