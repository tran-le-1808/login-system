// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Đào tường và đào hầm tự do (cần công cụ đào), che dấu vết bằng ảnh treo tường / thảm chân.
 * - Đào tường: ô tường thành "lỗ" (đi qua được). Tường ngoài (giáp bên ngoài) rất cứng (tiles.json outerWallHardness) —
 *   đục thủng là mở lối vượt ngục WALL; bước ra ngoài chỉ được khi đã bắt đầu đào tẩu.
 * - Đào sàn: mở "miệng hầm"; xuống hầm (tầng ẩn) rồi đào từng ô hầm đi ngang dưới đất;
 *   đào ngược lên ở ô khác để mở miệng hầm mới (kể cả bên ngoài tường).
 * - Cai ngục thấy lỗ / miệng hầm CHƯA CHE trong 3 ô là phát hiện ngay; ĐÃ CHE chỉ lộ khi khám phòng theo xác suất.
 * Thông số: data/tiles.json, data/tools.json, data/dig.json, data/concealers.json (thời gian × actionTimeScale).
 */
import tilesJson from './data/tiles.json';
import digJson from './data/dig.json';
import concealersJson from './data/concealers.json';
import { PRISON_CONFIG as C } from './config';
import { dist, hasLineOfSight } from './geometry';
import { addItem, countItem, ITEM_DEFS, removeItem } from './items';
import {
  bestTool,
  hasToolFor,
  maxDigPower,
  toolSpec,
  wearOwnedTool,
} from './tools';
import { PRISON_MAP, tileAt, zoneAt } from './map';
import { nextRandom } from './rng';
import { canCarry, clockInfo, emit, journal, outsideOpen } from './rules';
import { needStamina, spendStamina } from './stamina';
import type {
  ActionResult,
  Channel,
  DigState,
  ErrorCode,
  GuardEntity,
  ItemId,
  Outbox,
  PlayerState,
  WorldState,
} from './types';

export const DIG = digJson;
export const CONCEALERS = concealersJson as unknown as Record<
  string,
  {
    type: 'wall' | 'floor';
    coversTileState: string;
    searchDetectionChance: number;
  }
>;
const TILES = tilesJson as unknown as Record<
  string,
  { hardness: number | null; diggable: boolean; onDigTile: string }
> & {
  thinWallZones: string[];
  thinWallHardness: number;
  outerWallHardness: number | null;
  tunnelHardness: number;
};

const fail = (code: ErrorCode, message: string): ActionResult => ({
  ok: false,
  code,
  message,
});
export const tileKey = (x: number, y: number) => `${x},${y}`;

export const emptyDig = (): DigState => ({
  holes: {},
  entrances: {},
  tunnels: {},
  decor: {},
});

type StartChannel = (
  kind: Channel['kind'],
  targetId: string,
  seconds: number,
  extra?: Partial<Channel>,
) => ActionResult;

const matchZone = (zone: string | null, patterns: string[]) =>
  !!zone &&
  patterns.some((z) =>
    z.endsWith('*') ? zone.startsWith(z.slice(0, -1)) : zone === z,
  );

/** Tường giáp bên ngoài (8 ô xung quanh có ô 'o') */
export function isOuterWall(x: number, y: number): boolean {
  if (tileAt(PRISON_MAP, x, y) !== '#') return false;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      if (tileAt(PRISON_MAP, x + dx, y + dy) === 'o') return true;
  return false;
}

/** Độ cứng ô trên mặt đất; null = không đào được */
export function tileHardness(x: number, y: number): number | null {
  const ch = tileAt(PRISON_MAP, x, y);
  const rule = TILES[ch];
  if (!rule?.diggable || rule.hardness === null) return null;
  if (ch === '#') {
    if (isOuterWall(x, y)) return TILES.outerWallHardness;
    // vách mỏng giữa hai xà lim
    const thin =
      (matchZone(zoneAt(PRISON_MAP, x - 0.5, y + 0.5), TILES.thinWallZones) &&
        matchZone(zoneAt(PRISON_MAP, x + 1.5, y + 0.5), TILES.thinWallZones)) ||
      (matchZone(zoneAt(PRISON_MAP, x + 0.5, y - 0.5), TILES.thinWallZones) &&
        matchZone(zoneAt(PRISON_MAP, x + 0.5, y + 1.5), TILES.thinWallZones));
    return thin ? TILES.thinWallHardness : rule.hardness;
  }
  return rule.hardness;
}

/** Công cụ đào mạnh nhất đang có (túi chính / ô vũ khí) — dùng cho gợi ý & kiểm tra nhanh */
export function bestDigTool(
  p: Pick<PlayerState, 'inventory' | 'gear'>,
): { itemId: ItemId; power: number } | null {
  const t = bestTool(p, 'dig');
  return t ? { itemId: t.itemId, power: maxDigPower(p) } : null;
}

const DIG_KIND: Record<DigKind, 'wall' | 'floor' | 'tunnel'> = {
  digWall: 'wall',
  digFloor: 'floor',
  digTunnel: 'tunnel',
};

export const playerTile = (p: { x: number; y: number }) => ({
  x: Math.floor(p.x),
  y: Math.floor(p.y),
});

/** Có lỗ tường / miệng hầm đang được che không */
export function isCovered(
  world: Pick<WorldState, 'dig'>,
  key: string,
  kind: 'hole' | 'entrance',
): boolean {
  const d = world.dig.decor[key];
  if (!d) return false;
  const c = CONCEALERS[d];
  return (
    !!c && c.coversTileState === (kind === 'hole' ? 'hole' : 'tunnelEntrance')
  );
}

// ------------------------------------------------------------------ đào

export type DigKind = 'digWall' | 'digFloor' | 'digTunnel';

/** Kiểm tra đào ô (x, y): trả về loại thao tác hoặc lỗi. Ô phải kề ô đang đứng (hoặc chính ô đứng khi đào ngược lên từ hầm). */
export function digCheck(
  world: WorldState,
  p: PlayerState,
  x: number,
  y: number,
): { kind: DigKind; hardness: number } | ActionResult {
  if (x < 0 || y < 0 || x >= PRISON_MAP.width || y >= PRISON_MAP.height)
    return fail('INVALID_PAYLOAD', 'Ngoài bản đồ');
  const me = playerTile(p);
  const md = Math.abs(me.x - x) + Math.abs(me.y - y);
  const key = tileKey(x, y);
  const d = world.dig;
  if (p.underground) {
    if (md === 0) {
      // đào ngược lên: mở miệng hầm mới ở ô sàn / đất phía trên
      if (d.entrances[key])
        return fail('INVALID_STATE', 'Đã có miệng hầm ở đây');
      const h = tileHardness(x, y);
      const ch = tileAt(PRISON_MAP, x, y);
      if (h === null || ch === '#')
        return fail(
          'INVALID_STATE',
          'Phía trên là tường / đồ vật — không đào lên được',
        );
      if (ch === 'o' && !outsideOpen(world))
        return fail(
          'INVALID_STATE',
          'Chưa đào tẩu — chưa lên mặt đất bên ngoài được',
        );
      return { kind: 'digFloor', hardness: h };
    }
    if (md !== 1) return fail('OUT_OF_RANGE', 'Chỉ đào ô hầm ngay cạnh');
    if (d.tunnels[key]) return fail('INVALID_STATE', 'Ô này đã là hầm');
    if (Object.keys(d.tunnels).length >= DIG.tunnelLengthMax)
      return fail('OVER_CAPACITY', 'Hầm đã quá dài');
    return { kind: 'digTunnel', hardness: TILES.tunnelHardness };
  }
  if (md !== 1 && !(md === 0 && tileAt(PRISON_MAP, x, y) !== '#'))
    return fail('OUT_OF_RANGE', 'Đứng sát ô cần đào');
  const ch = tileAt(PRISON_MAP, x, y);
  const h = tileHardness(x, y);
  if (ch === '#') {
    if (h === null) return fail('INVALID_STATE', 'Tường này không đào được');
    if (d.holes[key]) return fail('INVALID_STATE', 'Đã có lỗ ở đây');
    return { kind: 'digWall', hardness: h };
  }
  if (h === null) return fail('INVALID_STATE', 'Không đào được ô này');
  if (d.entrances[key]) return fail('INVALID_STATE', 'Đã có miệng hầm ở đây');
  if (ch === 'o' && !outsideOpen(world))
    return fail('INVALID_STATE', 'Không ra được bên ngoài');
  return { kind: 'digFloor', hardness: h };
}

const SECONDS: Record<DigKind, number> = {
  digWall: DIG.wallSeconds,
  digFloor: DIG.floorSeconds,
  digTunnel: DIG.tunnelSeconds,
};
const STAMINA_COST: Record<DigKind, number> = {
  digWall: DIG.staminaPerWallTile,
  digFloor: DIG.staminaPerFloorTile,
  digTunnel: DIG.staminaPerTunnelTile,
};

export function startDig(
  world: WorldState,
  p: PlayerState,
  x: number,
  y: number,
  start: StartChannel,
): ActionResult {
  const c = digCheck(world, p, x, y);
  if ('ok' in c) return c;
  if (!hasToolFor(p, 'dig'))
    return fail(
      'ITEM_NOT_OWNED',
      'Cần công cụ đào (Muỗng mài / Dụng cụ đào / Cuốc chim…)',
    );
  // công cụ đủ cấp, hiệu quả nhất cho loại ô này (cuốc chim nhanh với tường, xẻng nhanh với sàn / hầm)
  const tool = bestTool(p, 'dig', {
    hardness: c.hardness,
    digKind: DIG_KIND[c.kind],
  });
  if (!tool)
    return fail(
      'REQUIREMENTS_NOT_MET',
      'Công cụ đào hiện có không đủ cứng để đào ô này',
    );
  const low = needStamina(p, STAMINA_COST[c.kind]);
  if (low) return low;
  if (c.kind !== 'digTunnel' && DIG.dirtDisposalEnabled && !canCarry(p, 'dirt'))
    return fail('OVER_CAPACITY', 'Túi đầy — cần chỗ chứa đất');
  return start(
    c.kind,
    tool.itemId,
    SECONDS[c.kind] / Math.max(0.1, tool.efficiency),
    { recipeId: tileKey(x, y), itemId: tool.itemId },
  );
}

export function completeDigTile(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  ch: Channel,
): void {
  const [x, y] = (ch.recipeId ?? '').split(',').map(Number);
  const c = digCheck(world, p, x, y);
  if ('ok' in c || c.kind !== ch.kind) return;
  const toolId = (ch.itemId ?? ch.targetId) as ItemId;
  if (
    (toolSpec(toolId)?.dig?.power ?? 0) < c.hardness ||
    !wearOwnedTool(p, toolId)
  )
    return;
  const lowStamina = p.stats.energy < DIG.lowStaminaThreshold;
  spendStamina(p, STAMINA_COST[c.kind]);
  if (!countItem(p.inventory, toolId) && p.gear.weapon?.itemId !== toolId)
    emit(world, out, {
      type: 'combat:weapon-broken',
      playerId: p.id,
      text: `🔨 ${ITEM_DEFS[toolId].name} đã gãy`,
    });
  out.dirtyInventories.add(p.id);
  out.dirtyMeta = true;
  // đào vội khi kiệt sức: có thể sập
  if (lowStamina && nextRandom(world) < DIG.collapseChanceLowStamina) {
    p.stats.health = Math.max(1, p.stats.health - DIG.collapseDamage);
    emit(world, out, {
      type: 'tunnel:collapse',
      playerId: p.id,
      x: p.x,
      y: p.y,
      text: `💥 Đất đá sập xuống! ${p.name} bị thương — nghỉ cho lại sức rồi đào tiếp`,
    });
    return;
  }
  const key = tileKey(x, y);
  const day = clockInfo(world.totalGameMinutes).day;
  if (c.kind === 'digWall') {
    world.dig.holes[key] = { by: p.id, day };
    emit(world, out, {
      type: 'dig:hole',
      playerId: p.id,
      x: x + 0.5,
      y: y + 0.5,
      text: `🕳️ ${p.name} đục thủng một lỗ tường`,
    });
  } else if (c.kind === 'digFloor') {
    world.dig.entrances[key] = { by: p.id, day };
    world.dig.tunnels[key] ??= p.id;
    emit(world, out, {
      type: 'dig:entrance',
      playerId: p.id,
      x: x + 0.5,
      y: y + 0.5,
      text: `🕳️ ${p.name} mở một miệng hầm`,
    });
  } else {
    world.dig.tunnels[key] = p.id;
    emit(world, out, {
      type: 'tunnel:dug',
      playerId: p.id,
      x: x + 0.5,
      y: y + 0.5,
      text: `⛏️ Hầm dài thêm 1 ô`,
    });
  }
  if (DIG.dirtDisposalEnabled && c.kind !== 'digWall') {
    if (canCarry(p, 'dirt')) addItem(p.inventory, 'dirt', 1);
  }
}

/** Xuống hầm / lên khỏi hầm tại miệng hầm đang đứng */
export function hatch(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
): ActionResult {
  const t = playerTile(p);
  const key = tileKey(t.x, t.y);
  if (!world.dig.entrances[key])
    return fail('OUT_OF_RANGE', 'Hãy đứng trên miệng hầm');
  if (!p.underground && isCovered(world, key, 'entrance')) {
    // thảm che: lật thảm lên rồi chui xuống (thảm vào túi nếu còn chỗ, không thì để cạnh miệng hầm)
    takeDecorAt(world, out, p, t.x, t.y);
  }
  if (
    p.underground &&
    tileAt(PRISON_MAP, t.x, t.y) === 'o' &&
    !outsideOpen(world)
  )
    return fail(
      'INVALID_STATE',
      'Chưa đào tẩu — chưa lên mặt đất bên ngoài được',
    );
  p.underground = !p.underground;
  p.channel = null;
  p.x = t.x + 0.5;
  p.y = t.y + 0.5;
  out.dirtyMeta = true;
  out.dirtyInventories.add(p.id);
  emit(world, out, {
    type: p.underground ? 'dig:down' : 'dig:up',
    playerId: p.id,
    x: p.x,
    y: p.y,
    text: p.underground ? `${p.name} chui xuống hầm` : `${p.name} lên khỏi hầm`,
  });
  return { ok: true, data: { underground: p.underground } };
}

// ------------------------------------------------------------------ vật che / trang trí

function nearTile(p: { x: number; y: number }, x: number, y: number): boolean {
  return dist(p.x, p.y, x + 0.5, y + 0.5) <= C.interaction.range;
}

export function placeDecor(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  itemId: ItemId,
  x: number,
  y: number,
): ActionResult {
  const def = ITEM_DEFS[itemId] as { decor?: 'wall' | 'floor'; name: string };
  if (!def?.decor)
    return fail('INVALID_PAYLOAD', 'Món này không treo / trải được');
  if (!countItem(p.inventory, itemId))
    return fail('ITEM_NOT_OWNED', `Bạn không có ${def.name}`);
  if (!nearTile(p, x, y)) return fail('OUT_OF_RANGE', 'Đứng sát chỗ cần đặt');
  const key = tileKey(x, y);
  if (world.dig.decor[key]) return fail('CONFLICT', 'Chỗ này đã có vật khác');
  const ch = tileAt(PRISON_MAP, x, y);
  if (def.decor === 'wall' && ch !== '#')
    return fail('INVALID_STATE', 'Ảnh chỉ treo được lên tường');
  if (def.decor === 'floor') {
    if (ch !== '.' && ch !== ',' && !world.dig.entrances[key])
      return fail('INVALID_STATE', 'Thảm chỉ trải được trên sàn');
    if (
      p.underground &&
      !(
        world.dig.entrances[key] &&
        tileKey(Math.floor(p.x), Math.floor(p.y)) === key
      )
    )
      return fail(
        'INVALID_STATE',
        'Từ dưới hầm chỉ che được miệng hầm đang đứng',
      );
  }
  removeItem(p.inventory, itemId, 1);
  world.dig.decor[key] = itemId;
  out.dirtyMeta = true;
  out.dirtyInventories.add(p.id);
  const covers =
    (def.decor === 'wall' && world.dig.holes[key]) ||
    (def.decor === 'floor' && world.dig.entrances[key]);
  emit(world, out, {
    type: 'decor:placed',
    playerId: p.id,
    x: x + 0.5,
    y: y + 0.5,
    text: covers
      ? `${def.name} đã che kín dấu vết`
      : `Đã đặt ${def.name.toLowerCase()}`,
  });
  return { ok: true, data: { covers: !!covers } };
}

function takeDecorAt(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  x: number,
  y: number,
): boolean {
  const key = tileKey(x, y);
  const it = world.dig.decor[key];
  if (!it) return false;
  if (!canCarry(p, it)) return false;
  delete world.dig.decor[key];
  addItem(p.inventory, it, 1);
  out.dirtyMeta = true;
  out.dirtyInventories.add(p.id);
  return true;
}

export function takeDecor(
  world: WorldState,
  out: Outbox,
  p: PlayerState,
  x: number,
  y: number,
): ActionResult {
  if (!nearTile(p, x, y)) return fail('OUT_OF_RANGE', 'Đứng sát vật cần gỡ');
  const key = tileKey(x, y);
  if (!world.dig.decor[key]) return fail('NOT_FOUND', 'Không có gì để gỡ');
  if (!takeDecorAt(world, out, p, x, y))
    return fail('OVER_CAPACITY', 'Túi chính đã đầy 6 ô');
  return { ok: true };
}

// ------------------------------------------------------------------ cai ngục phát hiện

/** Lấp hầm: xoá miệng hầm và mọi ô hầm nối với nó; ai đang ở dưới thì bị lôi lên */
function fillTunnelFrom(world: WorldState, startKey: string): void {
  const d = world.dig;
  const stack = [startKey];
  const seen = new Set<string>();
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k) || !d.tunnels[k]) continue;
    seen.add(k);
    const [x, y] = k.split(',').map(Number);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      stack.push(tileKey(x + dx, y + dy));
  }
  seen.add(startKey);
  for (const k of seen) {
    delete d.tunnels[k];
    delete d.entrances[k];
    if (CONCEALERS[d.decor[k] ?? '']?.type === 'floor') delete d.decor[k];
  }
  for (const id of world.playerOrder) {
    const p = world.players[id];
    if (p?.underground && seen.has(tileKey(Math.floor(p.x), Math.floor(p.y)))) {
      p.underground = false;
      const [x, y] = startKey.split(',').map(Number);
      p.x = x + 0.5;
      p.y = y + 0.5;
    }
  }
}

/** Cai ngục phát hiện lỗ tường / miệng hầm: gỡ vật che, lấp lại, người đào bị nghi ngờ */
export function digTraceFound(
  world: WorldState,
  out: Outbox,
  key: string,
  kind: 'hole' | 'entrance',
  by: string,
): void {
  const d = world.dig;
  const owner = (kind === 'hole' ? d.holes[key] : d.entrances[key])?.by;
  if (!owner) return;
  const [x, y] = key.split(',').map(Number);
  if (DIG.holeFoundConsequence === 'fill') {
    if (kind === 'hole') {
      delete d.holes[key];
      if (CONCEALERS[d.decor[key] ?? '']?.type === 'wall') delete d.decor[key];
    } else fillTunnelFrom(world, key);
  } else delete d.decor[key];
  const p = world.players[owner];
  if (p && p.status !== 'ESCAPED') {
    p.stats.personalHeat = Math.min(100, p.stats.personalHeat + DIG.foundHeat);
    out.dirtyInventories.add(p.id);
  }
  out.dirtyMeta = true;
  const what = kind === 'hole' ? 'lỗ tường' : 'đường hầm';
  journal(
    world,
    out,
    'search',
    `${by} phát hiện ${what} ở ${PRISON_MAP.zones.find((z) => z.id === zoneAt(PRISON_MAP, x + 0.5, y + 0.5))?.name ?? 'trại'} — đã lấp lại`,
    owner,
  );
  emit(world, out, {
    type: 'dig:found',
    playerId: owner,
    x: x + 0.5,
    y: y + 0.5,
    data: { kind },
    text: `🚨 ${by} phát hiện ${what} và cho lấp lại!`,
  });
}

/** Cai ngục nhìn thấy dấu vết CHƯA CHE trong tầm 3 ô (gọi trong AI cai ngục) */
export function guardSpotDigTraces(
  world: WorldState,
  out: Outbox,
  g: GuardEntity,
): void {
  const d = world.dig;
  for (const [kind, list] of [
    ['hole', d.holes],
    ['entrance', d.entrances],
  ] as const) {
    for (const key of Object.keys(list)) {
      if (isCovered(world, key, kind)) continue;
      const [x, y] = key.split(',').map(Number);
      const cx = x + 0.5;
      const cy = y + 0.5;
      const dd = dist(g.x, g.y, cx, cy);
      if (dd > DIG.guardSpotRange) continue;
      // nhìn tới mép ô (ô tường tự che chính nó)
      const k = Math.max(0, (dd - 0.6) / dd);
      if (
        !hasLineOfSight(
          PRISON_MAP,
          g.x,
          g.y,
          g.x + (cx - g.x) * k,
          g.y + (cy - g.y) * k,
        )
      )
        continue;
      digTraceFound(world, out, key, kind, g.name);
    }
  }
}

/** Khám phòng: dấu vết trong xà lim (và vách quanh nó) — chưa che lộ ngay, đã che lộ theo xác suất của vật che */
export function searchDigTraces(
  world: WorldState,
  out: Outbox,
  cellIndex: number,
  by: string,
): void {
  const zone = PRISON_MAP.zones.find((z) => z.id === `cell_${cellIndex}`);
  if (!zone) return;
  const inRoom = (x: number, y: number) =>
    zone.rects.some(
      ([x0, y0, x1, y1]) =>
        x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1,
    );
  const d = world.dig;
  for (const [kind, list] of [
    ['hole', d.holes],
    ['entrance', d.entrances],
  ] as const)
    for (const key of Object.keys(list)) {
      const [x, y] = key.split(',').map(Number);
      if (!inRoom(x, y)) continue;
      const covered = isCovered(world, key, kind);
      const chance = covered
        ? CONCEALERS[d.decor[key]].searchDetectionChance
        : 1;
      if (nextRandom(world) < chance) digTraceFound(world, out, key, kind, by);
    }
}

/** Ô có thể đi trên mặt đất nhờ lỗ tường; dưới hầm chỉ đi trong ô hầm */
export function digPassInfo(world: Pick<WorldState, 'dig'>): {
  holes: string[];
  tunnels: string[];
} {
  return {
    holes: Object.keys(world.dig.holes),
    tunnels: Object.keys(world.dig.tunnels),
  };
}

export { removeItem };
