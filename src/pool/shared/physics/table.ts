// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import { POOL_PHYSICS, type PoolConfig } from './config';
import { DEG, dcos, dlen, dsin } from './math';

/** Đoạn thẳng băng: mũi băng (rail) hoặc mặt vát mũi lỗ (jaw) */
export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  kind: 'rail' | 'jaw';
}

/** Mũi lỗ bo tròn: hình trụ đứng bán kính r (tâm nằm trong thân băng) */
export interface Nose {
  x: number;
  y: number;
  r: number;
  pocket: number;
}

export interface Pocket {
  id: number;
  name: string;
  short: string;
  kind: 'corner' | 'side';
  /** Hố rơi: bi rơi khi TÂM bi vượt qua mép hố */
  x: number;
  y: number;
  r: number;
  /** Thành sau lỗ (bọc da): bán kính tính từ tâm hố */
  backR: number;
  /** Tâm đường miệng lỗ & hướng đi vào lỗ */
  mouthX: number;
  mouthY: number;
  axisX: number;
  axisY: number;
  /** 2 điểm mũi lỗ (jaw point) — khoảng cách giữa chúng = độ rộng miệng */
  tips: [[number, number], [number, number]];
  mouth: number;
  shelf: number;
}

export interface TableGeometry {
  L: number;
  W: number;
  segments: Segment[];
  noses: Nose[];
  pockets: Pocket[];
  footSpot: { x: number; y: number };
  headSpot: { x: number; y: number };
  headStringX: number;
}

/**
 * HÌNH HỌC BÀN 9 FEET, 6 LỖ (WPA) ở cao độ mũi băng.
 * Mỗi lỗ gồm:
 *  1. 2 đoạn mũi băng thẳng kết thúc tại 2 ĐIỂM MŨI LỖ; khoảng cách giữa chúng = độ rộng miệng
 *     (lỗ góc đo theo đường chéo nối 2 mũi, lỗ giữa đo dọc băng).
 *  2. 2 MẶT VÁT đi từ điểm mũi lỗ vào trong theo góc vát 142° (góc) / 104° (giữa) so với mũi băng.
 *  3. Góc giữa mũi băng và mặt vát được BO TRÒN bán kính noseRadius (tiếp tuyến cả 2 đường).
 *  4. THỀM: mặt phẳng từ đường mũi băng tới mép hố — bi vẫn lăn được, chưa rơi.
 *  5. HỐ RƠI tròn. 6. THÀNH SAU LỖ (bi đánh quá mạnh đập vào và có thể bật ra).
 */
export function buildTable(c: PoolConfig = POOL_PHYSICS): TableGeometry {
  const L = c.tableLength;
  const W = c.tableWidth;
  const hx = L / 2;
  const hy = W / 2;
  const segments: Segment[] = [];
  const noses: Nose[] = [];
  const pockets: Pocket[] = [];
  const a = c.cornerMouth / Math.SQRT2;
  const m = c.sideMouth / 2;
  const cj = (180 - c.cornerJawAngle) * DEG;
  const sj = c.sideJawAngle * DEG;
  const rho = c.noseRadius;

  /**
   * Bo tròn góc tại điểm mũi lỗ P giữa hướng mũi băng ur (đi xa lỗ) và hướng mặt vát uj
   * (đi vào lỗ), góc kẹp θ. Trả về 2 điểm tiếp tuyến & tâm cung.
   */
  const round = (
    px: number,
    py: number,
    ur: [number, number],
    uj: [number, number],
    theta: number,
  ) => {
    const t = rho / (dsin(theta / 2) / dcos(theta / 2)); // ρ / tan(θ/2)
    let bx = ur[0] + uj[0];
    let by = ur[1] + uj[1];
    const bl = dlen(bx, by);
    bx /= bl;
    by /= bl;
    const d = rho / dsin(theta / 2);
    return {
      onRail: [px + ur[0] * t, py + ur[1] * t] as [number, number],
      onJaw: [px + uj[0] * t, py + uj[1] * t] as [number, number],
      center: [px + bx * d, py + by * d] as [number, number],
    };
  };

  /** Điểm cuối mũi băng (sau khi bo tròn) tại mỗi điểm mũi lỗ, khoá theo toạ độ */
  const railEnd = new Map<string, [number, number]>();
  const key = (x: number, y: number) => `${x.toFixed(6)},${y.toFixed(6)}`;

  const addJaw = (
    pocketId: number,
    P: [number, number],
    ur: [number, number],
    uj: [number, number],
    theta: number,
    len: number,
  ) => {
    const r = round(P[0], P[1], ur, uj, theta);
    railEnd.set(key(P[0], P[1]), r.onRail);
    noses.push({ x: r.center[0], y: r.center[1], r: rho, pocket: pocketId });
    segments.push({
      ax: r.onJaw[0],
      ay: r.onJaw[1],
      bx: P[0] + uj[0] * len,
      by: P[1] + uj[1] * len,
      kind: 'jaw',
    });
  };

  const corner = (sx: number, sy: number, name: string, short: string) => {
    const id = pockets.length;
    const t1: [number, number] = [sx * (hx - a), sy * hy];
    const t2: [number, number] = [sx * hx, sy * (hy - a)];
    const l = c.cornerJawLength;
    const theta = c.cornerJawAngle * DEG;
    addJaw(id, t1, [-sx, 0], [sx * dcos(cj), sy * dsin(cj)], theta, l);
    addJaw(id, t2, [0, -sy], [sx * dsin(cj), sy * dcos(cj)], theta, l);
    const mx = (t1[0] + t2[0]) / 2;
    const my = (t1[1] + t2[1]) / 2;
    const ax = sx / Math.SQRT2;
    const ay = sy / Math.SQRT2;
    const d = c.cornerShelf + c.cornerHoleRadius;
    pockets.push({
      id,
      name,
      short,
      kind: 'corner',
      x: mx + ax * d,
      y: my + ay * d,
      r: c.cornerHoleRadius,
      backR: c.cornerHoleRadius + 0.004,
      mouthX: mx,
      mouthY: my,
      axisX: ax,
      axisY: ay,
      tips: [t1, t2],
      mouth: dlen(t1[0] - t2[0], t1[1] - t2[1]),
      shelf: c.cornerShelf,
    });
  };

  const side = (sy: number, name: string, short: string) => {
    const id = pockets.length;
    const l = c.sideJawLength;
    const theta = c.sideJawAngle * DEG;
    for (const sx of [1, -1]) {
      addJaw(
        id,
        [sx * m, sy * hy],
        [sx, 0],
        [sx * dcos(sj), sy * dsin(sj)],
        theta,
        l,
      );
    }
    const d = c.sideShelf + c.sideHoleRadius;
    pockets.push({
      id,
      name,
      short,
      kind: 'side',
      x: 0,
      y: sy * (hy + d),
      r: c.sideHoleRadius,
      backR: c.sideHoleRadius + 0.004,
      mouthX: 0,
      mouthY: sy * hy,
      axisX: 0,
      axisY: sy,
      tips: [
        [-m, sy * hy],
        [m, sy * hy],
      ],
      mouth: 2 * m,
      shelf: c.sideShelf,
    });
  };

  // Thứ tự lỗ: hàng trên (trái → phải), rồi hàng dưới
  corner(-1, 1, 'Góc trên trái', '↖');
  side(1, 'Giữa trên', '↑');
  corner(1, 1, 'Góc trên phải', '↗');
  corner(-1, -1, 'Góc dưới trái', '↙');
  side(-1, 'Giữa dưới', '↓');
  corner(1, -1, 'Góc dưới phải', '↘');

  // Mũi băng: 4 đoạn dài (bị lỗ giữa chia đôi) + 2 đoạn ngắn, cắt ngắn tại điểm bo tròn
  const rail = (ax: number, ay: number, bx: number, by: number) => {
    const A = railEnd.get(key(ax, ay)) ?? [ax, ay];
    const B = railEnd.get(key(bx, by)) ?? [bx, by];
    segments.unshift({ ax: A[0], ay: A[1], bx: B[0], by: B[1], kind: 'rail' });
  };
  for (const sx of [-1, 1]) rail(sx * hx, -hy + a, sx * hx, hy - a);
  for (const sy of [-1, 1]) {
    rail(m, sy * hy, hx - a, sy * hy);
    rail(-hx + a, sy * hy, -m, sy * hy);
  }

  return {
    L,
    W,
    segments,
    noses,
    pockets,
    footSpot: { x: L / 4, y: 0 },
    headSpot: { x: -L / 4, y: 0 },
    headStringX: -L / 4,
  };
}

export const POOL_TABLE = buildTable(POOL_PHYSICS);

/** Bộ nhớ đệm hình học theo preset lỗ */
const cache = new Map<string, TableGeometry>();
export function tableFor(c: PoolConfig): TableGeometry {
  const k = `${c.cornerMouth}|${c.sideMouth}|${c.cornerShelf}|${c.sideShelf}|${c.noseRadius}`;
  let t = cache.get(k);
  if (!t) {
    t = buildTable(c);
    cache.set(k, t);
  }
  return t;
}

/** Điểm gần nhất trên đoạn thẳng */
export function closestOnSegment(s: Segment, px: number, py: number) {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - s.ax) * dx + (py - s.ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: s.ax + dx * t, y: s.ay + dy * t };
}
