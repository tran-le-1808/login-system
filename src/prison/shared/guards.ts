// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * AI cai ngục (server-authoritative). Quyết định ở aiRate (độc lập khung hình), di chuyển mỗi tick.
 * Trạng thái: PATROL (bình thường), SUSPICIOUS (chú ý), INVESTIGATE (điều tra), CHASE (truy đuổi/báo động),
 * SEARCH, RETURN. Có nhiệm vụ khám phòng theo lịch.
 */
import {
  DIFFICULTY_PRESETS,
  PRISON_CONFIG as C,
  ROLE_MODIFIERS,
} from './config';
import {
  angleDiff,
  dist,
  findPath,
  hasLineOfSight,
  moveWithCollision,
  round4,
} from './geometry';
import { resolveRoomSearch } from './hiding';
import { litAt, PRISON_MAP } from './map';
import { nextRandom } from './rng';
import { checkDisguise, disguiseActive, exposeDisguise } from './disguise';
import { ITEM_DEFS } from './items';
import { interruptLooters } from './loot';
import { zoneAt, zoneName } from './map';
import {
  cancelChannelsTargeting,
  cellLightsOn,
  clockInfo,
  emit,
  guardSolid,
  isNight,
  journal,
  knockOut,
  recordViolation,
  violationOf,
  type Violation,
} from './rules';
import { isCurfew, outsideOwnCell, raiseWanted } from './wanted';
import { blackoutActive } from './breakout';
import patrols from './data/patrols.json';
import COMBAT_RULES from './data/combat.json';
import { guardSpotDigTraces } from './digging';
import { toolNoise } from './tools';
import { INMATE_BY_ID } from './npc';
import type {
  Gear,
  GuardAIState,
  GuardEntity,
  InventoryItem,
  ItemId,
  Outbox,
  PlayerState,
  Point,
  WorldState,
} from './types';

const passable = (tx: number, ty: number) => !guardSolid(tx, ty);

const hm = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const PATROLS = {
  ...patrols,
  dayStartMinute: hm(patrols.dayStart),
  nightStartMinute: hm(patrols.nightStart),
};

/** Ca trực tại một phút trong ngày */
export function isNightShift(minuteOfDay: number): boolean {
  const a = PATROLS.nightStartMinute;
  const b = PATROLS.dayStartMinute;
  return a > b
    ? minuteOfDay >= a || minuteOfDay < b
    : minuteOfDay >= a && minuteOfDay < b;
}

/** Phút đổi ca (nếu đúng phút này) */
export function shiftChangeAt(minuteOfDay: number): 'day' | 'night' | null {
  if (minuteOfDay === PATROLS.dayStartMinute) return 'day';
  if (minuteOfDay === PATROLS.nightStartMinute) return 'night';
  return null;
}

function routeFor(index: number, night: boolean): string {
  const list = night ? PATROLS.night : PATROLS.day;
  const r = list[index] ?? 'office';
  return PRISON_MAP.guardRoutes[r]?.length
    ? r
    : (Object.keys(PRISON_MAP.guardRoutes)[0] ?? r);
}

/** Người thứ k cùng tuyến đi sau người trước vài điểm tuần tra (đi thành cặp -> để lại khoảng trống có thể khai thác) */
function startWaypoint(index: number, routeId: string, night: boolean): number {
  const list = night ? PATROLS.night : PATROLS.day;
  const k = list.slice(0, index).filter((r) => r === routeId).length;
  const len = PRISON_MAP.guardRoutes[routeId]?.length ?? 1;
  return (k * PATROLS.stagger) % len;
}

function baseGuard(
  id: string,
  i: number,
  routeId: string,
  x: number,
  y: number,
  wp: number,
): GuardEntity {
  const code = C.guard.codes[i % C.guard.codes.length];
  return {
    id,
    name: C.guard.names[i % C.guard.names.length],
    routeId,
    x,
    y,
    facing: 0,
    state: 'PATROL' as GuardAIState,
    waypointIndex: wp,
    path: [],
    targetPlayerId: null,
    lastKnown: null,
    stateTime: 0,
    suspicion: 0,
    lostSightTime: 0,
    stunnedUntil: 0,
    repathAt: 0,
    pauseUntil: 0,
    task: null,
    health: C.guard.knockoutHp,
    maxHealth: C.guard.knockoutHp,
    downUntil: 0,
    catchTimer: 0,
    code,
    ...guardKit(routeId, code),
    koDay: 0,
    koBy: null,
    reinforced: false,
    missingReported: false,
    shiftIndex: i,
    tower: false,
    targetInmateId: null,
  };
}

/** Ca ngày 6 cai ngục (3 tuyến × 2), ca đêm đổi tuyến theo patrols.json; mỗi tháp canh một cai ngục cố định */
export function createGuards(world: WorldState): GuardEntity[] {
  const night = isNightShift(clockInfo(world.totalGameMinutes).minuteOfDay);
  const count = Math.max(PATROLS.day.length, PATROLS.night.length);
  const list: GuardEntity[] = [];
  for (let i = 0; i < count; i++) {
    const routeId = routeFor(i, night);
    const route = PRISON_MAP.guardRoutes[routeId];
    const wp = startWaypoint(i, routeId, night);
    list.push(
      baseGuard(`guard_${i}`, i, routeId, route[wp].x, route[wp].y, wp),
    );
  }
  PRISON_MAP.towers.forEach((t, k) => {
    const g = baseGuard(`tower_${k}`, count + k, 'tower', t.x, t.y, 0);
    g.name = `${g.name} (${t.name})`;
    g.tower = true;
    g.facing = round4(t.angle);
    g.bag = [];
    list.push(g);
  });
  return list;
}

/** Đổi ca: cai ngục rảnh chuyển sang tuyến của ca mới (đang truy đuổi / bất tỉnh thì giữ nguyên tới khi xong) */
export function applyShift(
  world: WorldState,
  out: Outbox,
  night: boolean,
): void {
  for (const g of world.guards) {
    if (g.tower) continue;
    const routeId = routeFor(g.shiftIndex, night);
    if (routeId === g.routeId) continue;
    g.routeId = routeId;
    if (g.state === 'CHASE' || g.downUntil > 0) continue;
    g.task = null;
    setState(g, 'RETURN');
  }
  emit(world, out, {
    type: 'guard:shift',
    data: { night },
    text: night
      ? '🌙 Đổi ca: 4 cai ngục ca đêm tuần hành lang, kiểm tra từng xà lim'
      : '☀️ Đổi ca: cai ngục ca ngày nhận tuyến tuần tra',
  });
}

/** Túi đồ của cai ngục theo guards.json (dùi cui, áo + quần có mã, đồ theo tuyến) */
export function guardKit(
  routeId: string,
  code: string,
): { gear: Gear; bag: InventoryItem[] } {
  const inv = C.guard.inventory;
  const extra =
    (C.guard.routeInventory as Record<string, { bag: string[] }>)[routeId]
      ?.bag ?? inv.bag;
  const item = (id: string): InventoryItem => {
    const d = ITEM_DEFS[id as ItemId];
    return {
      itemId: id as ItemId,
      quantity: 1,
      ...(d.maxDurability ? { durability: d.maxDurability } : {}),
      ...(d.slotType === 'outfit' ? { owner: code, condition: 100 } : {}),
    };
  };
  return {
    gear: {
      weapon: inv.weapon ? item(inv.weapon) : null,
      outfit: inv.outfit ? item(inv.outfit) : null,
    },
    bag: extra.slice(0, 6).map(item),
  };
}

function setState(g: GuardEntity, s: GuardAIState): void {
  if (g.state === s) return;
  g.state = s;
  g.stateTime = 0;
  g.path = [];
  if (s !== 'CHASE' && s !== 'SUSPICIOUS') g.lostSightTime = 0;
}

export function guardVisionRange(
  world: WorldState,
  target?: { x: number; y: number },
  g?: GuardEntity,
): number {
  if (g?.tower) {
    // tháp canh nhìn xa (đèn pha ban đêm); mất điện -> chỉ còn mắt thường trong bóng tối
    const k = DIFFICULTY_PRESETS[world.difficulty].guardVision;
    return (
      (blackoutActive(world)
        ? PATROLS.tower.blackoutVisionRange
        : PATROLS.tower.visionRange) * k
    );
  }
  let r =
    C.guard.visionRange *
    DIFFICULTY_PRESETS[world.difficulty].guardVision *
    (world.prisonState === 'LOCKDOWN' ? 1.25 : 1) *
    (g?.reinforced ? C.guard.reinforcedVisionMultiplier : 1);
  const m = clockInfo(world.totalGameMinutes).minuteOfDay;
  if (
    target &&
    isNight(m) &&
    (blackoutActive(world) ||
      !litAt(PRISON_MAP, target.x, target.y, cellLightsOn(m)))
  )
    r *= C.guard.nightVisionMultiplier;
  return r;
}

export function canGuardSee(
  world: WorldState,
  g: GuardEntity,
  p: { x: number; y: number },
): boolean {
  const d = dist(g.x, g.y, p.x, p.y);
  if (d > guardVisionRange(world, p, g)) return false;
  if (d > 1.1) {
    const ang = Math.atan2(p.y - g.y, p.x - g.x);
    const fov = g.tower ? PATROLS.tower.fovDeg : C.guard.visionFovDeg;
    if (Math.abs(angleDiff(ang, g.facing)) > ((fov / 2) * Math.PI) / 180)
      return false;
  }
  return hasLineOfSight(PRISON_MAP, g.x, g.y, p.x, p.y);
}

function pathTo(g: GuardEntity, target: Point): void {
  g.path = findPath(PRISON_MAP, passable, g, target) ?? [];
}

function nearestWaypoint(g: GuardEntity): number {
  const route = PRISON_MAP.guardRoutes[g.routeId];
  let best = 0;
  let bd = Infinity;
  route.forEach((w, i) => {
    const d = dist(g.x, g.y, w.x, w.y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/** Gửi một cai ngục tới điều tra một điểm (đồ cấm trên đất, tiếng động…) */
export function sendGuardTo(g: GuardEntity, pos: Point): void {
  g.lastKnown = { x: pos.x, y: pos.y };
  setState(g, 'INVESTIGATE');
  pathTo(g, pos);
}

/** Báo động: các cai ngục gần đó (không bận truy đuổi) tới điều tra vị trí */
export function alertGuardsTo(
  world: WorldState,
  pos: Point,
  radius = C.guard.alarmCallRadius,
  exceptId?: string,
): void {
  for (const g of world.guards) {
    if (
      g.tower ||
      g.id === exceptId ||
      g.state === 'CHASE' ||
      g.downUntil > 0 ||
      world.time < g.stunnedUntil
    )
      continue;
    if (dist(g.x, g.y, pos.x, pos.y) > radius) continue;
    g.lastKnown = { x: pos.x, y: pos.y };
    setState(g, 'INVESTIGATE');
    pathTo(g, pos);
  }
}

/** Phát hiện cai ngục mất tích (nằm ngất): điều tra quanh đó, còi báo động nhỏ */
export function reportMissing(
  world: WorldState,
  out: Outbox,
  o: GuardEntity,
  by: string,
): void {
  o.missingReported = true;
  world.teamHeat = Math.min(100, world.teamHeat + C.guard.missingAlarmHeat);
  alertGuardsTo(world, o, C.guard.alarmCallRadius, o.id);
  journal(
    world,
    out,
    'event',
    `${by} phát hiện ${o.name} mất tích (nằm ngất ở ${zoneName(zoneAt(PRISON_MAP, o.x, o.y))})`,
  );
  emit(world, out, {
    type: 'game:guard-missing',
    x: o.x,
    y: o.y,
    data: { guardId: o.id },
    text: `🚨 ${by}: ${o.name} mất tích! Điều tra khu ${zoneName(zoneAt(PRISON_MAP, o.x, o.y))}`,
  });
}

/** Cai ngục bị tấn công: quay lại truy đuổi người đánh ngay */
export function provokeGuard(
  world: WorldState,
  out: Outbox,
  g: GuardEntity,
  attacker: PlayerState,
): void {
  if (g.downUntil > 0 || g.tower) return;
  g.targetPlayerId = attacker.id;
  g.lastKnown = { x: attacker.x, y: attacker.y };
  g.task = null;
  if (g.state !== 'CHASE') {
    setState(g, 'CHASE');
    g.repathAt = 0;
    emit(world, out, {
      type: 'guard:alert',
      playerId: attacker.id,
      x: g.x,
      y: g.y,
      text: `🚨 ${g.name} bị ${attacker.name} tấn công!`,
    });
  }
}

/** Phân công khám phòng cho cai ngục gần nhất đang rảnh */
export function assignRoomSearch(
  world: WorldState,
  cellIndex: number,
): GuardEntity | null {
  const target = PRISON_MAP.cells[cellIndex];
  const free = world.guards.filter(
    (g) =>
      !g.tower &&
      !g.task &&
      g.state !== 'CHASE' &&
      g.routeId !== 'office' &&
      g.downUntil <= 0,
  );
  if (!free.length) return null;
  free.sort(
    (a, b) =>
      dist(a.x, a.y, target.x, target.y) - dist(b.x, b.y, target.x, target.y),
  );
  const g = free[0];
  g.task = { kind: 'roomSearch', cellIndex, stage: 'going', elapsed: 0 };
  setState(g, 'RETURN');
  pathTo(g, target);
  return g;
}

interface Seen {
  p: PlayerState;
  v: Violation;
}

/** Tháp canh: quét nhìn qua lại; thấy vi phạm / người ngoài xà lim ban đêm -> báo động cho cai ngục dưới sân */
function towerThink(world: WorldState, out: Outbox, g: GuardEntity): void {
  const t = PRISON_MAP.towers[Number(g.id.slice('tower_'.length))];
  if (t)
    g.facing = round4(
      t.angle + t.sweep * Math.sin((2 * Math.PI * world.time) / t.period),
    );
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (
      !p ||
      p.status !== 'ACTIVE' ||
      !p.connected ||
      p.vehicle ||
      p.underground ||
      !canGuardSee(world, g, p)
    )
      continue;
    if (isCurfew(world) && outsideOwnCell(p) && !disguiseActive(world, p))
      raiseWanted(
        world,
        out,
        p,
        'tháp canh phát hiện ngoài xà lim sau 21:00',
        g.name,
        (q, r) => alertGuardsTo(world, q, r, g.id),
      );
    const disguised = disguiseActive(world, p);
    const crime = violationOf(world, p, disguised);
    // người mặc đồ cai ngục chỉ bị báo khi đang phạm tội
    const v = disguised
      ? crime
        ? { ...crime, severity: 'serious' as const }
        : null
      : crime;
    if (!v || v.severity !== 'serious') continue;
    if (disguised) exposeDisguise(world, out, p, g.name, v.reason);
    const key = `tower:${v.key}`;
    if (p.violationKeys.includes(key)) continue;
    recordViolation(world, out, p, { ...v, key }, g.name);
    emit(world, out, {
      type: 'guard:alert',
      playerId: p.id,
      x: g.x,
      y: g.y,
      text: `🗼 ${g.name} phát hiện ${p.name} ${v.reason} — báo động!`,
    });
    alertGuardsTo(world, p, C.guard.alarmCallRadius * 2, g.id);
  }
}

/**
 * Cai ngục thấy tù nhân GÂY HẤN (đánh trước) thì chuyển mục tiêu sang tù nhân đó: lao tới, khống chế (ngất),
 * phạt, kết thúc ẩu đả — không phạt người bị đánh. Trả về true nếu cai ngục đang bận việc này.
 */
function interveneInmate(
  world: WorldState,
  out: Outbox,
  g: GuardEntity,
): boolean {
  if (!COMBAT_RULES.guardInterveneOnAggression) return false;
  if (g.targetInmateId) {
    const n = world.inmates.find((x) => x.id === g.targetInmateId);
    if (!n || n.downUntil > 0) {
      g.targetInmateId = null;
      setState(g, 'RETURN');
      return false;
    }
    g.lastKnown = { x: n.x, y: n.y };
    if (dist(g.x, g.y, n.x, n.y) <= C.guard.catchRadius + 0.35) {
      const pun = COMBAT_RULES.aggressorPunishment;
      n.downUntil = world.time + pun.knockoutSeconds;
      n.combat = 'knockedOut';
      n.fightWith = null;
      n.path = [];
      n.aggressorAt = -1e9;
      g.targetInmateId = null;
      setState(g, 'RETURN');
      const name = INMATE_BY_ID[n.defId]?.name ?? 'Tù nhân';
      journal(world, out, 'event', `${g.name} khống chế ${name} vì gây hấn`);
      emit(world, out, {
        type: 'guard:subdue',
        targetId: n.id,
        x: n.x,
        y: n.y,
        text: `👮 ${g.name} khống chế ${name} — kết thúc ẩu đả`,
      });
      return true;
    }
    if (world.time >= g.repathAt) {
      g.repathAt = world.time + C.guard.repathSeconds;
      pathTo(g, n);
    }
    return true;
  }
  if (g.state === 'CHASE' || g.task) return false;
  const window = COMBAT_RULES.selfDefenseWindowSeconds * 2;
  const n = world.inmates.find(
    (x) =>
      x.downUntil <= 0 &&
      x.combat === 'fighting' &&
      world.time - x.aggressorAt < window &&
      canGuardSee(world, g, x),
  );
  if (!n) return false;
  g.targetInmateId = n.id;
  g.targetPlayerId = null;
  setState(g, 'CHASE');
  g.repathAt = 0;
  emit(world, out, {
    type: 'guard:intervene',
    targetId: n.id,
    x: g.x,
    y: g.y,
    text: `🚨 ${g.name}: "Dừng tay!" — lao vào xử ${INMATE_BY_ID[n.defId]?.name ?? 'tù nhân'}`,
  });
  return true;
}

function think(
  world: WorldState,
  out: Outbox,
  g: GuardEntity,
  dt: number,
): void {
  if (g.tower) return towerThink(world, out, g);
  const preset = DIFFICULTY_PRESETS[world.difficulty];
  const players = world.playerOrder
    .map((id) => world.players[id])
    .filter(
      (p) =>
        p &&
        p.status === 'ACTIVE' &&
        p.connected &&
        !p.vehicle &&
        !p.underground,
    );
  // lỗ tường / miệng hầm chưa che trong tầm 3 ô: phát hiện ngay
  guardSpotDigTraces(world, out, g);
  // cai ngục bênh người bị đánh: đang can thiệp / thấy tù nhân gây hấn -> xử tù nhân đó
  if (interveneInmate(world, out, g)) return;
  const visible = players.filter((p) => canGuardSee(world, g, p));
  const serious: Seen[] = [];
  const minor: Seen[] = [];
  for (const p of visible) {
    const d = dist(g.x, g.y, p.x, p.y);
    let v: Violation | null;
    const disguised = disguiseActive(world, p);
    if (disguised) {
      // mặc đồ cai ngục: danh tính không bao giờ bị nhận ra; chỉ bị thấy PHẠM TỘI mới mất cải trang và báo động
      const crime = violationOf(world, p, true);
      v =
        crime && checkDisguise(world, out, g, p, d, crime.reason) === 'exposed'
          ? { ...crime, severity: 'serious' }
          : null;
    } else v = violationOf(world, p);
    // ngoài xà lim sau 21:00 mà bị nhìn thấy -> truy nã (người giả dạng ở xa thì không bị nhận ra)
    if (isCurfew(world) && outsideOwnCell(p) && !disguiseActive(world, p))
      raiseWanted(
        world,
        out,
        p,
        'phát hiện ngoài xà lim sau 21:00',
        g.name,
        (q, r) => alertGuardsTo(world, q, r, g.id),
      );
    if (
      !v &&
      !disguised &&
      (p.stats.personalHeat >= C.heat.chaseThreshold || p.wantedLevel > 0)
    )
      v = { reason: 'đang bị truy nã', severity: 'serious', key: 'wanted' };
    if (!v) continue;
    if (v.severity === 'serious') serious.push({ p, v });
    else minor.push({ p, v });
  }
  // Vi phạm nhẹ: nhắc nhở / phạt; lần thứ 3 trong ngày thành nghiêm trọng
  for (const m of minor)
    if (recordViolation(world, out, m.p, m.v, g.name)) serious.push(m);
  for (const s of serious) {
    s.p.stats.personalHeat = Math.min(
      100,
      s.p.stats.personalHeat +
        C.heat.personalPerSecond * preset.heatMultiplier * dt,
    );
    world.teamHeat = Math.min(
      100,
      world.teamHeat + C.heat.teamPerSecond * preset.heatMultiplier * dt,
    );
  }
  g.stateTime += dt;

  // thấy đồng nghiệp nằm ngất -> phát hiện mất tích, điều tra khu đó, còi báo động nhỏ
  for (const o of world.guards)
    if (
      o !== g &&
      o.downUntil > 0 &&
      !o.missingReported &&
      canGuardSee(world, g, o)
    )
      reportMissing(world, out, o, g.name);

  if (g.state === 'CHASE') {
    const t = g.targetPlayerId ? world.players[g.targetPlayerId] : undefined;
    if (!t || t.status !== 'ACTIVE' || !t.connected) {
      setState(g, 'RETURN');
      g.targetPlayerId = null;
      return;
    }
    if (visible.includes(t)) {
      g.lastKnown = { x: t.x, y: t.y };
      g.lostSightTime = 0;
    } else {
      g.lostSightTime += dt;
      if (g.lostSightTime > C.guard.loseSightSeconds) {
        setState(g, 'SEARCH');
        g.targetPlayerId = null;
        if (g.lastKnown) pathTo(g, g.lastKnown);
        emit(world, out, { type: 'guard:lost', text: `${g.name} mất dấu` });
        return;
      }
    }
    if (world.time >= g.repathAt) {
      g.repathAt = world.time + C.guard.repathSeconds;
      pathTo(g, g.lastKnown ?? t);
    }
    return;
  }

  if (serious.length) {
    serious.sort(
      (a, b) => dist(g.x, g.y, a.p.x, a.p.y) - dist(g.x, g.y, b.p.x, b.p.y),
    );
    const { p, v } = serious[0];
    g.targetPlayerId = p.id;
    g.lastKnown = { x: p.x, y: p.y };
    g.suspicion += dt;
    g.facing = round4(Math.atan2(p.y - g.y, p.x - g.x));
    if (
      g.suspicion >= C.guard.suspicionToChase ||
      p.stats.personalHeat >= C.heat.chaseThreshold
    ) {
      setState(g, 'CHASE');
      g.repathAt = 0;
      recordViolation(world, out, p, v, g.name);
      emit(world, out, {
        type: 'guard:alert',
        playerId: p.id,
        x: g.x,
        y: g.y,
        text: `🚨 ${g.name} phát hiện ${p.name} ${v.reason}!`,
      });
      alertGuardsTo(world, p, C.guard.alarmCallRadius, g.id);
    } else if (g.state !== 'SUSPICIOUS') {
      setState(g, 'SUSPICIOUS');
      emit(world, out, {
        type: 'guard:suspicious',
        playerId: p.id,
        x: g.x,
        y: g.y,
        text: `❓ ${g.name} để ý ${p.name}`,
      });
    }
    return;
  }
  if (minor.length && g.state !== 'SUSPICIOUS') {
    g.facing = round4(Math.atan2(minor[0].p.y - g.y, minor[0].p.x - g.x));
  }
  g.suspicion = Math.max(0, g.suspicion - dt * 0.5);

  if (g.state === 'PATROL' || g.state === 'RETURN' || g.state === 'SEARCH') {
    const heard = players.find((p) => {
      const ch = p.channel?.kind;
      // xà beng khi cậy / phá: ồn — cai ngục trong bán kính nghe thấy
      const toolLoud =
        ch === 'openVent' || ch === 'breakIn'
          ? toolNoise(p.channel?.itemId)
          : 0;
      const noisy = p.sprinting
        ? C.guard.hearingRadius * ROLE_MODIFIERS[p.role].noise
        : ch === 'dig'
          ? C.tunnel.noiseRadius
          : toolLoud;
      return noisy > 0 && dist(g.x, g.y, p.x, p.y) <= noisy;
    });
    if (heard) {
      g.lastKnown = { x: heard.x, y: heard.y };
      setState(g, 'INVESTIGATE');
      g.facing = round4(Math.atan2(heard.y - g.y, heard.x - g.x));
      pathTo(g, g.lastKnown);
      return;
    }
  }

  // Nhiệm vụ khám phòng
  if (g.task && (g.state === 'PATROL' || g.state === 'RETURN')) {
    const target = PRISON_MAP.cells[g.task.cellIndex];
    if (g.task.stage === 'going') {
      if (dist(g.x, g.y, target.x, target.y) < 0.6) g.task.stage = 'searching';
      else if (!g.path.length) pathTo(g, target);
      return;
    }
    g.task.elapsed += dt;
    g.facing = round4(g.facing + 2.5 * dt);
    if (g.task.elapsed >= C.guard.roomSearchSeconds) {
      resolveRoomSearch(world, out, g.task.cellIndex, g, (q, r) =>
        alertGuardsTo(world, q, r, g.id),
      );
      g.task = null;
      setState(g, 'RETURN');
    }
    return;
  }

  switch (g.state) {
    case 'SUSPICIOUS':
      if (g.stateTime > 1.5) {
        setState(g, g.lastKnown ? 'INVESTIGATE' : 'RETURN');
        if (g.lastKnown) pathTo(g, g.lastKnown);
      }
      break;
    case 'INVESTIGATE':
      if (!g.path.length) setState(g, 'SEARCH');
      break;
    case 'SEARCH':
      g.facing = round4(g.facing + 2.2 * dt);
      if (g.stateTime > C.guard.searchSeconds) {
        setState(g, 'RETURN');
        g.lastKnown = null;
      }
      break;
    case 'RETURN': {
      const route = PRISON_MAP.guardRoutes[g.routeId];
      if (!g.path.length) {
        const wi = nearestWaypoint(g);
        if (dist(g.x, g.y, route[wi].x, route[wi].y) < 0.3) {
          g.waypointIndex = wi;
          setState(g, 'PATROL');
        } else pathTo(g, route[wi]);
      }
      break;
    }
    case 'PATROL': {
      if (!g.path.length && world.time >= g.pauseUntil) {
        // ngẫu nhiên nhỏ: đôi khi dừng lại vài giây ở điểm tuần tra
        if (
          g.stateTime > 0.5 &&
          nextRandom(world) < PATROLS.pauseChance &&
          g.pauseUntil < world.time - 1
        ) {
          const [a, b] = PATROLS.pauseSeconds;
          g.pauseUntil = world.time + a + nextRandom(world) * (b - a);
          return;
        }
        const route = PRISON_MAP.guardRoutes[g.routeId];
        g.waypointIndex = (g.waypointIndex + 1) % route.length;
        pathTo(g, route[g.waypointIndex]);
      }
      break;
    }
  }
}

function speedOf(world: WorldState, g: GuardEntity): number {
  if (g.tower) return 0;
  if (
    g.task?.stage === 'searching' ||
    (g.state === 'PATROL' && world.time < g.pauseUntil)
  )
    return 0;
  const base =
    g.state === 'CHASE'
      ? C.guard.chaseSpeed
      : g.state === 'SUSPICIOUS'
        ? 0
        : g.state === 'PATROL'
          ? C.guard.patrolSpeed
          : C.guard.investigateSpeed;
  return (
    base *
    DIFFICULTY_PRESETS[world.difficulty].guardSpeed *
    (world.prisonState === 'LOCKDOWN' ? 1.1 : 1)
  );
}

function moveGuard(world: WorldState, g: GuardEntity, dt: number): void {
  const speed = speedOf(world, g);
  if (speed <= 0) return;
  let target: Point | null = null;
  if (g.state === 'CHASE' && g.targetPlayerId) {
    const t = world.players[g.targetPlayerId];
    if (
      t &&
      dist(g.x, g.y, t.x, t.y) < 5 &&
      hasLineOfSight(PRISON_MAP, g.x, g.y, t.x, t.y)
    )
      target = t;
  }
  if (!target) {
    while (g.path.length && dist(g.x, g.y, g.path[0].x, g.path[0].y) < 0.12)
      g.path.shift();
    target = g.path[0] ?? null;
  }
  if (!target) return;
  const dx = target.x - g.x;
  const dy = target.y - g.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  const step = Math.min(d, speed * dt);
  const pos = moveWithCollision(
    g.x,
    g.y,
    (dx / d) * step,
    (dy / d) * step,
    C.guard.radius,
    guardSolid,
  );
  g.x = pos.x;
  g.y = pos.y;
  if (g.state !== 'SEARCH') g.facing = round4(Math.atan2(dy, dx));
}

function tryCatch(
  world: WorldState,
  out: Outbox,
  g: GuardEntity,
  dt: number,
): void {
  if (g.tower || g.state !== 'CHASE' || !g.targetPlayerId) {
    g.catchTimer = 0;
    return;
  }
  const t = world.players[g.targetPlayerId];
  if (
    !t ||
    t.status !== 'ACTIVE' ||
    world.time < t.invulnerableUntil ||
    dist(g.x, g.y, t.x, t.y) > C.guard.catchRadius
  ) {
    g.catchTimer = 0;
    return;
  }
  // cần ở trong tầm đủ lâu mới khống chế được: đủ thời gian để đánh trả
  g.catchTimer += dt;
  if (g.catchTimer < C.guard.catchSeconds) return;
  g.catchTimer = 0;
  if (ROLE_MODIFIERS[t.role].breakFree && world.time >= t.breakFreeReadyAt) {
    t.breakFreeReadyAt = world.time + C.fighter.breakFreeCooldownSeconds;
    t.invulnerableUntil = world.time + 1.5;
    g.stunnedUntil = world.time + C.guard.stunSeconds;
    setState(g, 'SEARCH');
    emit(world, out, {
      type: 'player:break-free',
      playerId: t.id,
      x: t.x,
      y: t.y,
      text: `💪 ${t.name} vùng thoát khỏi ${g.name}!`,
    });
    return;
  }
  cancelChannelsTargeting(world, t.id);
  knockOut(world, out, t, `bị ${g.name} khống chế`);
  for (const o of world.guards)
    if (o.targetPlayerId === t.id) {
      setState(o, 'RETURN');
      o.targetPlayerId = null;
    }
}

/** Cai ngục tỉnh lại: được tăng cường (máu, tầm nhìn), lấy đồ mới, báo cáo kẻ đánh mình; ai đang lục soát thì bị truy đuổi */
function wakeGuard(world: WorldState, out: Outbox, g: GuardEntity): void {
  g.downUntil = 0;
  g.reinforced = true;
  g.maxHealth = Math.round(C.guard.knockoutHp * C.guard.reinforcedHpMultiplier);
  g.health = g.maxHealth;
  const kit = guardKit(g.routeId, g.code);
  g.gear = kit.gear;
  g.bag = kit.bag;
  setState(g, 'RETURN');
  const looters = interruptLooters(world, out, g.id);
  const attacker = g.koBy ? world.players[g.koBy] : undefined;
  const culprit = looters[0] ?? attacker;
  if (attacker) {
    attacker.stats.personalHeat = Math.max(
      attacker.stats.personalHeat,
      C.heat.chaseThreshold,
    );
    journal(
      world,
      out,
      'violation',
      `${g.name} tỉnh lại và báo cáo bị ${attacker.name} đánh ngất`,
      attacker.id,
    );
  }
  emit(world, out, {
    type: 'guard:woke',
    x: g.x,
    y: g.y,
    text: `${g.name} đã tỉnh lại${attacker ? ` và báo cáo ${attacker.name}` : ''}`,
  });
  if (culprit && culprit.status === 'ACTIVE')
    provokeGuard(world, out, g, culprit);
  g.koBy = null;
}

export function updateGuards(
  world: WorldState,
  out: Outbox,
  dt: number,
  aiTick: boolean,
): void {
  const aiDt = 1 / C.net.aiRate;
  for (const g of world.guards) {
    if (g.downUntil > 0) {
      if (world.time < g.downUntil) continue;
      wakeGuard(world, out, g);
    }
    if (world.time < g.stunnedUntil) continue;
    if (aiTick) think(world, out, g, aiDt);
    moveGuard(world, g, dt);
    tryCatch(world, out, g, dt);
  }
}
