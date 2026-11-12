import type { PhysicsConfig } from './config';
import type { BallPositions, ShotCommand, Vec3 } from './types';

/**
 * HÌNH HỌC CÂY CƠ (3D)
 *
 * Hướng ngang ĥ = (dirX, dirY) và góc nâng θ (0° nằm ngang → 90° dựng đứng) độc lập.
 * Trục cơ (hướng đầu cơ lao tới):  d = (cosθ·ĥx, cosθ·ĥy, −sinθ)
 * Khung toạ độ vuông góc trục cơ:   s = (ĥy, −ĥx, 0)  (bên phải)
 *                                   u = s × d          (phía "trên" của cơ)
 * θ = 0  → u = ẑ (trên thật);  θ = 90° → d = −ẑ, u = ĥ (điểm chạm lệch theo mặt phẳng ngang).
 *
 * Điểm chạm trên bi (so với tâm): giao điểm ĐẦU TIÊN của trục cơ đã lệch (a, b) với mặt cầu
 *   r = R·( a·s + b·u − √(1 − a² − b²)·d )
 */
export interface CueFrame {
  d: Vec3;
  s: Vec3;
  u: Vec3;
  /** Góc nâng (radian) */
  theta: number;
}

export function cueFrame(shot: ShotCommand): CueFrame {
  const deg = Math.max(0, Math.min(90, shot.elevation));
  const theta = (deg * Math.PI) / 180;
  // Biên hình học: 0° và 90° dùng giá trị CHÍNH XÁC (tránh cos 90° ≈ 6e-17 làm lệch hướng)
  const c = deg === 90 ? 0 : deg === 0 ? 1 : Math.cos(theta);
  const sn = deg === 90 ? 1 : deg === 0 ? 0 : Math.sin(theta);
  // Phương vị luôn được chuẩn hoá -> d luôn là vector đơn vị, s luôn xác định (kể cả ở 90°)
  const hl = Math.hypot(shot.dirX, shot.dirY) || 1;
  const hx = shot.dirX / hl;
  const hy = shot.dirY / hl;
  const d: Vec3 = { x: c * hx, y: c * hy, z: -sn };
  const s: Vec3 = { x: hy, y: -hx, z: 0 };
  // u = s × d
  const u: Vec3 = {
    x: s.y * d.z - s.z * d.y,
    y: s.z * d.x - s.x * d.z,
    z: s.x * d.y - s.y * d.x,
  };
  return { d, s, u, theta };
}

/** Điểm chạm đầu cơ trên bi (vector từ tâm bi) */
export function cueContactPoint(shot: ShotCommand, c: PhysicsConfig): Vec3 {
  const { d, s, u } = cueFrame(shot);
  const R = c.ballRadius;
  const a = shot.tipX * c.maxTipOffset;
  const b = shot.tipY * c.maxTipOffset;
  const depth = Math.sqrt(Math.max(0, 1 - a * a - b * b));
  return {
    x: R * (a * s.x + b * u.x - depth * d.x),
    y: R * (a * s.y + b * u.y - depth * d.y),
    z: R * (a * s.z + b * u.z - depth * d.z),
  };
}

export type CueObstruction = 'cloth' | 'rail' | 'ball';

export interface CueClearance {
  ok: boolean;
  /** Vật cản đầu tiên (nếu có) */
  blockedBy?: CueObstruction;
  reason?: string;
  /** Góc nâng nhỏ nhất (độ) để cơ không vướng, null nếu không có góc nào hợp lệ */
  minElevation: number | null;
}

/** Khoảng cách theo phương ngang từ điểm (px, py) đi ngược hướng (bx, by) tới mép băng */
function distanceToRail(
  px: number,
  py: number,
  bx: number,
  by: number,
  c: PhysicsConfig,
): number {
  const hw = c.tableWidth / 2;
  const hh = c.tableHeight / 2;
  let t = Infinity;
  if (bx > 1e-9) t = Math.min(t, (hw - px) / bx);
  if (bx < -1e-9) t = Math.min(t, (-hw - px) / bx);
  if (by > 1e-9) t = Math.min(t, (hh - py) / by);
  if (by < -1e-9) t = Math.min(t, (-hh - py) / by);
  return Math.max(0, t);
}

/** Kiểm tra va chạm cơ - bàn - băng - bi tại đúng góc nâng của lệnh đánh */
function checkAt(
  balls: BallPositions,
  shot: ShotCommand,
  c: PhysicsConfig,
): { ok: boolean; blockedBy?: CueObstruction } {
  const { d, u, theta } = cueFrame(shot);
  const R = c.ballRadius;
  const r = cueContactPoint(shot, c);
  const [cx, cy] = balls[shot.cue];
  // Điểm chạm trong toạ độ bàn (z = 0 là mặt vải)
  const P: Vec3 = { x: cx + r.x, y: cy + r.y, z: R + r.z };

  // 1. Đầu cơ (đĩa bán kính tipR vuông góc trục cơ) không được chạm mặt vải
  const tipLowest = P.z - c.cueTipRadius * Math.abs(u.z);
  if (tipLowest < 0) return { ok: false, blockedBy: 'cloth' };

  // 2. Thân cơ phía sau không được đè lên thành băng
  if (theta < Math.PI / 2 - 1e-6) {
    const hl = Math.hypot(d.x, d.y);
    const back = { x: -d.x / hl, y: -d.y / hl };
    const L = distanceToRail(P.x, P.y, back.x, back.y, c);
    // Băng nằm ngoài chiều dài cây cơ (tính theo phương ngang) thì không vướng
    const reach = c.cueLength * Math.cos(theta);
    const shaftLowest =
      P.z + L * Math.tan(theta) - c.cueShaftRadius * Math.cos(theta);
    if (L < reach && shaftLowest < c.railTopHeight)
      return { ok: false, blockedBy: 'rail' };
  }

  // 3. Thân cơ không được xuyên qua bi khác (khoảng cách 3D từ tâm bi tới trục cơ phía sau)
  for (let i = 0; i < balls.length; i++) {
    if (i === shot.cue) continue;
    const B: Vec3 = { x: balls[i][0], y: balls[i][1], z: R };
    const w: Vec3 = { x: B.x - P.x, y: B.y - P.y, z: B.z - P.z };
    const along = -(w.x * d.x + w.y * d.y + w.z * d.z); // >0: nằm phía sau đầu cơ
    if (along <= 0 || along > c.cueLength) continue;
    // |w × d| = khoảng cách tới trục cơ
    const cxv = w.y * d.z - w.z * d.y;
    const cyv = w.z * d.x - w.x * d.z;
    const czv = w.x * d.y - w.y * d.x;
    const dist = Math.sqrt(cxv * cxv + cyv * cyv + czv * czv);
    if (dist < R + c.cueShaftRadius) return { ok: false, blockedBy: 'ball' };
  }
  return { ok: true };
}

const REASON: Record<CueObstruction, string> = {
  cloth: 'Đầu cơ chạm mặt bàn trước bi',
  rail: 'Thân cơ vướng thành băng',
  ball: 'Thân cơ vướng vào bi khác',
};

/**
 * Kiểm tra lệnh đánh có thực hiện được về mặt hình học không.
 * Nếu vướng, tìm góc nâng nhỏ nhất (bước 0.5°) để cơ không chạm bàn / băng / bi.
 */
export function checkCueClearance(
  balls: BallPositions,
  shot: ShotCommand,
  c: PhysicsConfig,
): CueClearance {
  const res = checkAt(balls, shot, c);
  if (res.ok) return { ok: true, minElevation: shot.elevation };
  let minElevation: number | null = null;
  for (
    let e = Math.ceil(shot.elevation * 2) / 2;
    e <= c.maxElevation;
    e += 0.5
  ) {
    if (checkAt(balls, { ...shot, elevation: e }, c).ok) {
      minElevation = e;
      break;
    }
  }
  return {
    ok: false,
    blockedBy: res.blockedBy,
    reason: REASON[res.blockedBy ?? 'cloth'],
    minElevation,
  };
}
