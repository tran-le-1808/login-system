// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Đồ trên mặt đất (FloorItem): vứt ra ô trước mặt, ném xa vài ô, nhặt một món / nhặt tất cả.
 * - Vật trên đất là thực thể thế giới: cai ngục thấy đồ cấm thì tới nhặt (tịch thu, tăng nghi ngờ);
 *   tù nhân NPC nhặt đồ theo tính cách (tham lam nhặt nhiều hơn).
 * - Đồ kim loại / nặng rơi kêu to; ném đồ gây tiếng động ở chỗ rơi (đánh lạc hướng).
 * - Tự biến mất sau worldItemDespawnDays ngày game; đồ cấm ngoài xà lim bị dọn ngay lúc điểm danh.
 * Thông số: balance.json → floor.
 */
import { PRISON_CONFIG as C } from './config';
import { dist, hasLineOfSight } from './geometry';
import { canGuardSee, alertGuardsTo, sendGuardTo } from './guards';
import { addItem, countItem, ITEM_DEFS, removeItem, slotsAfter } from './items';
import { bagFits, giveItems } from './gear';
import { PRISON_MAP, tileAt, zoneAt } from './map';
import { nextRandom } from './rng';
import { INMATE_BY_ID } from './npc';
import {
  clockInfo,
  DOOR_RULES,
  emit,
  FURNITURE,
  journal,
  nextId,
} from './rules';
import type {
  ActionResult,
  ErrorCode,
  FloorItem,
  InventoryItem,
  ItemId,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

export const FLOOR = C.floor as {
  pickupRadiusTiles: number;
  pickupAllHoldMs: number;
  worldItemDespawnDays: number;
  dropNoiseRadiusTiles: number;
  throwRangeTiles: number;
  throwNoiseRadiusTiles: number;
  guardPickupRange: number;
  guardContrabandHeat: number;
  rollcallSweepContraband: boolean;
  inmatePickupRange: number;
  inmatePickupChance: Record<string, number>;
  inmateBagSlots: number;
};

const fail = (code: ErrorCode, message: string): ActionResult => ({
  ok: false,
  code,
  message,
});

/** Ô không đặt đồ được (tường, đồ đạc, cửa có khoá, lưới / ống gió, hàng rào) */
export function itemTileBlocked(tx: number, ty: number): boolean {
  const ch = tileAt(PRISON_MAP, tx, ty);
  return (
    FURNITURE.has(ch) ||
    !!DOOR_RULES[ch] ||
    ch === 'V' ||
    ch === 'u' ||
    ch === 'F'
  );
}

/** Vật ném bay qua được hàng rào, nhưng dừng trước tường / đồ đạc / cửa khoá */
function throwStops(tx: number, ty: number): boolean {
  const ch = tileAt(PRISON_MAP, tx, ty);
  return FURNITURE.has(ch) || !!DOOR_RULES[ch] || ch === 'V' || ch === 'u';
}

/** Chỗ rơi khi vứt: giữa ô trước mặt (theo hướng nhìn); bị chắn thì rơi ngay ô đang đứng */
export function dropSpot(
  p: Pick<PlayerState, 'x' | 'y' | 'facing' | 'underground'>,
): { x: number; y: number } {
  const here = { x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 };
  if (p.underground) return { x: p.x, y: p.y };
  const tx = Math.floor(p.x + Math.cos(p.facing));
  const ty = Math.floor(p.y + Math.sin(p.facing));
  const front = { x: tx + 0.5, y: ty + 0.5 };
  if (
    (tx === Math.floor(p.x) && ty === Math.floor(p.y)) ||
    itemTileBlocked(tx, ty) ||
    !hasLineOfSight(PRISON_MAP, p.x, p.y, front.x, front.y)
  )
    return here;
  return front;
}

/** Điểm rơi khi ném theo hướng (dirX, dirY): bay tối đa throwRangeTiles, dừng trước vật cản */
export function throwSpot(
  p: Pick<PlayerState, 'x' | 'y'>,
  dirX: number,
  dirY: number,
): { x: number; y: number } {
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len;
  const uy = dirY / len;
  let last = { x: p.x, y: p.y };
  for (let s = 0.25; s <= FLOOR.throwRangeTiles + 1e-6; s += 0.25) {
    const x = p.x + ux * s;
    const y = p.y + uy * s;
    if (
      x < 0 ||
      y < 0 ||
      x >= PRISON_MAP.width ||
      y >= PRISON_MAP.height ||
      throwStops(Math.floor(x), Math.floor(y))
    )
      break;
    last = { x, y };
  }
  return {
    x: Math.round(last.x * 100) / 100,
    y: Math.round(last.y * 100) / 100,
  };
}

export function placeFloorItem(
  world: WorldState,
  out: Outbox,
  x: number,
  y: number,
  item: InventoryItem,
  by?: string,
): FloorItem {
  const id = nextId(world, 'drop_');
  const f: FloorItem = {
    id,
    x,
    y,
    item: { ...item },
    droppedAt: world.totalGameMinutes,
    ...(by ? { droppedBy: by } : {}),
  };
  world.floorItems[id] = f;
  out.dirtyMeta = true;
  return f;
}

/** Vứt `quantity` món xuống ô trước mặt */
export function dropItem(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  itemId: ItemId,
  quantity: number,
): ActionResult {
  if (!ITEM_DEFS[itemId])
    return fail('INVALID_PAYLOAD', 'Không có vật phẩm này');
  if (quantity < 1 || countItem(p.inventory, itemId) < quantity)
    return fail('INSUFFICIENT_ITEMS', 'Không đủ vật phẩm');
  const at = dropSpot(p);
  for (const taken of removeItem(p.inventory, itemId, quantity))
    placeFloorItem(world, out, at.x, at.y, taken, p.id);
  out.dirtyInventories.add(p.id);
  const loud = !!ITEM_DEFS[itemId].noiseOnDrop;
  if (loud && !p.underground)
    alertGuardsTo(world, at, FLOOR.dropNoiseRadiusTiles);
  emit(world, out, {
    type: 'player:item-dropped',
    playerId: p.id,
    audit: true,
    x: at.x,
    y: at.y,
    data: { itemId, quantity, loud },
  });
  return { ok: true, data: { itemId, quantity, x: at.x, y: at.y } };
}

/** Ném 1 món theo hướng: rơi xa tới throwRangeTiles (qua được hàng rào), gây tiếng động ở chỗ rơi */
export function throwItem(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  itemId: ItemId,
  dirX: number,
  dirY: number,
): ActionResult {
  if (!ITEM_DEFS[itemId])
    return fail('INVALID_PAYLOAD', 'Không có vật phẩm này');
  if (p.underground) return fail('INVALID_STATE', 'Dưới hầm không ném được');
  if (!Number.isFinite(dirX) || !Number.isFinite(dirY))
    return fail('INVALID_PAYLOAD', 'Hướng ném không hợp lệ');
  if (!countItem(p.inventory, itemId))
    return fail('ITEM_NOT_OWNED', 'Bạn không có món này');
  if (Math.hypot(dirX, dirY) < 1e-3) {
    dirX = Math.cos(p.facing);
    dirY = Math.sin(p.facing);
  }
  const at = throwSpot(p, dirX, dirY);
  const [taken] = removeItem(p.inventory, itemId, 1);
  placeFloorItem(world, out, at.x, at.y, taken, p.id);
  out.dirtyInventories.add(p.id);
  // tiếng rơi ở chỗ đồ chạm đất: cai ngục gần đó tới xem (dùng để đánh lạc hướng)
  alertGuardsTo(world, at, FLOOR.throwNoiseRadiusTiles);
  emit(world, out, {
    type: 'player:item-thrown',
    playerId: p.id,
    audit: true,
    x: at.x,
    y: at.y,
    data: { itemId, x: at.x, y: at.y },
  });
  return { ok: true, data: { itemId, x: at.x, y: at.y } };
}

/** Nhặt một món trên đất (vũ khí vào ô vũ khí, đồ cùng loại gộp chồng) */
export function pickupFloor(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  floorId: string,
): ActionResult {
  const drop = world.floorItems[floorId];
  if (!drop) return fail('NOT_FOUND', 'Món đồ đã không còn');
  if (dist(p.x, p.y, drop.x, drop.y) > FLOOR.pickupRadiusTiles)
    return fail('OUT_OF_RANGE', 'Đứng gần hơn để nhặt');
  if (!bagFits(p, [drop.item]))
    return fail('OVER_CAPACITY', 'Túi chính đã đầy');
  delete world.floorItems[floorId];
  giveItems(world, out, p, [drop.item]); // vũ khí -> ô vũ khí (vũ khí cũ rơi xuống đất)
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'player:item-picked',
    playerId: p.id,
    x: drop.x,
    y: drop.y,
    data: { itemId: drop.item.itemId, quantity: drop.item.quantity },
  });
  return { ok: true, data: { picked: drop.item.itemId } };
}

/** Nhặt tất cả đồ trong bán kính nhặt (gần → xa) tới khi đầy túi */
export function pickupAll(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): ActionResult {
  const near = Object.values(world.floorItems)
    .map((f) => ({ f, d: dist(p.x, p.y, f.x, f.y) }))
    .filter((e) => e.d <= FLOOR.pickupRadiusTiles)
    .sort((a, b) => a.d - b.d || a.f.id.localeCompare(b.f.id));
  if (!near.length) return fail('NOT_FOUND', 'Không có gì để nhặt');
  let picked = 0;
  let full = false;
  for (const { f } of near) {
    if (!bagFits(p, [f.item])) {
      full = true;
      continue;
    }
    delete world.floorItems[f.id];
    giveItems(world, out, p, [f.item]);
    picked += 1;
  }
  if (!picked) return fail('OVER_CAPACITY', 'Túi chính đã đầy');
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'player:item-picked',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { count: picked, full },
  });
  return { ok: true, data: { picked, full } };
}

function isCellZone(zone: string | null): boolean {
  return !!zone && zone.startsWith('cell_');
}

function confiscateFloor(world: WorldState, out: Outbox, f: FloorItem): void {
  delete world.floorItems[f.id];
  const day = clockInfo(world.totalGameMinutes).day;
  world.confiscation.items.push({
    id: nextId(world, 'cf'),
    playerId: f.droppedBy ?? '',
    item: { ...f.item },
    day,
  });
  out.dirtyMeta = true;
}

/** Điểm danh: cai ngục dọn đồ cấm vứt ngoài xà lim (trong xà lim thì chờ khám phòng) */
export function sweepFloorContraband(world: WorldState, out: Outbox): number {
  if (!FLOOR.rollcallSweepContraband) return 0;
  let n = 0;
  for (const f of Object.values(world.floorItems)) {
    if (
      !ITEM_DEFS[f.item.itemId]?.contraband ||
      isCellZone(zoneAt(PRISON_MAP, f.x, f.y))
    )
      continue;
    confiscateFloor(world, out, f);
    n += f.item.quantity;
  }
  if (n)
    journal(
      world,
      out,
      'search',
      `Điểm danh: cai ngục dọn ${n} vật cấm vứt ngoài xà lim`,
    );
  return n;
}

/** Mỗi tick: hết hạn thì biến mất; trên lượt AI: cai ngục dọn đồ cấm thấy được, tù nhân nhặt đồ */
export function updateFloor(
  world: WorldState,
  out: Outbox,
  aiTick: boolean,
): void {
  const ttl = FLOOR.worldItemDespawnDays * 1440;
  for (const f of Object.values(world.floorItems)) {
    f.droppedAt ??= world.totalGameMinutes;
    if (world.totalGameMinutes - f.droppedAt >= ttl) {
      delete world.floorItems[f.id];
      out.dirtyMeta = true;
    }
  }
  if (!aiTick) return;
  const items = Object.values(world.floorItems);
  if (!items.length) return;
  // cai ngục: thấy đồ cấm -> tới nhặt, tịch thu, tăng nghi ngờ
  for (const g of world.guards) {
    if (
      g.tower ||
      g.downUntil > 0 ||
      g.state === 'CHASE' ||
      world.time < g.stunnedUntil
    )
      continue;
    for (const f of items) {
      if (!world.floorItems[f.id] || !ITEM_DEFS[f.item.itemId]?.contraband)
        continue;
      const d = dist(g.x, g.y, f.x, f.y);
      if (d <= FLOOR.guardPickupRange) {
        confiscateFloor(world, out, f);
        world.teamHeat = Math.min(
          100,
          world.teamHeat + FLOOR.guardContrabandHeat,
        );
        const who = f.droppedBy ? world.players[f.droppedBy]?.name : undefined;
        journal(
          world,
          out,
          'search',
          `${g.name} nhặt ${ITEM_DEFS[f.item.itemId].name} trên đất${who ? ` (do ${who} để lại)` : ''} — tịch thu`,
          f.droppedBy,
        );
        emit(world, out, {
          type: 'floor:confiscated',
          playerId: f.droppedBy,
          x: f.x,
          y: f.y,
          data: { itemId: f.item.itemId, guardId: g.id },
          text: `🔦 ${g.name} tịch thu ${ITEM_DEFS[f.item.itemId].name} vứt trên đất`,
        });
        if (
          g.state === 'INVESTIGATE' &&
          g.lastKnown &&
          dist(g.lastKnown.x, g.lastKnown.y, f.x, f.y) < 0.5
        )
          g.lastKnown = null;
        continue;
      }
      if (g.state === 'PATROL' || g.state === 'RETURN') {
        if (canGuardSee(world, g, f)) sendGuardTo(g, f);
      }
    }
  }
  // tù nhân NPC nhặt đồ dưới chân theo tính cách
  for (const n of world.inmates) {
    if (n.state !== 'IDLE' && n.state !== 'WALK') continue;
    if (n.downUntil > 0 || n.bag.length >= FLOOR.inmateBagSlots) continue;
    const chance =
      FLOOR.inmatePickupChance[INMATE_BY_ID[n.defId]?.personality ?? ''] ?? 0;
    if (chance <= 0) continue;
    for (const f of Object.values(world.floorItems)) {
      if (dist(n.x, n.y, f.x, f.y) > FLOOR.inmatePickupRange) continue;
      if (nextRandom(world) >= chance) break;
      if (slotsAfter(n.bag, [], [f.item]) > FLOOR.inmateBagSlots) break;
      delete world.floorItems[f.id];
      addItem(n.bag, f.item.itemId, f.item.quantity, f.item.durability);
      out.dirtyMeta = true;
      emit(world, out, {
        type: 'floor:npc-took',
        x: f.x,
        y: f.y,
        data: { inmateId: n.id, itemId: f.item.itemId },
      });
      break;
    }
  }
}
