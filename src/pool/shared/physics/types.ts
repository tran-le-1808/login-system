// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
/** Kiểu dữ liệu của engine vật lý bida lỗ (không phụ thuộc giao diện / luật). */

export interface Vec2 {
  x: number;
  y: number;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type MotionState =
  | 'stationary'
  | 'sliding'
  | 'rolling'
  | 'spinning'
  /** Tâm bi đã qua mép hố, đang rơi (vẫn có thể đập thành sau lỗ và bật ra) */
  | 'dropping'
  /** Bi rời mặt bàn (jump shot / nảy sau khi đáp): bay theo quỹ đạo ném xiên */
  | 'airborne'
  /** Bi đã văng khỏi bàn (không vào lỗ) */
  | 'offTable'
  | 'pocketed';

/**
 * Hệ toạ độ: gốc ở tâm bàn, x theo chiều dài (đầu bàn / vùng kitchen ở phía −x),
 * y theo chiều rộng, z hướng lên. Tâm bi luôn cao R so với mặt nỉ.
 * Bi số 0 là bi cái.
 */
export interface Ball {
  n: number;
  p: Vec2;
  v: Vec2;
  w: Vec3;
  state: MotionState;
  /** Chỉ số lỗ nếu đã rơi / đang rơi, −1 nếu còn trên bàn */
  pocket: number;
  /** Thời gian đã rơi (s) và độ tụt của tâm bi so với mặt bàn (m) */
  dropTime: number;
  z: number;
  /** Độ cao tâm bi so với lúc nằm trên bàn (m, ≥ 0) và vận tốc đứng (m/s) — chỉ khác 0 khi airborne */
  h: number;
  vz: number;
}

/** Vị trí 1 bi trên bàn (dạng gọn để lưu trạng thái ván) */
export interface BallSpot {
  n: number;
  x: number;
  y: number;
}

/** Lệnh đánh: chỉ chứa dữ liệu, không phụ thuộc UI */
export interface ShotCommand {
  /** Hướng cơ trên mặt bàn (không cần chuẩn hoá) */
  dirX: number;
  dirY: number;
  /** Lực 0..1 */
  power: number;
  /** Điểm chạm đầu cơ: −1..1 (trái/phải), −1..1 (dưới/trên), nhân maxTipOffset·R */
  tipX: number;
  tipY: number;
  /** Góc nâng cơ (độ) */
  elevation: number;
}

export type SimEvent =
  | {
      t: number;
      type: 'cue';
      speed: number;
      miscue: boolean;
      x: number;
      y: number;
    }
  | {
      t: number;
      type: 'ball';
      a: number;
      b: number;
      speed: number;
      x: number;
      y: number;
    }
  /** part: mũi băng / mặt vát lỗ / mũi lỗ bo tròn / thành sau lỗ */
  | {
      t: number;
      type: 'cushion';
      ball: number;
      speed: number;
      part: CushionPart;
      x: number;
      y: number;
    }
  | {
      t: number;
      type: 'pocket';
      ball: number;
      pocket: number;
      speed: number;
      x: number;
      y: number;
    }
  /** Bi rời mặt bàn (jump shot) với vận tốc đứng vz */
  | { t: number; type: 'jump'; ball: number; vz: number; x: number; y: number }
  /** Bi chạm lại mặt bàn với tốc độ đứng speed */
  | {
      t: number;
      type: 'land';
      ball: number;
      speed: number;
      x: number;
      y: number;
    }
  /** Bi bay khỏi bàn: vị trí / vận tốc / độ cao lúc vượt băng (để vẽ bi tiếp tục bay rồi rơi xuống sàn) */
  | {
      t: number;
      type: 'offtable';
      ball: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
      vz: number;
      h: number;
    };

export type CushionPart = 'rail' | 'jaw' | 'nose' | 'back';

/**
 * Nhật ký cú đánh — đầu vào DUY NHẤT của trọng tài (luật không đọc vật lý).
 */
export interface ShotResult {
  /** Bi mục tiêu đầu tiên bi cái chạm (null: không chạm bi nào) */
  firstHit: number | null;
  /** Bi vào lỗ theo thứ tự thời gian */
  pocketed: { ball: number; pocket: number }[];
  /** Các bi (kể cả bi cái) chạm băng SAU va chạm đầu tiên */
  cushionAfterContact: number[];
  /** Các bi mục tiêu khác nhau đã chạm băng trong cả cú đánh (luật phá bi) */
  objectBallsToCushion: number[];
  /** Bi văng khỏi bàn (engine hiện không mô phỏng bi nhảy nên luôn rỗng) */
  offTable: number[];
  scratch: boolean;
  miscue: boolean;
  /** Bi còn trên bàn sau cú đánh */
  final: BallSpot[];
  duration: number;
}

/**
 * Ghi lại cú đánh để phát lại: mỗi khung, mỗi bi 7 số
 * [x, y, ωx, ωy, ωz, trạng thái (0 = trên bàn, lỗ+1 = đã vào lỗ, 100 = văng khỏi bàn), z]
 * với z > 0: độ tụt xuống lỗ, z < 0: độ cao khi bay (bi ở độ cao R − z).
 */
export interface ShotTrace {
  result: ShotResult;
  events: SimEvent[];
  ballIds: number[];
  fps: number;
  frameCount: number;
  frames: Float32Array;
  stats: {
    steps: number;
    maxPasses: number;
    initialEnergy: number;
    finalEnergy: number;
  };
  /** Băm trạng thái cuối (so sánh client / server) */
  hash: string;
}

export const FRAME_STRIDE = 7;
