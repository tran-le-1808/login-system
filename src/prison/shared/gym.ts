// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Phòng gym: máy đẩy tạ (Sức mạnh) & máy chạy bộ (Nhanh nhẹn).
 * - Số máy mỗi loại = số tù nhân (tự cập nhật).
 * - Bấm xen kẽ trái–phải: mỗi cặp đúng = 1 nhịp; đủ nhịp = 1 lần (rep) = +1 điểm (tối đa 50).
 * - Bấm cùng bên 2 lần: mất đà (thanh đà về 0, nhịp của lần đang tập về 0 — Thể lực cao giữ lại một phần).
 * - Mở cả ngày (gym.json → alwaysOpen); bị đánh / bấm Nghỉ: lần dở không được tính.
 * - Tù nhân NPC dùng máy riêng của mình; trùng máy với người chơi thì xin (hiền) hoặc đuổi (hung hăng); hàng chờ 1 người.
 */
import GYM_CONF from './data/gym.json';
import { PRISON_CONFIG as C } from './config';
import {
  agilitySpeed,
  beatsNeeded,
  GYM,
  GYM_KINDS,
  gymOpenAt,
  gymStatOf,
  leaveMachine,
  machineCount,
  machineExists,
  machineId,
  parseMachineId,
  setStrength,
  STAT_MAX,
} from './gymStats';
import { PRISON_MAP, zoneAt } from './map';
import { INMATE_BY_ID, threaten } from './npc';
import { clockInfo, emit, gainSkill, journal } from './rules';
import { hasStamina, NO_STAMINA, spendStamina, STAMINA } from './stamina';
import type {
  ActionResult,
  GymKind,
  InmateEntity,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

const fail = (
  code: Extract<ActionResult, { ok: false }>['code'],
  message: string,
): ActionResult => ({ ok: false, code, message });
const OK: ActionResult = { ok: true };
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

const inGym = (e: { x: number; y: number }) =>
  zoneAt(PRISON_MAP, e.x, e.y) === 'gym';
const isOpen = (world: WorldState) =>
  gymOpenAt(clockInfo(world.totalGameMinutes).minuteOfDay);

function occupantName(world: WorldState, id: string): string {
  return (
    world.players[id]?.name ??
    INMATE_BY_ID[world.inmates.find((n) => n.id === id)?.defId ?? '']?.name ??
    id
  );
}

/** Chiếm máy cho người chơi và mở lượt tập mới */
function seat(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  mid: string,
): void {
  const m = parseMachineId(mid)!;
  world.gym.occupants[mid] = p.id;
  if (p.gymQueued && world.gym.queue[p.gymQueued] === p.id)
    delete world.gym.queue[p.gymQueued];
  p.gymQueued = null;
  p.channel = null;
  p.gym = {
    machineId: mid,
    kind: m.kind,
    beats: 0,
    half: false,
    lastSide: -1,
    momentum: 0,
    reps: 0,
  };
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'gym:start',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { machineId: mid, kind: m.kind },
    text: `🏋️ ${p.name} lên ${GYM.machines[m.kind].name} số ${m.index + 1}`,
  });
}

export function gymStart(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  mid: string,
): ActionResult {
  if (!isOpen(world)) return fail('INVALID_STATE', 'Phòng gym đang đóng');
  if (!machineExists(world, mid)) return fail('NOT_FOUND', 'Không có máy này');
  if (!inGym(p)) return fail('OUT_OF_RANGE', 'Hãy vào phòng gym trước');
  // bấm lại đúng máy đang tập = thoát
  if (p.gym?.machineId === mid) return gymStop(world, out, p);
  if (p.gym)
    return fail('CONFLICT', 'Bạn đang tập trên máy khác — bấm Nghỉ trước');
  if (p.channel && p.channel.kind !== 'sleep')
    return fail('CONFLICT', 'Bạn đang làm việc khác');
  if (!hasStamina(p, STAMINA.gymStaminaCost))
    return fail('INVALID_STATE', NO_STAMINA);
  const occ = world.gym.occupants[mid];
  if (!occ) {
    seat(world, out, p, mid);
    return { ok: true, data: { machineId: mid } };
  }
  // máy có người: không vào được (gym.json queueEnabled = false); bật lại thì vào hàng chờ 1 người
  if (!GYM_CONF.queueEnabled) return fail('CONFLICT', 'Máy đang bận');
  if (world.gym.queue[mid] && world.gym.queue[mid] !== p.id)
    return fail(
      'CONFLICT',
      `Máy đang có ${occupantName(world, occ)} dùng và đã có người chờ`,
    );
  if (p.gymQueued && p.gymQueued !== mid) delete world.gym.queue[p.gymQueued];
  world.gym.queue[mid] = p.id;
  p.gymQueued = mid;
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  return { ok: true, data: { queued: true, machineId: mid } };
}

export function gymStop(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  reason = 'Nghỉ',
): ActionResult {
  if (p.gymQueued) {
    if (world.gym.queue[p.gymQueued] === p.id)
      delete world.gym.queue[p.gymQueued];
    p.gymQueued = null;
    out.dirtyInventories.add(p.id);
  }
  if (!p.gym) return OK;
  const s = p.gym;
  const partial = s.beats > 0 || s.half;
  // tập dở: tính thể lực theo tỉ lệ nhịp đã làm
  if (partial)
    spendStamina(
      p,
      (STAMINA.gymStaminaCost * (s.beats + (s.half ? 0.5 : 0))) /
        Math.max(1, beatsNeeded(p, s.kind, C.needs.slowThreshold)),
    );
  leaveMachine(world, p);
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'gym:stop',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { reps: s.reps },
    text: `🧘 ${p.name} rời máy (${reason})${s.reps ? ` — ${s.reps} lần` : ''}${partial ? ', lần dở không tính' : ''}`,
  });
  return { ok: true, data: { reps: s.reps } };
}

function completeRep(world: WorldState, out: Outbox, p: PlayerState): void {
  const s = p.gym!;
  s.beats = 0;
  s.half = false;
  s.reps += 1;
  const stat = gymStatOf(s.kind);
  const max = STAT_MAX[stat];
  const before = p.stats[stat];
  if (before < max) {
    if (stat === 'strength') setStrength(p, before + 1);
    else p.stats.agility = Math.min(max, before + 1);
  }
  const after = p.stats[stat];
  spendStamina(p, STAMINA.gymStaminaCost);
  gainSkill(p, 'fitness', GYM.fitnessGainPerRep);
  const c = clockInfo(world.totalGameMinutes);
  p.gymDay = c.day;
  const name = GYM.machines[s.kind].statName;
  const effect =
    stat === 'strength'
      ? `HP tối đa ${p.stats.maxHealth}`
      : `tốc độ ${agilitySpeed(after).toFixed(2)}×`;
  journal(
    world,
    out,
    'event',
    `Tập ${s.kind === 'pressBench' ? 'đẩy tạ' : 'chạy bộ'} — ${name} ${after}/${max}`,
    p.id,
  );
  emit(world, out, {
    type: 'gym:rep',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { stat, value: after, gained: after > before ? 1 : 0 },
    text: `${after > before ? `💪 +1 ${name} (${effect})` : `${name} đã tối đa ${max}/${max}`} · −${STAMINA.gymStaminaCost} Thể lực`,
  });
  if (after > before && GYM.milestones.includes(after))
    emit(world, out, {
      type: 'gym:milestone',
      playerId: p.id,
      x: p.x,
      y: p.y,
      data: { stat, value: after },
      text: `✨ ${stat === 'strength' ? 'Mạnh hơn!' : 'Nhanh hơn!'} ${name} ${after}`,
    });
  // dưới 4 thể lực: không cho bắt đầu lần mới
  if (!hasStamina(p, STAMINA.gymStaminaCost))
    gymStop(world, out, p, NO_STAMINA.toLowerCase());
}

/** Một lần bấm trái (0) / phải (1) */
export function gymPress(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  side: 0 | 1,
): ActionResult {
  const s = p.gym;
  if (!s) return fail('INVALID_STATE', 'Bạn không ở trên máy tập');
  if (side !== 0 && side !== 1)
    return fail('INVALID_PAYLOAD', 'Chỉ có trái hoặc phải');
  out.dirtyInventories.add(p.id);
  if (s.lastSide === side) {
    // sai nhịp: mất đà, Thể lực cao giữ lại một phần nhịp
    const keep =
      (p.skills.fitness / 100) * GYM.momentum.mistakeKeepPerFitness100;
    s.beats = Math.floor(s.beats * keep);
    s.half = false;
    s.momentum = 0;
    s.lastSide = -1;
    emit(world, out, {
      type: 'gym:miss',
      playerId: p.id,
      data: { beats: s.beats },
    });
    return { ok: true, data: { miss: true, beats: s.beats } };
  }
  s.lastSide = side;
  s.momentum = r4(
    Math.min(
      1,
      s.momentum +
        GYM.momentum.gainPerPress *
          (1 + (p.skills.fitness / 100) * GYM.momentum.fitnessGainBonusPer100),
    ),
  );
  if (!s.half) s.half = true;
  else {
    s.half = false;
    s.beats += 1;
  }
  const need = beatsNeeded(p, s.kind, C.needs.slowThreshold);
  if (s.beats >= need) {
    completeRep(world, out, p);
    return { ok: true, data: { rep: true } };
  }
  return { ok: true, data: { beats: s.beats, need } };
}

/** Trả lời tù nhân xin / đòi máy: nhường hoặc từ chối */
export function gymAnswer(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  give: boolean,
): ActionResult {
  const r = world.gym.requests[p.id];
  if (!r) return fail('INVALID_STATE', 'Không có ai đang xin máy của bạn');
  delete world.gym.requests[p.id];
  const n = world.inmates.find((x) => x.id === r.npcId);
  const def = n ? INMATE_BY_ID[n.defId] : undefined;
  out.dirtyInventories.add(p.id);
  if (!n || !def) return OK;
  if (give) {
    gymStop(world, out, p, `nhường máy cho ${def.name}`);
    if (!world.gym.occupants[r.machineId]) seatNpc(world, n, r.machineId);
    journal(
      world,
      out,
      'event',
      `${p.name} nhường máy tập cho ${def.name}`,
      p.id,
    );
    return { ok: true, data: { yielded: true } };
  }
  if (r.aggressive) {
    threaten(world, n, p.id);
    emit(world, out, {
      type: 'inmate:provoke',
      playerId: p.id,
      x: n.x,
      y: n.y,
      text: `😠 ${def.name} không chịu: "Không nhường thì ăn đòn!"`,
    });
  } else {
    p.reputation.inmates = Math.max(
      0,
      p.reputation.inmates - GYM.contest.refuseReputationLoss,
    );
    if (!world.gym.queue[r.machineId]) world.gym.queue[r.machineId] = n.id;
    emit(world, out, {
      type: 'gym:refused',
      playerId: p.id,
      x: n.x,
      y: n.y,
      text: `😒 ${def.name} phật ý, đứng chờ máy (uy tín tù nhân −${GYM.contest.refuseReputationLoss})`,
    });
  }
  return { ok: true, data: { yielded: false } };
}

function seatNpc(world: WorldState, n: InmateEntity, mid: string): void {
  world.gym.occupants[mid] = n.id;
  n.gymMachine = mid;
  n.path = [];
  n.waitUntil = world.time + 1;
  const [a, b] = GYM.npc.repSeconds;
  n.gymRepAt = world.time + a + (b - a) / 2;
  for (const [k, v] of Object.entries(world.gym.queue))
    if (v === n.id) delete world.gym.queue[k];
}

function releaseNpc(world: WorldState, n: InmateEntity): void {
  if (n.gymMachine && world.gym.occupants[n.gymMachine] === n.id)
    delete world.gym.occupants[n.gymMachine];
  n.gymMachine = null;
}

/** Máy trống gần người chơi nhất (bấm E ở máy tập = tập luôn máy đó) */
export function nearestFreeMachine(
  world: WorldState,
  p: { x: number; y: number },
): string | null {
  let best: string | null = null;
  let bd = Infinity;
  const per = machineCount(world, 'pressBench');
  for (const kind of GYM_KINDS)
    for (let i = 0; i < machineCount(world, kind); i++) {
      const id = machineId(kind, i);
      if (world.gym.occupants[id]) continue;
      const s = gymMachineSpot(kind, i, per);
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
  return best;
}

function firstFree(world: WorldState): string | null {
  for (const kind of GYM_KINDS)
    for (let i = 0; i < machineCount(world, kind); i++)
      if (!world.gym.occupants[machineId(kind, i)]) return machineId(kind, i);
  return null;
}

/** Tù nhân NPC vào gym: dùng máy riêng (theo thứ tự tù nhân); máy riêng có người chơi thì xin / đòi (mỗi ngày 1 lần) */
function npcWantsMachine(
  world: WorldState,
  out: Outbox,
  n: InmateEntity,
  index: number,
): void {
  const c = clockInfo(world.totalGameMinutes);
  const kind: GymKind = GYM_KINDS[(c.day + index) % GYM_KINDS.length];
  const own = machineId(kind, index);
  const occ = world.gym.occupants[own];
  if (!occ) return seatNpc(world, n, own);
  if (Object.values(world.gym.queue).includes(n.id)) return; // đang chờ
  const p = world.players[occ];
  if (p && n.gymAskedDay !== c.day && !world.gym.requests[p.id]) {
    n.gymAskedDay = c.day;
    const def = INMATE_BY_ID[n.defId];
    const aggressive =
      (def?.aggression ?? 0) >= GYM.contest.aggressiveThreshold;
    world.gym.requests[p.id] = {
      npcId: n.id,
      machineId: own,
      aggressive,
      until: world.time + GYM.contest.requestSeconds,
    };
    out.dirtyInventories.add(p.id);
    emit(world, out, {
      type: 'gym:request',
      playerId: p.id,
      x: n.x,
      y: n.y,
      text: aggressive
        ? `😠 ${def?.name}: "Máy của tao! Xuống ngay!"`
        : `🙋 ${def?.name} hỏi xin dùng ${GYM.machines[kind].name} bạn đang tập`,
    });
    return;
  }
  if (world.gym.requests[occ]?.npcId === n.id) return; // đang chờ trả lời
  const free = firstFree(world);
  if (free) seatNpc(world, n, free);
  else if (!world.gym.queue[own]) world.gym.queue[own] = n.id;
}

/** Mỗi tick: đóng cửa, mất đà, máy bị dỡ khi bớt tù nhân, NPC, hàng chờ, hết hạn trả lời */
export function updateGym(world: WorldState, out: Outbox, dt: number): void {
  const before = JSON.stringify([world.gym.occupants, world.gym.queue]);
  step(world, out, dt);
  if (JSON.stringify([world.gym.occupants, world.gym.queue]) !== before)
    out.dirtyMeta = true;
}

function step(world: WorldState, out: Outbox, dt: number): void {
  const open = isOpen(world);
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (!p) continue;
    if (p.gym) {
      if (!open) gymStop(world, out, p, 'hết giờ gym');
      else if (p.status !== 'ACTIVE') gymStop(world, out, p, 'bị gián đoạn');
      else if (!machineExists(world, p.gym.machineId))
        gymStop(world, out, p, 'máy bị dỡ bớt');
      else if (!inGym(p)) gymStop(world, out, p, 'rời phòng gym');
      else if (p.gym.momentum > 0) {
        p.gym.momentum = r4(
          Math.max(0, p.gym.momentum - GYM.momentum.decayPerSecond * dt),
        );
        out.dirtyInventories.add(p.id);
      }
    }
    if (
      p.gymQueued &&
      (!open ||
        p.status !== 'ACTIVE' ||
        !inGym(p) ||
        !machineExists(world, p.gymQueued))
    )
      gymStop(world, out, p, 'bỏ hàng chờ');
  }
  world.inmates.forEach((n, i) => {
    if (n.gymMachine) {
      if (
        !open ||
        n.downUntil > 0 ||
        n.combat !== 'idle' ||
        n.goalZone !== 'gym' ||
        !machineExists(world, n.gymMachine)
      )
        releaseNpc(world, n);
      else {
        n.path = [];
        n.waitUntil = world.time + 1;
      }
    } else if (
      open &&
      n.downUntil <= 0 &&
      n.combat === 'idle' &&
      n.goalZone === 'gym' &&
      inGym(n)
    )
      npcWantsMachine(world, out, n, i);
  });
  // dọn chỗ của người/máy không còn
  for (const [mid, who] of Object.entries(world.gym.occupants)) {
    const p = world.players[who];
    const n = world.inmates.find((x) => x.id === who);
    if (
      (p && p.gym?.machineId !== mid) ||
      (!p && n?.gymMachine !== mid) ||
      (!p && !n)
    )
      delete world.gym.occupants[mid];
  }
  // máy trống -> người đang chờ lên
  for (const [mid, who] of Object.entries(world.gym.queue)) {
    if (world.gym.occupants[mid]) continue;
    delete world.gym.queue[mid];
    const p = world.players[who];
    if (p) {
      p.gymQueued = null;
      if (
        open &&
        p.status === 'ACTIVE' &&
        inGym(p) &&
        !p.gym &&
        machineExists(world, mid)
      )
        seat(world, out, p, mid);
      else out.dirtyInventories.add(p.id);
      continue;
    }
    const n = world.inmates.find((x) => x.id === who);
    if (
      n &&
      open &&
      !n.gymMachine &&
      n.downUntil <= 0 &&
      n.combat === 'idle' &&
      inGym(n) &&
      machineExists(world, mid)
    )
      seatNpc(world, n, mid);
  }
  // hết giờ trả lời: tù nhân đứng chờ máy
  for (const [pid, r] of Object.entries(world.gym.requests)) {
    const p = world.players[pid];
    if (!p || !p.gym || p.gym.machineId !== r.machineId) {
      delete world.gym.requests[pid];
      continue;
    }
    if (world.time < r.until) continue;
    delete world.gym.requests[pid];
    out.dirtyInventories.add(pid);
    const n = world.inmates.find((x) => x.id === r.npcId);
    if (!n) continue;
    if (r.aggressive) {
      threaten(world, n, pid);
      n.aggressorAt = world.time;
    } else if (!world.gym.queue[r.machineId])
      world.gym.queue[r.machineId] = n.id;
  }
}

/** Danh sách máy cho giao diện */
export function gymMachinesView(
  world: WorldState,
): {
  id: string;
  kind: GymKind;
  index: number;
  occupant: string | null;
  occupantId: string | null;
  queued: string | null;
}[] {
  const list: {
    id: string;
    kind: GymKind;
    index: number;
    occupant: string | null;
    occupantId: string | null;
    queued: string | null;
  }[] = [];
  for (const kind of GYM_KINDS)
    for (let i = 0; i < machineCount(world, kind); i++) {
      const id = machineId(kind, i);
      const occ = world.gym.occupants[id] ?? null;
      const q = world.gym.queue[id] ?? null;
      list.push({
        id,
        kind,
        index: i,
        occupant: occ ? occupantName(world, occ) : null,
        occupantId: occ,
        queued: q ? occupantName(world, q) : null,
      });
    }
  return list;
}

/** Vị trí vẽ máy trong khu gym (trang trí, không chặn đường): đẩy tạ ở mép trên, chạy bộ ở mép dưới */
export function gymMachineSpot(
  kind: GymKind,
  index: number,
  perKind: number,
): { x: number; y: number } {
  const zone = PRISON_MAP.zones.find((z) => z.id === 'gym')?.rects[0] ?? [
    15, 26, 21, 30,
  ];
  const [x0, y0, x1, y1] = zone;
  const cols = Math.max(1, Math.ceil(perKind / 2));
  const width = x1 + 1 - x0 - 0.6;
  const col = index % cols;
  const row = Math.floor(index / cols);
  const x = x0 + 0.3 + (width / cols) * (col + 0.5);
  const y =
    kind === 'pressBench'
      ? y0 + 0.3 + row * 0.45
      : y1 + 1 - 0.3 - (1 - row) * 0.45;
  return { x, y };
}
