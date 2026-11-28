import type { TablePlay, TLEvent, TLState } from './shared/cards';
import type { TLBotLevel } from './shared/bot';

export const TL_MAX_PLAYERS = 4;
export const TURN_OPTIONS = [15, 20, 30];

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface TLRoomSettings {
  isPrivate: boolean;
  /** Thời gian mỗi lượt (giây); hết giờ tự bỏ lượt / tự đánh lá nhỏ nhất */
  turnSeconds: number;
  quick: boolean;
}

export interface RoomPlayer {
  userId: string;
  name: string;
  avatar?: string;
  seat: number;
  ready: boolean;
  connected: boolean;
  socketId: string | null;
  joinedAt: number;
  /** Máy (null = người) */
  botLevel?: TLBotLevel | null;
}

export interface RoomChatMessage {
  id: string;
  userId: string;
  name: string;
  avatar?: string;
  seat: number;
  text: string;
  createdAt: number;
}

export interface TLMatch {
  state: TLState;
  /** userId theo vị trí trong ván (0..n-1) */
  players: string[];
  names: string[];
  bots: (TLBotLevel | null)[];
  deadline: number;
  lastScores: number[] | null;
  seq: number;
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: TLRoomSettings;
  players: RoomPlayer[];
  chat: RoomChatMessage[];
  match: TLMatch | null;
  /** Điểm cộng dồn theo userId */
  scores: Record<string, number>;
  /** userId người nhất ván trước (đi trước ván sau) */
  lastWinner: string | null;
  games: number;
  createdAt: number;
}

export interface PublicRoom {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: TLRoomSettings;
  players: Omit<RoomPlayer, 'socketId'>[];
  createdAt: number;
}

/** Trạng thái ván gửi riêng cho từng người (chỉ thấy bài của mình) */
export interface TLSnapshot {
  seq: number;
  n: number;
  mySeat: number;
  players: string[];
  names: string[];
  bots: boolean[];
  connected: boolean[];
  counts: number[];
  hand: number[];
  turn: number;
  table: TablePlay | null;
  passed: boolean[];
  finished: number[];
  mustPlay: number;
  over: boolean;
  instant: { seat: number; reason: string } | null;
  events: TLEvent[];
  deadline: number;
  serverNow: number;
  turnSeconds: number;
  scores: number[];
  lastScores: number[] | null;
  /** Bài còn lại của mọi người khi hết ván */
  revealed: number[][] | null;
  games: number;
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}
