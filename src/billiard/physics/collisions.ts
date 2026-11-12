import { inertia, type PhysicsConfig } from './config';
import type { BallState, Rail, Vec3 } from './types';
import { cross, dot3, len3 } from './vector';

/**
 * VA CHẠM BI - BI (impulse-based, 2 bi cùng khối lượng & bán kính)
 *
 * n: pháp tuyến từ a sang b. Điểm tiếp xúc: ra = R·n, rb = -R·n.
 * Vận tốc tương đối tại điểm tiếp xúc: vrel = (va + ωa×ra) - (vb + ωb×rb)
 * - Xung lực pháp tuyến: Jn = (1 + e)·vn / (1/m + 1/m)
 * - Xung lực tiếp tuyến (ma sát bi - bi): đủ để triệt tiêu trượt tại điểm tiếp xúc
 *   (khối lượng hiệu dụng 1 / (2·(1/m + R²/I)) = m/7), giới hạn Coulomb μ·Jn.
 * Thành phần thẳng đứng của xung lực bị mặt vải hấp thụ (tâm bi luôn ở độ cao R).
 *
 * Trả về tốc độ va chạm (để ghi sự kiện / âm thanh), 0 nếu 2 bi đang tách nhau.
 */
export function resolveBallBall(
  a: BallState,
  b: BallState,
  c: PhysicsConfig,
): number {
  const R = c.ballRadius;
  const m = c.ballMass;
  const I = inertia(c);

  const dx = b.p.x - a.p.x;
  const dy = b.p.y - a.p.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = 2 * R;
  if (dist >= minDist || dist === 0) return 0;

  const n: Vec3 = { x: dx / dist, y: dy / dist, z: 0 };

  // Chống xuyên lấn: tách 2 bi đúng bằng phần chồng lấn
  const overlap = minDist - dist;
  a.p.x -= n.x * overlap * 0.5;
  a.p.y -= n.y * overlap * 0.5;
  b.p.x += n.x * overlap * 0.5;
  b.p.y += n.y * overlap * 0.5;

  const ra: Vec3 = { x: R * n.x, y: R * n.y, z: 0 };
  const rb: Vec3 = { x: -R * n.x, y: -R * n.y, z: 0 };
  const wa = cross(a.w, ra);
  const wb = cross(b.w, rb);
  const vrel: Vec3 = {
    x: a.v.x + wa.x - (b.v.x + wb.x),
    y: a.v.y + wa.y - (b.v.y + wb.y),
    z: wa.z - wb.z,
  };
  const vn = dot3(vrel, n);
  if (vn <= 0) return 0; // đang tách nhau

  const Jn = ((1 + c.ballRestitution) * vn * m) / 2;

  // Trượt tiếp tuyến tại điểm tiếp xúc
  const vt: Vec3 = {
    x: vrel.x - vn * n.x,
    y: vrel.y - vn * n.y,
    z: vrel.z - vn * n.z,
  };
  const vtLen = len3(vt);
  let Jt = 0;
  let t: Vec3 = { x: 0, y: 0, z: 0 };
  if (vtLen > 1e-9) {
    t = { x: vt.x / vtLen, y: vt.y / vtLen, z: vt.z / vtLen };
    Jt = Math.min(c.ballFriction * Jn, (vtLen * m) / 7);
  }

  // Xung lực lên bi a (bi b nhận xung lực ngược lại)
  const P: Vec3 = {
    x: -Jn * n.x - Jt * t.x,
    y: -Jn * n.y - Jt * t.y,
    z: -Jt * t.z,
  };
  const Pb: Vec3 = { x: -P.x, y: -P.y, z: -P.z };

  a.v.x += P.x / m;
  a.v.y += P.y / m;
  b.v.x += Pb.x / m;
  b.v.y += Pb.y / m;

  const ta = cross(ra, P);
  const tb = cross(rb, Pb);
  a.w.x += ta.x / I;
  a.w.y += ta.y / I;
  a.w.z += ta.z / I;
  b.w.x += tb.x / I;
  b.w.y += tb.y / I;
  b.w.z += tb.z / I;

  a.state = 'sliding';
  b.state = 'sliding';
  return vn;
}

/** Hướng từ tâm bàn ra phía băng */
const RAIL_OUT: Record<Rail, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: -1 },
  top: { x: 0, y: 1 },
};
export const RAILS: readonly Rail[] = ['left', 'right', 'bottom', 'top'];

/** Khoảng cách từ tâm bi tới mặt băng (âm = đang lấn vào băng) */
export function railGap(b: BallState, rail: Rail, c: PhysicsConfig): number {
  const o = RAIL_OUT[rail];
  const half = o.x !== 0 ? c.tableWidth / 2 : c.tableHeight / 2;
  return half - (b.p.x * o.x + b.p.y * o.y) - c.ballRadius;
}

/**
 * VA CHẠM BI - BĂNG
 *
 * Mũi băng cao hơn tâm bi: điểm tiếp xúc rc = R·(cosθ·o + sinθ·ẑ),
 * sinθ = (h - R) / R. Pháp tuyến va chạm đi qua tâm bi (N = -rc/R) nên xung
 * lực pháp tuyến không tạo mô-men; ma sát tại điểm tiếp xúc (phụ thuộc vận tốc
 * tiếp tuyến do v VÀ ω) tạo ra hiệu ứng English chạy / ngược và thay đổi spin.
 *
 * Trả về tốc độ va chạm, 0 nếu không va chạm.
 */
export function resolveBallCushion(
  b: BallState,
  rail: Rail,
  c: PhysicsConfig,
): number {
  const gap = railGap(b, rail, c);
  if (gap >= 0) return 0;

  const R = c.ballRadius;
  const m = c.ballMass;
  const I = inertia(c);
  const o = RAIL_OUT[rail];

  // Đưa bi về đúng mép băng
  b.p.x += o.x * gap;
  b.p.y += o.y * gap;

  const sinT = Math.min(0.9, Math.max(0, (c.cushionHeight - R) / R));
  const cosT = Math.sqrt(1 - sinT * sinT);
  const rc: Vec3 = { x: R * cosT * o.x, y: R * cosT * o.y, z: R * sinT };
  const nIn: Vec3 = { x: rc.x / R, y: rc.y / R, z: rc.z / R }; // hướng từ tâm ra điểm tiếp xúc

  const wr = cross(b.w, rc);
  const vc: Vec3 = { x: b.v.x + wr.x, y: b.v.y + wr.y, z: wr.z };
  // Thành phần pháp tuyến chỉ tính từ chuyển động tịnh tiến của tâm bi
  const vn = b.v.x * nIn.x + b.v.y * nIn.y;
  if (vn <= 0) return 0;

  const Jn = (1 + c.cushionRestitution) * m * vn;

  // Trượt tiếp tuyến tại điểm tiếp xúc (bỏ thành phần pháp tuyến)
  const vcn = dot3(vc, nIn);
  const vt: Vec3 = {
    x: vc.x - vcn * nIn.x,
    y: vc.y - vcn * nIn.y,
    z: vc.z - vcn * nIn.z,
  };
  const vtLen = len3(vt);
  let Jt = 0;
  let t: Vec3 = { x: 0, y: 0, z: 0 };
  if (vtLen > 1e-9) {
    t = { x: vt.x / vtLen, y: vt.y / vtLen, z: vt.z / vtLen };
    // Khối lượng hiệu dụng tiếp tuyến của 1 bi với vật cố định: 1/(1/m + R²/I) = 2m/7
    Jt = Math.min(c.cushionFriction * Jn, (vtLen * 2 * m) / 7);
  }

  const P: Vec3 = {
    x: -Jn * nIn.x - Jt * t.x,
    y: -Jn * nIn.y - Jt * t.y,
    z: -Jn * nIn.z - Jt * t.z,
  };
  // Chỉ thành phần nằm ngang làm đổi vận tốc tâm bi (thành phần đứng do mặt vải chịu)
  b.v.x += P.x / m;
  b.v.y += P.y / m;
  // Mô-men chỉ do ma sát (xung lực pháp tuyến đi qua tâm bi)
  const torque = cross(rc, { x: -Jt * t.x, y: -Jt * t.y, z: -Jt * t.z });
  b.w.x += torque.x / I;
  b.w.y += torque.y / I;
  b.w.z += torque.z / I;
  b.state = 'sliding';
  return vn;
}
