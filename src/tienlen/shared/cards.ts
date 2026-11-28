/**
 * TIẾN LÊN MIỀN NAM — luật & diễn biến ván (thuần TypeScript, dùng chung cho trình duyệt và server).
 *
 * Lá bài: id 0..51, nước = floor(id / 4) (0 = 3, 1 = 4, …, 11 = A, 12 = 2 "heo"),
 * chất = id % 4 (0 ♠ bích < 1 ♣ chuồn < 2 ♦ rô < 3 ♥ cơ). id càng lớn lá càng mạnh.
 *
 * Bộ: rác (1 lá), đôi, ba (sám cô), tứ quý, sảnh (≥ 3 lá liên tiếp, không có heo),
 * đôi thông (≥ 3 đôi liên tiếp, không có heo).
 * Chặt: 3 đôi thông chặt 1 heo / 3 đôi thông nhỏ hơn; tứ quý chặt 1 heo, đôi heo, 3 đôi thông, tứ quý nhỏ hơn;
 * 4 đôi thông chặt 1 heo, đôi heo, 3 đôi thông, tứ quý, 4 đôi thông nhỏ hơn. (Chặt chồng được.)
 * Ván đầu: ai có lá nhỏ nhất (3♠ khi đủ 4 người) đi trước và phải đánh lá đó. Ván sau: người nhất ván trước đi trước.
 * Bỏ lượt thì mất quyền đánh trong vòng đó. Tới trắng khi chia: tứ quý heo, sảnh rồng (3→A), 6 đôi, 5 đôi thông.
 */

export const RANK_LABEL = [
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
  '2',
];
export const SUIT_LABEL = ['♠', '♣', '♦', '♥'];
export const rankOf = (c: number) => c >> 2;
export const suitOf = (c: number) => c & 3;
export const cardName = (c: number) =>
  RANK_LABEL[rankOf(c)] + SUIT_LABEL[suitOf(c)];
export const isRed = (c: number) => suitOf(c) >= 2;
const HEO = 12;

export type ComboType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'quad'
  | 'straight'
  | 'pairs';
export interface Combo {
  type: ComboType;
  /** Số lá */
  len: number;
  /** Lá mạnh nhất (để so) */
  top: number;
}

const sortAsc = (a: number, b: number) => a - b;

/** Nhận dạng bộ bài (null nếu không phải bộ hợp lệ) */
export function comboOf(cards: readonly number[]): Combo | null {
  const c = [...cards].sort(sortAsc);
  const n = c.length;
  if (
    !n ||
    new Set(c).size !== n ||
    c.some((x) => !Number.isInteger(x) || x < 0 || x > 51)
  )
    return null;
  const ranks = c.map(rankOf);
  const top = c[n - 1];
  const same = ranks.every((r) => r === ranks[0]);
  if (n === 1) return { type: 'single', len: 1, top };
  if (same && n === 2) return { type: 'pair', len: 2, top };
  if (same && n === 3) return { type: 'triple', len: 3, top };
  if (same && n === 4) return { type: 'quad', len: 4, top };
  if (
    n >= 3 &&
    ranks[n - 1] !== HEO &&
    ranks.every((r, i) => i === 0 || r === ranks[i - 1] + 1)
  )
    return { type: 'straight', len: n, top };
  if (n >= 6 && n % 2 === 0 && ranks[n - 1] !== HEO) {
    let ok = true;
    for (let i = 0; i < n; i += 2) {
      if (ranks[i] !== ranks[i + 1]) ok = false;
      if (i > 0 && ranks[i] !== ranks[i - 2] + 1) ok = false;
    }
    if (ok) return { type: 'pairs', len: n, top };
  }
  return null;
}

/** `next` có đè được `prev` không (gồm luật chặt) */
export function beats(next: Combo, prev: Combo): boolean {
  if (next.type === prev.type && next.len === prev.len)
    return next.top > prev.top;
  const prevHeo = rankOf(prev.top) === HEO;
  const bomb3 = next.type === 'pairs' && next.len === 6;
  const bomb4 = next.type === 'pairs' && next.len >= 8;
  const quad = next.type === 'quad';
  if (prev.type === 'single' && prevHeo) return bomb3 || bomb4 || quad;
  if (prev.type === 'pair' && prevHeo) return quad || bomb4;
  if (prev.type === 'pairs' && prev.len === 6) return quad || bomb4;
  if (prev.type === 'quad') return bomb4;
  return false;
}

/** Nước này có phải "chặt" không (để hiện hiệu ứng / âm thanh) */
export const isChop = (next: Combo, prev: Combo | null) =>
  !!prev && !(next.type === prev.type && next.len === prev.len);

export function comboLabel(c: Combo): string {
  switch (c.type) {
    case 'single':
      return rankOf(c.top) === HEO ? 'Heo' : 'Rác';
    case 'pair':
      return rankOf(c.top) === HEO ? 'Đôi heo' : 'Đôi';
    case 'triple':
      return 'Sám cô';
    case 'quad':
      return 'Tứ quý';
    case 'straight':
      return `Sảnh ${c.len}`;
    case 'pairs':
      return `${c.len / 2} đôi thông`;
  }
}

// ------------------------------------------------------------------ tới trắng

export function instantWin(hand: readonly number[]): string | null {
  if (hand.length !== 13) return null;
  const cnt = new Array<number>(13).fill(0);
  for (const c of hand) cnt[rankOf(c)]++;
  if (cnt[HEO] === 4) return 'Tứ quý heo';
  if (cnt.slice(0, 12).every((x) => x >= 1)) return 'Sảnh rồng';
  if (cnt.reduce((s, x) => s + Math.floor(x / 2), 0) >= 6) return '6 đôi';
  let run = 0;
  for (let r = 0; r < 12; r++) {
    run = cnt[r] >= 2 ? run + 1 : 0;
    if (run >= 5) return '5 đôi thông';
  }
  return null;
}

// ------------------------------------------------------------------ diễn biến ván

export interface TablePlay {
  seat: number;
  cards: number[];
  combo: Combo;
  chop: boolean;
}

export interface TLEvent {
  seat: number;
  kind: 'play' | 'pass' | 'newRound' | 'finish';
  cards?: number[];
  label?: string;
  chop?: boolean;
}

export interface TLState {
  n: number;
  hands: number[][];
  turn: number;
  table: TablePlay | null;
  /** Đã bỏ lượt trong vòng hiện tại */
  passed: boolean[];
  /** Thứ tự về (ghế) */
  finished: number[];
  /** Lá bắt buộc ở nước đầu tiên của ván (-1 = không) */
  mustPlay: number;
  over: boolean;
  /** Tới trắng (ghế, lý do) */
  instant: { seat: number; reason: string } | null;
  events: TLEvent[];
  /** Số lá đã đánh của từng ghế (để biết "cóng") */
  played: number[];
}

export type TLError =
  | 'GAME_OVER'
  | 'NOT_YOUR_TURN'
  | 'NOT_IN_HAND'
  | 'BAD_COMBO'
  | 'MUST_PLAY_LOWEST'
  | 'TOO_WEAK'
  | 'CANNOT_PASS';
export const TL_ERROR_VI: Record<TLError, string> = {
  GAME_OVER: 'Ván đã kết thúc',
  NOT_YOUR_TURN: 'Chưa tới lượt của bạn',
  NOT_IN_HAND: 'Bạn không có những lá này',
  BAD_COMBO: 'Các lá đã chọn không thành bộ',
  MUST_PLAY_LOWEST: 'Nước đầu phải có lá nhỏ nhất',
  TOO_WEAK: 'Bộ này không đè được bài trên bàn',
  CANNOT_PASS: 'Bạn đang cầm cái, phải đánh',
};

/** Trộn bài (rng trả số trong [0,1)) */
export function shuffled(rng: () => number = Math.random): number[] {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * Chia bài cho n người (2..4), mỗi người 13 lá.
 * `starter`: người đi trước (người nhất ván trước); null = ván đầu -> người có lá nhỏ nhất, phải đánh lá đó.
 */
export function deal(
  n: number,
  starter: number | null,
  rng: () => number = Math.random,
): TLState {
  const deck = shuffled(rng);
  const hands = Array.from({ length: n }, (_, i) =>
    deck.slice(i * 13, i * 13 + 13).sort(sortAsc),
  );
  let turn = starter ?? 0;
  let mustPlay = -1;
  if (starter === null) {
    const low = Math.min(...hands.flat());
    turn = hands.findIndex((h) => h.includes(low));
    mustPlay = low;
  }
  const s: TLState = {
    n,
    hands,
    turn,
    table: null,
    passed: new Array<boolean>(n).fill(false),
    finished: [],
    mustPlay,
    over: false,
    instant: null,
    events: [],
    played: new Array<number>(n).fill(0),
  };
  for (let i = 0; i < n; i++) {
    const reason = instantWin(hands[i]);
    if (reason) {
      s.instant = { seat: i, reason };
      s.over = true;
      s.finished = [i];
      break;
    }
  }
  return s;
}

const active = (s: TLState, seat: number) => !s.finished.includes(seat);

/** Chuyển lượt sau khi `from` vừa đánh / bỏ */
function advance(s: TLState, from: number) {
  const alive = Array.from({ length: s.n }, (_, i) => i).filter((i) =>
    active(s, i),
  );
  if (alive.length <= 1) {
    for (const i of alive) s.finished.push(i);
    s.over = true;
    return;
  }
  const owner = s.table?.seat ?? from;
  for (let k = 1; k <= s.n; k++) {
    const seat = (from + k) % s.n;
    if (seat === owner) {
      // ai cũng bỏ -> người đánh cuối mở vòng mới
      newRound(s, owner);
      return;
    }
    if (active(s, seat) && !s.passed[seat]) {
      s.turn = seat;
      return;
    }
  }
  newRound(s, owner);
}

function newRound(s: TLState, owner: number) {
  s.table = null;
  s.passed = new Array<boolean>(s.n).fill(false);
  // người đánh cuối đã về: người kế tiếp còn bài được "hưởng sái"
  let seat = owner;
  for (let k = 0; k < s.n && !active(s, seat); k++) seat = (seat + 1) % s.n;
  s.turn = seat;
  s.events.push({ seat, kind: 'newRound' });
}

export type ActResult =
  | { ok: true; state: TLState }
  | { ok: false; error: TLError };

export function play(
  state: TLState,
  seat: number,
  cards: readonly number[],
): ActResult {
  if (state.over) return { ok: false, error: 'GAME_OVER' };
  if (seat !== state.turn) return { ok: false, error: 'NOT_YOUR_TURN' };
  const hand = state.hands[seat];
  if (!cards.length || cards.some((c) => !hand.includes(c)))
    return { ok: false, error: 'NOT_IN_HAND' };
  const combo = comboOf(cards);
  if (!combo) return { ok: false, error: 'BAD_COMBO' };
  if (state.mustPlay >= 0 && !cards.includes(state.mustPlay))
    return { ok: false, error: 'MUST_PLAY_LOWEST' };
  if (state.table && !beats(combo, state.table.combo))
    return { ok: false, error: 'TOO_WEAK' };
  const s: TLState = structuredCloneState(state);
  const sorted = [...cards].sort(sortAsc);
  s.hands[seat] = hand.filter((c) => !cards.includes(c));
  const chop = isChop(combo, state.table?.combo ?? null);
  s.table = { seat, cards: sorted, combo, chop };
  s.mustPlay = -1;
  s.played[seat] += cards.length;
  s.events.push({
    seat,
    kind: 'play',
    cards: sorted,
    label: comboLabel(combo),
    chop,
  });
  if (!s.hands[seat].length) {
    s.finished.push(seat);
    s.events.push({ seat, kind: 'finish' });
  }
  advance(s, seat);
  return { ok: true, state: s };
}

export function pass(state: TLState, seat: number): ActResult {
  if (state.over) return { ok: false, error: 'GAME_OVER' };
  if (seat !== state.turn) return { ok: false, error: 'NOT_YOUR_TURN' };
  if (!state.table) return { ok: false, error: 'CANNOT_PASS' };
  const s = structuredCloneState(state);
  s.passed[seat] = true;
  s.events.push({ seat, kind: 'pass' });
  advance(s, seat);
  return { ok: true, state: s };
}

function structuredCloneState(s: TLState): TLState {
  return {
    ...s,
    hands: s.hands.map((h) => h.slice()),
    passed: s.passed.slice(),
    finished: s.finished.slice(),
    events: s.events.slice(-30),
    played: s.played.slice(),
    table: s.table ? { ...s.table, cards: s.table.cards.slice() } : null,
  };
}

/** Điểm theo thứ hạng: 4 người +3/+1/−1/−3, 3 người +2/0/−2, 2 người +1/−1; tới trắng: thắng cả bàn */
export function scoreOf(s: TLState): number[] {
  const pts = new Array<number>(s.n).fill(0);
  if (s.instant) {
    for (let i = 0; i < s.n; i++)
      pts[i] = i === s.instant.seat ? 2 * (s.n - 1) : -2;
    return pts;
  }
  const table: Record<number, number[]> = {
    2: [1, -1],
    3: [2, 0, -2],
    4: [3, 1, -1, -3],
  };
  s.finished.forEach((seat, i) => (pts[seat] = table[s.n][i] ?? 0));
  return pts;
}

export const PLACE_VI = ['Nhất', 'Nhì', 'Ba', 'Bét'];
