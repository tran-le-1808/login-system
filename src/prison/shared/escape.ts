// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * EscapeSession & chiến thắng chung.
 * Một người ESCAPED không kết thúc trận; chỉ ALL_ESCAPED khi MỌI requiredPlayerIds đều ESCAPED.
 */
import { PRISON_CONFIG as C } from './config';
import escapesJson from './data/escapes.json';
import { dist } from './geometry';
import { PRISON_MAP, zoneAt } from './map';
import { countItem } from './items';
import { isOuterWall } from './digging';
import { questCompleted, QUEST_DEFS } from './quests';
import { emit, journal } from './rules';
import { tunnelComplete } from './tunnel';
import type {
  ActionResult,
  EscapeMethod,
  EscapePlayerStatus,
  EscapeSessionState,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

const fail = (
  code: Extract<ActionResult, { ok: false }>['code'],
  message: string,
): ActionResult => ({ ok: false, code, message });

export function createEscapeSession(
  world: Pick<WorldState, 'idSeq'>,
): EscapeSessionState {
  world.idSeq += 1;
  return {
    id: `esc${world.idSeq}`,
    status: 'PREPARING',
    method: null,
    playerStatuses: {},
    allPlayersReady: false,
    failedAt: null,
    attempts: 0,
  };
}

export interface EscapeRouteDef {
  name: string;
  short: string;
  exit: string;
  requirements: string[];
  steps: string[];
  risks: string;
  time: string;
}

/** 5 lối vượt ngục (data/escapes.json) */
export const ESCAPE_ROUTES = escapesJson as Record<
  EscapeMethod,
  EscapeRouteDef
>;
export const ESCAPE_METHODS = Object.keys(ESCAPE_ROUTES) as EscapeMethod[];

/** Số ô hàng rào đã mở theo từng lớp (inner / outer) */
export function fenceRingsOpen(
  world: Pick<WorldState, 'routes'>,
): Record<string, boolean> {
  const res: Record<string, boolean> = {};
  for (const it of PRISON_MAP.interactables)
    if (it.kind === 'fence' && it.ring)
      res[it.ring] =
        res[it.ring] ||
        it.tiles.some((t) => world.routes.fenceGaps.includes(`${t.x},${t.y}`));
  return res;
}

/** Lối 7: chìa / thẻ mở cửa kho (K) — cổng xe tải tự mở khi xe hàng tới */
const TRUCK_KEYS = ['fake_key', 'keycard'] as const;

export function routeOpen(world: WorldState, method: EscapeMethod): boolean {
  switch (method) {
    case 'VENT':
      return world.routes.ventOpen;
    case 'FENCE': {
      const rings = Object.values(fenceRingsOpen(world));
      return rings.length > 0 && rings.every(Boolean);
    }
    case 'TUNNEL':
      return Object.values(world.tunnels).some((t) => tunnelComplete(t));
    case 'LAUNDRY':
      return PRISON_MAP.interactables.some(
        (i) => i.kind === 'vehicle' && i.vehicle === 'laundry',
      );
    case 'WALL':
      return Object.keys(world.dig.holes).some((k) => {
        const [x, y] = k.split(',').map(Number);
        return isOuterWall(x, y);
      });
    case 'TRUCK':
      return world.requiredPlayerIds.some((id) => {
        const p = world.players[id];
        return (
          !!p &&
          p.status !== 'ESCAPED' &&
          TRUCK_KEYS.some((k) => countItem(p.inventory, k) > 0)
        );
      });
    case 'GATE':
      return world.requiredPlayerIds.some((id) => {
        const p = world.players[id];
        if (
          !p ||
          p.status === 'ESCAPED' ||
          (countItem(p.inventory, 'keycard') === 0 &&
            countItem(p.inventory, 'fake_keycard') === 0)
        )
          return false;
        return (
          p.gear.outfit?.itemId === 'guard_outfit' ||
          countItem(p.inventory, 'guard_outfit') > 0
        );
      });
    default:
      return false;
  }
}

export const METHOD_NAMES = Object.fromEntries(
  ESCAPE_METHODS.map((m) => [m, ESCAPE_ROUTES[m].short]),
) as Record<EscapeMethod, string>;

const NOT_OPEN: Record<EscapeMethod, string> = {
  VENT: 'Lưới thông gió chưa được cậy',
  FENCE: 'Cần mở được cả hàng rào trong lẫn hàng rào ngoài (kìm cắt / dây leo)',
  TUNNEL: 'Chưa có đường hầm nào đào thông',
  LAUNDRY: 'Bản đồ không có xe giặt',
  GATE: 'Cần một người có Bộ đồ cai ngục và Thẻ cai ngục (thật hoặc giả)',
  WALL: 'Chưa đục thủng tường ngoài (cần Cuốc chim cải tiến)',
  TRUCK: 'Cần một người có Chìa kho giả hoặc Thẻ cai ngục để vào kho',
};

export interface EscapePointInfo {
  id: string;
  name: string;
  method: EscapeMethod;
  x: number;
  y: number;
  /** Giữ để tương thích bản lưu cũ — mọi ô thoát đều ở ngoài tường */
  inside: boolean;
}

/** Ô thoát ngoài tường (lớp escape của bản đồ) */
export function escapePoints(_world?: WorldState): EscapePointInfo[] {
  return PRISON_MAP.escapePoints.map((e) => ({ ...e, inside: false }));
}

/** Chỉ tính thắng khi đứng ở ô thoát NGOÀI hàng rào và không bị bắt */
function atPoint(
  world: WorldState,
  p: PlayerState,
  pt: EscapePointInfo,
): boolean {
  return (
    p.status === 'ACTIVE' &&
    !p.vehicle &&
    !p.underground &&
    dist(p.x, p.y, pt.x, pt.y) <= C.escape.pointRadius &&
    zoneAt(PRISON_MAP, p.x, p.y) === 'outside'
  );
}

function requiredPlayers(world: WorldState): PlayerState[] {
  return world.requiredPlayerIds
    .map((id) => world.players[id])
    .filter((p): p is PlayerState => !!p);
}

function recomputeReady(world: WorldState): void {
  const remaining = requiredPlayers(world).filter(
    (p) => p.status !== 'ESCAPED',
  );
  world.escape.allPlayersReady =
    remaining.length > 0 && remaining.every((p) => p.escapeReady);
}

function resetReady(world: WorldState): void {
  for (const id of world.playerOrder)
    if (world.players[id]) world.players[id].escapeReady = false;
  world.escape.allPlayersReady = false;
}

export function prepareEscape(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  method: EscapeMethod,
): ActionResult {
  if (p.status !== 'ACTIVE')
    return fail('INVALID_STATE', 'Bạn không thể lên kế hoạch lúc này');
  const st = world.escape.status;
  if (st !== 'PREPARING' && st !== 'FAILED' && st !== 'READY_CHECK')
    return fail('INVALID_STATE', 'Kế hoạch đang được thực hiện');
  const req = Object.values(QUEST_DEFS).filter(
    (d) => d.escapeRequirement && !questCompleted(world, d.questId),
  );
  if (req.length)
    return fail(
      'REQUIREMENTS_NOT_MET',
      `Cần hoàn thành nhiệm vụ nhóm «${req[0].name}»`,
    );
  if (!ESCAPE_ROUTES[method])
    return fail('INVALID_PAYLOAD', 'Không có lối thoát này');
  if (!routeOpen(world, method))
    return fail('REQUIREMENTS_NOT_MET', NOT_OPEN[method]);
  world.escape.status = 'READY_CHECK';
  world.escape.method = method;
  world.escape.failedAt = null;
  resetReady(world);
  syncPlayerStatuses(world);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'escape:prepared',
    playerId: p.id,
    audit: true,
    data: { method },
    text: `🗺️ ${p.name} chốt kế hoạch: ${METHOD_NAMES[method]} — mọi người bấm Sẵn sàng`,
  });
  return { ok: true, data: { method } };
}

export function setEscapeReady(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  ready: boolean,
): ActionResult {
  if (world.escape.status !== 'READY_CHECK')
    return fail('INVALID_STATE', 'Chưa có kế hoạch để sẵn sàng');
  if (!world.requiredPlayerIds.includes(p.id))
    return fail('FORBIDDEN', 'Bạn không thuộc đội đào tẩu');
  p.escapeReady = ready;
  recomputeReady(world);
  out.dirtyMeta = true;
  return {
    ok: true,
    data: { ready, allPlayersReady: world.escape.allPlayersReady },
  };
}

export function startEscape(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): ActionResult {
  if (world.escape.status !== 'READY_CHECK')
    return fail('INVALID_STATE', 'Chưa có kế hoạch');
  if (!world.requiredPlayerIds.includes(p.id))
    return fail('FORBIDDEN', 'Bạn không thuộc đội đào tẩu');
  recomputeReady(world);
  if (!world.escape.allPlayersReady)
    return fail('REQUIREMENTS_NOT_MET', 'Chưa phải ai cũng sẵn sàng');
  if (!world.escape.method || !routeOpen(world, world.escape.method))
    return fail('REQUIREMENTS_NOT_MET', 'Lối thoát đã bị chặn');
  world.escape.status = 'EXECUTING';
  world.escape.attempts += 1;
  syncPlayerStatuses(world);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'escape:started',
    playerId: p.id,
    audit: true,
    text: '🏃 BẮT ĐẦU ĐÀO TẨU! Tới lối thoát — đừng bỏ lại ai!',
  });
  return { ok: true };
}

export function cancelEscape(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): ActionResult {
  const st = world.escape.status;
  if (st !== 'READY_CHECK' && st !== 'EXECUTING' && st !== 'RESCUE_REQUIRED')
    return fail('INVALID_STATE', 'Không có kế hoạch để huỷ');
  world.escape.status = 'PREPARING';
  resetReady(world);
  syncPlayerStatuses(world);
  out.dirtyMeta = true;
  emit(world, out, {
    type: 'escape:cancelled',
    playerId: p.id,
    audit: true,
    text: `${p.name} huỷ kế hoạch đào tẩu`,
  });
  return { ok: true };
}

/** Yêu cầu kiểm tra điểm thoát — KHÔNG phải bằng chứng đã thoát; server xác minh vị trí & điều kiện */
export function enterEscapePoint(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  pointId: string,
): ActionResult {
  const st = world.escape.status;
  if (st !== 'EXECUTING' && st !== 'RESCUE_REQUIRED')
    return fail('INVALID_STATE', 'Chưa bắt đầu đào tẩu');
  if (p.status !== 'ACTIVE')
    return fail('INVALID_STATE', 'Bạn không thể thoát lúc này');
  if (!world.requiredPlayerIds.includes(p.id))
    return fail('FORBIDDEN', 'Bạn không thuộc đội đào tẩu');
  const point = escapePoints(world).find((e) => e.id === pointId);
  if (!point) return fail('NOT_FOUND', 'Không có điểm thoát này');
  if (!atPoint(world, p, point))
    return fail('OUT_OF_RANGE', 'Bạn chưa tới ô thoát ngoài tường');
  markEscaped(world, out, p);
  return { ok: true, data: { escaped: true } };
}

function markEscaped(world: WorldState, out: Outbox, p: PlayerState): void {
  p.status = 'ESCAPED';
  p.channel = null;
  p.moving = false;
  p.escapeReady = false;
  world.escape.playerStatuses[p.id] = {
    status: 'ESCAPED',
    escapedAt: world.time,
  };
  for (const tid of Object.keys(world.trades)) {
    const t = world.trades[tid];
    if (t.fromId === p.id || t.toId === p.id) {
      delete world.trades[tid];
      out.dirtyTrades.add(t.fromId).add(t.toId);
    }
  }
  out.dirtyMeta = true;
  journal(world, out, 'escape', `${p.name} đã thoát ra ngoài`, p.id);
  emit(world, out, {
    type: 'escape:player-escaped',
    playerId: p.id,
    audit: true,
    text: `🌄 ${p.name} đã thoát ra ngoài!`,
  });
}

function mapStatus(world: WorldState, p: PlayerState): EscapePlayerStatus {
  switch (p.status) {
    case 'ESCAPED':
      return 'ESCAPED';
    case 'CAPTURED':
      return 'CAPTURED';
    case 'KNOCKED_OUT':
      return 'KNOCKED_OUT';
    default:
      return world.escape.status === 'EXECUTING' ||
        world.escape.status === 'RESCUE_REQUIRED'
        ? 'ESCAPING'
        : 'INSIDE';
  }
}

export function syncPlayerStatuses(world: WorldState): void {
  const next: EscapeSessionState['playerStatuses'] = {};
  for (const p of requiredPlayers(world))
    next[p.id] = {
      status: mapStatus(world, p),
      escapedAt: world.escape.playerStatuses[p.id]?.escapedAt ?? null,
    };
  world.escape.playerStatuses = next;
}

/** Gọi mỗi tick: tự phát hiện người tới điểm thoát, chuyển RESCUE_REQUIRED / FAILED / ALL_ESCAPED */
export function updateEscape(world: WorldState, out: Outbox): void {
  const e = world.escape;
  if (e.status === 'ALL_ESCAPED') return;
  const active = e.status === 'EXECUTING' || e.status === 'RESCUE_REQUIRED';
  if (active) {
    const points = escapePoints(world);
    for (const p of requiredPlayers(world)) {
      if (p.status !== 'ACTIVE') continue;
      if (points.some((pt) => atPoint(world, p, pt)))
        markEscaped(world, out, p);
    }
  }
  const req = requiredPlayers(world);
  const before = e.status;
  if (req.length > 0 && req.every((p) => p.status === 'ESCAPED')) {
    e.status = 'ALL_ESCAPED';
    world.outcome = 'ALL_ESCAPED';
    emit(world, out, {
      type: 'escape:team-victory',
      audit: true,
      text: '🏆 CẢ ĐỘI ĐÃ VƯỢT NGỤC THÀNH CÔNG!',
    });
  } else if (active) {
    const remaining = req.filter((p) => p.status !== 'ESCAPED');
    if (remaining.length && remaining.every((p) => p.status === 'CAPTURED')) {
      e.status = 'FAILED';
      e.failedAt = world.time;
      emit(world, out, {
        type: 'escape:failed',
        audit: true,
        text: '❌ Kế hoạch thất bại — mọi người còn lại đều bị bắt',
      });
    } else if (
      remaining.some(
        (p) => p.status === 'CAPTURED' || p.status === 'KNOCKED_OUT',
      )
    ) {
      e.status = 'RESCUE_REQUIRED';
    } else e.status = 'EXECUTING';
    if (before === 'EXECUTING' && e.status === 'RESCUE_REQUIRED')
      emit(world, out, {
        type: 'escape:rescue-required',
        text: '🆘 Có người bị bắt giữa chừng — cần giải cứu!',
      });
  } else if (
    e.status === 'FAILED' &&
    e.failedAt !== null &&
    world.time - e.failedAt >= C.escape.failedResetSeconds
  ) {
    e.status = 'PREPARING';
    e.failedAt = null;
    resetReady(world);
  } else if (e.status === 'READY_CHECK') recomputeReady(world);
  const prevJson = JSON.stringify(e.playerStatuses);
  syncPlayerStatuses(world);
  if (before !== e.status || prevJson !== JSON.stringify(e.playerStatuses))
    out.dirtyMeta = true;
}
