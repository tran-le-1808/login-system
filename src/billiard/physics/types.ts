/** Kiểu dữ liệu dùng chung của physics engine (không phụ thuộc render / mạng). */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 0 = bi trắng, 1 = bi vàng, 2 = bi đỏ */
export type BallId = 0 | 1 | 2;
export const BALL_IDS: readonly BallId[] = [0, 1, 2];

export type MotionState = 'stationary' | 'sliding' | 'rolling' | 'spinning';

/**
 * Trạng thái 1 viên bi. Tâm bi luôn cách mặt vải đúng 1 bán kính (z = R),
 * nên vị trí / vận tốc tuyến tính nằm trong mặt phẳng bàn; vận tốc góc là vector 3D.
 * Hệ toạ độ: x theo chiều dài bàn, y theo chiều rộng, z hướng lên.
 */
export interface BallState {
  id: BallId;
  p: Vec2;
  v: Vec2;
  w: Vec3;
  state: MotionState;
}

/** 4 băng: trái (-x), phải (+x), dưới (-y), trên (+y) */
export type Rail = 'left' | 'right' | 'bottom' | 'top';

/** Vị trí 3 bi (gọn để gửi qua mạng) */
export type BallPositions = [number, number][];

/** Lệnh đánh — UI chỉ tạo cấu trúc này, physics không phụ thuộc giao diện */
export interface ShotCommand {
  /** Bi cái của người đánh */
  cue: BallId;
  /** Hướng cơ trong mặt phẳng bàn (không cần chuẩn hoá) */
  dirX: number;
  dirY: number;
  /** Lực 0..1 */
  power: number;
  /** Điểm chạm đầu cơ trên bi: -1..1 (trái / phải), -1..1 (dưới / trên) — trong khung toạ độ của cơ */
  tipX: number;
  tipY: number;
  /** Góc nâng cơ so với mặt bàn (độ): 0 = cơ nằm ngang, 90 = cơ dựng đứng */
  elevation: number;
}

export type PhysicsEvent =
  | { t: number; type: 'ball'; a: BallId; b: BallId; speed: number }
  | { t: number; type: 'cushion'; ball: BallId; rail: Rail; speed: number }
  | { t: number; type: 'cue'; ball: BallId; speed: number };

/** 1 khung hình quỹ đạo: [x, y, wx, wy, wz] cho từng bi */
export interface TrajectoryFrame {
  t: number;
  balls: [number, number, number, number, number][];
}

export interface SimulationResult {
  final: BallPositions;
  events: PhysicsEvent[];
  frames: TrajectoryFrame[];
  duration: number;
  /** Thống kê kiểm tra độ ổn định */
  stats: {
    steps: number;
    maxCollisionIterations: number;
    initialEnergy: number;
    finalEnergy: number;
  };
}
