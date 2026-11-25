// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Thư viện & điểm thông minh.
 * - Bắt đầu 20, tối đa 50, tối thiểu 0. Mỗi 08:00 giảm 2.
 * - Đứng cạnh kệ sách bấm E: đọc 5 giây (đứng yên). Xong +1 thông minh.
 * - Đọc xong là luôn +1 (không còn thời gian chờ giữa các lần đọc; balance.json → shelfCooldownMinutes = 0), tối đa 50.
 * - Mở cả ngày (balance.json → intelligence.alwaysOpen). Di chuyển / bị gọi tên: dừng, không cộng.
 */
import { PRISON_CONFIG as C } from './config';
import { PRISON_MAP, ZONE_BY_ID, zoneAt, type Interactable } from './map';
import { emit, journal } from './rules';
import type { ActionResult, Outbox, PlayerState, WorldState } from './types';

export const INTEL = C.intelligence;

export function clampIntelligence(v: number): number {
  return Math.max(
    INTEL.intelligenceMin,
    Math.min(INTEL.intelligenceMax, Math.round(v)),
  );
}

/** Thư viện mở 24/24 (balance.json → intelligence.alwaysOpen) */
export function libraryOpen(
  world: Pick<WorldState, 'totalGameMinutes'>,
): boolean {
  void world;
  return INTEL.alwaysOpen;
}

/** Phút game còn phải chờ để kệ này cộng điểm lại (0 = cộng được) */
export function shelfCooldownLeft(
  world: Pick<WorldState, 'totalGameMinutes'>,
  p: Pick<PlayerState, 'shelfReads'>,
  shelfId: string,
): number {
  const last = p.shelfReads[shelfId];
  if (last === undefined) return 0;
  return Math.max(
    0,
    last + INTEL.shelfCooldownMinutes - world.totalGameMinutes,
  );
}

export function canReadShelf(
  world: WorldState,
  p: PlayerState,
  it: Interactable,
): ActionResult | null {
  if (!libraryOpen(world))
    return { ok: false, code: 'INVALID_STATE', message: 'Thư viện đang đóng' };
  const z = zoneAt(PRISON_MAP, p.x, p.y);
  if (z && ZONE_BY_ID[z]?.restricted)
    return {
      ok: false,
      code: 'INVALID_STATE',
      message: 'Không đọc được trong khu cấm',
    };
  if (it.kind !== 'bookshelf')
    return { ok: false, code: 'NOT_FOUND', message: 'Không phải kệ sách' };
  return null;
}

/** Đọc xong một kệ */
export function completeRead(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  shelfId: string,
): void {
  const it = PRISON_MAP.interactableById[shelfId];
  if (!it) return;
  out.dirtyInventories.add(p.id);
  // đọc xong là luôn +1 (không còn thời gian chờ giữa các lần đọc), chỉ dừng ở mức tối đa
  p.shelfReads[shelfId] = Math.floor(world.totalGameMinutes);
  const before = p.stats.intelligence;
  p.stats.intelligence = clampIntelligence(before + 1);
  const gained = p.stats.intelligence - before;
  journal(
    world,
    out,
    'event',
    `Đọc ${it.name.toLowerCase()}, thông minh ${p.stats.intelligence}/${INTEL.intelligenceMax}`,
    p.id,
  );
  emit(world, out, {
    type: 'library:read',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { gained },
    text: gained
      ? `🧠 +1 Thông minh (${p.stats.intelligence}/${INTEL.intelligenceMax})`
      : `🧠 Thông minh đã tối đa ${INTEL.intelligenceMax}`,
  });
}

/** 08:00 mỗi ngày: thông minh −2 (không dưới 0) */
export function dailyIntelligenceDecay(
  world: WorldState,
  out: Outbox,
  players: PlayerState[],
): void {
  for (const p of players) {
    const before = p.stats.intelligence;
    p.stats.intelligence = clampIntelligence(
      before - INTEL.intelligenceDailyDecay,
    );
    const lost = before - p.stats.intelligence;
    if (!lost) continue;
    out.dirtyInventories.add(p.id);
    journal(
      world,
      out,
      'event',
      `Ngày mới: thông minh −${lost} (${p.stats.intelligence}/${INTEL.intelligenceMax})`,
      p.id,
    );
    emit(world, out, {
      type: 'library:decay',
      playerId: p.id,
      data: { lost },
      text: `🧠 Ngày mới: thông minh −${lost}`,
    });
  }
}
