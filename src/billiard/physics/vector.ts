import type { Vec2, Vec3 } from './types';

/** Phép toán vector nhỏ gọn (tránh tạo object trong vòng lặp nóng khi có thể) */
export const len2 = (x: number, y: number) => Math.sqrt(x * x + y * y);
export const len3 = (v: Vec3) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

export const clamp = (v: number, a: number, b: number) =>
  v < a ? a : v > b ? b : v;

export const isFiniteVec2 = (v: Vec2) =>
  Number.isFinite(v.x) && Number.isFinite(v.y);
export const isFiniteVec3 = (v: Vec3) =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
