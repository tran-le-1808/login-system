// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Cơ chế vượt ngục riêng của bản đồ Đá Xám: cắt / buộc dây hàng rào, cắt điện (mất điện 90 giây),
 * trốn theo xe (xe giặt, xe hàng), chui đường hầm ra ngoài tường, dấu vết khi mở khoá lén.
 * Chỉ chứa luật; các thao tác giữ (channel) do world.ts gọi completeX khi xong.
 */
import camerasJson from './data/cameras.json';
import { PRISON_CONFIG as C, ROLE_MODIFIERS } from './config';
import { dist } from './geometry';
import { agilityTime } from './gymStats';
import { countItem, removeItem, wearTool } from './items';
import { PRISON_MAP, type Interactable } from './map';
import { distanceToInteractable } from './proximity';
import { applyQuestEvent } from './quests';
import { nextRandom } from './rng';
import {
  clockInfo,
  DOOR_RULES,
  DOOR_TRACE,
  emit,
  gainSkill,
  journal,
  knockOut,
  lockedDoorUnder,
  outsideOpen,
  recordViolation,
} from './rules';
import { disguiseActive } from './disguise';
import { needStamina, spendStamina, STAMINA } from './stamina';
import { tunnelComplete } from './tunnel';
import { bestTool, wearOwnedTool } from './tools';
import { VEHICLES, vehiclePresent } from './vehicleSchedule';
import type {
  ActionResult,
  Channel,
  ErrorCode,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

const fail = (code: ErrorCode, message: string): ActionResult => ({
  ok: false,
  code,
  message,
});

export const BLACKOUT_SECONDS = camerasJson.blackoutSeconds;

export function blackoutActive(
  world: Pick<WorldState, 'time' | 'blackoutUntil'>,
): boolean {
  return world.time < world.blackoutUntil;
}

type StartChannel = (
  kind: Channel['kind'],
  targetId: string,
  seconds: number,
  extra?: Partial<Channel>,
) => ActionResult;

const dexterityTime = (p: PlayerState) =>
  Math.max(0.5, 1 - p.skills.dexterity / 250);

// ------------------------------------------------------------------ hàng rào

/** Ô hàng rào gần người chơi nhất (để cắt / buộc dây đúng chỗ đang đứng) */
export function fenceTileNear(
  p: { x: number; y: number },
  it: Interactable,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (const t of it.tiles) {
    const d = dist(p.x, p.y, t.x + 0.5, t.y + 0.5);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best && bd <= C.interaction.range ? best : null;
}

export function startFence(
  world: WorldState,
  p: PlayerState,
  it: Interactable,
  start: StartChannel,
): ActionResult {
  const t = fenceTileNear(p, it);
  if (!t) return fail('OUT_OF_RANGE', 'Đứng sát hàng rào hơn');
  const key = `${t.x},${t.y}`;
  if (world.routes.fenceGaps.includes(key))
    return fail('INVALID_STATE', 'Chỗ này đã mở');
  const mods = ROLE_MODIFIERS[p.role];
  const cutter = bestTool(p, 'cut');
  if (cutter)
    return start(
      'cutFence',
      it.id,
      (C.interaction.cutFenceSeconds * mods.channelTime * dexterityTime(p)) /
        cutter.efficiency,
      { recipeId: key, itemId: cutter.itemId },
    );
  if (countItem(p.inventory, 'rope')) {
    const low = needStamina(p, STAMINA.climbCost);
    if (low) return low;
    return start(
      'attachRope',
      it.id,
      C.interaction.attachRopeSeconds *
        mods.channelTime *
        dexterityTime(p) *
        agilityTime(p),
      { recipeId: key },
    );
  }
  return fail(
    'ITEM_NOT_OWNED',
    'Cần Kìm cắt rào (thường / thép / dao đa năng) hoặc Dây leo cao',
  );
}

export function completeFence(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  ch: Channel,
): void {
  const key = ch.recipeId ?? '';
  if (!key || world.routes.fenceGaps.includes(key)) return;
  if (ch.kind === 'cutFence') {
    if (!ch.itemId || !wearOwnedTool(p, ch.itemId)) return;
  } else {
    if (countItem(p.inventory, 'rope') < 1) return;
    removeItem(p.inventory, 'rope', 1);
    spendStamina(p, STAMINA.climbCost);
  }
  world.routes.fenceGaps.push(key);
  gainSkill(p, 'dexterity', C.skills.dexterityGain);
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  const it = PRISON_MAP.interactableById[ch.targetId];
  const how = ch.kind === 'cutFence' ? 'cắt một lỗ' : 'buộc dây trèo';
  journal(
    world,
    out,
    'event',
    `${p.name} ${how} trên ${it?.name.toLowerCase() ?? 'hàng rào'}`,
    p.id,
  );
  const ev = emit(world, out, {
    type: 'route:opened',
    playerId: p.id,
    audit: true,
    x: p.x,
    y: p.y,
    data: { route: 'FENCE', ring: it?.ring ?? '' },
    text: `✂️ ${p.name} đã ${how} trên ${it?.name.toLowerCase() ?? 'hàng rào'}!`,
  });
  applyQuestEvent(world, out, {
    eventId: ev.id,
    type: 'OPEN_ROUTE',
    playerId: p.id,
    targetId: 'FENCE',
    amount: 1,
  });
}

// ------------------------------------------------------------------ cắt điện

export function startBlackout(
  world: WorldState,
  p: PlayerState,
  it: Interactable,
  start: StartChannel,
): ActionResult {
  if (blackoutActive(world)) return fail('INVALID_STATE', 'Trại đang mất điện');
  if (!countItem(p.inventory, 'jammer'))
    return fail('ITEM_NOT_OWNED', 'Cần Thiết bị phá điện (bậc 5)');
  return start(
    'blackout',
    it.id,
    C.interaction.blackoutSeconds *
      ROLE_MODIFIERS[p.role].channelTime *
      dexterityTime(p),
  );
}

export function completeBlackout(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): void {
  if (countItem(p.inventory, 'jammer') < 1) return;
  removeItem(p.inventory, 'jammer', 1);
  world.blackoutUntil = world.time + BLACKOUT_SECONDS;
  world.camerasOffUntil = Math.max(world.camerasOffUntil, world.blackoutUntil);
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  journal(
    world,
    out,
    'event',
    `${p.name} gắn thiết bị phá điện — mất điện ${BLACKOUT_SECONDS} giây`,
    p.id,
  );
  emit(world, out, {
    type: 'power:blackout',
    playerId: p.id,
    audit: true,
    x: p.x,
    y: p.y,
    data: { seconds: BLACKOUT_SECONDS },
    text: `⚡ Mất điện toàn trại ${BLACKOUT_SECONDS} giây — camera và đèn pha tắt!`,
  });
}

// ------------------------------------------------------------------ xe giặt / xe hàng

export function startBoard(
  world: WorldState,
  p: PlayerState,
  it: Interactable,
  start: StartChannel,
): ActionResult {
  const v = it.vehicle ? VEHICLES[it.vehicle] : undefined;
  if (!v) return fail('NOT_FOUND', 'Không có xe này');
  if (!outsideOpen(world))
    return fail(
      'INVALID_STATE',
      'Hãy chốt kế hoạch đào tẩu và bấm Bắt đầu trước khi lên xe',
    );
  const md = clockInfo(world.totalGameMinutes).minuteOfDay;
  if (!vehiclePresent(v.id, md))
    return fail('INVALID_STATE', `${v.name} chưa tới / đã đi`);
  if (p.vehicle) return fail('INVALID_STATE', 'Bạn đang ở trong xe');
  return start('board', it.id, v.boardSeconds * agilityTime(p));
}

export function completeBoard(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  targetId: string,
): void {
  const it = PRISON_MAP.interactableById[targetId];
  const v = it?.vehicle ? VEHICLES[it.vehicle] : undefined;
  if (
    !v ||
    !vehiclePresent(v.id, clockInfo(world.totalGameMinutes).minuteOfDay)
  )
    return;
  p.vehicle = v.id;
  p.moving = false;
  p.sprinting = false;
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'vehicle:boarded',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { vehicle: v.id },
    text: `🧺 ${p.name} đã trốn vào ${v.name.toLowerCase()} — nằm yên chờ xe chạy`,
  });
}

export function leaveVehicle(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): ActionResult {
  if (!p.vehicle) return fail('INVALID_STATE', 'Bạn không ở trong xe');
  const name = VEHICLES[p.vehicle]?.name ?? 'xe';
  p.vehicle = null;
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'vehicle:left',
    playerId: p.id,
    text: `${p.name} chui ra khỏi ${name.toLowerCase()}`,
  });
  return { ok: true };
}

/** Đúng giờ xe chạy: kiểm tra xe theo xác suất; qua được thì thả người ở điểm ngoài cổng */
export function departVehicles(
  world: WorldState,
  out: Outbox,
  minuteOfDay: number,
  alarm: (p: PlayerState) => void,
): void {
  for (const v of Object.values(VEHICLES)) {
    if (minuteOfDay !== v.depart) continue;
    const riders = world.playerOrder
      .map((id) => world.players[id])
      .filter((p) => p && p.vehicle === v.id && p.status === 'ACTIVE');
    if (!riders.length) continue;
    emit(world, out, {
      type: 'vehicle:depart',
      data: { vehicle: v.id },
      text: `🚚 ${v.name} chạy ra cổng`,
    });
    for (const p of riders) {
      p.vehicle = null;
      out.dirtyInventories.add(p.id);
      out.dirtyMeta = true;
      const chance =
        v.inspectChance * (disguiseActive(world, p) ? v.disguiseFactor : 1);
      if (nextRandom(world) < chance) {
        const c = clockInfo(world.totalGameMinutes);
        recordViolation(
          world,
          out,
          p,
          {
            reason: `trốn trong ${v.name.toLowerCase()}`,
            severity: 'serious',
            key: `${c.day}:vehicle:${v.id}`,
          },
          'Cai ngục kiểm tra xe',
        );
        emit(world, out, {
          type: 'vehicle:inspected',
          playerId: p.id,
          x: p.x,
          y: p.y,
          text: `🔦 Cai ngục kiểm tra ${v.name.toLowerCase()} và lôi ${p.name} ra!`,
        });
        alarm(p);
        knockOut(world, out, p, `bị phát hiện trong ${v.name.toLowerCase()}`);
        continue;
      }
      const drop = PRISON_MAP.vehicleDrops[v.id];
      if (!drop) continue;
      p.x = drop.x;
      p.y = drop.y;
      p.channel = null;
      journal(
        world,
        out,
        'escape',
        `${p.name} nhảy khỏi ${v.name.toLowerCase()} bên ngoài cổng`,
        p.id,
      );
      emit(world, out, {
        type: 'vehicle:dropped',
        playerId: p.id,
        x: p.x,
        y: p.y,
        data: { vehicle: v.id },
        text: `🏃 ${p.name} nhảy khỏi ${v.name.toLowerCase()} — chạy tới ô thoát!`,
      });
    }
  }
}

// ------------------------------------------------------------------ chui đường hầm

export function crawlTunnel(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  cellIndex: number,
): ActionResult {
  const t = world.tunnels[String(cellIndex)];
  if (!tunnelComplete(t))
    return fail('INVALID_STATE', 'Hầm chưa thông ra ngoài');
  if (!outsideOpen(world))
    return fail(
      'INVALID_STATE',
      'Hãy chốt kế hoạch đào tẩu và bấm Bắt đầu trước',
    );
  const exit = PRISON_MAP.tunnelExit;
  if (!exit) return fail('NOT_FOUND', 'Bản đồ không có miệng hầm phía ngoài');
  const spot = PRISON_MAP.interactableById[`tunnel_${cellIndex}`];
  if (!spot || distanceToInteractable(p, spot) > C.interaction.range)
    return fail('OUT_OF_RANGE', 'Hãy tới miệng hầm');
  const low = needStamina(p, STAMINA.climbCost);
  if (low) return low;
  spendStamina(p, STAMINA.climbCost);
  p.x = exit.x;
  p.y = exit.y;
  p.channel = null;
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'tunnel:crawled',
    playerId: p.id,
    x: p.x,
    y: p.y,
    text: `🕳️ ${p.name} chui qua hầm, ló ra bụi cây ngoài tường!`,
  });
  return { ok: true, data: { x: p.x, y: p.y } };
}

// ------------------------------------------------------------------ dấu vết mở khoá lén

/** Gọi mỗi tick: đứng trên cửa đang khoá (đi qua bằng chìa giả) -> để lại dấu vết (mỗi cửa / ngày một lần) */
export function noteDoorTrace(world: WorldState, p: PlayerState): void {
  const door = lockedDoorUnder(world, p);
  if (!door) return;
  const day = clockInfo(world.totalGameMinutes).day;
  if (
    world.doorTraces.some(
      (t) => t.playerId === p.id && t.door === door && t.day === day,
    )
  )
    return;
  world.doorTraces.push({ playerId: p.id, door, day });
  if (world.doorTraces.length > 40)
    world.doorTraces.splice(0, world.doorTraces.length - 40);
}

/** 08:00: cai ngục kiểm tra ổ khoá — thấy vết cạy thì tăng nghi ngờ với người để lại */
export function morningLockCheck(world: WorldState, out: Outbox): void {
  for (const t of world.doorTraces) {
    const p = world.players[t.playerId];
    if (
      !p ||
      p.status === 'ESCAPED' ||
      nextRandom(world) >= DOOR_TRACE.foundChance
    )
      continue;
    p.stats.personalHeat = Math.min(
      100,
      p.stats.personalHeat + DOOR_TRACE.heat,
    );
    out.dirtyInventories.add(p.id);
    journal(
      world,
      out,
      'warning',
      `Cai ngục thấy vết mở khoá lén ở ${DOOR_RULES[t.door]?.name.toLowerCase() ?? 'cửa'} — nghi ngờ ${p.name}`,
      p.id,
    );
    emit(world, out, {
      type: 'door:trace-found',
      playerId: p.id,
      text: `🔍 Cai ngục phát hiện ổ khoá ${DOOR_RULES[t.door]?.name.toLowerCase() ?? 'cửa'} bị mở lén!`,
    });
  }
  world.doorTraces = [];
}
