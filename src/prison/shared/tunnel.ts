// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Đào hầm: nhiều đoạn, mỗi đoạn tạo đất phải xử lý; thiếu thanh chống có thể sập; miệng hầm cần che. */
import { PRISON_CONFIG as C } from './config';
import { addItem, countItem, removeItem, wearTool } from './items';
import { PRISON_MAP } from './map';
import { applyQuestEvent } from './quests';
import { nextRandom } from './rng';
import { canCarry, emit, gainSkill, journal, nextId } from './rules';
import type { Outbox, PlayerState, TunnelState, WorldState } from './types';

export function tunnelOf(world: WorldState, cellIndex: number): TunnelState {
  return (world.tunnels[String(cellIndex)] ??= {
    progress: 0,
    supports: 0,
    covered: true,
  });
}

export function tunnelComplete(t: TunnelState | undefined): boolean {
  return !!t && t.progress >= C.tunnel.segments;
}

export function supportsNeeded(progress: number): number {
  return Math.floor(progress / C.tunnel.supportEvery);
}

export function tunnelSpotId(cellIndex: number): string {
  return `tunnel_${cellIndex}`;
}

export function tunnelSpotCenter(cellIndex: number): { x: number; y: number } {
  const t = PRISON_MAP.interactableById[tunnelSpotId(cellIndex)].tiles[0];
  return { x: t.x + 0.5, y: t.y + 0.5 };
}

export function completeDig(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  cellIndex: number,
): void {
  const t = tunnelOf(world, cellIndex);
  if (tunnelComplete(t) || !wearTool(p.inventory, 'shovel')) return;
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  const spot = tunnelSpotCenter(cellIndex);
  if (
    t.progress > 0 &&
    t.supports < supportsNeeded(t.progress) &&
    nextRandom(world) < C.tunnel.collapseChance
  ) {
    t.progress = Math.max(0, t.progress - 1);
    t.covered = false;
    p.stats.health = Math.max(1, p.stats.health - C.tunnel.collapseDamage);
    journal(
      world,
      out,
      'event',
      `Hầm phòng ${cellIndex + 1} sập vì thiếu thanh chống (còn ${t.progress}/${C.tunnel.segments})`,
      p.id,
    );
    emit(world, out, {
      type: 'tunnel:collapse',
      playerId: p.id,
      x: spot.x,
      y: spot.y,
      text: `💥 Hầm sập! ${p.name} bị thương — cần Thanh chống`,
    });
    return;
  }
  t.progress += 1;
  t.covered = false;
  gainSkill(p, 'fitness', 1);
  gainSkill(p, 'dexterity', 0.5);
  if (canCarry(p, 'dirt')) addItem(p.inventory, 'dirt', 1);
  else {
    const id = nextId(world, 'drop_');
    world.floorItems[id] = {
      id,
      x: p.x,
      y: p.y,
      item: { itemId: 'dirt', quantity: 1 },
    };
  }
  emit(world, out, {
    type: 'tunnel:dug',
    playerId: p.id,
    x: spot.x,
    y: spot.y,
    text: `⛏️ Hầm phòng ${cellIndex + 1}: ${t.progress}/${C.tunnel.segments}`,
  });
  if (tunnelComplete(t)) {
    journal(
      world,
      out,
      'event',
      `Đường hầm phòng ${cellIndex + 1} đã thông ra ngoài tường`,
      p.id,
    );
    const ev = emit(world, out, {
      type: 'route:opened',
      playerId: p.id,
      audit: true,
      data: { route: 'TUNNEL', cellIndex },
      text: `🕳️ ${p.name} đã đào thông đường hầm!`,
    });
    applyQuestEvent(world, out, {
      eventId: ev.id,
      type: 'OPEN_ROUTE',
      playerId: p.id,
      targetId: 'TUNNEL',
      amount: 1,
    });
  }
}

export function completeSupport(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  cellIndex: number,
): void {
  const t = tunnelOf(world, cellIndex);
  if (countItem(p.inventory, 'support') < 1) return;
  removeItem(p.inventory, 'support', 1);
  t.supports += 1;
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'tunnel:support',
    playerId: p.id,
    text: `🪜 Đã chống hầm (${t.supports} thanh)`,
  });
}

export function completeCover(
  world: WorldState,
  out: Outbox,
  cellIndex: number,
): void {
  tunnelOf(world, cellIndex).covered = true;
  out.dirtyMeta = true;
}
