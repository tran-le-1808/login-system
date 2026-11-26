// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/**
 * Thông số Prison Break – Last Chance. Mọi con số gameplay nằm trong data/*.json (giá trị prototype,
 * cần playtest để cân bằng) — file này chỉ gom lại và gắn kiểu.
 */
import balance from './data/balance.json';
import guards from './data/guards.json';
import roles from './data/roles.json';
import routines from './data/routines.json';
import type { Difficulty, Role } from './types';

function hhmm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/** Thời lượng thao tác có thanh tiến trình × actionTimeScale (0.5 = nhanh gấp đôi). Không áp cho ngủ, cooldown, lịch. */
export function actionSeconds(seconds: number): number {
  return Math.round(seconds * balance.actionTimeScale * 1000) / 1000;
}

export const PRISON_CONFIG = {
  ...balance,
  clock: { ...balance.clock, startMinuteOfDay: hhmm(routines.startTime) },
  guard: guards,
};

export interface DifficultyPreset {
  guardVision: number;
  guardSpeed: number;
  heatMultiplier: number;
  searchFindBonus: number;
}

export const DIFFICULTY_PRESETS: Record<Difficulty, DifficultyPreset> =
  guards.difficulty;

export interface RoleDef {
  name: string;
  perk: string;
  color: string;
  speed: number;
  channelTime: number;
  noise: number;
  /** Mechanic: chế tạo nhanh hơn, +10% thành công, dụng cụ +1 độ bền, hình nộm chân thực hơn */
  craftBonus: boolean;
  breakFree: boolean;
  skills: Partial<
    Record<'crafting' | 'fitness' | 'dexterity' | 'social', number>
  >;
}

export const ROLE_MODIFIERS: Record<Role, RoleDef> = roles;
export const ROLE_INFO = ROLE_MODIFIERS;

export interface PeriodDef {
  id: string;
  name: string;
  /** Hoạt động mô tả cho người chơi */
  rule: string;
  /** any | ownCell | cellBlock | rollcall | work | <zone id> */
  required: string;
  severity: 'minor' | 'serious';
  startMinute: number;
  endMinute: number;
  /** Giờ bắt đầu thật của khung (khung qua nửa đêm bị tách đôi) */
  originMinute: number;
  /** true với phần sau nửa đêm của khung qua đêm: không phát sự kiện bắt đầu */
  cont: boolean;
  rollCall?: boolean;
  workShift?: boolean;
  showerCheck?: boolean;
  sleepOk?: boolean;
  night?: boolean;
}

type RawPeriod = {
  id: string;
  start?: string;
  end?: string;
  name: string;
  activity: string;
  requiredZone: string;
  severity: string;
  rollCall?: boolean;
  workShift?: boolean;
  showerCheck?: boolean;
  sleepOk?: boolean;
  night?: boolean;
};

const mkPeriod = (
  r: RawPeriod,
  startMinute: number,
  endMinute: number,
  originMinute: number,
  cont: boolean,
): PeriodDef => ({
  id: r.id,
  name: r.name,
  rule: r.activity,
  required: r.requiredZone,
  severity: r.severity as 'minor' | 'serious',
  startMinute,
  endMinute,
  originMinute,
  cont,
  rollCall: r.rollCall,
  workShift: r.workShift,
  showerCheck: r.showerCheck,
  sleepOk: r.sleepOk,
  night: r.night,
});

/** Bảng 11 khung theo dữ liệu (routines.json), cộng đoạn nghỉ ngầm định lấp các khoảng trống */
function buildSegments(): { table: PeriodDef[]; segments: PeriodDef[] } {
  const table: PeriodDef[] = [];
  const segments: PeriodDef[] = [];
  for (const r of routines.periods as RawPeriod[]) {
    const s = hhmm(r.start!);
    const e = hhmm(r.end!);
    table.push(mkPeriod(r, s, e, s, false));
    if (e > s) segments.push(mkPeriod(r, s, e, s, false));
    else {
      segments.push(mkPeriod(r, s, 1440, s, false));
      if (e > 0) segments.push(mkPeriod(r, 0, e, s, true));
    }
  }
  segments.sort((a, b) => a.startMinute - b.startMinute);
  const gap = routines.gap as RawPeriod;
  const filled: PeriodDef[] = [];
  let cursor = 0;
  for (const seg of segments) {
    if (seg.startMinute > cursor)
      filled.push(mkPeriod(gap, cursor, seg.startMinute, cursor, false));
    filled.push(seg);
    cursor = seg.endMinute;
  }
  if (cursor < 1440) filled.push(mkPeriod(gap, cursor, 1440, cursor, false));
  return { table, segments: filled };
}

const built = buildSegments();

export const ROUTINE = {
  /** Đúng bảng lịch trong routines.json (11 khung) */
  periods: built.table,
  /** Mọi đoạn trong ngày (kể cả đoạn nghỉ ngầm định và phần sau nửa đêm), sắp theo giờ */
  segments: built.segments,
  graceMinutes: routines.graceMinutes,
  bellBeforeMinutes: routines.bellBeforeMinutes,
  workChecksMinutes: routines.workChecksMinutes,
  roomSearchMinutes: routines.roomSearchTimes.map(hhmm),
  nightChecks: routines.nightChecks.map((c) => ({
    minute: hhmm(c.time),
    kind: c.kind as 'glance' | 'rollcall',
  })),
  dayLimitDefault: routines.dayLimitDefault,
};

export const PLAYER_COLORS = ['#f97316', '#a855f7', '#22d3ee', '#facc15'];
