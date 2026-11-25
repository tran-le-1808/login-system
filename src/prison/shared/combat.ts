// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Đánh nhau: đòn cận chiến theo hướng đang quay mặt, có tầm, hồi chiêu và độ bền vũ khí.
 * Sát thương = sát thương vũ khí (tay không nếu không cầm) × (1 + Sức mạnh + Thể lực) × đánh lén × dao động nhỏ.
 * Mục tiêu: cai ngục và tù nhân (đồng đội không bị đánh nhầm). Server tính mọi kết quả; client chỉ gửi ý định.
 */
import { PRISON_CONFIG as C } from './config';
import { alertGuardsTo, provokeGuard } from './guards';
import {
  angleDiff,
  dist,
  hasLineOfSight,
  moveWithCollision,
  round4,
} from './geometry';
import { equippedWeaponItem, ITEM_DEFS, isWeaponId } from './items';
import { PRISON_MAP, zoneAt, zoneName } from './map';
import { INMATE_BY_ID, onInmateHit } from './npc';
import { strengthAttack } from './gymStats';
import { nextRandom } from './rng';
import {
  clockInfo,
  emit,
  guardSolid,
  inmateSolid,
  journal,
  recordViolation,
} from './rules';
import type {
  ActionResult,
  GuardEntity,
  InmateEntity,
  ItemId,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

const fail = (
  code: Extract<ActionResult, { ok: false }>['code'],
  message: string,
): ActionResult => ({ ok: false, code, message });

export interface WeaponStats {
  itemId: ItemId | null;
  name: string;
  damage: number;
  range: number;
  cooldown: number;
  /** Độ bền còn lại (null = tay không / không có độ bền) */
  durability: number | null;
  maxDurability: number | null;
}

/** Vũ khí đang cầm, hoặc tay không */
export function currentWeapon(
  p: Pick<PlayerState, 'gear' | 'weaponDrawn'>,
): WeaponStats {
  const it = p.weaponDrawn ? equippedWeaponItem(p) : null;
  if (!it)
    return {
      itemId: null,
      name: 'Tay không',
      ...C.combat.fists,
      durability: null,
      maxDurability: null,
    };
  const def = ITEM_DEFS[it.itemId];
  return {
    itemId: it.itemId,
    name: def.name,
    ...def.weapon!,
    durability: it.durability ?? null,
    maxDurability: def.maxDurability ?? null,
  };
}

/** Hệ số sát thương theo Sức mạnh và kỹ năng Thể lực */
export function damageMultiplier(p: {
  stats: { strength: number };
  skills: { fitness: number };
}): number {
  // Sức mạnh (máy đẩy tạ): tấn công × (1 + sức mạnh × 0.02); Thể lực cộng thêm một chút
  return Math.max(
    0.5,
    strengthAttack(p.stats.strength) +
      (p.skills.fitness / 100) * C.combat.fitnessDamagePer100,
  );
}

/** Sát thương kỳ vọng của một đòn (chưa tính đánh lén / dao động) — dùng để hiển thị */
export function expectedDamage(
  p: Pick<PlayerState, 'gear' | 'weaponDrawn' | 'stats' | 'skills'>,
): number {
  return Math.round(currentWeapon(p).damage * damageMultiplier(p) * 10) / 10;
}

/**
 * Rút / cất vũ khí ở ô vũ khí. itemId = null -> cất (đánh tay không, không bị coi là cầm vũ khí);
 * itemId = vũ khí trong ô -> rút ra.
 */
export function equipWeapon(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  itemId: ItemId | null,
): ActionResult {
  if (itemId === null) p.weaponDrawn = false;
  else {
    if (!isWeaponId(itemId))
      return fail('INVALID_STATE', 'Đây không phải vũ khí');
    if (p.gear.weapon?.itemId !== itemId)
      return fail('ITEM_NOT_OWNED', 'Ô vũ khí không có vũ khí này');
    p.weaponDrawn = true;
  }
  out.dirtyInventories.add(p.id);
  emit(world, out, {
    type: 'combat:equip',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { itemId: itemId ?? '' },
  });
  return { ok: true, data: { equipped: itemId ?? '' } };
}

type Target =
  | { kind: 'guard'; e: GuardEntity; d: number }
  | { kind: 'inmate'; e: InmateEntity; d: number };

function findTarget(
  world: WorldState,
  p: PlayerState,
  reach: number,
): Target | null {
  const half = ((C.combat.arcDeg / 2) * Math.PI) / 180;
  let best: Target | null = null;
  const consider = (
    kind: Target['kind'],
    e: GuardEntity | InmateEntity,
    radius: number,
  ): void => {
    const d = dist(p.x, p.y, e.x, e.y);
    if (d > reach + radius) return;
    if (
      d > 0.45 &&
      Math.abs(angleDiff(Math.atan2(e.y - p.y, e.x - p.x), p.facing)) > half
    )
      return;
    if (!hasLineOfSight(PRISON_MAP, p.x, p.y, e.x, e.y)) return;
    if (!best || d < best.d) best = { kind, e, d } as Target;
  };
  for (const g of world.guards)
    if (g.downUntil <= 0 && !g.tower) consider('guard', g, C.guard.radius);
  for (const n of world.inmates)
    if (n.downUntil <= 0) consider('inmate', n, 0.3);
  return best;
}

function wearWeapon(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  w: WeaponStats,
): void {
  if (!w.itemId || w.durability === null) return;
  const it = p.gear.weapon;
  if (!it || it.durability === undefined) return;
  it.durability -= 1;
  out.dirtyInventories.add(p.id);
  if (it.durability <= 0) {
    p.gear.weapon = null;
    p.weaponDrawn = false;
    emit(world, out, {
      type: 'combat:weapon-broken',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: `💥 ${ITEM_DEFS[it.itemId].name} của ${p.name} đã gãy!`,
    });
  }
}

function knockback(
  e: GuardEntity | InmateEntity,
  from: PlayerState,
  solid: typeof guardSolid,
): void {
  const dx = e.x - from.x;
  const dy = e.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const pos = moveWithCollision(
    e.x,
    e.y,
    (dx / d) * C.combat.knockback,
    (dy / d) * C.combat.knockback,
    C.guard.radius,
    solid,
  );
  e.x = pos.x;
  e.y = pos.y;
}

function hitGuard(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  g: GuardEntity,
  dmg: number,
): void {
  const c = clockInfo(world.totalGameMinutes);
  // mỗi cai ngục chỉ bị đánh ngất một lần mỗi ngày (lần sau họ cảnh giác, không gục)
  const floor = g.koDay === c.day ? 1 : 0;
  g.health = Math.max(floor, g.health - dmg);
  g.stunnedUntil = Math.max(
    g.stunnedUntil,
    world.time + C.combat.hitStunSeconds,
  );
  knockback(g, p, guardSolid);
  const key = `${c.day}:assault:${g.id}:${c.hour}`;
  if (!p.violationKeys.includes(key))
    world.teamHeat = Math.min(100, world.teamHeat + C.combat.assaultTeamHeat);
  recordViolation(
    world,
    out,
    p,
    { reason: `tấn công ${g.name}`, severity: 'serious', key },
    g.name,
  );
  if (g.health <= 0) {
    // ngất tại chỗ — đồng nghiệp KHÔNG biết ngay trừ khi nhìn thấy (phát hiện khi đi ngang / lúc điểm danh)
    g.downUntil = world.time + C.guard.recoveryTime;
    g.koDay = c.day;
    g.koBy = p.id;
    g.missingReported = false;
    g.targetPlayerId = null;
    g.task = null;
    g.path = [];
    g.state = 'RETURN';
    g.catchTimer = 0;
    journal(
      world,
      out,
      'violation',
      `${p.name} đánh ngất ${g.name} ở ${zoneName(zoneAt(PRISON_MAP, g.x, g.y))}`,
      p.id,
    );
    emit(world, out, {
      type: 'combat:ko',
      playerId: p.id,
      targetId: g.id,
      audit: true,
      x: g.x,
      y: g.y,
      text: `💥 ${p.name} đánh ngất ${g.name}!`,
    });
  } else {
    provokeGuard(world, out, g, p);
    alertGuardsTo(world, p, C.guard.alarmCallRadius, g.id);
  }
}

function hitInmate(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  n: InmateEntity,
  dmg: number,
): void {
  const def = INMATE_BY_ID[n.defId];
  n.health = Math.max(0, n.health - dmg);
  knockback(n, p, inmateSolid);
  p.reputation.inmates = Math.max(
    0,
    p.reputation.inmates - C.combat.inmateHitRepLoss,
  );
  if (n.health > 0) {
    onInmateHit(world, out, n, p);
    return;
  }
  n.downUntil = world.time + (def.recoveryTime ?? C.combat.inmateDownSeconds);
  n.state = 'DOWN';
  n.combat = 'knockedOut';
  n.fightWith = null;
  n.path = [];
  if (!n.grudges.includes(p.id)) n.grudges.push(p.id);
  p.groupRep[def.groupId] = Math.max(
    0,
    (p.groupRep[def.groupId] ?? C.reputation.start) -
      C.combat.ai.groupRepLoss * 2,
  );
  p.reputation.inmates = Math.max(
    0,
    p.reputation.inmates - C.combat.inmateRepLoss,
  );
  const [lo, hi] = C.combat.inmatePurse;
  const purse = Math.round(lo + nextRandom(world) * (hi - lo));
  p.money += purse;
  journal(
    world,
    out,
    'violation',
    `${p.name} đánh gục ${def.name} và lấy ${purse}$`,
    p.id,
  );
  emit(world, out, {
    type: 'combat:ko',
    playerId: p.id,
    targetId: n.id,
    audit: true,
    x: n.x,
    y: n.y,
    text: `💥 ${p.name} đánh gục ${def.name} (+${purse}$)`,
  });
}

/**
 * Tung một đòn theo hướng đang quay mặt. Hồi chiêu tính cả khi đánh hụt; vũ khí chỉ mòn khi trúng.
 */
export function attack(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): ActionResult {
  if (world.time < p.attackReadyAt)
    return fail('RATE_LIMITED', 'Đang hồi chiêu');
  const w = currentWeapon(p);
  p.channel = null;
  p.attackReadyAt = Math.round((world.time + w.cooldown) * 1e6) / 1e6;
  p.lastAttackAt = world.time;
  out.dirtyInventories.add(p.id);
  emit(world, out, {
    type: 'combat:swing',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { facing: p.facing, range: w.range },
  });
  const t = findTarget(world, p, w.range);
  if (!t) return { ok: true, data: { hit: false } };
  // đánh lén: nhắm vào lưng đối phương (cai ngục không quay mặt về phía mình) -> sát thương cao hơn
  const toMe = Math.atan2(p.y - t.e.y, p.x - t.e.x);
  const sneak =
    Math.abs(angleDiff(t.e.facing, toMe)) > (110 * Math.PI) / 180 &&
    !(t.kind === 'guard' && t.e.state === 'CHASE');
  const variance = 1 + (nextRandom(world) * 2 - 1) * C.combat.variance;
  const dmg =
    Math.round(
      w.damage *
        damageMultiplier(p) *
        variance *
        (sneak ? C.combat.sneakMultiplier : 1) *
        10,
    ) / 10;
  emit(world, out, {
    type: 'combat:hit',
    playerId: p.id,
    targetId: t.e.id,
    x: t.e.x,
    y: t.e.y,
    data: { damage: dmg, sneak },
  });
  if (t.kind === 'guard') hitGuard(world, out, p, t.e, dmg);
  else hitInmate(world, out, p, t.e, dmg);
  wearWeapon(world, out, p, w);
  p.facing = round4(p.facing);
  return { ok: true, data: { hit: true, damage: dmg, sneak, target: t.e.id } };
}
