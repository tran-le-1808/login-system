// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Căng tin (giá theo cung cầu & danh tiếng), bán đồ, việc làm theo ca. Hệ số ở data/prices.json. */
import prices from './data/prices.json';

import { addItem, countItem, ITEM_DEFS, removeItem } from './items';
import { nextRandom } from './rng';
import { canCarry, emit, gainSkill, journal } from './rules';
import type {
  ActionResult,
  ItemId,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

export const SHOP_ITEMS = prices.shop as {
  itemId: ItemId;
  basePrice: number;
}[];
export const PRICES = prices;

export function discount(
  p: Pick<PlayerState, 'skills' | 'reputation'>,
): number {
  return Math.min(
    0.35,
    p.skills.social * prices.socialDiscountPerPoint +
      Math.max(0, p.reputation.guards - 50) * prices.reputationDiscountPerPoint,
  );
}

export function shopPrice(
  world: Pick<WorldState, 'market'>,
  itemId: ItemId,
  p?: Pick<PlayerState, 'skills' | 'reputation'>,
): number {
  const entry = SHOP_ITEMS.find((s) => s.itemId === itemId);
  const base = entry?.basePrice ?? ITEM_DEFS[itemId].basePrice;
  const demand = world.market[itemId] ?? 0;
  return Math.max(
    1,
    Math.round(base * (1 + demand) * (1 - (p ? discount(p) : 0))),
  );
}

export function sellPrice(
  world: Pick<WorldState, 'market'>,
  itemId: ItemId,
): number {
  const base = ITEM_DEFS[itemId].basePrice;
  return Math.max(
    1,
    Math.floor(
      base *
        prices.sellRatio *
        Math.max(0.4, 1 - (world.market[`sell:${itemId}`] ?? 0)),
    ),
  );
}

export function marketRecover(world: WorldState, gameMinutes: number): void {
  const k = (prices.demandRecoveryPerGameHour * gameMinutes) / 60;
  for (const key of Object.keys(world.market)) {
    world.market[key] = Math.max(0, world.market[key] - k);
    if (world.market[key] < 1e-6) delete world.market[key];
  }
}

const fail = (
  code: Extract<ActionResult, { ok: false }>['code'],
  message: string,
): ActionResult => ({ ok: false, code, message });

export function buy(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  itemId: ItemId,
): ActionResult {
  if (!SHOP_ITEMS.some((s) => s.itemId === itemId))
    return fail('NOT_FOUND', 'Căng tin không bán món này');
  const price = shopPrice(world, itemId, p);
  if (p.money < price) return fail('INSUFFICIENT_ITEMS', `Cần ${price}$`);
  if (!canCarry(p, itemId))
    return fail('OVER_CAPACITY', 'Túi chính đã đầy 6 ô');
  p.money -= price;
  addItem(p.inventory, itemId, 1);
  world.market[itemId] = Math.min(
    prices.maxDemand,
    (world.market[itemId] ?? 0) + prices.demandPerPurchase,
  );
  gainSkill(p, 'social', 0.5);
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'shop:bought',
    playerId: p.id,
    audit: true,
    data: { itemId, price },
  });
  return { ok: true, data: { itemId, price } };
}

export function sell(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  itemId: ItemId,
): ActionResult {
  if (ITEM_DEFS[itemId].contraband)
    return fail('FORBIDDEN', 'Căng tin không mua đồ cấm');
  if (countItem(p.inventory, itemId) < 1)
    return fail('ITEM_NOT_OWNED', 'Bạn không có món này');
  const price = sellPrice(world, itemId);
  removeItem(p.inventory, itemId, 1);
  p.money += price;
  world.market[`sell:${itemId}`] = Math.min(
    0.6,
    (world.market[`sell:${itemId}`] ?? 0) + prices.demandPerPurchase,
  );
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'shop:sold',
    playerId: p.id,
    audit: true,
    data: { itemId, price },
  });
  return { ok: true, data: { itemId, price } };
}

export function completeWork(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  stationName: string,
): void {
  const j = prices.jobs;
  if (nextRandom(world) < j.accidentChance) {
    p.stats.health = Math.max(1, p.stats.health - j.accidentDamage);
    journal(
      world,
      out,
      'event',
      `${p.name} bị tai nạn lao động ở ${stationName}`,
      p.id,
    );
    emit(world, out, {
      type: 'work:accident',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: `🤕 ${p.name} bị thương khi làm việc`,
    });
  }
  p.money += j.payPerShift;
  gainSkill(p, 'crafting', 0.5);
  p.reputation.guards = Math.min(100, p.reputation.guards + 1);
  out.dirtyInventories.add(p.id);
  emit(world, out, {
    type: 'work:paid',
    playerId: p.id,
    x: p.x,
    y: p.y,
    text: `💵 ${p.name} hoàn thành một ca (+${j.payPerShift}$)`,
  });
}
