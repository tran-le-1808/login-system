// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Phòng gym — phần công thức thuần (không phụ thuộc rules/world để tránh vòng import).
 * Mọi hệ số nằm trong data/gym.json.
 */
import balance from './data/balance.json';
import gymJson from './data/gym.json';

const C_STAMINA = balance.stamina;
import type { GymKind, PlayerState, WorldState } from './types';

export const GYM = gymJson;
export const GYM_KINDS: GymKind[] = ['pressBench', 'treadmill'];

/** Phòng gym mở 24/24 (gym.json → alwaysOpen). Khung 15:00–16:00 chỉ là khung sinh hoạt mặc định trong lịch. */
export function gymOpenAt(minuteOfDay: number): boolean {
  void minuteOfDay;
  return GYM.alwaysOpen;
}

export const STAT_MAX = {
  strength: GYM.machines.pressBench.maxPoints,
  agility: GYM.machines.treadmill.maxPoints,
};

export function gymStatOf(kind: GymKind): 'strength' | 'agility' {
  return GYM.machines[kind].stat as 'strength' | 'agility';
}

/** Số tù nhân hiện có trong trại = tù nhân NPC + người chơi chưa thoát */
export function inmateCount(
  world: Pick<WorldState, 'inmates' | 'players'>,
): number {
  return (
    world.inmates.length +
    Object.values(world.players).filter((p) => p.status !== 'ESCAPED').length
  );
}

/** Số máy mỗi loại = số tù nhân × countPerInmate (tự cập nhật, không lưu cứng) */
export function machineCount(
  world: Pick<WorldState, 'inmates' | 'players'>,
  kind: GymKind,
): number {
  return inmateCount(world) * GYM.machines[kind].countPerInmate;
}

export function machineId(kind: GymKind, index: number): string {
  return `${GYM.machines[kind].idPrefix}_${index}`;
}

export function parseMachineId(
  id: string,
): { kind: GymKind; index: number } | null {
  const m = /^([a-z]+)_(\d{1,3})$/.exec(id);
  if (!m) return null;
  const kind = GYM_KINDS.find((k) => GYM.machines[k].idPrefix === m[1]);
  return kind ? { kind, index: Number(m[2]) } : null;
}

export function machineExists(
  world: Pick<WorldState, 'inmates' | 'players'>,
  id: string,
): boolean {
  const m = parseMachineId(id);
  return !!m && m.index < machineCount(world, m.kind);
}

/** Số nhịp gốc cho một lần theo mốc chỉ số (0–20: 10, 21–35: 12, 36–50: 15) */
export function baseClicksFor(stat: number): number {
  for (const t of GYM.clicksPerRep) if (stat <= t.maxStat) return t.clicks;
  return GYM.clicksPerRep[GYM.clicksPerRep.length - 1].clicks;
}

export function isWeak(
  p: Pick<PlayerState, 'stats'>,
  hungerThreshold: number,
): boolean {
  return (
    p.stats.hunger >= hungerThreshold ||
    p.stats.health < p.stats.maxHealth * GYM.weakHealthPct
  );
}

/** Số nhịp cần cho lần kế tiếp: mốc chỉ số × mệt (×1.2) × đói/yếu (×1.1) */
export function beatsNeeded(
  p: Pick<PlayerState, 'stats'>,
  kind: GymKind,
  hungerThreshold: number,
): number {
  let n = baseClicksFor(p.stats[gymStatOf(kind)]);
  if (p.stats.energy < C_STAMINA.lowThreshold) n *= GYM.lowStaminaMultiplier;
  if (isWeak(p, hungerThreshold)) n *= GYM.weakEffectMultiplier;
  return Math.ceil(n - 1e-9);
}

/** Sức mạnh: HP tối đa cộng thêm */
export const strengthHp = (strength: number) =>
  strength * GYM.strength.hpPerPoint;

/** Sức mạnh: hệ số tấn công 1 + sức mạnh × 0.02 */
export const strengthAttack = (strength: number) =>
  1 + strength * GYM.strength.attackPerPoint;

/** Nhanh nhẹn: hệ số tốc độ chạy (có trần) */
export function agilitySpeed(agility: number): number {
  return Math.min(
    GYM.agility.maxSpeedMultiplier,
    1 + Math.max(0, agility) * GYM.agility.speedPerPoint,
  );
}

/** Nhanh nhẹn: hệ số thời gian đào / leo / trèo rào (giảm tối đa 20%) */
export function agilityTime(p: Pick<PlayerState, 'stats'>): number {
  const frac = Math.max(0, Math.min(1, p.stats.agility / STAT_MAX.agility));
  return 1 - frac * GYM.agility.actionTimeReductionMax;
}

/** Đặt sức mạnh: HP tối đa đổi theo, máu hiện tại tăng/giảm đúng phần chênh lệch (không hồi đầy) */
export function setStrength(
  p: Pick<PlayerState, 'stats'>,
  value: number,
): void {
  const v = Math.max(0, Math.min(STAT_MAX.strength, Math.round(value)));
  const diff = strengthHp(v) - strengthHp(p.stats.strength);
  p.stats.strength = v;
  p.stats.maxHealth += diff;
  p.stats.health = Math.max(
    diff < 0 ? 1 : 0,
    Math.min(p.stats.maxHealth, p.stats.health + diff),
  );
}

/** Rời máy (không cộng lần dở). Thuần trạng thái, không phát sự kiện. */
export function leaveMachine(
  world: Pick<WorldState, 'gym'>,
  p: PlayerState,
): void {
  if (!p.gym) return;
  if (world.gym.occupants[p.gym.machineId] === p.id)
    delete world.gym.occupants[p.gym.machineId];
  delete world.gym.requests[p.id];
  p.gym = null;
}

/** Vận tốc hiển thị trên máy chạy bộ */
export function treadmillKmh(momentum: number): number {
  const { base, atFullMomentum } = GYM.treadmillKmh;
  return (
    Math.round(
      (base + (atFullMomentum - base) * Math.max(0, Math.min(1, momentum))) *
        10,
    ) / 10
  );
}
