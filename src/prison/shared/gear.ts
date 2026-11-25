// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Ô trang bị: túi chính (6 ô) + ô vũ khí + ô bộ đồ (áo + quần gộp làm một).
 * - Vũ khí chỉ nằm ở ô vũ khí (không chiếm túi). Nhận vũ khí mới khi ô đã có -> vũ khí cũ rơi xuống đất.
 * - Bộ đồ chỉ đặt vào ô bộ đồ. Mặc bộ mới -> bộ cũ vào túi (còn chỗ) hoặc rơi xuống đất.
 * - Không mặc bộ đồ = còn đồ lót (không phải vật phẩm, không lấy được, không mất).
 */
import { PRISON_CONFIG as C } from './config';
import {
  addItem,
  ITEM_DEFS,
  removeItem,
  slotsAfter,
  slotTypeOf,
} from './items';
import { emit, journal, maxSlots, nextId } from './rules';
import type {
  ActionResult,
  ErrorCode,
  Gear,
  InventoryItem,
  ItemId,
  Outbox,
  PlayerState,
  SlotType,
  WorldState,
} from './types';

const fail = (code: ErrorCode, message: string): ActionResult => ({
  ok: false,
  code,
  message,
});

export const emptyGear = (): Gear => ({ weapon: null, outfit: null });

/** Bộ đồ tù nhân mặc định (in mã người mặc) */
export function prisonerOutfit(code: string): InventoryItem {
  return {
    itemId: 'prisoner_outfit',
    quantity: 1,
    owner: code,
    condition: 100,
  };
}

/** Mã tù nhân của người chơi (in trên áo tù) */
export const playerCode = (p: Pick<PlayerState, 'cellIndex'>) =>
  `TN-${String(100 + p.cellIndex * 7).padStart(4, '0')}`;

export type OutfitType = 'prisoner' | 'guard' | 'worker' | null;

/** Loại bộ đồ đang mặc (null = chỉ còn đồ lót) */
export function outfitTypeOf(gear: Pick<Gear, 'outfit'>): OutfitType {
  const it = gear.outfit;
  return it ? ((ITEM_DEFS[it.itemId].outfitType as OutfitType) ?? null) : null;
}

/** Đang mặc bộ đồ cai ngục */
export function isDisguised(p: { gear: Pick<Gear, 'outfit'> }): boolean {
  return outfitTypeOf(p.gear) === 'guard';
}

/** Món có đặt được vào ô này không (kiểm tra ở cả logic lẫn giao diện) */
export function fitsSlot(itemId: ItemId, slot: SlotType): boolean {
  const t = slotTypeOf(itemId);
  if (slot === 'bag') return t !== 'weapon'; // vũ khí không vào túi chính
  return t === slot;
}

export function dropToFloor(
  world: WorldState,
  out: Outbox,
  x: number,
  y: number,
  item: InventoryItem,
): string {
  const id = nextId(world, 'drop_');
  world.floorItems[id] = {
    id,
    x,
    y,
    item: { ...item },
    droppedAt: world.totalGameMinutes,
  };
  out.dirtyMeta = true;
  return id;
}

/** Túi chính còn chứa được các món (bỏ qua vũ khí — chúng vào ô riêng) */
export function bagFits(
  p: Pick<PlayerState, 'inventory'>,
  incoming: InventoryItem[],
  remove: { itemId: ItemId; quantity: number }[] = [],
): boolean {
  const bagItems = incoming.filter((i) => slotTypeOf(i.itemId) !== 'weapon');
  return slotsAfter(p.inventory, remove, bagItems) <= maxSlots(p);
}

/** Đưa vũ khí vào ô vũ khí; vũ khí cũ rơi xuống đất */
export function equipWeaponItem(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  item: InventoryItem,
): void {
  if (p.gear.weapon) {
    const old = p.gear.weapon;
    dropToFloor(world, out, p.x, p.y, old);
    emit(world, out, {
      type: 'gear:dropped',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: `${ITEM_DEFS[old.itemId].name} cũ rơi xuống đất`,
    });
  }
  p.gear.weapon = { ...item, quantity: 1 };
  out.dirtyInventories.add(p.id);
}

/** Mặc bộ đồ; bộ cũ vào túi nếu còn chỗ, không thì rơi xuống đất */
export function wearItem(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  item: InventoryItem,
): void {
  const old = p.gear.outfit;
  p.gear.outfit = { ...item, quantity: 1 };
  if (old) {
    if (bagFits(p, [old])) p.inventory.push({ ...old });
    else dropToFloor(world, out, p.x, p.y, old);
  }
  out.dirtyInventories.add(p.id);
}

/** Nhận đồ: vũ khí -> ô vũ khí; quần áo, đồ khác -> túi chính (gọi sau khi đã kiểm tra bagFits) */
export function giveItems(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  items: InventoryItem[],
): void {
  for (const it of items) {
    if (slotTypeOf(it.itemId) === 'weapon') equipWeaponItem(world, out, p, it);
    else if (
      it.quality !== undefined ||
      it.owner !== undefined ||
      it.condition !== undefined
    )
      p.inventory.push({ ...it });
    else addItem(p.inventory, it.itemId, it.quantity, it.durability);
  }
  out.dirtyInventories.add(p.id);
}

// ------------------------------------------------------------------ hành động

export function wearFromBag(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  index: number,
): ActionResult {
  const it = p.inventory[index];
  if (!it) return fail('NOT_FOUND', 'Ô túi trống');
  if (slotTypeOf(it.itemId) !== 'outfit')
    return fail('INVALID_PAYLOAD', 'Món này không mặc được');
  p.inventory.splice(index, 1);
  wearItem(world, out, p, it);
  const disguised = isDisguised(p);
  if (disguised)
    journal(world, out, 'event', `${p.name} mặc bộ đồ cai ngục`, p.id);
  emit(world, out, {
    type: 'gear:wear',
    playerId: p.id,
    x: p.x,
    y: p.y,
    text: disguised
      ? `🧥 ${p.name} đã mặc bộ đồ cai ngục`
      : `${p.name} mặc ${ITEM_DEFS[it.itemId].name}`,
  });
  return { ok: true, data: { disguised } };
}

/** Cởi bộ đồ: vào túi nếu còn chỗ, đầy thì rơi xuống đất tại chân; người còn mặc đồ lót */
export function takeOff(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): ActionResult {
  const it = p.gear.outfit;
  if (!it) return fail('INVALID_STATE', 'Bạn không mặc bộ đồ nào');
  p.gear.outfit = null;
  if (bagFits(p, [it])) p.inventory.push({ ...it });
  else dropToFloor(world, out, p.x, p.y, it);
  out.dirtyInventories.add(p.id);
  emit(world, out, {
    type: 'gear:take-off',
    playerId: p.id,
    x: p.x,
    y: p.y,
    text: `${p.name} cởi ${ITEM_DEFS[it.itemId].name.toLowerCase()}`,
  });
  return { ok: true };
}

export function dropWeapon(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): ActionResult {
  if (!p.gear.weapon) return fail('INVALID_STATE', 'Không có vũ khí');
  dropToFloor(world, out, p.x, p.y, p.gear.weapon);
  p.gear.weapon = null;
  p.weaponDrawn = false;
  out.dirtyInventories.add(p.id);
  return { ok: true };
}

/** Tháo hết đồ cấm khi bị bắt: vũ khí, bộ đồ cai ngục (trả lại bộ đồ tù của chính mình) */
export function confiscateGear(p: PlayerState, code: string): number {
  let n = 0;
  if (p.gear.weapon) {
    p.gear.weapon = null;
    n++;
  }
  const it = p.gear.outfit;
  if (it && ITEM_DEFS[it.itemId].contraband) {
    p.gear.outfit = prisonerOutfit(code);
    n++;
  } else if (!it) p.gear.outfit = prisonerOutfit(code);
  p.weaponDrawn = false;
  return n;
}

export { removeItem };
