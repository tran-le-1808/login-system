import type { SMEvent, SMState } from './shared/cards';
import type { SMBotLevel } from './shared/bot';

export const SM_MAX_PLAYERS = 4;
export const TURN_OPTIONS = [15, 20, 30];

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface SMRoomSettings {
  isPrivate: boolean;
  /** Thời gian mỗi lượt (giây); hết giờ tự bốc bài và bỏ lượt */
  turnSeconds: number;
  quick: boolean;
  /** Cho phép cộng dồn +2 / +4 */
  stack: boolean;
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
  botLevel?: SMBotLevel | null;
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

export interface SMMatch {
  state: SMState;
  /** userId theo vị trí trong ván (0..n-1) */
  players: string[];
  names: string[];
  bots: (SMBotLevel | null)[];
  deadline: number;
  lastScores: number[] | null;
  seq: number;
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: SMRoomSettings;
  players: RoomPlayer[];
  chat: RoomChatMessage[];
  match: SMMatch | null;
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
  settings: SMRoomSettings;
  players: Omit<RoomPlayer, 'socketId'>[];
  createdAt: number;
}

/** Trạng thái ván gửi riêng cho từng người (chỉ thấy bài của mình) */
export interface SMSnapshot {
  seq: number;
  n: number;
  mySeat: number;
  players: string[];
  names: string[];
  bots: boolean[];
  connected: boolean[];
  counts: number[];
  hand: number[];
  top: number;
  color: number;
  dir: 1 | -1;
  turn: number;
  pending: number;
  /** Lá mình vừa bốc (null nếu không phải lượt mình / chưa bốc) */
  drawn: number | null;
  playable: number[];
  pileCount: number;
  called: boolean[];
  stack: boolean;
  over: boolean;
  winner: number | null;
  events: SMEvent[];
  deadline: number;
  serverNow: number;
  turnSeconds: number;
  scores: number[];
  lastScores: number[] | null;
  revealed: number[][] | null;
  games: number;
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}
