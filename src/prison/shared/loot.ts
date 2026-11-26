// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Lục soát người bị knock out (cai ngục hoặc tù nhân đang ngất).
 * Mở túi 3 giây; mỗi lần lấy một món 0.5 giây, áo / quần 2 giây. Có thanh tiến trình, di chuyển hoặc bị đánh thì dừng.
 * Có cai ngục khác đang nhìn: vẫn cho lục nhưng tăng nghi ngờ mạnh. Mục tiêu tỉnh dậy giữa chừng thì dừng ngay.
 */
import { actionSeconds, PRISON_CONFIG as C } from './config';
import { dist } from './geometry';
import { bagFits, equipWeaponItem, giveItems, wearItem } from './gear';
import { ITEM_DEFS, slotTypeOf } from './items';
import { INMATE_BY_ID } from './npc';
import { PRISON_MAP, zoneAt, zoneName } from './map';
import { emit, journal } from './rules';
import type {
  ActionResult,
  ErrorCode,
  Gear,
  GuardEntity,
  InmateEntity,
  InventoryItem,
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

export type LootTarget =
  | { kind: 'guard'; e: GuardEntity; name: string }
  | { kind: 'inmate'; e: InmateEntity; name: string };

export function findLootTarget(
  world: WorldState,
  id: string,
): LootTarget | null {
  const g = world.guards.find((x) => x.id === id);
  if (g) return { kind: 'guard', e: g, name: g.name };
  const n = world.inmates.find((x) => x.id === id);
  if (n)
    return { kind: 'inmate', e: n, name: INMATE_BY_ID[n.defId]?.name ?? n.id };
  return null;
}

const isDown = (t: LootTarget) => t.e.downUntil > 0;

function reach(p: PlayerState, t: LootTarget): boolean {
  return dist(p.x, p.y, t.e.x, t.e.y) <= C.interaction.range;
}

function itemAt(
  e: { gear: Gear; bag: InventoryItem[] },
  slot: SlotType,
  index: number,
): InventoryItem | null {
  return slot === 'bag' ? (e.bag[index] ?? null) : e.gear[slot];
}

/** Bắt đầu lục soát (mở túi) */
export function lootStart(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  targetId: string,
  watched: boolean,
): ActionResult {
  const t = findLootTarget(world, targetId);
  if (!t) return fail('NOT_FOUND', 'Không có ai ở đây');
  if (!isDown(t))
    return fail('INVALID_STATE', 'Chỉ lục soát được người đang ngất');
  if (!reach(p, t)) return fail('OUT_OF_RANGE', 'Hãy đứng cạnh người bị ngất');
  if (p.channel && p.channel.kind !== 'sleep')
    return fail('CONFLICT', 'Bạn đang làm việc khác');
  if (watched) {
    p.stats.personalHeat = Math.min(
      100,
      p.stats.personalHeat + C.loot.watchedHeat,
    );
    emit(world, out, {
      type: 'loot:watched',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: '👀 Có người đang nhìn!',
    });
  }
  const open = actionSeconds(C.loot.openSeconds);
  p.channel = {
    kind: 'loot',
    targetId,
    elapsed: 0,
    duration: open,
    startX: p.x,
    startY: p.y,
  };
  return { ok: true, data: { channel: 'loot', duration: open } };
}

export function completeLootOpen(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  targetId: string,
  watched: boolean,
): void {
  const t = findLootTarget(world, targetId);
  if (!t || !isDown(t) || !reach(p, t)) return;
  p.lootTarget = targetId;
  out.dirtyInventories.add(p.id);
  const where = zoneName(zoneAt(PRISON_MAP, p.x, p.y));
  journal(
    world,
    out,
    'event',
    `${p.name} lục soát ${t.name} (ngất) ở ${where}${watched ? ' — bị nhìn thấy' : ''}`,
    p.id,
  );
  emit(world, out, {
    type: 'loot:open',
    playerId: p.id,
    targetId,
    text: `🎒 ${p.name} mở túi đồ của ${t.name}`,
  });
}

/** Lấy một món từ mục tiêu (bắt đầu thao tác giữ) */
export function lootTake(
  world: WorldState,
  p: PlayerState,
  targetId: string,
  slot: SlotType,
  index: number,
): ActionResult {
  if (p.lootTarget !== targetId)
    return fail('INVALID_STATE', 'Hãy lục soát người này trước');
  const t = findLootTarget(world, targetId);
  if (!t || !isDown(t)) return fail('INVALID_STATE', 'Người này đã tỉnh');
  if (!reach(p, t)) return fail('OUT_OF_RANGE', 'Bạn đã đi quá xa');
  const it = itemAt(t.e, slot, index);
  if (!it) return fail('NOT_FOUND', 'Ô này trống');
  const type = slotTypeOf(it.itemId);
  if (type === 'bag' && !bagFits(p, [it]))
    return fail('OVER_CAPACITY', 'Túi chính đã đầy 6 ô — bỏ bớt đồ trước');
  if (
    type === 'outfit' &&
    p.gear.outfit?.itemId === it.itemId &&
    p.gear.outfit?.owner === it.owner
  )
    return fail('INVALID_STATE', 'Bạn đang mặc đúng món này rồi');
  if (p.channel && p.channel.kind !== 'sleep')
    return fail('CONFLICT', 'Bạn đang làm việc khác');
  const seconds = actionSeconds(
    type === 'outfit' ? C.loot.clothingSeconds : C.loot.itemSeconds,
  );
  p.channel = {
    kind: 'lootTake',
    targetId,
    elapsed: 0,
    duration: seconds,
    startX: p.x,
    startY: p.y,
    slot,
    index,
    itemId: it.itemId,
  };
  return { ok: true, data: { channel: 'lootTake', duration: seconds } };
}

export function completeLootTake(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  targetId: string,
  slot: SlotType,
  index: number,
  itemId: string,
): void {
  const t = findLootTarget(world, targetId);
  if (!t || !isDown(t) || !reach(p, t)) return;
  const it = itemAt(t.e, slot, index);
  if (!it || it.itemId !== itemId) return;
  const type = slotTypeOf(it.itemId);
  if (type !== 'weapon' && type !== 'outfit' && !bagFits(p, [it])) return;
  if (slot === 'bag') t.e.bag.splice(index, 1);
  else t.e.gear[slot] = null;
  if (type === 'weapon') equipWeaponItem(world, out, p, it);
  else if (type === 'outfit') wearItem(world, out, p, it);
  else giveItems(world, out, p, [it]);
  if (t.kind === 'inmate') t.e.robbedBy = p.id;
  out.dirtyMeta = true;
  out.dirtyInventories.add(p.id);
  const name = ITEM_DEFS[it.itemId].name;
  journal(world, out, 'event', `${p.name} lấy ${name} từ ${t.name}`, p.id);
  emit(world, out, {
    type: 'loot:take',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { itemId: it.itemId },
    text: `Đã lấy ${name} từ ${t.name}`,
  });
}

/** Mục tiêu tỉnh dậy: dừng mọi người đang lục soát họ; trả về những người đó (để mục tiêu phản ứng) */
export function interruptLooters(
  world: WorldState,
  out: Outbox,
  targetId: string,
): PlayerState[] {
  const hit: PlayerState[] = [];
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (!p) continue;
    const looting =
      p.lootTarget === targetId ||
      ((p.channel?.kind === 'loot' || p.channel?.kind === 'lootTake') &&
        p.channel.targetId === targetId);
    if (!looting) continue;
    p.lootTarget = null;
    if (p.channel?.kind === 'loot' || p.channel?.kind === 'lootTake')
      p.channel = null;
    out.dirtyInventories.add(p.id);
    hit.push(p);
  }
  return hit;
}

/** Đóng túi khi đi xa / mục tiêu không còn ngất */
export function validateLootSessions(world: WorldState, out: Outbox): void {
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (!p?.lootTarget) continue;
    const t = findLootTarget(world, p.lootTarget);
    if (
      !t ||
      !isDown(t) ||
      dist(p.x, p.y, t.e.x, t.e.y) > C.interaction.range + 0.6 ||
      p.status !== 'ACTIVE'
    ) {
      p.lootTarget = null;
      out.dirtyInventories.add(p.id);
    }
  }
}
