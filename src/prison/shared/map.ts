// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Bản đồ đọc từ file Tiled (maps/*.map.json). Mở bằng Tiled để chỉnh — KHÔNG vẽ cứng trong code.
 * Lớp: floor + walls (hoặc ground cũ) — tile, thuộc tính `ch` của tileset; zones, areas,
 * objects (hoặc interactables), spawns, guard_routes (polyline), escape (hoặc exits), lights, cameras.
 * 1 ô = 1 đơn vị thế giới; tâm ô (x+0.5, y+0.5). Thuộc tính khu: data/zones.json; camera: data/cameras.json.
 */
import rawMap from './maps/grey_stone.map.json';
import zonesJson from './data/zones.json';
import camerasJson from './data/cameras.json';
import type { EscapeMethod, ItemId, Point } from './types';

export type InteractableKind =
  | 'container'
  | 'shop'
  | 'workbench'
  | 'stash'
  | 'vent'
  | 'wall'
  | 'solitaryDoor'
  | 'hideSpot'
  | 'bed'
  | 'tunnelSpot'
  | 'job'
  | 'cameraPanel'
  | 'gym'
  | 'bookshelf'
  | 'evidenceLocker'
  | 'shower'
  | 'gate'
  | 'vehicle'
  | 'fence'
  | 'powerPanel';

export interface Interactable {
  id: string;
  kind: InteractableKind;
  name: string;
  tiles: Point[];
  loot?: ItemId[];
  solitaryIndex?: number;
  safety?: number;
  capacity?: number;
  cellIndex?: number;
  zone?: string;
  /** Số ô của tủ / thùng (mặc định theo balance.json) */
  slots?: number;
  /** false = không tự bổ sung đồ mỗi sáng (vd. bàn cá nhân trong phòng giam) */
  refill?: boolean;
  /** Xe (data/vehicles.json) */
  vehicle?: string;
  /** Lớp hàng rào: inner | outer */
  ring?: string;
  /** Giường: hướng nằm, đầu giường, điểm nằm, ô đứng dậy (phía chân giường) */
  orientation?: 'horizontal' | 'vertical';
  headSide?: 'left' | 'right' | 'top' | 'bottom';
  sleepAnchor?: Point;
  wakeTile?: Point;
  /** Vòi sen: ô đứng dưới nước */
  showerSpot?: Point;
}

export interface ZoneDef {
  id: string;
  name: string;
  rects: [number, number, number, number][];
  restricted: boolean;
  /** Mức an ninh 0–3 (data/zones.json) */
  security: number;
  /** Thuộc khu xà lim (lịch "cellBlock") */
  cellBlock: boolean;
}

export interface EscapePoint {
  id: string;
  name: string;
  method: EscapeMethod;
  x: number;
  y: number;
}

export interface LightDef {
  x: number;
  y: number;
  radius: number;
  /** Đèn trong phòng giam — tắt sau giờ tắt đèn */
  cell: boolean;
}

export interface CameraDef {
  id: string;
  x: number;
  y: number;
  /** radian */
  angle: number;
  sweep: number;
  period: number;
  range: number;
  fov: number;
  /** Vùng mù ngay dưới chân camera (ô) */
  blindRadius: number;
  name: string;
}

export interface TowerDef {
  id: string;
  name: string;
  x: number;
  y: number;
  /** radian */
  angle: number;
  sweep: number;
  period: number;
}

export interface PrisonMap {
  id: string;
  name: string;
  width: number;
  height: number;
  tiles: string[];
  zones: ZoneDef[];
  zoneGrid: (string | null)[];
  areas: Record<string, [number, number, number, number]>;
  interactables: Interactable[];
  interactableById: Record<string, Interactable>;
  interactablesAt: Record<string, string[]>;
  cells: Point[];
  solitaryCells: { inside: Point; release: Point; doorId: string }[];
  inmateSpawns: Point[];
  guardRoutes: Record<string, Point[]>;
  escapePoints: EscapePoint[];
  lights: LightDef[];
  cameras: CameraDef[];
  towers: TowerDef[];
  /** Miệng hầm phía ngoài tường (đường hầm thông thì chui ra đây) */
  tunnelExit: Point | null;
  /** Điểm nhảy khỏi xe bên ngoài cổng, theo id xe */
  vehicleDrops: Record<string, Point>;
  /** Giường phòng y tế để người bị ngất tỉnh dậy (theo thứ tự) */
  infirmaryBeds: string[];
}

// ------------------------------------------------------------------ đọc định dạng Tiled
interface TiledProp {
  name: string;
  value: string | number | boolean;
}
interface TiledObject {
  id: number;
  name: string;
  type?: string;
  class?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  polyline?: Point[];
  properties?: TiledProp[];
}
interface TiledLayer {
  name: string;
  type: string;
  data?: number[];
  objects?: TiledObject[];
}
export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  properties?: TiledProp[];
  tilesets: {
    firstgid: number;
    tiles?: { id: number; properties?: TiledProp[] }[];
  }[];
  layers: TiledLayer[];
}

const prop = <T>(
  o: { properties?: TiledProp[] },
  name: string,
  fallback: T,
): T => {
  const p = o.properties?.find((x) => x.name === name);
  return (p ? p.value : fallback) as T;
};

interface ZoneMeta {
  security?: number;
  cellBlock?: boolean;
}

/** Thuộc tính khu theo id; khoá "abc_*" áp cho mọi id bắt đầu bằng "abc_" */
function zoneMeta(id: string): ZoneMeta {
  const all = zonesJson.zones as Record<string, ZoneMeta>;
  if (all[id]) return all[id];
  const wild = Object.keys(all).find(
    (k) => k.endsWith('*') && id.startsWith(k.slice(0, -1)),
  );
  return wild ? all[wild] : {};
}

export function parseTiledMap(raw: TiledMap): PrisonMap {
  const W = raw.width;
  const H = raw.height;
  const T = raw.tilewidth;
  const gidChar = new Map<number, string>();
  for (const ts of raw.tilesets)
    for (const t of ts.tiles ?? [])
      gidChar.set(ts.firstgid + t.id, prop(t, 'ch', '#'));
  const layer = (name: string) => raw.layers.find((l) => l.name === name);
  const objects = (name: string) => layer(name)?.objects ?? [];
  const cls = (o: TiledObject) => o.type ?? o.class ?? '';
  // floor + walls (ô tường đè lên sàn); bản đồ cũ: một lớp ground
  const floor = layer('floor')?.data ?? layer('ground')?.data;
  const walls = layer('walls')?.data;
  if (!floor || floor.length !== W * H || (walls && walls.length !== W * H))
    throw new Error('Bản đồ thiếu lớp floor/walls hợp lệ');
  const tiles: string[] = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) {
      const gid = walls?.[y * W + x] || floor[y * W + x];
      row += gidChar.get(gid) ?? '#';
    }
    tiles.push(row);
  }
  const rectTiles = (o: TiledObject): [number, number, number, number] => [
    Math.round(o.x / T),
    Math.round(o.y / T),
    Math.round((o.x + o.width) / T) - 1,
    Math.round((o.y + o.height) / T) - 1,
  ];

  const zones: ZoneDef[] = [];
  for (const o of objects('zones')) {
    const r = rectTiles(o);
    const existing = zones.find((z) => z.id === o.name);
    if (existing) existing.rects.push(r);
    else {
      const id = o.name.replace(/_south$/, '');
      const meta = zoneMeta(id);
      const security =
        meta.security ??
        prop(o, 'security', prop(o, 'restricted', false) ? 3 : 1);
      zones.push({
        id,
        name: prop(o, 'label', o.name),
        rects: [r],
        restricted: security >= 3,
        security,
        cellBlock: !!meta.cellBlock,
      });
    }
  }
  // gộp các zone cùng id (vd. hall + hall_south)
  const merged: ZoneDef[] = [];
  for (const z of zones) {
    const m = merged.find((x) => x.id === z.id);
    if (m) m.rects.push(...z.rects);
    else merged.push(z);
  }
  const zoneOrder = [
    ...merged.filter((z) => z.id !== 'outside'),
    ...merged.filter((z) => z.id === 'outside'),
  ];
  const zoneGrid: (string | null)[] = new Array(W * H).fill(null);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const ch = tiles[y][x];
      if (ch === '#') continue;
      if (ch === 'o' || ch === 'G') {
        zoneGrid[y * W + x] = 'outside';
        continue;
      }
      // khu "outside" phủ cả bản đồ: chỉ dùng khi không khu nào khác chứa ô này (bất kể thứ tự trong file Tiled)
      for (const z of zoneOrder)
        if (
          z.rects.some(
            ([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
          )
        ) {
          zoneGrid[y * W + x] = z.id;
          break;
        }
    }

  const areas: Record<string, [number, number, number, number]> = {};
  for (const o of objects('areas')) areas[o.name] = rectTiles(o);

  const interactables: Interactable[] = [
    ...objects('objects'),
    ...objects('interactables'),
  ].map((o) => {
    const [x0, y0, x1, y1] = rectTiles(o);
    const tilesOf: Point[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) tilesOf.push({ x, y });
    const loot = prop<string>(o, 'loot', '');
    const it: Interactable = {
      id: o.name,
      kind: cls(o) as InteractableKind,
      name: prop(o, 'label', o.name),
      tiles: tilesOf,
    };
    if (loot) it.loot = loot.split(',').map((s) => s.trim()) as ItemId[];
    const si = prop(o, 'solitaryIndex', -1);
    if (si >= 0) it.solitaryIndex = si;
    const ci = prop(o, 'cellIndex', -1);
    if (ci >= 0) it.cellIndex = ci;
    const safety = prop(o, 'safety', -1);
    if (safety >= 0) it.safety = safety;
    const cap = prop(o, 'capacity', 0);
    if (cap) it.capacity = cap;
    const zone = prop<string>(o, 'zone', '');
    if (zone) it.zone = zone;
    const slots = prop(o, 'slots', 0);
    if (slots) it.slots = slots;
    if (!prop(o, 'refill', true)) it.refill = false;
    const vehicle = prop<string>(o, 'vehicle', '');
    if (vehicle) it.vehicle = vehicle;
    const ring = prop<string>(o, 'ring', '');
    if (ring) it.ring = ring;
    if (it.kind === 'shower')
      it.showerSpot = {
        x: prop(o, 'showerSpotX', x0),
        y: prop(o, 'showerSpotY', y0 - 1),
      };
    if (it.kind === 'bed') {
      const horiz =
        tilesOf.length > 1
          ? tilesOf[0].y === tilesOf[tilesOf.length - 1].y
          : true;
      it.orientation = prop<string>(
        o,
        'orientation',
        horiz ? 'horizontal' : 'vertical',
      ) as Interactable['orientation'];
      it.headSide = prop<string>(
        o,
        'headSide',
        it.orientation === 'horizontal' ? 'left' : 'top',
      ) as Interactable['headSide'];
      const cx = (x0 + x1 + 1) / 2;
      const cy = (y0 + y1 + 1) / 2;
      it.sleepAnchor = {
        x: prop(o, 'sleepAnchorX', cx),
        y: prop(o, 'sleepAnchorY', cy),
      };
      // mặc định: ô kế bên phía chân giường
      const foot = {
        left: { x: x1 + 1, y: y1 },
        right: { x: x0 - 1, y: y0 },
        top: { x: x0, y: y1 + 1 },
        bottom: { x: x0, y: y0 - 1 },
      }[it.headSide ?? 'top'];
      it.wakeTile = {
        x: prop(o, 'wakeTileX', foot.x),
        y: prop(o, 'wakeTileY', foot.y),
      };
    }
    return it;
  });
  const interactableById: Record<string, Interactable> = {};
  const interactablesAt: Record<string, string[]> = {};
  for (const it of interactables) {
    interactableById[it.id] = it;
    for (const t of it.tiles)
      (interactablesAt[`${t.x},${t.y}`] ??= []).push(it.id);
  }

  const pt = (o: TiledObject): Point => ({ x: o.x / T, y: o.y / T });
  const spawns = objects('spawns');
  const byKind = (k: string) =>
    spawns
      .filter((o) => cls(o) === k)
      .sort((a, b) => prop(a, 'index', 0) - prop(b, 'index', 0))
      .map(pt);
  const cells = byKind('cell');
  const inside = byKind('solitaryInside');
  const release = byKind('solitaryRelease');
  const doors = interactables
    .filter((i) => i.kind === 'solitaryDoor')
    .sort((a, b) => (a.solitaryIndex ?? 0) - (b.solitaryIndex ?? 0));

  const guardRoutes: Record<string, Point[]> = {};
  for (const o of objects('guard_routes'))
    guardRoutes[o.name] = (o.polyline ?? []).map((p) => ({
      x: (o.x + p.x) / T,
      y: (o.y + p.y) / T,
    }));

  const deg = Math.PI / 180;
  const camDef = camerasJson.defaults;
  const tunnelExit = spawns.find((o) => cls(o) === 'tunnelExit');
  const vehicleDrops: Record<string, Point> = {};
  for (const o of spawns)
    if (cls(o) === 'vehicleDrop')
      vehicleDrops[prop(o, 'vehicle', o.name)] = pt(o);
  return {
    id: prop(raw, 'id', 'map'),
    name: prop(raw, 'name', 'Nhà tù'),
    width: W,
    height: H,
    tiles,
    zones: merged,
    zoneGrid,
    areas,
    interactables,
    interactableById,
    interactablesAt,
    cells,
    solitaryCells: doors.map((d, i) => ({
      inside: inside[i],
      release: release[i],
      doorId: d.id,
    })),
    inmateSpawns: byKind('inmate'),
    guardRoutes,
    escapePoints: [...objects('escape'), ...objects('exits')].map((o) => ({
      id: o.name,
      name: prop(o, 'label', o.name),
      method: prop(o, 'method', 'VENT') as EscapeMethod,
      ...pt(o),
    })),
    lights: objects('lights').map((o) => ({
      ...pt(o),
      radius: prop(o, 'radius', 4),
      cell: prop(o, 'cell', false),
    })),
    cameras: objects('cameras').map((o) => ({
      id: o.name,
      ...pt(o),
      name: prop(o, 'label', o.name),
      angle: prop(o, 'angle', 0) * deg,
      sweep: prop(o, 'sweep', camDef.sweep) * deg,
      period: prop(o, 'period', camDef.period),
      range: prop(o, 'range', camDef.range),
      fov: prop(o, 'fov', camDef.fov) * deg,
      blindRadius: prop(o, 'blindRadius', camDef.blindRadius),
    })),
    towers: spawns
      .filter((o) => cls(o) === 'tower')
      .map((o) => ({
        id: o.name,
        name: prop(o, 'label', o.name),
        ...pt(o),
        angle: prop(o, 'angle', 0) * deg,
        sweep: prop(o, 'sweep', 30) * deg,
        period: prop(o, 'period', 16),
      })),
    tunnelExit: tunnelExit ? pt(tunnelExit) : null,
    infirmaryBeds: spawns
      .filter((o) => cls(o) === 'infirmaryBed')
      .sort((a, b) => prop(a, 'index', 0) - prop(b, 'index', 0))
      .map((o) => prop<string>(o, 'bed', '')),
    vehicleDrops,
  };
}

/** Mọi giường phải có điểm nằm và ô dậy hợp lệ (ô dậy là sàn đi được, trong bản đồ) — sai thì báo lỗi ngay khi nạp */
export function validateBeds(map: PrisonMap): string[] {
  const errors: string[] = [];
  for (const b of map.interactables) {
    if (b.kind !== 'bed') continue;
    if (!b.sleepAnchor || !b.wakeTile) {
      errors.push(`${b.id}: thiếu sleepAnchor / wakeTile`);
      continue;
    }
    const { x, y } = b.wakeTile;
    const ch =
      x < 0 || y < 0 || x >= map.width || y >= map.height
        ? '#'
        : map.tiles[y][x];
    if (ch !== '.' && ch !== ',')
      errors.push(`${b.id}: ô dậy (${x},${y}) không đi được ("${ch}")`);
    const inBed = b.tiles.some(
      (t) =>
        b.sleepAnchor!.x >= t.x &&
        b.sleepAnchor!.x <= t.x + 1 &&
        b.sleepAnchor!.y >= t.y &&
        b.sleepAnchor!.y <= t.y + 1,
    );
    if (!inBed) errors.push(`${b.id}: điểm nằm không nằm trên giường`);
  }
  return errors;
}

export const PRISON_MAP: PrisonMap = parseTiledMap(
  rawMap as unknown as TiledMap,
);
{
  const bad = validateBeds(PRISON_MAP);
  if (bad.length)
    throw new Error(
      `Bản đồ ${PRISON_MAP.id}: giường không hợp lệ — ${bad.join('; ')}`,
    );
}

export function tileAt(map: PrisonMap, tx: number, ty: number): string {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return '#';
  return map.tiles[ty][tx];
}

export function zoneAt(map: PrisonMap, x: number, y: number): string | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return 'outside';
  return map.zoneGrid[ty * map.width + tx];
}

export const ZONE_BY_ID: Record<string, ZoneDef> = Object.fromEntries(
  PRISON_MAP.zones.map((z) => [z.id, z]),
);

export function zoneName(id: string | null): string {
  return (id && ZONE_BY_ID[id]?.name) || '—';
}

export function inArea(
  map: PrisonMap,
  area: string,
  x: number,
  y: number,
): boolean {
  const r = map.areas[area];
  if (!r) return false;
  return x >= r[0] && x < r[2] + 1 && y >= r[1] && y < r[3] + 1;
}

/** Khu xà lim (xà lim + hành lang khu xà lim) — theo cờ cellBlock trong data/zones.json */
export function inCellBlock(x: number, y: number): boolean {
  const z = zoneAt(PRISON_MAP, x, y);
  return !!z && !!ZONE_BY_ID[z]?.cellBlock;
}

/** Ô chắn tầm nhìn (song sắt xà lim, hàng rào thép, tháp canh nhìn xuyên được) */
export function isOpaque(ch: string): boolean {
  return (
    ch === '#' ||
    ch === 'L' ||
    ch === 'R' ||
    ch === 'V' ||
    ch === 'W' ||
    ch === 'G' ||
    ch === 'K' ||
    ch === 'u'
  );
}

/** Gần đèn đang bật? (tầm nhìn ban đêm) */
export function litAt(
  map: PrisonMap,
  x: number,
  y: number,
  cellLightsOn: boolean,
): boolean {
  for (const l of map.lights) {
    if (l.cell && !cellLightsOn) continue;
    if (Math.hypot(l.x - x, l.y - y) <= l.radius) return true;
  }
  return false;
}
