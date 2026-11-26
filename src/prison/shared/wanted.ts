// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Truy nã (1–3 sao). Từ 21:00 tới 08:00 người chơi phải ở trong xà lim. Ra ngoài và bị cai ngục
 * nhìn thấy (hoặc kiểm tra đêm phát hiện giường trống / hình nộm) -> truy nã. Bị thấy thêm hoặc ở ngoài lâu
 * -> tăng sao. Không bị ai thấy đủ lâu -> giảm dần về 0. Từ 2 sao: còi, tăng viện, phong toả cửa khu.
 */
import { PRISON_CONFIG as C } from './config';
import { countItem } from './items';
import { PRISON_MAP, zoneAt } from './map';
import { clockInfo, emit, journal, periodAt, recordViolation } from './rules';
import type { Outbox, PlayerState, WorldState } from './types';

/** Đang trong giờ giới nghiêm (21:00–08:00) */
export function isCurfew(world: Pick<WorldState, 'totalGameMinutes'>): boolean {
  return !!periodAt(clockInfo(world.totalGameMinutes).minuteOfDay).night;
}

export function outsideOwnCell(p: PlayerState): boolean {
  return zoneAt(PRISON_MAP, p.x, p.y) !== `cell_${p.cellIndex}`;
}

/** Cửa khu bị phong toả khi có người bị truy nã từ mức `lockdownLevel` */
export function doorsLocked(world: Pick<WorldState, 'players'>): boolean {
  return Object.values(world.players).some(
    (p) => p.status === 'ACTIVE' && p.wantedLevel >= C.wanted.lockdownLevel,
  );
}

/** Đồ mở được cửa khu đang bị phong toả */
export function hasDoorPass(p: Pick<PlayerState, 'inventory'>): boolean {
  return ['lockpick', 'improved_lockpick', 'multitool', 'keycard'].some(
    (id) => countItem(p.inventory, id as 'lockpick') > 0,
  );
}

/**
 * Bị phát hiện ngoài xà lim sau 21:00 (hoặc giường trống / hình nộm lộ). Lần đầu: 1 sao.
 * Bị thấy lại sau khoảng chờ: +1 sao. Gọi tăng viện theo bán kính của mức truy nã.
 */
export function raiseWanted(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  reason: string,
  by: string,
  onAlarm: (p: PlayerState, radius: number) => void,
): number {
  const now = world.totalGameMinutes;
  const before = p.wantedLevel;
  if (p.wantedLevel === 0) {
    p.wantedLevel = 1;
    p.wantedSince = now;
  } else if (now - p.wantedSeenAt >= C.wanted.redetectCooldownMinutes)
    p.wantedLevel = Math.min(3, p.wantedLevel + 1);
  p.wantedSeenAt = now;
  if (p.wantedLevel === before) return before;
  const c = clockInfo(now);
  world.teamHeat = Math.min(100, world.teamHeat + C.wanted.teamHeatPerLevel);
  p.stats.personalHeat = Math.max(p.stats.personalHeat, C.heat.chaseThreshold);
  recordViolation(
    world,
    out,
    p,
    {
      reason,
      severity: 'serious',
      key: `${c.day}:wanted:${p.wantedLevel}:${Math.floor(now)}`,
    },
    by,
  );
  const hh = `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
  journal(
    world,
    out,
    'violation',
    `${hh} ${by}: ${reason} — truy nã cấp ${p.wantedLevel}`,
    p.id,
  );
  emit(world, out, {
    type: 'violation:wanted',
    playerId: p.id,
    audit: true,
    x: p.x,
    y: p.y,
    data: { level: p.wantedLevel },
    text: `🚨 TRUY NÃ ${'★'.repeat(p.wantedLevel)} ${p.name}! (${reason})${p.wantedLevel >= C.wanted.lockdownLevel ? ' — phong toả cửa khu' : ''}`,
  });
  onAlarm(p, C.wanted.alertRadius[p.wantedLevel - 1]);
  return p.wantedLevel;
}

export function clearWanted(p: PlayerState): void {
  p.wantedLevel = 0;
  p.wantedSeenAt = 0;
  p.wantedSince = 0;
}

/**
 * Mỗi phút game: ở ngoài quá lâu khi bị truy nã -> tăng sao (tối đa 3);
 * không bị ai thấy trong `decayMinutes` và đang khuất tầm nhìn -> giảm 1 sao.
 */
export function updateWanted(
  world: WorldState,
  out: Outbox,
  isSeen: (p: PlayerState) => boolean,
): void {
  const now = world.totalGameMinutes;
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (!p || p.wantedLevel === 0 || p.status !== 'ACTIVE') continue;
    if (isSeen(p)) {
      p.wantedSeenAt = now;
      continue;
    }
    if (now - p.wantedSeenAt >= C.wanted.decayMinutes) {
      p.wantedLevel -= 1;
      p.wantedSeenAt = now;
      out.dirtyMeta = true;
      if (p.wantedLevel === 0) {
        p.wantedSince = 0;
        journal(
          world,
          out,
          'event',
          `${p.name} đã cắt đuôi cai ngục — hết truy nã`,
          p.id,
        );
        emit(world, out, {
          type: 'player:wanted-cleared',
          playerId: p.id,
          text: `😮‍💨 ${p.name} đã thoát truy nã`,
        });
      } else
        emit(world, out, {
          type: 'player:wanted-down',
          playerId: p.id,
          data: { level: p.wantedLevel },
          text: `Truy nã ${p.name} giảm còn ${'★'.repeat(p.wantedLevel)}`,
        });
    }
  }
}

/** Ở ngoài xà lim lâu trong giờ giới nghiêm khi đang bị truy nã -> tăng sao (một lần mỗi `levelUpOutsideMinutes`) */
export function escalateLongAbsence(
  world: WorldState,
  out: Outbox,
  onAlarm: (p: PlayerState, radius: number) => void,
): void {
  if (!isCurfew(world)) return;
  const now = world.totalGameMinutes;
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (
      !p ||
      p.status !== 'ACTIVE' ||
      p.wantedLevel === 0 ||
      p.wantedLevel >= 3 ||
      !outsideOwnCell(p)
    )
      continue;
    if (now - p.wantedSince >= C.wanted.levelUpOutsideMinutes) {
      p.wantedSince = now;
      p.wantedSeenAt = now - C.wanted.redetectCooldownMinutes;
      raiseWanted(
        world,
        out,
        p,
        'ở ngoài xà lim quá lâu sau 21:00',
        'Cai ngục',
        onAlarm,
      );
    }
  }
}
