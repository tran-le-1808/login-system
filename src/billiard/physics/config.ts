/**
 * Thông số vật lý bida carom (đơn vị SI: m, kg, s, rad).
 * Mọi giá trị là tham số có thể hiệu chỉnh — không phải hằng số tuyệt đối của mọi loại bàn.
 *
 * ⚠️ Thư mục physics/ được sao chép sang frontend (chat-zone/app/games/billiard/_lib/physics/)
 *    để vẽ đường ngắm. Server vẫn là nơi quyết định kết quả cú đánh.
 */
export interface PhysicsConfig {
  /** Kích thước mặt chơi (mép trong băng) */
  tableWidth: number;
  tableHeight: number;
  ballRadius: number;
  ballMass: number;
  gravity: number;

  /** Ma sát trượt bi - vải */
  clothSlidingFriction: number;
  /** Lực cản lăn (hệ số, lực = μ·m·g) */
  clothRollingFriction: number;
  /** Ma sát xoáy quanh trục đứng (side spin suy giảm) */
  clothSpinFriction: number;

  /** Va chạm bi - bi */
  ballRestitution: number;
  ballFriction: number;

  /** Va chạm bi - băng */
  cushionRestitution: number;
  cushionFriction: number;
  /** Độ cao mũi băng tính từ mặt vải (cao hơn tâm bi) */
  cushionHeight: number;

  /** Vận tốc bi cái khi đánh GIỮA TÂM, cơ nằm ngang, ở lực tối thiểu / tối đa */
  minCueSpeed: number;
  maxCueSpeed: number;
  /** Bán kính tối đa của điểm chạm đầu cơ (tỉ lệ bán kính bi) — chống cú đánh phi vật lý */
  maxTipOffset: number;
  /** Bán kính đầu cơ / thân cơ (đoạn gần đầu) — dùng kiểm tra va chạm cơ với bàn, băng, bi */
  cueTipRadius: number;
  cueShaftRadius: number;
  /** Chiều dài cây cơ (chỉ phần cơ có thật mới có thể vướng băng / bi) */
  cueLength: number;
  /** Chiều cao mặt trên thành băng (cơ không được xuyên qua) */
  railTopHeight: number;
  /** Ma sát bi - vải trong lúc bi bị kẹp giữa đầu cơ và mặt bàn (cú đánh chúi cơ) */
  strikeTableFriction: number;
  /** Góc nâng cơ tối đa (độ) */
  maxElevation: number;
  /** Khối lượng hiệu dụng của cơ & hệ số đàn hồi đầu cơ (va chạm cơ - bi) */
  cueMass: number;
  cueTipRestitution: number;

  /** Bước thời gian cố định & số substep mỗi bước */
  tickRate: number;
  substeps: number;
  /** Số vòng xử lý va chạm tối đa mỗi substep */
  collisionIterations: number;
  maxSimTime: number;
  /** Ngưỡng dừng */
  stopSpeed: number;
  stopSpin: number;
  /** Tần số ghi khung hình gửi cho client */
  frameRate: number;
}

export const DEFAULT_PHYSICS: PhysicsConfig = {
  tableWidth: 2.84,
  tableHeight: 1.42,
  ballRadius: 0.03075,
  ballMass: 0.21,
  gravity: 9.81,

  clothSlidingFriction: 0.2,
  clothRollingFriction: 0.012,
  clothSpinFriction: 0.012,

  ballRestitution: 0.94,
  ballFriction: 0.06,

  cushionRestitution: 0.8,
  cushionFriction: 0.16,
  cushionHeight: 0.037,

  minCueSpeed: 0.25,
  maxCueSpeed: 6.3,
  maxTipOffset: 0.55,
  cueTipRadius: 0.0065,
  cueShaftRadius: 0.0075,
  cueLength: 1.47,
  railTopHeight: 0.049,
  strikeTableFriction: 0.3,
  maxElevation: 90,
  cueMass: 0.54,
  cueTipRestitution: 0.75,

  tickRate: 240,
  substeps: 4,
  collisionIterations: 4,
  maxSimTime: 40,
  stopSpeed: 0.004,
  stopSpin: 0.25,
  frameRate: 30,
};

/** Moment quán tính hình cầu đặc */
export const inertia = (c: PhysicsConfig) =>
  0.4 * c.ballMass * c.ballRadius * c.ballRadius;
