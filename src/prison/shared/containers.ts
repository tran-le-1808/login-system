// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Tủ / thùng / bàn là lưới ô thật (như rương): hiện đủ đồ bên trong, cất vào hoặc lấy ra từng ô.
 * Mọi thao tác kiểm tra tầm với, ô còn khớp vật phẩm, số lượng, sức chứa — client chỉ gửi ý định.
 */
import { PRISON_CONFIG as C } from './config';
import { addItem, addTaken, ITEM_DEFS, slotsAfter } from './items';
import { PRISON_MAP, type Interactable } from './map';
import { distanceToInteractable } from './proximity';
import { applyQuestEvent } from './quests';
import { bagFits, giveItems } from './gear';
import { pick } from './rng';
import { clockInfo, emit } from './rules';
import type {
  ActionResult,
  ErrorCode,
  InventoryItem,
  ItemId,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

const fail = (code: ErrorCode, message: string): ActionResult => ({
  ok: false,
  code,
  message,
});

export function containerSlots(it: Pick<Interactable, 'slots'>): number {
  return it.slots ?? C.interaction.containerSlots;
}

function rollItems(
  world: WorldState,
  it: Interactable,
  count: number,
): InventoryItem[] {
  const items: InventoryItem[] = [];
  const loot = it.loot ?? [];
  for (
    let i = 0;
    i < count && loot.length && items.length < containerSlots(it);
    i++
  ) {
    const itemId = pick(world, loot);
    addItem(items, itemId, 1, ITEM_DEFS[itemId].maxDurability);
  }
  return items.slice(0, containerSlots(it));
}

export function initContainers(world: WorldState): void {
  for (const it of PRISON_MAP.interactables)
    if (it.kind === 'container')
      world.containers[it.id] = {
        id: it.id,
        items: rollItems(world, it, C.interaction.containerStock),
      };
}

/** 06:00 mỗi ngày: bổ sung đồ ngẫu nhiên cho các tủ công cộng đang ít đồ (bàn cá nhân thì không) */
export function refillContainers(world: WorldState): void {
  for (const it of PRISON_MAP.interactables) {
    if (it.kind !== 'container' || it.refill === false) continue;
    const c = (world.containers[it.id] ??= { id: it.id, items: [] });
    for (
      let guard = 0;
      guard < 12 &&
      c.items.length < C.interaction.containerStock &&
      c.items.length < containerSlots(it);
      guard++
    ) {
      const itemId = pick(world, it.loot ?? []);
      if (!itemId) break;
      addItem(c.items, itemId, 1, ITEM_DEFS[itemId].maxDurability);
    }
  }
}

function reachable(
  p: PlayerState,
  containerId: string,
): Interactable | ActionResult {
  const it = PRISON_MAP.interactableById[containerId];
  if (!it || it.kind !== 'container')
    return fail('NOT_FOUND', 'Không có tủ này');
  if (distanceToInteractable(p, it) > C.interaction.range)
    return fail('OUT_OF_RANGE', 'Bạn ở quá xa');
  return it;
}

function movedOf(slot: InventoryItem, quantity: number): InventoryItem {
  return {
    itemId: slot.itemId,
    quantity,
    ...(slot.durability !== undefined ? { durability: slot.durability } : {}),
  };
}

/** Lấy `quantity` món từ ô `index` của tủ về túi (ô phải còn đúng `itemId`) */
export function containerTake(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  containerId: string,
  index: number,
  itemId: ItemId,
  quantity: number,
): ActionResult {
  const it = reachable(p, containerId);
  if ('ok' in it) return it;
  const items = (world.containers[containerId] ??= {
    id: containerId,
    items: [],
  }).items;
  const slot = items[index];
  if (!slot || slot.itemId !== itemId)
    return fail('CONFLICT', 'Ô này đã thay đổi');
  if (quantity < 1 || quantity > slot.quantity)
    return fail('INSUFFICIENT_ITEMS', 'Không đủ số lượng trong ô');
  const moved = movedOf(slot, quantity);
  if (!bagFits(p, [moved]))
    return fail('OVER_CAPACITY', 'Túi chính đã đầy 6 ô');
  slot.quantity -= quantity;
  if (slot.quantity <= 0) items.splice(index, 1);
  giveItems(world, out, p, [moved]); // vũ khí trong tủ -> ô vũ khí
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  const day = clockInfo(world.totalGameMinutes).day;
  emit(world, out, {
    type: 'item:found',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { containerId, itemId, quantity },
  });
  // mỗi tủ chỉ tính một lần mỗi ngày cho nhiệm vụ "lục soát" (chống lấy–cất–lấy để cày)
  applyQuestEvent(world, out, {
    eventId: `ct:${containerId}:${day}`,
    type: 'SEARCH',
    playerId: p.id,
    targetId: containerId,
    amount: 1,
  });
  return { ok: true, data: { itemId, quantity } };
}

/** Cất `quantity` món từ ô `index` của túi vào tủ */
export function containerPut(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  containerId: string,
  index: number,
  itemId: ItemId,
  quantity: number,
): ActionResult {
  const it = reachable(p, containerId);
  if ('ok' in it) return it;
  const slot = p.inventory[index];
  if (!slot || slot.itemId !== itemId)
    return fail('CONFLICT', 'Ô túi đồ đã thay đổi');
  if (quantity < 1 || quantity > slot.quantity)
    return fail('INSUFFICIENT_ITEMS', 'Không đủ số lượng trong ô');
  const items = (world.containers[containerId] ??= {
    id: containerId,
    items: [],
  }).items;
  const moved = movedOf(slot, quantity);
  if (slotsAfter(items, [], [moved]) > containerSlots(it))
    return fail('OVER_CAPACITY', 'Tủ đã đầy');
  slot.quantity -= quantity;
  if (slot.quantity <= 0) p.inventory.splice(index, 1);
  addTaken(items, [moved]);
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'container:put',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { containerId, itemId, quantity },
  });
  return { ok: true, data: { itemId, quantity } };
}
