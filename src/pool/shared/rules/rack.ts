// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import { POOL_PHYSICS } from '../physics/config';
import { POOL_TABLE } from '../physics/table';
import type { BallSpot } from '../physics/types';
import type { GameType } from './types';

/** PRNG xác định (mulberry32) — xếp bi tái lập được từ seed */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const R = POOL_PHYSICS.ballRadius;
/**
 * Khung bi thật không bao giờ khít tuyệt đối: khe hở ~0.4 mm + lệch ngẫu nhiên ≤ 0.15 mm
 * (xác định theo seed). Không có khe, xung lực truyền tuần tự dồn hết năng lượng vào
 * 2 bi góc cuối như con lắc Newton — cú phá trông giả.
 */
const GAP = 0.0004;
const JITTER = 0.00015;
const SP = 2 * R + GAP;
const ROW_DX = SP * (Math.sqrt(3) / 2); // cos 30° (xác định)

/** Toạ độ ô (hàng i, vị trí j) với đỉnh khung ở foot spot, khung mở về phía băng cuối (+x) */
function slot(i: number, j: number, rowLen: number, rand: () => number) {
  const jx = i === 0 ? 0 : (rand() * 2 - 1) * JITTER;
  const jy = i === 0 ? 0 : (rand() * 2 - 1) * JITTER;
  return {
    x: POOL_TABLE.footSpot.x + i * ROW_DX + jx,
    y: (j - (rowLen - 1) / 2) * SP + jy,
  };
}

export const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
export const STRIPES = [9, 10, 11, 12, 13, 14, 15];

/**
 * 8 bi (WPA): tam giác 15 bi, đỉnh tại foot spot, bi 8 giữa hàng 3,
 * 2 góc cuối: 1 bi trơn + 1 bi sọc, còn lại ngẫu nhiên.
 */
export function rackEight(seed: number): BallSpot[] {
  const rand = rng(seed);
  const solid = SOLIDS[Math.floor(rand() * 7)];
  const stripe = STRIPES[Math.floor(rand() * 7)];
  const [left, right] = rand() < 0.5 ? [solid, stripe] : [stripe, solid];
  const rest = shuffle(
    [...SOLIDS, ...STRIPES].filter((n) => n !== solid && n !== stripe),
    rand,
  );
  const out: BallSpot[] = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j <= i; j++) {
      let n: number;
      if (i === 2 && j === 1) n = 8;
      else if (i === 4 && j === 0) n = left;
      else if (i === 4 && j === 4) n = right;
      else n = rest.pop()!;
      out.push({ n, ...slot(i, j, i + 1, rand) });
    }
  }
  return out;
}

/** 9 bi (WPA): hình thoi 1-2-3-2-1, bi 1 ở đỉnh (foot spot), bi 9 chính giữa, còn lại ngẫu nhiên */
export function rackNine(seed: number): BallSpot[] {
  const rand = rng(seed);
  const rest = shuffle([2, 3, 4, 5, 6, 7, 8], rand);
  const rows = [1, 2, 3, 2, 1];
  const out: BallSpot[] = [];
  rows.forEach((len, i) => {
    for (let j = 0; j < len; j++) {
      let n: number;
      if (i === 0) n = 1;
      else if (i === 2 && j === 1) n = 9;
      else n = rest.pop()!;
      out.push({ n, ...slot(i, j, len, rand) });
    }
  });
  return out;
}

export function rackFor(type: GameType, seed: number): BallSpot[] {
  return type === 'eight' ? rackEight(seed) : rackNine(seed);
}

const freeAt = (balls: BallSpot[], x: number, y: number, ignore = -1) =>
  balls.every(
    (b) => b.n === ignore || Math.hypot(b.x - x, b.y - y) >= 2 * R + 1e-6,
  );

/**
 * Đặt lại bi (spotting): lên foot spot; nếu bị chiếm thì trên đường dọc từ foot spot về
 * băng cuối, sát bi chắn nhất có thể; hết chỗ thì đặt phía trước foot spot.
 */
export function spotBall(balls: BallSpot[], n: number): BallSpot[] {
  const rest = balls.filter((b) => b.n !== n);
  const { x: fx } = POOL_TABLE.footSpot;
  const maxX = POOL_TABLE.L / 2 - R - 0.001;
  if (freeAt(rest, fx, 0)) return [...rest, { n, x: fx, y: 0 }];
  // Tìm vị trí trống đầu tiên từ foot spot đi về băng cuối, rồi về phía đầu bàn
  const step = 0.0005;
  for (let x = fx; x <= maxX; x += step) {
    if (freeAt(rest, x, 0)) return [...rest, { n, x, y: 0 }];
  }
  for (let x = fx; x >= -maxX; x -= step) {
    if (freeAt(rest, x, 0)) return [...rest, { n, x, y: 0 }];
  }
  return [...rest, { n, x: fx, y: 0 }];
}

/** Vị trí đặt bi cái có hợp lệ không (trong bàn, không chồng bi, kitchen nếu cần) */
export function isValidCuePlacement(
  balls: BallSpot[],
  x: number,
  y: number,
  kitchen: boolean,
): boolean {
  const hx = POOL_TABLE.L / 2 - R;
  const hy = POOL_TABLE.W / 2 - R;
  if (Math.abs(x) > hx || Math.abs(y) > hy) return false;
  if (kitchen && x > POOL_TABLE.headStringX) return false;
  return freeAt(balls, x, y, 0);
}

/** Kẹp vị trí bi cái về vùng hợp lệ gần nhất (để kéo thả mượt) */
export function clampCuePlacement(x: number, y: number, kitchen: boolean) {
  const hx = POOL_TABLE.L / 2 - R;
  const hy = POOL_TABLE.W / 2 - R;
  return {
    x: Math.max(-hx, Math.min(kitchen ? POOL_TABLE.headStringX : hx, x)),
    y: Math.max(-hy, Math.min(hy, y)),
  };
}

/** Vị trí mặc định của bi cái khi có bi trong tay */
export function defaultCueSpot(
  balls: BallSpot[],
  kitchen: boolean,
): { x: number; y: number } {
  const others = balls.filter((b) => b.n !== 0);
  const { x: hx } = POOL_TABLE.headSpot;
  const cands: [number, number][] = [[hx, 0]];
  for (let k = 1; k < 40; k++) {
    const d = k * 0.03;
    cands.push([hx, d], [hx, -d], [hx - d, 0], [kitchen ? hx - d : hx + d, 0]);
  }
  for (const [x, y] of cands)
    if (isValidCuePlacement(others, x, y, kitchen)) return { x, y };
  return { x: hx, y: 0 };
}

export function withCueAt(balls: BallSpot[], x: number, y: number): BallSpot[] {
  return [{ n: 0, x, y }, ...balls.filter((b) => b.n !== 0)];
}
