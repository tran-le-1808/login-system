// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
/**
 * TOÁN XÁC ĐỊNH (deterministic) cho engine vật lý.
 *
 * ECMAScript chỉ bắt buộc + − × ÷ và Math.sqrt cho kết quả đúng IEEE-754 (bit-giống-nhau
 * trên mọi trình duyệt / Node). Math.sin, cos, atan, exp, pow, hypot… thì KHÔNG — mỗi engine
 * JS có thể lệch vài ULP, đủ làm quỹ đạo bi phân kỳ sau vài va chạm.
 * Engine vật lý chỉ được dùng các hàm dưới đây (chỉ gồm + − × ÷ sqrt).
 */

export const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;

/** √(x² + y²) — thay cho Math.hypot (Math.hypot không bắt buộc chính xác tuyệt đối) */
export const dlen = (x: number, y: number) => Math.sqrt(x * x + y * y);
export const dlen3 = (x: number, y: number, z: number) =>
  Math.sqrt(x * x + y * y + z * z);

/** sin, cos trên [−π/4, π/4] bằng chuỗi Taylor (sai số < 1e-16) */
function sinK(x: number) {
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 *
                (-1 / 5040 +
                  x2 *
                    (1 / 362880 +
                      x2 * (-1 / 39916800 + x2 * (1 / 6227020800)))))))
  );
}
function cosK(x: number) {
  const x2 = x * x;
  return (
    1 +
    x2 *
      (-1 / 2 +
        x2 *
          (1 / 24 +
            x2 *
              (-1 / 720 +
                x2 *
                  (1 / 40320 +
                    x2 *
                      (-1 / 3628800 +
                        x2 * (1 / 479001600 + x2 * (-1 / 87178291200)))))))
  );
}

/** Đưa x về k·(π/2) + r với |r| ≤ π/4 (đủ chính xác cho góc |x| < 1e6) */
function reduce(x: number): [number, number] {
  const k = Math.round(x / HALF_PI);
  // Cody–Waite: π/2 tách 2 phần để giảm sai số làm tròn
  const r = x - k * 1.5707963267341256 - k * 6.077100506506192e-11;
  return [((k % 4) + 4) % 4, r];
}

export function dsin(x: number): number {
  const [q, r] = reduce(x);
  return q === 0 ? sinK(r) : q === 1 ? cosK(r) : q === 2 ? -sinK(r) : -cosK(r);
}

export function dcos(x: number): number {
  const [q, r] = reduce(x);
  return q === 0 ? cosK(r) : q === 1 ? -sinK(r) : q === 2 ? -cosK(r) : sinK(r);
}

export const DEG = PI / 180;

/**
 * Băm trạng thái (FNV-1a 32 bit trên từng byte của số thực 64 bit) — so sánh
 * trạng thái client và server: chỉ khớp khi các số bit-giống-nhau.
 */
export function hashNumbers(values: ArrayLike<number>): string {
  const buf = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++)
    buf[i] = values[i] === 0 ? 0 : values[i]; // −0 -> 0
  const bytes = new Uint8Array(buf.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
