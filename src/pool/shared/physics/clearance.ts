// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import type { PoolConfig } from './config';
import { cueContactPoint, cueFrame } from './cue';
import type { BallSpot, ShotCommand } from './types';

/**
 * KIỂM TRA CƠ CÓ ĐÁNH ĐƯỢC KHÔNG (hình học cây cơ, góc nâng 0–80°):
 *  1. đầu cơ không chạm mặt nỉ trước khi tới bi (đánh chúi sát nỉ),
 *  2. thân cơ phía sau không đè lên thành băng,
 *  3. thân cơ không xuyên qua bi khác nằm phía sau đầu cơ.
 * Server cũng gọi hàm này: cú đánh vướng bị từ chối (không "đánh xuyên" bi / băng).
 */
export type CueObstruction = 'cloth' | 'rail' | 'ball';

export interface CueClearance {
  ok: boolean;
  blockedBy?: CueObstruction;
  reason?: string;
  /** Góc nâng nhỏ nhất (độ, bước 0.5°) để cơ không vướng; null nếu không có góc nào */
  minElevation: number | null;
}

const REASON: Record<CueObstruction, string> = {
  cloth: 'Đầu cơ chạm mặt bàn trước bi',
  rail: 'Thân cơ vướng thành băng',
  ball: 'Thân cơ vướng vào bi khác',
};

/** Khoảng cách theo phương ngang từ (px, py) đi theo hướng (bx, by) tới mép bàn */
function distanceToEdge(
  px: number,
  py: number,
  bx: number,
  by: number,
  c: PoolConfig,
): number {
  const hw = c.tableLength / 2;
  const hh = c.tableWidth / 2;
  let t = Infinity;
  if (bx > 1e-9) t = Math.min(t, (hw - px) / bx);
  if (bx < -1e-9) t = Math.min(t, (-hw - px) / bx);
  if (by > 1e-9) t = Math.min(t, (hh - py) / by);
  if (by < -1e-9) t = Math.min(t, (-hh - py) / by);
  return Math.max(0, t);
}

function checkAt(
  balls: BallSpot[],
  shot: ShotCommand,
  c: PoolConfig,
): { ok: boolean; blockedBy?: CueObstruction } {
  const cue = balls.find((b) => b.n === 0);
  if (!cue) return { ok: true };
  const { d, u, theta } = cueFrame(shot);
  const R = c.ballRadius;
  const r = cueContactPoint(shot, c);
  // Điểm chạm trong toạ độ bàn (z = 0 là mặt nỉ)
  const Px = cue.x + r.x;
  const Py = cue.y + r.y;
  const Pz = R + r.z;

  // 1. Đầu cơ (đĩa vuông góc trục cơ) không được chạm mặt nỉ
  if (Pz - c.cueTipRadius * Math.abs(u.z) < 0)
    return { ok: false, blockedBy: 'cloth' };

  // 2. Thân cơ phía sau không được đè lên thành băng
  if (theta < Math.PI / 2 - 1e-6) {
    const hl = Math.hypot(d.x, d.y);
    const L = distanceToEdge(Px, Py, -d.x / hl, -d.y / hl, c);
    const reach = c.cueLength * Math.cos(theta);
    const shaftLowest =
      Pz + L * Math.tan(theta) - c.cueShaftRadius * Math.cos(theta);
    if (L < reach && shaftLowest < c.railTopHeight)
      return { ok: false, blockedBy: 'rail' };
  }

  // 3. Thân cơ không xuyên bi khác (khoảng cách 3D từ tâm bi tới trục cơ phía sau đầu cơ)
  for (const b of balls) {
    if (b.n === 0) continue;
    const wx = b.x - Px;
    const wy = b.y - Py;
    const wz = R - Pz;
    const along = -(wx * d.x + wy * d.y + wz * d.z); // > 0: nằm phía sau đầu cơ
    if (along <= 0 || along > c.cueLength) continue;
    const cx = wy * d.z - wz * d.y;
    const cy = wz * d.x - wx * d.z;
    const cz = wx * d.y - wy * d.x;
    if (Math.sqrt(cx * cx + cy * cy + cz * cz) < R + c.cueShaftRadius)
      return { ok: false, blockedBy: 'ball' };
  }
  return { ok: true };
}

export function checkCueClearance(
  balls: BallSpot[],
  shot: ShotCommand,
  c: PoolConfig,
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

/** Nâng đuôi cơ tự động tối đa (độ) để vượt thành băng — đủ nhỏ để không gây nhảy */
export const AUTO_LIFT_MAX = 6;

export interface LiftedShot {
  /** Cú đánh sẽ thực hiện (đã nâng đuôi cơ nếu cần) */
  shot: ShotCommand;
  clearance: CueClearance;
  lifted: boolean;
}

/**
 * Ngoài đời người chơi luôn hơi nâng đuôi cơ để thân cơ không đè lên thành băng (cây cơ dài 147 cm,
 * lúc đánh từ giữa bàn đuôi cơ nhô qua băng). Nếu CHỈ vướng băng và cần nâng ≤ AUTO_LIFT_MAX
 * thì nâng tự động; vướng bi hoặc cần nâng nhiều hơn thì giữ nguyên và báo lỗi.
 * Client (dự đoán) và server (kết quả chính thức) gọi cùng hàm này nên mô phỏng luôn khớp.
 */
export function liftShot(
  balls: BallSpot[],
  shot: ShotCommand,
  c: PoolConfig,
): LiftedShot {
  const first = checkAt(balls, shot, c);
  if (!first.ok && first.blockedBy === 'rail') {
    // Mức nâng NHỎ NHẤT chỉ để vượt băng (bỏ qua việc vướng bi, xét riêng sau)
    let e = Math.ceil(shot.elevation * 2) / 2;
    while (
      e <= AUTO_LIFT_MAX &&
      checkAt(balls, { ...shot, elevation: e }, c).blockedBy === 'rail'
    )
      e += 0.5;
    if (e <= AUTO_LIFT_MAX) {
      const lifted: ShotCommand = { ...shot, elevation: e };
      const again = checkCueClearance(balls, lifted, c);
      // Vượt băng rồi: nếu còn vướng bi thì báo đúng lý do (bi), kèm góc cần nâng
      return { shot: lifted, clearance: again, lifted: true };
    }
  }
  return { shot, clearance: checkCueClearance(balls, shot, c), lifted: false };
}
