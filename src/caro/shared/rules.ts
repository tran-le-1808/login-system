/**
 * LUẬT CỜ CARO (dùng chung client & server — server là nguồn xác thực).
 * Bàn 20×20, 5 quân liền trở lên (ngang / dọc / chéo) là thắng.
 * - "free"   (chặn 1 đầu): 5 quân liền luôn thắng, kể cả khi bị chặn cả hai đầu.
 * - "block2" (chặn 2 đầu): 5 quân liền bị quân đối thủ chặn ở CẢ HAI đầu thì không thắng; bị chặn một đầu vẫn thắng.
 * Mép bàn KHÔNG tính là quân chặn.
 * Bản sao phía server: login-system/src/caro/shared/rules.ts (đồng bộ bằng `npm run caro:sync-shared`).
 */
export const BOARD_SIZE = 20;
export const WIN_LENGTH = 5;

export type CaroRule = 'free' | 'block2';
/** 0 trống, 1 quân X, 2 quân O */
export type Cell = 0 | 1 | 2;
export type Stone = 1 | 2;

export const RULE_LABEL: Record<CaroRule, string> = {
  free: 'Chặn 1 đầu',
  block2: 'Chặn 2 đầu',
};
export const RULE_HINT: Record<CaroRule, string> = {
  free: '5 quân liền là thắng, kể cả khi bị chặn hai đầu',
  block2: '5 quân bị chặn cả hai đầu thì không tính thắng',
};

export const DIRS: readonly [number, number][] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

export const idx = (x: number, y: number, size = BOARD_SIZE) => y * size + x;
export const inside = (x: number, y: number, size = BOARD_SIZE) =>
  x >= 0 && y >= 0 && x < size && y < size;
export const other = (s: Stone): Stone => (s === 1 ? 2 : 1);

export function emptyBoard(size = BOARD_SIZE): Cell[] {
  return new Array<Cell>(size * size).fill(0);
}

export interface WinLine {
  stone: Stone;
  cells: [number, number][];
}

/** Ô thứ k theo hướng (dx, dy) có phải quân đối thủ (chặn) không — mép bàn không tính */
function blockedAt(
  board: readonly Cell[],
  x: number,
  y: number,
  s: Stone,
  size: number,
): boolean {
  return inside(x, y, size) && board[idx(x, y, size)] === other(s);
}

/** Kiểm tra nước vừa đi tại (x, y) có thắng không theo luật */
export function checkWin(
  board: readonly Cell[],
  x: number,
  y: number,
  rule: CaroRule,
  size = BOARD_SIZE,
): WinLine | null {
  const s = board[idx(x, y, size)];
  if (s === 0) return null;
  for (const [dx, dy] of DIRS) {
    const cells: [number, number][] = [[x, y]];
    let ax = x + dx;
    let ay = y + dy;
    while (inside(ax, ay, size) && board[idx(ax, ay, size)] === s) {
      cells.push([ax, ay]);
      ax += dx;
      ay += dy;
    }
    let bx = x - dx;
    let by = y - dy;
    while (inside(bx, by, size) && board[idx(bx, by, size)] === s) {
      cells.unshift([bx, by]);
      bx -= dx;
      by -= dy;
    }
    if (cells.length < WIN_LENGTH) continue;
    if (
      rule === 'block2' &&
      blockedAt(board, ax, ay, s, size) &&
      blockedAt(board, bx, by, s, size)
    )
      continue;
    return { stone: s, cells };
  }
  return null;
}

export type MoveError =
  | 'OUT_OF_BOARD'
  | 'OCCUPIED'
  | 'GAME_OVER'
  | 'NOT_YOUR_TURN';

export interface CaroGameState {
  size: number;
  rule: CaroRule;
  board: Cell[];
  /** Quân đến lượt */
  turn: Stone;
  moves: [number, number][];
  winner: Stone | null;
  winLine: [number, number][] | null;
  draw: boolean;
}

export function newGame(rule: CaroRule, size = BOARD_SIZE): CaroGameState {
  return {
    size,
    rule,
    board: emptyBoard(size),
    turn: 1,
    moves: [],
    winner: null,
    winLine: null,
    draw: false,
  };
}

/** Đi một nước (trả về trạng thái mới, không sửa trạng thái cũ) */
export function applyMove(
  g: CaroGameState,
  x: number,
  y: number,
): { ok: true; state: CaroGameState } | { ok: false; error: MoveError } {
  if (g.winner !== null || g.draw) return { ok: false, error: 'GAME_OVER' };
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inside(x, y, g.size))
    return { ok: false, error: 'OUT_OF_BOARD' };
  const i = idx(x, y, g.size);
  if (g.board[i] !== 0) return { ok: false, error: 'OCCUPIED' };
  const board = g.board.slice();
  board[i] = g.turn;
  const win = checkWin(board, x, y, g.rule, g.size);
  const moves = [...g.moves, [x, y] as [number, number]];
  return {
    ok: true,
    state: {
      ...g,
      board,
      moves,
      turn: other(g.turn),
      winner: win ? win.stone : null,
      winLine: win ? win.cells : null,
      draw: !win && moves.length >= g.size * g.size,
    },
  };
}

export const MOVE_ERROR_VI: Record<MoveError, string> = {
  OUT_OF_BOARD: 'Nước đi ngoài bàn cờ',
  OCCUPIED: 'Ô này đã có quân',
  GAME_OVER: 'Ván đã kết thúc',
  NOT_YOUR_TURN: 'Chưa tới lượt bạn',
};
