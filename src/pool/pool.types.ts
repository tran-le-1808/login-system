import type { BallSpot, SimEvent } from './shared/physics/types';
import type { PocketPreset } from './shared/physics/config';
import type { MatchState } from './shared/rules/engine';
import type {
  CallShot,
  DecisionChoice,
  GameType,
  RuleMessage,
} from './shared/rules/types';

export const POOL_MAX_PLAYERS = 2;
export const POOL_RACE_OPTIONS = [1, 3, 5, 7, 9];

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface PoolRoomSettings {
  isPrivate: boolean;
  type: GameType;
  raceTo: number;
  breakRule: 'alternate' | 'winner';
  pocketPreset: PocketPreset;
  /** Bật đồng hồ đánh (30 s / 60 s) */
  shotClock: boolean;
  /** Cho phép đường dự đoán quỹ đạo đầy đủ (xếp hạng: luôn tắt) */
  allowFullGuide: boolean;
  autoCall: boolean;
  /** Phòng xếp hạng (ghép trận nhanh): khoá preset WPA, tính ELO */
  ranked: boolean;
  /** Cho phép khán giả */
  spectators: boolean;
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
  elo?: number;
}

export interface Spectator {
  userId: string;
  name: string;
  socketId: string | null;
}

export interface RoomChatMessage {
  id: string;
  userId: string;
  name: string;
  avatar?: string;
  seat: number;
  text: string;
  createdAt: number;
  messageType?: 'player' | 'system';
}

/** 1 cú đánh đã xử lý (SHOT_RESULT) — đủ để client tái dựng quỹ đạo chính xác */
export interface ShotRecord {
  seq: number;
  shotId: string;
  by: number;
  input: {
    aimAngle: number;
    power: number;
    tipX: number;
    tipY: number;
    elevation: number;
    call: CallShot | null;
    safety: boolean;
    pushOut: boolean;
  };
  start: BallSpot[];
  /** Keyframes: sự kiện va chạm / rơi lỗ có thời điểm & vị trí */
  events: SimEvent[];
  final: BallSpot[];
  pocketed: { ball: number; pocket: number }[];
  hash: string;
  foul: string | null;
  messages: RuleMessage[];
  duration: number;
  at: number;
}

export type ReplayAction =
  | { kind: 'shot'; seq: number; by: number; input: ShotRecord['input'] }
  | { kind: 'place'; seq: number; by: number; x: number; y: number }
  | { kind: 'option'; seq: number; by: number; choice: DecisionChoice }
  | { kind: 'timeout'; seq: number; by: number }
  | { kind: 'resign'; seq: number; by: number };

export interface PlayerStats {
  shots: number;
  pots: number;
  fouls: number;
  breakAndRuns: number;
}

export interface ClockState {
  /** Hạn chót của cú hiện tại (ms, giờ server); 0 = tắt đồng hồ */
  deadline: number;
  /** Đang tạm dừng vì người tới lượt mất kết nối */
  pausedAt: number | null;
  /** Số lần gia hạn còn lại trong ván */
  extensions: [number, number];
}

/** Trạng thái trận (server là nguồn chân lý duy nhất) */
export interface PoolGame {
  seq: number;
  match: MatchState;
  /** userId theo ghế */
  players: [string, string];
  names: [string, string];
  clock: ClockState;
  busyUntil: number;
  lastShot: ShotRecord | null;
  rackOver: { winner: number; reason: string; rackNo: number } | null;
  stats: [PlayerStats, PlayerStats];
  /** Nhật ký input để xem lại & xử lý khiếu nại (seed + danh sách thao tác) */
  replay: {
    rackNo: number;
    seed: number;
    breaker: number;
    actions: ReplayAction[];
  }[];
  /** Người đánh trong ván hiện tại (để tính break-and-run) */
  rackShooters: number[];
  /** Thông báo của trọng tài khi hết giờ / khi chọn theo luật */
  timeoutMessages?: RuleMessage[];
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  eloChange?: [number, number];
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: PoolRoomSettings;
  players: RoomPlayer[];
  spectators: Spectator[];
  game: PoolGame | null;
  chat: RoomChatMessage[];
  voice: Record<string, { muted: boolean }>;
  processedShots: Set<string>;
  createdAt: number;
}

export interface PublicRoom {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: PoolRoomSettings;
  players: Omit<RoomPlayer, 'socketId'>[];
  spectators: number;
  createdAt: number;
}

/** ROOM_STATE gửi client */
export interface PoolSnapshot {
  v: number;
  seq: number;
  match: MatchState;
  players: [string, string];
  names: [string, string];
  clock: ClockState & { serverNow: number };
  busyUntil: number;
  lastShot: ShotRecord | null;
  rackOver: PoolGame['rackOver'];
  stats: PoolGame['stats'];
  settings: PoolRoomSettings;
  endReason?: string;
  eloChange?: [number, number];
}

export interface AckResponse<T = undefined> {
  ok: boolean;
  error?: string;
  code?: string;
  data?: T;
}
