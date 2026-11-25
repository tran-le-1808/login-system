// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Bước di chuyển tất định — server dùng để mô phỏng, client dùng để dự đoán (prediction). */
import { PRISON_CONFIG as C, ROLE_MODIFIERS } from './config';
import { moveWithCollision, round4, type SolidFn } from './geometry';
import { agilitySpeed } from './gymStats';
import type { MoveInput, Role } from './types';

export interface MoveBody {
  x: number;
  y: number;
  facing: number;
  energy: number;
}

export interface MoveContext {
  solid: SolidFn;
  role: Role;
  /** Hệ số tốc độ từ đói / mệt / kỹ năng thể lực — xem movementModifiers */
  speedMul: number;
  drainMul: number;
}

export interface MoveResult extends MoveBody {
  moving: boolean;
  sprinting: boolean;
}

export const FIXED_DT = 1 / C.net.tickRate;

/** Hệ số theo ngưỡng (bậc thang) để client dự đoán ít lệch với server */
export function movementModifiers(s: {
  hunger: number;
  fitness: number;
  stamina?: number;
  agility?: number;
}): { speedMul: number; drainMul: number } {
  let speedMul = 1;
  if (s.hunger >= C.needs.slowThreshold) speedMul *= C.needs.slowMultiplier;
  speedMul *= 1 + Math.floor(s.fitness / 10) * 0.01;
  // Nhanh nhẹn (máy chạy bộ): tốc độ × (1 + nhanh nhẹn × 0.01), có trần
  speedMul *= agilitySpeed(s.agility ?? 0);
  const drainMul = Math.max(
    0.5,
    1 - ((s.stamina ?? 5) - 5) * 0.05 - Math.floor(s.fitness / 10) * 0.02,
  );
  return { speedMul: round4(speedMul), drainMul: round4(drainMul) };
}

export function sanitizeDirection(dx: number, dy: number): [number, number] {
  const x = Number.isFinite(dx) ? Math.max(-1, Math.min(1, dx)) : 0;
  const y = Number.isFinite(dy) ? Math.max(-1, Math.min(1, dy)) : 0;
  const len = Math.hypot(x, y);
  if (len < 0.05) return [0, 0];
  return len > 1 ? [x / len, y / len] : [x, y];
}

export function stepMove(
  ctx: MoveContext,
  body: MoveBody,
  input: Pick<MoveInput, 'directionX' | 'directionY' | 'sprint'>,
  dt = FIXED_DT,
): MoveResult {
  const [dx, dy] = sanitizeDirection(input.directionX, input.directionY);
  if (dx === 0 && dy === 0) return { ...body, moving: false, sprinting: false };
  const mods = ROLE_MODIFIERS[ctx.role];
  const sprinting = input.sprint && body.energy > 0;
  // Thể lực < 20: đi chậm hơn 15%
  const low =
    body.energy < C.stamina.lowThreshold ? C.stamina.lowSpeedMultiplier : 1;
  const speed =
    (sprinting ? C.player.sprintSpeed : C.player.walkSpeed) *
    mods.speed *
    ctx.speedMul *
    low;
  const pos = moveWithCollision(
    body.x,
    body.y,
    dx * speed * dt,
    dy * speed * dt,
    C.player.radius,
    ctx.solid,
  );
  const energy = sprinting
    ? round4(
        Math.max(0, body.energy - C.player.sprintDrain * ctx.drainMul * dt),
      )
    : body.energy;
  return {
    x: pos.x,
    y: pos.y,
    facing: round4(Math.atan2(dy, dx)),
    energy,
    moving: true,
    sprinting,
  };
}
