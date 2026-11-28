import type { MSState, MSView } from './shared/game';
import type { MSBotLevel } from './shared/bot';

export const MS_MAX_PLAYERS = 12;
export const DISCUSS_OPTIONS = [60, 90, 120, 180];
/** Thời gian các giai đoạn (giây) — ngày thảo luận theo cài đặt phòng */
export const PHASE_SECONDS = { night: 30, witch: 20, vote: 30, hunter: 20 };

export type RoomStatus = 'lobby' | 'playing' | 'finished';
export type ChatChannel = 'all' | 'wolf' | 'dead';

export interface MSRoomSettings {
  isPrivate: boolean;
  discussSeconds: number;
  quick: boolean;
  /** Lộ vai khi chết */
  reveal: boolean;
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
  botLevel?: MSBotLevel | null;
}

export interface RoomChatMessage {
  id: string;
  userId: string;
  name: string;
  avatar?: string;
  seat: number;
  text: string;
  createdAt: number;
  channel: ChatChannel;
}

export interface MSMatch {
  state: MSState;
  players: string[];
  names: string[];
  bots: (MSBotLevel | null)[];
  deadline: number;
  /** pid của giai đoạn mà deadline đang áp dụng */
  deadlinePid: number;
  startedAt: number;
  seq: number;
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: MSRoomSettings;
  players: RoomPlayer[];
  chat: RoomChatMessage[];
  match: MSMatch | null;
  /** Ai đang bật voice (userId -> tắt mic?) */
  voice: Record<string, { muted: boolean }>;
  games: number;
  createdAt: number;
}

export interface PublicRoom {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: MSRoomSettings;
  players: Omit<RoomPlayer, 'socketId'>[];
  createdAt: number;
}

export interface MSSnapshot extends MSView {
  seq: number;
  players: string[];
  names: string[];
  bots: boolean[];
  connected: boolean[];
  deadline: number;
  serverNow: number;
  games: number;
  startedAt: number;
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}
