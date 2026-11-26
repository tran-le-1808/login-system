// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Giường: nơi thức dậy và nghỉ ngơi — KHÔNG phải nơi giấu đồ (không mở được, không chứa đồ bên trong / dưới).
 * Trên giường chỉ có gối, chăn và có thể đặt Hình nộm (được coi là "người đang ngủ", không phải giấu đồ).
 * Ban đêm cai ngục nhìn vào xà lim: nhìn thoáng (dễ qua mắt nếu hình nộm tốt, trời tối) hoặc điểm danh đêm
 * (gọi tên — hình nộm không trả lời, trừ khi đồng đội trong xà lim trả lời thay).
 */
import { PRISON_CONFIG as C, ROLE_MODIFIERS } from './config';
import { addItem, countItem, ITEM_DEFS, slotsAfter } from './items';
import { PRISON_MAP, zoneAt, type Interactable } from './map';
import { distanceToInteractable } from './proximity';
import { nextRandom } from './rng';
import {
  cellLightsOn,
  clockInfo,
  emit,
  journal,
  maxSlots,
  periodAt,
  recordViolation,
} from './rules';
import type {
  ActionResult,
  BedItem,
  BedState,
  ErrorCode,
  Outbox,
  PlayerState,
  WorldState,
} from './types';
import { isCurfew, outsideOwnCell, raiseWanted } from './wanted';

const fail = (code: ErrorCode, message: string): ActionResult => ({
  ok: false,
  code,
  message,
});

export const BED_ITEMS: BedItem[] = ['pillow', 'blanket', 'dummy'];

export function isBedItem(v: unknown): v is BedItem {
  return v === 'pillow' || v === 'blanket' || v === 'dummy';
}

export const bedIdOfCell = (cellIndex: number) => `bedrest_${cellIndex}`;

const freshBed = (): BedState => ({
  pillow: true,
  blanket: true,
  dummy: false,
  realism: 0,
  meter: 0,
});

export function initBeds(world: WorldState): void {
  for (const it of PRISON_MAP.interactables)
    if (it.kind === 'bed') world.beds[it.id] = freshBed();
}

function reachable(p: PlayerState, bedId: string): Interactable | ActionResult {
  const it = PRISON_MAP.interactableById[bedId];
  if (!it || it.kind !== 'bed') return fail('NOT_FOUND', 'Không có giường này');
  if (distanceToInteractable(p, it) > C.interaction.range)
    return fail('OUT_OF_RANGE', 'Bạn ở quá xa');
  return it;
}

function bedOf(world: WorldState, id: string): BedState {
  return (world.beds[id] ??= freshBed());
}

/** Độ chân thực của hình nộm khi chế tạo: theo Khéo tay (và vai trò Mechanic) */
export function decoyRealism(p: Pick<PlayerState, 'skills' | 'role'>): number {
  const d = C.decoy;
  return Math.round(
    Math.min(
      100,
      d.baseRealism +
        p.skills.crafting * d.perCraftingPoint +
        (ROLE_MODIFIERS[p.role].craftBonus ? d.mechanicBonus : 0),
    ),
  );
}

/** Lấy gối / chăn / hình nộm từ giường về túi */
export function bedTake(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  bedId: string,
  what: BedItem,
): ActionResult {
  const it = reachable(p, bedId);
  if ('ok' in it) return it;
  const bed = bedOf(world, bedId);
  if (!bed[what]) return fail('INVALID_STATE', 'Giường không có món này');
  const item =
    what === 'dummy'
      ? { itemId: what, quantity: 1, quality: bed.realism }
      : { itemId: what, quantity: 1 };
  if (slotsAfter(p.inventory, [], [item]) > maxSlots(p))
    return fail('OVER_CAPACITY', 'Túi chính đã đầy 6 ô');
  bed[what] = false;
  if (what === 'dummy') {
    p.inventory.push(item);
    bed.realism = 0;
    bed.meter = 0;
  } else addItem(p.inventory, what, 1);
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'bed:take',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { bedId, what },
  });
  return { ok: true, data: { what } };
}

/** Đặt gối / chăn / hình nộm từ túi lên giường (đặt lên — không phải giấu) */
export function bedPlace(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  bedId: string,
  what: BedItem,
): ActionResult {
  const it = reachable(p, bedId);
  if ('ok' in it) return it;
  const bed = bedOf(world, bedId);
  if (bed[what]) return fail('INVALID_STATE', 'Giường đã có món này');
  if (!countItem(p.inventory, what))
    return fail('ITEM_NOT_OWNED', `Bạn không có ${ITEM_DEFS[what].name}`);
  if (what === 'dummy') {
    const idx = p.inventory.findIndex((i) => i.itemId === 'dummy');
    const [d] = p.inventory.splice(idx, 1);
    bed.realism = d.quality ?? C.decoy.baseRealism;
    bed.meter = 0;
    journal(
      world,
      out,
      'event',
      `${p.name} đặt hình nộm (chân thực ${bed.realism}) lên ${it.name}`,
      p.id,
    );
  } else {
    const idx = p.inventory.findIndex((i) => i.itemId === what);
    p.inventory[idx].quantity -= 1;
    if (p.inventory[idx].quantity <= 0) p.inventory.splice(idx, 1);
  }
  bed[what] = true;
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'bed:place',
    playerId: p.id,
    x: p.x,
    y: p.y,
    data: { bedId, what },
  });
  return { ok: true, data: { what } };
}

/** Nằm / ngủ: chỉ giường của mình, không có hình nộm. Ngủ ngoài giờ cho phép vẫn được nhưng là vi phạm. */
/** Ngủ được ở mọi giường (xà lim mình / xà lim khác / y tế / biệt giam) — trừ giường đang có người hoặc có hình nộm */
export function canSleepIn(
  world: WorldState,
  p: PlayerState,
  it: Interactable,
): ActionResult {
  if (
    Object.values(world.players).some(
      (q) => q.id !== p.id && q.bed === it.id && q.status !== 'ESCAPED',
    )
  )
    return fail('CONFLICT', 'Giường đang có người nằm');
  if (bedOf(world, it.id).dummy)
    return fail('INVALID_STATE', 'Lấy hình nộm ra khỏi giường trước khi nằm');
  return { ok: true };
}

export function sleepAllowedNow(world: WorldState): boolean {
  return !!periodAt(clockInfo(world.totalGameMinutes).minuteOfDay).sleepOk;
}

function exposeDecoy(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  how: string,
  onAlarm: (p: PlayerState, r: number) => void,
): void {
  const bed = bedOf(world, bedIdOfCell(p.cellIndex));
  bed.dummy = false;
  bed.realism = 0;
  bed.meter = 0;
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'bed:dummy-exposed',
    playerId: p.id,
    audit: true,
    text: `🧍 Hình nộm trong phòng ${p.cellIndex + 1} bị lộ (${how})!`,
  });
  if (isCurfew(world) && outsideOwnCell(p))
    raiseWanted(
      world,
      out,
      p,
      `hình nộm bị lộ khi ${how} — vắng mặt sau 21:00`,
      'Cai ngục',
      onAlarm,
    );
  else {
    const c = clockInfo(world.totalGameMinutes);
    journal(
      world,
      out,
      'violation',
      `Hình nộm phòng ${p.cellIndex + 1} bị lộ khi ${how} — bị thu`,
      p.id,
    );
    recordViolation(
      world,
      out,
      p,
      {
        reason: 'để hình nộm trên giường',
        severity: 'minor',
        key: `${c.day}:decoy:${c.hour}`,
      },
      'Cai ngục',
    );
  }
}

/**
 * Cai ngục nhìn thoáng vào xà lim (đi ngang cửa). Người vắng mặt:
 * - không có hình nộm -> truy nã; - có hình nộm -> xác suất qua mắt theo độ chân thực & ánh sáng; thanh nghi ngờ phụ tăng.
 */
export function nightGlance(
  world: WorldState,
  out: Outbox,
  onAlarm: (p: PlayerState, r: number) => void,
): void {
  emit(world, out, {
    type: 'game:night-check',
    data: { kind: 'glance' },
    text: '🔦 Cai ngục đi ngang nhìn vào các xà lim',
  });
  const dark = !cellLightsOn(clockInfo(world.totalGameMinutes).minuteOfDay);
  for (const id of world.playerOrder) {
    const p = world.players[id];
    // vắng giường: ở ngoài xà lim, hoặc đang đào / chống hầm trong xà lim (hình nộm che được cả hai)
    const digging =
      !!p && (p.channel?.kind === 'dig' || p.channel?.kind === 'support');
    if (
      !p ||
      p.status !== 'ACTIVE' ||
      !p.connected ||
      (!outsideOwnCell(p) && !digging)
    )
      continue;
    const bed = bedOf(world, bedIdOfCell(p.cellIndex));
    if (!bed.dummy) {
      raiseWanted(
        world,
        out,
        p,
        digging
          ? 'đang đào hầm khi cai ngục nhìn vào xà lim'
          : 'giường trống khi cai ngục nhìn vào xà lim sau 21:00',
        'Cai ngục',
        onAlarm,
      );
      continue;
    }
    const miss = (100 - bed.realism) / 100;
    const k = dark ? C.decoy.darkFactor : 1;
    bed.meter = Math.min(100, bed.meter + C.decoy.meterPerGlance * miss * k);
    out.dirtyMeta = true;
    if (bed.meter >= 100 || nextRandom(world) < miss * C.decoy.glanceFactor * k)
      exposeDecoy(world, out, p, 'cai ngục nhìn vào', onAlarm);
    else {
      journal(
        world,
        out,
        'event',
        `Hình nộm qua mắt cai ngục — ${p.name} vắng mặt không bị phát hiện`,
        p.id,
      );
      emit(world, out, {
        type: 'bed:dummy-fooled',
        playerId: p.id,
        text: `🛏️ Cai ngục tưởng hình nộm là ${p.name}`,
      });
    }
  }
}

/** Nhìn kỹ (khám phòng): đồ trên giường luôn bị thấy; hình nộm lộ theo độ chân thực (không bao giờ an toàn tuyệt đối) */
export function closeLook(
  world: WorldState,
  out: Outbox,
  cellIndex: number,
  onAlarm: (p: PlayerState, r: number) => void,
): boolean {
  const bed = bedOf(world, bedIdOfCell(cellIndex));
  if (!bed.dummy) return false;
  const owner = Object.values(world.players).find(
    (p) => p.cellIndex === cellIndex,
  );
  const p = (100 - bed.realism) / 100 + C.decoy.closeLookBase;
  if (nextRandom(world) >= Math.min(1, p) && owner && !outsideOwnCell(owner))
    return false;
  if (owner) exposeDecoy(world, out, owner, 'khám phòng', onAlarm);
  else {
    bed.dummy = false;
    bed.realism = 0;
  }
  return true;
}

/**
 * Điểm danh đêm: cai ngục gọi tên từng xà lim. Ai vắng mặt mà không có đồng đội trong xà lim
 * trả lời thay (answerRollcall) thì bị lộ (có hình nộm) hoặc bị truy nã (giường trống).
 */
export function startNightRollcall(world: WorldState, out: Outbox): void {
  world.nightRollcall = { until: world.time + 10, answered: [] };
  emit(world, out, {
    type: 'game:night-check',
    data: { kind: 'rollcall' },
    text: '📢 Điểm danh đêm: cai ngục gọi tên từng xà lim (10 giây)',
  });
}

export function answerRollcall(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): ActionResult {
  const rc = world.nightRollcall;
  if (!rc) return fail('INVALID_STATE', 'Không có điểm danh đêm');
  const zone = zoneAt(PRISON_MAP, p.x, p.y);
  const m = /^cell_(\d+)$/.exec(zone ?? '');
  if (!m) return fail('OUT_OF_RANGE', 'Phải ở trong một xà lim');
  const cell = Number(m[1]);
  const owner = Object.values(world.players).find((q) => q.cellIndex === cell);
  if (!owner || owner.id === p.id)
    return fail('INVALID_STATE', 'Không có ai cần trả lời thay ở xà lim này');
  if (!rc.answered.includes(cell)) rc.answered.push(cell);
  emit(world, out, {
    type: 'bed:rollcall-answered',
    playerId: p.id,
    text: `🗣️ ${p.name} trả lời điểm danh thay ${owner.name}`,
  });
  return { ok: true, data: { cell } };
}

export function resolveNightRollcall(
  world: WorldState,
  out: Outbox,
  onAlarm: (p: PlayerState, r: number) => void,
): void {
  const rc = world.nightRollcall;
  if (!rc || world.time < rc.until) return;
  world.nightRollcall = null;
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (!p || p.status !== 'ACTIVE' || !p.connected || !outsideOwnCell(p))
      continue;
    if (rc.answered.includes(p.cellIndex)) {
      journal(
        world,
        out,
        'event',
        `Đồng đội trả lời điểm danh đêm thay ${p.name}`,
        p.id,
      );
      continue;
    }
    const bed = bedOf(world, bedIdOfCell(p.cellIndex));
    if (bed.dummy)
      exposeDecoy(
        world,
        out,
        p,
        'điểm danh đêm (hình nộm không trả lời)',
        onAlarm,
      );
    else
      raiseWanted(
        world,
        out,
        p,
        'vắng mặt khi điểm danh đêm',
        'Cai ngục',
        onAlarm,
      );
  }
}

/** Thanh nghi ngờ phụ của hình nộm giảm dần theo giờ */
export function decayDecoyMeters(world: WorldState, gameMinutes: number): void {
  for (const b of Object.values(world.beds))
    if (b.meter > 0)
      b.meter = Math.max(
        0,
        b.meter - (C.decoy.meterDecayPerHour * gameMinutes) / 60,
      );
}
