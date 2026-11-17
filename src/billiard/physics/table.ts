/**
 * CẤU HÌNH BÀN BIDA CAROM — nguồn duy nhất cho mọi kích thước bàn (đơn vị mét, 1 đơn vị Three.js = 1 m).
 *
 * Hệ toạ độ: tâm mặt thi đấu là gốc.
 *  - Vật lý (2D): x theo chiều dài, y theo chiều rộng.
 *  - Three.js: X = x (chiều dài), Z = −y (chiều rộng), Y hướng lên; mặt vải ở Y = 0.
 *
 * Mặt thi đấu (2.84 × 1.42 m, tỉ lệ 2:1) giống nhau ở bàn Libre và bàn 3 băng; kích thước phủ bì
 * cấu hình độc lập (không bao giờ dùng phủ bì để tính mặt thi đấu, kim cương hay va chạm).
 *
 * ⚠️ login-system/src/billiard/physics là nguồn chính; chat-zone/app/games/billiard/_lib/physics là bản sao.
 */
import type { CaromMode } from './rules';

export type CaromTableType = 'LIBRE' | 'THREE_CUSHION';

export interface CaromTableConfig {
  type: CaromTableType;
  name: string;
  /** Mặt thi đấu (mép mũi băng tới mép mũi băng) */
  playingSurface: { length: number; width: number };
  /** Phủ bì (cấu hình mẫu theo nhà sản xuất — độc lập với mặt thi đấu) */
  outerDimensions: { length: number; width: number };
  slate: { thickness: number };
  cushion: {
    /** Bề rộng băng cao su (từ mũi băng ra tới khung gỗ) */
    width: number;
    /** Độ cao mặt trên băng (cũng là mặt trên khung gỗ) — cơ không được xuyên qua */
    height: number;
    /** Độ cao mũi băng (điểm tiếp xúc bi) tính từ mặt vải */
    noseHeight: number;
  };
  ball: { diameter: number; radius: number };
  /** Kim cương: số điểm ở giữa mỗi cạnh dài / ngắn (chưa kể điểm góc) */
  diamonds: { long: number; short: number; size: number };
  /** Độ cao mặt vải so với sàn */
  surfaceHeight: number;
  /** Khung gỗ: chiều cao phần yếm (apron) dưới mặt băng, bo góc ngoài */
  frame: {
    apronDepth: number;
    cornerRadius: number;
    legCount: 4 | 6;
    legSize: number;
  };
  heated: boolean;
}

/** Mặt thi đấu tiêu chuẩn quốc tế (Libre & 3 băng) */
export const PLAYING_SURFACE = { length: 2.84, width: 1.42 } as const;
export const TABLE_ASPECT_RATIO = 2;
/** Bi carom 61,5 mm */
export const BALL_SPEC = { diameter: 0.0615, radius: 0.0615 / 2 } as const;
/**
 * Profile băng: mũi 37 mm (cao hơn tâm bi ~6 mm), mặt trên 49 mm, rộng 5 cm.
 * (Bề rộng 8 cm trong tài liệu tham khảo không vừa phủ bì 3.0 m của bàn Libre — chọn 5 cm, đúng cỡ băng cao su thực tế.)
 */
export const CUSHION_SPEC = {
  width: 0.05,
  height: 0.049,
  noseHeight: 0.037,
} as const;

const common = {
  playingSurface: { ...PLAYING_SURFACE },
  cushion: { ...CUSHION_SPEC },
  ball: { ...BALL_SPEC },
  diamonds: { long: 7, short: 3, size: 0.014 },
  surfaceHeight: 0.8,
};

export const CAROM_TABLE_CONFIGS: Record<CaromTableType, CaromTableConfig> = {
  LIBRE: {
    ...common,
    type: 'LIBRE',
    name: 'Bàn Libre',
    outerDimensions: { length: 3.0, width: 1.65 },
    slate: { thickness: 0.03 },
    frame: {
      apronDepth: 0.14,
      cornerRadius: 0.025,
      legCount: 4,
      legSize: 0.12,
    },
    heated: false,
  },
  THREE_CUSHION: {
    ...common,
    type: 'THREE_CUSHION',
    name: 'Bàn 3 băng (sưởi)',
    outerDimensions: { length: 3.1, width: 1.68 },
    slate: { thickness: 0.04 },
    frame: { apronDepth: 0.2, cornerRadius: 0.04, legCount: 6, legSize: 0.16 },
    heated: true,
  },
};

/** Phăng (free) chơi trên bàn Libre, 3 băng chơi trên bàn 3 băng — mặt thi đấu như nhau nên vật lý không đổi */
export function tableTypeForMode(mode: CaromMode): CaromTableType {
  return mode === 'three' ? 'THREE_CUSHION' : 'LIBRE';
}

export function tableConfigForMode(mode: CaromMode): CaromTableConfig {
  return CAROM_TABLE_CONFIGS[tableTypeForMode(mode)];
}

/** Giới hạn mặt thi đấu (mép mũi băng) */
export function tableBounds(cfg: CaromTableConfig = CAROM_TABLE_CONFIGS.LIBRE) {
  const halfLength = cfg.playingSurface.length / 2;
  const halfWidth = cfg.playingSurface.width / 2;
  return {
    length: cfg.playingSurface.length,
    width: cfg.playingSurface.width,
    halfLength,
    halfWidth,
    minX: -halfLength,
    maxX: halfLength,
    minZ: -halfWidth,
    maxZ: halfWidth,
  };
}

/** Giới hạn tâm bi trên mặt bàn (chạm băng thì tâm bi đúng ở biên này) */
export function ballBounds(cfg: CaromTableConfig = CAROM_TABLE_CONFIGS.LIBRE) {
  const b = tableBounds(cfg);
  const r = cfg.ball.radius;
  return {
    minX: b.minX + r,
    maxX: b.maxX - r,
    minZ: b.minZ + r,
    maxZ: b.maxZ - r,
  };
}

/** Bề rộng khung gỗ mỗi phía (ngoài băng) theo phủ bì: đầu bàn (cạnh ngắn) & hai bên (cạnh dài) */
export function railWidths(cfg: CaromTableConfig): {
  end: number;
  side: number;
} {
  return {
    end:
      (cfg.outerDimensions.length - cfg.playingSurface.length) / 2 -
      cfg.cushion.width,
    side:
      (cfg.outerDimensions.width - cfg.playingSurface.width) / 2 -
      cfg.cushion.width,
  };
}

/** Vị trí kim cương dọc một cạnh (chia đều theo mặt thi đấu, không đặt ở góc): công thức −L/2 + L/(n+1)·i */
export function getDiamondPositions(length: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= count; i++)
    out.push(-length / 2 + (length / (count + 1)) * i);
  return out;
}

/**
 * Toàn bộ kim cương trên khung (toạ độ vật lý x, y): điểm giữa mỗi cạnh + điểm góc khung.
 * Đặt giữa bề rộng khung gỗ, theo kích thước mặt thi đấu (không theo phủ bì).
 */
export function diamondLayout(
  cfg: CaromTableConfig,
): { x: number; y: number; corner: boolean }[] {
  const L = cfg.playingSurface.length;
  const W = cfg.playingSurface.width;
  const rw = railWidths(cfg);
  const offLong = W / 2 + cfg.cushion.width + rw.side / 2;
  const offShort = L / 2 + cfg.cushion.width + rw.end / 2;
  const list: { x: number; y: number; corner: boolean }[] = [];
  for (const x of getDiamondPositions(L, cfg.diamonds.long))
    list.push(
      { x, y: offLong, corner: false },
      { x, y: -offLong, corner: false },
    );
  for (const y of getDiamondPositions(W, cfg.diamonds.short))
    list.push(
      { x: offShort, y, corner: false },
      { x: -offShort, y, corner: false },
    );
  for (const sx of [1, -1])
    for (const sy of [1, -1])
      list.push({ x: sx * offShort, y: sy * offLong, corner: true });
  return list;
}

/** Điểm đặt bi chuẩn carom: chấm đầu bàn / chấm cuối bàn (¼ chiều dài), bi cái lệch 182,5 mm trên đường đầu bàn */
export function spotPositions(
  cfg: CaromTableConfig = CAROM_TABLE_CONFIGS.LIBRE,
) {
  const L = cfg.playingSurface.length;
  return {
    head: { x: -L / 4, y: 0 },
    foot: { x: L / 4, y: 0 },
    breakOffset: 0.1825,
  };
}

/**
 * Khoảng cách camera để cả phủ bì nằm trong khung hình (camera phối cảnh nhìn thẳng xuống).
 * aspect = rộng / cao của màn hình; fovDeg = góc nhìn dọc.
 */
export function fitCameraDistance(
  cfg: CaromTableConfig,
  aspect: number,
  fovDeg: number,
  margin = 0.04,
): number {
  const half = (fovDeg * Math.PI) / 360;
  const len = cfg.outerDimensions.length + 2 * margin;
  const wid = cfg.outerDimensions.width + 2 * margin;
  const fitW = wid / 2 / Math.tan(half);
  const fitL = len / 2 / (Math.tan(half) * Math.max(0.1, aspect));
  // camera đứng trên mặt bàn: cộng chiều cao khung để mép khung gần camera cũng nằm trong khung hình
  return Math.max(fitW, fitL) + cfg.cushion.height;
}

/** Giới hạn xoay / zoom camera theo kích thước bàn (không chui xuống dưới bàn, không xuyên khung) */
export function cameraLimits(cfg: CaromTableConfig, fitDistance: number) {
  return {
    minDistance: Math.max(0.45, cfg.playingSurface.width * 0.45),
    maxDistance: fitDistance * 1.8,
    /** Không quá 81° so với phương thẳng đứng: camera luôn ở trên mặt khung */
    maxPolarAngle: Math.PI * 0.45,
  };
}

/** Kiểm tra cấu hình hợp lệ (dùng trong test & khi thêm mẫu bàn mới) */
export function validateTableConfig(cfg: CaromTableConfig): string[] {
  const errs: string[] = [];
  const ps = cfg.playingSurface;
  if (Math.abs(ps.length / ps.width - TABLE_ASPECT_RATIO) > 1e-9)
    errs.push('Mặt thi đấu phải đúng tỉ lệ 2:1');
  const rw = railWidths(cfg);
  if (rw.end <= 0 || rw.side <= 0)
    errs.push('Phủ bì quá nhỏ so với mặt thi đấu + băng');
  if (cfg.cushion.noseHeight <= cfg.ball.radius)
    errs.push('Mũi băng phải cao hơn tâm bi');
  if (cfg.cushion.noseHeight >= cfg.ball.diameter)
    errs.push('Mũi băng không được cao hơn đỉnh bi');
  if (cfg.cushion.height < cfg.cushion.noseHeight)
    errs.push('Mặt trên băng phải cao hơn mũi băng');
  if (cfg.diamonds.size >= Math.min(rw.end, rw.side))
    errs.push('Kim cương lớn hơn bề rộng khung');
  return errs;
}
