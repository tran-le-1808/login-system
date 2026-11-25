// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Tạo thế giới, vòng tick tất định, vào/ra phiên. Dùng chung: server (co-op) & trình duyệt (chơi đơn). */
import { PRISON_CONFIG as C, ROLE_MODIFIERS, ROUTINE } from './config';
import { updateCameras } from './cameras';
import { completeWork, marketRecover } from './economy';
import {
  decayDecoyMeters,
  initBeds,
  nightGlance,
  resolveNightRollcall,
  sleepAllowedNow,
  startNightRollcall,
} from './bedding';
import { canGuardSee, provokeGuard, reportMissing } from './guards';
import { DISGUISE, disguiseActive, updateChallenges } from './disguise';
import knockoutJson from './data/knockout.json';
import { bagFits, dropToFloor, prisonerOutfit } from './gear';
import { updateGym } from './gym';
import {
  completeRead,
  dailyIntelligenceDecay,
  INTEL,
  libraryOpen,
} from './library';
import { completeBreakIn, purgeConfiscation } from './confiscation';
import {
  canRecoverStamina,
  restoreStamina,
  spendStamina,
  STAMINA,
} from './stamina';
import { setStrength, strengthHp } from './gymStats';
import {
  completeLootOpen,
  completeLootTake,
  validateLootSessions,
} from './loot';
import { escalateLongAbsence, updateWanted } from './wanted';
import { initContainers, refillContainers } from './containers';
import { sweepFloorContraband, updateFloor } from './floor';
import {
  createEscapeSession,
  syncPlayerStatuses,
  updateEscape,
} from './escape';
import { dist } from './geometry';
import {
  alertGuardsTo,
  applyShift,
  assignRoomSearch,
  createGuards,
  shiftChangeAt,
  updateGuards,
} from './guards';
import { completeDigTile, emptyDig } from './digging';
import { wearOwnedTool } from './tools';
import {
  completeBlackout,
  completeBoard,
  completeFence,
  departVehicles,
  morningLockCheck,
  noteDoorTrace,
} from './breakout';
import { addItem, countItem, ITEM_DEFS, removeItem, wearTool } from './items';
import { inArea, PRISON_MAP, zoneAt } from './map';
import { FIXED_DT, movementModifiers, stepMove } from './movement';
import { createInmates, updateInmates } from './npc';
import { applyQuestEvent, initPersonalQuests, initTeamQuests } from './quests';
import { pick } from './rng';
import {
  capturePlayer,
  clockInfo,
  emit,
  freeInfirmaryBed,
  gainSkill,
  infirmarySpot,
  journal,
  lieOnBed,
  passFlags,
  playerSolid,
  PERIOD_INFO as PERIOD_INFO_BY_ID,
  recordViolation,
  recoverPlayer,
  releasePlayer,
  revivePlayer,
  standUp,
  stashOrDrop,
} from './rules';
import { completeCover, completeDig, completeSupport } from './tunnel';
const KO = knockoutJson;
import {
  WORLD_SCHEMA_VERSION,
  type Difficulty,
  type GameMode,
  type MoveInput,
  type Outbox,
  type PlayerState,
  type Role,
  type WorldState,
} from './types';

export interface PlayerInfo {
  id: string;
  name: string;
  role: Role;
}

export interface CreateWorldOptions {
  seed: number;
  difficulty: Difficulty;
  mode: GameMode;
  players: PlayerInfo[];
  /** null = không giới hạn ngày */
  dayLimit?: number | null;
}

function freeCell(world: WorldState): number {
  const used = new Set(Object.values(world.players).map((p) => p.cellIndex));
  for (let i = 0; i < PRISON_MAP.cells.length; i++) if (!used.has(i)) return i;
  return -1;
}

function makePlayer(
  info: PlayerInfo,
  cellIndex: number,
  colorIndex: number,
): PlayerState {
  const spawn = PRISON_MAP.cells[cellIndex];
  const bonus = (r: Role) => (info.role === r ? 2 : 0);
  const roleSkills = ROLE_MODIFIERS[info.role].skills;
  const p: PlayerState = {
    id: info.id,
    name: info.name.slice(0, 32),
    role: info.role,
    colorIndex,
    cellIndex,
    x: spawn.x,
    y: spawn.y,
    facing: Math.PI / 2,
    status: 'ACTIVE',
    connected: true,
    stats: {
      health: C.player.maxHealth + strengthHp(5 + bonus('FIGHTER')),
      maxHealth: C.player.maxHealth + strengthHp(5 + bonus('FIGHTER')),
      energy: STAMINA.staminaMax,
      maxEnergy: STAMINA.staminaMax,
      hunger: 20,
      strength: 5 + bonus('FIGHTER'),
      intelligence: INTEL.intelligenceStart,
      stamina: 5 + bonus('MECHANIC'),
      agility: 5 + bonus('SCOUT'),
      personalHeat: 0,
    },
    skills: {
      crafting: roleSkills.crafting ?? 0,
      fitness: roleSkills.fitness ?? 0,
      dexterity: roleSkills.dexterity ?? 0,
      social: roleSkills.social ?? 0,
    },
    reputation: { guards: C.reputation.start, inmates: C.reputation.start },
    money: C.player.startMoney,
    level: 1,
    experience: 0,
    inventory: [],
    shelfReads: {},
    foodCooldowns: {},
    soloNightPending: false,
    lastCraftAt: -1e9,
    lastCraftContraband: false,
    gear: {
      weapon: null,
      outfit: prisonerOutfit(
        `TN-${String(100 + cellIndex * 7).padStart(4, '0')}`,
      ),
    },
    weaponDrawn: false,
    lootTarget: null,
    disguiseChecks: {},
    lastSeq: 0,
    moving: false,
    sprinting: false,
    knockoutDeadline: null,
    solitaryUntil: null,
    solitaryClock: null,
    solitaryCell: null,
    invulnerableUntil: 0,
    breakFreeReadyAt: 0,
    assistReadyAt: 0,
    channel: null,
    visitedZones: [],
    escapeReady: false,
    violationsToday: { day: 1, count: 0 },
    violationKeys: [],
    timesCaught: 0,
    vehicle: null,
    bed: null,
    bedHold: false,
    soloKoPending: false,
    excusedUntil: 0,
    bedToggleAt: -1e9,
    showerOutfit: null,
    attackedAt: -1e9,
    underground: false,
    wantedLevel: 0,
    wantedSeenAt: 0,
    wantedSince: 0,
    showeredDay: 0,
    gymDay: 0,
    gym: null,
    gymQueued: null,
    groupRep: {},
    attackReadyAt: 0,
    lastAttackAt: -1e9,
    knockoutRecover: false,
  };
  addItem(p.inventory, 'food', 1);
  return p;
}

export function createWorld(opts: CreateWorldOptions): WorldState {
  const world: WorldState = {
    schemaVersion: WORLD_SCHEMA_VERSION,
    prisonId: PRISON_MAP.id,
    seed: opts.seed,
    rngState: opts.seed | 0,
    mode: opts.mode,
    difficulty: opts.difficulty,
    dayLimit: opts.dayLimit === undefined ? null : opts.dayLimit,
    tick: 0,
    time: 0,
    totalGameMinutes: C.clock.startMinuteOfDay,
    prisonState: 'NORMAL',
    lockdownUntil: null,
    teamHeat: 0,
    players: {},
    playerOrder: [],
    requiredPlayerIds: [],
    guards: [],
    inmates: [],
    containers: {},
    lastRefillDay: 1,
    floorItems: {},
    routes: { ventOpen: false, fenceGaps: [] },
    blackoutUntil: 0,
    doorTraces: [],
    dig: emptyDig(),
    tunnels: {},
    hideSpots: {},
    beds: {},
    market: {},
    camerasOffUntil: 0,
    bribedCells: {},
    teamStorage: {
      items: [],
      maxSlots: C.interaction.teamStorageMaxSlots,
      authorizedPlayerIds: [],
      version: 0,
    },
    personalQuests: {},
    teamQuests: {},
    contributionLedger: [],
    trades: {},
    closedTradeIds: [],
    escape: {
      id: '',
      status: 'PREPARING',
      method: null,
      playerStatuses: {},
      allPlayersReady: false,
      failedAt: null,
      attempts: 0,
    },
    intelUntil: 0,
    outcome: null,
    scheduleKeys: [],
    nightRollcall: null,
    challenges: {},
    soloMode: opts.mode === 'single' && C.solitary.soloMode,
    confiscation: { items: [] },
    gym: { occupants: {}, queue: {}, requests: {} },
    journal: [],
    idSeq: 0,
    requestLog: {},
  };
  world.escape = createEscapeSession(world);
  for (const it of PRISON_MAP.interactables)
    if (it.kind === 'hideSpot') world.hideSpots[it.id] = [];
  initContainers(world);
  initBeds(world);
  world.guards = createGuards(world);
  world.inmates = createInmates();
  initTeamQuests(world);
  for (const info of opts.players.slice(0, PRISON_MAP.cells.length))
    addPlayerToWorld(world, info);
  return world;
}

/** Thêm người chơi (lúc tạo hoặc late-join). Chính sách: người vào giữa chừng cũng là thành viên bắt buộc. */
export function addPlayerToWorld(
  world: WorldState,
  info: PlayerInfo,
): PlayerState | null {
  if (world.players[info.id]) return world.players[info.id];
  const cell = freeCell(world);
  if (cell < 0) return null;
  const used = new Set(Object.values(world.players).map((p) => p.colorIndex));
  let color = 0;
  while (used.has(color)) color++;
  const p = makePlayer(info, cell, color);
  p.violationsToday.day = clockInfo(world.totalGameMinutes).day;
  world.players[p.id] = p;
  world.playerOrder.push(p.id);
  world.requiredPlayerIds.push(p.id);
  world.teamStorage.authorizedPlayerIds.push(p.id);
  initPersonalQuests(world, p.id);
  syncPlayerStatuses(world);
  return p;
}

/**
 * Hết grace period / chủ động rời trận. Chính sách:
 * - Người đã ESCAPED: giữ nguyên (vẫn được tính đã thoát).
 * - Người còn trong tù: bị loại khỏi requiredPlayerIds, đồ đạc chuyển vào kho nhóm / rơi cạnh kho.
 */
export function removePlayerFromWorld(
  world: WorldState,
  out: Outbox,
  playerId: string,
  reason: string,
): void {
  const p = world.players[playerId];
  if (!p) return;
  p.connected = false;
  if (p.status === 'ESCAPED') {
    out.dirtyMeta = true;
    return;
  }
  const items = p.inventory;
  p.inventory = [];
  stashOrDrop(world, out, items);
  for (const tid of Object.keys(world.trades)) {
    const t = world.trades[tid];
    if (t.fromId === playerId || t.toId === playerId) {
      delete world.trades[tid];
      out.dirtyTrades.add(t.fromId).add(t.toId);
    }
  }
  for (const q of Object.values(world.players))
    if (q.channel?.targetId === playerId) q.channel = null;
  const rescue = world.teamQuests[`d_rescue_${playerId}`];
  if (rescue && rescue.status === 'ACTIVE') {
    rescue.status = 'FAILED';
    out.dirtyQuests.add('team');
  }
  delete world.players[playerId];
  delete world.personalQuests[playerId];
  world.playerOrder = world.playerOrder.filter((id) => id !== playerId);
  world.requiredPlayerIds = world.requiredPlayerIds.filter(
    (id) => id !== playerId,
  );
  world.teamStorage.authorizedPlayerIds =
    world.teamStorage.authorizedPlayerIds.filter((id) => id !== playerId);
  for (const g of world.guards)
    if (g.targetPlayerId === playerId) g.targetPlayerId = null;
  syncPlayerStatuses(world);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'player:removed',
    playerId,
    audit: true,
    text: `${p.name} ${reason} — đồ đạc đã chuyển vào kho nhóm`,
  });
}

export function setPlayerConnected(
  world: WorldState,
  out: Outbox,
  playerId: string,
  connected: boolean,
): void {
  const p = world.players[playerId];
  if (!p || p.connected === connected) return;
  p.connected = connected;
  if (!connected) {
    p.channel = null;
    p.moving = false;
    p.sprinting = false;
  }
  out.dirtyMeta = true;
}

// ------------------------------------------------------------------ input di chuyển

export function moveContextFor(world: WorldState, p: PlayerState) {
  return {
    solid: playerSolid(passFlags(world, p)),
    role: p.role,
    ...movementModifiers({
      hunger: p.stats.hunger,
      fitness: p.skills.fitness,
      stamina: p.stats.stamina,
      agility: p.stats.agility,
    }),
  };
}

/** Áp dụng một input. Trả về false nếu input trùng / cũ (sequence không tăng). */
export function applyMoveInput(
  world: WorldState,
  playerId: string,
  input: MoveInput,
): boolean {
  const p = world.players[playerId];
  if (!p || !Number.isInteger(input.sequence) || input.sequence <= p.lastSeq)
    return false;
  p.lastSeq = input.sequence;
  if (p.status !== 'ACTIVE' || world.outcome) return true;
  if (p.gym) return true; // đang trên máy tập: phím trái/phải là nhịp tập, không di chuyển
  if (p.vehicle) return true; // đang nằm trốn trong xe
  // đang nằm trên giường (trạng thái ngủ): khoá nhân vật — phím di chuyển bị bỏ qua, chỉ dậy bằng nút "Dậy" / sự kiện
  if (p.bed) return true;
  const res = stepMove(
    moveContextFor(world, p),
    { x: p.x, y: p.y, facing: p.facing, energy: p.stats.energy },
    input,
  );
  if (!res.moving) return true;
  p.x = res.x;
  p.y = res.y;
  p.facing = res.facing;
  p.stats.energy = res.energy;
  p.moving = true;
  if (res.sprinting) p.sprinting = true;
  if (
    p.channel &&
    dist(p.x, p.y, p.channel.startX, p.channel.startY) >
      C.interaction.channelMoveTolerance
  )
    p.channel = null;
  return true;
}

// ------------------------------------------------------------------ thao tác giữ

function completeChannel(world: WorldState, out: Outbox, p: PlayerState): void {
  const ch = p.channel;
  if (!ch) return;
  p.channel = null;
  switch (ch.kind) {
    case 'openVent': {
      // dụng cụ cậy đã chọn lúc bắt đầu (dao mài cầm tay không mòn khi cậy)
      const tool = ch.itemId;
      const pry =
        !!tool &&
        (tool === 'shiv'
          ? countItem(p.inventory, 'shiv') > 0 ||
            p.gear.weapon?.itemId === 'shiv'
          : wearOwnedTool(p, tool));
      if (world.routes.ventOpen || !pry) return;
      world.routes.ventOpen = true;
      gainSkill(p, 'dexterity', C.skills.dexterityGain);
      out.dirtyInventories.add(p.id);
      out.dirtyMeta = true;
      journal(world, out, 'event', `${p.name} cậy lưới thông gió`, p.id);
      const ev = emit(world, out, {
        type: 'route:opened',
        playerId: p.id,
        audit: true,
        x: p.x,
        y: p.y,
        data: { route: 'VENT' },
        text: `🔧 ${p.name} đã cậy lưới thông gió!`,
      });
      applyQuestEvent(world, out, {
        eventId: ev.id,
        type: 'OPEN_ROUTE',
        playerId: p.id,
        targetId: 'VENT',
        amount: 1,
      });
      return;
    }
    case 'attachRope':
    case 'cutFence':
      completeFence(world, out, p, ch);
      return;
    case 'board':
      completeBoard(world, out, p, ch.targetId);
      return;
    case 'digWall':
    case 'digFloor':
    case 'digTunnel':
      completeDigTile(world, out, p, ch);
      return;
    case 'blackout':
      completeBlackout(world, out, p);
      return;
    case 'revive': {
      const t = world.players[ch.targetId];
      if (
        t &&
        t.status === 'KNOCKED_OUT' &&
        dist(p.x, p.y, t.x, t.y) <= C.interaction.range + 0.5
      )
        revivePlayer(world, out, t, p);
      return;
    }
    case 'rescue': {
      const t = world.players[ch.targetId];
      if (
        !t ||
        t.status !== 'CAPTURED' ||
        !ch.itemId ||
        !wearOwnedTool(p, ch.itemId)
      )
        return;
      gainSkill(p, 'dexterity', C.skills.dexterityGain);
      out.dirtyInventories.add(p.id);
      releasePlayer(world, out, t, p);
      return;
    }
    case 'breakIn':
      if (ch.itemId) wearOwnedTool(p, ch.itemId);
      completeBreakIn(world, out, p);
      return;
    case 'read':
      completeRead(world, out, p, ch.targetId);
      return;
    case 'hide': {
      if (
        !ch.itemId ||
        !ch.quantity ||
        countItem(p.inventory, ch.itemId) < ch.quantity
      )
        return;
      const items = (world.hideSpots[ch.targetId] ??= []);
      for (const t of removeItem(p.inventory, ch.itemId, ch.quantity))
        addItem(items, t.itemId, t.quantity, t.durability);
      out.dirtyInventories.add(p.id);
      out.dirtyMeta = true;
      emit(world, out, {
        type: 'item:hidden',
        playerId: p.id,
        x: p.x,
        y: p.y,
        text: `🤫 Đã giấu ${ITEM_DEFS[ch.itemId].name}`,
      });
      return;
    }
    case 'flush':
      if (countItem(p.inventory, 'dirt')) {
        removeItem(p.inventory, 'dirt', 1);
        out.dirtyInventories.add(p.id);
        emit(world, out, {
          type: 'tunnel:flushed',
          playerId: p.id,
          x: p.x,
          y: p.y,
        });
      }
      return;
    case 'dig':
      spendStamina(p, STAMINA.digCost);
      completeDig(world, out, p, Number(ch.recipeId));
      return;
    case 'support':
      completeSupport(world, out, p, Number(ch.recipeId));
      return;
    case 'cover':
      completeCover(world, out, Number(ch.recipeId));
      emit(world, out, {
        type: 'tunnel:covered',
        playerId: p.id,
        text: '🛏️ Đã che miệng hầm',
      });
      return;
    case 'work':
      completeWork(
        world,
        out,
        p,
        PRISON_MAP.interactableById[ch.targetId]?.name ?? 'xưởng',
      );
      return;
    case 'cameraPanel':
      world.camerasOffUntil = world.time + C.cameras.disabledSeconds;
      gainSkill(p, 'dexterity', C.skills.dexterityGain);
      out.dirtyMeta = true;
      journal(
        world,
        out,
        'event',
        `${p.name} tắt hệ thống camera ${C.cameras.disabledSeconds} giây`,
        p.id,
      );
      emit(world, out, {
        type: 'camera:disabled',
        playerId: p.id,
        audit: true,
        text: `📴 ${p.name} vô hiệu hoá camera ${C.cameras.disabledSeconds} giây!`,
      });
      return;
    case 'loot':
      completeLootOpen(
        world,
        out,
        p,
        ch.targetId,
        world.guards.some((g) => g.downUntil <= 0 && canGuardSee(world, g, p)),
      );
      return;
    case 'lootTake':
      if (ch.slot !== undefined && ch.index !== undefined && ch.itemId)
        completeLootTake(
          world,
          out,
          p,
          ch.targetId,
          ch.slot,
          ch.index,
          ch.itemId,
        );
      return;
    case 'shower':
      p.showeredDay = clockInfo(world.totalGameMinutes).day;
      out.dirtyInventories.add(p.id);
      {
        // tắm đúng khung 16:00–17:00 và tắm xong (không bị gián đoạn) thì +30 thể lực
        const inShowerTime =
          clockInfo(world.totalGameMinutes).period === 'SHOWER';
        const gained =
          inShowerTime && canRecoverStamina(p)
            ? restoreStamina(p, STAMINA.showerRestore)
            : 0;
        emit(world, out, {
          type: 'activity:shower',
          playerId: p.id,
          x: p.x,
          y: p.y,
          data: { stamina: gained },
          text: `🚿 ${p.name} tắm xong, sạch sẽ${gained ? ` (+${Math.round(gained)} thể lực)` : ''}`,
        });
      }
      return;
    case 'sleep':
      return;
  }
}

function channelStillValid(world: WorldState, p: PlayerState): boolean {
  const ch = p.channel;
  if (!ch || p.status !== 'ACTIVE' || !p.connected) return false;
  if (ch.kind === 'revive')
    return world.players[ch.targetId]?.status === 'KNOCKED_OUT';
  if (ch.kind === 'rescue')
    return world.players[ch.targetId]?.status === 'CAPTURED';
  if (ch.kind === 'work')
    return !!PERIOD_INFO_BY_ID[clockInfo(world.totalGameMinutes).period]
      ?.workShift;
  // ngủ: tự dậy khi thể lực đầy 100
  // ngủ không tự dậy khi đầy thể lực: nằm tới khi bấm Dậy hoặc có sự kiện (bị đánh, gọi tên, điểm danh)
  if (ch.kind === 'sleep') return true;
  if (ch.kind === 'read') return libraryOpen(world);
  return true;
}

// ------------------------------------------------------------------ lịch sinh hoạt (mỗi phút game)

function onceKey(world: WorldState, key: string): boolean {
  if (world.scheduleKeys.includes(key)) return false;
  world.scheduleKeys.push(key);
  if (world.scheduleKeys.length > 60)
    world.scheduleKeys.splice(0, world.scheduleKeys.length - 60);
  return true;
}

function isAt(player: PlayerState, req: string): boolean {
  const zone = zoneAt(PRISON_MAP, player.x, player.y);
  if (req === 'rollcall')
    return inArea(PRISON_MAP, 'rollcall', player.x, player.y);
  if (req === 'work') return zone === 'workshop' || zone === 'laundry';
  if (req === 'ownCell') return zone === `cell_${player.cellIndex}`;
  return zone === req;
}

function activePlayers(world: WorldState): PlayerState[] {
  return world.playerOrder
    .map((id) => world.players[id])
    .filter(
      (p): p is PlayerState => !!p && p.status === 'ACTIVE' && p.connected,
    );
}

/** Gọi người đang ngủ dậy (điểm danh, cai ngục gọi tên) */
function wakeSleepers(world: WorldState, out: Outbox, why: string): void {
  for (const pl of activePlayers(world))
    if (pl.channel?.kind === 'sleep') {
      pl.channel = null;
      out.dirtyInventories.add(pl.id);
      emit(world, out, {
        type: 'player:woken',
        playerId: pl.id,
        text: `⏰ ${pl.name} bị gọi dậy — ${why}!`,
      });
    }
}

/**
 * Chơi một mình: bị bắt -> ngủ trong phòng biệt giam tới 08:00 kế tiếp.
 * Các phút ở giữa vẫn chạy lịch (bổ sung đồ, nửa đêm, giới hạn ngày, 08:00 thông minh −2) — người bị giam không bị tính vắng.
 * Thức dậy: thể lực 100, vài giây sau được thả về xà lim.
 */
/**
 * Chơi một mình, bị đánh ngất (hết máu): tua nhanh 30 phút game (vẫn chạy lịch: điểm danh, 08:00 thông minh −2…),
 * tỉnh dậy nằm trên giường phòng y tế, thể lực 100, sức mạnh −1, nhanh nhẹn −1, máu 50%. Kẻ đánh rời đi.
 */
/**
 * Phòng tắm: vòi sen luôn xả nước, mọi giờ. Đứng ở ô dưới vòi (showerSpot) hồi thể lực như ngủ (+4/giây).
 * showerRemovesOutfit: bước vào thì cởi bộ đồ để lên giá, bước ra thì tự mặc lại.
 */
export function showerAt(x: number, y: number): string | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  for (const it of PRISON_MAP.interactables)
    if (
      it.kind === 'shower' &&
      it.showerSpot &&
      it.showerSpot.x === tx &&
      it.showerSpot.y === ty
    )
      return it.id;
  return null;
}

function updateShower(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  dt: number,
): void {
  const under = !p.underground && !p.vehicle && showerAt(p.x, p.y);
  if (under) {
    if (C.shower.showerRemovesOutfit && p.gear.outfit && !p.showerOutfit) {
      p.showerOutfit = p.gear.outfit;
      p.gear.outfit = null;
      out.dirtyInventories.add(p.id);
    }
    if (p.showeredDay !== clockInfo(world.totalGameMinutes).day) {
      p.showeredDay = clockInfo(world.totalGameMinutes).day;
      out.dirtyInventories.add(p.id);
    }
    if (canRecoverStamina(p) && p.stats.energy < p.stats.maxEnergy)
      restoreStamina(p, C.shower.staminaPerSecond * dt);
  } else if (p.showerOutfit) {
    // bước ra: mặc lại (đang mặc bộ khác thì bộ trên giá vào túi / rơi xuống)
    const it = p.showerOutfit;
    p.showerOutfit = null;
    if (!p.gear.outfit) p.gear.outfit = it;
    else if (bagFits(p, [it])) p.inventory.push(it);
    else dropToFloor(world, out, p.x, p.y, it);
    out.dirtyInventories.add(p.id);
  }
}

export function soloKnockoutWake(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): void {
  p.soloKoPending = false;
  if (p.status !== 'KNOCKED_OUT') return;
  const K = C.knockout;
  const now = world.totalGameMinutes;
  const target = now + K.knockoutSoloMinutes;
  p.excusedUntil = Math.ceil(target);
  emit(world, out, {
    type: 'player:blackout',
    playerId: p.id,
    data: { minutes: K.knockoutSoloMinutes },
    text: '😵 Bạn đã bất tỉnh…',
  });
  for (let m = Math.floor(now) + 1; m <= target && !world.outcome; m++) {
    world.totalGameMinutes = m;
    runScheduleMinute(world, out, m);
  }
  world.totalGameMinutes = target;
  // trận đánh kết thúc: kẻ đánh rời đi, không đánh tiếp ngay
  for (const n of world.inmates)
    if (n.fightWith === p.id) {
      n.fightWith = null;
      n.combat = 'idle';
      n.path = [];
    }
  p.status = 'ACTIVE';
  p.knockoutDeadline = null;
  p.knockoutRecover = false;
  setStrength(p, Math.max(0, p.stats.strength - K.knockoutStrengthLoss));
  p.stats.agility = Math.max(0, p.stats.agility - K.knockoutAgilityLoss);
  p.stats.energy = Math.min(p.stats.maxEnergy, K.knockoutStaminaRestore);
  p.stats.health = Math.round(p.stats.maxHealth * K.knockoutHpRecoverRatio);
  p.invulnerableUntil =
    world.time + KO.safeGameMinutes / C.clock.gameMinutesPerSecond;
  p.channel = null;
  if (!lieOnBed(world, p, freeInfirmaryBed(world, p.id), true)) {
    const spot = infirmarySpot();
    p.x = spot.x;
    p.y = spot.y;
  }
  const text = `🏥 Bạn tỉnh dậy ở phòng y tế · Sức mạnh −${K.knockoutStrengthLoss} · Nhanh nhẹn −${K.knockoutAgilityLoss}`;
  journal(
    world,
    out,
    'event',
    `${p.name} bất tỉnh ${K.knockoutSoloMinutes} phút, tỉnh dậy ở phòng y tế (sức mạnh −${K.knockoutStrengthLoss}, nhanh nhẹn −${K.knockoutAgilityLoss})`,
    p.id,
  );
  emit(world, out, {
    type: 'player:recovered',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { solo: true },
    text,
  });
  out.dirtyMeta = true;
  out.dirtyInventories.add(p.id);
}

export function skipToMorning(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): void {
  p.soloNightPending = false;
  if (p.status !== 'CAPTURED') return;
  const wake = ROUTINE.periods[0].startMinute;
  const now = world.totalGameMinutes;
  const dayStart = Math.floor(now / 1440) * 1440;
  let target = dayStart + wake;
  if (target <= now) target += 1440;
  const fromDay = clockInfo(now).day;
  for (let m = Math.floor(now) + 1; m <= target && !world.outcome; m++) {
    world.totalGameMinutes = m;
    runScheduleMinute(world, out, m);
  }
  world.totalGameMinutes = target;
  p.stats.energy = p.stats.maxEnergy;
  p.stats.hunger = Math.min(p.stats.hunger, 30);
  p.solitaryClock = 'sim';
  p.solitaryUntil = world.time + C.solitary.soloWakeSeconds;
  const day = clockInfo(target).day;
  const nights = Math.max(1, day - fromDay);
  journal(
    world,
    out,
    'capture',
    `${p.name} ngủ ${nights} đêm trong phòng biệt giam, thức dậy 08:00 ngày ${day}`,
    p.id,
  );
  emit(world, out, {
    type: 'player:solo-night',
    playerId: p.id,
    data: { day, nights },
    text: `🌅 08:00 ngày ${day} — thức dậy trong phòng biệt giam`,
  });
  out.dirtyMeta = true;
  out.dirtyInventories.add(p.id);
}

function runScheduleMinute(
  world: WorldState,
  out: Outbox,
  minute: number,
): void {
  const md = ((minute % 1440) + 1440) % 1440;
  const day = Math.floor(minute / 1440) + 1;
  const hhmm = `${String(Math.floor(md / 60)).padStart(2, '0')}:${String(md % 60).padStart(2, '0')}`;
  for (const p of ROUTINE.segments) {
    if (p.cont) continue;
    // đếm ngược trước khung (thanh trên HUD), chuông báo ĐÚNG giờ
    if (
      p.id !== 'BREAK' &&
      md === (p.startMinute - ROUTINE.bellBeforeMinutes + 1440) % 1440 &&
      onceKey(world, `soon:${day}:${p.id}`)
    )
      emit(world, out, {
        type: 'game:countdown',
        data: { period: p.id },
        text: `⏳ ${ROUTINE.bellBeforeMinutes} phút nữa: ${p.name} — ${p.rule}`,
      });
    const isRollcall = (C.rollcall.periods as string[]).includes(p.id);
    // điểm danh: chuông cảnh báo trước 1 phút + gọi người đang ngủ dậy
    if (
      isRollcall &&
      md === (p.startMinute - C.rollcall.warningMinutes + 1440) % 1440 &&
      onceKey(world, `rcwarn:${day}:${p.id}`)
    ) {
      emit(world, out, {
        type: 'game:rollcall-warning',
        data: {
          period: p.id,
          seconds: C.rollcall.warningMinutes / C.clock.gameMinutesPerSecond,
        },
        text: `🔔 ${C.rollcall.warningMinutes} phút nữa điểm danh — ra vạch sân!`,
      });
      wakeSleepers(world, out, 'sắp điểm danh');
    }
    if (md === p.startMinute && onceKey(world, `start:${day}:${p.id}`)) {
      emit(world, out, {
        type:
          p.id === 'LIGHTS_OUT'
            ? 'game:lights-out'
            : p.id === 'BREAK'
              ? 'game:clock-updated'
              : isRollcall
                ? 'game:rollcall-bell'
                : 'game:bell',
        data: { period: p.id },
        text: `🔔 ${hhmm} ${p.name}: ${p.rule}`,
      });
      if (isRollcall) {
        wakeSleepers(world, out, 'điểm danh');
        sweepFloorContraband(world, out);
      }
      out.dirtyMeta = true;
    }
    if (
      isRollcall &&
      md === p.endMinute % 1440 &&
      onceKey(world, `rcend:${day}:${p.id}`)
    )
      emit(world, out, {
        type: 'game:rollcall-end',
        data: { period: p.id },
        text: `🔔 ${hhmm} Kết thúc ${p.name.toLowerCase()}`,
      });
    // Điểm danh: hết ân hạn mà vắng mặt -> vi phạm, cai ngục đi tìm (hình nộm không giúp được)
    if (
      p.rollCall &&
      md === (p.startMinute + ROUTINE.graceMinutes) % 1440 &&
      onceKey(world, `roll:${day}:${p.id}`)
    ) {
      for (const pl of activePlayers(world)) {
        if (isAt(pl, 'rollcall')) continue;
        // có lý do y tế (vừa bất tỉnh ở phòng y tế) hoặc đang mặc đồ cai ngục (điểm danh chỉ đếm tù nhân)
        if (KO.medicalExcusesRollCall && pl.excusedUntil >= minute) continue;
        if (DISGUISE.bypassRollCall && disguiseActive(world, pl)) continue;
        recordViolation(
          world,
          out,
          pl,
          {
            reason: 'vắng mặt điểm danh',
            severity: 'minor',
            key: `${day}:${p.id}`,
          },
          'Điểm danh',
        );
        alertGuardsTo(world, pl, 99);
      }
      // điểm danh cai ngục: ai đang nằm ngất ở đâu đó bị phát hiện mất tích
      for (const g of world.guards)
        if (g.downUntil > 0 && !g.missingReported)
          reportMissing(world, out, g, 'Điểm danh cai ngục');
    }
    // Ca làm: kiểm tra giữa ca, bỏ việc -> vắng việc (trừ tiền công, vi phạm nhỏ)
    if (p.workShift)
      for (const off of ROUTINE.workChecksMinutes) {
        if (
          md !== (p.startMinute + off) % 1440 ||
          !onceKey(world, `work:${day}:${p.id}:${off}`)
        )
          continue;
        for (const pl of activePlayers(world)) {
          if (isAt(pl, 'work')) continue;
          const fine = Math.min(pl.money, C.activities.absentWagePenalty);
          pl.money -= fine;
          out.dirtyInventories.add(pl.id);
          journal(
            world,
            out,
            'penalty',
            `${pl.name} vắng việc ở ca ${p.name} — trừ ${fine}$ tiền công`,
            pl.id,
          );
          recordViolation(
            world,
            out,
            pl,
            {
              reason: 'vắng việc giữa ca',
              severity: 'minor',
              key: `${day}:${p.id}:absent`,
            },
            'Quản đốc',
          );
        }
      }
    // Hết giờ tắm: ai không tắm bị phạt danh tiếng
    if (
      C.shower.hygienePenaltyEnabled &&
      p.showerCheck &&
      md === p.endMinute % 1440 &&
      onceKey(world, `shower:${day}`)
    )
      for (const pl of activePlayers(world)) {
        if (pl.showeredDay === day) continue;
        pl.reputation.guards = Math.max(
          0,
          pl.reputation.guards - C.activities.noShowerGuardRep,
        );
        pl.reputation.inmates = Math.max(
          0,
          pl.reputation.inmates - C.activities.noShowerInmateRep,
        );
        out.dirtyInventories.add(pl.id);
        journal(
          world,
          out,
          'penalty',
          `${pl.name} không tắm — mất uy tín`,
          pl.id,
        );
        emit(world, out, {
          type: 'violation:penalty',
          playerId: pl.id,
          text: `🚿 ${pl.name} không tắm hôm nay (−uy tín)`,
        });
      }
  }
  // 08:00 thức dậy: ai đang ngủ thì dậy
  if (md === ROUTINE.periods[0].startMinute && onceKey(world, `wake:${day}`)) {
    if (C.sleep.autoWakeAt8)
      for (const pl of activePlayers(world))
        if (pl.channel?.kind === 'sleep') {
          pl.channel = null;
          out.dirtyInventories.add(pl.id);
        }
    purgeConfiscation(world, out, day);
    morningLockCheck(world, out);
    dailyIntelligenceDecay(
      world,
      out,
      Object.values(world.players).filter((q) => q.status !== 'ESCAPED'),
    );
    emit(world, out, {
      type: 'game:wake',
      data: { day },
      text: `☀️ 08:00 — Ngày ${day} bắt đầu, thức dậy!`,
    });
  }
  // Đổi ca cai ngục (patrols.json) & xe ra cổng (vehicles.json)
  const shift = shiftChangeAt(md);
  if (shift && onceKey(world, `shift:${day}:${shift}`))
    applyShift(world, out, shift === 'night');
  departVehicles(world, out, md, (pl) =>
    alertGuardsTo(world, pl, C.guard.alarmCallRadius),
  );
  // Kiểm tra đêm: nhìn thoáng vào xà lim / điểm danh đêm (gọi tên)
  for (const nc of ROUTINE.nightChecks)
    if (md === nc.minute && onceKey(world, `night:${day}:${md}`)) {
      if (nc.kind === 'glance')
        nightGlance(world, out, (q, r) => alertGuardsTo(world, q, r));
      else {
        wakeSleepers(world, out, 'cai ngục gọi tên');
        startNightRollcall(world, out);
      }
    }
  if (md === 0)
    escalateLongAbsence(world, out, (q, r) => alertGuardsTo(world, q, r));
  if (
    ROUTINE.roomSearchMinutes.includes(md) &&
    onceKey(world, `search:${day}:${md}`)
  ) {
    const cells = [
      ...new Set(
        Object.values(world.players)
          .filter((p) => p.status !== 'ESCAPED')
          .map((p) => p.cellIndex),
      ),
    ].filter((c) => world.bribedCells[String(c)] !== day);
    if (cells.length) {
      const cell = pick(world, cells);
      const g = assignRoomSearch(world, cell);
      if (g)
        emit(world, out, {
          type: 'search:start',
          data: { cellIndex: cell },
          text: `🔦 ${g.name} đi khám phòng ${cell + 1}!`,
        });
    }
  }
  updateWanted(world, out, (pl) =>
    world.guards.some((g) => g.downUntil <= 0 && canGuardSee(world, g, pl)),
  );
  escalateLongAbsence(world, out, (q, r) => alertGuardsTo(world, q, r));
  if (md === 360 && day > world.lastRefillDay) {
    world.lastRefillDay = day;
    refillContainers(world);
    out.dirtyMeta = true;
    emit(world, out, {
      type: 'game:refill',
      text: '📦 Đồ dùng trong trại đã được bổ sung',
    });
  }
  if (md === 0 && onceKey(world, `midnight:${day}`)) {
    emit(world, out, {
      type: 'game:midnight',
      data: { day },
      text: `🌙 Ngày ${day} bắt đầu`,
    });
    if (world.dayLimit !== null && day > world.dayLimit && !world.outcome) {
      world.outcome = 'TIME_UP';
      journal(
        world,
        out,
        'event',
        `Hết ${world.dayLimit} ngày — kế hoạch vượt ngục thất bại`,
      );
      emit(world, out, {
        type: 'game:time-up',
        audit: true,
        text: `⌛ Đã hết ${world.dayLimit} ngày!`,
      });
    }
  }
}

// ------------------------------------------------------------------ tick

export function stepWorld(world: WorldState, out: Outbox, dt = FIXED_DT): void {
  if (world.outcome) return;
  world.tick += 1;
  world.time = Math.round((world.time + dt) * 1e6) / 1e6;

  const prevMin = world.totalGameMinutes;
  world.totalGameMinutes =
    Math.round(
      (world.totalGameMinutes + C.clock.gameMinutesPerSecond * dt) * 1e6,
    ) / 1e6;
  const dm = world.totalGameMinutes - prevMin;
  for (
    let m = Math.floor(prevMin) + 1;
    m <= Math.floor(world.totalGameMinutes);
    m++
  )
    runScheduleMinute(world, out, m);
  if (world.outcome) return;
  marketRecover(world, dm);
  validateLootSessions(world, out);
  for (const { p, g } of updateChallenges(world, out))
    if (g && p.status === 'ACTIVE') provokeGuard(world, out, g, p);
  decayDecoyMeters(world, dm);
  resolveNightRollcall(world, out, (q, r) => alertGuardsTo(world, q, r));

  // Người chơi
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (!p) continue;
    if (p.status === 'ACTIVE' || p.status === 'CAPTURED') {
      const s = p.stats;
      const sleeping = p.channel?.kind === 'sleep';
      s.hunger = Math.min(100, s.hunger + C.needs.hungerPerGameMinute * dm);
      if (sleeping) {
        // nằm trên giường: +1 thể lực mỗi giây (không hồi trong khu cấm / khi bị truy nã)
        if (canRecoverStamina(p))
          restoreStamina(p, STAMINA.bedSleepStaminaPerSecond * dt);
        // ngủ ngoài giờ cho phép (đang có lịch) = vi phạm
        if (!sleepAllowedNow(world)) {
          const c = clockInfo(world.totalGameMinutes);
          const per = c.period;
          const since =
            (c.minuteOfDay -
              (PERIOD_INFO_BY_ID[per]?.originMinute ?? c.minuteOfDay) +
              1440) %
            1440;
          if (since >= ROUTINE.graceMinutes)
            recordViolation(
              world,
              out,
              p,
              {
                reason: `ngủ trong giờ ${PERIOD_INFO_BY_ID[per]?.name ?? 'sinh hoạt'}`,
                severity: 'minor',
                key: `${c.day}:oversleep:${per}`,
              },
              'Cai ngục',
            );
        }
      }
      if (p.sprinting) {
        gainSkill(p, 'fitness', C.skills.fitnessPerSprintSecond * dt);
      }
      if (s.hunger >= C.needs.criticalThreshold)
        s.health = Math.max(
          1,
          s.health - C.needs.criticalHealthDrainPerSecond * dt,
        );
      else
        s.health = Math.min(s.maxHealth, s.health + C.player.healthRegen * dt);
    }
    if (p.status === 'ACTIVE') {
      p.stats.personalHeat = Math.max(
        0,
        p.stats.personalHeat - C.heat.personalDecay * dt,
      );
      noteDoorTrace(world, p);
      updateShower(world, out, p, dt);
      // đang nằm: giữ cố định ở điểm nằm của giường (không hệ nào khác được đẩy ra)
      if (p.bed) {
        const a = PRISON_MAP.interactableById[p.bed]?.sleepAnchor;
        if (a) {
          p.x = a.x;
          p.y = a.y;
        }
      }
      const zone = zoneAt(PRISON_MAP, p.x, p.y);
      if (zone && !p.visitedZones.includes(zone)) {
        p.visitedZones.push(zone);
        applyQuestEvent(world, out, {
          eventId: `visit:${zone}`,
          type: 'VISIT',
          playerId: p.id,
          targetId: zone,
          amount: 1,
        });
      }
      if (p.channel) {
        if (!channelStillValid(world, p)) {
          if (p.channel.kind === 'sleep')
            emit(world, out, {
              type: 'player:woke',
              playerId: p.id,
              text: `☀️ ${p.name} đã ngủ đủ`,
            });
          p.channel = null;
        } else {
          p.channel.elapsed += dt;
          if (p.channel.elapsed >= p.channel.duration - 1e-9)
            completeChannel(world, out, p);
        }
      }
    } else if (
      p.status === 'KNOCKED_OUT' &&
      p.knockoutDeadline !== null &&
      world.time >= p.knockoutDeadline
    ) {
      if (p.knockoutRecover) recoverPlayer(world, out, p);
      else capturePlayer(world, out, p);
    } else if (p.status === 'CAPTURED' && p.solitaryUntil !== null) {
      const due =
        p.solitaryClock === 'game'
          ? world.totalGameMinutes >= p.solitaryUntil
          : world.time >= p.solitaryUntil;
      if (due) releasePlayer(world, out, p, null);
    }
  }

  // chơi một mình bị bắt: qua ngày mới trong phòng biệt giam; bị đánh ngất: 30 phút rồi tỉnh ở phòng y tế
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (p?.soloNightPending) skipToMorning(world, out, p);
    if (p?.soloKoPending) soloKnockoutWake(world, out, p);
    // hết ngủ (tự dậy / bị gọi / bị đánh) mà vẫn nằm: ngồi dậy ở chân giường
    if (
      p?.bed &&
      p.channel?.kind !== 'sleep' &&
      !p.bedHold &&
      p.status === 'ACTIVE'
    )
      standUp(world, p);
  }
  if (world.outcome) return;

  // AI (quyết định ở aiRate, di chuyển mỗi tick)
  const aiEvery = Math.max(1, Math.round(C.net.tickRate / C.net.aiRate));
  const aiTick = world.tick % aiEvery === 0;
  updateGuards(world, out, dt, aiTick);
  updateInmates(world, out, dt, aiTick, (p) => alertGuardsTo(world, p, 10));
  updateGym(world, out, dt);
  updateFloor(world, out, aiTick);
  if (aiTick)
    updateCameras(world, out, 1 / C.net.aiRate, (p) => alertGuardsTo(world, p));

  // Heat & phong tỏa
  if (world.prisonState === 'NORMAL') {
    world.teamHeat = Math.max(0, world.teamHeat - C.heat.teamDecay * dt);
    if (world.teamHeat >= C.heat.lockdownThreshold) {
      world.prisonState = 'LOCKDOWN';
      world.lockdownUntil = world.time + C.heat.lockdownSeconds;
      out.dirtyMeta = true;
      journal(world, out, 'event', 'Báo động toàn trại — phong tỏa');
      emit(world, out, {
        type: 'game:lockdown',
        audit: true,
        text: `🔒 PHONG TỎA TOÀN TRẠI ${C.heat.lockdownSeconds} giây — về phòng ngay!`,
      });
    }
  } else if (
    world.lockdownUntil !== null &&
    world.time >= world.lockdownUntil
  ) {
    world.prisonState = 'NORMAL';
    world.lockdownUntil = null;
    world.teamHeat = Math.min(world.teamHeat, C.heat.teamHeatAfterLockdown);
    out.dirtyMeta = true;
    emit(world, out, { type: 'game:lockdown-ended', text: '🔓 Hết phong tỏa' });
  }

  for (const t of Object.values(world.trades))
    if (world.time - t.createdAt > C.interaction.tradeTimeoutSeconds) {
      delete world.trades[t.id];
      world.closedTradeIds.push(t.id);
      out.dirtyTrades.add(t.fromId).add(t.toId);
    }

  updateEscape(world, out);
}

/**
 * Một tick hoàn chỉnh: xoá cờ chuyển động, áp input đã xếp hàng, rồi mô phỏng.
 * Server và phiên chơi đơn đều gọi hàm này — không có hai vòng lặp cạnh tranh.
 */
export function runTick(
  world: WorldState,
  out: Outbox,
  inputs: Map<string, MoveInput[]>,
): void {
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (p) {
      p.moving = false;
      p.sprinting = false;
    }
  }
  for (const [pid, list] of inputs)
    for (const inp of list) applyMoveInput(world, pid, inp);
  stepWorld(world, out);
}
