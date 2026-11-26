/**
 * LUẬT CỜ TƯỚNG (thuần TypeScript, không phụ thuộc gì — dùng chung cho trình duyệt và server).
 *
 * Bàn 9 cột × 10 hàng, ô i = y * 9 + x. Hàng 0 ở trên (bên Đen), hàng 9 ở dưới (bên Đỏ).
 * Quân: số dương = Đỏ (đi trước), số âm = Đen. 1 Tướng, 2 Sĩ, 3 Tượng, 4 Mã, 5 Xe, 6 Pháo, 7 Tốt.
 *
 * Kết thúc ván:
 *  - bên tới lượt không còn nước hợp lệ (bị chiếu bí hoặc hết nước) -> thua
 *  - lặp lại cùng thế cờ 3 lần: nếu một bên chiếu liên tục trong cả chu kỳ (chiếu dai) -> bên đó thua,
 *    ngược lại -> hoà
 *  - 120 nước liên tiếp (60 mỗi bên) không ăn quân -> hoà
 *  - cả hai bên đều không còn quân sang sông tấn công được (Xe, Mã, Pháo, Tốt) -> hoà
 */

export type Side = 1 | -1;
/** [ô đi, ô đến] */
export type XqMove = [number, number];

export const COLS = 9;
export const ROWS = 10;
export const KING = 1;
export const ADVISOR = 2;
export const ELEPHANT = 3;
export const HORSE = 4;
export const ROOK = 5;
export const CANNON = 6;
export const PAWN = 7;

export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'repetition'
  | 'perpetual'
  | 'moveLimit'
  | 'material';

export interface XqState {
  board: number[];
  turn: Side;
  moves: XqMove[];
  /** Quân bị ăn ở mỗi nước (0 = không ăn) */
  captures: number[];
  /** Nước thứ i có chiếu tướng đối phương không */
  checks: boolean[];
  /** Khoá thế cờ: [0] là thế ban đầu, [i] là thế sau nước thứ i */
  history: string[];
  /** Số nước liên tiếp không ăn quân */
  quiet: number;
  winner: Side | null;
  draw: boolean;
  endReason: EndReason | null;
}

export type MoveError =
  | 'GAME_OVER'
  | 'BAD_SQUARE'
  | 'NO_PIECE'
  | 'NOT_YOUR_PIECE'
  | 'ILLEGAL'
  | 'SELF_CHECK';
export const MOVE_ERROR_VI: Record<MoveError | 'NOT_YOUR_TURN', string> = {
  GAME_OVER: 'Ván cờ đã kết thúc',
  BAD_SQUARE: 'Ô không hợp lệ',
  NO_PIECE: 'Không có quân ở ô này',
  NOT_YOUR_PIECE: 'Đó không phải quân của bạn',
  ILLEGAL: 'Quân này không đi được như vậy',
  SELF_CHECK: 'Nước này để tướng bị chiếu (hoặc lộ mặt tướng)',
  NOT_YOUR_TURN: 'Chưa tới lượt của bạn',
};

export const END_REASON_VI: Record<EndReason, string> = {
  checkmate: 'chiếu bí',
  stalemate: 'hết nước đi',
  repetition: 'lặp lại thế cờ 3 lần',
  perpetual: 'chiếu dai (lặp nước bằng cách chiếu liên tục)',
  moveLimit: '60 nước mỗi bên không ăn quân',
  material: 'cả hai bên không còn quân tấn công',
};

export const SIDE_VI: Record<Side, string> = { 1: 'Đỏ', [-1]: 'Đen' } as Record<
  Side,
  string
>;

export const idx = (x: number, y: number) => y * COLS + x;
export const sqX = (i: number) => i % COLS;
export const sqY = (i: number) => (i / COLS) | 0;
const onBoard = (x: number, y: number) =>
  x >= 0 && x < COLS && y >= 0 && y < ROWS;
const sideOf = (p: number): Side | 0 => (p > 0 ? 1 : p < 0 ? -1 : 0);

const BACK = [
  ROOK,
  HORSE,
  ELEPHANT,
  ADVISOR,
  KING,
  ADVISOR,
  ELEPHANT,
  HORSE,
  ROOK,
];

export function initialBoard(): number[] {
  const b = new Array<number>(COLS * ROWS).fill(0);
  BACK.forEach((p, x) => {
    b[idx(x, 0)] = -p;
    b[idx(x, 9)] = p;
  });
  for (const x of [1, 7]) {
    b[idx(x, 2)] = -CANNON;
    b[idx(x, 7)] = CANNON;
  }
  for (const x of [0, 2, 4, 6, 8]) {
    b[idx(x, 3)] = -PAWN;
    b[idx(x, 6)] = PAWN;
  }
  return b;
}

/** Khoá thế cờ (bàn + bên tới lượt) để phát hiện lặp nước */
export function positionKey(board: readonly number[], turn: Side): string {
  let s = turn === 1 ? 'r' : 'b';
  for (const p of board)
    s += p === 0 ? '.' : p > 0 ? 'KABNRCP'[p - 1] : 'kabnrcp'[-p - 1];
  return s;
}

export function newGame(): XqState {
  const board = initialBoard();
  return {
    board,
    turn: 1,
    moves: [],
    captures: [],
    checks: [],
    history: [positionKey(board, 1)],
    quiet: 0,
    winner: null,
    draw: false,
    endReason: null,
  };
}

const inPalace = (x: number, y: number, side: Side) =>
  x >= 3 && x <= 5 && (side === 1 ? y >= 7 && y <= 9 : y >= 0 && y <= 2);
/** Ô đã qua sông (đối với quân của `side`) */
const crossed = (y: number, side: Side) => (side === 1 ? y <= 4 : y >= 5);

const ORTH: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAG: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const HORSE_D: [number, number, number, number][] = [
  // [dx, dy, chân dx, chân dy]
  [1, 2, 0, 1],
  [-1, 2, 0, 1],
  [1, -2, 0, -1],
  [-1, -2, 0, -1],
  [2, 1, 1, 0],
  [2, -1, 1, 0],
  [-2, 1, -1, 0],
  [-2, -1, -1, 0],
];

/** Nước đi theo cách đi của quân (chưa xét tự chiếu). Mã hoá: from * 256 + to */
export function pseudoMoves(
  board: readonly number[],
  side: Side,
  out: number[] = [],
): number[] {
  for (let i = 0; i < 90; i++) {
    const p = board[i];
    if (p === 0 || sideOf(p) !== side) continue;
    pieceMoves(board, i, out);
  }
  return out;
}

export function pieceMoves(
  board: readonly number[],
  from: number,
  out: number[] = [],
): number[] {
  const p = board[from];
  const side = sideOf(p) as Side;
  const t = Math.abs(p);
  const x = sqX(from);
  const y = sqY(from);
  const push = (nx: number, ny: number) => {
    const to = idx(nx, ny);
    const q = board[to];
    if (q === 0 || sideOf(q) !== side) out.push(from * 256 + to);
  };
  switch (t) {
    case KING:
      for (const [dx, dy] of ORTH)
        if (inPalace(x + dx, y + dy, side)) push(x + dx, y + dy);
      break;
    case ADVISOR:
      for (const [dx, dy] of DIAG)
        if (inPalace(x + dx, y + dy, side)) push(x + dx, y + dy);
      break;
    case ELEPHANT:
      for (const [dx, dy] of DIAG) {
        const nx = x + 2 * dx;
        const ny = y + 2 * dy;
        if (!onBoard(nx, ny) || crossed(ny, side)) continue;
        if (board[idx(x + dx, y + dy)] !== 0) continue; // cản mắt tượng
        push(nx, ny);
      }
      break;
    case HORSE:
      for (const [dx, dy, lx, ly] of HORSE_D) {
        const nx = x + dx;
        const ny = y + dy;
        if (!onBoard(nx, ny)) continue;
        if (board[idx(x + lx, y + ly)] !== 0) continue; // cản chân mã
        push(nx, ny);
      }
      break;
    case ROOK:
      for (const [dx, dy] of ORTH) {
        let nx = x + dx;
        let ny = y + dy;
        while (onBoard(nx, ny)) {
          const q = board[idx(nx, ny)];
          if (q === 0) out.push(from * 256 + idx(nx, ny));
          else {
            if (sideOf(q) !== side) out.push(from * 256 + idx(nx, ny));
            break;
          }
          nx += dx;
          ny += dy;
        }
      }
      break;
    case CANNON:
      for (const [dx, dy] of ORTH) {
        let nx = x + dx;
        let ny = y + dy;
        let screen = false;
        while (onBoard(nx, ny)) {
          const q = board[idx(nx, ny)];
          if (!screen) {
            if (q === 0) out.push(from * 256 + idx(nx, ny));
            else screen = true;
          } else if (q !== 0) {
            if (sideOf(q) !== side) out.push(from * 256 + idx(nx, ny));
            break;
          }
          nx += dx;
          ny += dy;
        }
      }
      break;
    case PAWN: {
      const fy = y - side; // Đỏ đi lên (y giảm), Đen đi xuống
      if (onBoard(x, fy)) push(x, fy);
      if (crossed(y, side)) {
        if (onBoard(x - 1, y)) push(x - 1, y);
        if (onBoard(x + 1, y)) push(x + 1, y);
      }
      break;
    }
  }
  return out;
}

export function findKing(board: readonly number[], side: Side): number {
  const k = KING * side;
  // tướng chỉ ở trong cung: dò 9 ô
  const ys = side === 1 ? [7, 8, 9] : [0, 1, 2];
  for (const y of ys)
    for (let x = 3; x <= 5; x++) if (board[idx(x, y)] === k) return idx(x, y);
  return -1;
}

/** Ô `sq` có bị quân của `by` tấn công không (dùng cho tướng: gồm cả luật lộ mặt tướng) */
export function isAttacked(
  board: readonly number[],
  sq: number,
  by: Side,
): boolean {
  const x = sqX(sq);
  const y = sqY(sq);
  // Xe, Pháo, Tướng (lộ mặt) theo 4 hướng
  for (const [dx, dy] of ORTH) {
    let nx = x + dx;
    let ny = y + dy;
    let seen = 0;
    while (onBoard(nx, ny)) {
      const q = board[idx(nx, ny)];
      if (q !== 0) {
        if (seen === 0) {
          if (q === ROOK * by) return true;
          if (dx === 0 && q === KING * by) return true;
          seen = 1;
        } else {
          if (q === CANNON * by) return true;
          break;
        }
      }
      nx += dx;
      ny += dy;
    }
  }
  // Mã: mã ở (hx, hy) nhảy tới sq, chân mã sát mã theo hướng dài
  for (const [dx, dy] of HORSE_D) {
    const hx = x - dx;
    const hy = y - dy;
    if (!onBoard(hx, hy) || board[idx(hx, hy)] !== HORSE * by) continue;
    const lx = Math.abs(dx) === 2 ? Math.sign(dx) : 0;
    const ly = Math.abs(dy) === 2 ? Math.sign(dy) : 0;
    if (board[idx(hx + lx, hy + ly)] === 0) return true;
  }
  // Tốt
  const py = y + by; // tốt của `by` đứng sau ô này một hàng (theo hướng nó tiến)
  if (onBoard(x, py) && board[idx(x, py)] === PAWN * by) return true;
  for (const dx of [-1, 1]) {
    const px = x + dx;
    if (onBoard(px, y) && board[idx(px, y)] === PAWN * by && crossed(y, by))
      return true;
  }
  return false;
}

export function inCheck(board: readonly number[], side: Side): boolean {
  const k = findKing(board, side);
  return k < 0 || isAttacked(board, k, -side as Side);
}

/** Các nước hợp lệ của bên tới lượt (đã loại nước tự chiếu / lộ mặt tướng) */
export function legalMoves(board: readonly number[], side: Side): number[] {
  const b = board.slice();
  const out: number[] = [];
  for (const m of pseudoMoves(b, side)) {
    const from = m >> 8;
    const to = m & 255;
    const cap = b[to];
    b[to] = b[from];
    b[from] = 0;
    if (!inCheck(b, side)) out.push(m);
    b[from] = b[to];
    b[to] = cap;
  }
  return out;
}

/** Các ô quân ở `from` đi tới được (hợp lệ) — để tô gợi ý trên bàn */
export function legalTargets(board: readonly number[], from: number): number[] {
  const p = board[from];
  if (!p) return [];
  const side = sideOf(p) as Side;
  const b = board.slice();
  const res: number[] = [];
  for (const m of pieceMoves(b, from)) {
    const to = m & 255;
    const cap = b[to];
    b[to] = b[from];
    b[from] = 0;
    if (!inCheck(b, side)) res.push(to);
    b[from] = b[to];
    b[to] = cap;
  }
  return res;
}

const ATTACKERS = [HORSE, ROOK, CANNON, PAWN];
function hasAttacker(board: readonly number[], side: Side) {
  return board.some(
    (p) => sideOf(p) === side && ATTACKERS.includes(Math.abs(p)),
  );
}

export type MoveResult =
  | { ok: true; state: XqState }
  | { ok: false; error: MoveError };

export function applyMove(
  state: XqState,
  from: number,
  to: number,
): MoveResult {
  if (state.winner !== null || state.draw)
    return { ok: false, error: 'GAME_OVER' };
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= 90 ||
    to < 0 ||
    to >= 90
  )
    return { ok: false, error: 'BAD_SQUARE' };
  const p = state.board[from];
  if (!p) return { ok: false, error: 'NO_PIECE' };
  if (sideOf(p) !== state.turn) return { ok: false, error: 'NOT_YOUR_PIECE' };
  if (!pieceMoves(state.board, from).includes(from * 256 + to))
    return { ok: false, error: 'ILLEGAL' };
  const board = state.board.slice();
  const cap = board[to];
  board[to] = p;
  board[from] = 0;
  if (inCheck(board, state.turn)) return { ok: false, error: 'SELF_CHECK' };

  const turn = -state.turn as Side;
  const check = inCheck(board, turn);
  const key = positionKey(board, turn);
  const next: XqState = {
    board,
    turn,
    moves: [...state.moves, [from, to]],
    captures: [...state.captures, cap],
    checks: [...state.checks, check],
    history: [...state.history, key],
    quiet: cap ? 0 : state.quiet + 1,
    winner: null,
    draw: false,
    endReason: null,
  };

  if (legalMoves(board, turn).length === 0) {
    next.winner = state.turn;
    next.endReason = check ? 'checkmate' : 'stalemate';
    return { ok: true, state: next };
  }
  // lặp lại thế cờ lần thứ 3
  const reps = next.history.filter((k) => k === key).length;
  if (reps >= 3) {
    const first = next.history.indexOf(key);
    // nước thứ i (0-based) tạo ra history[i + 1]; trong chu kỳ: các nước first .. n-1
    const n = next.moves.length;
    const perpetual: Record<string, boolean> = { '1': true, '-1': true };
    for (let i = first; i < n; i++) {
      const mover = i % 2 === 0 ? '1' : '-1';
      if (!next.checks[i]) perpetual[mover] = false;
    }
    if (perpetual['1'] !== perpetual['-1']) {
      next.winner = perpetual['1'] ? -1 : 1;
      next.endReason = 'perpetual';
    } else {
      next.draw = true;
      next.endReason = 'repetition';
    }
    return { ok: true, state: next };
  }
  if (next.quiet >= 120) {
    next.draw = true;
    next.endReason = 'moveLimit';
  } else if (cap && !hasAttacker(board, 1) && !hasAttacker(board, -1)) {
    next.draw = true;
    next.endReason = 'material';
  }
  return { ok: true, state: next };
}

/** Dựng lại ván từ danh sách nước (dùng cho "đi lại") */
export function replay(moves: readonly XqMove[]): XqState {
  let g = newGame();
  for (const [f, t] of moves) {
    const r = applyMove(g, f, t);
    if (!r.ok) break;
    g = r.state;
  }
  return g;
}

// ------------------------------------------------------------------ ký hiệu nước đi kiểu Việt Nam

/** Chữ viết tắt quân: Tg Tướng, S Sĩ, T Tượng, M Mã, X Xe, P Pháo, B Binh (Tốt) */
export const PIECE_ABBR: Record<number, string> = {
  1: 'Tg',
  2: 'S',
  3: 'T',
  4: 'M',
  5: 'X',
  6: 'P',
  7: 'B',
};
export const PIECE_NAME_VI: Record<number, string> = {
  1: 'Tướng',
  2: 'Sĩ',
  3: 'Tượng',
  4: 'Mã',
  5: 'Xe',
  6: 'Pháo',
  7: 'Tốt',
};

/** Cột theo cách đếm của mỗi bên (1 = cột bên tay phải người cầm quân đó) */
const fileOf = (x: number, side: Side) => (side === 1 ? 9 - x : x + 1);

/**
 * Ký hiệu nước đi (trước khi đi), ví dụ "P2-5" (pháo cột 2 bình sang cột 5), "M8.7" (mã tiến), "X1/2" (xe thoái 2).
 * Hai quân cùng loại trên một cột: thêm "t" (trước) / "s" (sau).
 */
export function notation(
  board: readonly number[],
  from: number,
  to: number,
): string {
  const p = board[from];
  if (!p) return '?';
  const side = sideOf(p) as Side;
  const t = Math.abs(p);
  const x0 = sqX(from);
  const y0 = sqY(from);
  const x1 = sqX(to);
  const y1 = sqY(to);
  let name = PIECE_ABBR[t] + fileOf(x0, side);
  const same: number[] = [];
  for (let y = 0; y < ROWS; y++) if (board[idx(x0, y)] === p) same.push(y);
  if (same.length >= 2 && t !== ADVISOR && t !== ELEPHANT) {
    // "trước" = quân gần phía đối phương hơn
    const ordered = side === 1 ? same : same.slice().reverse();
    name = PIECE_ABBR[t] + (ordered[0] === y0 ? 't' : 's');
  }
  if (y0 === y1) return `${name}-${fileOf(x1, side)}`;
  const forward = side === 1 ? y1 < y0 : y1 > y0;
  const op = forward ? '.' : '/';
  const diagonal = t === HORSE || t === ADVISOR || t === ELEPHANT;
  return `${name}${op}${diagonal ? fileOf(x1, side) : Math.abs(y1 - y0)}`;
}

/** Ký hiệu cho cả ván */
export function notations(moves: readonly XqMove[]): string[] {
  let b = initialBoard();
  return moves.map(([f, t]) => {
    const s = notation(b, f, t);
    b = b.slice();
    b[t] = b[f];
    b[f] = 0;
    return s;
  });
}
