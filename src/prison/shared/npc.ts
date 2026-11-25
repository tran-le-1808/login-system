// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Tù nhân NPC: lịch riêng theo khung giờ, tính cách (mách lẻo / tham / nóng / hiền), mua bán, mách nước,
 * và đánh nhau: bị đánh thì đánh trả hoặc bỏ chạy (theo hung hăng / gan dạ / máu / thù), người cùng nhóm lao vào
 * (tối đa 3 người một trận), nóng tính có thể chủ động gây sự với người họ thù.
 * Trạng thái chiến đấu: idle, threatened, fighting, retreating, knockedOut.
 */
import inmatesJson from './data/inmates.json';
import { PRISON_CONFIG as C } from './config';
import {
  dist,
  findPath,
  hasLineOfSight,
  moveWithCollision,
  round4,
} from './geometry';
import { DISGUISE, disguiseActive } from './disguise';
import COMBAT_RULES from './data/combat.json';
import { giveItems } from './gear';
import { ITEM_DEFS } from './items';
import { interruptLooters } from './loot';
import { zoneAt, PRISON_MAP } from './map';
import { nextRandom, pick } from './rng';
import {
  canCarry,
  clockInfo,
  damagePlayer,
  emit,
  gainSkill,
  infirmarySpot,
  inmateSolid,
  journal,
  undressedInPublic,
  violationOf,
} from './rules';
import type {
  ActionResult,
  Gear,
  InmateEntity,
  InventoryItem,
  ItemId,
  Outbox,
  PlayerState,
  Point,
  WorldState,
} from './types';

export interface InmateDef {
  id: string;
  name: string;
  personality: 'calm' | 'greedy' | 'snitch' | 'hothead';
  color: string;
  sells: { itemId: ItemId; price: number }[];
  tips: { text: string; true: boolean }[];
  /** 0–1: khả năng đánh trả / chủ động gây sự */
  aggression: number;
  /** 0–1: dám đánh tiếp khi có cai ngục gần / máu thấp */
  courage: number;
  groupId: string;
  /** id người chơi thù sẵn (nạp từ dữ liệu) */
  grudges: string[];
  code: string;
  inventory: { bag: string[]; weapon: string | null; outfit: string | null };
  knockoutHp: number;
  recoveryTime: number;
}

export const INMATE_DEFS = inmatesJson as InmateDef[];
export const INMATE_BY_ID: Record<string, InmateDef> = Object.fromEntries(
  INMATE_DEFS.map((d) => [d.id, d]),
);

const passable = (tx: number, ty: number) => !inmateSolid(tx, ty);

/** Túi đồ tù nhân theo inmates.json: túi 6 ô, vũ khí, áo + quần có mã tù */
export function inmateKit(d: InmateDef): { gear: Gear; bag: InventoryItem[] } {
  const item = (id: string): InventoryItem => {
    const def = ITEM_DEFS[id as ItemId];
    return {
      itemId: id as ItemId,
      quantity: 1,
      ...(def.maxDurability ? { durability: def.maxDurability } : {}),
      ...(def.slotType === 'outfit' ? { owner: d.code, condition: 100 } : {}),
    };
  };
  const inv = d.inventory;
  return {
    gear: {
      weapon: inv.weapon ? item(inv.weapon) : null,
      outfit: inv.outfit ? item(inv.outfit) : null,
    },
    bag: inv.bag.slice(0, 6).map(item),
  };
}

export function createInmates(): InmateEntity[] {
  return INMATE_DEFS.map((d, i) => {
    const s = PRISON_MAP.inmateSpawns[i % PRISON_MAP.inmateSpawns.length];
    return {
      id: d.id,
      defId: d.id,
      x: s.x,
      y: s.y,
      facing: 0,
      state: 'IDLE',
      path: [],
      waitUntil: 0,
      gymMachine: null,
      gymRepAt: 0,
      gymAskedDay: 0,
      goalZone: null,
      snitchTarget: null,
      snitchTimer: 0,
      health: d.knockoutHp ?? C.combat.inmateHealth,
      downUntil: 0,
      ...inmateKit(d),
      robbedBy: null,
      combat: 'idle',
      fightWith: null,
      reactAt: 0,
      aggressorAt: -1e9,
      retreatUntil: 0,
      attackReadyAt: 0,
      grudges: [...(d.grudges ?? [])],
      provokedAt: -1e9,
    };
  });
}

/** Xà lim của tù nhân thứ index (theo điểm xuất hiện trên bản đồ) */
function homeZone(index: number): string {
  const s = PRISON_MAP.inmateSpawns[index % PRISON_MAP.inmateSpawns.length];
  return (s && zoneAt(PRISON_MAP, s.x, s.y)) || 'hall';
}

function goalFor(periodId: string, index: number): string {
  switch (periodId) {
    case 'WAKE':
    case 'LIGHTS_OUT':
      return homeZone(index);
    case 'ROLL_CALL':
    case 'ROLL_CALL_2':
      return '@rollcall';
    case 'LUNCH':
    case 'DINNER':
      return 'canteen';
    case 'WORK':
    case 'WORK_2':
      return index % 2 ? 'laundry' : 'workshop';
    case 'GYM':
      return 'gym';
    case 'SHOWER':
      return 'shower';
    default:
      return index % 3 === 0 ? 'library' : 'yard';
  }
}

// ------------------------------------------------------------------ đánh nhau

const r2 = (v: number) => Math.round(v * 1e6) / 1e6;

function participants(world: WorldState, playerId: string): InmateEntity[] {
  return world.inmates.filter(
    (n) =>
      n.fightWith === playerId &&
      (n.combat === 'fighting' || n.combat === 'threatened'),
  );
}

/** Đưa một tù nhân vào thế bị đe doạ với người chơi (phản ứng sau 0.3–0.8 giây, không đồng loạt như máy) */
export function threaten(
  world: WorldState,
  n: InmateEntity,
  playerId: string,
): void {
  if (n.downUntil > 0) return;
  const [a, b] = C.combat.ai.reactDelay;
  n.combat = 'threatened';
  n.fightWith = playerId;
  n.reactAt = r2(world.time + a + nextRandom(world) * (b - a));
  n.path = [];
}

/** Người chơi đánh trúng tù nhân: ghi thù, người cùng nhóm thấy thì có thể lao vào (tối đa 3 người/trận) */
export function onInmateHit(
  world: WorldState,
  out: Outbox,
  n: InmateEntity,
  attacker: PlayerState,
): void {
  const def = INMATE_BY_ID[n.defId];
  if (!n.grudges.includes(attacker.id)) n.grudges.push(attacker.id);
  attacker.groupRep[def.groupId] = Math.max(
    0,
    (attacker.groupRep[def.groupId] ?? C.reputation.start) -
      C.combat.ai.groupRepLoss,
  );
  if (n.combat === 'idle' || n.combat === 'retreating')
    threaten(world, n, attacker.id);
  for (const ally of world.inmates) {
    if (
      ally === n ||
      ally.downUntil > 0 ||
      ally.combat !== 'idle' ||
      ally.state === 'SLEEP'
    )
      continue;
    if (participants(world, attacker.id).length >= C.combat.ai.maxParticipants)
      break;
    const ad = INMATE_BY_ID[ally.defId];
    if (ad.groupId !== def.groupId) continue;
    if (
      dist(ally.x, ally.y, n.x, n.y) > C.combat.ai.allyJoinRange ||
      !hasLineOfSight(PRISON_MAP, ally.x, ally.y, n.x, n.y)
    )
      continue;
    if (nextRandom(world) < ad.aggression) {
      threaten(world, ally, attacker.id);
      emit(world, out, {
        type: 'inmate:joined',
        playerId: attacker.id,
        x: ally.x,
        y: ally.y,
        text: `👊 ${ad.name} lao vào giúp ${def.name}!`,
      });
    }
  }
}

function guardNear(world: WorldState, n: InmateEntity): boolean {
  return world.guards.some(
    (g) =>
      g.downUntil <= 0 &&
      dist(g.x, g.y, n.x, n.y) <= C.combat.ai.guardFleeRange,
  );
}

function retreat(
  world: WorldState,
  n: InmateEntity,
  from: { x: number; y: number },
): void {
  n.combat = 'retreating';
  n.retreatUntil = r2(world.time + C.combat.ai.retreatSeconds);
  // chạy về phía xa đối thủ nhất trong vài điểm ngẫu nhiên
  let best: Point | null = null;
  let bd = -1;
  for (const z of ['yard', 'hall', 'library', 'canteen']) {
    const pt = randomPointIn(world, z);
    if (!pt) continue;
    const d = dist(pt.x, pt.y, from.x, from.y);
    if (d > bd) {
      bd = d;
      best = pt;
    }
  }
  n.path = best ? (findPath(PRISON_MAP, passable, n, best) ?? []) : [];
}

/** Một bước AI chiến đấu. Trả về true nếu tù nhân đang bận đánh nhau (bỏ qua lịch sinh hoạt). */
function combatStep(
  world: WorldState,
  out: Outbox,
  n: InmateEntity,
  aiTick: boolean,
): boolean {
  const def = INMATE_BY_ID[n.defId];
  const ai = C.combat.ai;
  if (n.combat === 'retreating') {
    if (world.time >= n.retreatUntil) {
      n.combat = 'idle';
      n.fightWith = null;
      n.goalZone = null;
      return false;
    }
    n.state = n.path.length ? 'WALK' : 'IDLE';
    return true;
  }
  if (n.combat !== 'threatened' && n.combat !== 'fighting') return false;
  const foe = n.fightWith ? world.players[n.fightWith] : undefined;
  if (
    !foe ||
    foe.status !== 'ACTIVE' ||
    dist(n.x, n.y, foe.x, foe.y) > ai.giveUpRange
  ) {
    n.combat = 'idle';
    n.fightWith = null;
    n.goalZone = null;
    return false;
  }
  if (n.combat === 'threatened') {
    if (world.time < n.reactAt) {
      n.state = 'IDLE';
      n.facing = round4(Math.atan2(foe.y - n.y, foe.x - n.x));
      return true;
    }
    // quyết định: đánh trả hay bỏ chạy — hung hăng, máu còn, thù sẵn làm tăng khả năng đánh
    const hp = Math.min(1, n.health / C.combat.inmateHealth);
    const grudge = n.grudges.includes(foe.id) ? 0.15 : 0;
    const fight =
      hp > ai.fleeHealthPct &&
      nextRandom(world) <
        Math.min(0.97, def.aggression * (0.5 + hp / 2) + grudge);
    if (fight) {
      n.combat = 'fighting';
      emit(world, out, {
        type: 'inmate:fight',
        playerId: foe.id,
        x: n.x,
        y: n.y,
        text: `😠 ${def.name} đánh trả ${foe.name}!`,
      });
    } else {
      retreat(world, n, foe);
      emit(world, out, {
        type: 'inmate:flee',
        playerId: foe.id,
        x: n.x,
        y: n.y,
        text: `🏃 ${def.name} bỏ chạy`,
      });
      return true;
    }
  }
  // đang đánh: máu thấp hoặc cai ngục đến gần mà không đủ gan -> bỏ chạy
  if (aiTick) {
    const lowHp = n.health / C.combat.inmateHealth <= ai.fleeHealthPct;
    if (lowHp || (guardNear(world, n) && nextRandom(world) > def.courage)) {
      retreat(world, n, foe);
      emit(world, out, {
        type: 'inmate:flee',
        playerId: foe.id,
        x: n.x,
        y: n.y,
        text: `🏃 ${def.name} bỏ chạy${lowHp ? '' : ' vì cai ngục tới'}`,
      });
      return true;
    }
    n.path =
      dist(n.x, n.y, foe.x, foe.y) > ai.reach * 0.8
        ? (findPath(PRISON_MAP, passable, n, foe) ?? [])
        : [];
  }
  n.state = n.path.length ? 'WALK' : 'IDLE';
  n.goalZone = null;
  if (
    dist(n.x, n.y, foe.x, foe.y) <= ai.reach + 0.3 &&
    world.time >= n.attackReadyAt
  ) {
    n.attackReadyAt = r2(world.time + ai.cooldown);
    n.facing = round4(Math.atan2(foe.y - n.y, foe.x - n.x));
    emit(world, out, {
      type: 'combat:swing',
      playerId: n.id,
      x: n.x,
      y: n.y,
      data: { facing: n.facing, range: ai.reach },
    });
    // tù nhân có vũ khí đánh đau hơn
    const wdmg = n.gear.weapon
      ? (ITEM_DEFS[n.gear.weapon.itemId].weapon?.damage ?? 0) * 0.5
      : 0;
    // tù nhân đánh trước: người bị đánh được phòng vệ chính đáng trong cửa sổ selfDefenseWindowSeconds
    if (world.time - n.aggressorAt < COMBAT_RULES.selfDefenseWindowSeconds * 2)
      foe.attackedAt = world.time;
    damagePlayer(world, out, foe, ai.damage + wdmg, `bị ${def.name} đánh`);
  }
  return true;
}

/** Tỉnh dậy thấy mất đồ: hung hăng thì trả thù (ghi thù, lao vào khi gặp), hiền thì báo cai ngục */
function reactToRobbery(
  world: WorldState,
  out: Outbox,
  n: InmateEntity,
  def: InmateDef,
): void {
  const thief = n.robbedBy ? world.players[n.robbedBy] : undefined;
  n.robbedBy = null;
  if (!thief) return;
  if (!n.grudges.includes(thief.id)) n.grudges.push(thief.id);
  if (def.aggression >= 0.6) {
    n.provokedAt = -1e9; // sẵn sàng gây sự ngay khi gặp
    journal(
      world,
      out,
      'event',
      `${def.name} tỉnh dậy, thấy mất đồ và thề trả thù ${thief.name}`,
      thief.id,
    );
    emit(world, out, {
      type: 'inmate:revenge',
      playerId: thief.id,
      text: `😡 ${def.name} phát hiện mất đồ — sẽ trả thù ${thief.name}!`,
    });
  } else {
    thief.stats.personalHeat = Math.min(
      100,
      thief.stats.personalHeat + C.inmates.snitchHeat,
    );
    thief.reputation.guards = Math.max(0, thief.reputation.guards - 5);
    journal(
      world,
      out,
      'violation',
      `${def.name} báo cai ngục bị ${thief.name} lấy đồ`,
      thief.id,
    );
    emit(world, out, {
      type: 'inmate:snitched',
      playerId: thief.id,
      text: `🗣️ ${def.name} báo cai ngục bị ${thief.name} lấy đồ`,
    });
  }
}

/** Chủ xà lim thấy người lạ nằm giường mình: nhắc / đuổi trước (không đánh ngay); nhắc đủ số lần thì ghi thù */
function bedOwnerReact(
  world: WorldState,
  out: Outbox,
  n: InmateEntity,
  def: InmateDef,
  index: number,
): void {
  const S = C.sleep;
  if (!S.bedOwnerReaction || n.combat !== 'idle' || n.state === 'SLEEP') return;
  const m = /^cell_(\d+)$/.exec(homeZone(index));
  if (!m) return;
  const bedId = `bedrest_${m[1]}`;
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (!p || p.status !== 'ACTIVE' || p.bed !== bedId) continue;
    if (
      dist(n.x, n.y, p.x, p.y) > 4 ||
      !hasLineOfSight(PRISON_MAP, n.x, n.y, p.x, p.y)
    )
      continue;
    const tKey = `bedwarn:${n.id}`;
    if (
      world.time - (p.disguiseChecks[tKey] ?? -1e9) <
      S.ownerWarnCooldownSeconds
    )
      continue;
    p.disguiseChecks[tKey] = world.time;
    const count = (p.disguiseChecks[`${tKey}:n`] ?? 0) + 1;
    p.disguiseChecks[`${tKey}:n`] = count;
    n.facing = Math.atan2(p.y - n.y, p.x - n.x);
    if (count > S.ownerWarningsBeforeGrudge && !n.grudges.includes(p.id)) {
      n.grudges.push(p.id);
      emit(world, out, {
        type: 'inmate:revenge',
        playerId: p.id,
        x: n.x,
        y: n.y,
        text: `😡 ${def.name}: "Đã bảo rồi! Mày liệu hồn!"`,
      });
    } else
      emit(world, out, {
        type: 'inmate:comment',
        playerId: p.id,
        targetId: n.id,
        x: n.x,
        y: n.y,
        text: `💬 ${def.name}: "Giường của tao! Dậy ngay!"`,
      });
  }
}

/** Thấy người chơi chỉ mặc đồ lót ngoài chỗ cho phép: nhìn, bình luận một câu (không đánh vì lý do này) */
function commentUndressed(
  world: WorldState,
  out: Outbox,
  n: InmateEntity,
  def: InmateDef,
): void {
  if (n.combat !== 'idle' || n.state === 'SLEEP') return;
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (
      !p ||
      p.status !== 'ACTIVE' ||
      p.gear.outfit ||
      !undressedInPublic(p, zoneAt(PRISON_MAP, p.x, p.y))
    )
      continue;
    if (
      dist(n.x, n.y, p.x, p.y) > DISGUISE.inmateCommentRange ||
      !hasLineOfSight(PRISON_MAP, n.x, n.y, p.x, p.y)
    )
      continue;
    const key = `comment:${n.id}`;
    if (
      world.time - (p.disguiseChecks[key] ?? -1e9) <
      DISGUISE.inmateCommentCooldownSeconds
    )
      continue;
    p.disguiseChecks[key] = world.time;
    n.facing = Math.atan2(p.y - n.y, p.x - n.x);
    const line =
      DISGUISE.inmateComments[
        Math.floor(nextRandom(world) * DISGUISE.inmateComments.length) %
          DISGUISE.inmateComments.length
      ];
    p.stats.personalHeat = Math.min(
      100,
      p.stats.personalHeat + DISGUISE.undressedHeat,
    );
    emit(world, out, {
      type: 'inmate:comment',
      playerId: p.id,
      targetId: n.id,
      x: n.x,
      y: n.y,
      text: `💬 ${def.name}: "${line}"`,
    });
  }
}

/** Gặp người mặc áo tù có mã của mình -> nhận ra (nóng tính lao vào, hiền thì báo cai ngục) */
function recognizeOwnClothes(
  world: WorldState,
  out: Outbox,
  n: InmateEntity,
  def: InmateDef,
): void {
  if (n.combat !== 'idle' || n.state === 'SLEEP') return;
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (!p || p.status !== 'ACTIVE' || p.gear.outfit?.owner !== def.code)
      continue;
    if (
      dist(n.x, n.y, p.x, p.y) > DISGUISE.ownerRecognizeRange ||
      !hasLineOfSight(PRISON_MAP, n.x, n.y, p.x, p.y)
    )
      continue;
    const key = `ownclothes:${n.id}:${clockInfo(world.totalGameMinutes).day}`;
    if (p.violationKeys.includes(key)) continue;
    p.violationKeys.push(key);
    if (!n.grudges.includes(p.id)) n.grudges.push(p.id);
    emit(world, out, {
      type: 'inmate:recognized',
      playerId: p.id,
      x: n.x,
      y: n.y,
      text: `👕 ${def.name}: "Áo của tao mà!"`,
    });
    if (def.aggression >= 0.6) {
      threaten(world, n, p.id);
      n.reactAt = world.time;
      n.combat = 'fighting';
    } else {
      p.stats.personalHeat = Math.min(
        100,
        p.stats.personalHeat + C.inmates.snitchHeat,
      );
      journal(
        world,
        out,
        'violation',
        `${def.name} nhận ra ${p.name} mặc áo của mình và báo cai ngục`,
        p.id,
      );
    }
    return;
  }
}

/** Tù nhân hung hăng chủ động gây sự với người họ thù / người có uy tín xấu với nhóm họ */
function maybeProvoke(world: WorldState, out: Outbox, n: InmateEntity): void {
  const def = INMATE_BY_ID[n.defId];
  const ai = C.combat.ai;
  if (
    def.aggression < 0.7 ||
    n.combat !== 'idle' ||
    n.state === 'SLEEP' ||
    world.time - n.provokedAt < ai.proactiveCooldown
  )
    return;
  const target = world.playerOrder
    .map((id) => world.players[id])
    .find(
      (p) =>
        p &&
        p.status === 'ACTIVE' &&
        p.connected &&
        // người mặc đồ cai ngục được coi là cai ngục: tù nhân không chủ động gây sự
        !disguiseActive(world, p) &&
        (n.grudges.includes(p.id) ||
          (p.groupRep[def.groupId] ?? C.reputation.start) < ai.lowRepAttack) &&
        dist(n.x, n.y, p.x, p.y) <= ai.proactiveRange &&
        hasLineOfSight(PRISON_MAP, n.x, n.y, p.x, p.y),
    );
  if (!target || participants(world, target.id).length >= ai.maxParticipants)
    return;
  n.provokedAt = world.time;
  n.aggressorAt = world.time; // chủ động gây sự: là kẻ gây hấn
  threaten(world, n, target.id);
  n.reactAt = world.time; // chủ động: không chần chừ
  n.combat = 'fighting';
  emit(world, out, {
    type: 'inmate:provoke',
    playerId: target.id,
    x: n.x,
    y: n.y,
    text: `😡 ${def.name} lao vào gây sự với ${target.name}!`,
  });
}

/** Báo cai ngục khi bị tù nhân gây sự: uy tín với cai ngục tăng, với tù nhân giảm; kẻ gây sự bỏ chạy */
export function reportInmate(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  npcId: string,
): ActionResult {
  const n = world.inmates.find((x) => x.id === npcId);
  if (!n) return fail('NOT_FOUND', 'Không tìm thấy người này');
  if (
    n.fightWith !== p.id ||
    (n.combat !== 'fighting' && n.combat !== 'threatened')
  )
    return fail('INVALID_STATE', 'Người này không gây sự với bạn');
  const def = INMATE_BY_ID[n.defId];
  const ai = C.combat.ai;
  p.reputation.guards = Math.min(100, p.reputation.guards + ai.reportGuardRep);
  p.reputation.inmates = Math.max(0, p.reputation.inmates - ai.reportInmateRep);
  p.groupRep[def.groupId] = Math.max(
    0,
    (p.groupRep[def.groupId] ?? C.reputation.start) - ai.reportInmateRep,
  );
  if (!n.grudges.includes(p.id)) n.grudges.push(p.id);
  retreat(world, n, p);
  out.dirtyInventories.add(p.id);
  journal(
    world,
    out,
    'event',
    `${p.name} bỏ chạy và báo cai ngục việc ${def.name} gây sự`,
    p.id,
  );
  emit(world, out, {
    type: 'inmate:reported',
    playerId: p.id,
    x: n.x,
    y: n.y,
    text: `📣 ${p.name} báo cai ngục: ${def.name} gây sự`,
  });
  return { ok: true, data: { npcId } };
}

function randomPointIn(world: WorldState, goal: string): Point | null {
  const rects = goal.startsWith('@')
    ? [PRISON_MAP.areas[goal.slice(1)]].filter(Boolean)
    : (PRISON_MAP.zones.find((z) => z.id === goal)?.rects ?? []);
  if (!rects.length) return null;
  for (let tries = 0; tries < 12; tries++) {
    const [x0, y0, x1, y1] = pick(world, rects);
    const tx = x0 + Math.floor(nextRandom(world) * (x1 - x0 + 1));
    const ty = y0 + Math.floor(nextRandom(world) * (y1 - y0 + 1));
    if (passable(tx, ty)) return { x: tx + 0.5, y: ty + 0.5 };
  }
  return null;
}

export function updateInmates(
  world: WorldState,
  out: Outbox,
  dt: number,
  aiTick: boolean,
  onReport: (p: PlayerState) => void,
): void {
  const c = clockInfo(world.totalGameMinutes);
  world.inmates.forEach((n, i) => {
    const def = INMATE_BY_ID[n.defId];
    // ngất: nằm yên, rồi được đưa tới phòng y tế và tỉnh lại với nửa máu
    // bị lột bộ đồ: tỉnh dậy là kiếm bộ đồ tù khác mặc (người lấy đồ đã nằm trong danh sách thù)
    if (n.downUntil <= 0 && !n.gear.outfit)
      n.gear.outfit = {
        itemId: 'prisoner_outfit',
        quantity: 1,
        owner: def.code,
        condition: 100,
      };
    if (n.downUntil > 0) {
      if (world.time < n.downUntil) {
        n.state = 'DOWN';
        n.combat = 'knockedOut';
        return;
      }
      n.downUntil = 0;
      n.health = Math.round((def.knockoutHp ?? C.combat.inmateHealth) / 2);
      // tỉnh giữa lúc bị lục soát -> đánh luôn người đang lục
      const looters = interruptLooters(world, out, n.id);
      if (looters.length) {
        n.combat = 'idle';
        threaten(world, n, looters[0].id);
        n.reactAt = world.time;
        n.combat = 'fighting';
        emit(world, out, {
          type: 'inmate:fight',
          playerId: looters[0].id,
          x: n.x,
          y: n.y,
          text: `😠 ${def.name} tỉnh dậy khi đang bị lục túi!`,
        });
        return;
      }
      if (n.robbedBy) reactToRobbery(world, out, n, def);
      const spot = infirmarySpot();
      n.x = spot.x;
      n.y = spot.y + 0.6;
      n.path = [];
      n.state = 'IDLE';
      n.combat = 'idle';
      n.fightWith = null;
      n.goalZone = null;
    }
    if (combatStep(world, out, n, aiTick)) {
      // vẫn di chuyển theo đường đi bên dưới
    } else if (aiTick) {
      maybeProvoke(world, out, n);
      recognizeOwnClothes(world, out, n, def);
      commentUndressed(world, out, n, def);
      bedOwnerReact(world, out, n, def, i);
      const goal = goalFor(c.period, i);
      const sleeping = goal === homeZone(i) && c.period === 'LIGHTS_OUT';
      if (
        goal !== n.goalZone ||
        (!n.path.length && world.time >= n.waitUntil && !sleeping)
      ) {
        n.goalZone = goal;
        const target = sleeping
          ? PRISON_MAP.inmateSpawns[i % PRISON_MAP.inmateSpawns.length]
          : randomPointIn(world, goal);
        n.path = target
          ? (findPath(PRISON_MAP, passable, n, target) ?? [])
          : [];
        const [a, b] = C.inmates.wanderSeconds;
        n.waitUntil = world.time + a + nextRandom(world) * (b - a);
      }
      n.state = n.path.length ? 'WALK' : sleeping ? 'SLEEP' : 'IDLE';
      // mách lẻo
      if (def.personality === 'snitch' && n.state !== 'SLEEP') {
        const seen = world.playerOrder
          .map((id) => world.players[id])
          .find(
            (p) =>
              p &&
              p.status === 'ACTIVE' &&
              p.connected &&
              dist(n.x, n.y, p.x, p.y) <= C.inmates.snitchRange &&
              violationOf(world, p)?.severity === 'serious' &&
              hasLineOfSight(PRISON_MAP, n.x, n.y, p.x, p.y),
          );
        if (seen && (n.snitchTarget === seen.id || !n.snitchTarget)) {
          n.snitchTarget = seen.id;
          n.snitchTimer += 1 / C.net.aiRate;
          const key = `snitch:${c.day}:${c.hour}`;
          if (
            n.snitchTimer >= C.inmates.snitchDelay &&
            !seen.violationKeys.includes(key)
          ) {
            seen.violationKeys.push(key);
            seen.stats.personalHeat = Math.min(
              100,
              seen.stats.personalHeat + C.inmates.snitchHeat,
            );
            seen.reputation.inmates = Math.max(
              0,
              seen.reputation.inmates - C.reputation.snitchedLoss,
            );
            journal(
              world,
              out,
              'violation',
              `${def.name} mách lẻo cai ngục về ${seen.name}`,
              seen.id,
            );
            emit(world, out, {
              type: 'inmate:snitched',
              playerId: seen.id,
              x: n.x,
              y: n.y,
              text: `🗣️ ${def.name} mách lẻo về ${seen.name}!`,
            });
            onReport(seen);
            n.snitchTimer = 0;
            n.snitchTarget = null;
          }
        } else {
          n.snitchTimer = 0;
          n.snitchTarget = null;
        }
      }
    }
    while (n.path.length && dist(n.x, n.y, n.path[0].x, n.path[0].y) < 0.12)
      n.path.shift();
    const t = n.path[0];
    if (!t) return;
    const dx = t.x - n.x;
    const dy = t.y - n.y;
    const d = Math.hypot(dx, dy);
    const step = Math.min(
      d,
      C.inmates.speed *
        (n.combat === 'retreating' || n.combat === 'fighting' ? 1.5 : 1) *
        dt,
    );
    const pos = moveWithCollision(
      n.x,
      n.y,
      (dx / d) * step,
      (dy / d) * step,
      C.player.radius,
      inmateSolid,
    );
    n.x = pos.x;
    n.y = pos.y;
    n.facing = round4(Math.atan2(dy, dx));
  });
}

const fail = (
  code: Extract<ActionResult, { ok: false }>['code'],
  message: string,
): ActionResult => ({ ok: false, code, message });

function near(
  world: WorldState,
  p: PlayerState,
  npcId: string,
): InmateEntity | ActionResult {
  const n = world.inmates.find((x) => x.id === npcId);
  if (!n) return fail('NOT_FOUND', 'Không tìm thấy người này');
  if (dist(p.x, p.y, n.x, n.y) > C.interaction.npcRange)
    return fail('OUT_OF_RANGE', 'Đứng gần hơn để nói chuyện');
  if (n.state === 'SLEEP') return fail('INVALID_STATE', 'Đang ngủ');
  return n;
}

export function npcPrice(
  def: InmateDef,
  itemId: ItemId,
  p: Pick<PlayerState, 'skills' | 'reputation'>,
): number | null {
  const s = def.sells.find((x) => x.itemId === itemId);
  if (!s) return null;
  const greedy = def.personality === 'greedy' ? 1.2 : 1;
  return Math.max(
    1,
    Math.round(
      s.price *
        greedy *
        (1.25 - p.reputation.inmates / 200 - p.skills.social / 400),
    ),
  );
}

export function npcTalk(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  npcId: string,
): ActionResult {
  const n = near(world, p, npcId);
  if ('ok' in n) return n;
  const def = INMATE_BY_ID[n.defId];
  if (n.combat === 'fighting' || n.combat === 'threatened')
    return fail(
      'INVALID_STATE',
      `${def.name} đang muốn đánh nhau, không phải lúc nói chuyện`,
    );
  if (def.personality === 'hothead' && p.reputation.inmates < 40)
    return fail(
      'FORBIDDEN',
      `${def.name}: "Biến đi!" (danh tiếng với tù nhân quá thấp)`,
    );
  const tip = pick(world, def.tips);
  gainSkill(p, 'social', C.skills.socialGain / 2);
  journal(world, out, 'tip', `${def.name}: "${tip.text}"`, p.id);
  return { ok: true, data: { text: tip.text, from: def.name } };
}

export function npcBuy(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  npcId: string,
  itemId: ItemId,
): ActionResult {
  const n = near(world, p, npcId);
  if ('ok' in n) return n;
  const def = INMATE_BY_ID[n.defId];
  const price = npcPrice(def, itemId, p);
  if (price === null) return fail('NOT_FOUND', `${def.name} không bán món này`);
  if (ITEM_DEFS[itemId].contraband && disguiseActive(world, p))
    return fail(
      'FORBIDDEN',
      `${def.name}: "Tôi không có gì để bán cho cán bộ cả."`,
    );
  if (p.money < price) return fail('INSUFFICIENT_ITEMS', `Cần ${price}$`);
  if (!canCarry(p, itemId))
    return fail('OVER_CAPACITY', 'Túi chính đã đầy 6 ô');
  p.money -= price;
  giveItems(world, out, p, [
    {
      itemId,
      quantity: 1,
      ...(ITEM_DEFS[itemId].maxDurability
        ? { durability: ITEM_DEFS[itemId].maxDurability }
        : {}),
    },
  ]);
  p.reputation.inmates = Math.min(
    100,
    p.reputation.inmates + C.reputation.tradeInmateGain,
  );
  gainSkill(p, 'social', C.skills.socialGain);
  out.dirtyInventories.add(p.id);
  emit(world, out, {
    type: 'inmate:trade',
    playerId: p.id,
    audit: true,
    data: { npcId, itemId, price },
    text: `🤝 ${p.name} mua ${ITEM_DEFS[itemId].name} của ${def.name} (${price}$)`,
  });
  return { ok: true, data: { itemId, price } };
}
