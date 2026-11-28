/**
 * MÁY CHƠI SẮC MÀU (dùng chung cho trình duyệt và server).
 *  - easy: đánh lá hợp lệ bất kỳ, hay quên báo
 *  - normal: giữ lá Đổi sắc, ưu tiên hệ mình có nhiều, chọn hệ theo bài trên tay
 *  - hard: như normal + ép người sắp hết bài (Chặn / +2 / +4), xả lá điểm cao khi đối thủ sắp thắng
 */
import {
  colorOf,
  DRAW2,
  isWild,
  playable,
  REVERSE,
  SKIP,
  valueOf,
  WILD4,
  cardPoints,
  type SMState,
} from './cards';

export type SMBotLevel = 'easy' | 'normal' | 'hard';
export const SM_BOT_LEVELS: Record<SMBotLevel, string> = {
  easy: 'Dễ',
  normal: 'Vừa',
  hard: 'Khó',
};

export type SMBotAction =
  | { kind: 'play'; card: number; color?: number; call: boolean }
  | { kind: 'draw' }
  | { kind: 'pass' };

/** Hệ có nhiều lá nhất trên tay (không tính lá Đổi sắc) */
export function bestColor(
  hand: readonly number[],
  rng: () => number = Math.random,
): number {
  const cnt = [0, 0, 0, 0];
  for (const c of hand)
    if (!isWild(c)) cnt[colorOf(c)] += 1 + cardPoints(c) / 40;
  const max = Math.max(...cnt);
  if (max === 0) return Math.floor(rng() * 4);
  return cnt.indexOf(max);
}

export function botAction(
  s: SMState,
  seat: number,
  level: SMBotLevel,
  rng: () => number = Math.random,
): SMBotAction {
  const opts = playable(s, seat);
  if (!opts.length)
    return s.drawn !== null ? { kind: 'pass' } : { kind: 'draw' };
  const hand = s.hands[seat];
  const call = hand.length === 2 && (level !== 'easy' || rng() < 0.6);
  if (level === 'easy') {
    const card = opts[Math.floor(rng() * opts.length)];
    return {
      kind: 'play',
      card,
      color: isWild(card) ? Math.floor(rng() * 4) : undefined,
      call,
    };
  }
  const nextSeat = (((seat + s.dir) % s.n) + s.n) % s.n;
  const nextCount = s.hands[nextSeat].length;
  const minOther = Math.min(
    ...s.hands.map((h, i) => (i === seat ? 99 : h.length)),
  );
  const cnt = [0, 0, 0, 0];
  for (const c of hand) if (!isWild(c)) cnt[colorOf(c)]++;
  // hệ người kế tiếp vừa phải bốc vì không có (chỉ nhớ các lần bốc gần đây)
  const lacks = new Set<number>();
  if (level === 'hard')
    for (const e of s.events.slice(-12)) {
      if (
        e.seat === nextSeat &&
        e.kind === 'draw' &&
        e.count === 1 &&
        e.color !== undefined
      )
        lacks.add(e.color);
      if (e.seat === nextSeat && e.kind === 'play' && e.color !== undefined)
        lacks.delete(e.color);
    }
  const score = (c: number) => {
    const v = valueOf(c);
    let sc = 0;
    if (isWild(c))
      sc -= 40; // giữ đổi sắc cho lúc cần
    else sc += cnt[colorOf(c)] * 4; // xả hệ mình nhiều
    if (level === 'hard') {
      const pressure = nextCount <= 2;
      if (
        pressure &&
        (v === SKIP || v === DRAW2 || v === WILD4 || (v === REVERSE && s.n > 2))
      )
        sc += 60;
      if (minOther <= 2) sc += cardPoints(c) / 2; // đối thủ sắp thắng: xả lá điểm cao
      if (v === WILD4 && !pressure && hand.length > 3) sc -= 30;
      if (!isWild(c) && lacks.has(colorOf(c))) sc += 25;
    }
    sc += cardPoints(c) / 10;
    return sc;
  };
  const card = opts.slice().sort((a, b) => score(b) - score(a))[0];
  // lá vừa bốc mà là đổi sắc: normal vẫn đánh luôn
  let color: number | undefined;
  if (isWild(card)) {
    const rest = hand.filter((c) => c !== card);
    const mine = bestColor(rest, rng);
    // ép hệ đối thủ thiếu nếu mình cũng có lá hệ đó
    const forced = [...lacks].find((col) =>
      rest.some((c) => colorOf(c) === col),
    );
    color = forced ?? mine;
  }
  return { kind: 'play', card, color, call };
}
