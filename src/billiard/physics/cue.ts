import { inertia, type PhysicsConfig } from './config';
import type { BallId, BallState, ShotCommand, Vec3 } from './types';
import { clamp, cross } from './vector';
import { cueContactPoint, cueFrame } from './cueGeometry';

/**
 * Kiểm tra NGHIÊM lệnh đánh từ client (server & client đều gọi trước khi gửi / xử lý).
 * Trả về lỗi (chuỗi) nếu không hợp lệ — không âm thầm sửa giá trị sai.
 */
export function validateShotInput(
  input: Partial<Record<keyof ShotCommand, unknown>>,
): string | null {
  const isNum = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v);
  if (!isNum(input.dirX) || !isNum(input.dirY))
    return 'Hướng đánh không hợp lệ';
  if (Math.hypot(input.dirX, input.dirY) < 1e-9)
    return 'Hướng đánh không hợp lệ';
  if (!isNum(input.power) || input.power < 0 || input.power > 1)
    return 'Lực đánh không hợp lệ (0–100%)';
  if (!isNum(input.elevation) || input.elevation < 0 || input.elevation > 90)
    return 'Góc cơ không hợp lệ (0°–90°)';
  for (const k of ['tipX', 'tipY'] as const) {
    if (input[k] !== undefined && (!isNum(input[k]) || Math.abs(input[k]) > 1))
      return 'Điểm chạm không hợp lệ';
  }
  return null;
}

/**
 * Chuẩn hoá & giới hạn lệnh đánh (server dùng để chống dữ liệu bậy / gian lận).
 * Điểm chạm đầu cơ bị giới hạn trong hình tròn bán kính maxTipOffset·R.
 */
export function sanitizeShot(
  input: Partial<Record<keyof ShotCommand, unknown>>,
  cue: BallId,
): ShotCommand {
  const num = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  let dx = num(input.dirX, 1);
  let dy = num(input.dirY, 0);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  let tipX = clamp(num(input.tipX, 0), -1, 1);
  let tipY = clamp(num(input.tipY, 0), -1, 1);
  const tipLen = Math.sqrt(tipX * tipX + tipY * tipY);
  if (tipLen > 1) {
    tipX /= tipLen;
    tipY /= tipLen;
  }
  return {
    cue,
    dirX: dx,
    dirY: dy,
    power: clamp(num(input.power, 0.5), 0.01, 1),
    tipX,
    tipY,
    elevation: clamp(num(input.elevation, 0), 0, 90),
  };
}

/**
 * SWERVE (bi chạy cong do đánh lệch ngang khi nâng cơ) chỉ có từ MASSE_START_DEG, tăng mượt tới MASSE_FULL_DEG
 * (massé thật sự). Cú đánh thường / cơ chỉ nâng nhẹ thì bi đi THẲNG theo hướng ngắm: quỹ đạo không phụ thuộc lực.
 */
export const MASSE_START_DEG = 8;
export const MASSE_FULL_DEG = 15;
export function masseGate(elevationDeg: number): number {
  const t = clamp(
    (elevationDeg - MASSE_START_DEG) / (MASSE_FULL_DEG - MASSE_START_DEG),
    0,
    1,
  );
  return t * t * (3 - 2 * t);
}

/** Kết quả chi tiết của cú đánh (để kiểm chứng định luật & debug) */
export interface StrikeResult {
  /** Điểm chạm đầu cơ (vector từ tâm bi) */
  contact: Vec3;
  /** Hướng cơ (đơn vị) */
  direction: Vec3;
  /** Xung lực của đầu cơ lên bi (N·s) */
  cueImpulse: Vec3;
  /** Phản lực pháp tuyến của mặt bàn (N·s, hướng lên, ≥ 0) */
  tableNormalImpulse: number;
  /** Xung lực ma sát của mặt vải lúc bi bị kẹp giữa đầu cơ và bàn (N·s, nằm ngang) */
  tableFrictionImpulse: Vec3;
  /** Thay đổi vận tốc tâm bi (vz luôn = 0: bi không nảy) & vận tốc góc */
  dv: Vec3;
  dw: Vec3;
  /** Động năng của cơ trước va chạm (J) */
  cueEnergy: number;
}

/**
 * CÚ ĐÁNH CƠ (3D) — hàm thuần, không đổi trạng thái bi.
 *
 * Hệ toạ độ vật lý: x, y nằm ngang trên mặt bàn, z hướng lên (radian, SI).
 * Hướng cơ d = (cosθ·cosφ, cosθ·sinφ, −sinθ); điểm chạm r trên mặt cầu (cueGeometry).
 *
 * 1. VA CHẠM CƠ - BI: cơ khối lượng M, vận tốc V, đàn hồi đầu cơ e.
 *    Mặt bàn chặn chuyển động đứng của bi nên khối lượng hiệu dụng của bi theo d:
 *      1/m_hd = cos²θ/m + |r × d|²/I
 *      J = (1 + e)·V / (1/M + 1/m_hd),   xung lực cơ P = J·d
 *    Đánh lệch tâm / chúi cơ -> m_hd lớn -> J nhỏ: KHÔNG sinh năng lượng.
 * 2. RÀNG BUỘC MẶT BÀN: phản lực pháp tuyến N = −P_z = J·sinθ ≥ 0 tại đáy bi (đi qua tâm,
 *    không tạo mô-men); hệ số đàn hồi bàn = 0 nên bi không nảy (chế độ Carom, không jump).
 * 3. MA SÁT COULOMB tại đáy bi rb = −R·ẑ trong lúc bi bị kẹp: vận tốc trượt
 *      u = v + ω × rb,  F = −min(μ·N, |u|·2m/7)·û   (|F| ≤ μN)
 * Kết quả: m·Δv = P_ngang + F,   I·Δω = r × P + rb × F
 * -> top / back / English / masse / swerve đều sinh ra từ hình học & ma sát, không gán tay.
 */
export function computeCueStrike(
  shot: ShotCommand,
  c: PhysicsConfig,
  v0: Vec3 = { x: 0, y: 0, z: 0 },
  w0: Vec3 = { x: 0, y: 0, z: 0 },
): StrikeResult {
  const m = c.ballMass;
  const M = c.cueMass;
  const e = c.cueTipRestitution;
  const R = c.ballRadius;
  const I = inertia(c);
  const cueEnergy = cueKineticEnergy(shot, c);
  const cueSpeed = Math.sqrt((2 * cueEnergy) / M);

  const { d } = cueFrame(shot);
  const r = cueContactPoint(shot, c);
  const rxd = cross(r, d);
  const horiz2 = d.x * d.x + d.y * d.y; // = cos²θ (đúng bằng 0 ở 90°)
  const invBall =
    horiz2 / m + (rxd.x * rxd.x + rxd.y * rxd.y + rxd.z * rxd.z) / I;
  const J = ((1 + e) * cueSpeed) / (1 / M + invBall);
  const P: Vec3 = { x: J * d.x, y: J * d.y, z: J * d.z };

  // 1. Xung lực đầu cơ
  const tq = cross(r, P);
  const v: Vec3 = { x: v0.x + P.x / m, y: v0.y + P.y / m, z: 0 };
  const w: Vec3 = {
    x: w0.x + tq.x / I,
    y: w0.y + tq.y / I,
    z: w0.z + tq.z / I,
  };

  // Đánh lệch ngang + nâng cơ làm trục xoáy nghiêng về phía trước (thành phần ω dọc hướng đi) -> bi chạy cong
  // và độ cong đổi theo lực. Bỏ thành phần do cú đánh gây ra khi cơ chưa đủ dốc để massé: bi đi thẳng.
  const gate = masseGate(shot.elevation);
  if (gate < 1) {
    const hh = Math.sqrt(d.x * d.x + d.y * d.y);
    if (hh > 1e-9) {
      const hx = d.x / hh;
      const hy = d.y / hh;
      const along = (w.x - w0.x) * hx + (w.y - w0.y) * hy;
      w.x -= (1 - gate) * along * hx;
      w.y -= (1 - gate) * along * hy;
    }
  }

  // 2. Phản lực mặt bàn & 3. ma sát lúc bi bị kẹp
  const N = Math.max(0, -P.z);
  let F: Vec3 = { x: 0, y: 0, z: 0 };
  if (N > 0) {
    const ux = v.x - R * w.y;
    const uy = v.y + R * w.x;
    const u = Math.sqrt(ux * ux + uy * uy);
    if (u > 1e-12) {
      const Jt = Math.min(c.strikeTableFriction * N, (u * 2 * m) / 7);
      F = { x: (-Jt * ux) / u, y: (-Jt * uy) / u, z: 0 };
      const rb: Vec3 = { x: 0, y: 0, z: -R };
      const tf = cross(rb, F);
      v.x += F.x / m;
      v.y += F.y / m;
      w.x += tf.x / I;
      w.y += tf.y / I;
      w.z += tf.z / I;
    }
  }

  return {
    contact: r,
    direction: d,
    cueImpulse: P,
    tableNormalImpulse: N,
    tableFrictionImpulse: F,
    dv: { x: v.x - v0.x, y: v.y - v0.y, z: 0 },
    dw: { x: w.x - w0.x, y: w.y - w0.y, z: w.z - w0.z },
    cueEnergy,
  };
}

/** Áp cú đánh lên bi cái. Trả về tốc độ ngang ban đầu của bi. */
export function applyCueStrike(
  ball: BallState,
  shot: ShotCommand,
  c: PhysicsConfig,
): number {
  const res = computeCueStrike(
    shot,
    c,
    { x: ball.v.x, y: ball.v.y, z: 0 },
    ball.w,
  );
  ball.v.x += res.dv.x;
  ball.v.y += res.dv.y;
  ball.w = {
    x: ball.w.x + res.dw.x,
    y: ball.w.y + res.dw.y,
    z: ball.w.z + res.dw.z,
  };
  ball.state = 'sliding';
  return Math.sqrt(ball.v.x * ball.v.x + ball.v.y * ball.v.y);
}

/** Động năng của cơ ngay trước va chạm (để kiểm tra không sinh năng lượng) */
export function cueKineticEnergy(shot: ShotCommand, c: PhysicsConfig): number {
  const m = c.ballMass;
  const M = c.cueMass;
  const centerSpeed =
    c.minCueSpeed + (c.maxCueSpeed - c.minCueSpeed) * shot.power;
  const cueSpeed =
    (centerSpeed * m * (1 / M + 1 / m)) / (1 + c.cueTipRestitution);
  return 0.5 * M * cueSpeed * cueSpeed;
}
