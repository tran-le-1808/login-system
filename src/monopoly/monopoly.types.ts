export const MONOPOLY_MAX_PLAYERS = 4;
export const MONOPOLY_MIN_PLAYERS = 2;

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface RoomSettings {
  isPrivate: boolean;
  startingMoney: number;
}

export interface RoomPlayer {
  userId: string;
  name: string;
  avatar?: string;
  /** Ghế 0..3, quyết định quân cờ và màu */
  seat: number;
  ready: boolean;
  connected: boolean;
  socketId: string | null;
  joinedAt: number;
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

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: RoomSettings;
  players: RoomPlayer[];
  /** Trạng thái game mới nhất do host gửi lên (để rejoin / chuyển host) */
  snapshot: unknown;
  chat: RoomChatMessage[];
  /** Voice chat: những người đang bật voice (userId -> đang tắt mic hay không) */
  voice: Record<string, { muted: boolean }>;
  createdAt: number;
}

/** Dữ liệu phòng gửi cho client (không có snapshot / socketId) */
export interface PublicRoom {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: RoomSettings;
  players: Omit<RoomPlayer, 'socketId'>[];
  createdAt: number;
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}
