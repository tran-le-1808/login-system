// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Nhiệm vụ: định nghĩa tách khỏi tiến trình.
 * - Cá nhân: 1 bản ghi / người / quest.
 * - Nhóm & động: 1 bản ghi / phiên / quest (không nhân bản theo người).
 * Tiến trình chỉ tăng từ sự kiện engine đã xác minh, chống cộng trùng bằng sổ cái eventId.
 */
import { countItem, isItemId, removeItem } from './items';
import { emit, grantReward } from './rules';
import type {
  ActionResult,
  ItemId,
  Outbox,
  PlayerState,
  QuestProgress,
  QuestType,
  WorldState,
} from './types';

export type ObjectiveType =
  | 'VISIT'
  | 'SEARCH'
  | 'CRAFT'
  | 'DELIVER'
  | 'OPEN_ROUTE'
  | 'RESCUE';

export interface QuestObjectiveDef {
  objectiveId: string;
  type: ObjectiveType;
  targetId?: string;
  requiredAmount: number;
  label: string;
}

export interface QuestDef {
  questId: string;
  name: string;
  description: string;
  type: QuestType;
  objectives: QuestObjectiveDef[];
  rewards: { money: number; experience: number };
  /** Quest là điều kiện chuẩn bị đào tẩu */
  escapeRequirement?: boolean;
}

export const QUEST_DEFS: Record<string, QuestDef> = {
  p_explore: {
    questId: 'p_explore',
    name: 'Làm quen nhà tù',
    description: 'Đi một vòng để nắm địa hình.',
    type: 'PERSONAL',
    objectives: [
      {
        objectiveId: 'canteen',
        type: 'VISIT',
        targetId: 'canteen',
        requiredAmount: 1,
        label: 'Ghé nhà ăn',
      },
      {
        objectiveId: 'workshop',
        type: 'VISIT',
        targetId: 'workshop',
        requiredAmount: 1,
        label: 'Ghé xưởng',
      },
      {
        objectiveId: 'yard',
        type: 'VISIT',
        targetId: 'yard',
        requiredAmount: 1,
        label: 'Ra sân tập',
      },
    ],
    rewards: { money: 20, experience: 30 },
  },
  p_scavenge: {
    questId: 'p_scavenge',
    name: 'Nhặt nhạnh',
    description:
      'Mở tủ, thùng và lấy đồ ra để gom nguyên liệu (mỗi nơi tính một lần mỗi ngày).',
    type: 'PERSONAL',
    objectives: [
      {
        objectiveId: 'search',
        type: 'SEARCH',
        requiredAmount: 3,
        label: 'Lấy đồ từ 3 tủ / thùng khác nhau',
      },
    ],
    rewards: { money: 30, experience: 40 },
  },
  p_craft: {
    questId: 'p_craft',
    name: 'Tay nghề',
    description: 'Chế tạo một món đồ bất kỳ.',
    type: 'PERSONAL',
    objectives: [
      {
        objectiveId: 'craft',
        type: 'CRAFT',
        requiredAmount: 1,
        label: 'Chế tạo 1 món',
      },
    ],
    rewards: { money: 40, experience: 60 },
  },
  t_supplies: {
    questId: 't_supplies',
    name: 'Lương thực đào tẩu',
    description:
      'Cả đội góp bánh mì cho chuyến trốn. Bắt buộc trước khi lên kế hoạch thoát.',
    type: 'TEAM',
    objectives: [
      {
        objectiveId: 'food',
        type: 'DELIVER',
        targetId: 'food',
        requiredAmount: 2,
        label: 'Nộp 2 Bánh mì',
      },
    ],
    rewards: { money: 25, experience: 50 },
    escapeRequirement: true,
  },
  t_route: {
    questId: 't_route',
    name: 'Mở đường',
    description: 'Tháo nắp ống thông gió (xưởng) hoặc buộc dây lên tường sân.',
    type: 'TEAM',
    objectives: [
      {
        objectiveId: 'route',
        type: 'OPEN_ROUTE',
        requiredAmount: 1,
        label: 'Mở 1 lối thoát',
      },
    ],
    rewards: { money: 25, experience: 60 },
  },
};

export const RESCUE_QUEST_DEF: QuestDef = {
  questId: 'd_rescue',
  name: 'Giải cứu đồng đội',
  description: 'Dùng Kẹp mở khóa ở cửa biệt giam (thao tác 6 giây, khu cấm!).',
  type: 'DYNAMIC',
  objectives: [
    {
      objectiveId: 'rescue',
      type: 'RESCUE',
      requiredAmount: 1,
      label: 'Mở cửa biệt giam',
    },
  ],
  rewards: { money: 30, experience: 40 },
};

export function questDef(questId: string): QuestDef | null {
  if (questId.startsWith('d_rescue_')) return RESCUE_QUEST_DEF;
  return QUEST_DEFS[questId] ?? null;
}

const LEDGER_MAX = 600;

function blankProgress(def: QuestDef): Record<string, number> {
  return Object.fromEntries(def.objectives.map((o) => [o.objectiveId, 0]));
}

export function initPersonalQuests(world: WorldState, playerId: string): void {
  const list: Record<string, QuestProgress> = {};
  for (const def of Object.values(QUEST_DEFS))
    if (def.type === 'PERSONAL')
      list[def.questId] = {
        questId: def.questId,
        playerId,
        status: 'AVAILABLE',
        objectiveProgress: blankProgress(def),
        completedAt: null,
        version: 0,
      };
  world.personalQuests[playerId] = list;
}

export function initTeamQuests(world: WorldState): void {
  for (const def of Object.values(QUEST_DEFS))
    if (def.type === 'TEAM')
      world.teamQuests[def.questId] = {
        questId: def.questId,
        status: 'ACTIVE',
        objectiveProgress: blankProgress(def),
        completedAt: null,
        version: 0,
      };
}

function objectivesDone(def: QuestDef, q: QuestProgress): boolean {
  return def.objectives.every(
    (o) => (q.objectiveProgress[o.objectiveId] ?? 0) >= o.requiredAmount,
  );
}

function ledgerHas(world: WorldState, key: string): boolean {
  return world.contributionLedger.includes(key);
}
function ledgerAdd(world: WorldState, key: string): void {
  world.contributionLedger.push(key);
  if (world.contributionLedger.length > LEDGER_MAX)
    world.contributionLedger.splice(
      0,
      world.contributionLedger.length - LEDGER_MAX,
    );
}

/** Áp dụng sự kiện đã xác minh vào tiến trình (cá nhân của người gây ra + quest nhóm). Idempotent theo eventId. */
export function applyQuestEvent(
  world: WorldState,
  out: Outbox,
  ev: {
    eventId: string;
    type: ObjectiveType;
    playerId: string;
    targetId?: string;
    amount: number;
  },
): void {
  const bump = (scope: string, q: QuestProgress) => {
    const def = questDef(q.questId);
    if (!def || q.status !== 'ACTIVE') return;
    const key = `${scope}:${q.questId}:${ev.eventId}`;
    if (ledgerHas(world, key)) return;
    let changed = false;
    for (const o of def.objectives) {
      if (o.type !== ev.type || (o.targetId && o.targetId !== ev.targetId))
        continue;
      const cur = q.objectiveProgress[o.objectiveId] ?? 0;
      if (cur >= o.requiredAmount) continue;
      q.objectiveProgress[o.objectiveId] = Math.min(
        o.requiredAmount,
        cur + ev.amount,
      );
      changed = true;
    }
    if (changed) {
      ledgerAdd(world, key);
      q.version += 1;
      out.dirtyQuests.add(scope === 'team' ? 'team' : ev.playerId);
      emit(world, out, {
        type: 'quest:progress-updated',
        playerId: ev.playerId,
        data: { questId: q.questId, done: objectivesDone(def, q) },
      });
    }
  };
  const mine = world.personalQuests[ev.playerId];
  if (mine) for (const q of Object.values(mine)) bump(ev.playerId, q);
  for (const q of Object.values(world.teamQuests))
    if (q.questId.startsWith('t_')) bump('team', q);
}

const fail = (
  code: Extract<ActionResult, { ok: false }>['code'],
  message: string,
): ActionResult => ({ ok: false, code, message });

function findQuest(
  world: WorldState,
  p: PlayerState,
  questId: string,
): { q: QuestProgress; def: QuestDef; team: boolean } | null {
  const def = questDef(questId);
  if (!def) return null;
  if (def.type === 'PERSONAL') {
    const q = world.personalQuests[p.id]?.[questId];
    return q ? { q, def, team: false } : null;
  }
  const q = world.teamQuests[questId];
  return q ? { q, def, team: true } : null;
}

export function acceptQuest(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  questId: string,
): ActionResult {
  const f = findQuest(world, p, questId);
  if (!f) return fail('NOT_FOUND', 'Không có nhiệm vụ này');
  if (f.team) return fail('INVALID_STATE', 'Nhiệm vụ nhóm tự động nhận');
  if (f.q.status !== 'AVAILABLE' && f.q.status !== 'ABANDONED')
    return fail('INVALID_STATE', 'Nhiệm vụ đã nhận hoặc đã xong');
  f.q.status = 'ACTIVE';
  f.q.objectiveProgress = blankProgress(f.def);
  f.q.version += 1;
  out.dirtyQuests.add(p.id);
  // Đã ghé khu nào thì tính luôn (đã được server ghi nhận trước đó)
  if (questId === 'p_explore')
    for (const z of p.visitedZones)
      applyQuestEvent(world, out, {
        eventId: `visit:${z}:${f.q.version}`,
        type: 'VISIT',
        playerId: p.id,
        targetId: z,
        amount: 1,
      });
  return { ok: true, data: { questId } };
}

export function abandonQuest(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  questId: string,
): ActionResult {
  const f = findQuest(world, p, questId);
  if (!f) return fail('NOT_FOUND', 'Không có nhiệm vụ này');
  if (f.team) return fail('FORBIDDEN', 'Không thể bỏ nhiệm vụ nhóm');
  if (f.q.status !== 'ACTIVE')
    return fail('INVALID_STATE', 'Nhiệm vụ không ở trạng thái đang làm');
  f.q.status = 'ABANDONED';
  f.q.version += 1;
  out.dirtyQuests.add(p.id);
  return { ok: true, data: { questId } };
}

/** Nhận thưởng: chỉ một lần, cấp thưởng trong cùng bước (atomic) với chuyển trạng thái */
export function completeQuest(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  questId: string,
): ActionResult {
  const f = findQuest(world, p, questId);
  if (!f) return fail('NOT_FOUND', 'Không có nhiệm vụ này');
  if (f.q.status === 'COMPLETED')
    return fail('DUPLICATE_REQUEST', 'Đã nhận thưởng nhiệm vụ này');
  if (f.q.status !== 'ACTIVE')
    return fail('INVALID_STATE', 'Nhiệm vụ chưa nhận');
  if (f.def.type === 'DYNAMIC')
    return fail('INVALID_STATE', 'Nhiệm vụ động tự hoàn thành');
  if (!objectivesDone(f.def, f.q))
    return fail('REQUIREMENTS_NOT_MET', 'Chưa hoàn thành mục tiêu');
  f.q.status = 'COMPLETED';
  f.q.completedAt = world.time;
  f.q.version += 1;
  const receivers = f.team
    ? world.playerOrder.map((id) => world.players[id]).filter(Boolean)
    : [p];
  for (const r of receivers)
    grantReward(world, out, r, f.def.rewards.money, f.def.rewards.experience);
  out.dirtyQuests.add(f.team ? 'team' : p.id);
  emit(world, out, {
    type: 'quest:completed',
    playerId: p.id,
    audit: true,
    data: {
      questId,
      money: f.def.rewards.money,
      experience: f.def.rewards.experience,
      team: f.team,
    },
    text: `✅ ${f.team ? 'Nhiệm vụ nhóm' : p.name + ' hoàn thành'} «${f.def.name}» (+${f.def.rewards.money}$)`,
  });
  return { ok: true, data: { questId } };
}

/** Nộp vật phẩm cho mục tiêu DELIVER — server đọc túi đồ thật, chỉ trừ đúng phần còn thiếu */
export function contributeQuest(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  questId: string,
  objectiveId: string,
  quantity: number,
  eventId: string,
): ActionResult {
  const f = findQuest(world, p, questId);
  if (!f) return fail('NOT_FOUND', 'Không có nhiệm vụ này');
  if (f.q.status !== 'ACTIVE')
    return fail('INVALID_STATE', 'Nhiệm vụ không còn nhận đóng góp');
  const obj = f.def.objectives.find((o) => o.objectiveId === objectiveId);
  if (
    !obj ||
    obj.type !== 'DELIVER' ||
    !obj.targetId ||
    !isItemId(obj.targetId)
  )
    return fail('INVALID_PAYLOAD', 'Mục tiêu không nhận vật phẩm');
  const itemId: ItemId = obj.targetId;
  const need = obj.requiredAmount - (f.q.objectiveProgress[objectiveId] ?? 0);
  if (need <= 0) return fail('INVALID_STATE', 'Mục tiêu đã đủ');
  const give = Math.min(need, quantity);
  if (countItem(p.inventory, itemId) < give)
    return fail('INSUFFICIENT_ITEMS', 'Không đủ vật phẩm');
  const key = `${f.team ? 'team' : p.id}:${questId}:${eventId}`;
  if (ledgerHas(world, key))
    return fail('DUPLICATE_REQUEST', 'Đóng góp này đã được ghi nhận');
  removeItem(p.inventory, itemId, give);
  f.q.objectiveProgress[objectiveId] =
    (f.q.objectiveProgress[objectiveId] ?? 0) + give;
  f.q.version += 1;
  ledgerAdd(world, key);
  out.dirtyInventories.add(p.id);
  out.dirtyQuests.add(f.team ? 'team' : p.id);
  emit(world, out, {
    type: 'quest:contributed',
    playerId: p.id,
    audit: true,
    data: { questId, objectiveId, quantity: give },
    text: `📦 ${p.name} góp ${give} cho «${f.def.name}»`,
  });
  return { ok: true, data: { questId, contributed: give } };
}

export function questCompleted(world: WorldState, questId: string): boolean {
  return world.teamQuests[questId]?.status === 'COMPLETED';
}
