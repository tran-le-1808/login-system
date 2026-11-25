// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Ô giấu đồ & khám phòng. Mỗi ô có độ an toàn (0–1): xác suất lộ khi khám = 1 - an toàn (+ thưởng độ khó). */
import { searchDigTraces } from './digging';
import { DIFFICULTY_PRESETS, PRISON_CONFIG as C } from './config';
import { closeLook } from './bedding';
import { ITEM_DEFS } from './items';
import { PRISON_MAP, zoneAt } from './map';
import { nextRandom } from './rng';
import { clockInfo, emit, journal, recordViolation } from './rules';
import type { GuardEntity, Outbox, PlayerState, WorldState } from './types';

export function hideSpotIdsOfCell(cellIndex: number): string[] {
  return PRISON_MAP.interactables
    .filter((i) => i.kind === 'hideSpot' && i.cellIndex === cellIndex)
    .map((i) => i.id);
}

export function findChance(world: WorldState, safety: number): number {
  return Math.max(
    0,
    Math.min(
      1,
      1 - safety + DIFFICULTY_PRESETS[world.difficulty].searchFindBonus,
    ),
  );
}

export interface SearchResult {
  found: number;
  tunnelFound: boolean;
}

/** Cai ngục khám phòng giam: ô giấu, đồ trên sàn trong phòng và miệng hầm */
export function resolveRoomSearch(
  world: WorldState,
  out: Outbox,
  cellIndex: number,
  guard: GuardEntity | null,
  onAlarm: (p: PlayerState, radius: number) => void = () => {},
): SearchResult {
  let found = 0;
  for (const spotId of hideSpotIdsOfCell(cellIndex)) {
    const spot = PRISON_MAP.interactableById[spotId];
    const items = world.hideSpots[spotId] ?? [];
    const kept = items.filter((it) => {
      if (!ITEM_DEFS[it.itemId].contraband) return true;
      if (nextRandom(world) < findChance(world, spot.safety ?? 0.5)) {
        found += it.quantity;
        return false;
      }
      return true;
    });
    world.hideSpots[spotId] = kept;
  }
  const zone = `cell_${cellIndex}`;
  for (const [id, f] of Object.entries(world.floorItems))
    if (
      zoneAt(PRISON_MAP, f.x, f.y) === zone &&
      ITEM_DEFS[f.item.itemId].contraband
    ) {
      found += f.item.quantity;
      delete world.floorItems[id];
    }
  // bàn trong phòng: dễ bị lục (an toàn thấp)
  const desk = world.containers[`desk_${cellIndex}`];
  if (desk)
    desk.items = desk.items.filter((it) => {
      if (!ITEM_DEFS[it.itemId].contraband) return true;
      if (nextRandom(world) < findChance(world, 0.2)) {
        found += it.quantity;
        return false;
      }
      return true;
    });
  // đồ đặt trên giường không phải giấu: nhìn kỹ lúc khám là thấy hình nộm
  closeLook(world, out, cellIndex, onAlarm);
  let tunnelFound = false;
  const t = world.tunnels[String(cellIndex)];
  if (
    t &&
    t.progress > 0 &&
    (!t.covered || nextRandom(world) < C.tunnel.foundCoveredChance)
  ) {
    tunnelFound = true;
    t.progress = 0;
    t.supports = 0;
    t.covered = true;
  }
  const owner = Object.values(world.players).find(
    (p) => p.cellIndex === cellIndex,
  );
  const by = guard?.name ?? 'Cai ngục';
  // lỗ tường / miệng hầm tự đào trong xà lim: chưa che lộ ngay, đã che (ảnh / thảm) lộ theo xác suất
  searchDigTraces(world, out, cellIndex, by);
  const c = clockInfo(world.totalGameMinutes);
  out.dirtyMeta = true;
  if (found || tunnelFound) {
    const what = [
      found ? `${found} vật cấm` : '',
      tunnelFound ? 'đường hầm' : '',
    ]
      .filter(Boolean)
      .join(' và ');
    journal(
      world,
      out,
      'search',
      `${by} khám phòng ${cellIndex + 1}: phát hiện ${what}`,
      owner?.id,
    );
    emit(world, out, {
      type: 'search:found',
      playerId: owner?.id,
      audit: true,
      data: { cellIndex, found, tunnelFound },
      text: `🔦 ${by} khám phòng ${cellIndex + 1}: phát hiện ${what}!`,
    });
    if (owner && owner.status === 'ACTIVE')
      recordViolation(
        world,
        out,
        owner,
        {
          reason: `bị phát hiện ${what} trong phòng`,
          severity: 'serious',
          key: `${c.day}:search:${cellIndex}:${c.hour}`,
        },
        by,
      );
  } else {
    journal(
      world,
      out,
      'search',
      `${by} khám phòng ${cellIndex + 1}: không phát hiện gì`,
      owner?.id,
    );
    emit(world, out, {
      type: 'search:clean',
      playerId: owner?.id,
      text: `🔦 ${by} khám phòng ${cellIndex + 1}: sạch sẽ`,
    });
  }
  return { found, tunnelFound };
}
