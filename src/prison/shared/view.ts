// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Trạng thái gửi cho client: phần công khai (cả đội), phần riêng (từng người), snapshot delta. */
import { outfitTypeOf, type OutfitType } from './gear';
import { PRISON_CONFIG as C } from './config';
import { escapePoints, type EscapePointInfo } from './escape';
import { INMATE_BY_ID } from './npc';
import { equippedWeaponItem } from './items';
import { doorsLocked } from './wanted';
import { DISGUISE, disguiseActive } from './disguise';
import { findLootTarget } from './loot';
import { shelfCooldownLeft } from './library';
import { CONFISCATION, entriesOf, reclaimPrice } from './confiscation';
import { gymMachinesView } from './gym';
import {
  beatsNeeded,
  gymOpenAt,
  gymStatOf,
  isWeak,
  machineCount,
  parseMachineId,
  STAT_MAX,
  treadmillKmh,
} from './gymStats';
import {
  clockInfo,
  maxSlots,
  solitaryRemaining,
  type ClockInfo,
} from './rules';
import type {
  GymKind,
  ChannelKind,
  Difficulty,
  EscapeSessionState,
  FloorItem,
  GameMode,
  BedState,
  Gear,
  PlayerState,
  GuardAIState,
  InmateState,
  InventoryItem,
  ItemId,
  JournalEntry,
  Outcome,
  PlayerSkills,
  PlayerStats,
  PlayerStatus,
  PrisonState,
  QuestProgress,
  Role,
  Trade,
  TunnelState,
  WorldState,
} from './types';

export interface PlayerPublic {
  id: string;
  name: string;
  role: Role;
  colorIndex: number;
  cellIndex: number;
  x: number;
  y: number;
  facing: number;
  status: PlayerStatus;
  connected: boolean;
  health: number;
  maxHealth: number;
  energy: number;
  maxEnergy: number;
  hunger: number;
  fitness: number;
  /** Nhanh nhẹn (máy chạy bộ) — client cần để dự đoán tốc độ */
  agility: number;
  /** Đang tập trên máy nào (để vẽ) */
  gym: GymKind | null;
  heat: number;
  level: number;
  lastSeq: number;
  moving: boolean;
  sprinting: boolean;
  invulnerable: boolean;
  disguised: boolean;
  /** Đang nằm trốn trong xe (id xe) */
  vehicle: string | null;
  /** Bộ đồ đang mặc (để vẽ trang phục): prisoner / guard / null = đồ lót */
  outfit: OutfitType;
  /** Đang nằm trên giường nào (ngủ / vừa tỉnh ở phòng y tế) — vẽ nằm theo chiều giường */
  bed: string | null;
  /** Đang ở dưới hầm (người khác không thấy) */
  underground: boolean;
  weaponDrawn: boolean;
  /** Mức truy nã 0–3 sao */
  wanted: number;
  /** Vũ khí đang cầm (còn trong túi) và độ bền; swinging = vừa tung đòn */
  weapon: ItemId | null;
  weaponDurability: number | null;
  swinging: boolean;
  escapeReady: boolean;
  channel: { kind: ChannelKind; targetId: string; progress: number } | null;
  knockoutRemaining: number | null;
  solitaryRemaining: number | null;
}

export interface InmateCombatInfo {
  combat: import('./types').InmateCombatState;
  fightWith: string | null;
}

export interface GuardPublic {
  id: string;
  name: string;
  x: number;
  y: number;
  facing: number;
  state: GuardAIState;
  targetPlayerId: string | null;
  task: 'roomSearch' | null;
  health: number;
  maxHealth: number;
  down: boolean;
  outfit: OutfitType;
}

export interface InmatePublic {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  facing: number;
  state: InmateState;
  health: number;
  maxHealth: number;
  down: boolean;
  combat: import('./types').InmateCombatState;
  fightWith: string | null;
}

export interface WorldMeta {
  mode: GameMode;
  difficulty: Difficulty;
  dayLimit: number | null;
  prisonState: PrisonState;
  lockdownRemaining: number | null;
  routes: { ventOpen: boolean; fenceGaps: string[] };
  /** Mất điện còn bao lâu (giây) — camera & đèn tắt */
  blackoutRemaining: number;
  /** Lỗ tường, miệng hầm, ô hầm, vật che / trang trí */
  dig: import('./types').DigState;
  tunnels: Record<string, TunnelState>;
  hideSpots: Record<string, InventoryItem[]>;
  market: Record<string, number>;
  camerasOffRemaining: number;
  escape: EscapeSessionState;
  escapePoints: EscapePointInfo[];
  requiredPlayerIds: string[];
  outcome: Outcome | null;
  intelRemaining: number;
  /** Toàn bộ đồ trong từng tủ / thùng (modal lưới ô) */
  containers: Record<string, InventoryItem[]>;
  beds: Record<string, BedState>;
  /** Cửa khu đang bị phong toả (có người bị truy nã từ 2 sao) */
  doorsLocked: boolean;
  /** Chơi một mình: bị bắt thì qua ngày mới thay cho biệt giam */
  soloMode: boolean;
  /** Phòng gym: đang mở không, số máy mỗi loại (= số tù nhân), ai đang dùng / chờ */
  gym: {
    open: boolean;
    perKind: number;
    machines: ReturnType<typeof gymMachinesView>;
  };
  /** Điểm danh đêm đang chờ trả lời: còn bao nhiêu giây */
  nightRollcallRemaining: number;
  floorItems: FloorItem[];
  teamQuests: QuestProgress[];
  journal: JournalEntry[];
}

export interface PrivateState {
  playerId: string;
  inventory: InventoryItem[];
  maxSlots: number;
  money: number;
  level: number;
  experience: number;
  stats: PlayerStats;
  skills: PlayerSkills;
  reputation: { guards: number; inmates: number };
  /** Phút game còn phải chờ để từng kệ sách cộng điểm lại */
  shelfCooldowns: Record<string, number>;
  /** Đồ của mình đang nằm trong kho tịch thu (còn bao nhiêu ngày trước khi bị huỷ) + giá chuộc */
  confiscated: {
    items: { id: string; itemId: ItemId; quantity: number; daysLeft: number }[];
    reclaimPrice: number;
  };
  /** Giây còn phải chờ để ăn lại từng món */
  foodCooldowns: Record<string, number>;
  violationsToday: number;
  gear: Gear;
  /** Túi đồ của người đang bị lục soát (bảng bên cạnh túi người chơi) */
  loot: {
    targetId: string;
    name: string;
    gear: Gear;
    bag: InventoryItem[];
  } | null;
  /** Cai ngục đang hỏi khi cải trang */
  challenge: {
    guardName: string;
    question: string;
    options: string[];
    remaining: number;
  } | null;
  /** Lượt tập gym đang diễn ra */
  gym: GymPrivate | null;
  /** Máy đang xếp hàng chờ */
  gymQueued: string | null;
  /** Mã in trên áo đang mặc */
  outfitCode: string | null;
  groupRep: Record<string, number>;
  showeredToday: boolean;
  timesCaught: number;
  quests: QuestProgress[];
  trades: Trade[];
  assistReadyIn: number;
  breakFreeReadyIn: number;
}

export interface TeamStorageView {
  items: InventoryItem[];
  maxSlots: number;
  version: number;
}

export interface GameTime {
  day: number;
  hour: number;
  minute: number;
}

export interface FullState {
  roomId: string;
  tick: number;
  time: number;
  serverTime: number;
  clock: ClockInfo;
  totalGameMinutes: number;
  teamHeat: number;
  players: PlayerPublic[];
  guards: GuardPublic[];
  inmates: InmatePublic[];
  meta: WorldMeta;
  teamStorage: TeamStorageView;
}

export type EntitySnapshot =
  | ({ kind: 'guard' } & GuardPublic)
  | ({ kind: 'inmate' } & InmatePublic);

/** Snapshot định kỳ: người chơi (tối đa 4 — luôn gửi) + lính gác / tù nhân đã thay đổi */
export interface GameSnapshot {
  roomId: string;
  tick: number;
  time: number;
  serverTime: number;
  gameTime: GameTime;
  totalGameMinutes: number;
  players: PlayerPublic[];
  changedEntities: EntitySnapshot[];
  prisonAlertLevel: number;
  keyframe: boolean;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function playerPublic(
  world: WorldState,
  id: string,
): PlayerPublic | null {
  const p = world.players[id];
  if (!p) return null;
  const sol = solitaryRemaining(world, p);
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    colorIndex: p.colorIndex,
    cellIndex: p.cellIndex,
    x: p.x,
    y: p.y,
    facing: p.facing,
    status: p.status,
    connected: p.connected,
    health: Math.round(p.stats.health),
    maxHealth: p.stats.maxHealth,
    energy: r2(p.stats.energy),
    maxEnergy: p.stats.maxEnergy,
    hunger: r2(p.stats.hunger),
    fitness: r2(p.skills.fitness),
    agility: p.stats.agility,
    gym: p.gym?.kind ?? null,
    heat: Math.round(p.stats.personalHeat),
    level: p.level,
    lastSeq: p.lastSeq,
    moving: p.moving,
    sprinting: p.sprinting,
    invulnerable: world.time < p.invulnerableUntil,
    disguised: disguiseActive(world, p),
    vehicle: p.vehicle,
    outfit: outfitTypeOf(p.gear),
    bed: p.bed,
    underground: p.underground,
    weaponDrawn: p.weaponDrawn,
    wanted: p.wantedLevel,
    weapon: p.weaponDrawn ? (equippedWeaponItem(p)?.itemId ?? null) : null,
    weaponDurability: equippedWeaponItem(p)?.durability ?? null,
    swinging: world.time - p.lastAttackAt < 0.3,
    escapeReady: p.escapeReady,
    channel: p.channel
      ? {
          kind: p.channel.kind,
          targetId: p.channel.targetId,
          progress:
            p.channel.kind === 'sleep'
              ? 0
              : r2(Math.min(1, p.channel.elapsed / p.channel.duration)),
        }
      : null,
    knockoutRemaining:
      p.knockoutDeadline !== null
        ? r2(Math.max(0, p.knockoutDeadline - world.time))
        : null,
    solitaryRemaining: sol !== null ? r2(sol) : null,
  };
}

export function guardPublic(g: WorldState['guards'][number]): GuardPublic {
  return {
    id: g.id,
    name: g.name,
    x: g.x,
    y: g.y,
    facing: g.facing,
    state: g.state,
    targetPlayerId: g.targetPlayerId,
    task: g.task ? 'roomSearch' : null,
    health: Math.round(g.health),
    maxHealth: g.maxHealth,
    down: g.downUntil > 0,
    outfit: outfitTypeOf(g.gear),
  };
}

export function inmatePublic(n: WorldState['inmates'][number]): InmatePublic {
  const def = INMATE_BY_ID[n.defId];
  return {
    id: n.id,
    name: def?.name ?? n.id,
    color: def?.color ?? '#cbd5e1',
    x: n.x,
    y: n.y,
    facing: n.facing,
    state: n.state,
    health: Math.round(n.health),
    maxHealth: C.combat.inmateHealth,
    down: n.downUntil > 0,
    combat: n.combat,
    fightWith: n.fightWith,
  };
}

export function buildMeta(world: WorldState): WorldMeta {
  return {
    mode: world.mode,
    difficulty: world.difficulty,
    dayLimit: world.dayLimit,
    prisonState: world.prisonState,
    lockdownRemaining:
      world.lockdownUntil !== null
        ? r2(Math.max(0, world.lockdownUntil - world.time))
        : null,
    routes: {
      ventOpen: world.routes.ventOpen,
      fenceGaps: [...world.routes.fenceGaps],
    },
    blackoutRemaining: r2(Math.max(0, world.blackoutUntil - world.time)),
    dig: clone(world.dig),
    tunnels: clone(world.tunnels),
    hideSpots: clone(world.hideSpots),
    market: { ...world.market },
    camerasOffRemaining: r2(Math.max(0, world.camerasOffUntil - world.time)),
    escape: clone(world.escape),
    escapePoints: escapePoints(world),
    requiredPlayerIds: [...world.requiredPlayerIds],
    outcome: world.outcome,
    intelRemaining: r2(Math.max(0, world.intelUntil - world.time)),
    containers: Object.fromEntries(
      Object.values(world.containers).map((c) => [
        c.id,
        c.items.map((i) => ({ ...i })),
      ]),
    ),
    beds: clone(world.beds),
    doorsLocked: doorsLocked(world),
    soloMode: world.soloMode,
    gym: {
      open: gymOpenAt(clockInfo(world.totalGameMinutes).minuteOfDay),
      perKind: machineCount(world, 'pressBench'),
      machines: gymMachinesView(world),
    },
    nightRollcallRemaining: world.nightRollcall
      ? r2(Math.max(0, world.nightRollcall.until - world.time))
      : 0,
    floorItems: clone(Object.values(world.floorItems)),
    teamQuests: clone(Object.values(world.teamQuests)),
    journal: world.journal.slice(-C.journal.maxEntries).map((j) => ({ ...j })),
  };
}

export function buildPrivate(
  world: WorldState,
  playerId: string,
): PrivateState | null {
  const p = world.players[playerId];
  if (!p) return null;
  const day = clockInfo(world.totalGameMinutes).day;
  return {
    playerId,
    inventory: p.inventory.map((i) => ({ ...i })),
    maxSlots: maxSlots(p),
    money: p.money,
    level: p.level,
    experience: p.experience,
    stats: { ...p.stats },
    skills: { ...p.skills },
    reputation: { ...p.reputation },
    shelfCooldowns: Object.fromEntries(
      Object.keys(p.shelfReads)
        .map((id) => [id, shelfCooldownLeft(world, p, id)])
        .filter(([, m]) => (m as number) > 0),
    ),
    confiscated: {
      items: entriesOf(world, p.id).map((e) => ({
        id: e.id,
        itemId: e.item.itemId,
        quantity: e.item.quantity,
        daysLeft: Math.max(0, e.day + CONFISCATION.keepDays - day),
      })),
      reclaimPrice: entriesOf(world, p.id).length
        ? reclaimPrice(entriesOf(world, p.id))
        : 0,
    },
    foodCooldowns: Object.fromEntries(
      Object.entries(p.foodCooldowns)
        .map(([id, t]) => [id, r2(Math.max(0, t - world.time))])
        .filter(([, s]) => (s as number) > 0),
    ),
    violationsToday:
      p.violationsToday.day === day ? p.violationsToday.count : 0,
    gear: clone(p.gear),
    loot: lootView(world, p),
    challenge: challengeView(world, p),
    gym: gymPrivate(world, p),
    gymQueued: p.gymQueued,
    outfitCode: p.gear.outfit?.owner ?? null,
    groupRep: { ...p.groupRep },
    showeredToday: p.showeredDay === day,
    timesCaught: p.timesCaught,
    quests: clone(Object.values(world.personalQuests[playerId] ?? {})),
    trades: clone(
      Object.values(world.trades).filter(
        (t) => t.fromId === playerId || t.toId === playerId,
      ),
    ),
    assistReadyIn: r2(Math.max(0, p.assistReadyAt - world.time)),
    breakFreeReadyIn: r2(Math.max(0, p.breakFreeReadyAt - world.time)),
  };
}

function lootView(world: WorldState, p: PlayerState): PrivateState['loot'] {
  if (!p.lootTarget) return null;
  const t = findLootTarget(world, p.lootTarget);
  return t
    ? {
        targetId: t.e.id,
        name: t.name,
        gear: clone(t.e.gear),
        bag: clone(t.e.bag),
      }
    : null;
}

export interface GymPrivate {
  machineId: string;
  kind: GymKind;
  index: number;
  beats: number;
  need: number;
  half: boolean;
  lastSide: number;
  momentum: number;
  reps: number;
  stat: 'strength' | 'agility';
  value: number;
  max: number;
  kmh: number;
  tired: boolean;
  weak: boolean;
  request: { npcName: string; aggressive: boolean; remaining: number } | null;
}

function gymPrivate(world: WorldState, p: PlayerState): GymPrivate | null {
  const s = p.gym;
  if (!s) return null;
  const stat = gymStatOf(s.kind);
  const r = world.gym.requests[p.id];
  const n = r ? world.inmates.find((x) => x.id === r.npcId) : undefined;
  return {
    machineId: s.machineId,
    kind: s.kind,
    index: parseMachineId(s.machineId)?.index ?? 0,
    beats: s.beats,
    need: beatsNeeded(p, s.kind, C.needs.slowThreshold),
    half: s.half,
    lastSide: s.lastSide,
    momentum: s.momentum,
    reps: s.reps,
    stat,
    value: p.stats[stat],
    max: STAT_MAX[stat],
    kmh: treadmillKmh(s.momentum),
    tired: p.stats.energy < C.stamina.lowThreshold,
    weak: isWeak(p, C.needs.slowThreshold),
    request: r
      ? {
          npcName: INMATE_BY_ID[n?.defId ?? '']?.name ?? 'Tù nhân',
          aggressive: r.aggressive,
          remaining: r2(Math.max(0, r.until - world.time)),
        }
      : null,
  };
}

function challengeView(
  _world: WorldState,
  _p: PlayerState,
): PrivateState['challenge'] {
  return null; // cải trang không còn hỏi đáp
}

export function buildTeamStorage(world: WorldState): TeamStorageView {
  return {
    items: world.teamStorage.items.map((i) => ({ ...i })),
    maxSlots: world.teamStorage.maxSlots,
    version: world.teamStorage.version,
  };
}

export function buildFullState(
  world: WorldState,
  roomId: string,
  serverTime: number,
): FullState {
  return {
    roomId,
    tick: world.tick,
    time: world.time,
    serverTime,
    clock: clockInfo(world.totalGameMinutes),
    totalGameMinutes: world.totalGameMinutes,
    teamHeat: Math.round(world.teamHeat),
    players: world.playerOrder
      .map((id) => playerPublic(world, id))
      .filter((p): p is PlayerPublic => !!p),
    guards: world.guards.map(guardPublic),
    inmates: world.inmates.map(inmatePublic),
    meta: buildMeta(world),
    teamStorage: buildTeamStorage(world),
  };
}

/** Theo dõi thực thể đã gửi để chỉ gửi phần thay đổi */
export class SnapshotDelta {
  private sent = new Map<string, string>();

  build(
    world: WorldState,
    roomId: string,
    serverTime: number,
    keyframe: boolean,
  ): GameSnapshot {
    const changed: EntitySnapshot[] = [];
    const consider = (e: EntitySnapshot) => {
      const key = `${Math.round(e.x * 100)}|${Math.round(e.y * 100)}|${Math.round(e.facing * 50)}|${e.state}|${e.health}|${e.down}|${e.kind === 'guard' ? `${e.targetPlayerId}|${e.task}` : `${e.combat}|${e.fightWith}`}`;
      if (keyframe || this.sent.get(e.id) !== key) {
        changed.push(e);
        this.sent.set(e.id, key);
      }
    };
    for (const g of world.guards)
      consider({ kind: 'guard', ...guardPublic(g) });
    for (const n of world.inmates)
      consider({ kind: 'inmate', ...inmatePublic(n) });
    const c = clockInfo(world.totalGameMinutes);
    return {
      roomId,
      tick: world.tick,
      time: world.time,
      serverTime,
      gameTime: { day: c.day, hour: c.hour, minute: c.minute },
      totalGameMinutes: world.totalGameMinutes,
      players: world.playerOrder
        .map((id) => playerPublic(world, id))
        .filter((p): p is PlayerPublic => !!p),
      changedEntities: changed,
      prisonAlertLevel: Math.round(world.teamHeat),
      keyframe,
    };
  }

  reset(): void {
    this.sent.clear();
  }
}
