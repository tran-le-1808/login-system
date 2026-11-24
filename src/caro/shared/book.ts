/**
 * SÁCH KHAI CUỘC: chuẩn hoá thế cờ để các thế giống nhau (xoay / lật / tịnh tiến) có cùng một khoá.
 * Dùng chung client & server (bản sao: login-system/src/caro/shared/book.ts — `npm run caro:sync-shared`).
 * Không tính mép bàn (khai cuộc thường ở giữa bàn 20×20).
 */
export type Move = [number, number];

/** Số nước đầu được ghi vào sách */
export const BOOK_PLIES = 16;

const TRANSFORMS: ((x: number, y: number) => Move)[] = [
  (x, y) => [x, y],
  (x, y) => [-y, x],
  (x, y) => [-x, -y],
  (x, y) => [y, -x],
  (x, y) => [-x, y],
  (x, y) => [x, -y],
  (x, y) => [y, x],
  (x, y) => [-y, -x],
];
/** Biến đổi ngược của TRANSFORMS[i] */
const INVERSE = [0, 3, 2, 1, 4, 5, 6, 7];

export interface Canonical {
  key: string;
  /** Toạ độ thật -> toạ độ chuẩn */
  toCanon: (m: Move) => string;
  /** Toạ độ chuẩn ("x,y") -> toạ độ thật */
  fromCanon: (c: string) => Move;
}

/** Khoá chuẩn của thế cờ sau các nước `moves` (X đi trước, luân phiên) */
export function canonical(moves: readonly Move[]): Canonical {
  let best: { key: string; t: number; ox: number; oy: number } | null = null;
  for (let t = 0; t < 8; t++) {
    const pts = moves.map(([x, y], i) => {
      const [a, b] = TRANSFORMS[t](x, y);
      return { a, b, s: i % 2 === 0 ? 'x' : 'o' };
    });
    const ox = pts.length ? Math.min(...pts.map((p) => p.a)) : 0;
    const oy = pts.length ? Math.min(...pts.map((p) => p.b)) : 0;
    const key = pts
      .map((p) => `${p.s}${p.a - ox}.${p.b - oy}`)
      .sort()
      .join(' ');
    if (!best || key < best.key) best = { key, t, ox, oy };
  }
  const b = best!;
  return {
    key: `${moves.length}|${b.key}`,
    toCanon: ([x, y]) => {
      const [a, c] = TRANSFORMS[b.t](x, y);
      return `${a - b.ox},${c - b.oy}`;
    },
    fromCanon: (s) => {
      const [a, c] = s.split(',').map(Number);
      return TRANSFORMS[INVERSE[b.t]](a + b.ox, c + b.oy);
    },
  };
}

/** Thống kê một nước trong sách (theo góc nhìn bên đi nước đó) */
export interface BookMove {
  x: number;
  y: number;
  /** số ván */
  n: number;
  /** điểm trung bình: thắng 1, hoà 0.5, thua 0 */
  score: number;
}
