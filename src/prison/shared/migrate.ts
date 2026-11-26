// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Nâng cấp bản lưu / checkpoint cũ lên cấu trúc hiện tại (WORLD_SCHEMA_VERSION).
 * 10 -> 11: áo + quần riêng -> 1 ô "bộ đồ".
 *   - Có áo: áo thành bộ đồ cùng loại. Quần thừa: quần tù -> "Quần áo tù" (vật liệu) vào túi nếu còn chỗ; quần cai ngục bị bỏ.
 *   - Chỉ có quần: thành bộ đồ cùng loại.
 *   - Áo / quần nằm rời trong túi, tủ, ô giấu, kho, sàn, kho tịch thu: áo -> bộ đồ; quần tù -> "Quần áo tù"; quần cai ngục bị bỏ.
 *   - Thêm các trường mới của người chơi (giường, ngất solo, lý do y tế).
 * Trả về null nếu không nâng cấp được (bản quá cũ / hỏng).
 */
import { PRISON_CONFIG as C } from './config';
import { slotsAfter } from './items';
import {
  WORLD_SCHEMA_VERSION,
  type InventoryItem,
  type ItemId,
  type WorldState,
} from './types';

type Loose = Record<string, unknown>;
type OldItem = Omit<InventoryItem, 'itemId'> & { itemId: string };

const OUTFIT_OF: Record<string, ItemId> = {
  guard_top: 'guard_outfit',
  guard_bottom: 'guard_outfit',
  prisoner_top: 'prisoner_outfit',
  prisoner_bottom: 'prisoner_outfit',
};

/** Món rời: áo -> bộ đồ; quần tù -> vật liệu "Quần áo tù"; quần cai ngục -> bỏ (null) */
function looseItem(it: OldItem): InventoryItem | null {
  switch (it.itemId) {
    case 'guard_top':
    case 'prisoner_top':
      return {
        ...it,
        itemId: OUTFIT_OF[it.itemId],
        quantity: 1,
      } as InventoryItem;
    case 'prisoner_bottom':
      return { itemId: 'clothes', quantity: it.quantity };
    case 'guard_bottom':
      return null;
    default:
      return it as unknown as InventoryItem;
  }
}

function mapList(list: unknown): InventoryItem[] {
  if (!Array.isArray(list)) return [];
  return (list as OldItem[])
    .map(looseItem)
    .filter((x): x is InventoryItem => !!x);
}

/** gear {weapon, top, bottom} -> {weapon, outfit}; trả về món thừa (quần) cần cho vào túi */
function migrateGear(gear: Loose | undefined): {
  gear: { weapon: InventoryItem | null; outfit: InventoryItem | null };
  extra: InventoryItem | null;
} {
  const g = gear ?? {};
  if ('outfit' in g)
    return {
      gear: {
        weapon: (g.weapon as InventoryItem) ?? null,
        outfit: (g.outfit as InventoryItem) ?? null,
      },
      extra: null,
    };
  const top = g.top as OldItem | null | undefined;
  const bottom = g.bottom as OldItem | null | undefined;
  let outfit: InventoryItem | null = null;
  let extra: InventoryItem | null = null;
  if (top) {
    outfit = {
      ...top,
      itemId: OUTFIT_OF[top.itemId] ?? 'prisoner_outfit',
      quantity: 1,
    } as InventoryItem;
    if (bottom?.itemId === 'prisoner_bottom')
      extra = { itemId: 'clothes', quantity: 1 };
  } else if (bottom)
    outfit = {
      ...bottom,
      itemId: OUTFIT_OF[bottom.itemId] ?? 'prisoner_outfit',
      quantity: 1,
    } as InventoryItem;
  return {
    gear: { weapon: (g.weapon as InventoryItem) ?? null, outfit },
    extra,
  };
}

export function migrateWorld(raw: unknown): WorldState | null {
  const w = raw as Loose | null;
  if (!w || typeof w !== 'object') return null;
  if (w.schemaVersion === WORLD_SCHEMA_VERSION)
    return w as unknown as WorldState;
  if (w.schemaVersion !== 10 && w.schemaVersion !== 11) return null;
  const world = JSON.parse(JSON.stringify(w)) as Loose;
  if (world.schemaVersion === 10) migrate10to11(world);
  migrate11to12(world);
  world.schemaVersion = WORLD_SCHEMA_VERSION;
  return world as unknown as WorldState;
}

/** 11 -> 12: ngủ khoá chỗ, vòi sen, phòng vệ, đào tường / hầm */
function migrate11to12(world: Loose): void {
  for (const p of Object.values(
    (world.players ?? {}) as Record<string, Loose>,
  )) {
    p.bedToggleAt ??= -1e9;
    p.showerOutfit ??= null;
    p.attackedAt ??= -1e9;
    p.underground ??= false;
  }
  for (const g of (world.guards ?? []) as Loose[]) g.targetInmateId ??= null;
  for (const n of (world.inmates ?? []) as Loose[]) n.aggressorAt ??= -1e9;
  world.dig ??= { holes: {}, entrances: {}, tunnels: {}, decor: {} };
}

function migrate10to11(world: Loose): void {
  for (const p of Object.values(
    (world.players ?? {}) as Record<string, Loose>,
  )) {
    p.inventory = mapList(p.inventory);
    const { gear, extra } = migrateGear(p.gear as Loose);
    p.gear = gear;
    // quần thừa vào túi nếu còn chỗ, không thì bỏ
    if (
      extra &&
      slotsAfter(p.inventory as InventoryItem[], [], [extra]) <=
        C.player.inventorySlots
    )
      (p.inventory as InventoryItem[]).push(extra);
    p.bed ??= null;
    p.bedHold ??= false;
    p.soloKoPending ??= false;
    p.excusedUntil ??= 0;
  }
  for (const e of [
    ...((world.guards ?? []) as Loose[]),
    ...((world.inmates ?? []) as Loose[]),
  ]) {
    e.bag = mapList(e.bag);
    e.gear = migrateGear(e.gear as Loose).gear;
  }
  for (const c of Object.values(
    (world.containers ?? {}) as Record<string, Loose>,
  ))
    c.items = mapList(c.items);
  const spots = (world.hideSpots ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(spots)) spots[k] = mapList(spots[k]);
  const ts = world.teamStorage as Loose | undefined;
  if (ts) ts.items = mapList(ts.items);
  const floor = (world.floorItems ?? {}) as Record<string, Loose>;
  for (const [id, f] of Object.entries(floor)) {
    const it = looseItem(f.item as OldItem);
    if (it) f.item = it;
    else delete floor[id];
  }
  const conf = world.confiscation as { items?: Loose[] } | undefined;
  if (conf?.items)
    conf.items = conf.items.flatMap((e) => {
      const it = looseItem(e.item as OldItem);
      return it ? [{ ...e, item: it }] : [];
    });
  // giao dịch đang chờ có thể nhắc tới món đã đổi id: huỷ hết cho an toàn
  world.trades = {};
  world.challenges = {};
}
