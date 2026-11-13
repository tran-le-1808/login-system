// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import { inertia, powerToSpeed, type PoolConfig } from './config';
import type { Ball, ShotCommand, Vec3 } from './types';
import { DEG, dcos, dlen, dsin } from './math';

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/**
 * Khung toạ độ cây cơ: d = hướng đầu cơ lao tới (có góc nâng θ), s = bên phải, u = s × d (phía trên).
 */
export function cueFrame(shot: ShotCommand) {
  const th = clamp(shot.elevation, 0, 89.9) * DEG;
  const hl = dlen(shot.dirX, shot.dirY) || 1;
  const hx = shot.dirX / hl;
  const hy = shot.dirY / hl;
  const ct = dcos(th);
  const d: Vec3 = { x: ct * hx, y: ct * hy, z: -dsin(th) };
  const s: Vec3 = { x: hy, y: -hx, z: 0 };
  const u = cross(s, d);
  return { d, s, u, theta: th, hx, hy };
}

/** Hệ số swerve theo góc nâng: 0 dưới masseStartDeg, 1 từ masseFullDeg, tăng mượt ở giữa (smoothstep) */
export function masseGate(elevationDeg: number, c: PoolConfig): number {
  const t = clamp(
    (elevationDeg - c.masseStartDeg) / (c.masseFullDeg - c.masseStartDeg),
    0,
    1,
  );
  return t * t * (3 - 2 * t);
}

/** Độ lệch điểm chạm (tỉ lệ R) */
export const tipOffset = (shot: ShotCommand, c: PoolConfig) =>
  dlen(shot.tipX, shot.tipY) * c.maxTipOffset;

/** Chuẩn hoá lệnh đánh (chặn giá trị bậy) */
export function sanitizeShot(
  s: Partial<ShotCommand>,
  c: PoolConfig,
): ShotCommand {
  const num = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  let dx = num(s.dirX, 1);
  let dy = num(s.dirY, 0);
  const l = dlen(dx, dy);
  if (l < 1e-9) {
    dx = 1;
    dy = 0;
  } else {
    dx /= l;
    dy /= l;
  }
  let tipX = clamp(num(s.tipX, 0), -1, 1);
  let tipY = clamp(num(s.tipY, 0), -1, 1);
  const tl = dlen(tipX, tipY);
  if (tl > 1) {
    tipX /= tl;
    tipY /= tl;
  }
  return {
    dirX: dx,
    dirY: dy,
    power: clamp(num(s.power, 0.4), 0, 1),
    tipX,
    tipY,
    elevation: clamp(num(s.elevation, 0), 0, c.maxElevation),
  };
}

/** Điểm chạm đầu cơ trên bi (vector từ tâm bi, 3D) */
export function cueContactPoint(shot: ShotCommand, c: PoolConfig): Vec3 {
  const { d, s, u } = cueFrame(shot);
  const a = shot.tipX * c.maxTipOffset;
  const b = shot.tipY * c.maxTipOffset;
  const depth = Math.sqrt(Math.max(0, 1 - a * a - b * b));
  const R = c.ballRadius;
  return {
    x: R * (a * s.x + b * u.x - depth * d.x),
    y: R * (a * s.y + b * u.y - depth * d.y),
    z: R * (a * s.z + b * u.z - depth * d.z),
  };
}

/**
 * Góc squirt (bi cái lệch khỏi hướng cơ khi đánh english), mô hình khối lượng đầu cơ
 * (Dr. Dave Alciatore):  tanα = (5/2)·a·√(1−a²) / (1 + m/mₑ + (5/2)(1−a²))
 * a = độ lệch ngang (tỉ lệ R), mₑ/m = cueEndMassRatio. Bi lệch NGƯỢC phía english.
 */
export function squirtTan(sideOffset: number, c: PoolConfig): number {
  const a = clamp(sideOffset, -0.95, 0.95);
  const q = 1 - a * a;
  return (2.5 * a * Math.sqrt(q)) / (1 + 1 / c.cueEndMassRatio + 2.5 * q);
}

export interface StrikeOutcome {
  v: Vec3;
  w: Vec3;
  speed: number;
  miscue: boolean;
  /** tan góc squirt */
  squirt: number;
  /** Vận tốc đứng ban đầu (m/s) — 0 nếu không phải jump shot */
  vz: number;
  jump: boolean;
}

/**
 * CÚ ĐÁNH CƠ — xung lực trên vật rắn.
 * 1. Cơ khối lượng M, vận tốc V va chạm tại điểm r với hệ số đàn hồi e:
 *      1/m_hd = cos²θ/m + |r × d|²/I,   J = (1 + e)·V / (1/M + 1/m_hd),   P = J·d
 *    (đánh lệch tâm -> m_hd lớn -> J nhỏ: không sinh năng lượng)
 *    m·Δv = P_ngang,  I·Δω = r × P   -> follow / draw / english sinh ra từ hình học.
 * 2. Đánh chúi cơ (θ > 0): bi nhận vận tốc tự do v = P/m (độ lớn không bị khuếch đại); thành phần đi
 *    xuống đập vào nỉ và nảy lên với hệ số e_b (cueBounce): vz = e_b·|vz⁻|. Đủ lớn (≥ jumpMinVz)
 *    -> JUMP SHOT (bi bay), không đủ (cú đánh thường, góc nhỏ) -> bi vẫn nằm trên bàn. Ma sát Coulomb tại đáy bi
 *    trong lúc bi bị kẹp -> tạo xoáy massé / swerve.
 * 3. SQUIRT: xoay vận tốc một góc α ngược phía english.
 * 4. TRƯỢT CƠ: độ lệch điểm chạm > miscueOffset·R -> đầu cơ trượt khỏi bi, chỉ truyền ~30% xung lực.
 */
export function computeStrike(shot: ShotCommand, c: PoolConfig): StrikeOutcome {
  const m = c.ballMass;
  const M = c.cueMass;
  const R = c.ballRadius;
  const I = inertia(c);
  const e = c.cueTipRestitution;
  const centerSpeed = powerToSpeed(shot.power, c);
  const V = (centerSpeed * m * (1 / M + 1 / m)) / (1 + e);

  const { d } = cueFrame(shot);
  const r = cueContactPoint(shot, c);
  const rxd = cross(r, d);
  // Va chạm cơ – bi: bi TỰ DO (xung lực không bị bàn khuếch đại), khối lượng hiệu dụng 1/m + |r×d|²/I
  const invBall = 1 / m + (rxd.x * rxd.x + rxd.y * rxd.y + rxd.z * rxd.z) / I;
  const miscue = tipOffset(shot, c) > c.miscueOffset + 1e-9;
  const J = (((1 + e) * V) / (1 / M + invBall)) * (miscue ? 0.3 : 1);
  const P: Vec3 = { x: J * d.x, y: J * d.y, z: J * d.z };
  const tq = cross(r, P);
  const v: Vec3 = { x: P.x / m, y: P.y / m, z: 0 };
  const w: Vec3 = { x: tq.x / I, y: tq.y / I, z: tq.z / I };

  // Đánh lệch ngang + nâng cơ làm trục xoáy nghiêng về phía trước (thành phần ω dọc hướng đi) -> bi chạy
  // CONG (swerve) và độ cong đổi theo lực. Bỏ thành phần này khi cơ chưa đủ dốc để massé: bi đi thẳng.
  const gate = masseGate(shot.elevation, c);
  if (gate < 1) {
    const hh = dlen(d.x, d.y);
    if (hh > 1e-9) {
      const hx = d.x / hh;
      const hy = d.y / hh;
      const along = w.x * hx + w.y * hy;
      w.x -= (1 - gate) * along * hx;
      w.y -= (1 - gate) * along * hy;
    }
  }

  // Bàn: thành phần vận tốc ĐI XUỐNG đập vào nỉ rồi nảy lên với hệ số cueBounce:
  //   vz⁺ = e_b·|vz⁻|,  phản lực N = m(1 + e_b)·|vz⁻|  (lực ép càng lớn thì ma sát càng lớn)
  const vzDown = Math.max(0, -P.z / m);
  const N = m * (1 + c.cueBounce) * vzDown;
  if (N > 0) {
    const ux = v.x - R * w.y;
    const uy = v.y + R * w.x;
    const u = dlen(ux, uy);
    if (u > 1e-12) {
      const Jt = Math.min(c.strikeTableFriction * N, (u * 2 * m) / 7);
      const F: Vec3 = { x: (-Jt * ux) / u, y: (-Jt * uy) / u, z: 0 };
      const tf = cross({ x: 0, y: 0, z: -R }, F);
      v.x += F.x / m;
      v.y += F.y / m;
      w.x += tf.x / I;
      w.y += tf.y / I;
      w.z += tf.z / I;
    }
  }

  // Squirt: lệch ngược phía english (english phải -> bi lệch trái = xoay ngược chiều kim đồng hồ)
  // Xoay theo tanα (không cần hàm lượng giác): cosα = 1/√(1+tan²), sinα = tan·cosα
  const tanA = miscue ? 0 : squirtTan(shot.tipX * c.maxTipOffset, c);
  const alpha = tanA;
  if (tanA !== 0) {
    const ca = 1 / Math.sqrt(1 + tanA * tanA);
    const sa = tanA * ca;
    const x = v.x * ca - v.y * sa;
    const y = v.x * sa + v.y * ca;
    v.x = x;
    v.y = y;
    // Trục xoáy ngang quay theo hướng bi (nếu không, xoáy lệch pha với vận tốc làm bi tự uốn lại, phụ thuộc lực)
    const wx = w.x * ca - w.y * sa;
    const wy = w.x * sa + w.y * ca;
    w.x = wx;
    w.y = wy;
  }
  // Vận tốc đứng sau khi bật khỏi mặt bàn (chỉ khi đủ mạnh mới tính là jump shot)
  const vzUp = c.cueBounce * vzDown;
  const jump = vzUp >= c.jumpMinVz;
  return {
    v,
    w,
    speed: dlen(v.x, v.y),
    miscue,
    squirt: alpha,
    vz: jump ? vzUp : 0,
    jump,
  };
}

export function applyStrike(
  ball: Ball,
  shot: ShotCommand,
  c: PoolConfig,
): StrikeOutcome {
  const o = computeStrike(shot, c);
  ball.v.x = o.v.x;
  ball.v.y = o.v.y;
  ball.w = { x: o.w.x, y: o.w.y, z: o.w.z };
  ball.vz = o.vz;
  ball.h = 0;
  ball.state = o.jump ? 'airborne' : 'sliding';
  return o;
}
