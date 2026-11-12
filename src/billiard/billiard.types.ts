import type {
  BallPositions,
  CaromMode,
  PhysicsEvent,
  ShotCommand,
  ShotVerdict,
  TrajectoryFrame,
} from './physics';

export const BILLIARD_MAX_PLAYERS = 2;
export const BILLIARD_MIN_PLAYERS = 2;
/** Thời gian mỗi lượt (giây) — hết giờ tự mất lượt */
export const BILLIARD_TURN_SECONDS = 45;

export const ALLOWED_TARGETS: Record<CaromMode, number[]> = {
  free: [10, 15, 20, 30],
  three: [3, 5, 10, 15],
};

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface RoomSettings {
  isPrivate: boolean;
  /** free = Phăng (chạm 2 bi), three = 3 băng */
  mode: CaromMode;
  /** Số điểm để thắng */
  target: number;
  /** Cho phép hiện đường ngắm dự đoán */
  guideline: boolean;
}

export interface RoomPlayer {
  userId: string;
  name: string;
  avatar?: string;
  /** Ghế 0 = bi trắng, 1 = bi vàng */
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
  /** player = người chơi gửi, system = thông báo hệ thống */
  messageType?: 'player' | 'system';
}

/** Sự kiện va chạm gọn (để client phát âm thanh / hiệu ứng) */
export type CompactEvent = Pick<PhysicsEvent, 't' | 'type'> & {
  speed: number;
  ball?: number;
};

export interface ShotRecord {
  seq: number;
  /** ID do client tạo — chống xử lý trùng khi gửi lặp / reconnect */
  shotId: string;
  /** Lượt của ai (chỉ số trong players) */
  by: number;
  shot: ShotCommand;
  start: BallPositions;
  final: BallPositions;
  frames: TrajectoryFrame[];
  events: CompactEvent[];
  verdict: ShotVerdict;
  duration: number;
  at: number;
}

export interface PlayerStats {
  shots: number;
  points: number;
  /** Chuỗi ghi điểm liên tiếp dài nhất */
  bestRun: number;
  currentRun: number;
  /** Số lượt (inning) đã đánh */
  innings: number;
}

/** Trạng thái trận bida (server là nguồn xác thực duy nhất) */
export interface BilliardMatch {
  /** Tăng mỗi khi trạng thái trận đổi (cú đánh / hết giờ / kết thúc) */
  seq: number;
  mode: CaromMode;
  target: number;
  guideline: boolean;
  balls: BallPositions;
  /** userId theo ghế: [bi trắng, bi vàng] */
  players: string[];
  scores: number[];
  stats: PlayerStats[];
  turn: number;
  /** Bi đang lăn tới thời điểm này (ms) — chưa được đánh tiếp */
  busyUntil: number;
  turnDeadline: number;
  lastShot: ShotRecord | null;
  winner: number | null;
  endReason?: string;
  startedAt: number;
  endedAt?: number;
  /** Server time khi gửi (client dùng để đồng bộ đồng hồ lượt) */
  serverNow?: number;
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  settings: RoomSettings;
  players: RoomPlayer[];
  snapshot: BilliardMatch | null;
  chat: RoomChatMessage[];
  /** Voice chat: những người đang bật voice (userId -> đang tắt mic hay không) */
  voice: Record<string, { muted: boolean }>;
  /** shotId đã xử lý (chống trùng) */
  processedShots: Set<string>;
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
