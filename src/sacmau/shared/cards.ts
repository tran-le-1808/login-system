/**
 * SẮC MÀU — game bài đổi màu (thuần TypeScript, dùng chung cho trình duyệt và server).
 *
 * Bộ 108 lá, 4 hệ: Lửa, Nước, Lá, Gió. Mỗi hệ: một lá 0, hai lá mỗi số 1–9, hai Chặn, hai Đảo chiều, hai +2.
 * Thêm 4 lá Đổi sắc và 4 lá Đổi sắc +4.
 * Lượt: đánh lá cùng hệ hoặc cùng số / cùng chức năng, hoặc lá Đổi sắc. Không đánh thì bốc 1 lá
 * (lá vừa bốc đánh được thì có thể đánh luôn). Còn 1 lá phải "Báo!", quên báo bị phạt bốc 2.
 * +2 / +4: người kế tiếp bốc và mất lượt; bật "cộng dồn" thì được chồng +2 lên +2, +4 lên +2 / +4.
 * Hết bài trước là thắng, ăn điểm bài còn lại của mọi người (số = điểm số, chức năng 20, đổi sắc 50).
 * Hết bài để bốc mà cả bàn đi một vòng không ai đánh được: ván dừng, người ít điểm bài nhất thắng.
 */

export const COLOR_NAME = ['Lửa', 'Nước', 'Lá', 'Gió'];
export const WILD = 4;
/** Giá trị: 0–9 số, 10 Chặn, 11 Đảo chiều, 12 +2, 13 Đổi sắc, 14 Đổi sắc +4 */
export const SKIP = 10;
export const REVERSE = 11;
export const DRAW2 = 12;
export const WILDCARD = 13;
export const WILD4 = 14;

export interface CardInfo {
  color: number;
  value: number;
}

/** Bảng lá bài theo id 0..107 */
export const CARDS: CardInfo[] = (() => {
  const out: CardInfo[] = [];
  for (let c = 0; c < 4; c++) {
    out.push({ color: c, value: 0 });
    for (let v = 1; v <= 12; v++)
      out.push({ color: c, value: v }, { color: c, value: v });
  }
  for (let i = 0; i < 4; i++) out.push({ color: WILD, value: WILDCARD });
  for (let i = 0; i < 4; i++) out.push({ color: WILD, value: WILD4 });
  return out;
})();

export const colorOf = (id: number) => CARDS[id].color;
export const valueOf = (id: number) => CARDS[id].value;
export const isWild = (id: number) => CARDS[id].color === WILD;
export function cardLabel(id: number): string {
  const { color, value } = CARDS[id];
  const v =
    value <= 9
      ? String(value)
      : value === SKIP
        ? 'Chặn'
        : value === REVERSE
          ? 'Đảo chiều'
          : value === DRAW2
            ? '+2'
            : value === WILDCARD
              ? 'Đổi sắc'
              : 'Đổi sắc +4';
  return color === WILD ? v : `${v} ${COLOR_NAME[color]}`;
}
export const cardPoints = (id: number) => {
  const v = valueOf(id);
  return v <= 9 ? v : v <= DRAW2 ? 20 : 50;
};

export interface SMSettings {
  /** Cho phép cộng dồn +2 / +4 */
  stack: boolean;
}

export interface SMEvent {
  seat: number;
  kind: 'play' | 'draw' | 'pass' | 'penalty' | 'skip' | 'win' | 'call';
  card?: number;
  count?: number;
  color?: number;
}

export interface SMState {
  n: number;
  hands: number[][];
  /** Chồng bốc (lá trên cùng ở cuối mảng) */
  pile: number[];
  /** Chồng bài đã đánh (lá trên cùng ở cuối) */
  discard: number[];
  /** Hệ hiện tại (sau Đổi sắc là hệ được chọn) */
  color: number;
  turn: number;
  dir: 1 | -1;
  /** Số lá đang chờ bốc do +2 / +4 */
  pending: number;
  /** Lá vừa bốc của người đang tới lượt (được đánh luôn hoặc bỏ lượt) */
  drawn: number | null;
  over: boolean;
  winner: number | null;
  settings: SMSettings;
  events: SMEvent[];
  /** Ghế đã báo khi còn 1 lá */
  called: boolean[];
  /** Số lượt liên tiếp bốc mà không còn bài để bốc (đủ một vòng thì dừng ván) */
  stall: number;
}

export type SMError =
  | 'GAME_OVER'
  | 'NOT_YOUR_TURN'
  | 'NOT_IN_HAND'
  | 'CANNOT_PLAY'
  | 'NEED_COLOR'
  | 'MUST_PLAY_DRAWN'
  | 'CANNOT_PASS'
  | 'ALREADY_DREW';
export const SM_ERROR_VI: Record<SMError, string> = {
  GAME_OVER: 'Ván đã kết thúc',
  NOT_YOUR_TURN: 'Chưa tới lượt của bạn',
  NOT_IN_HAND: 'Bạn không có lá này',
  CANNOT_PLAY: 'Lá này không đánh được lúc này',
  NEED_COLOR: 'Hãy chọn hệ cho lá Đổi sắc',
  MUST_PLAY_DRAWN: 'Chỉ được đánh lá vừa bốc (hoặc bỏ lượt)',
  CANNOT_PASS: 'Phải bốc bài trước khi bỏ lượt',
  ALREADY_DREW: 'Bạn đã bốc rồi',
};

export function shuffled(
  ids: number[],
  rng: () => number = Math.random,
): number[] {
  const d = ids.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function deal(
  n: number,
  starter = 0,
  settings: SMSettings = { stack: true },
  rng: () => number = Math.random,
): SMState {
  let pile = shuffled(
    CARDS.map((_, i) => i),
    rng,
  );
  const hands: number[][] = Array.from({ length: n }, () => []);
  for (let k = 0; k < 7; k++)
    for (let i = 0; i < n; i++) hands[i].push(pile.pop()!);
  // lá mở đầu phải là lá số
  let first = pile.pop()!;
  while (valueOf(first) > 9) {
    pile.unshift(first);
    first = pile.pop()!;
  }
  pile = pile.slice();
  return {
    n,
    hands: hands.map(sortHand),
    pile,
    discard: [first],
    color: colorOf(first),
    turn: starter % n,
    dir: 1,
    pending: 0,
    drawn: null,
    over: false,
    winner: null,
    settings,
    events: [],
    called: new Array<boolean>(n).fill(false),
    stall: 0,
  };
}

export function sortHand(h: number[]): number[] {
  return h
    .slice()
    .sort(
      (a, b) => colorOf(a) - colorOf(b) || valueOf(a) - valueOf(b) || a - b,
    );
}

export const topCard = (s: SMState) => s.discard[s.discard.length - 1];

/** Lá `card` có đánh được lên bàn hiện tại không (chưa xét lá vừa bốc) */
export function canPlay(s: SMState, card: number): boolean {
  const v = valueOf(card);
  if (s.pending > 0) {
    if (!s.settings.stack) return false;
    const top = valueOf(topCard(s));
    return v === WILD4 || (v === DRAW2 && top === DRAW2);
  }
  if (isWild(card)) return true;
  const top = topCard(s);
  return colorOf(card) === s.color || (valueOf(top) === v && !isWild(top));
}

/** Các lá đánh được của ghế đang tới lượt */
export function playable(s: SMState, seat = s.turn): number[] {
  if (s.over || seat !== s.turn) return [];
  if (s.drawn !== null) return canPlay(s, s.drawn) ? [s.drawn] : [];
  return s.hands[seat].filter((c) => canPlay(s, c));
}

const next = (s: SMState, from: number, steps = 1) =>
  (((from + s.dir * steps) % s.n) + s.n) % s.n;

function clone(s: SMState): SMState {
  return {
    ...s,
    hands: s.hands.map((h) => h.slice()),
    pile: s.pile.slice(),
    discard: s.discard.slice(),
    events: s.events.slice(-30),
    called: s.called.slice(),
  };
}

/** Bốc k lá cho ghế (xào lại chồng đã đánh khi hết bài) */
function take(
  s: SMState,
  seat: number,
  k: number,
  rng: () => number,
): number[] {
  const got: number[] = [];
  for (let i = 0; i < k; i++) {
    if (!s.pile.length) {
      const top = s.discard.pop()!;
      s.pile = shuffled(s.discard, rng);
      s.discard = [top];
      if (!s.pile.length) break;
    }
    got.push(s.pile.pop()!);
  }
  s.hands[seat] = sortHand([...s.hands[seat], ...got]);
  if (s.hands[seat].length > 1) s.called[seat] = false;
  return got;
}

/** Chuyển lượt; nếu đang có +2/+4 mà không được cộng dồn thì người kế bốc luôn và mất lượt */
function advance(s: SMState, steps: number, rng: () => number) {
  s.drawn = null;
  s.turn = next(s, s.turn, steps);
  if (s.pending > 0 && !s.settings.stack) resolvePending(s, rng);
}

function resolvePending(s: SMState, rng: () => number) {
  const seat = s.turn;
  const k = s.pending;
  take(s, seat, k, rng);
  s.events.push({ seat, kind: 'draw', count: k });
  s.events.push({ seat, kind: 'skip' });
  s.pending = 0;
  s.turn = next(s, seat);
}

export type ActResult =
  | { ok: true; state: SMState }
  | { ok: false; error: SMError };

export function play(
  state: SMState,
  seat: number,
  card: number,
  color?: number,
  call = false,
  rng: () => number = Math.random,
): ActResult {
  if (state.over) return { ok: false, error: 'GAME_OVER' };
  if (seat !== state.turn) return { ok: false, error: 'NOT_YOUR_TURN' };
  if (!state.hands[seat].includes(card))
    return { ok: false, error: 'NOT_IN_HAND' };
  if (state.drawn !== null && card !== state.drawn)
    return { ok: false, error: 'MUST_PLAY_DRAWN' };
  if (!canPlay(state, card)) return { ok: false, error: 'CANNOT_PLAY' };
  const wild = isWild(card);
  if (wild && !(Number.isInteger(color) && color! >= 0 && color! <= 3))
    return { ok: false, error: 'NEED_COLOR' };
  const s = clone(state);
  s.hands[seat] = s.hands[seat].filter((c) => c !== card);
  s.discard.push(card);
  s.color = wild ? color! : colorOf(card);
  s.stall = 0;
  s.events.push({ seat, kind: 'play', card, color: s.color });
  if (!s.hands[seat].length) {
    s.over = true;
    s.winner = seat;
    s.drawn = null;
    s.events.push({ seat, kind: 'win' });
    return { ok: true, state: s };
  }
  if (s.hands[seat].length === 1) {
    if (call) {
      s.called[seat] = true;
      s.events.push({ seat, kind: 'call' });
    } else {
      // quên báo: phạt bốc 2
      take(s, seat, 2, rng);
      s.events.push({ seat, kind: 'penalty', count: 2 });
    }
  }
  const v = valueOf(card);
  let steps = 1;
  if (v === SKIP) steps = 2;
  else if (v === REVERSE) {
    s.dir = (s.dir * -1) as 1 | -1;
    if (s.n === 2) steps = 2;
  } else if (v === DRAW2) s.pending += 2;
  else if (v === WILD4) s.pending += 4;
  if (steps === 2) s.events.push({ seat: next(s, seat), kind: 'skip' });
  advance(s, steps, rng);
  return { ok: true, state: s };
}

/** Bốc bài: đang bị +2/+4 thì bốc hết và mất lượt; không thì bốc 1 (đánh được thì có thể đánh luôn) */
export function draw(
  state: SMState,
  seat: number,
  rng: () => number = Math.random,
): ActResult {
  if (state.over) return { ok: false, error: 'GAME_OVER' };
  if (seat !== state.turn) return { ok: false, error: 'NOT_YOUR_TURN' };
  if (state.drawn !== null) return { ok: false, error: 'ALREADY_DREW' };
  const s = clone(state);
  if (s.pending > 0) {
    resolvePending(s, rng);
    return { ok: true, state: s };
  }
  const [c] = take(s, seat, 1, rng);
  if (c !== undefined) s.stall = 0;
  else {
    // hết bài để bốc
    s.stall += 1;
    if (s.stall >= s.n) {
      const pts = s.hands.map((h) => h.reduce((a, x) => a + cardPoints(x), 0));
      s.over = true;
      s.winner = pts.indexOf(Math.min(...pts));
      s.events.push({ seat: s.winner, kind: 'win' });
      return { ok: true, state: s };
    }
  }
  // ghi hệ lúc bốc: người này đang thiếu hệ đó (máy mức Khó dùng để ép)
  s.events.push({ seat, kind: 'draw', count: 1, color: s.color });
  if (c !== undefined && canPlay(s, c)) s.drawn = c;
  else advance(s, 1, rng);
  return { ok: true, state: s };
}

/** Bỏ lượt sau khi đã bốc (giữ lá vừa bốc) */
export function pass(
  state: SMState,
  seat: number,
  rng: () => number = Math.random,
): ActResult {
  if (state.over) return { ok: false, error: 'GAME_OVER' };
  if (seat !== state.turn) return { ok: false, error: 'NOT_YOUR_TURN' };
  if (state.drawn === null) return { ok: false, error: 'CANNOT_PASS' };
  const s = clone(state);
  s.events.push({ seat, kind: 'pass' });
  advance(s, 1, rng);
  return { ok: true, state: s };
}

/** Điểm ván: người thắng ăn tổng điểm bài còn lại của người khác */
export function scoreOf(s: SMState): number[] {
  const pts = new Array<number>(s.n).fill(0);
  if (s.winner === null) return pts;
  for (let i = 0; i < s.n; i++) {
    if (i === s.winner) continue;
    const p = s.hands[i].reduce((a, c) => a + cardPoints(c), 0);
    pts[s.winner] += p;
    pts[i] -= p;
  }
  return pts;
}
