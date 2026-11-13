// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
/**
 * GIAO THỨC BIDA LỖ ONLINE (dùng chung client & server — server có bản sao trong
 * login-system/src/pool/shared/, đồng bộ bằng `npm run pool:sync-shared`).
 * Không phụ thuộc thư viện: tự kiểm tra kiểu & phạm vi để server từ chối input bậy.
 */
import { POOL_PHYSICS, type PoolConfig } from './physics/config';
import { dcos, dsin, hashNumbers } from './physics/math';
import type { BallSpot, ShotCommand } from './physics/types';
import type { CallShot, DecisionChoice } from './rules/types';

export const POOL_PROTOCOL_VERSION = 1;

/** Đồng hồ (giây): mỗi cú 30 s; cú đầu sau phá & khi có bi trong tay 60 s; 1 lần gia hạn +30 s / ván */
export const SHOT_CLOCK = {
  normal: 30,
  long: 60,
  extension: 30,
  extensionsPerRack: 1,
} as const;
/** Giữ ghế khi mất kết nối (ms) — đồng hồ của người đó tạm dừng tối đa chừng ấy */
export const RECONNECT_GRACE_MS = 60_000;
/** Tần suất tối đa của AIM_UPDATE (ms giữa 2 gói) */
export const AIM_MIN_INTERVAL_MS = 60;

export type PoolErrorCode =
  | 'BAD_VERSION'
  | 'BAD_INPUT'
  | 'NOT_IN_ROOM'
  | 'SPECTATOR'
  | 'NOT_YOUR_TURN'
  | 'WRONG_PHASE'
  | 'STALE_SEQ'
  | 'OUT_OF_RANGE'
  | 'CUE_BLOCKED'
  | 'STATE_MISMATCH'
  | 'INVALID_PLACEMENT'
  | 'INVALID_OPTION'
  | 'NO_EXTENSION'
  | 'RATE_LIMIT';

export const ERROR_MESSAGES: Record<PoolErrorCode, string> = {
  BAD_VERSION: 'Phiên bản giao thức không khớp — hãy tải lại trang',
  BAD_INPUT: 'Dữ liệu không hợp lệ',
  NOT_IN_ROOM: 'Bạn không ở trong phòng',
  SPECTATOR: 'Khán giả không thể thao tác',
  NOT_YOUR_TURN: 'Chưa tới lượt bạn',
  WRONG_PHASE: 'Không thể thao tác lúc này',
  STALE_SEQ: 'Cú đánh đã cũ (trạng thái đã thay đổi)',
  OUT_OF_RANGE: 'Giá trị vượt giới hạn vật lý',
  CUE_BLOCKED:
    'Cơ đang vướng bi hoặc thành băng — hãy nâng góc cơ hoặc đổi hướng ngắm',
  STATE_MISMATCH: 'Trạng thái bàn không khớp máy chủ — đã đồng bộ lại',
  INVALID_PLACEMENT: 'Vị trí đặt bi cái không hợp lệ',
  INVALID_OPTION: 'Lựa chọn không hợp lệ',
  NO_EXTENSION: 'Bạn đã dùng hết lượt gia hạn',
  RATE_LIMIT: 'Thao tác quá nhanh',
};

// ===================== Client -> Server =====================

export interface ShotInput {
  v: number;
  /** Số thứ tự trạng thái mà client nhìn thấy (phải bằng seq hiện tại của server) */
  seq: number;
  /** Chống xử lý trùng khi gửi lặp / kết nối lại */
  shotId: string;
  aimAngle: number;
  power: number;
  tipX: number;
  tipY: number;
  elevation: number;
  call?: CallShot | null;
  safety?: boolean;
  pushOut?: boolean;
  /** Băm vị trí bi client đang thấy (phải khớp server) */
  clientStateHash: string;
}

export interface AimUpdate {
  v: number;
  dirX: number;
  dirY: number;
  power: number;
  tipX: number;
  tipY: number;
  elevation: number;
  call?: CallShot | null;
}

export interface PlaceCueInput {
  v: number;
  seq: number;
  x: number;
  y: number;
}

export interface OptionInput {
  v: number;
  seq: number;
  choice: DecisionChoice;
}

type Result<T> = { ok: true; value: T } | { ok: false; code: PoolErrorCode };

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;
const num = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x);
const fail = <T>(code: PoolErrorCode): Result<T> => ({ ok: false, code });

function readCall(x: unknown): CallShot | null | undefined | false {
  if (x === undefined || x === null) return x as null | undefined;
  if (!isObj(x) || !Number.isInteger(x.ball) || !Number.isInteger(x.pocket))
    return false;
  const ball = x.ball as number;
  const pocket = x.pocket as number;
  if (ball < 1 || ball > 15 || pocket < 0 || pocket > 5) return false;
  return { ball, pocket };
}

export function validateShotInput(
  x: unknown,
  c: PoolConfig = POOL_PHYSICS,
): Result<ShotInput> {
  if (!isObj(x)) return fail('BAD_INPUT');
  if (x.v !== POOL_PROTOCOL_VERSION) return fail('BAD_VERSION');
  if (
    !Number.isInteger(x.seq) ||
    typeof x.shotId !== 'string' ||
    x.shotId.length > 64 ||
    typeof x.clientStateHash !== 'string'
  )
    return fail('BAD_INPUT');
  for (const k of ['aimAngle', 'power', 'tipX', 'tipY', 'elevation'])
    if (!num(x[k])) return fail('BAD_INPUT');
  const power = x.power as number;
  const tipX = x.tipX as number;
  const tipY = x.tipY as number;
  const elevation = x.elevation as number;
  const aimAngle = x.aimAngle as number;
  // Lực 0..1 (≤ maxCueSpeed = 12 m/s), điểm chạm trong vòng tròn đơn vị (≤ maxTipOffset·R), góc cơ ≤ 80°
  if (power < 0 || power > 1) return fail('OUT_OF_RANGE');
  if (tipX * tipX + tipY * tipY > 1 + 1e-9) return fail('OUT_OF_RANGE');
  if (elevation < 0 || elevation > c.maxElevation) return fail('OUT_OF_RANGE');
  if (Math.abs(aimAngle) > 100) return fail('OUT_OF_RANGE');
  const call = readCall(x.call);
  if (call === false) return fail('BAD_INPUT');
  return {
    ok: true,
    value: {
      v: POOL_PROTOCOL_VERSION,
      seq: x.seq as number,
      shotId: x.shotId,
      aimAngle,
      power,
      tipX,
      tipY,
      elevation,
      call: call ?? null,
      safety: x.safety === true,
      pushOut: x.pushOut === true,
      clientStateHash: x.clientStateHash,
    },
  };
}

export function validateAim(x: unknown): Result<AimUpdate> {
  if (!isObj(x)) return fail('BAD_INPUT');
  if (x.v !== POOL_PROTOCOL_VERSION) return fail('BAD_VERSION');
  for (const k of ['dirX', 'dirY', 'power', 'tipX', 'tipY', 'elevation'])
    if (!num(x[k])) return fail('BAD_INPUT');
  const call = readCall(x.call);
  if (call === false) return fail('BAD_INPUT');
  const clamp = (v: number, a: number, b: number) =>
    Math.max(a, Math.min(b, v));
  return {
    ok: true,
    value: {
      v: POOL_PROTOCOL_VERSION,
      dirX: clamp(x.dirX as number, -10, 10),
      dirY: clamp(x.dirY as number, -10, 10),
      power: clamp(x.power as number, 0, 1),
      tipX: clamp(x.tipX as number, -1, 1),
      tipY: clamp(x.tipY as number, -1, 1),
      elevation: clamp(x.elevation as number, 0, 90),
      call: call ?? null,
    },
  };
}

export function validatePlace(x: unknown): Result<PlaceCueInput> {
  if (!isObj(x)) return fail('BAD_INPUT');
  if (x.v !== POOL_PROTOCOL_VERSION) return fail('BAD_VERSION');
  if (!Number.isInteger(x.seq) || !num(x.x) || !num(x.y))
    return fail('BAD_INPUT');
  return {
    ok: true,
    value: {
      v: POOL_PROTOCOL_VERSION,
      seq: x.seq as number,
      x: x.x as number,
      y: x.y as number,
    },
  };
}

const CHOICES: DecisionChoice[] = [
  'acceptTable',
  'rerackSelfBreak',
  'rerackOpponentBreak',
  'spotAndContinue',
  'rerack',
  'spotWithBallInHand',
  'shoot',
  'passBack',
];
export function validateOption(x: unknown): Result<OptionInput> {
  if (!isObj(x)) return fail('BAD_INPUT');
  if (x.v !== POOL_PROTOCOL_VERSION) return fail('BAD_VERSION');
  if (!Number.isInteger(x.seq) || !CHOICES.includes(x.choice as DecisionChoice))
    return fail('BAD_INPUT');
  return {
    ok: true,
    value: {
      v: POOL_PROTOCOL_VERSION,
      seq: x.seq as number,
      choice: x.choice as DecisionChoice,
    },
  };
}

/** Lệnh đánh từ góc ngắm — dùng dcos/dsin để client & server ra hướng bit-giống-nhau */
export function shotCommandFromInput(
  i: Pick<ShotInput, 'aimAngle' | 'power' | 'tipX' | 'tipY' | 'elevation'>,
): ShotCommand {
  return {
    dirX: dcos(i.aimAngle),
    dirY: dsin(i.aimAngle),
    power: i.power,
    tipX: i.tipX,
    tipY: i.tipY,
    elevation: i.elevation,
  };
}

/** Băm vị trí bi hiện tại (client gửi kèm cú đánh để chứng minh đang nhìn đúng trạng thái) */
export function ballsHash(balls: BallSpot[]): string {
  const nums: number[] = [];
  for (const b of balls) nums.push(b.n, b.x, b.y);
  return hashNumbers(nums);
}
