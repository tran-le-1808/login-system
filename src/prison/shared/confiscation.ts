// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Kho tịch thu: khi bị bắt, vũ khí + đồ vượt ngục + đồ cấm bị lấy khỏi người và đưa vào kho của trại.
 * Không mất vĩnh viễn: chuộc lại bằng hối lộ cai ngục, hoặc đột nhập tủ tang vật trong phòng bảo vệ.
 * Quá `keepDays` ngày thì bị huỷ (kiểm tra lúc 08:00). Đồ sinh hoạt hợp lệ và quần áo tù được giữ.
 */
import confJson from './data/confiscation.json';
import { giveItems, playerCode, prisonerOutfit } from './gear';
import { ITEM_DEFS } from './items';
import { clockInfo, emit, journal, nextId } from './rules';
import type {
  ActionResult,
  ConfiscatedEntry,
  InventoryItem,
  ItemId,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

export const CONFISCATION = confJson;

/** Món này có bị tịch thu khi bị bắt không */
export function isConfiscated(itemId: ItemId): boolean {
  const d = ITEM_DEFS[itemId];
  const r = CONFISCATION.rules;
  return (
    (r.confiscateContraband && d.contraband) ||
    (r.confiscateEscapeItems && !!d.escapeItem) ||
    (r.confiscateWeapons && (!!d.isWeapon || d.slotType === 'weapon'))
  );
}

/** Tịch thu trên người: ô vũ khí, túi chính, áo/quần không phải đồ tù. Trả về danh sách món bị lấy. */
export function confiscateFrom(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): InventoryItem[] {
  const taken: InventoryItem[] = [];
  const day = clockInfo(world.totalGameMinutes).day;
  if (p.gear.weapon) {
    taken.push(p.gear.weapon);
    p.gear.weapon = null;
  }
  p.weaponDrawn = false;
  const kept: InventoryItem[] = [];
  for (const it of p.inventory)
    (isConfiscated(it.itemId) ? taken : kept).push(it);
  p.inventory = kept;
  const it = p.gear.outfit;
  if (it && isConfiscated(it.itemId)) taken.push(it);
  if (!it || isConfiscated(it.itemId))
    p.gear.outfit = prisonerOutfit(playerCode(p));
  for (const item of taken)
    world.confiscation.items.push({
      id: nextId(world, 'cf'),
      playerId: p.id,
      item: { ...item },
      day,
    });
  if (taken.length) {
    journal(
      world,
      out,
      'capture',
      `Bị tịch thu: ${taken.map((i) => `${ITEM_DEFS[i.itemId].name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ')}`,
      p.id,
    );
    out.dirtyMeta = true;
  }
  out.dirtyInventories.add(p.id);
  return taken;
}

export function entriesOf(
  world: Pick<WorldState, 'confiscation'>,
  playerId: string,
): ConfiscatedEntry[] {
  return world.confiscation.items.filter((e) => e.playerId === playerId);
}

/** Giá chuộc = giá gốc × hệ số (tối thiểu minBribe) */
export function reclaimPrice(entries: ConfiscatedEntry[]): number {
  const base = entries.reduce(
    (s, e) => s + ITEM_DEFS[e.item.itemId].basePrice * e.item.quantity,
    0,
  );
  return Math.max(
    CONFISCATION.minBribe,
    Math.round(base * CONFISCATION.bribePriceMultiplier),
  );
}

function giveBack(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  entries: ConfiscatedEntry[],
): void {
  const ids = new Set(entries.map((e) => e.id));
  world.confiscation.items = world.confiscation.items.filter(
    (e) => !ids.has(e.id),
  );
  giveItems(
    world,
    out,
    p,
    entries.map((e) => e.item),
  );
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
}

/** Hối lộ cai ngục để chuộc lại toàn bộ đồ của mình */
export function reclaimByBribe(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  guardName: string,
): ActionResult {
  const mine = entriesOf(world, p.id);
  if (!mine.length)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'Bạn không có đồ nào trong kho tịch thu',
    };
  const price = reclaimPrice(mine);
  if (p.money < price)
    return {
      ok: false,
      code: 'REQUIREMENTS_NOT_MET',
      message: `Cần ${price}$ để chuộc lại đồ`,
    };
  p.money -= price;
  giveBack(world, out, p, mine);
  journal(
    world,
    out,
    'event',
    `${p.name} hối lộ ${guardName} ${price}$ để chuộc lại ${mine.length} món bị tịch thu`,
    p.id,
  );
  emit(world, out, {
    type: 'confiscation:reclaimed',
    playerId: p.id,
    data: { count: mine.length, price },
    text: `💸 Chuộc lại ${mine.length} món bị tịch thu (−${price}$)`,
  });
  return { ok: true, data: { count: mine.length, price } };
}

/** Đột nhập tủ tang vật xong: lấy lại đồ của mình */
export function completeBreakIn(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): void {
  const mine = entriesOf(world, p.id);
  if (!mine.length) return;
  giveBack(world, out, p, mine);
  journal(
    world,
    out,
    'event',
    `${p.name} phá tủ tang vật, lấy lại ${mine.length} món`,
    p.id,
  );
  emit(world, out, {
    type: 'confiscation:stolen',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { count: mine.length },
    text: `🗝️ Lấy lại ${mine.length} món từ tủ tang vật!`,
  });
}

/** 08:00: huỷ đồ đã nằm kho quá keepDays ngày */
export function purgeConfiscation(
  world: WorldState,
  out: Outbox,
  day: number,
): void {
  const old = world.confiscation.items.filter(
    (e) => day - e.day >= CONFISCATION.keepDays,
  );
  if (!old.length) return;
  world.confiscation.items = world.confiscation.items.filter(
    (e) => day - e.day < CONFISCATION.keepDays,
  );
  out.dirtyMeta = true;
  for (const pid of new Set(old.map((e) => e.playerId))) {
    const n = old.filter((e) => e.playerId === pid).length;
    out.dirtyInventories.add(pid);
    journal(
      world,
      out,
      'event',
      `Kho tịch thu đã huỷ ${n} món của bạn (quá ${CONFISCATION.keepDays} ngày)`,
      pid,
    );
  }
}
