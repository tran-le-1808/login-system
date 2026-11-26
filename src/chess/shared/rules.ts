/**
 * LUẬT CỜ VUA (thuần TypeScript, dùng chung cho trình duyệt và server).
 *
 * Bàn 8×8, ô i = y * 8 + x; y = 0 là hàng 8 (bên Đen), y = 7 là hàng 1 (bên Trắng); x = 0 là cột a.
 * Quân: dương = Trắng (đi trước), âm = Đen. 1 Vua, 2 Hậu, 3 Xe, 4 Tượng, 5 Mã, 6 Tốt.
 * Đủ luật: nhập thành, bắt tốt qua đường, phong cấp; chiếu bí; hoà khi hết nước (pat), lặp lại thế cờ 3 lần,
 * 50 nước không ăn quân / không đi tốt, không đủ quân để chiếu bí.
 */

export type Side = 1 | -1;
/** [ô đi, ô đến, quân phong cấp (2..5) hoặc 0] */
export type ChessMove = [number, number, number];

export const KING = 1;
export const QUEEN = 2;
export const ROOK = 3;
export const BISHOP = 4;
export const KNIGHT = 5;
export const PAWN = 6;

/** Quyền nhập thành: bit 1 Trắng cánh vua, 2 Trắng cánh hậu, 4 Đen cánh vua, 8 Đen cánh hậu */
export interface Pos {
  b: number[];
  turn: Side;
  castle: number;
  /** Ô có thể bắt tốt qua đường (-1 = không) */
  ep: number;
  /** Số nửa nước từ lần ăn quân / đi tốt gần nhất */
  half: number;
}

export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'repetition'
  | 'fiftyMove'
  | 'material';

export interface ChessState extends Pos {
  moves: ChessMove[];
  /** Quân bị ăn ở mỗi nước (0 = không) */
  captures: number[];
  checks: boolean[];
  /** Ký hiệu SAN của từng nước */
  san: string[];
  history: string[];
  winner: Side | null;
  draw: boolean;
  endReason: EndReason | null;
}

export type MoveError =
  | 'GAME_OVER'
  | 'BAD_SQUARE'
  | 'NO_PIECE'
  | 'NOT_YOUR_PIECE'
  | 'ILLEGAL';
export const MOVE_ERROR_VI: Record<MoveError | 'NOT_YOUR_TURN', string> = {
  GAME_OVER: 'Ván cờ đã kết thúc',
  BAD_SQUARE: 'Ô không hợp lệ',
  NO_PIECE: 'Không có quân ở ô này',
  NOT_YOUR_PIECE: 'Đó không phải quân của bạn',
  ILLEGAL: 'Nước đi không hợp lệ',
  NOT_YOUR_TURN: 'Chưa tới lượt của bạn',
};

export const END_REASON_VI: Record<EndReason, string> = {
  checkmate: 'chiếu hết',
  stalemate: 'hết nước đi (pat)',
  repetition: 'lặp lại thế cờ 3 lần',
  fiftyMove: '50 nước không ăn quân, không đi tốt',
  material: 'không đủ quân để chiếu hết',
};

export const SIDE_VI = { 1: 'Trắng', [-1]: 'Đen' } as Record<Side, string>;

export const sqX = (i: number) => i & 7;
export const sqY = (i: number) => i >> 3;
export const sq = (x: number, y: number) => y * 8 + x;
export const sqName = (i: number) => 'abcdefgh'[sqX(i)] + (8 - sqY(i));
const on = (x: number, y: number) => x >= 0 && x < 8 && y >= 0 && y < 8;
const sideOf = (p: number): Side | 0 => (p > 0 ? 1 : p < 0 ? -1 : 0);

const FEN_P: Record<string, number> = {
  k: KING,
  q: QUEEN,
  r: ROOK,
  b: BISHOP,
  n: KNIGHT,
  p: PAWN,
};
export const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function fromFEN(fen: string): Pos {
  const [rows, turn, cas, ep, half] = fen.trim().split(/\s+/);
  const b = new Array<number>(64).fill(0);
  rows.split('/').forEach((row, y) => {
    let x = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) x += Number(ch);
      else {
        const t = FEN_P[ch.toLowerCase()];
        b[sq(x, y)] = ch === ch.toUpperCase() ? t : -t;
        x++;
      }
    }
  });
  let castle = 0;
  if (cas.includes('K')) castle |= 1;
  if (cas.includes('Q')) castle |= 2;
  if (cas.includes('k')) castle |= 4;
  if (cas.includes('q')) castle |= 8;
  const epSq =
    ep && ep !== '-' ? sq('abcdefgh'.indexOf(ep[0]), 8 - Number(ep[1])) : -1;
  return {
    b,
    turn: turn === 'b' ? -1 : 1,
    castle,
    ep: epSq,
    half: Number(half ?? 0) || 0,
  };
}

/** Khoá thế cờ để phát hiện lặp nước */
export function positionKey(p: Pos): string {
  let s = p.turn === 1 ? 'w' : 'b';
  s += p.castle.toString(16);
  s += p.ep >= 0 ? sqName(p.ep) : '-';
  for (const v of p.b)
    s += v === 0 ? '.' : v > 0 ? 'KQRBNP'[v - 1] : 'kqrbnp'[-v - 1];
  return s;
}

export function newGame(fen = START_FEN): ChessState {
  const p = fromFEN(fen);
  return {
    ...p,
    moves: [],
    captures: [],
    checks: [],
    san: [],
    history: [positionKey(p)],
    winner: null,
    draw: false,
    endReason: null,
  };
}

const N_D: [number, number][] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];
const K_D: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const R_D: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const B_D: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Ô `s` có bị bên `by` tấn công không */
export function isAttacked(b: readonly number[], s: number, by: Side): boolean {
  const x = sqX(s);
  const y = sqY(s);
  // tốt của `by` tấn công chéo về phía trước của nó (Trắng đi lên: y giảm)
  const py = y + by;
  for (const dx of [-1, 1])
    if (on(x + dx, py) && b[sq(x + dx, py)] === PAWN * by) return true;
  for (const [dx, dy] of N_D)
    if (on(x + dx, y + dy) && b[sq(x + dx, y + dy)] === KNIGHT * by)
      return true;
  for (const [dx, dy] of K_D)
    if (on(x + dx, y + dy) && b[sq(x + dx, y + dy)] === KING * by) return true;
  for (const [dx, dy] of R_D) {
    let nx = x + dx;
    let ny = y + dy;
    while (on(nx, ny)) {
      const q = b[sq(nx, ny)];
      if (q) {
        if (q === ROOK * by || q === QUEEN * by) return true;
        break;
      }
      nx += dx;
      ny += dy;
    }
  }
  for (const [dx, dy] of B_D) {
    let nx = x + dx;
    let ny = y + dy;
    while (on(nx, ny)) {
      const q = b[sq(nx, ny)];
      if (q) {
        if (q === BISHOP * by || q === QUEEN * by) return true;
        break;
      }
      nx += dx;
      ny += dy;
    }
  }
  return false;
}

export function findKing(b: readonly number[], side: Side): number {
  return b.indexOf(KING * side);
}

export function inCheck(b: readonly number[], side: Side): boolean {
  const k = findKing(b, side);
  return k < 0 || isAttacked(b, k, -side as Side);
}

/** Mã hoá nước: from + to * 64 + promo * 4096 */
export const enc = (f: number, t: number, promo = 0) =>
  f + t * 64 + promo * 4096;
export const mFrom = (m: number) => m & 63;
export const mTo = (m: number) => (m >> 6) & 63;
export const mPromo = (m: number) => m >> 12;

/** Nước đi theo cách đi của quân (chưa loại nước để vua bị chiếu) */
export function pseudoMoves(
  p: Pos,
  out: number[] = [],
  capturesOnly = false,
): number[] {
  const b = p.b;
  const side = p.turn;
  for (let i = 0; i < 64; i++) {
    const v = b[i];
    if (!v || sideOf(v) !== side) continue;
    const t = Math.abs(v);
    const x = sqX(i);
    const y = sqY(i);
    if (t === PAWN) {
      const dir = -side; // Trắng đi lên (y giảm)
      const ny = y + dir;
      const last = side === 1 ? 0 : 7;
      const start = side === 1 ? 6 : 1;
      const add = (to: number) => {
        if (ny === last)
          for (const pr of [QUEEN, KNIGHT, ROOK, BISHOP])
            out.push(enc(i, to, pr));
        else out.push(enc(i, to));
      };
      if (on(x, ny) && !b[sq(x, ny)] && (!capturesOnly || ny === last)) {
        add(sq(x, ny));
        if (!capturesOnly && y === start && !b[sq(x, y + 2 * dir)])
          out.push(enc(i, sq(x, y + 2 * dir)));
      }
      for (const dx of [-1, 1]) {
        if (!on(x + dx, ny)) continue;
        const to = sq(x + dx, ny);
        if ((b[to] && sideOf(b[to]) === -side) || to === p.ep) add(to);
      }
      continue;
    }
    if (t === KNIGHT || t === KING) {
      for (const [dx, dy] of t === KNIGHT ? N_D : K_D) {
        if (!on(x + dx, y + dy)) continue;
        const to = sq(x + dx, y + dy);
        if (!b[to] ? !capturesOnly : sideOf(b[to]) === -side)
          out.push(enc(i, to));
      }
      if (t === KING && !capturesOnly) {
        // nhập thành
        const home = side === 1 ? 7 : 0;
        if (y === home && x === 4) {
          const kBit = side === 1 ? 1 : 4;
          const qBit = side === 1 ? 2 : 8;
          const opp = -side as Side;
          if (
            p.castle & kBit &&
            !b[sq(5, home)] &&
            !b[sq(6, home)] &&
            b[sq(7, home)] === ROOK * side &&
            !isAttacked(b, i, opp) &&
            !isAttacked(b, sq(5, home), opp) &&
            !isAttacked(b, sq(6, home), opp)
          )
            out.push(enc(i, sq(6, home)));
          if (
            p.castle & qBit &&
            !b[sq(3, home)] &&
            !b[sq(2, home)] &&
            !b[sq(1, home)] &&
            b[sq(0, home)] === ROOK * side &&
            !isAttacked(b, i, opp) &&
            !isAttacked(b, sq(3, home), opp) &&
            !isAttacked(b, sq(2, home), opp)
          )
            out.push(enc(i, sq(2, home)));
        }
      }
      continue;
    }
    const dirs = t === ROOK ? R_D : t === BISHOP ? B_D : K_D;
    for (const [dx, dy] of dirs) {
      let nx = x + dx;
      let ny = y + dy;
      while (on(nx, ny)) {
        const to = sq(nx, ny);
        const q = b[to];
        if (!q) {
          if (!capturesOnly) out.push(enc(i, to));
        } else {
          if (sideOf(q) === -side) out.push(enc(i, to));
          break;
        }
        nx += dx;
        ny += dy;
      }
    }
  }
  return out;
}

const CASTLE_MASK = (() => {
  const m = new Array<number>(64).fill(15);
  m[sq(4, 7)] = 15 & ~3;
  m[sq(7, 7)] = 15 & ~1;
  m[sq(0, 7)] = 15 & ~2;
  m[sq(4, 0)] = 15 & ~12;
  m[sq(7, 0)] = 15 & ~4;
  m[sq(0, 0)] = 15 & ~8;
  return m;
})();

/** Đi nước (không kiểm tra hợp lệ), trả về thế mới + quân bị ăn */
export function makeMove(p: Pos, m: number): { pos: Pos; captured: number } {
  const f = mFrom(m);
  const t = mTo(m);
  const promo = mPromo(m);
  const b = p.b.slice();
  const v = b[f];
  const side = p.turn;
  let captured = b[t];
  b[t] = promo ? promo * side : v;
  b[f] = 0;
  let ep = -1;
  if (Math.abs(v) === PAWN) {
    if (t === p.ep && !captured) {
      // bắt tốt qua đường: tốt bị bắt nằm cùng hàng với ô xuất phát
      const cs = sq(sqX(t), sqY(f));
      captured = b[cs];
      b[cs] = 0;
    }
    if (Math.abs(sqY(t) - sqY(f)) === 2) ep = (f + t) >> 1;
  } else if (Math.abs(v) === KING && Math.abs(sqX(t) - sqX(f)) === 2) {
    const y = sqY(f);
    if (sqX(t) === 6) {
      b[sq(5, y)] = b[sq(7, y)];
      b[sq(7, y)] = 0;
    } else {
      b[sq(3, y)] = b[sq(0, y)];
      b[sq(0, y)] = 0;
    }
  }
  const castle = p.castle & CASTLE_MASK[f] & CASTLE_MASK[t];
  const half = captured || Math.abs(v) === PAWN ? 0 : p.half + 1;
  return { pos: { b, turn: -side as Side, castle, ep, half }, captured };
}

export function legalMoves(p: Pos): number[] {
  return pseudoMoves(p).filter((m) => !inCheck(makeMove(p, m).pos.b, p.turn));
}

/** Các ô quân ở `from` đi tới được (hợp lệ) */
export function legalTargets(p: Pos, from: number): number[] {
  const set = new Set<number>();
  for (const m of legalMoves(p)) if (mFrom(m) === from) set.add(mTo(m));
  return [...set];
}

/** Nước tới hàng cuối của tốt (cần chọn quân phong cấp) */
export function isPromotion(p: Pos, from: number, to: number): boolean {
  const v = p.b[from];
  return Math.abs(v) === PAWN && (sqY(to) === 0 || sqY(to) === 7);
}

/** Không đủ quân để chiếu hết: K-K, K+mã/tượng - K, K+tượng - K+tượng cùng màu ô */
export function insufficient(b: readonly number[]): boolean {
  const rest: { t: number; s: number }[] = [];
  for (let i = 0; i < 64; i++) {
    const t = Math.abs(b[i]);
    if (!t || t === KING) continue;
    if (t === PAWN || t === ROOK || t === QUEEN) return false;
    rest.push({ t, s: i });
  }
  if (rest.length <= 1) return true;
  if (rest.every((r) => r.t === BISHOP)) {
    const color = (i: number) => (sqX(i) + sqY(i)) & 1;
    return rest.every((r) => color(r.s) === color(rest[0].s));
  }
  return false;
}

const LETTER = ['', 'K', 'Q', 'R', 'B', 'N', ''];

/** Ký hiệu SAN của nước m ở thế p (vd. "Nf3", "exd5", "O-O", "e8=Q+", "Qh7#") */
export function san(p: Pos, m: number, legal = legalMoves(p)): string {
  const f = mFrom(m);
  const t = mTo(m);
  const v = p.b[f];
  const type = Math.abs(v);
  let s: string;
  if (type === KING && Math.abs(sqX(t) - sqX(f)) === 2)
    s = sqX(t) === 6 ? 'O-O' : 'O-O-O';
  else {
    const capture = !!p.b[t] || (type === PAWN && t === p.ep);
    if (type === PAWN) {
      s = (capture ? 'abcdefgh'[sqX(f)] + 'x' : '') + sqName(t);
      if (mPromo(m)) s += '=' + LETTER[mPromo(m)];
    } else {
      s = LETTER[type];
      const others = legal.filter(
        (o) => mTo(o) === t && mFrom(o) !== f && p.b[mFrom(o)] === v,
      );
      if (others.length) {
        const sameFile = others.some((o) => sqX(mFrom(o)) === sqX(f));
        const sameRank = others.some((o) => sqY(mFrom(o)) === sqY(f));
        if (!sameFile) s += 'abcdefgh'[sqX(f)];
        else if (!sameRank) s += String(8 - sqY(f));
        else s += sqName(f);
      }
      s += (capture ? 'x' : '') + sqName(t);
    }
  }
  const after = makeMove(p, m).pos;
  if (inCheck(after.b, after.turn)) s += legalMoves(after).length ? '+' : '#';
  return s;
}

export type MoveResult =
  | { ok: true; state: ChessState }
  | { ok: false; error: MoveError };

/** Đi nước có kiểm tra luật; promo mặc định là Hậu */
export function applyMove(
  state: ChessState,
  from: number,
  to: number,
  promo = 0,
): MoveResult {
  if (state.winner !== null || state.draw)
    return { ok: false, error: 'GAME_OVER' };
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from > 63 ||
    to < 0 ||
    to > 63
  )
    return { ok: false, error: 'BAD_SQUARE' };
  const v = state.b[from];
  if (!v) return { ok: false, error: 'NO_PIECE' };
  if (sideOf(v) !== state.turn) return { ok: false, error: 'NOT_YOUR_PIECE' };
  const pr = isPromotion(state, from, to)
    ? [QUEEN, ROOK, BISHOP, KNIGHT].includes(promo)
      ? promo
      : QUEEN
    : 0;
  const m = enc(from, to, pr);
  const legal = legalMoves(state);
  if (!legal.includes(m)) return { ok: false, error: 'ILLEGAL' };
  const notation = san(state, m, legal);
  const { pos, captured } = makeMove(state, m);
  const check = inCheck(pos.b, pos.turn);
  const key = positionKey(pos);
  const next: ChessState = {
    ...pos,
    moves: [...state.moves, [from, to, pr]],
    captures: [...state.captures, captured],
    checks: [...state.checks, check],
    san: [...state.san, notation],
    history: [...state.history, key],
    winner: null,
    draw: false,
    endReason: null,
  };
  if (legalMoves(pos).length === 0) {
    if (check) {
      next.winner = state.turn;
      next.endReason = 'checkmate';
    } else {
      next.draw = true;
      next.endReason = 'stalemate';
    }
  } else if (next.history.filter((k) => k === key).length >= 3) {
    next.draw = true;
    next.endReason = 'repetition';
  } else if (pos.half >= 100) {
    next.draw = true;
    next.endReason = 'fiftyMove';
  } else if (insufficient(pos.b)) {
    next.draw = true;
    next.endReason = 'material';
  }
  return { ok: true, state: next };
}

export function replay(moves: readonly ChessMove[]): ChessState {
  let g = newGame();
  for (const [f, t, pr] of moves) {
    const r = applyMove(g, f, t, pr);
    if (!r.ok) break;
    g = r.state;
  }
  return g;
}
