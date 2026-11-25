// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Công cụ theo vai trò (data/tools.json): đào (dig), cậy (pry: lưới gió, tủ tang vật), cắt (cut: hàng rào),
 * mở khoá (pick: cửa biệt giam, cửa khu khi phong toả).
 * - Mỗi công cụ có hiệu quả (efficiency): thời gian thao tác chia cho hiệu quả — đồ chuyên dụng / cấp cao nhanh hơn.
 * - Dao đa năng làm được nhiều việc nhưng kém đồ chuyên dụng.
 * - Độ bền ở items.json (maxDurability); mỗi lần dùng −1, hết thì gãy và mất (luật hiện tại).
 */
import toolsJson from './data/tools.json';
import { countItem, ITEM_DEFS } from './items';
import type { InventoryItem, ItemId, PlayerState } from './types';

export type ToolRole = 'dig' | 'pry' | 'cut' | 'pick';
export interface DigSpec {
  power: number;
  wall: number;
  floor: number;
  tunnel: number;
}
interface RoleSpecs {
  dig?: DigSpec;
  pry?: { efficiency: number; noise: number };
  cut?: { efficiency: number };
  pick?: { efficiency: number };
}

export const TOOL_CONF = toolsJson as unknown as Record<string, RoleSpecs> & {
  repairKit: { restoreFraction: number };
  storagePouchBonusSlots: number;
  firecracker: { throwDistance: number; alertRadius: number };
  mapSketchSeconds: number;
};

export function toolSpec(itemId: string): RoleSpecs | null {
  const s = (TOOL_CONF as unknown as Record<string, unknown>)[itemId];
  return s &&
    typeof s === 'object' &&
    ('dig' in s || 'pry' in s || 'cut' in s || 'pick' in s)
    ? (s as RoleSpecs)
    : null;
}

/** Công cụ đang có (túi chính + ô vũ khí) */
function owned(p: Pick<PlayerState, 'inventory' | 'gear'>): ItemId[] {
  const ids = new Set<ItemId>(p.inventory.map((i) => i.itemId));
  if (p.gear.weapon) ids.add(p.gear.weapon.itemId);
  return [...ids];
}

/** Hiệu quả của công cụ cho một vai trò (đào thì theo loại ô) */
export function roleEfficiency(
  itemId: string,
  role: ToolRole,
  digKind: 'wall' | 'floor' | 'tunnel' = 'floor',
): number {
  const s = toolSpec(itemId);
  if (!s) return 0;
  if (role === 'dig') return s.dig ? s.dig[digKind] : 0;
  return s[role]?.efficiency ?? 0;
}

/** Công cụ tốt nhất cho vai trò (đào: phải đủ cấp với độ cứng ô) */
export function bestTool(
  p: Pick<PlayerState, 'inventory' | 'gear'>,
  role: ToolRole,
  opts: { hardness?: number; digKind?: 'wall' | 'floor' | 'tunnel' } = {},
): { itemId: ItemId; efficiency: number; power: number } | null {
  let best: { itemId: ItemId; efficiency: number; power: number } | null = null;
  for (const id of owned(p)) {
    const s = toolSpec(id);
    if (!s?.[role]) continue;
    const power = role === 'dig' ? (s.dig?.power ?? 0) : 1;
    if (opts.hardness !== undefined && power < opts.hardness) continue;
    const eff = roleEfficiency(id, role, opts.digKind);
    if (
      !best ||
      eff > best.efficiency ||
      (eff === best.efficiency && power > best.power)
    )
      best = { itemId: id, efficiency: eff, power };
  }
  return best;
}

/** Có công cụ nào cho vai trò này không (bỏ qua cấp) */
export function hasToolFor(
  p: Pick<PlayerState, 'inventory' | 'gear'>,
  role: ToolRole,
): boolean {
  return owned(p).some((id) => !!toolSpec(id)?.[role]);
}

/** Cấp đào cao nhất đang có (0 = không có công cụ đào) */
export function maxDigPower(
  p: Pick<PlayerState, 'inventory' | 'gear'>,
): number {
  return Math.max(0, ...owned(p).map((id) => toolSpec(id)?.dig?.power ?? 0));
}

/** Mòn công cụ một lần (túi hoặc ô vũ khí); hết độ bền thì gãy và mất. Trả về false nếu không còn công cụ. */
export function wearOwnedTool(p: PlayerState, itemId: ItemId): boolean {
  const idx = p.inventory.findIndex((i) => i.itemId === itemId);
  if (idx >= 0) {
    const it = p.inventory[idx];
    if (it.durability === undefined) return true;
    it.durability -= 1;
    if (it.durability <= 0) p.inventory.splice(idx, 1);
    return true;
  }
  const w = p.gear.weapon;
  if (w?.itemId === itemId) {
    if (w.durability === undefined) return true;
    w.durability -= 1;
    if (w.durability <= 0) {
      p.gear.weapon = null;
      p.weaponDrawn = false;
    }
    return true;
  }
  return false;
}

/** Tiếng động khi dùng công cụ (xà beng...) — 0 nếu êm */
export function toolNoise(itemId: string | undefined): number {
  return itemId ? (toolSpec(itemId)?.pry?.noise ?? 0) : 0;
}

/** Bộ sửa chữa: món (túi / ô vũ khí) có độ bền đang thấp nhất so với tối đa */
export function mostWornItem(
  p: Pick<PlayerState, 'inventory' | 'gear'>,
): InventoryItem | null {
  let best: InventoryItem | null = null;
  let ratio = 1;
  for (const it of [
    ...p.inventory,
    ...(p.gear.weapon ? [p.gear.weapon] : []),
  ]) {
    const max = ITEM_DEFS[it.itemId].maxDurability;
    if (!max || it.durability === undefined || it.durability >= max) continue;
    const r = it.durability / max;
    if (r < ratio) {
      ratio = r;
      best = it;
    }
  }
  return best;
}

export function hasAny(
  p: Pick<PlayerState, 'inventory'>,
  ids: ItemId[],
): boolean {
  return ids.some((id) => countItem(p.inventory, id) > 0);
}
