// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Va chạm hình tròn – lưới ô, tầm nhìn (line of sight) và tìm đường A* trên lưới. */
import { isOpaque, tileAt, type PrisonMap } from './map';
import type { Point } from './types';

export type SolidFn = (tx: number, ty: number) => boolean;

function circleHitsTile(
  cx: number,
  cy: number,
  r: number,
  tx: number,
  ty: number,
): boolean {
  const nx = Math.max(tx, Math.min(cx, tx + 1));
  const ny = Math.max(ty, Math.min(cy, ty + 1));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

export function circleBlocked(
  cx: number,
  cy: number,
  r: number,
  solid: SolidFn,
): boolean {
  const x0 = Math.floor(cx - r);
  const x1 = Math.floor(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.floor(cy + r);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      if (solid(tx, ty) && circleHitsTile(cx, cy, r, tx, ty)) return true;
  return false;
}

/**
 * Di chuyển tách trục (X rồi Y) — trượt dọc tường, tất định.
 * Mỗi bước nhỏ hơn bán kính nên không xuyên tường; vẫn chia nhỏ bước dài để an toàn.
 */
export function moveWithCollision(
  x: number,
  y: number,
  dx: number,
  dy: number,
  r: number,
  solid: SolidFn,
): Point {
  const steps = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (r * 0.9)),
  );
  const sx = dx / steps;
  const sy = dy / steps;
  let px = x;
  let py = y;
  for (let i = 0; i < steps; i++) {
    if (sx !== 0 && !circleBlocked(px + sx, py, r, solid)) px += sx;
    if (sy !== 0 && !circleBlocked(px, py + sy, r, solid)) py += sy;
  }
  return { x: round4(px), y: round4(py) };
}

/** Làm tròn để client và server ra cùng một số (tránh trôi số thực khi tuần tự hoá) */
export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Duyệt ô theo tia (Amanatides–Woo) — true nếu không ô nào chắn tầm nhìn */
export function hasLineOfSight(
  map: PrisonMap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  let tx = Math.floor(x0);
  let ty = Math.floor(y0);
  const ex = Math.floor(x1);
  const ey = Math.floor(y1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx !== 0 ? (dx > 0 ? tx + 1 - x0 : x0 - tx) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? ty + 1 - y0 : y0 - ty) * tDeltaY : Infinity;
  for (let guard = 0; guard < 200; guard++) {
    if (tx === ex && ty === ey) return true;
    if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (tx === ex && ty === ey) return true;
    if (isOpaque(tileAt(map, tx, ty))) return false;
  }
  return false;
}

/** A* 8 hướng (không cắt góc tường). Trả về các tâm ô từ sau điểm đầu tới đích. */
export function findPath(
  map: PrisonMap,
  passable: (tx: number, ty: number) => boolean,
  from: Point,
  to: Point,
  maxNodes = 3000,
): Point[] | null {
  const W = map.width;
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const gx = Math.floor(to.x);
  const gy = Math.floor(to.y);
  if (!passable(gx, gy)) return null;
  if (sx === gx && sy === gy) return [{ x: gx + 0.5, y: gy + 0.5 }];
  const start = sy * W + sx;
  const goal = gy * W + gx;
  const gScore = new Map<number, number>([[start, 0]]);
  const came = new Map<number, number>();
  const open: { k: number; f: number }[] = [{ k: start, f: 0 }];
  const closed = new Set<number>();
  const h = (k: number) => {
    const x = k % W;
    const y = (k - x) / W;
    const ddx = Math.abs(x - gx);
    const ddy = Math.abs(y - gy);
    return Math.max(ddx, ddy) + 0.414 * Math.min(ddx, ddy);
  };
  let expanded = 0;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const { k } = open[bi];
    open.splice(bi, 1);
    if (k === goal) {
      const out: Point[] = [];
      let c: number | undefined = k;
      while (c !== undefined && c !== start) {
        const x = c % W;
        out.push({ x: x + 0.5, y: (c - x) / W + 0.5 });
        c = came.get(c);
      }
      return out.reverse();
    }
    if (closed.has(k)) continue;
    closed.add(k);
    if (++expanded > maxNodes) return null;
    const x = k % W;
    const y = (k - x) / W;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = x + ox;
        const ny = y + oy;
        if (!passable(nx, ny)) continue;
        if (ox && oy && (!passable(x + ox, y) || !passable(x, y + oy)))
          continue;
        const nk = ny * W + nx;
        if (closed.has(nk)) continue;
        const ng = (gScore.get(k) ?? 0) + (ox && oy ? 1.414 : 1);
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, k);
          open.push({ k: nk, f: ng + h(nk) });
        }
      }
  }
  return null;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}
