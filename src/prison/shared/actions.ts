// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Xử lý ý định (intent) của người chơi. Mọi kiểm tra quyền sở hữu, số lượng, khoảng cách,
 * trạng thái đều ở đây; client không bao giờ gửi kết quả. Idempotent theo requestId.
 */
import { actionSeconds, PRISON_CONFIG as C, ROLE_MODIFIERS } from './config';
import {
  cancelEscape,
  enterEscapePoint,
  prepareEscape,
  setEscapeReady,
  startEscape,
} from './escape';
import { dist } from './geometry';
import { buy, sell } from './economy';
import {
  addTaken,
  countItem,
  ITEM_DEFS,
  RECIPE_BY_ID,
  removeItem,
  slotsAfter,
} from './items';
import {
  answerRollcall,
  bedPlace,
  bedTake,
  canSleepIn,
  decoyRealism,
} from './bedding';
import { attack, equipWeapon } from './combat';
import { answerChallenge } from './disguise';
import { bagFits, dropWeapon, giveItems, takeOff, wearFromBag } from './gear';
import { alertGuardsTo, canGuardSee } from './guards';
import { lootStart, lootTake } from './loot';
import {
  gymAnswer,
  gymPress,
  gymStart,
  gymStop,
  nearestFreeMachine,
} from './gym';
import { agilityTime } from './gymStats';
import { canReadShelf, INTEL } from './library';
import { eatConsumable, needStamina, spendStamina, STAMINA } from './stamina';
import { CONFISCATION, entriesOf, reclaimByBribe } from './confiscation';
import { containerPut, containerTake } from './containers';
import { dropItem, pickupAll, pickupFloor, throwItem } from './floor';
import { PRISON_MAP, type Interactable } from './map';
import { distanceToInteractable } from './proximity';
import { npcBuy, npcTalk, reportInmate } from './npc';
import {
  abandonQuest,
  acceptQuest,
  applyQuestEvent,
  completeQuest,
  contributeQuest,
} from './quests';
import { PRICES } from './economy';
import { nextRandom } from './rng';
import {
  canCarry,
  clockInfo,
  emit,
  gainSkill,
  journal,
  lieOnBed,
  maxSlots,
  nextId,
  periodAt,
  recordViolation,
  standUp,
  violationOf,
} from './rules';
import {
  tunnelComplete,
  tunnelOf,
  tunnelSpotId,
  supportsNeeded,
} from './tunnel';
import {
  crawlTunnel,
  leaveVehicle,
  startBlackout,
  startBoard,
  startFence,
} from './breakout';
import { hatch, placeDecor, startDig, takeDecor } from './digging';
import { bestTool, mostWornItem, TOOL_CONF } from './tools';
import type {
  ActionResult,
  Channel,
  ChannelKind,
  ErrorCode,
  ItemId,
  Outbox,
  PlayerAction,
  PlayerState,
  TunnelOp,
  WorldState,
} from './types';

const fail = (code: ErrorCode, message: string): ActionResult => ({
  ok: false,
  code,
  message,
});
const OK: ActionResult = { ok: true };

export { distanceToInteractable };

function inRange(
  p: PlayerState,
  id: string,
  range = C.interaction.range,
): boolean {
  const it = PRISON_MAP.interactableById[id];
  return !!it && distanceToInteractable(p, it) <= range;
}

function startChannel(
  world: WorldState,
  p: PlayerState,
  kind: ChannelKind,
  targetId: string,
  seconds: number,
  extra: Partial<Channel> = {},
): ActionResult {
  if (p.channel && p.channel.kind !== 'sleep')
    return fail('CONFLICT', 'Bạn đang làm việc khác');
  // mọi thao tác có tiến trình chạy theo hệ số thời gian (ngủ thì không có hạn)
  const duration = kind === 'sleep' ? seconds : actionSeconds(seconds);
  p.channel = {
    kind,
    targetId,
    elapsed: 0,
    duration,
    startX: p.x,
    startY: p.y,
    ...extra,
  };
  return { ok: true, data: { channel: kind, duration } };
}

/** Kỹ năng Khéo léo rút ngắn thao tác khoá / phá */
function dexterityTime(p: PlayerState): number {
  return Math.max(0.5, 1 - p.skills.dexterity / 250);
}

function someoneChanneling(
  world: WorldState,
  kind: ChannelKind,
  targetId: string,
  exceptId: string,
): boolean {
  return world.playerOrder.some(
    (id) =>
      id !== exceptId &&
      world.players[id]?.channel?.kind === kind &&
      world.players[id]?.channel?.targetId === targetId,
  );
}

// ------------------------------------------------------------------ tương tác

function interact(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  targetId: string,
): ActionResult {
  if (world.floorItems[targetId]) return pickupFloor(world, out, p, targetId);
  const it = PRISON_MAP.interactableById[targetId];
  if (!it) return fail('NOT_FOUND', 'Không có gì để tương tác');
  // đang trốn trong xe: bấm vào xe để chui ra
  if (p.vehicle)
    return it.kind === 'vehicle'
      ? leaveVehicle(world, out, p)
      : fail('INVALID_STATE', 'Bạn đang nằm trốn trong xe');
  if (distanceToInteractable(p, it) > C.interaction.range)
    return fail('OUT_OF_RANGE', 'Bạn ở quá xa');
  const mods = ROLE_MODIFIERS[p.role];
  const start = (
    kind: ChannelKind,
    id: string,
    seconds: number,
    extra?: Partial<Channel>,
  ) => startChannel(world, p, kind, id, seconds, extra);
  switch (it.kind) {
    case 'container':
      // mở modal lưới ô: cất vào / lấy ra qua containerPut / containerTake
      return { ok: true, data: { opened: 'container' } };
    case 'shop':
    case 'workbench':
    case 'stash':
    case 'hideSpot':
    case 'tunnelSpot':
    case 'gate':
      return { ok: true, data: { opened: it.kind } };
    case 'bed': {
      // đang nằm trên chính giường này: bấm lần nữa = Dậy
      if (p.bed === it.id) return wakeUp(world, out, p);
      const can = canSleepIn(world, p, it);
      if (!can.ok) return can;
      if (world.time - p.bedToggleAt < C.sleep.toggleDebounceSeconds)
        return fail('RATE_LIMITED', 'Chậm lại một chút');
      // ngủ mọi lúc, kể cả khi thể lực đã đầy (nằm chờ thời gian); không tự dậy khi đầy
      if (p.channel && p.channel.kind !== 'sleep')
        return fail('CONFLICT', 'Bạn đang làm việc khác');
      // nằm vào đúng điểm nằm của giường, theo chiều giường — khoá nhân vật tới khi Dậy
      lieOnBed(world, p, it.id);
      p.bedToggleAt = world.time;
      return startChannel(world, p, 'sleep', it.id, 1e9);
    }
    case 'evidenceLocker': {
      if (!entriesOf(world, p.id).length)
        return fail('NOT_FOUND', 'Không có đồ nào của bạn trong tủ tang vật');
      if (p.channel && p.channel.kind !== 'sleep')
        return fail('CONFLICT', 'Bạn đang làm việc khác');
      {
        // có dụng cụ cậy (xà beng…) thì phá nhanh hơn
        const pry = bestTool(p, 'pry');
        return startChannel(
          world,
          p,
          'breakIn',
          it.id,
          (CONFISCATION.breakInSeconds * dexterityTime(p)) /
            Math.max(1, pry?.efficiency ?? 1),
          pry ? { itemId: pry.itemId } : {},
        );
      }
    }
    case 'bookshelf': {
      const no = canReadShelf(world, p, it);
      if (no) return no;
      return startChannel(world, p, 'read', it.id, INTEL.shelfReadSeconds);
    }
    case 'gym': {
      // bấm vào máy tập = tập luôn máy trống gần nhất (không còn bảng chọn máy)
      const mid = nearestFreeMachine(world, p);
      if (!mid) return fail('CONFLICT', 'Máy đang bận');
      return gymStart(world, out, p, mid);
    }
    case 'shower':
      // vòi sen luôn xả nước: chỉ cần đứng ở ô dưới vòi là hồi thể lực
      return { ok: true, data: { opened: 'shower' } };
    case 'job': {
      const period = periodAt(clockInfo(world.totalGameMinutes).minuteOfDay);
      if (!period.workShift)
        return fail(
          'INVALID_STATE',
          'Chỉ làm việc trong giờ làm nhiệm vụ (09:00–11:00, 13:00–15:00)',
        );
      return startChannel(world, p, 'work', it.id, PRICES.jobs.shiftSeconds);
    }
    case 'cameraPanel':
      return startChannel(
        world,
        p,
        'cameraPanel',
        it.id,
        C.interaction.cameraPanelSeconds *
          ROLE_MODIFIERS[p.role].channelTime *
          dexterityTime(p),
      );
    case 'vent':
      if (world.routes.ventOpen)
        return fail('INVALID_STATE', 'Lưới thông gió đã được cậy');
      {
        // dụng cụ cậy tốt nhất: xà beng (nhanh, ồn) > tua vít > dao mài / dao đa năng
        const pry = bestTool(p, 'pry');
        if (!pry)
          return fail(
            'ITEM_NOT_OWNED',
            'Cần dụng cụ cậy: Tua vít, Dao mài, Xà beng hoặc Dao đa năng',
          );
        return startChannel(
          world,
          p,
          'openVent',
          it.id,
          (C.interaction.openVentSeconds *
            mods.channelTime *
            dexterityTime(p) *
            agilityTime(p)) /
            pry.efficiency,
          { itemId: pry.itemId },
        );
      }
    case 'fence':
      return startFence(world, p, it, start);
    case 'powerPanel':
      return startBlackout(world, p, it, start);
    case 'vehicle':
      return startBoard(world, p, it, start);
    case 'solitaryDoor': {
      const prisoner = world.playerOrder
        .map((id) => world.players[id])
        .find(
          (q) =>
            q && q.status === 'CAPTURED' && q.solitaryCell === it.solitaryIndex,
        );
      if (!prisoner) return fail('INVALID_STATE', 'Phòng biệt giam trống');
      return rescueStart(world, p, prisoner.id, it.id);
    }
  }
  return fail('INVALID_STATE', 'Không thể tương tác');
}

/** Dậy khỏi giường (nút "Dậy" / bấm lại giường) — có chống bấm lặp 300 ms */
function wakeUp(world: WorldState, out: Outbox, p: PlayerState): ActionResult {
  if (!p.bed) return fail('INVALID_STATE', 'Bạn không nằm trên giường');
  if (world.time - p.bedToggleAt < C.sleep.toggleDebounceSeconds)
    return fail('RATE_LIMITED', 'Chậm lại một chút');
  if (p.channel?.kind === 'sleep') p.channel = null;
  standUp(world, p);
  p.bedToggleAt = world.time;
  out.dirtyInventories.add(p.id);
  return { ok: true };
}

function rescueStart(
  world: WorldState,
  p: PlayerState,
  targetPlayerId: string,
  rescuePointId: string,
): ActionResult {
  const target = world.players[targetPlayerId];
  if (!target || target.id === p.id)
    return fail('NOT_FOUND', 'Không tìm thấy đồng đội');
  if (target.status !== 'CAPTURED' || target.solitaryCell === null)
    return fail('INVALID_STATE', 'Đồng đội không bị giam');
  const door = PRISON_MAP.solitaryCells[target.solitaryCell].doorId;
  if (rescuePointId !== door)
    return fail('INVALID_PAYLOAD', 'Sai cửa biệt giam');
  if (!inRange(p, door))
    return fail('OUT_OF_RANGE', 'Hãy tới sát cửa biệt giam');
  const pick = bestTool(p, 'pick');
  if (!pick)
    return fail(
      'ITEM_NOT_OWNED',
      'Cần Kẹp mở khoá (hoặc Bộ mở khoá tinh / Dao đa năng)',
    );
  if (someoneChanneling(world, 'rescue', target.id, p.id))
    return fail('CONFLICT', 'Đồng đội khác đang giải cứu');
  return startChannel(
    world,
    p,
    'rescue',
    target.id,
    (C.rescue.rescueSeconds *
      ROLE_MODIFIERS[p.role].channelTime *
      dexterityTime(p)) /
      pick.efficiency,
    { itemId: pick.itemId },
  );
}

function revive(
  world: WorldState,
  p: PlayerState,
  targetPlayerId: string,
): ActionResult {
  const target = world.players[targetPlayerId];
  if (!target || target.id === p.id)
    return fail('NOT_FOUND', 'Không tìm thấy đồng đội');
  if (target.status !== 'KNOCKED_OUT')
    return fail('INVALID_STATE', 'Đồng đội không bị hạ gục');
  if (dist(p.x, p.y, target.x, target.y) > C.interaction.range)
    return fail('OUT_OF_RANGE', 'Hãy tới gần đồng đội');
  if (someoneChanneling(world, 'revive', target.id, p.id))
    return fail('CONFLICT', 'Đồng đội khác đang hồi sinh');
  return startChannel(world, p, 'revive', target.id, C.rescue.reviveSeconds);
}

// ------------------------------------------------------------------ túi đồ, kho nhóm, chế tạo

/** Kiểm tra công thức (dùng khi bắt đầu và khi hoàn tất) */
export function craftCheck(
  world: WorldState,
  p: PlayerState,
  recipeId: string,
): ActionResult {
  const r = RECIPE_BY_ID[recipeId];
  if (!r) return fail('NOT_FOUND', 'Không có công thức này');
  for (const inp of r.ingredients)
    if (countItem(p.inventory, inp.itemId) < inp.quantity)
      return fail('INSUFFICIENT_ITEMS', `Thiếu ${ITEM_DEFS[inp.itemId].name}`);
  if (p.stats.intelligence < r.intelligenceRequired)
    return fail(
      'REQUIREMENTS_NOT_MET',
      `Cần ${r.intelligenceRequired} điểm thông minh (bạn có ${p.stats.intelligence}) — đọc sách ở thư viện`,
    );
  if (!bagFits(p, [{ itemId: r.output, quantity: 1 }], r.ingredients))
    return fail('OVER_CAPACITY', 'Túi chính đã đầy 6 ô');
  return { ok: true };
}

/**
 * Tỉ lệ thành công theo chênh lệch thông minh − ngưỡng: vừa đủ 70%, dư 10 điểm trở lên 95% (trần).
 * Khéo tay & vai trò Thợ máy cộng thêm một chút, vẫn không vượt 95%. Thiếu điểm = 0.
 */
export function craftSuccessChance(
  p: Pick<PlayerState, 'role' | 'skills' | 'stats'>,
  recipeId: string,
): number {
  const r = RECIPE_BY_ID[recipeId];
  const K = C.crafting;
  const surplus = p.stats.intelligence - r.intelligenceRequired;
  if (surplus < 0) return 0;
  const chance =
    K.baseSuccess +
    surplus * K.successPerSurplusPoint +
    (p.skills.crafting / 100) * K.skillBonusPer100 +
    (ROLE_MODIFIERS[p.role].craftBonus ? K.roleBonus : 0);
  return Math.round(Math.min(K.maxSuccess, chance) * 1e4) / 1e4;
}

/** Thất bại: mất 50% tổng số nguyên liệu (làm tròn), lấy từ nguyên liệu nhiều nhất trước */
export function craftFailureLoss(
  recipeId: string,
): { itemId: ItemId; quantity: number }[] {
  const r = RECIPE_BY_ID[recipeId];
  const total = r.ingredients.reduce((s, i) => s + i.quantity, 0);
  let left = Math.round(total * C.crafting.failLossFraction);
  const lost: { itemId: ItemId; quantity: number }[] = [];
  const order = [...r.ingredients].sort((a, b) => b.quantity - a.quantity);
  // lần lượt bớt mỗi loại một món cho đều, tới khi đủ số cần mất
  const taken = new Map<ItemId, number>();
  while (left > 0) {
    let progressed = false;
    for (const ing of order) {
      if (left <= 0) break;
      const t = taken.get(ing.itemId) ?? 0;
      if (t >= ing.quantity) continue;
      taken.set(ing.itemId, t + 1);
      left -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const [itemId, quantity] of taken) lost.push({ itemId, quantity });
  return lost;
}

/** Chế tạo tức thì ở bất kỳ đâu: không thanh tiến trình, không bị gián đoạn; −1 thể lực mỗi lần */
function craft(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  recipeId: string,
): ActionResult {
  const chk = craftCheck(world, p, recipeId);
  if (!chk.ok) return chk;
  const r = RECIPE_BY_ID[recipeId];
  spendStamina(p, C.stamina.craftStaminaCost);
  // cai ngục / camera nhìn thấy đúng lúc chế tạo -> vi phạm (đồ cấm: nặng)
  p.lastCraftAt = world.time;
  p.lastCraftContraband = !!ITEM_DEFS[r.output].contraband;
  const witness = world.guards.find(
    (g) => g.downUntil <= 0 && canGuardSee(world, g, p),
  );
  if (witness) {
    const v = violationOf(world, p);
    if (v) {
      recordViolation(world, out, p, v, witness.name);
      // đồ cấm: cai ngục chú ý ngay
      if (v.severity === 'serious')
        p.stats.personalHeat = Math.max(
          p.stats.personalHeat,
          C.heat.chaseThreshold,
        );
    }
  }
  const success = completeCraft(world, out, p, recipeId);
  return { ok: true, data: { success, output: r.output } };
}

/** Chế tạo: thành công theo tỉ lệ (thông minh, Khéo tay); thất bại mất 50% nguyên liệu. Trả về thành công hay không. */
export function completeCraft(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  recipeId: string,
): boolean {
  if (!craftCheck(world, p, recipeId).ok) return false;
  const r = RECIPE_BY_ID[recipeId];
  const def = ITEM_DEFS[r.output];
  out.dirtyInventories.add(p.id);
  if (nextRandom(world) >= craftSuccessChance(p, recipeId)) {
    const lost = craftFailureLoss(recipeId);
    for (const l of lost) removeItem(p.inventory, l.itemId, l.quantity);
    gainSkill(p, 'crafting', C.skills.craftGain / 2);
    journal(
      world,
      out,
      'craft',
      `${p.name} chế tạo ${def.name} thất bại (mất ${lost.map((l) => `${l.quantity} ${ITEM_DEFS[l.itemId].name}`).join(', ')})`,
      p.id,
    );
    emit(world, out, {
      type: 'crafting:failed',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: `❌ Chế tạo ${def.name} thất bại`,
    });
    return false;
  }
  for (const inp of r.ingredients)
    removeItem(p.inventory, inp.itemId, inp.quantity);
  if (def.isDecoy)
    p.inventory.push({
      itemId: r.output,
      quantity: 1,
      quality: decoyRealism(p),
    });
  else {
    const dur =
      def.maxDurability !== undefined
        ? def.maxDurability + (ROLE_MODIFIERS[p.role].craftBonus ? 1 : 0)
        : undefined;
    giveItems(world, out, p, [
      {
        itemId: r.output,
        quantity: 1,
        ...(dur !== undefined ? { durability: dur } : {}),
      },
    ]);
  }
  gainSkill(p, 'crafting', C.skills.craftGain);
  journal(world, out, 'craft', `${p.name} chế tạo ${def.name}`, p.id);
  const ev = emit(world, out, {
    type: 'crafting:result',
    playerId: p.id,
    audit: true,
    x: p.x,
    y: p.y,
    data: { recipeId, output: r.output },
    text: `🛠️ ${p.name} chế tạo ${def.name}`,
  });
  applyQuestEvent(world, out, {
    eventId: ev.id,
    type: 'CRAFT',
    playerId: p.id,
    targetId: r.output,
    amount: 1,
  });
  return true;
}

function deposit(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  itemId: PlayerState['inventory'][number]['itemId'],
  quantity: number,
): ActionResult {
  if (!inRange(p, 'stash'))
    return fail('OUT_OF_RANGE', 'Hãy tới Kho nhóm (cuối hành lang)');
  const ts = world.teamStorage;
  if (!ts.authorizedPlayerIds.includes(p.id))
    return fail('FORBIDDEN', 'Không có quyền dùng kho');
  if (countItem(p.inventory, itemId) < quantity)
    return fail('INSUFFICIENT_ITEMS', 'Không đủ vật phẩm');
  if (slotsAfter(ts.items, [], [{ itemId, quantity }]) > ts.maxSlots)
    return fail('OVER_CAPACITY', 'Kho nhóm đã đầy');
  addTaken(ts.items, removeItem(p.inventory, itemId, quantity));
  ts.version += 1;
  out.dirtyInventories.add(p.id);
  out.dirtyTeamStorage = true;
  emit(world, out, {
    type: 'team-storage:deposit',
    playerId: p.id,
    audit: true,
    data: { itemId, quantity },
  });
  return { ok: true, data: { version: ts.version } };
}

function withdraw(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  itemId: PlayerState['inventory'][number]['itemId'],
  quantity: number,
): ActionResult {
  if (!inRange(p, 'stash'))
    return fail('OUT_OF_RANGE', 'Hãy tới Kho nhóm (cuối hành lang)');
  const ts = world.teamStorage;
  if (!ts.authorizedPlayerIds.includes(p.id))
    return fail('FORBIDDEN', 'Không có quyền dùng kho');
  if (countItem(ts.items, itemId) < quantity)
    return fail('INSUFFICIENT_ITEMS', 'Kho không đủ vật phẩm');
  if (!bagFits(p, [{ itemId, quantity }]))
    return fail('OVER_CAPACITY', 'Túi chính đã đầy 6 ô');
  giveItems(world, out, p, removeItem(ts.items, itemId, quantity));
  ts.version += 1;
  out.dirtyInventories.add(p.id);
  out.dirtyTeamStorage = true;
  emit(world, out, {
    type: 'team-storage:withdraw',
    playerId: p.id,
    audit: true,
    data: { itemId, quantity },
  });
  return { ok: true, data: { version: ts.version } };
}

// ------------------------------------------------------------------ giao dịch

function hasAll(
  p: PlayerState,
  list: {
    itemId: PlayerState['inventory'][number]['itemId'];
    quantity: number;
  }[],
): boolean {
  const need = new Map<string, number>();
  for (const it of list)
    need.set(it.itemId, (need.get(it.itemId) ?? 0) + it.quantity);
  for (const [id, q] of need)
    if (
      countItem(p.inventory, id as PlayerState['inventory'][number]['itemId']) <
      q
    )
      return false;
  return true;
}

function closeTrade(world: WorldState, tradeId: string): void {
  delete world.trades[tradeId];
  world.closedTradeIds.push(tradeId);
  if (world.closedTradeIds.length > 200)
    world.closedTradeIds.splice(0, world.closedTradeIds.length - 200);
}

function tradeRequest(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  a: Extract<PlayerAction, { type: 'tradeRequest' }>,
): ActionResult {
  const t = world.players[a.targetPlayerId];
  if (!t || t.id === p.id)
    return fail('NOT_FOUND', 'Không tìm thấy người nhận');
  if (t.status !== 'ACTIVE' || !t.connected)
    return fail('INVALID_STATE', 'Người nhận không thể giao dịch lúc này');
  if (dist(p.x, p.y, t.x, t.y) > C.interaction.tradeRange)
    return fail('OUT_OF_RANGE', 'Hãy đứng gần nhau hơn để giao dịch');
  if (!a.offered.length && !a.requested.length)
    return fail('INVALID_PAYLOAD', 'Giao dịch trống');
  if (!hasAll(p, a.offered))
    return fail('INSUFFICIENT_ITEMS', 'Bạn không đủ vật phẩm để đề nghị');
  if (
    Object.values(world.trades).some(
      (x) => x.fromId === p.id && x.toId === t.id,
    )
  )
    return fail('CONFLICT', 'Đã có đề nghị đang chờ');
  const id = nextId(world, 'trade_');
  world.trades[id] = {
    id,
    fromId: p.id,
    toId: t.id,
    offered: a.offered.map((x) => ({ ...x })),
    requested: a.requested.map((x) => ({ ...x })),
    createdAt: world.time,
  };
  out.dirtyTrades.add(p.id).add(t.id);
  emit(world, out, {
    type: 'player:trade-offer',
    playerId: p.id,
    targetId: t.id,
    data: { tradeId: id },
    text: `🤝 ${p.name} gửi đề nghị giao dịch cho ${t.name}`,
  });
  return { ok: true, data: { tradeId: id } };
}

/** Chấp nhận: kiểm tra lại sở hữu + sức chứa NGAY LÚC commit, rồi hoán đổi trong cùng một bước */
function tradeAccept(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  tradeId: string,
): ActionResult {
  const tr = world.trades[tradeId];
  if (!tr)
    return world.closedTradeIds.includes(tradeId)
      ? fail('DUPLICATE_REQUEST', 'Giao dịch đã được xử lý')
      : fail('NOT_FOUND', 'Không có giao dịch này');
  if (tr.toId !== p.id)
    return fail('FORBIDDEN', 'Chỉ người nhận mới được chấp nhận');
  const from = world.players[tr.fromId];
  if (!from || from.status !== 'ACTIVE' || p.status !== 'ACTIVE') {
    closeTrade(world, tradeId);
    out.dirtyTrades.add(tr.fromId).add(tr.toId);
    return fail('INVALID_STATE', 'Giao dịch không còn hiệu lực');
  }
  if (dist(p.x, p.y, from.x, from.y) > C.interaction.tradeRange)
    return fail('OUT_OF_RANGE', 'Hai người đã đi quá xa nhau');
  if (!hasAll(from, tr.offered) || !hasAll(p, tr.requested)) {
    closeTrade(world, tradeId);
    out.dirtyTrades.add(tr.fromId).add(tr.toId);
    return fail(
      'INSUFFICIENT_ITEMS',
      'Một bên không còn đủ vật phẩm — giao dịch huỷ',
    );
  }
  const asItems = (l: typeof tr.offered) =>
    l.map((x) => ({ itemId: x.itemId, quantity: x.quantity }));
  if (
    slotsAfter(from.inventory, tr.offered, asItems(tr.requested)) >
      maxSlots(from) ||
    slotsAfter(p.inventory, tr.requested, asItems(tr.offered)) > maxSlots(p)
  )
    return fail('OVER_CAPACITY', 'Túi đồ của một bên sẽ quá đầy');
  const fromTaken = tr.offered.flatMap((x) =>
    removeItem(from.inventory, x.itemId, x.quantity),
  );
  const toTaken = tr.requested.flatMap((x) =>
    removeItem(p.inventory, x.itemId, x.quantity),
  );
  addTaken(p.inventory, fromTaken);
  addTaken(from.inventory, toTaken);
  closeTrade(world, tradeId);
  out.dirtyInventories.add(from.id).add(p.id);
  out.dirtyTrades.add(from.id).add(p.id);
  emit(world, out, {
    type: 'player:trade-completed',
    playerId: from.id,
    targetId: p.id,
    audit: true,
    data: {
      tradeId,
      offered: JSON.stringify(tr.offered),
      requested: JSON.stringify(tr.requested),
    },
    text: `🤝 ${from.name} ⇄ ${p.name}: giao dịch hoàn tất`,
  });
  return { ok: true, data: { tradeId } };
}

function tradeDecline(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  tradeId: string,
): ActionResult {
  const tr = world.trades[tradeId];
  if (!tr) return fail('NOT_FOUND', 'Không có giao dịch này');
  if (tr.toId !== p.id && tr.fromId !== p.id)
    return fail('FORBIDDEN', 'Không phải giao dịch của bạn');
  closeTrade(world, tradeId);
  out.dirtyTrades.add(tr.fromId).add(tr.toId);
  return OK;
}

// ------------------------------------------------------------------ giấu đồ, hầm, đồ dùng, mua chuộc

function spotOf(p: PlayerState, spotId: string): Interactable | ActionResult {
  const it = PRISON_MAP.interactableById[spotId];
  if (!it || it.kind !== 'hideSpot')
    return fail('NOT_FOUND', 'Không có chỗ giấu này');
  if (distanceToInteractable(p, it) > C.interaction.range)
    return fail('OUT_OF_RANGE', 'Hãy tới gần chỗ giấu');
  return it;
}

function hide(
  world: WorldState,
  p: PlayerState,
  spotId: string,
  itemId: ItemId,
  quantity: number,
): ActionResult {
  const it = spotOf(p, spotId);
  if ('ok' in it) return it;
  if (countItem(p.inventory, itemId) < quantity)
    return fail('INSUFFICIENT_ITEMS', 'Không đủ vật phẩm');
  if (
    slotsAfter(world.hideSpots[spotId] ?? [], [], [{ itemId, quantity }]) >
    (it.capacity ?? 4)
  )
    return fail('OVER_CAPACITY', 'Chỗ giấu đã đầy');
  return startChannel(world, p, 'hide', spotId, C.interaction.hideSeconds, {
    itemId,
    quantity,
  });
}

function retrieve(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  spotId: string,
  itemId: ItemId,
  quantity: number,
): ActionResult {
  const it = spotOf(p, spotId);
  if ('ok' in it) return it;
  const items = (world.hideSpots[spotId] ??= []);
  if (countItem(items, itemId) < quantity)
    return fail('INSUFFICIENT_ITEMS', 'Chỗ giấu không có đủ');
  const taken = removeItem(items, itemId, quantity);
  if (!bagFits(p, taken)) {
    addTaken(items, taken);
    return fail('OVER_CAPACITY', 'Túi chính đã đầy 6 ô');
  }
  giveItems(world, out, p, taken);
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  return { ok: true };
}

function flush(
  world: WorldState,
  p: PlayerState,
  spotId: string,
): ActionResult {
  if (!spotId.startsWith('toilet_'))
    return fail('INVALID_PAYLOAD', 'Chỉ xả được ở bồn cầu');
  const it = spotOf(p, spotId);
  if ('ok' in it) return it;
  if (!countItem(p.inventory, 'dirt'))
    return fail('ITEM_NOT_OWNED', 'Bạn không mang đất');
  return startChannel(world, p, 'flush', spotId, C.interaction.flushSeconds);
}

function tunnelAction(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  cellIndex: number,
  op: TunnelOp,
): ActionResult {
  const spot = PRISON_MAP.interactableById[tunnelSpotId(cellIndex)];
  if (!spot) return fail('NOT_FOUND', 'Không có chỗ đào này');
  if (distanceToInteractable(p, spot) > C.interaction.range)
    return fail('OUT_OF_RANGE', 'Hãy tới góc sàn phòng giam');
  const t = tunnelOf(world, cellIndex);
  const speed = Math.max(0.5, 1 - p.skills.fitness / 250);
  switch (op) {
    case 'crawl':
      return crawlTunnel(world, out, p, cellIndex);
    case 'dig':
      if (tunnelComplete(t)) return fail('INVALID_STATE', 'Đường hầm đã thông');
      if (!countItem(p.inventory, 'shovel'))
        return fail('ITEM_NOT_OWNED', 'Cần Dụng cụ đào');
      if (!canCarry(p, 'dirt'))
        return fail('OVER_CAPACITY', 'Túi đầy — cần chỗ chứa đất');
      {
        const low = needStamina(p, STAMINA.digCost);
        if (low) return low;
      }
      return startChannel(
        world,
        p,
        'dig',
        spot.id,
        C.tunnel.digSeconds * speed * agilityTime(p),
        { recipeId: String(cellIndex) },
      );
    case 'support':
      if (t.progress === 0)
        return fail('INVALID_STATE', 'Chưa có hầm để chống');
      if (t.supports >= supportsNeeded(C.tunnel.segments))
        return fail('INVALID_STATE', 'Đã đủ thanh chống');
      if (!countItem(p.inventory, 'support'))
        return fail('ITEM_NOT_OWNED', 'Cần Thanh chống');
      return startChannel(
        world,
        p,
        'support',
        spot.id,
        C.tunnel.supportSeconds,
        { recipeId: String(cellIndex) },
      );
    case 'cover':
      if (t.progress === 0 || t.covered)
        return fail('INVALID_STATE', 'Không có gì để che');
      return startChannel(world, p, 'cover', spot.id, C.tunnel.coverSeconds, {
        recipeId: String(cellIndex),
      });
  }
}

/**
 * Chế tạo nhiều lần trong MỘT yêu cầu (×1 / ×5 / tối đa, tối đa 10): mỗi lần kiểm tra lại nguyên liệu,
 * thông minh, sức chứa; dừng ngay khi không đủ điều kiện. Cùng requestId không chế tạo hai lần.
 */
function craftMany(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  recipeId: string,
  quantity: number,
): ActionResult {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10)
    return fail('INVALID_PAYLOAD', 'Số lượng chế tạo 1–10');
  let attempts = 0;
  let made = 0;
  let stoppedBy: string | null = null;
  for (let i = 0; i < quantity; i++) {
    const r = craft(world, out, p, recipeId);
    if (!r.ok) {
      if (attempts === 0) return r;
      stoppedBy = r.message;
      break;
    }
    attempts++;
    if (r.data?.success) made++;
  }
  return {
    ok: true,
    data: {
      output: RECIPE_BY_ID[recipeId].output,
      attempts,
      made,
      success: made > 0,
      ...(stoppedBy ? { stoppedBy } : {}),
    },
  };
}

function applyUseItem(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  itemId: ItemId,
): ActionResult {
  if (!countItem(p.inventory, itemId))
    return fail('ITEM_NOT_OWNED', 'Bạn không có món này');
  const def = ITEM_DEFS[itemId];
  out.dirtyInventories.add(p.id);
  if (itemId === 'repair_kit') {
    // phục hồi một phần độ bền cho món mòn nhất, không vượt độ bền tối đa
    const it = mostWornItem(p);
    if (!it)
      return fail('INVALID_STATE', 'Không có công cụ / vũ khí nào cần sửa');
    const max = ITEM_DEFS[it.itemId].maxDurability!;
    const before = it.durability ?? max;
    it.durability = Math.min(
      max,
      before + Math.ceil(max * TOOL_CONF.repairKit.restoreFraction),
    );
    removeItem(p.inventory, 'repair_kit', 1);
    emit(world, out, {
      type: 'item:repaired',
      playerId: p.id,
      data: { itemId: it.itemId, durability: it.durability },
      text: `🛠️ Sửa ${ITEM_DEFS[it.itemId].name}: độ bền ${before} → ${it.durability}/${max}`,
    });
    return {
      ok: true,
      data: { used: itemId, repaired: it.itemId, durability: it.durability },
    };
  }
  if (itemId === 'firecracker') {
    if (p.underground)
      return fail('INVALID_STATE', 'Không ném được khi đang dưới hầm');
    // ném ra phía trước: tiếng nổ dụ cai ngục gần đó tới xem chỗ nổ (không phải chỗ người ném)
    const d = TOOL_CONF.firecracker.throwDistance;
    const pos = {
      x: p.x + Math.cos(p.facing) * d,
      y: p.y + Math.sin(p.facing) * d,
    };
    removeItem(p.inventory, 'firecracker', 1);
    alertGuardsTo(world, pos, TOOL_CONF.firecracker.alertRadius);
    emit(world, out, {
      type: 'item:firecracker',
      playerId: p.id,
      x: pos.x,
      y: pos.y,
      text: '🧨 Bùm! Tiếng nổ thu hút cai ngục',
    });
    return { ok: true, data: { used: itemId } };
  }
  if (itemId === 'map_sketch') {
    removeItem(p.inventory, 'map_sketch', 1);
    world.intelUntil = Math.max(
      world.intelUntil,
      world.time + TOOL_CONF.mapSketchSeconds,
    );
    out.dirtyMeta = true;
    emit(world, out, {
      type: 'item:map-sketch',
      playerId: p.id,
      text: `🗺️ Sơ đồ chép tay: thấy vị trí cai ngục trong ${TOOL_CONF.mapSketchSeconds} giây`,
    });
    return { ok: true, data: { used: itemId } };
  }
  if (itemId === 'food') {
    removeItem(p.inventory, 'food', 1);
    p.stats.hunger = Math.max(0, p.stats.hunger - C.needs.foodHunger);
    return { ok: true, data: { used: itemId } };
  }
  if (itemId === 'bandage') {
    removeItem(p.inventory, 'bandage', 1);
    p.stats.health = Math.min(p.stats.maxHealth, p.stats.health + 35);
    return { ok: true, data: { used: itemId } };
  }
  if (def.slotType === 'outfit')
    return wearFromBag(
      world,
      out,
      p,
      p.inventory.findIndex((i) => i.itemId === itemId),
    );
  if (def.consumable) {
    const r = eatConsumable(p, world.time, itemId);
    if (!r.ok) return r;
    removeItem(p.inventory, itemId, 1);
    emit(world, out, {
      type: 'item:eaten',
      playerId: p.id,
      data: { itemId, stamina: Number(r.data?.stamina ?? 0) },
      text: `${def.glyph} Ăn ${def.name}: +${Math.round(Number(r.data?.stamina ?? 0))} thể lực`,
    });
    return r;
  }
  return fail('INVALID_STATE', 'Không thể dùng trực tiếp vật phẩm này');
}

function bribe(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  guardId: string,
): ActionResult {
  const g = world.guards.find((x) => x.id === guardId);
  if (!g) return fail('NOT_FOUND', 'Không có cai ngục này');
  if (dist(p.x, p.y, g.x, g.y) > C.interaction.npcRange)
    return fail('OUT_OF_RANGE', 'Đứng gần cai ngục hơn');
  if (g.state === 'CHASE' || g.state === 'SUSPICIOUS')
    return fail('INVALID_STATE', `${g.name} đang để ý bạn — không phải lúc`);
  const cost = Math.round(
    C.guard.bribe.cost * (1.2 - p.reputation.guards / 250),
  );
  if (p.money < cost) return fail('INSUFFICIENT_ITEMS', `Cần ${cost}$`);
  const day = clockInfo(world.totalGameMinutes).day;
  p.money -= cost;
  world.bribedCells[String(p.cellIndex)] = day;
  gainSkill(p, 'social', C.skills.socialGain);
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  if (
    nextRandom(world) <
    Math.max(0.03, C.guard.bribe.reportChance - p.skills.social / 500)
  ) {
    p.stats.personalHeat = Math.min(
      100,
      p.stats.personalHeat + C.guard.bribe.heatIfReported,
    );
    p.reputation.guards = Math.max(0, p.reputation.guards - 10);
    journal(
      world,
      out,
      'violation',
      `${g.name} nhận ${cost}$ nhưng báo cáo việc ${p.name} hối lộ`,
      p.id,
    );
    emit(world, out, {
      type: 'bribe:reported',
      playerId: p.id,
      text: `😠 ${g.name} báo cáo ${p.name} hối lộ!`,
    });
    return { ok: true, data: { reported: true, cost } };
  }
  journal(
    world,
    out,
    'event',
    `${p.name} mua chuộc ${g.name} (${cost}$) — bỏ qua khám phòng hôm nay`,
    p.id,
  );
  return { ok: true, data: { reported: false, cost } };
}

// ------------------------------------------------------------------ điều phối

/** Đang trên máy tập thì không làm các việc dùng tay / di chuyển */
const BLOCKED_ON_MACHINE = new Set<PlayerAction['type']>([
  'attack',
  'interact',
  'lootStart',
  'lootTake',
  'craft',
  'revive',
  'rescueStart',
  'escapeEnterPoint',
  'hide',
  'retrieve',
  'flush',
  'tunnel',
  'bedTake',
  'bedPlace',
  'containerTake',
  'containerPut',
  'equip',
  'wear',
  'takeOff',
  'dropWeapon',
  'dropItem',
  'throwItem',
  'pickupAll',
  'useItem',
]);
const ANY_STATUS = new Set<PlayerAction['type']>([
  'cancelChannel',
  'rescueCancel',
  'tradeDecline',
  'questAccept',
  'questAbandon',
  'questComplete',
  'escapeReady',
  'assist',
  'escapeCancel',
]);

function dispatch(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  a: PlayerAction,
  requestId: string,
): ActionResult {
  if (world.outcome) return fail('INVALID_STATE', 'Trận đã kết thúc');
  if (!ANY_STATUS.has(a.type) && p.status !== 'ACTIVE')
    return fail('INVALID_STATE', 'Bạn không thể hành động lúc này');
  // đang nằm (trạng thái ngủ): chỉ được Dậy / thao tác với chính giường đó
  if (
    p.bed &&
    (a.type === 'attack' ||
      a.type === 'lootStart' ||
      a.type === 'tunnel' ||
      a.type === 'dig' ||
      (a.type === 'interact' && a.targetId !== p.bed))
  )
    return fail('INVALID_STATE', 'Bạn đang nằm — bấm Dậy trước');
  // dưới hầm: không với tới đồ vật trên mặt đất
  if (
    p.underground &&
    (a.type === 'interact' ||
      a.type === 'attack' ||
      a.type === 'lootStart' ||
      a.type === 'tunnel' ||
      a.type === 'rescueStart' ||
      a.type === 'revive' ||
      a.type === 'takeDecor')
  )
    return fail('INVALID_STATE', 'Bạn đang ở dưới hầm');
  if (p.gym && BLOCKED_ON_MACHINE.has(a.type))
    return fail('CONFLICT', 'Bạn đang tập — bấm Nghỉ trước');
  switch (a.type) {
    case 'gymStart':
      return gymStart(world, out, p, a.machineId);
    case 'gymPress':
      return gymPress(world, out, p, a.side);
    case 'gymStop':
      return gymStop(world, out, p);
    case 'gymAnswer':
      return gymAnswer(world, out, p, a.yield);
    case 'interact':
      return interact(world, out, p, a.targetId);
    case 'cancelChannel':
    case 'rescueCancel':
      if (p.vehicle && !p.channel) return leaveVehicle(world, out, p);
      if (p.gym || p.gymQueued) gymStop(world, out, p);
      p.channel = null;
      return OK;
    case 'useItem':
      return applyUseItem(world, out, p, a.itemId);
    case 'dropItem':
      return dropItem(world, out, p, a.itemId, a.quantity);
    case 'throwItem':
      return throwItem(world, out, p, a.itemId, a.dirX, a.dirY);
    case 'pickupAll':
      return pickupAll(world, out, p);
    case 'craft':
      return craftMany(world, out, p, a.recipeId, a.quantity ?? 1);
    case 'attack':
      return attack(world, out, p);
    case 'lootStart':
      return lootStart(
        world,
        out,
        p,
        a.targetId,
        world.guards.some((g) => g.downUntil <= 0 && canGuardSee(world, g, p)),
      );
    case 'lootTake':
      return lootTake(world, p, a.targetId, a.slot, a.index);
    case 'lootClose':
      p.lootTarget = null;
      out.dirtyInventories.add(p.id);
      return OK;
    case 'wear':
      return wearFromBag(world, out, p, a.index);
    case 'takeOff':
      return takeOff(world, out, p);
    case 'dropWeapon':
      return dropWeapon(world, out, p);
    case 'answerChallenge':
      return answerChallenge(world, out, p, a.choice);
    case 'report':
      return reportInmate(world, out, p, a.npcId);
    case 'answerRollcall':
      return answerRollcall(world, out, p);
    case 'equip':
      return equipWeapon(world, out, p, a.itemId);
    case 'containerTake':
      return containerTake(
        world,
        out,
        p,
        a.containerId,
        a.index,
        a.itemId,
        a.quantity,
      );
    case 'containerPut':
      return containerPut(
        world,
        out,
        p,
        a.containerId,
        a.index,
        a.itemId,
        a.quantity,
      );
    case 'bedTake':
      return bedTake(world, out, p, a.bedId, a.what);
    case 'bedPlace':
      return bedPlace(world, out, p, a.bedId, a.what);
    case 'hide':
      return hide(world, p, a.spotId, a.itemId, a.quantity);
    case 'retrieve':
      return retrieve(world, out, p, a.spotId, a.itemId, a.quantity);
    case 'flush':
      return flush(world, p, a.spotId);
    case 'tunnel':
      return tunnelAction(world, out, p, a.cellIndex, a.op);
    case 'wake':
      return wakeUp(world, out, p);
    case 'dig':
      if (!Number.isInteger(a.x) || !Number.isInteger(a.y))
        return fail('INVALID_PAYLOAD', 'Ô không hợp lệ');
      return startDig(world, p, a.x, a.y, (kind, id, seconds, extra) =>
        startChannel(world, p, kind, id, seconds, extra),
      );
    case 'hatch':
      return hatch(world, out, p);
    case 'placeDecor':
      if (!Number.isInteger(a.x) || !Number.isInteger(a.y))
        return fail('INVALID_PAYLOAD', 'Ô không hợp lệ');
      return placeDecor(world, out, p, a.itemId, a.x, a.y);
    case 'takeDecor':
      if (!Number.isInteger(a.x) || !Number.isInteger(a.y))
        return fail('INVALID_PAYLOAD', 'Ô không hợp lệ');
      return takeDecor(world, out, p, a.x, a.y);
    case 'buy':
      if (!inRange(p, 'shop'))
        return fail('OUT_OF_RANGE', 'Hãy tới quầy căng tin');
      return buy(world, out, p, a.itemId);
    case 'sell':
      if (!inRange(p, 'shop'))
        return fail('OUT_OF_RANGE', 'Hãy tới quầy căng tin');
      return sell(world, out, p, a.itemId);
    case 'npcTalk':
      return npcTalk(world, out, p, a.npcId);
    case 'npcBuy':
      return npcBuy(world, out, p, a.npcId, a.itemId);
    case 'bribe':
      return bribe(world, out, p, a.guardId);
    case 'reclaimConfiscated': {
      const g = world.guards.find((x) => x.id === a.guardId);
      if (!g || g.downUntil > 0)
        return fail('NOT_FOUND', 'Không có cai ngục này');
      if (dist(p.x, p.y, g.x, g.y) > C.interaction.npcRange)
        return fail('OUT_OF_RANGE', 'Hãy tới gần cai ngục');
      if (g.state === 'CHASE' || g.state === 'SUSPICIOUS')
        return fail('INVALID_STATE', 'Cai ngục đang để ý bạn');
      return reclaimByBribe(world, out, p, g.name);
    }
    case 'deposit':
      return deposit(world, out, p, a.itemId, a.quantity);
    case 'withdraw':
      return withdraw(world, out, p, a.itemId, a.quantity);
    case 'tradeRequest':
      return tradeRequest(world, out, p, a);
    case 'tradeAccept':
      return tradeAccept(world, out, p, a.tradeId);
    case 'tradeDecline':
      return tradeDecline(world, out, p, a.tradeId);
    case 'questAccept':
      return acceptQuest(world, out, p, a.questId);
    case 'questAbandon':
      return abandonQuest(world, out, p, a.questId);
    case 'questComplete':
      return completeQuest(world, out, p, a.questId);
    case 'questContribute':
      return contributeQuest(
        world,
        out,
        p,
        a.questId,
        a.objectiveId,
        a.quantity,
        `req:${p.id}:${requestId}`,
      );
    case 'revive':
      return revive(world, p, a.targetPlayerId);
    case 'rescueStart':
      return rescueStart(world, p, a.targetPlayerId, a.rescuePointId);
    case 'assist': {
      if (p.status !== 'ESCAPED')
        return fail(
          'INVALID_STATE',
          'Chỉ người đã thoát mới hỗ trợ từ bên ngoài',
        );
      if (world.time < p.assistReadyAt)
        return fail('RATE_LIMITED', 'Đang hồi chiêu');
      world.intelUntil = world.time + C.assist.intelSeconds;
      p.assistReadyAt = world.time + C.assist.intelCooldownSeconds;
      out.dirtyMeta = true;
      emit(world, out, {
        type: 'player:assist-result',
        playerId: p.id,
        text: `📡 ${p.name} báo vị trí lính gác từ bên ngoài (${C.assist.intelSeconds}s)`,
      });
      return OK;
    }
    case 'escapePrepare':
      return prepareEscape(world, out, p, a.escapeMethod);
    case 'escapeReady':
      return setEscapeReady(world, out, p, a.ready);
    case 'escapeStart':
      return startEscape(world, out, p);
    case 'escapeEnterPoint':
      return enterEscapePoint(world, out, p, a.escapePointId);
    case 'escapeCancel':
      return cancelEscape(world, out, p);
  }
}

/**
 * Điểm vào duy nhất cho hành động. Cùng requestId gửi lại -> trả kết quả cũ (không thực hiện lần 2).
 */
export function applyAction(
  world: WorldState,
  out: Outbox,
  playerId: string,
  action: PlayerAction,
  requestId: string,
): ActionResult {
  const p = world.players[playerId];
  if (!p) return fail('NOT_ROOM_MEMBER', 'Bạn không ở trong phiên chơi này');
  const log = (world.requestLog[playerId] ??= []);
  const cached = log.find((c) => c.requestId === requestId);
  if (cached) return { ...cached.result, duplicate: true };
  const result = dispatch(world, out, p, action, requestId);
  log.push({ requestId, result });
  if (log.length > C.idempotency.keepPerPlayer)
    log.splice(0, log.length - C.idempotency.keepPerPlayer);
  return result;
}
