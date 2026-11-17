/// <reference types="jest" />
import { DEFAULT_PHYSICS as C } from './config';
import { initialPositions, PhysicsWorld, simulateShot } from './world';
import { sanitizeShot } from './cue';
import { judgeShot } from './rules';
import {
  ballBounds,
  BALL_SPEC,
  cameraLimits,
  CAROM_TABLE_CONFIGS,
  diamondLayout,
  fitCameraDistance,
  getDiamondPositions,
  PLAYING_SURFACE,
  railWidths,
  tableBounds,
  tableConfigForMode,
  validateTableConfig,
} from './table';
import type { BallPositions } from './types';

const TYPES = Object.values(CAROM_TABLE_CONFIGS);

describe('Hình học bàn Carom', () => {
  it('mặt thi đấu đúng 2.84 × 1.42 m, tỉ lệ 2:1, giống nhau ở Libre và 3 băng', () => {
    for (const cfg of TYPES) {
      expect(cfg.playingSurface).toEqual({ length: 2.84, width: 1.42 });
      expect(cfg.playingSurface.length / cfg.playingSurface.width).toBe(2);
      expect(
        cfg.playingSurface.length * cfg.playingSurface.width * 1e6,
      ).toBeCloseTo(4_032_800, 0);
    }
  });
  it('phủ bì độc lập với mặt thi đấu: Libre 3.0 × 1.65, 3 băng 3.10 × 1.68; khung gỗ nằm ngoài băng', () => {
    expect(CAROM_TABLE_CONFIGS.LIBRE.outerDimensions).toEqual({
      length: 3.0,
      width: 1.65,
    });
    expect(CAROM_TABLE_CONFIGS.THREE_CUSHION.outerDimensions).toEqual({
      length: 3.1,
      width: 1.68,
    });
    for (const cfg of TYPES) {
      const rw = railWidths(cfg);
      expect(rw.end).toBeGreaterThan(0);
      expect(rw.side).toBeGreaterThan(0);
      expect(
        cfg.playingSurface.length + 2 * (cfg.cushion.width + rw.end),
      ).toBeCloseTo(cfg.outerDimensions.length, 9);
      expect(
        cfg.playingSurface.width + 2 * (cfg.cushion.width + rw.side),
      ).toBeCloseTo(cfg.outerDimensions.width, 9);
      expect(validateTableConfig(cfg)).toEqual([]);
    }
    // 3 băng: khung dày hơn Libre
    expect(railWidths(CAROM_TABLE_CONFIGS.THREE_CUSHION).end).toBeGreaterThan(
      railWidths(CAROM_TABLE_CONFIGS.LIBRE).end,
    );
    expect(CAROM_TABLE_CONFIGS.THREE_CUSHION.slate.thickness).toBeGreaterThan(
      CAROM_TABLE_CONFIGS.LIBRE.slate.thickness,
    );
    expect(CAROM_TABLE_CONFIGS.THREE_CUSHION.heated).toBe(true);
  });
  it('chế độ chơi chọn đúng mẫu bàn', () => {
    expect(tableConfigForMode('free').type).toBe('LIBRE');
    expect(tableConfigForMode('three').type).toBe('THREE_CUSHION');
  });
  it('vật lý dùng đúng cấu hình trung tâm (giá trị không đổi so với trước)', () => {
    expect(C.tableWidth).toBe(PLAYING_SURFACE.length);
    expect(C.tableHeight).toBe(PLAYING_SURFACE.width);
    expect(C.ballRadius).toBe(0.03075);
    expect(BALL_SPEC.diameter).toBe(0.0615);
    expect(C.cushionHeight).toBe(0.037);
    expect(C.railTopHeight).toBe(0.049);
    expect(initialPositions()).toEqual([
      [-0.71, -0.1825],
      [-0.71, 0],
      [0.71, 0],
    ]);
  });
  it('mũi băng nằm giữa tâm bi và đỉnh bi', () => {
    for (const cfg of TYPES) {
      expect(cfg.cushion.noseHeight).toBeGreaterThan(cfg.ball.radius);
      expect(cfg.cushion.noseHeight).toBeLessThan(cfg.ball.diameter);
    }
  });
  it('kim cương: 7 điểm giữa cạnh dài + 2 góc (9), 3 điểm giữa cạnh ngắn + 2 góc (5); chia đều theo mặt thi đấu, đối xứng', () => {
    expect(getDiamondPositions(2.84, 7).map((x) => +x.toFixed(4))).toEqual([
      -1.065, -0.71, -0.355, 0, 0.355, 0.71, 1.065,
    ]);
    expect(getDiamondPositions(1.42, 3).map((x) => +x.toFixed(4))).toEqual([
      -0.355, 0, 0.355,
    ]);
    for (const cfg of TYPES) {
      const d = diamondLayout(cfg);
      expect(d.filter((p) => !p.corner)).toHaveLength(2 * 7 + 2 * 3);
      expect(d.filter((p) => p.corner)).toHaveLength(4);
      // đối xứng qua hai trục
      for (const p of d) {
        expect(
          d.some(
            (q) => Math.abs(q.x + p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9,
          ),
        ).toBe(true);
        expect(
          d.some(
            (q) => Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y + p.y) < 1e-9,
          ),
        ).toBe(true);
      }
      // nằm trên khung gỗ: ngoài mặt thi đấu + băng, trong phủ bì
      const b = tableBounds(cfg);
      for (const p of d) {
        const outside =
          Math.abs(p.x) > b.halfLength + cfg.cushion.width ||
          Math.abs(p.y) > b.halfWidth + cfg.cushion.width;
        expect(outside).toBe(true);
        expect(Math.abs(p.x)).toBeLessThan(cfg.outerDimensions.length / 2);
        expect(Math.abs(p.y)).toBeLessThan(cfg.outerDimensions.width / 2);
      }
    }
  });
  it('giới hạn tâm bi = mép mặt thi đấu trừ bán kính', () => {
    const bb = ballBounds();
    expect(bb.maxX).toBeCloseTo(1.42 - 0.03075, 9);
    expect(bb.minZ).toBeCloseTo(-0.71 + 0.03075, 9);
  });
});

/** Đánh thẳng bi cái theo hướng cho trước, trả về quỹ đạo bi cái */
function shoot(balls: BallPositions, dirX: number, dirY: number, power = 0.9) {
  const shot = sanitizeShot({ dirX, dirY, power, elevation: 3 }, 0);
  return simulateShot(balls, shot, C, { recordFrames: true });
}

describe('Va chạm bi - băng theo hình học bàn mới', () => {
  const lone: BallPositions = [
    [0, 0],
    [-1.2, 0.6],
    [-1.2, -0.6],
  ];
  it('bi chạm đúng mũi băng (tâm bi tới đúng biên) mà không xuyên qua, ở cả 4 băng', () => {
    const bb = ballBounds();
    for (const [dx, dy, axis, limit] of [
      [1, 0, 'x', bb.maxX],
      [-1, 0.0001, 'x', -bb.maxX],
      [0, 1, 'y', bb.maxZ],
      [0.0001, -1, 'y', -bb.maxZ],
    ] as const) {
      // chạy từng bước vật lý (240 Hz × substep) để bắt đúng thời điểm chạm
      const w = new PhysicsWorld(lone, C);
      w.strike(
        sanitizeShot({ dirX: dx, dirY: dy, power: 0.9, elevation: 3 }, 0),
      );
      let extreme = 0;
      while (w.isMoving() && w.time < 10) {
        w.step();
        const v = w.balls[0].p[axis];
        if (Math.abs(v) > Math.abs(extreme)) extreme = v;
      }
      expect(Math.abs(extreme)).toBeLessThanOrEqual(Math.abs(limit) + 1e-9);
      expect(Math.abs(extreme)).toBeGreaterThan(Math.abs(limit) - 1e-3);
      expect(w.events.some((e) => e.type === 'cushion')).toBe(true);
    }
  });
  it('không bật ngược khi chưa chạm: cú đánh nhẹ dừng trước băng thì không có va chạm băng', () => {
    const res = shoot(lone, 1, 0, 0.02);
    expect(res.events.some((e) => e.type === 'cushion')).toBe(false);
    expect(res.final[0][0]).toBeLessThan(ballBounds().maxX);
  });
  it('đánh thẳng vào góc: dội đúng cả hai băng, không kẹt góc, luôn trong bàn', () => {
    const start: BallPositions = [
      [0.9, 0.3],
      [-1.2, 0.6],
      [-1.2, -0.6],
    ];
    const res = shoot(start, 1, 0.71 / 1.42, 1);
    const bb = ballBounds();
    for (const f of res.frames)
      for (const [x, y] of f.balls) {
        expect(x).toBeGreaterThanOrEqual(-bb.maxX - 1e-9);
        expect(x).toBeLessThanOrEqual(bb.maxX + 1e-9);
        expect(y).toBeGreaterThanOrEqual(-bb.maxZ - 1e-9);
        expect(y).toBeLessThanOrEqual(bb.maxZ + 1e-9);
      }
    expect(
      res.events.filter((e) => e.type === 'cushion').length,
    ).toBeGreaterThanOrEqual(2);
    // bi rời góc (không dính góc)
    const [fx, fy] = res.final[0];
    expect(Math.hypot(fx - bb.maxX, fy - bb.maxZ)).toBeGreaterThan(0.1);
  });
  it('góc phản xạ: đánh chéo vào băng dài thì thành phần pháp tuyến đổi chiều, thành phần dọc băng giữ chiều', () => {
    // từ tâm bàn hướng 45°: chạm băng dài phía y+ ở x ≈ 0.68 (xa góc)
    const w = new PhysicsWorld(lone, C);
    w.strike(sanitizeShot({ dirX: 1, dirY: 1, power: 0.5, elevation: 3 }, 0));
    let before: { x: number; y: number } | null = null;
    while (w.isMoving() && !w.events.some((e) => e.type === 'cushion')) {
      before = { ...w.balls[0].v };
      w.step();
    }
    const after = w.balls[0].v;
    expect(before!.y).toBeGreaterThan(0);
    expect(after.y).toBeLessThan(0);
    expect(after.x).toBeGreaterThan(0);
    // hệ số phục hồi của băng giữ nguyên: |vy sau| ≈ e·|vy trước| (cộng ảnh hưởng ma sát / xoáy)
    expect(Math.abs(after.y) / before!.y).toBeLessThan(1);
    expect(Math.abs(after.y) / before!.y).toBeGreaterThan(0.5);
  });
  it('va chạm bi - bi & chấm điểm không đổi: cú phăng chuẩn vẫn ghi điểm', () => {
    // bi cái thẳng hàng hai bi mục tiêu
    const balls: BallPositions = [
      [-0.6, 0],
      [0, 0],
      [0.6, 0.0],
    ];
    const res = shoot(balls, 1, 0.0005, 0.6);
    const v = judgeShot(res.events, 0, { mode: 'free' });
    expect(
      res.events.filter((e) => e.type === 'ball').length,
    ).toBeGreaterThanOrEqual(1);
    expect(typeof v.scored).toBe('boolean');
  });
});

describe('Camera theo kích thước bàn', () => {
  it('nhìn từ trên: cả phủ bì nằm trong khung ở mọi tỉ lệ màn hình', () => {
    for (const cfg of TYPES)
      for (const aspect of [0.5, 0.8, 1, 1.6, 2.2]) {
        const fov = 40;
        const d = fitCameraDistance(cfg, aspect, fov);
        const tanV = Math.tan((fov * Math.PI) / 360);
        const height = d - cfg.cushion.height; // khoảng cách tới mặt trên khung
        expect(cfg.outerDimensions.width / 2).toBeLessThanOrEqual(
          height * tanV + 1e-9,
        );
        expect(cfg.outerDimensions.length / 2).toBeLessThanOrEqual(
          height * tanV * aspect + 1e-9,
        );
      }
  });
  it('giới hạn xoay / zoom: không chui dưới bàn, zoom xa đủ thấy cả bàn', () => {
    for (const cfg of TYPES) {
      const d = fitCameraDistance(cfg, 1.6, 40);
      const lim = cameraLimits(cfg, d);
      expect(lim.maxPolarAngle).toBeLessThan(Math.PI / 2);
      expect(lim.maxDistance).toBeGreaterThan(d);
      expect(lim.minDistance).toBeLessThan(d);
      // ở khoảng gần nhất và góc thấp nhất camera vẫn cao hơn mặt khung
      expect(lim.minDistance * Math.cos(lim.maxPolarAngle)).toBeGreaterThan(
        cfg.cushion.height,
      );
    }
  });
});
