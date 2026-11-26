import type { Side, ChessMove, ChessState } from './shared/rules';

export const CHESS_MAX_PLAYERS = 2;
/** Thời gian mỗi bên (phút) */
export const TIME_OPTIONS = [3, 5, 10, 15];

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface ChessRoomSettings {
  isPrivate: boolean;
  /** Thời gian suy nghĩ của mỗi bên cho cả ván (phút); hết giờ = thua */
  timeMinutes: number;
  /** Phòng tạo từ ghép trận nhanh */
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

export interface ChessMatch {
  state: ChessState;
  /** Ghế cầm quân Trắng (đi trước) — đổi luân phiên mỗi ván */
  whiteSeat: number;
  players: [string, string];
  names: [string, string];
  /** Thời gian còn lại của mỗi ghế (ms), tính tới lúc turnStart */
  clocks: [number, number];
  turnStart: number;
  pausedAt: number | null;
  /** Ghế đang xin hoà (null = không) */
  drawOffer: number | null;
  winnerSeat: number | null;
  endReason: string | null;
  startedAt: number;
  endedAt: number | null;
  seq: number;
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: ChessRoomSettings;
  players: RoomPlayer[];
  chat: RoomChatMessage[];
  match: ChessMatch | null;
  score: [number, number];
  games: number;
  createdAt: number;
}

export interface PublicRoom {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: ChessRoomSettings;
  players: Omit<RoomPlayer, 'socketId'>[];
  createdAt: number;
}

export interface ChessSnapshot {
  seq: number;
  b: number[];
  castle: number;
  ep: number;
  half: number;
  moves: ChessMove[];
  san: string[];
  captures: number[];
  checks: boolean[];
  turn: Side;
  whiteSeat: number;
  players: [string, string];
  names: [string, string];
  clocks: [number, number];
  turnStart: number;
  pausedAt: number | null;
  serverNow: number;
  drawOffer: number | null;
  winnerSeat: number | null;
  draw: boolean;
  endReason: string | null;
  score: [number, number];
  timeMinutes: number;
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}
