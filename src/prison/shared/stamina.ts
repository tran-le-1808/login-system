// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Thể lực (Stamina, dùng trường `stats.energy`, tối đa 100).
 * - Tiêu hao: mỗi lần gym 4, đào 2, trèo rào 6, chế tạo 1 / 10 giây, chạy 1 / giây (movement.ts).
 * - Hồi: ngủ trên giường (đủ đêm = đầy), nằm nghỉ ban ngày +1/giây, tắm xong +30, đồ ăn bổ sung.
 * - Không hồi khi nghỉ trong khu cấm hoặc đang bị truy nã.
 * - Thể lực = 0: không tập gym/chạy bộ, không đào, không trèo; vẫn đi bộ (chậm 15% khi < 20) và làm việc nhẹ.
 */
import { PRISON_CONFIG as C } from './config';
import { ITEM_DEFS } from './items';
import { PRISON_MAP, ZONE_BY_ID, zoneAt } from './map';
import type { ActionResult, ItemId, PlayerState } from './types';

export const STAMINA = C.stamina;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function spendStamina(
  p: Pick<PlayerState, 'stats'>,
  amount: number,
): void {
  p.stats.energy = r4(Math.max(0, p.stats.energy - Math.max(0, amount)));
}

/** Nghỉ / tắm có được hồi thể lực không (khu cấm, đang truy nã thì không) */
export function canRecoverStamina(
  p: Pick<PlayerState, 'x' | 'y' | 'wantedLevel'>,
): boolean {
  if (p.wantedLevel > 0) return false;
  const z = zoneAt(PRISON_MAP, p.x, p.y);
  return !(z && ZONE_BY_ID[z]?.restricted);
}

export function restoreStamina(
  p: Pick<PlayerState, 'stats'>,
  amount: number,
): number {
  const before = p.stats.energy;
  p.stats.energy = r4(
    Math.min(p.stats.maxEnergy, p.stats.energy + Math.max(0, amount)),
  );
  return r4(p.stats.energy - before);
}

export function hasStamina(
  p: Pick<PlayerState, 'stats'>,
  amount: number,
): boolean {
  return p.stats.energy >= amount - 1e-9;
}

export const NO_STAMINA = 'Hết thể lực, hãy nghỉ hoặc ăn';

export function needStamina(
  p: Pick<PlayerState, 'stats'>,
  amount: number,
): ActionResult | null {
  return hasStamina(p, Math.max(amount, 1e-6))
    ? null
    : { ok: false, code: 'INVALID_STATE', message: NO_STAMINA };
}

/** Ăn đồ bổ sung thể lực: tức thì, chờ 30 giây mỗi món, không vượt 100 */
export function eatConsumable(
  p: PlayerState,
  worldTime: number,
  itemId: ItemId,
): ActionResult {
  const def = ITEM_DEFS[itemId];
  if (!def.consumable)
    return {
      ok: false,
      code: 'INVALID_STATE',
      message: 'Không ăn được món này',
    };
  const ready = p.foodCooldowns[itemId] ?? 0;
  if (worldTime < ready)
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: `Chờ ${Math.ceil(ready - worldTime)} giây nữa mới ăn ${def.name} được`,
    };
  const gained = restoreStamina(p, def.staminaRestore ?? 0);
  p.foodCooldowns[itemId] =
    worldTime + (def.cooldownSeconds ?? C.food.defaultCooldownSeconds);
  return { ok: true, data: { used: itemId, stamina: gained } };
}
