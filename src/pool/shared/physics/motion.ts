// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import { inertia, type PoolConfig } from './config';
import type { Ball } from './types';
import { dlen } from './math';

/** Vận tốc điểm tiếp xúc bi – nỉ: u = v + ω × (−R·ẑ) = (vx − R·ωy, vy + R·ωx) */
export function contactVelocity(b: Ball, R: number) {
  return { x: b.v.x - R * b.w.y, y: b.v.y + R * b.w.x };
}

const EPS_U = 1e-7;
const EPS_V = 1e-9;

/** Xác định pha chuyển động từ v, ω (gọi sau mọi va chạm / cú đánh) */
export function classify(b: Ball, c: PoolConfig): void {
  if (
    b.state === 'pocketed' ||
    b.state === 'dropping' ||
    b.state === 'airborne' ||
    b.state === 'offTable'
  )
    return;
  const u = contactVelocity(b, c.ballRadius);
  if (dlen(u.x, u.y) > EPS_U) b.state = 'sliding';
  else if (dlen(b.v.x, b.v.y) > EPS_V) b.state = 'rolling';
  else if (Math.abs(b.w.z) > EPS_V) {
    b.state = 'spinning';
    b.v.x = b.v.y = b.w.x = b.w.y = 0;
  } else {
    b.state = 'stationary';
    b.v.x = b.v.y = 0;
    b.w.x = b.w.y = b.w.z = 0;
  }
}

/**
 * CHUYỂN ĐỘNG TRÊN NỈ — NGHIỆM GIẢI TÍCH theo từng pha (không tích phân Euler).
 *
 * • TRƯỢT: lực ma sát F = −μs·m·g·û không đổi hướng (û là hướng trượt tại điểm tiếp xúc,
 *   giữ nguyên trong suốt pha trượt). Do đó:
 *     v(t) = v0 − μs·g·û·t,   r(t) = r0 + v0·t − ½·μs·g·û·t²
 *     ω(t) = ω0 + (r × F)/I·t,   |u(t)| = |u0| − (7/2)·μs·g·t
 *   -> thời điểm bắt đầu LĂN chính xác: τs = 2|u0| / (7·μs·g).
 *   Đánh giữa tâm: v lăn = v0 − μs·g·τs = 5/7·v0.
 * • LĂN: v = R·ω (ngang), gia tốc −μr·g·v̂ không đổi hướng
 *   -> thời điểm dừng τr = |v| / (μr·g).
 * • XOÁY ĐỨNG ωz: giảm tuyến tính 5·μsp·g/(2R), độc lập.
 *
 * Hàm tiến bi đúng `dt` giây, tự tách bước tại thời điểm đổi pha.
 */
export function advanceBall(b: Ball, dt: number, c: PoolConfig): number {
  if (
    b.state === 'pocketed' ||
    b.state === 'stationary' ||
    b.state === 'dropping' ||
    b.state === 'offTable'
  )
    return 0;
  if (b.state === 'airborne') return advanceAirborne(b, dt, c);
  const R = c.ballRadius;
  const g = c.gravity;
  const mI = (c.ballMass * R) / inertia(c); // m·R / I

  let t = dt;
  for (let guard = 0; t > 0 && guard < 4; guard++) {
    if (b.state === 'sliding') {
      const u = contactVelocity(b, R);
      const ul = dlen(u.x, u.y);
      if (ul <= EPS_U) {
        b.state = 'rolling';
        b.w.x = -b.v.y / R;
        b.w.y = b.v.x / R;
        continue;
      }
      const ax = (-c.muSlide * g * u.x) / ul;
      const ay = (-c.muSlide * g * u.y) / ul;
      const tSlide = ul / (3.5 * c.muSlide * g);
      const h = Math.min(t, tSlide);
      b.p.x += b.v.x * h + 0.5 * ax * h * h;
      b.p.y += b.v.y * h + 0.5 * ay * h * h;
      b.v.x += ax * h;
      b.v.y += ay * h;
      // dω/dt = (r × F)/I với r = −R·ẑ:  (R·Fy, −R·Fx)/I
      b.w.x += mI * ay * h;
      b.w.y += -mI * ax * h;
      t -= h;
      if (h === tSlide) {
        // Đúng thời điểm lăn: khử sai số làm tròn, ép ràng buộc lăn
        b.state = dlen(b.v.x, b.v.y) > EPS_V ? 'rolling' : 'stationary';
        b.w.x = -b.v.y / R;
        b.w.y = b.v.x / R;
        if (b.state === 'stationary') {
          b.v.x = b.v.y = b.w.x = b.w.y = 0;
          if (Math.abs(b.w.z) > EPS_V) b.state = 'spinning';
        }
      }
    } else if (b.state === 'rolling') {
      const sp = dlen(b.v.x, b.v.y);
      if (sp <= EPS_V) {
        b.v.x = b.v.y = b.w.x = b.w.y = 0;
        b.state = Math.abs(b.w.z) > EPS_V ? 'spinning' : 'stationary';
        continue;
      }
      const dec = c.muRoll * g;
      const tStop = sp / dec;
      const h = Math.min(t, tStop);
      const ax = (-dec * b.v.x) / sp;
      const ay = (-dec * b.v.y) / sp;
      b.p.x += b.v.x * h + 0.5 * ax * h * h;
      b.p.y += b.v.y * h + 0.5 * ay * h * h;
      if (h === tStop) {
        b.v.x = b.v.y = 0;
        b.state = Math.abs(b.w.z) > EPS_V ? 'spinning' : 'stationary';
      } else {
        b.v.x += ax * h;
        b.v.y += ay * h;
      }
      b.w.x = -b.v.y / R;
      b.w.y = b.v.x / R;
      t -= h;
    } else break; // spinning: vị trí không đổi
  }

  // Xoáy quanh trục đứng
  if (b.w.z !== 0) {
    const dw = ((5 * c.muSpin * g) / (2 * R)) * dt;
    b.w.z = Math.abs(b.w.z) <= dw ? 0 : b.w.z - Math.sign(b.w.z) * dw;
    if (b.w.z === 0 && b.state === 'spinning') b.state = 'stationary';
  }
  return 0;
}

/**
 * BAY (jump shot / nảy): ném xiên trong trường trọng lực, không ma sát không khí.
 *   h(t) = h0 + vz·t − ½·g·t²,   vx, vy, ω không đổi.
 * Nghiệm giải tích -> thời điểm chạm nỉ chính xác (không phụ thuộc bước thời gian).
 * Trả về tốc độ đứng lúc chạm nỉ (> 0 nếu có chạm trong bước này), 0 nếu không.
 */
function advanceAirborne(b: Ball, dt: number, c: PoolConfig): number {
  const g = c.gravity;
  const hEnd = b.h + b.vz * dt - 0.5 * g * dt * dt;
  if (hEnd > 0) {
    b.p.x += b.v.x * dt;
    b.p.y += b.v.y * dt;
    b.h = hEnd;
    b.vz -= g * dt;
    return 0;
  }
  // Nghiệm dương của h + vz·t − ½·g·t² = 0
  const tl = Math.min(dt, (b.vz + Math.sqrt(b.vz * b.vz + 2 * g * b.h)) / g);
  b.p.x += b.v.x * tl;
  b.p.y += b.v.y * tl;
  const vIn = -(b.vz - g * tl);
  b.h = 0;
  land(b, Math.max(0, vIn), c);
  const rest = dt - tl;
  if (rest > 0) advanceBall(b, rest, c);
  return Math.max(0, vIn);
}

/**
 * ĐÁP XUỐNG NỈ: va chạm với mặt bàn.
 *  • Pháp tuyến: phục hồi e (nảy lại với vz = e·vIn); vIn nhỏ -> dính hẳn (không nảy vô hạn).
 *  • Tiếp tuyến: ma sát Coulomb tại điểm tiếp xúc, tối đa bằng xung lực làm triệt tiêu trượt
 *    (khối lượng hiệu dụng 2m/7) -> đổi cả v và ω, bi chuyển sang trượt rồi lăn.
 */
function land(b: Ball, vIn: number, c: PoolConfig): void {
  const R = c.ballRadius;
  const m = c.ballMass;
  const I = inertia(c);
  const bounce = c.clothRestitution * vIn >= c.landSettleVz;
  const Jn = m * (1 + (bounce ? c.clothRestitution : 0)) * vIn;
  const u = contactVelocity(b, R);
  const ul = dlen(u.x, u.y);
  if (ul > 1e-9 && Jn > 0) {
    const Jt = Math.min(c.muSlide * Jn, (2 * m * ul) / 7);
    const Fx = (-Jt * u.x) / ul;
    const Fy = (-Jt * u.y) / ul;
    b.v.x += Fx / m;
    b.v.y += Fy / m;
    // τ = r × F, r = (0, 0, −R)
    b.w.x += (R * Fy) / I;
    b.w.y += (-R * Fx) / I;
  }
  if (bounce) {
    b.vz = c.clothRestitution * vIn;
    b.state = 'airborne';
  } else {
    b.vz = 0;
    b.state = 'sliding';
    classify(b, c);
  }
}
