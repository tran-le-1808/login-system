// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Vật phẩm & công thức: dữ liệu ở data/items.json, data/recipes.json. Ở đây chỉ có thao tác thuần. */
import itemsJson from './data/items.json';
import recipesJson from './data/recipes.json';
import type { Gear, InventoryItem, ItemId, SlotType } from './types';

export type ItemType =
  | 'usable'
  | 'material'
  | 'contraband'
  | 'disguise'
  | 'weapon'
  | 'clothing';

export interface WeaponData {
  damage: number;
  range: number;
  cooldown: number;
}

export interface ItemDef {
  id: ItemId;
  name: string;
  type: ItemType;
  weight: number;
  contraband: boolean;
  maxDurability?: number;
  maxStack: number;
  glyph: string;
  color: string;
  basePrice: number;
  /** Đồ ăn bổ sung: dùng là mất, hồi thể lực tức thì, có thời gian chờ ăn lại */
  consumable?: boolean;
  /** Đồ vượt ngục: bị tịch thu khi bị bắt */
  escapeItem?: boolean;
  /** Rơi xuống đất kêu to (kim loại / đồ nặng): cai ngục gần đó nghe thấy */
  noiseOnDrop?: boolean;
  staminaRestore?: number;
  cooldownSeconds?: number;
  weapon?: WeaponData;
  /** Hình nộm: dùng làm người giả trên giường */
  isDecoy?: boolean;
  slotType: SlotType;
  isWeapon?: boolean;
  /** Nhóm vật phẩm: raw | component | tool | weapon | disguise | utility | special */
  category?:
    | 'raw'
    | 'component'
    | 'tool'
    | 'weapon'
    | 'disguise'
    | 'utility'
    | 'special';
  /** Độ hiếm: common | uncommon | rare | epic */
  rarity?: 'common' | 'uncommon' | 'rare' | 'epic';
  /** Đặt lên tường / sàn (vật che) */
  decor?: 'wall' | 'floor';
  /** Bộ đồ (áo + quần gộp): loại & màu để vẽ nhân vật */
  isOutfit?: boolean;
  outfitType?: 'prisoner' | 'guard' | 'worker';
  outfitColor?: string;
  damage?: number;
  attackSpeed?: number;
  description: string;
}

export const ITEM_DEFS = Object.fromEntries(
  (Object.entries(itemsJson) as [ItemId, Omit<ItemDef, 'id'>][]).map(
    ([id, d]) => [id, { ...d, id }],
  ),
) as Record<ItemId, ItemDef>;

export const ITEM_IDS = Object.keys(ITEM_DEFS) as ItemId[];

export function isItemId(v: unknown): v is ItemId {
  return (
    typeof v === 'string' && Object.prototype.hasOwnProperty.call(ITEM_DEFS, v)
  );
}

/** Công thức: không cần bản vẽ — cần đủ điểm thông minh theo bậc (1–5) */
export interface Recipe {
  id: string;
  output: ItemId;
  tier: number;
  intelligenceRequired: number;
  ingredients: { itemId: ItemId; quantity: number }[];
}

export const RECIPES = recipesJson as Recipe[];
export const RECIPE_BY_ID: Record<string, Recipe> = Object.fromEntries(
  RECIPES.map((r) => [r.id, r]),
);

// ------------------------------------------------------------------ thao tác túi đồ (thuần)

export function countItem(items: InventoryItem[], itemId: ItemId): number {
  let n = 0;
  for (const it of items) if (it.itemId === itemId) n += it.quantity;
  return n;
}

export function totalWeight(items: InventoryItem[]): number {
  let w = 0;
  for (const it of items) w += ITEM_DEFS[it.itemId].weight * it.quantity;
  return w;
}

export function itemsWeight(
  list: { itemId: ItemId; quantity: number }[],
): number {
  let w = 0;
  for (const it of list) w += ITEM_DEFS[it.itemId].weight * it.quantity;
  return w;
}

/** Thêm vật phẩm. Vật có độ bền: mỗi món một ô. */
export function addItem(
  items: InventoryItem[],
  itemId: ItemId,
  quantity: number,
  durability?: number,
): void {
  const def = ITEM_DEFS[itemId];
  if (def.maxDurability !== undefined) {
    for (let i = 0; i < quantity; i++)
      items.push({
        itemId,
        quantity: 1,
        durability: durability ?? def.maxDurability,
      });
    return;
  }
  let left = quantity;
  for (const it of items) {
    if (left <= 0) break;
    if (it.itemId !== itemId) continue;
    const room = def.maxStack - it.quantity;
    if (room <= 0) continue;
    const put = Math.min(room, left);
    it.quantity += put;
    left -= put;
  }
  while (left > 0) {
    const put = Math.min(def.maxStack, left);
    items.push({ itemId, quantity: put });
    left -= put;
  }
}

/** Lấy ra vật phẩm, trả về các món đã lấy (giữ độ bền). Gọi sau khi đã kiểm tra đủ số lượng. */
export function removeItem(
  items: InventoryItem[],
  itemId: ItemId,
  quantity: number,
): InventoryItem[] {
  const taken: InventoryItem[] = [];
  let left = quantity;
  for (let i = items.length - 1; i >= 0 && left > 0; i--) {
    const it = items[i];
    if (it.itemId !== itemId) continue;
    const take = Math.min(it.quantity, left);
    it.quantity -= take;
    left -= take;
    taken.push({
      itemId,
      quantity: take,
      ...(it.durability !== undefined ? { durability: it.durability } : {}),
    });
    if (it.quantity <= 0) items.splice(i, 1);
  }
  return taken;
}

export function addTaken(items: InventoryItem[], taken: InventoryItem[]): void {
  for (const t of taken) addItem(items, t.itemId, t.quantity, t.durability);
}

/**
 * Mô phỏng (trên bản sao) việc lấy ra `remove` rồi thêm `add` — trả về số ô sau đó.
 * Dùng để kiểm tra sức chứa theo ô trước khi ghi thật.
 */
export function slotsAfter(
  items: InventoryItem[],
  remove: { itemId: ItemId; quantity: number }[],
  add: InventoryItem[],
): number {
  const copy = items.map((i) => ({ ...i }));
  for (const r of remove) removeItem(copy, r.itemId, r.quantity);
  addTaken(copy, add);
  return copy.length;
}

/** Dùng 1 độ bền của dụng cụ; hỏng thì mất. Trả về false nếu không có. */
export function wearTool(items: InventoryItem[], itemId: ItemId): boolean {
  const idx = items.findIndex((it) => it.itemId === itemId);
  if (idx < 0) return false;
  const it = items[idx];
  if (it.durability === undefined) return true;
  it.durability -= 1;
  if (it.durability <= 0) items.splice(idx, 1);
  return true;
}

// ------------------------------------------------------------------ vũ khí

export function isWeaponId(id: ItemId | null | undefined): id is ItemId {
  return !!id && !!ITEM_DEFS[id]?.weapon;
}

/** Vũ khí trong ô vũ khí (null = tay không) */
export function equippedWeaponItem(p: { gear: Gear }): InventoryItem | null {
  return p.gear.weapon;
}

export function slotTypeOf(itemId: ItemId): SlotType {
  return ITEM_DEFS[itemId].slotType ?? 'bag';
}
