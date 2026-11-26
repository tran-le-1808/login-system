// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Luật nền: đồng hồ & lịch, đi qua ô, sức chứa, vi phạm, nhật ký, hạ gục / bắt / thả. */
import { PRISON_CONFIG as C, ROUTINE, type PeriodDef } from './config';
import {
  addItem,
  countItem,
  equippedWeaponItem,
  slotsAfter,
  slotTypeOf,
} from './items';
import { DISGUISE, disguiseActive } from './disguise';
import { confiscateFrom } from './confiscation';
import { leaveMachine } from './gymStats';
import {
  inArea,
  inCellBlock,
  PRISON_MAP,
  tileAt,
  zoneAt,
  ZONE_BY_ID,
} from './map';
import type { SolidFn } from './geometry';
import doorsJson from './data/doors.json';
import KO_CONF from './data/knockout.json';
import COMBAT_RULES from './data/combat.json';
import TOOL_RULES from './data/tools.json';
import { gateOpenByVehicle } from './vehicleSchedule';
import type {
  EngineEvent,
  InventoryItem,
  ItemId,
  JournalKind,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

// ------------------------------------------------------------------ id, sự kiện, nhật ký

export function nextId(world: WorldState, prefix: string): string {
  world.idSeq += 1;
  return `${prefix}${world.idSeq}`;
}

export function emit(
  world: WorldState,
  out: Outbox,
  ev: Omit<EngineEvent, 'id'>,
): EngineEvent {
  const full: EngineEvent = { id: nextId(world, 'ev'), ...ev };
  out.events.push(full);
  return full;
}

export function journal(
  world: WorldState,
  out: Outbox,
  kind: JournalKind,
  text: string,
  playerId?: string,
): void {
  world.journal.push({
    id: nextId(world, 'j'),
    t: Math.floor(world.totalGameMinutes),
    kind,
    text,
    ...(playerId ? { playerId } : {}),
  });
  if (world.journal.length > C.journal.maxEntries)
    world.journal.splice(0, world.journal.length - C.journal.maxEntries);
  out.dirtyMeta = true;
  if (playerId) out.dirtyInventories.add(playerId);
}

// ------------------------------------------------------------------ đồng hồ & lịch sinh hoạt

export interface ClockInfo {
  day: number;
  hour: number;
  minute: number;
  minuteOfDay: number;
  period: string;
}

export const PERIOD_INFO: Record<string, PeriodDef> = Object.fromEntries(
  ROUTINE.segments.map((p) => [p.id, p]),
);

export function periodAt(minuteOfDay: number): PeriodDef {
  return (
    ROUTINE.segments.find(
      (p) => minuteOfDay >= p.startMinute && minuteOfDay < p.endMinute,
    ) ?? ROUTINE.segments[0]
  );
}

/** Khung kế tiếp (bỏ qua phần sau nửa đêm của khung qua đêm) và số phút game còn lại */
export function nextPeriod(minuteOfDay: number): {
  period: PeriodDef;
  inMinutes: number;
} {
  const starts = ROUTINE.segments.filter((p) => !p.cont);
  const next = starts.find((p) => p.startMinute > minuteOfDay) ?? starts[0];
  const inMinutes = (next.startMinute - minuteOfDay + 1440) % 1440 || 1440;
  return { period: next, inMinutes };
}

export function schedulePeriod(minuteOfDay: number): string {
  return periodAt(minuteOfDay).id;
}

export function clockInfo(totalGameMinutes: number): ClockInfo {
  const t = Math.floor(totalGameMinutes);
  const minuteOfDay = ((t % 1440) + 1440) % 1440;
  return {
    day: Math.floor(t / 1440) + 1,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    minuteOfDay,
    period: periodAt(minuteOfDay).id,
  };
}

export function isNight(minuteOfDay: number): boolean {
  return minuteOfDay >= 21 * 60 || minuteOfDay < 6 * 60;
}

/** Đèn phòng giam còn bật (trước giờ tắt đèn) */
export function cellLightsOn(minuteOfDay: number): boolean {
  return !(minuteOfDay >= 21 * 60 || minuteOfDay < 6 * 60);
}

// ------------------------------------------------------------------ đi qua ô

export function outsideOpen(world: WorldState): boolean {
  return (
    world.escape.status === 'EXECUTING' ||
    world.escape.status === 'RESCUE_REQUIRED'
  );
}

export interface DoorRule {
  name: string;
  openWith: string[];
  lockedFrom?: string;
  lockedUntil?: string;
  disguiseWith?: string[];
  openWhileTruck?: boolean;
  trace?: boolean;
}

/** Luật cửa theo ký tự ô (data/doors.json) */
export const DOOR_RULES: Record<string, DoorRule> = Object.fromEntries(
  Object.entries(doorsJson).filter(([, v]) => typeof v === 'object'),
) as Record<string, DoorRule>;
export const DOOR_TRACE = {
  foundChance: doorsJson.traceFoundChance,
  heat: doorsJson.traceHeat,
};

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/** Cửa có giờ khoá (xà lim) đang khoá lúc này? Cửa không có giờ khoá luôn khoá với tù nhân. */
export function doorLockedAt(rule: DoorRule, minuteOfDay: number): boolean {
  if (!rule.lockedFrom || !rule.lockedUntil) return true;
  const a = hm(rule.lockedFrom);
  const b = hm(rule.lockedUntil);
  return a <= b
    ? minuteOfDay >= a && minuteOfDay < b
    : minuteOfDay >= a || minuteOfDay < b;
}

/** Cờ quyết định va chạm của một người chơi — client dùng lại để dự đoán */
export interface PlayerPassFlags {
  ventOpen: boolean;
  outsideOpen: boolean;
  /** Ký tự các cửa có khoá mà người này đi qua được lúc này (theo doors.json) */
  openDoors: string;
  /** Ô hàng rào đã cắt / buộc dây */
  fenceGaps: string[];
  doorsLocked: boolean;
  doorPass: boolean;
  /** Lỗ tường đã đào (đi qua được) */
  holes?: string[];
  /** Ô hầm dưới đất; đang ở dưới hầm thì chỉ đi được trong các ô này */
  tunnels?: string[];
  underground?: boolean;
}

export interface PassInput {
  ventOpen: boolean;
  fenceGaps: string[];
  escapeActive: boolean;
  minuteOfDay: number;
  has: (itemId: string) => boolean;
  disguised: boolean;
  doorsLocked: boolean;
  holes?: string[];
  tunnels?: string[];
  underground?: boolean;
}

/** Hàm thuần: dùng chung server (từ WorldState) và client (từ meta + túi đồ của mình) */
export function computePassFlags(i: PassInput): PlayerPassFlags {
  let openDoors = '';
  for (const [ch, rule] of Object.entries(DOOR_RULES)) {
    const any = (ids?: string[]) => !!ids?.some((id) => i.has(id));
    const open =
      !doorLockedAt(rule, i.minuteOfDay) ||
      any(rule.openWith) ||
      (i.disguised && any(rule.disguiseWith)) ||
      (!!rule.openWhileTruck && gateOpenByVehicle(i.minuteOfDay));
    if (open) openDoors += ch;
  }
  return {
    ventOpen: i.ventOpen,
    outsideOpen: i.escapeActive,
    openDoors,
    fenceGaps: i.fenceGaps,
    doorsLocked: i.doorsLocked,
    doorPass:
      i.has('lockpick') ||
      i.has('improved_lockpick') ||
      i.has('multitool') ||
      i.has('keycard'),
    holes: i.holes ?? [],
    tunnels: i.tunnels ?? [],
    underground: !!i.underground,
  };
}

export function passFlags(world: WorldState, p: PlayerState): PlayerPassFlags {
  return computePassFlags({
    ventOpen: world.routes.ventOpen,
    fenceGaps: world.routes.fenceGaps,
    escapeActive: outsideOpen(world),
    minuteOfDay: clockInfo(world.totalGameMinutes).minuteOfDay,
    has: (id) => countItem(p.inventory, id as ItemId) > 0,
    disguised: disguiseActive(world, p),
    doorsLocked: Object.values(world.players).some(
      (q) => q.status === 'ACTIVE' && q.wantedLevel >= C.wanted.lockdownLevel,
    ),
    holes: Object.keys(world.dig.holes),
    tunnels: Object.keys(world.dig.tunnels),
    underground: p.underground,
  });
}

export const FURNITURE = new Set([
  '#',
  '=',
  'k',
  'B',
  'S',
  '$',
  'R',
  'b',
  't',
  'J',
  'P',
  'x',
  'g',
  's',
  'T',
  'X',
  'W',
]);

export function playerSolid(flags: PlayerPassFlags): SolidFn {
  const gaps = new Set(flags.fenceGaps);
  const holes = new Set(flags.holes ?? []);
  const tunnels = new Set(flags.tunnels ?? []);
  // dưới hầm (tầng ẩn): chỉ đi trong các ô hầm đã đào
  if (flags.underground) return (tx, ty) => !tunnels.has(`${tx},${ty}`);
  return (tx, ty) => {
    if (holes.has(`${tx},${ty}`)) return false;
    const ch = tileAt(PRISON_MAP, tx, ty);
    if (FURNITURE.has(ch)) return true;
    if (DOOR_RULES[ch]) return !flags.openDoors.includes(ch);
    switch (ch) {
      case 'V':
      case 'u':
        return !flags.ventOpen;
      case 'F':
        return !gaps.has(`${tx},${ty}`);
      case 'd':
        return !!flags.doorsLocked && !flags.doorPass;
      case 'o':
        return !flags.outsideOpen;
      default:
        return false;
    }
  };
}

/** Cai ngục đi qua sàn, cửa thường, cửa xà lim, cửa kho, cửa văn phòng */
export const guardSolid: SolidFn = (tx, ty) => {
  const ch = tileAt(PRISON_MAP, tx, ty);
  return (
    ch !== '.' &&
    ch !== ',' &&
    ch !== 'd' &&
    ch !== 'L' &&
    ch !== 'K' &&
    ch !== 'c'
  );
};

/** Tù nhân NPC không vào văn phòng / kho */
export const inmateSolid: SolidFn = (tx, ty) => {
  const ch = tileAt(PRISON_MAP, tx, ty);
  return ch !== '.' && ch !== ',' && ch !== 'd' && ch !== 'c';
};

/** Ô cửa có dấu vết khi mở lén (đang khoá với tù nhân) dưới chân người chơi */
export function lockedDoorUnder(
  world: WorldState,
  p: PlayerState,
): string | null {
  const ch = tileAt(PRISON_MAP, Math.floor(p.x), Math.floor(p.y));
  const rule = DOOR_RULES[ch];
  if (!rule?.trace || disguiseActive(world, p)) return null;
  return doorLockedAt(rule, clockInfo(world.totalGameMinutes).minuteOfDay)
    ? ch
    : null;
}

// ------------------------------------------------------------------ sức chứa & thưởng

/** Sức chứa túi chính: 6 ô, mang Túi đeo hông thì +2 (bản thân túi chiếm 1 ô) */
export function maxSlots(p?: Pick<PlayerState, 'inventory'>): number {
  const pouch =
    p && p.inventory.some((i) => i.itemId === 'storage_pouch')
      ? TOOL_RULES.storagePouchBonusSlots
      : 0;
  return C.player.inventorySlots + pouch;
}

export function canCarry(
  p: PlayerState,
  itemId: ItemId,
  quantity = 1,
  durability?: number,
): boolean {
  if (slotTypeOf(itemId) === 'weapon') return true; // vũ khí vào ô riêng (vũ khí cũ rơi xuống đất)
  return (
    slotsAfter(
      p.inventory,
      [],
      [
        {
          itemId,
          quantity,
          ...(durability !== undefined ? { durability } : {}),
        },
      ],
    ) <= maxSlots(p)
  );
}

export function grantReward(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  money: number,
  exp: number,
): void {
  p.money += money;
  p.experience += exp;
  while (p.experience >= p.level * C.player.expPerLevel) {
    p.experience -= p.level * C.player.expPerLevel;
    p.level += 1;
    p.stats.maxEnergy += 5;
    p.stats.maxHealth += 5;
    emit(world, out, {
      type: 'player:level-up',
      playerId: p.id,
      text: `⭐ ${p.name} lên cấp ${p.level}`,
    });
  }
  out.dirtyInventories.add(p.id);
}

export function gainSkill(
  p: PlayerState,
  skill: keyof PlayerState['skills'],
  amount: number,
): void {
  p.skills[skill] = Math.min(
    C.skills.max,
    Math.round((p.skills[skill] + amount) * 100) / 100,
  );
}

// ------------------------------------------------------------------ vi phạm nội quy

export interface Violation {
  reason: string;
  severity: 'minor' | 'serious';
  /** Khoá chống ghi trùng (theo ngày/khung giờ) */
  key: string;
}

function meetsRequirement(
  req: string,
  p: PlayerState,
  zone: string | null,
): boolean {
  switch (req) {
    case 'any':
      return true;
    case 'ownCell':
      return zone === `cell_${p.cellIndex}`;
    case 'cellBlock':
      return inCellBlock(p.x, p.y);
    case 'rollcall':
      return inArea(PRISON_MAP, 'rollcall', p.x, p.y);
    case 'work':
      return (
        zone === 'workshop' || zone === 'laundry' || workerAllowed(p, zone)
      );
    default:
      return zone === req;
  }
}

/** Vi phạm hiện tại của người chơi (không tính khoảng cách tới lính — ngụy trang xử lý ở guards.ts) */
export function violationOf(
  world: WorldState,
  p: PlayerState,
  ignoreLocation = false,
): Violation | null {
  if (p.status !== 'ACTIVE' || !p.connected) return null;
  const c = clockInfo(world.totalGameMinutes);
  const ch = p.channel?.kind;
  if (
    ch === 'openVent' ||
    ch === 'attachRope' ||
    ch === 'rescue' ||
    ch === 'cameraPanel' ||
    ch === 'cutFence' ||
    ch === 'blackout'
  )
    return {
      reason: 'đang phá hoại',
      severity: 'serious',
      key: `${c.day}:sabotage:${c.hour}`,
    };
  if (ch === 'dig' || ch === 'support')
    return {
      reason: 'đang đào hầm',
      severity: 'serious',
      key: `${c.day}:dig:${c.hour}`,
    };
  if (ch === 'board')
    return {
      reason: 'trèo lên xe',
      severity: 'serious',
      key: `${c.day}:board:${c.hour}`,
    };
  // chế tạo tức thì: cai ngục / camera thấy ngay lúc chế tạo (cửa sổ ngắn sau thời điểm chế tạo)
  if (world.time - p.lastCraftAt < C.crafting.witnessSeconds) {
    if (p.lastCraftContraband)
      return {
        reason: 'chế tạo đồ cấm',
        severity: 'serious',
        key: `${c.day}:craftc:${c.hour}`,
      };
    return {
      reason: 'chế tạo đồ trước mặt cai ngục',
      severity: 'minor',
      key: `${c.day}:craft:${c.hour}`,
    };
  }
  // đánh trả trong cửa sổ phòng vệ (bị tù nhân tấn công trước) không tính là gây hấn
  if (
    world.time - p.lastAttackAt < C.combat.fightWindowSeconds &&
    !(world.time - p.attackedAt < COMBAT_RULES.selfDefenseWindowSeconds)
  )
    return {
      reason: 'đánh nhau',
      severity: 'serious',
      key: `${c.day}:fight:${Math.floor(world.time / 8)}`,
    };
  if (ch === 'loot' || ch === 'lootTake')
    return {
      reason: 'lục soát người bị ngất',
      severity: 'serious',
      key: `${c.day}:loot:${c.hour}`,
    };
  if (p.weaponDrawn && equippedWeaponItem(p))
    return {
      reason: 'cầm vũ khí',
      severity: 'minor',
      key: `${c.day}:armed:${c.hour}`,
    };
  const zone = zoneAt(PRISON_MAP, p.x, p.y);
  // mặc đồ cai ngục: được coi là cai ngục — không vi phạm vì vị trí / khu cấm / lịch tù nhân
  if (ignoreLocation || disguiseActive(world, p)) return null;
  // bộ đồ công nhân: trong giờ làm việc được vào kho / phòng điện / sân xe tải
  if (
    zone &&
    ZONE_BY_ID[zone]?.restricted &&
    !workerAllowed(p, zone, c.minuteOfDay)
  )
    return {
      reason: 'vào khu cấm',
      severity: 'serious',
      key: `${c.day}:restricted:${zone}:${c.hour}`,
    };
  // không mặc bộ đồ (chỉ còn đồ lót) ngoài xà lim / phòng tắm / phòng y tế
  if (undressedInPublic(p, zone))
    return {
      reason: 'không mặc đồ ở nơi công cộng',
      severity: 'minor',
      key: `${c.day}:undressed:${c.hour}`,
    };
  const ownCell = `cell_${p.cellIndex}`;
  if (world.prisonState === 'LOCKDOWN' && zone !== ownCell)
    return {
      reason: 'không về phòng khi phong tỏa',
      severity: 'serious',
      key: `${c.day}:lockdown:${c.hour}`,
    };
  const period = periodAt(c.minuteOfDay);
  const sinceStart = (c.minuteOfDay - period.originMinute + 1440) % 1440;
  if (sinceStart < ROUTINE.graceMinutes) return null;
  if (!meetsRequirement(period.required, p, zone))
    return {
      reason: `vi phạm lịch «${period.name}» (${period.rule.toLowerCase()})`,
      severity: period.severity,
      key: `${c.day}:${period.id}`,
    };
  return null;
}

/** Tương thích: chỉ lấy lý do */
export function violationReason(
  world: WorldState,
  p: PlayerState,
): string | null {
  return violationOf(world, p)?.reason ?? null;
}

/**
 * Lính / camera / điểm danh ghi nhận một vi phạm. Leo thang theo số lần trong ngày:
 * nhắc nhở -> phạt (trừ tiền, danh tiếng, tăng nghi ngờ) -> nghiêm trọng (đủ nghi ngờ để truy đuổi).
 * Trả về true nếu vi phạm đã thành nghiêm trọng.
 */
export function recordViolation(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  v: Violation,
  by: string,
): boolean {
  const c = clockInfo(world.totalGameMinutes);
  if (p.violationKeys.includes(v.key)) return v.severity === 'serious';
  p.violationKeys.push(v.key);
  if (p.violationKeys.length > 40)
    p.violationKeys.splice(0, p.violationKeys.length - 40);
  if (p.violationsToday.day !== c.day)
    p.violationsToday = { day: c.day, count: 0 };
  p.violationsToday.count += 1;
  const n = p.violationsToday.count;
  out.dirtyInventories.add(p.id);
  if (v.severity === 'serious' || n >= C.violations.seriousAfterCount) {
    p.reputation.guards = Math.max(
      0,
      p.reputation.guards - C.reputation.penaltyGuardLoss,
    );
    p.stats.personalHeat = Math.max(
      p.stats.personalHeat,
      C.heat.chaseThreshold,
    );
    journal(
      world,
      out,
      'violation',
      `${by}: ${p.name} ${v.reason} — vi phạm nghiêm trọng`,
      p.id,
    );
    emit(world, out, {
      type: 'violation:serious',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: `🚨 ${p.name} ${v.reason}!`,
    });
    return true;
  }
  if (n === 1) {
    p.stats.personalHeat = Math.min(
      100,
      p.stats.personalHeat + C.heat.warningHeat,
    );
    p.reputation.guards = Math.max(
      0,
      p.reputation.guards - C.reputation.violationGuardLoss,
    );
    journal(
      world,
      out,
      'warning',
      `${by} nhắc nhở ${p.name}: ${v.reason}`,
      p.id,
    );
    emit(world, out, {
      type: 'violation:warning',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: `📣 Nhắc nhở ${p.name}: ${v.reason}`,
    });
  } else {
    const fine = Math.min(p.money, C.violations.penaltyFine);
    p.money -= fine;
    p.stats.personalHeat = Math.min(
      100,
      p.stats.personalHeat + C.heat.penaltyHeat,
    );
    p.reputation.guards = Math.max(
      0,
      p.reputation.guards - C.reputation.penaltyGuardLoss,
    );
    journal(
      world,
      out,
      'penalty',
      `${by} phạt ${p.name} ${fine}$: ${v.reason}`,
      p.id,
    );
    emit(world, out, {
      type: 'violation:penalty',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: `⚠️ ${p.name} bị phạt ${fine}$ (${v.reason})`,
    });
  }
  return false;
}

// ------------------------------------------------------------------ hạ gục / bắt / thả

export function activeHelpers(
  world: WorldState,
  exceptId: string,
): PlayerState[] {
  return world.playerOrder
    .map((id) => world.players[id])
    .filter(
      (q) => q && q.id !== exceptId && q.status === 'ACTIVE' && q.connected,
    );
}

export function cancelChannelsTargeting(
  world: WorldState,
  targetId: string,
): void {
  for (const id of world.playerOrder) {
    const q = world.players[id];
    if (
      q?.channel &&
      q.channel.targetId === targetId &&
      (q.channel.kind === 'revive' || q.channel.kind === 'rescue')
    )
      q.channel = null;
  }
}

export function knockOut(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  cause: string,
  opts: { recover?: boolean } = {},
): void {
  if (p.status !== 'ACTIVE') return;
  p.status = 'KNOCKED_OUT';
  p.knockoutRecover = !!opts.recover;
  p.channel = null;
  p.moving = false;
  p.sprinting = false;
  p.stats.health = 0;
  p.stats.personalHeat = C.heat.heatAfterKnockout;
  const helpers = activeHelpers(world, p.id);
  p.knockoutDeadline =
    world.time +
    (helpers.length
      ? C.rescue.knockoutWindowSeconds
      : opts.recover
        ? C.combat.recoverSeconds
        : C.rescue.knockoutWindowSoloSeconds);
  emit(world, out, {
    type: 'player:knocked-out',
    playerId: p.id,
    audit: true,
    x: p.x,
    y: p.y,
    text: `💫 ${p.name} bị hạ gục (${cause})${helpers.length ? ` — đồng đội có ${C.rescue.knockoutWindowSeconds} giây để hồi sinh!` : ''}`,
  });
  out.dirtyMeta = true;
}

export function revivePlayer(
  world: WorldState,
  out: Outbox,
  target: PlayerState,
  by: PlayerState,
): void {
  target.status = 'ACTIVE';
  target.knockoutDeadline = null;
  target.knockoutRecover = false;
  target.stats.health = Math.round(
    target.stats.maxHealth * C.rescue.reviveHealthPct,
  );
  target.stats.energy = Math.round(
    target.stats.maxEnergy * C.rescue.reviveEnergyPct,
  );
  target.invulnerableUntil = world.time + C.rescue.invulnerableSeconds;
  emit(world, out, {
    type: 'player:revived',
    playerId: target.id,
    targetId: by.id,
    audit: true,
    text: `❤️ ${by.name} đã hồi sinh ${target.name}`,
  });
  out.dirtyMeta = true;
}

/** Tự tỉnh lại sau trận đánh (không có ai hồi sinh, cũng không bị bắt) */
export function recoverPlayer(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): void {
  p.status = 'ACTIVE';
  p.knockoutDeadline = null;
  p.knockoutRecover = false;
  p.stats.health = Math.round(p.stats.maxHealth * C.rescue.reviveHealthPct);
  p.stats.energy = Math.round(p.stats.maxEnergy * C.rescue.reviveEnergyPct);
  p.invulnerableUntil = world.time + C.rescue.invulnerableSeconds;
  // tỉnh dậy nằm trên giường phòng y tế (theo chiều giường); bấm di chuyển để đứng dậy
  if (!lieOnBed(world, p, freeInfirmaryBed(world, p.id), true)) {
    const spot = infirmarySpot();
    p.x = spot.x;
    p.y = spot.y;
  }
  journal(
    world,
    out,
    'event',
    `${p.name} ngất sau trận đánh, được đưa tới phòng y tế`,
    p.id,
  );
  emit(world, out, {
    type: 'player:recovered',
    playerId: p.id,
    x: p.x,
    y: p.y,
    text: `🏥 ${p.name} tỉnh lại ở phòng y tế`,
  });
  out.dirtyMeta = true;
}

/** Mặc bộ đồ công nhân trong khu làm việc (và trong giờ làm việc nếu cấu hình yêu cầu) */
export function workerAllowed(
  p: Pick<PlayerState, 'gear'>,
  zone: string | null,
  minuteOfDay?: number,
): boolean {
  const W = DISGUISE.workerOutfit;
  if (
    !zone ||
    p.gear.outfit?.itemId !== 'worker_outfit' ||
    !W.zones.includes(zone)
  )
    return false;
  if (
    W.onlyDuringWorkShift &&
    minuteOfDay !== undefined &&
    !periodAt(minuteOfDay).workShift
  )
    return false;
  return true;
}

/** Không mặc bộ đồ ở nơi công cộng (ngoài xà lim, phòng tắm, phòng y tế, biệt giam) — tắt được bằng cấu hình */
export function undressedInPublic(
  p: Pick<PlayerState, 'gear'>,
  zone: string | null,
): boolean {
  if (!DISGUISE.outfitRequiredOutsideCell || p.gear.outfit) return false;
  if (!zone || zone === 'outside') return false;
  return !DISGUISE.undressedFreeZones.some((z) =>
    z.endsWith('*') ? zone.startsWith(z.slice(0, -1)) : zone === z,
  );
}

// ------------------------------------------------------------------ nằm trên giường (theo chiều giường)

/** Giường y tế còn trống (theo thứ tự trong bản đồ); đầy thì lấy giường kế tiếp / giường đầu tiên */
export function freeInfirmaryBed(
  world: WorldState,
  exceptId?: string,
): string | null {
  const beds = PRISON_MAP.infirmaryBeds.length
    ? PRISON_MAP.infirmaryBeds
    : PRISON_MAP.interactables
        .filter((i) => i.kind === 'bed' && i.id.startsWith('bedrest_infirm'))
        .map((i) => i.id);
  const taken = new Set(
    Object.values(world.players)
      .filter((q) => q.id !== exceptId && q.bed)
      .map((q) => q.bed),
  );
  return beds.find((b) => !taken.has(b)) ?? beds[0] ?? null;
}

/** Đặt người nằm vào đúng điểm nằm của giường. hold = nằm yên tới khi tự đứng dậy */
export function lieOnBed(
  world: WorldState,
  p: PlayerState,
  bedId: string | null,
  hold = false,
): boolean {
  const bed = bedId ? PRISON_MAP.interactableById[bedId] : undefined;
  if (!bed?.sleepAnchor) return false;
  p.bed = bed.id;
  p.bedHold = hold;
  p.x = bed.sleepAnchor.x;
  p.y = bed.sleepAnchor.y;
  p.moving = false;
  p.sprinting = false;
  return true;
}

/** Ngồi dậy và đứng ở ô trống kế bên giường phía chân giường (bị chắn thì ô trống gần nhất) */
export function standUp(world: WorldState, p: PlayerState): void {
  const bed = p.bed ? PRISON_MAP.interactableById[p.bed] : undefined;
  p.bed = null;
  p.bedHold = false;
  if (!bed?.wakeTile) return;
  const solid = playerSolid(passFlags(world, p));
  const w = bed.wakeTile;
  const cand: { x: number; y: number }[] = [w];
  for (let r = 1; r <= 2; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r)
          cand.push({ x: w.x + dx, y: w.y + dy });
  const t = cand.find((c) => !solid(c.x, c.y)) ?? w;
  p.x = t.x + 0.5;
  p.y = t.y + 0.5;
}

/** Chỗ đứng cạnh giường phòng y tế (nơi người ngất được đưa tới) */
export function infirmarySpot(): { x: number; y: number } {
  const t = PRISON_MAP.interactableById.bedrest_infirm?.tiles[0];
  return t ? { x: t.x + 1.5, y: t.y + 0.5 } : PRISON_MAP.cells[0];
}

/** Nhận sát thương (bị đánh -> huỷ thao tác đang làm, nguyên liệu chế tạo dở không mất); hết máu thì ngất */
export function damagePlayer(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  amount: number,
  cause: string,
): void {
  if (p.status !== 'ACTIVE' || world.time < p.invulnerableUntil) return;
  p.stats.health = Math.max(0, p.stats.health - amount);
  p.channel = null;
  // bị đánh khi đang tập: dừng, giữ các lần đã hoàn thành
  if (p.gym) {
    leaveMachine(world, p);
    out.dirtyMeta = true;
    emit(world, out, {
      type: 'gym:stop',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: `🧘 ${p.name} bị đánh, rời máy tập`,
    });
  }
  emit(world, out, {
    type: 'combat:hurt',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { amount: Math.round(amount * 10) / 10 },
  });
  if (p.stats.health <= 0) {
    knockOut(world, out, p, cause, { recover: true });
    // chơi một mình: cuối tick tua nhanh 30 phút rồi tỉnh dậy ở phòng y tế (world.ts)
    if (world.soloMode && (p.status as string) === 'KNOCKED_OUT')
      p.soloKoPending = true;
  }
}

export function solitaryRemaining(
  world: WorldState,
  p: PlayerState,
): number | null {
  if (p.solitaryUntil === null) return null;
  return p.solitaryClock === 'game'
    ? Math.max(0, p.solitaryUntil - world.totalGameMinutes) /
        C.clock.gameMinutesPerSecond
    : Math.max(0, p.solitaryUntil - world.time);
}

export function capturePlayer(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): void {
  if (p.status !== 'KNOCKED_OUT' && p.status !== 'ACTIVE') return;
  const used = new Set(
    world.playerOrder
      .map((id) => world.players[id])
      .filter((q) => q && q.status === 'CAPTURED')
      .map((q) => q.solitaryCell),
  );
  let cell = PRISON_MAP.solitaryCells.findIndex((_, i) => !used.has(i));
  if (cell < 0) cell = 0;
  const spot = PRISON_MAP.solitaryCells[cell].inside;
  cancelChannelsTargeting(world, p.id);
  p.status = 'CAPTURED';
  p.channel = null;
  p.knockoutDeadline = null;
  p.solitaryCell = cell;
  if (world.mode === 'single') {
    p.solitaryClock = 'game';
    p.solitaryUntil =
      world.totalGameMinutes +
      C.rescue.solitarySingleGameHours[world.difficulty] * 60;
  } else {
    p.solitaryClock = 'sim';
    p.solitaryUntil =
      world.time + C.rescue.solitaryMultiSeconds[world.difficulty];
  }
  p.x = spot.x;
  p.y = spot.y;
  p.stats.personalHeat = 0;
  // bị cai ngục bắt: tịch thu vũ khí + đồ vượt ngục + đồ cấm (knockout.json: confiscateOnGuardKO)
  const seized = KO_CONF.confiscateOnGuardKO
    ? confiscateFrom(world, out, p)
    : [];
  p.bed = null;
  p.bedHold = false;
  p.lootTarget = null;
  const wasWanted = p.wantedLevel;
  p.wantedLevel = 0;
  p.wantedSeenAt = 0;
  p.wantedSince = 0;
  p.timesCaught += 1;
  const lost = seized.length;
  const cash = Math.max(0, p.money - C.rescue.cashKeptOnCapture);
  p.money -= cash;
  out.dirtyInventories.add(p.id);
  for (const tid of Object.keys(world.trades)) {
    const t = world.trades[tid];
    if (t.fromId === p.id || t.toId === p.id) {
      delete world.trades[tid];
      out.dirtyTrades.add(t.fromId).add(t.toId);
    }
  }
  const questId = `d_rescue_${p.id}`;
  if (world.soloMode) {
    // chơi một mình: không ngồi biệt giam nhiều ngày — cuối tick sẽ "qua ngày mới" tới 08:00
    p.soloNightPending = true;
    p.solitaryClock = 'sim';
    p.solitaryUntil = null;
    journal(
      world,
      out,
      'capture',
      `${p.name} bị bắt${wasWanted ? ` khi đang bị truy nã ${wasWanted}★` : ''} — giam qua đêm trong phòng biệt giam${lost ? `, bị tịch thu ${lost} món` : ''}${cash ? `, mất ${cash}$` : ''}`,
      p.id,
    );
    emit(world, out, {
      type: 'player:captured',
      playerId: p.id,
      audit: true,
      data: { solitaryCell: cell, confiscated: lost, cash, solo: true },
      text: `🚨 ${p.name} bị bắt — giam qua đêm${lost ? ` (bị tịch thu ${lost} món)` : ''}`,
    });
    out.dirtyMeta = true;
    return;
  }
  world.teamQuests[questId] = {
    questId,
    status: 'ACTIVE',
    objectiveProgress: { rescue: 0 },
    completedAt: null,
    version: (world.teamQuests[questId]?.version ?? 0) + 1,
    targetPlayerId: p.id,
  };
  out.dirtyQuests.add('team');
  if (wasWanted > 0) {
    // bị bắt khi đang truy nã: biệt giam lâu hơn theo số sao
    if (p.solitaryClock === 'game')
      p.solitaryUntil =
        world.totalGameMinutes +
        C.rescue.solitarySingleGameHours[world.difficulty] *
          60 *
          (1 + (wasWanted - 1) * 0.5);
    else
      p.solitaryUntil =
        world.time +
        C.rescue.solitaryMultiSeconds[world.difficulty] *
          (1 + (wasWanted - 1) * 0.5);
  }
  const span =
    world.mode === 'single'
      ? `${Math.round(((p.solitaryUntil - world.totalGameMinutes) / 1440) * 10) / 10} ngày`
      : `${Math.round(p.solitaryUntil - world.time)} giây`;
  journal(
    world,
    out,
    'capture',
    `${p.name} bị biệt giam ${span}${lost ? `, bị tịch thu ${lost} món` : ''}${cash ? `, mất ${cash}$` : ''}`,
    p.id,
  );
  emit(world, out, {
    type: 'player:captured',
    playerId: p.id,
    audit: true,
    data: { solitaryCell: cell, confiscated: lost, cash },
    text: `🚨 ${p.name} bị tống vào biệt giam${lost ? ` (bị tịch thu ${lost} vật cấm)` : ''}`,
  });
  if (world.mode === 'multi')
    emit(world, out, {
      type: 'rescue:request',
      playerId: p.id,
      text: `🆘 Giải cứu ${p.name} ở ${cell === 0 ? 'Biệt giam A' : 'Biệt giam B'}!`,
    });
  out.dirtyMeta = true;
}

export function releasePlayer(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  rescuer: PlayerState | null,
): void {
  if (p.status !== 'CAPTURED') return;
  const cell = p.solitaryCell ?? 0;
  p.status = 'ACTIVE';
  p.solitaryCell = null;
  p.solitaryUntil = null;
  p.solitaryClock = null;
  p.stats.health = Math.max(
    p.stats.health,
    Math.round(p.stats.maxHealth * C.rescue.releasedHealthPct),
  );
  p.invulnerableUntil = world.time + C.rescue.invulnerableSeconds;
  const spot = rescuer
    ? PRISON_MAP.solitaryCells[cell].release
    : PRISON_MAP.cells[p.cellIndex];
  p.x = spot.x;
  p.y = spot.y;
  const quest = world.teamQuests[`d_rescue_${p.id}`];
  if (quest && quest.status === 'ACTIVE') {
    quest.version += 1;
    if (rescuer) {
      quest.objectiveProgress.rescue = 1;
      quest.status = 'COMPLETED';
      quest.completedAt = world.time;
      grantReward(world, out, rescuer, 30, 40);
    } else quest.status = 'FAILED';
    out.dirtyQuests.add('team');
  }
  emit(world, out, {
    type: rescuer ? 'rescue:completed' : 'player:released',
    playerId: p.id,
    targetId: rescuer?.id,
    audit: true,
    text: rescuer
      ? `🔓 ${rescuer.name} đã giải cứu ${p.name}!`
      : `${p.name} mãn hạn biệt giam, được đưa về phòng`,
  });
  out.dirtyMeta = true;
}

/** Thêm đồ vào kho nhóm nếu vừa, phần còn lại rơi xuống sàn cạnh kho (không mất, không nhân đôi) */
export function stashOrDrop(
  world: WorldState,
  out: Outbox,
  items: InventoryItem[],
): void {
  for (const it of items) {
    if (
      slotsAfter(world.teamStorage.items, [], [it]) <=
      world.teamStorage.maxSlots
    ) {
      addItem(world.teamStorage.items, it.itemId, it.quantity, it.durability);
      world.teamStorage.version += 1;
      out.dirtyTeamStorage = true;
    } else {
      const id = nextId(world, 'drop_');
      world.floorItems[id] = { id, x: 4.5, y: 8.5, item: { ...it } };
      out.dirtyMeta = true;
    }
  }
}
