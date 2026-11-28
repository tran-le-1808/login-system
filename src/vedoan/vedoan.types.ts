import type { DrawOp } from './shared/draw';

export const VD_MAX_PLAYERS = 10;
export const ROUND_OPTIONS = [2, 3, 4, 5];
export const DRAW_OPTIONS = [60, 80, 100, 120];
export const CHOOSE_SECONDS = 15;
export const REVEAL_SECONDS = 6;
/** Giới hạn số nét mỗi lượt (chống tràn bộ nhớ) */
export const MAX_OPS = 6000;

export type RoomStatus = 'lobby' | 'playing' | 'finished';
export type ChatKind = 'chat' | 'correct' | 'close' | 'guessed' | 'system';

export interface VDRoomSettings {
  isPrivate: boolean;
  quick: boolean;
  rounds: number;
  drawSeconds: number;
  /** Lộ dần chữ cái khi còn ít thời gian */
  hints: boolean;
  customWords: string[];
  onlyCustom: boolean;
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
  kind: ChatKind;
}

export interface VDTurn {
  id: number;
  drawer: string;
  choices: string[];
  word: string | null;
  phase: 'choose' | 'draw' | 'reveal';
  deadline: number;
  drawStart: number;
  revealed: number[];
  /** Người đoán đúng theo thứ tự */
  guessed: string[];
  /** Điểm cộng trong lượt */
  gains: Record<string, number>;
  ops: DrawOp[];
}

export interface VDMatch {
  round: number;
  order: string[];
  idx: number;
  turn: VDTurn;
  used: string[];
  scores: Record<string, number>;
  names: Record<string, string>;
  turnSeq: number;
  over: boolean;
  startedAt: number;
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: VDRoomSettings;
  players: RoomPlayer[];
  chat: RoomChatMessage[];
  match: VDMatch | null;
  voice: Record<string, { muted: boolean }>;
  games: number;
  createdAt: number;
}

export interface PublicRoom {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: Omit<VDRoomSettings, 'customWords'> & { customCount: number };
  players: Omit<RoomPlayer, 'socketId'>[];
  createdAt: number;
}

export interface VDSnapshotPlayer {
  userId: string;
  name: string;
  score: number;
  gain: number;
  connected: boolean;
  guessed: boolean;
}

export interface VDSnapshot {
  games: number;
  round: number;
  rounds: number;
  phase: 'choose' | 'draw' | 'reveal' | 'over';
  turnId: number;
  drawer: string;
  isDrawer: boolean;
  choices: string[];
  /** Đáp án (người vẽ, người đã đoán đúng, lúc công bố) */
  word: string | null;
  mask: string;
  deadline: number;
  serverNow: number;
  drawSeconds: number;
  players: VDSnapshotPlayer[];
  /** Thứ tự vẽ còn lại trong vòng */
  upcoming: string[];
  startedAt: number;
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}
