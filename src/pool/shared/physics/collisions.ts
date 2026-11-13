// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import { inertia, type PoolConfig } from './config';
import type { Ball, Vec3 } from './types';
import { dlen3 } from './math';

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/**
 * VA CHẠM BI – BI (xung lực tức thời, 2 bi cùng khối lượng, bán kính).
 *
 * n = pháp tuyến từ a sang b; điểm tiếp xúc ra = R·n, rb = −R·n.
 * • Pháp tuyến: Jn = (1 + e)·vn·m/2  -> bảo toàn động lượng, mất (1−e²) động năng pháp tuyến.
 * • Tiếp tuyến (ma sát bi – bi, gây THROW và truyền xoáy):
 *   vận tốc trượt tại điểm tiếp xúc vt (gồm cả v và ω×r). Khối lượng hiệu dụng
 *   tiếp tuyến của 2 quả cầu đặc là m/7 -> Jt = min(μ·Jn, |vt|·m/7) (giới hạn Coulomb).
 *   Cắt mỏng / đánh chậm -> vt lớn so với vn -> ma sát bão hoà, throw nhiều hơn khi chậm
 *   vì tỉ lệ trượt cao hơn (μ có thể phụ thuộc vận tốc trượt, ở đây giữ hằng).
 * Thành phần thẳng đứng của xung lực ma sát do mặt nỉ hấp thụ (bi không rời bàn).
 *
 * Trả về vn (tốc độ áp sát), 0 nếu 2 bi đang tách nhau.
 */
export function resolveBallBall(a: Ball, b: Ball, c: PoolConfig): number {
  const R = c.ballRadius;
  const m = c.ballMass;
  const I = inertia(c);
  const dx = b.p.x - a.p.x;
  const dy = b.p.y - a.p.y;
  // 3D: một bi đang bay có tâm cao hơn -> pháp tuyến nghiêng (đập vào đỉnh bi dưới thì đẩy xuống bàn)
  const dz = b.h - a.h;
  const dist = dlen3(dx, dy, dz);
  if (dist === 0) return 0;
  const n: Vec3 = { x: dx / dist, y: dy / dist, z: dz / dist };
  const ra: Vec3 = { x: R * n.x, y: R * n.y, z: R * n.z };
  const rb: Vec3 = { x: -R * n.x, y: -R * n.y, z: -R * n.z };
  const wa = cross(a.w, ra);
  const wb = cross(b.w, rb);
  const vrel: Vec3 = {
    x: a.v.x + wa.x - (b.v.x + wb.x),
    y: a.v.y + wa.y - (b.v.y + wb.y),
    z: a.vz + wa.z - (b.vz + wb.z),
  };
  const vn = vrel.x * n.x + vrel.y * n.y + vrel.z * n.z;
  if (vn <= 0) return 0;

  const Jn = ((1 + c.ballRestitution) * vn * m) / 2;
  const vt: Vec3 = {
    x: vrel.x - vn * n.x,
    y: vrel.y - vn * n.y,
    z: vrel.z - vn * n.z,
  };
  const vtl = dlen3(vt.x, vt.y, vt.z);
  let Jt = 0;
  let t: Vec3 = { x: 0, y: 0, z: 0 };
  if (vtl > 1e-9) {
    t = { x: vt.x / vtl, y: vt.y / vtl, z: vt.z / vtl };
    Jt = Math.min(c.ballFriction * Jn, (vtl * m) / 7);
  }
  const P: Vec3 = {
    x: -Jn * n.x - Jt * t.x,
    y: -Jn * n.y - Jt * t.y,
    z: -Jn * n.z - Jt * t.z,
  };
  const Pb: Vec3 = { x: -P.x, y: -P.y, z: -P.z };
  a.v.x += P.x / m;
  a.v.y += P.y / m;
  b.v.x += Pb.x / m;
  b.v.y += Pb.y / m;
  // Bi nằm trên bàn: mặt nỉ hấp thụ thành phần đứng; bi đang bay thì nhận đủ xung lực
  if (a.state === 'airborne') a.vz += P.z / m;
  if (b.state === 'airborne') b.vz += Pb.z / m;
  const ta = cross(ra, P);
  const tb = cross(rb, Pb);
  a.w.x += ta.x / I;
  a.w.y += ta.y / I;
  a.w.z += ta.z / I;
  b.w.x += tb.x / I;
  b.w.y += tb.y / I;
  b.w.z += tb.z / I;
  return vn;
}

/** Hệ số phục hồi băng phụ thuộc vận tốc (đánh mạnh -> băng "ăn" nhiều năng lượng hơn) */
export function cushionRestitution(vn: number, c: PoolConfig): number {
  const e = c.cushionRestitution - c.cushionRestitutionSlope * (vn - 1);
  return Math.max(
    c.cushionRestitutionMin,
    Math.min(c.cushionRestitutionMax, e),
  );
}

/**
 * VA CHẠM BI – BĂNG (mô hình tiếp xúc tại mũi băng, kiểu Han 2005 rút gọn).
 *
 * (ox, oy): hướng ngang từ tâm bi tới điểm tiếp xúc trên băng / mũi lỗ.
 * Mũi băng cao h > R nên điểm tiếp xúc rc = R·(cosθ·o + sinθ·ẑ), sinθ = (h − R)/R.
 * • Xung lực pháp tuyến đi qua tâm: Jn = (1 + e(v))·m·vn — không tạo mô-men.
 * • Ma sát tại điểm tiếp xúc phụ thuộc vận tốc tiếp tuyến do CẢ v và ω:
 *   english xuôi / ngược làm góc bật ra dài / ngắn; topspin chạm điểm cao hơn tâm
 *   bị băng "kéo" tạo hiệu ứng bi cong sau băng; đánh mạnh -> e nhỏ -> góc ngắn hơn.
 */
export function resolveBallCushion(
  b: Ball,
  ox: number,
  oy: number,
  c: PoolConfig,
  /** Hệ số phục hồi riêng (mặt vát / mũi lỗ); mặc định theo băng */
  restitution?: number,
): number {
  const R = c.ballRadius;
  const m = c.ballMass;
  const I = inertia(c);
  const vn = b.v.x * ox + b.v.y * oy;
  if (vn <= 0) return 0;

  const sinT = Math.min(0.9, Math.max(0, (c.cushionHeight - R) / R));
  const cosT = Math.sqrt(1 - sinT * sinT);
  const rc: Vec3 = { x: R * cosT * ox, y: R * cosT * oy, z: R * sinT };
  const nIn: Vec3 = { x: rc.x / R, y: rc.y / R, z: rc.z / R };
  const wr = cross(b.w, rc);
  const vc: Vec3 = { x: b.v.x + wr.x, y: b.v.y + wr.y, z: wr.z };

  // Phần nằm ngang của xung lực pháp tuyến đảo đúng vn theo e(v); toàn phần nghiêng theo nIn
  const Jh = (1 + (restitution ?? cushionRestitution(vn, c))) * m * vn;
  const Jn = Jh / cosT;
  const vcn = vc.x * nIn.x + vc.y * nIn.y + vc.z * nIn.z;
  const vt: Vec3 = {
    x: vc.x - vcn * nIn.x,
    y: vc.y - vcn * nIn.y,
    z: vc.z - vcn * nIn.z,
  };
  const vtl = dlen3(vt.x, vt.y, vt.z);
  let Jt = 0;
  let t: Vec3 = { x: 0, y: 0, z: 0 };
  if (vtl > 1e-9) {
    t = { x: vt.x / vtl, y: vt.y / vtl, z: vt.z / vtl };
    // Băng cao su đàn hồi tiếp tuyến: có thể đảo ngược một phần vận tốc trượt tại điểm tiếp xúc
    Jt = Math.min(
      c.cushionFriction * Jn,
      ((1 + c.cushionTangentialRestitution) * vtl * 2 * m) / 7,
    );
  }
  // Thành phần ngang của xung lực pháp tuyến (thành phần đứng do mặt nỉ chịu)
  b.v.x += (-Jh * ox - Jt * t.x) / m;
  b.v.y += (-Jh * oy - Jt * t.y) / m;
  const tq = cross(rc, { x: -Jt * t.x, y: -Jt * t.y, z: -Jt * t.z });
  b.w.x += tq.x / I;
  b.w.y += tq.y / I;
  b.w.z += tq.z / I;
  return vn;
}
