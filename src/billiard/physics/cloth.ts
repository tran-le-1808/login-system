import { inertia, type PhysicsConfig } from './config';
import type { BallState } from './types';
import { len2 } from './vector';

/**
 * MA SÁT MẶT VẢI — áp dụng cho 1 bi trong khoảng thời gian dt.
 *
 * Vận tốc tại điểm tiếp xúc bi - vải (điểm r = -R·ẑ):
 *   u = v + ω × r = (vx - R·ωy, vy + R·ωx)
 *
 * - TRƯỢT (|u| > 0): lực ma sát trượt F = -μs·m·g·û tác động tại điểm tiếp xúc
 *     dv/dt = F/m,  dω/dt = (r × F)/I
 *   -> u giảm theo cùng hướng với tốc độ (7/2)·μs·g. Khi u về 0 trong bước này,
 *   chỉ áp phần ma sát cần thiết rồi chuyển sang LĂN (không dừng đột ngột).
 * - LĂN (u = 0): lực cản lăn μr·m·g ngược chiều chuyển động, giữ ràng buộc lăn
 *     ωx = -vy/R, ωy = vx/R
 * - XOÁY ĐỨNG (ωz, side spin): suy giảm do ma sát xoáy, độc lập với lăn / trượt.
 */
export function applyClothFriction(
  b: BallState,
  dt: number,
  c: PhysicsConfig,
): void {
  const R = c.ballRadius;
  const g = c.gravity;
  const I = inertia(c);
  const m = c.ballMass;

  const ux = b.v.x - R * b.w.y;
  const uy = b.v.y + R * b.w.x;
  const u = len2(ux, uy);
  const speed = len2(b.v.x, b.v.y);

  if (u > 1e-9) {
    // ---- Trượt ----
    const uxh = ux / u;
    const uyh = uy / u;
    const slipDecay = 3.5 * c.clothSlidingFriction * g * dt;
    // Tỉ lệ ma sát cần dùng để u về đúng 0 trong bước này (nếu sắp lăn)
    const f = u <= slipDecay ? u / slipDecay : 1;
    const Fx = -c.clothSlidingFriction * m * g * uxh * f;
    const Fy = -c.clothSlidingFriction * m * g * uyh * f;
    b.v.x += (Fx / m) * dt;
    b.v.y += (Fy / m) * dt;
    // τ = r × F với r = (0, 0, -R): τ = (R·Fy, -R·Fx, 0)
    b.w.x += ((R * Fy) / I) * dt;
    b.w.y += ((-R * Fx) / I) * dt;
    if (f < 1) {
      // Vừa đạt điều kiện lăn không trượt: khử sai số làm tròn
      b.w.x = -b.v.y / R;
      b.w.y = b.v.x / R;
      b.state = 'rolling';
    } else {
      b.state = 'sliding';
    }
  } else if (speed > 0) {
    // ---- Lăn ----
    const dv = c.clothRollingFriction * g * dt;
    if (speed <= dv) {
      b.v.x = 0;
      b.v.y = 0;
    } else {
      const k = (speed - dv) / speed;
      b.v.x *= k;
      b.v.y *= k;
    }
    b.w.x = -b.v.y / R;
    b.w.y = b.v.x / R;
    b.state = 'rolling';
  }

  // ---- Xoáy quanh trục đứng (side spin) ----
  if (b.w.z !== 0) {
    const dwz = ((5 * c.clothSpinFriction * g) / (2 * R)) * dt;
    if (Math.abs(b.w.z) <= dwz) b.w.z = 0;
    else b.w.z -= Math.sign(b.w.z) * dwz;
  }

  // ---- Dừng ổn định ----
  const sp = len2(b.v.x, b.v.y);
  if (
    sp < c.stopSpeed &&
    (b.state === 'rolling' || sp === 0) &&
    Math.abs(b.w.z) < c.stopSpin
  ) {
    b.v.x = 0;
    b.v.y = 0;
    b.w.x = 0;
    b.w.y = 0;
    b.w.z = 0;
    b.state = 'stationary';
  } else if (sp === 0 && b.w.z !== 0 && u <= 1e-9) {
    b.state = 'spinning';
  }
}
