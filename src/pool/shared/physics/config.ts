// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
/**
 * Thông số vật lý bida lỗ (pool) — đơn vị SI (m, kg, s, rad).
 * Mọi hệ số đều chỉnh được; giá trị mặc định theo bàn 9 feet chuẩn WPA.
 */
export interface PoolConfig {
  /** Mặt chơi (tính tới mũi băng) */
  tableLength: number;
  tableWidth: number;
  ballRadius: number;
  ballMass: number;
  gravity: number;

  /** Ma sát trượt bi – nỉ (μs) */
  muSlide: number;
  /** Hệ số cản lăn (μr) */
  muRoll: number;
  /** Ma sát xoáy quanh trục đứng (μsp) — gia tốc góc = 5·μsp·g / (2R) */
  muSpin: number;

  /** Va chạm bi – bi */
  ballRestitution: number;
  ballFriction: number;

  /** Va chạm bi – băng: e(v) = clamp(e0 − k·(v − 1), eMin, eMax) */
  cushionRestitution: number;
  cushionRestitutionSlope: number;
  cushionRestitutionMin: number;
  cushionRestitutionMax: number;
  cushionFriction: number;
  /** Phục hồi tiếp tuyến của băng (0 = ma sát thuần, >0 = cao su đàn hồi đảo ngược xoáy một phần) */
  cushionTangentialRestitution: number;
  /** Độ cao mũi băng tính từ mặt bàn (≈ 0.635 · 2R) */
  cushionHeight: number;

  /** Đầu cơ */
  cueTipRestitution: number;
  /** Khối lượng hiệu dụng của cây cơ khi truyền xung lực (kg) */
  cueMass: number;
  /** Tỉ lệ khối lượng đầu cơ (end mass) / bi — quyết định độ lệch squirt */
  cueEndMassRatio: number;
  /** Vận tốc bi cái khi đánh giữa tâm ở lực 0% / 100% (m/s) */
  minCueSpeed: number;
  maxCueSpeed: number;
  /** Điểm chạm tối đa trên widget (tỉ lệ R) và ngưỡng trượt cơ (tỉ lệ R) */
  maxTipOffset: number;
  miscueOffset: number;
  /** Ma sát bi – nỉ khi bi bị kẹp giữa đầu cơ và mặt bàn (đánh chúi cơ) */
  strikeTableFriction: number;
  maxElevation: number;
  /**
   * Hệ số bật của mặt bàn khi đầu cơ ép bi xuống (đánh chúi): vận tốc đứng sau cú đánh
   * = cueBounce · (thành phần đứng hướng xuống). Dưới jumpMinVz thì bi vẫn nằm trên bàn.
   */
  cueBounce: number;
  jumpMinVz: number;
  /**
   * SWERVE (bi chạy cong do đánh lệch ngang khi nâng cơ) chỉ có từ masseStartDeg, tăng mượt tới masseFullDeg
   * (massé thật sự). Cú đánh thường / cơ chỉ nâng nhẹ để vượt băng thì bi đi THẲNG theo hướng ngắm:
   * quỹ đạo không phụ thuộc lực kéo.
   */
  masseStartDeg: number;
  masseFullDeg: number;
  /** Phục hồi khi bi đáp xuống nỉ; dưới landSettleVz thì dính hẳn xuống mặt bàn */
  clothRestitution: number;
  landSettleVz: number;
  /** Hình học cây cơ — kiểm tra cơ không xuyên bàn / băng / bi khi đánh chúi */
  cueTipRadius: number;
  cueShaftRadius: number;
  cueLength: number;
  railTopHeight: number;

  /** Lỗ — độ rộng miệng đo giữa 2 điểm mũi lỗ (jaw point) trên đường mũi băng */
  pocketPreset: PocketPreset;
  cornerMouth: number;
  sideMouth: number;
  /** Góc giữa mũi băng và mặt hàm lỗ (độ) */
  cornerJawAngle: number;
  sideJawAngle: number;
  cornerJawLength: number;
  sideJawLength: number;
  /** Bán kính hố rơi & thềm (shelf: từ đường mũi băng tới mép hố) */
  cornerHoleRadius: number;
  cornerShelf: number;
  sideHoleRadius: number;
  sideShelf: number;
  /** Bán kính bo tròn tại điểm mũi lỗ (va chạm như hình trụ đứng) */
  noseRadius: number;
  /** Hệ số phục hồi của mặt vát / mũi lỗ (thấp hơn băng) & thành sau lỗ (bọc da) */
  jawRestitution: number;
  backRestitution: number;
  /** Bi đang rơi: tụt quá độ sâu này (tỉ lệ R) thì không thể bật ra nữa */
  dropEscapeDepth: number;

  /** Bước thời gian cố định (s) — ≤ 1 ms */
  dt: number;
  maxSimTime: number;
  /** Số khung ghi lại mỗi giây để phát lại */
  frameRate: number;
  /** Số vòng xử lý va chạm tối đa trong 1 bước */
  maxCollisionPasses: number;
}

export const POOL_PHYSICS: PoolConfig = {
  tableLength: 2.54,
  tableWidth: 1.27,
  ballRadius: 0.028575,
  ballMass: 0.17,
  gravity: 9.81,

  muSlide: 0.2,
  muRoll: 0.01,
  muSpin: 0.044,

  ballRestitution: 0.95,
  ballFriction: 0.06,

  // Hiệu chỉnh theo dữ liệu thật (test calibration.test.ts): lag ~1.5 m/s, 3 m/s lăn ~4 chiều bàn,
  // bi lăn vào băng 45° bật ra ngắn hơn 45° một chút
  cushionRestitution: 0.86,
  cushionRestitutionSlope: 0.025,
  cushionRestitutionMin: 0.62,
  cushionRestitutionMax: 0.9,
  cushionFriction: 0.26,
  cushionTangentialRestitution: 0.6,
  cushionHeight: 0.0363,

  cueTipRestitution: 0.75,
  cueMass: 0.54,
  cueEndMassRatio: 0.1,
  minCueSpeed: 0.5,
  maxCueSpeed: 12,
  maxTipOffset: 0.6,
  miscueOffset: 0.5,
  strikeTableFriction: 0.3,
  maxElevation: 80,
  cueBounce: 0.35,
  jumpMinVz: 0.25,
  masseStartDeg: 8,
  masseFullDeg: 15,
  clothRestitution: 0.5,
  landSettleVz: 0.2,
  cueTipRadius: 0.0065,
  cueShaftRadius: 0.0075,
  cueLength: 1.47,
  railTopHeight: 0.049,

  pocketPreset: 'wpa',
  cornerMouth: 0.1143,
  sideMouth: 0.127,
  cornerJawAngle: 142,
  sideJawAngle: 104,
  cornerJawLength: 0.05,
  sideJawLength: 0.04,
  // Hố Ø12.7 / 13.0 cm ≈ 2.2–2.3 × đường kính bi; thềm góc 3.5 cm (WPA 2.54–5.72), giữa 0.8 cm (WPA 0–0.95)
  cornerHoleRadius: 0.0635,
  cornerShelf: 0.035,
  sideHoleRadius: 0.065,
  sideShelf: 0.008,
  noseRadius: 0.008,
  jawRestitution: 0.7,
  backRestitution: 0.45,
  dropEscapeDepth: 0.35,

  dt: 1 / 2000,
  maxSimTime: 40,
  frameRate: 120,
  maxCollisionPasses: 96,
};

/** Mô-men quán tính quả cầu đặc I = 2/5·m·R² */
export const inertia = (c: PoolConfig) =>
  0.4 * c.ballMass * c.ballRadius * c.ballRadius;

/**
 * Lực 0..1 -> vận tốc bi cái khi đánh giữa tâm. Đường cong p^1.5 = p·√p (chỉ dùng phép tính
 * xác định) để chỉnh lực nhẹ chính xác hơn.
 */
export const powerToSpeed = (power: number, c: PoolConfig) => {
  const p = Math.max(0, Math.min(1, power));
  return c.minCueSpeed + (c.maxCueSpeed - c.minCueSpeed) * p * Math.sqrt(p);
};

/** Ngược lại: vận tốc -> lực */
export const speedToPower = (speed: number, c: PoolConfig) => {
  const k = Math.max(
    0,
    Math.min(1, (speed - c.minCueSpeed) / (c.maxCueSpeed - c.minCueSpeed)),
  );
  return Math.cbrt(k * k);
};

// ===================== PRESET ĐỘ KHÓ LỖ =====================

export type PocketPreset = 'easy' | 'wpa' | 'pro';

export const POCKET_PRESETS: Record<
  PocketPreset,
  { label: string; corner: number; side: number; note: string }
> = {
  easy: {
    label: 'Dễ (giải trí)',
    corner: 0.121,
    side: 0.133,
    note: 'Rộng hơn chuẩn — không chuẩn WPA',
  },
  wpa: {
    label: 'WPA Thi đấu',
    corner: 0.1143,
    side: 0.127,
    note: 'Chuẩn WPA (mức chặt nhất được phép)',
  },
  pro: {
    label: 'Pro / lỗ chặt',
    corner: 0.108,
    side: 0.124,
    note: 'Chặt hơn chuẩn WPA',
  },
};

export function configForPreset(
  preset: PocketPreset,
  base: PoolConfig = POOL_PHYSICS,
): PoolConfig {
  const p = POCKET_PRESETS[preset] ?? POCKET_PRESETS.wpa;
  return {
    ...base,
    pocketPreset: preset,
    cornerMouth: p.corner,
    sideMouth: p.side,
  };
}
