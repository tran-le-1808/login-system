// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Hợp đồng sự kiện Socket.IO (namespace /game) — dùng chung client/server. */
import type { ActionResult, ErrorCode } from './types';

export const PRISON_NAMESPACE = '/game';
export const PRISON_PROTOCOL_VERSION = 1;
export const MAX_PLAYERS = 4;
export const roomChannel = (code: string) => `prison_room_${code}`;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED: 'Bạn cần đăng nhập',
  ROOM_NOT_FOUND: 'Không tìm thấy phòng',
  ROOM_FULL: 'Phòng đã đủ 4 người',
  NOT_ROOM_MEMBER: 'Bạn không thuộc phòng này',
  FORBIDDEN: 'Bạn không có quyền',
  INVALID_STATE: 'Không thể thực hiện lúc này',
  INVALID_PAYLOAD: 'Dữ liệu không hợp lệ',
  OUT_OF_RANGE: 'Ngoài khoảng cách tương tác',
  ITEM_NOT_OWNED: 'Bạn không có vật phẩm này',
  INSUFFICIENT_ITEMS: 'Không đủ số lượng',
  OVER_CAPACITY: 'Vượt quá sức chứa',
  RATE_LIMITED: 'Thao tác quá nhanh',
  DUPLICATE_REQUEST: 'Yêu cầu đã được xử lý',
  CONFLICT: 'Trạng thái đã thay đổi',
  NOT_FOUND: 'Không tìm thấy',
  REQUIREMENTS_NOT_MET: 'Chưa đủ điều kiện',
};

export type Ack<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; code: ErrorCode; message: string; requestId?: string };

export type RoomStatus =
  | 'WAITING'
  | 'STARTING'
  | 'PLAYING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CLOSED';

export interface RoomSettings {
  prisonId: string;
  difficulty: 'NORMAL' | 'HARD' | 'HARDCORE';
  allowLateJoin: boolean;
  privateRoom: boolean;
  maxPlayers: 1 | 2 | 3 | 4;
}

export interface RoomMemberView {
  userId: string;
  name: string;
  avatar?: string;
  role: 'HACKER' | 'FIGHTER' | 'MECHANIC' | 'SCOUT';
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  joinedAt: number;
}

export interface RoomView {
  roomCode: string;
  hostId: string;
  status: RoomStatus;
  settings: RoomSettings;
  members: RoomMemberView[];
  createdAt: number;
}

/** Bản đồ sự kiện client -> server và tên hành động engine tương ứng */
export const ACTION_EVENTS = {
  'player:interact': 'interact',
  'player:cancel': 'cancelChannel',
  'player:use-item': 'useItem',
  'player:drop-item': 'dropItem',
  'player:throw-item': 'throwItem',
  'player:pickup-all': 'pickupAll',
  'player:assist': 'assist',
  'player:revive': 'revive',
  'crafting:craft': 'craft',
  'team-storage:deposit': 'deposit',
  'team-storage:withdraw': 'withdraw',
  'player:trade-request': 'tradeRequest',
  'player:trade-accept': 'tradeAccept',
  'player:trade-decline': 'tradeDecline',
  'quest:accept': 'questAccept',
  'quest:complete': 'questComplete',
  'quest:abandon': 'questAbandon',
  'quest:contribute': 'questContribute',
  'rescue:start': 'rescueStart',
  'rescue:cancel': 'rescueCancel',
  'escape:prepare': 'escapePrepare',
  'escape:ready': 'escapeReady',
  'escape:start': 'escapeStart',
  'escape:enter-point': 'escapeEnterPoint',
  'escape:cancel': 'escapeCancel',
  'combat:attack': 'attack',
  'combat:equip': 'equip',
  'container:take': 'containerTake',
  'container:put': 'containerPut',
  'bed:take': 'bedTake',
  'bed:place': 'bedPlace',
  'player:hide': 'hide',
  'player:retrieve': 'retrieve',
  'player:flush': 'flush',
  'tunnel:action': 'tunnel',
  'player:wake': 'wake',
  'dig:tile': 'dig',
  'dig:hatch': 'hatch',
  'decor:place': 'placeDecor',
  'decor:take': 'takeDecor',
  'shop:buy': 'buy',
  'shop:sell': 'sell',
  'npc:talk': 'npcTalk',
  'npc:buy': 'npcBuy',
  'guard:bribe': 'bribe',
} as const;

export type ActionEventName = keyof typeof ACTION_EVENTS;

export function ackFromResult(
  result: ActionResult,
  requestId?: string,
): Ack<Record<string, string | number | boolean>> {
  if (result.ok)
    return {
      ok: true,
      data: {
        ...(result.data ?? {}),
        ...(result.duplicate ? { duplicate: true } : {}),
      },
    };
  return { ok: false, code: result.code, message: result.message, requestId };
}
