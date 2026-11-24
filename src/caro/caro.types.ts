import type { CaroGameState, CaroRule, Stone } from './shared/rules';

export const CARO_MAX_PLAYERS = 2;
export const TURN_SECONDS_OPTIONS = [15, 30, 60];

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface CaroRoomSettings {
  isPrivate: boolean;
  rule: CaroRule;
  /** Thời gian mỗi nước (giây); hết giờ = thua ván */
  turnSeconds: number;
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

export interface CaroMatch {
  state: CaroGameState;
  /** Ghế cầm quân X (đi trước) — đổi luân phiên mỗi ván */
  xSeat: number;
  /** userId theo ghế */
  players: [string, string];
  names: [string, string];
  deadline: number;
  /** Tạm dừng đồng hồ khi người đến lượt mất kết nối */
  pausedAt: number | null;
  /** Ghế thắng (null = hoà / chưa xong) */
  winnerSeat: number | null;
  endReason: string | null;
  startedAt: number;
  endedAt: number | null;
  seq: number;
  /** Đã gửi ván này cho sách khai cuộc học chưa */
  learned?: boolean;
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: CaroRoomSettings;
  players: RoomPlayer[];
  chat: RoomChatMessage[];
  match: CaroMatch | null;
  /** Tỉ số qua các ván trong phòng (theo ghế) */
  score: [number, number];
  /** Số ván đã chơi (để đổi người đi trước) */
  games: number;
  createdAt: number;
}

export interface PublicRoom {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: CaroRoomSettings;
  players: Omit<RoomPlayer, 'socketId'>[];
  createdAt: number;
}

/** Trạng thái ván gửi cho client */
export interface CaroSnapshot {
  seq: number;
  rule: CaroRule;
  size: number;
  board: number[];
  moves: [number, number][];
  turn: Stone;
  xSeat: number;
  players: [string, string];
  names: [string, string];
  deadline: number;
  pausedAt: number | null;
  serverNow: number;
  winnerSeat: number | null;
  winLine: [number, number][] | null;
  draw: boolean;
  endReason: string | null;
  score: [number, number];
  turnSeconds: number;
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}
