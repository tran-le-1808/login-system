/// <reference types="jest" />
import {
  DEFAULT_PHYSICS as C,
  PhysicsWorld,
  checkCueClearance,
  cueContactPoint,
  cueKineticEnergy,
  initialPositions,
  kineticEnergy,
  sanitizeShot,
  simulateShot,
  type BallPositions,
  type ShotCommand,
} from './index';

const R = C.ballRadius;
const ANGLES = [0, 15, 30, 45, 60, 75, 90];

const shot = (p: Partial<ShotCommand>): ShotCommand =>
  sanitizeShot(
    { dirX: 1, dirY: 0, power: 0.12, tipX: 0, tipY: 0, elevation: 0, ...p },
    p.cue ?? 0,
  );

/** Bàn gần như trống: bi cái ở (x, y), 2 bi kia ở góc xa */
const lone = (x: number, y = 0): BallPositions => [
  [x, y],
  [1.3, 0.62],
  [1.3, -0.62],
];

const strike = (s: ShotCommand, pos = lone(-1.2)) => {
  const w = new PhysicsWorld(pos, C);
  w.strike(s);
  return w.balls[s.cue];
};

describe('Góc nâng cơ 0° → 90°: impulse 3D, mô-men & mặt bàn', () => {
  it.each(ANGLES)(
    '%i°: điểm chạm nằm đúng trên mặt cầu, ở phía trước cơ (hình học thật)',
    (el) => {
      for (const [tipX, tipY] of [
        [0, 0],
        [0.8, 0],
        [0, 0.8],
        [-0.6, -0.6],
      ]) {
        const s = shot({ elevation: el, tipX, tipY });
        const r = cueContactPoint(s, C);
        expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(R, 10);
        // Điểm chạm phải ở nửa bi phía đầu cơ tới (ngược hướng trục cơ)
        const rad = (el * Math.PI) / 180;
        const d = { x: Math.cos(rad), y: 0, z: -Math.sin(rad) };
        expect(r.x * d.x + r.z * d.z).toBeLessThan(0);
      }
    },
  );

  it.each(ANGLES)(
    '%i°: không sinh năng lượng (động năng bi ≤ động năng cơ), không NaN, bi dừng trong bàn',
    (el) => {
      for (const [tipX, tipY] of [
        [0, 0],
        [0.9, 0],
        [-0.9, 0.3],
        [0, 0.9],
        [0, -0.9],
      ]) {
        const s = shot({ elevation: el, tipX, tipY, power: 0.6 });
        const w = new PhysicsWorld(initialPositions(C), C);
        w.strike(s);
        expect(kineticEnergy(w.balls, C)).toBeLessThanOrEqual(
          cueKineticEnergy(s, C) + 1e-12,
        );
        const r = simulateShot(initialPositions(C), s, C);
        expect(r.final.flat().every(Number.isFinite)).toBe(true);
        for (const [x, y] of r.final) {
          expect(Math.abs(x)).toBeLessThanOrEqual(C.tableWidth / 2 - R + 1e-6);
          expect(Math.abs(y)).toBeLessThanOrEqual(C.tableHeight / 2 - R + 1e-6);
        }
        expect(r.stats.finalEnergy).toBe(0);
      }
    },
  );

  it('đánh giữa tâm: vận tốc ngang giảm dần khi cơ càng dựng; 90° bi không di chuyển', () => {
    const speeds = ANGLES.map((el) => {
      const b = strike(shot({ elevation: el, power: 0.5 }));
      return Math.hypot(b.v.x, b.v.y);
    });
    for (let i = 1; i < speeds.length; i++)
      expect(speeds[i]).toBeLessThanOrEqual(speeds[i - 1] + 1e-12);
    expect(speeds[speeds.length - 1]).toBeLessThan(1e-9);
    const r = simulateShot(lone(0), shot({ elevation: 90, power: 0.5 }), C);
    expect(r.final[0][0]).toBeCloseTo(0, 9);
    expect(r.final[0][1]).toBeCloseTo(0, 9);
  });

  it('cơ chúi đánh giữa tâm: ma sát mặt bàn lúc bi bị kẹp tạo xoáy lăn, không sinh xoáy ngang', () => {
    for (const el of [30, 60]) {
      const b = strike(shot({ elevation: el, power: 0.4 }));
      expect(Math.abs(b.w.z)).toBeLessThan(1e-9);
      expect(Math.abs(b.v.y)).toBeLessThan(1e-12);
    }
  });
});

describe('Masse / swerve: góc nâng + side spin', () => {
  /** Độ lệch ngang lúc dừng (bi không chạm băng) */
  const deviation = (el: number, tipX: number) => {
    const r = simulateShot(
      lone(-1.2),
      shot({ elevation: el, tipX, power: 0.1 }),
      C,
    );
    const cushions = r.events.filter((e) => e.type === 'cushion').length;
    return { y: r.final[0][1], cushions };
  };

  it('góc ≤ 8° (kể cả góc mặc định 5°): bi đi THẲNG theo hướng ngắm ở mọi lực, dù đánh lệch ngang', () => {
    for (const el of [0, 5, 8]) {
      for (const tipX of [-0.8, 0.8]) {
        for (const power of [0.1, 0.3, 0.6, 1]) {
          const r = simulateShot(
            lone(-1.2),
            shot({ elevation: el, tipX, tipY: 0.4, power }),
            C,
            { recordFrames: true },
          );
          // Tại mọi thời điểm trước khi chạm băng bi nằm đúng trên trục x (đường ngắm): không lệch ngang, bất kể lực
          const cushion = r.events.find((e) => e.type === 'cushion');
          const frames = r.frames.filter(
            (f) => !cushion || f.t < cushion.t - 0.01,
          );
          expect(frames.length).toBeGreaterThan(2);
          for (const f of frames)
            expect(Math.abs(f.balls[0][1])).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('0°: side spin KHÔNG làm bi cong trên mặt vải phẳng', () => {
    expect(Math.abs(deviation(0, 0.8).y)).toBeLessThan(1e-9);
  });

  it('cong về phía bên đánh lệch, độ cong tăng theo góc nâng (15° → 60°)', () => {
    let prev = 0;
    for (const el of [15, 30, 45, 60]) {
      const { y, cushions } = deviation(el, 0.8);
      expect(cushions).toBe(0);
      // Đánh lệch phải (tipX > 0) -> cong sang phải (y âm khi đánh theo +x)
      expect(y).toBeLessThan(0);
      expect(Math.abs(y)).toBeGreaterThan(prev);
      prev = Math.abs(y);
    }
  });

  it.each(ANGLES)('%i°: đánh lệch trái / phải cho quỹ đạo đối xứng', (el) => {
    const right = simulateShot(
      lone(-1.2),
      shot({ elevation: el, tipX: 0.8 }),
      C,
    );
    const left = simulateShot(
      lone(-1.2),
      shot({ elevation: el, tipX: -0.8 }),
      C,
    );
    expect(left.final[0][0]).toBeCloseTo(right.final[0][0], 9);
    expect(left.final[0][1]).toBeCloseTo(-right.final[0][1], 9);
  });

  it('90° (cơ dựng đứng): hướng bi đi do điểm chạm trên đỉnh bi quyết định', () => {
    const power = 0.08;
    const front = simulateShot(
      lone(0),
      shot({ elevation: 90, tipY: 0.8, power }),
      C,
    );
    expect(front.final[0][0]).toBeGreaterThan(0.02); // đi về hướng ngắm
    expect(Math.abs(front.final[0][1])).toBeLessThan(1e-9);
    const right = simulateShot(
      lone(0),
      shot({ elevation: 90, tipX: 0.8, power }),
      C,
    );
    expect(right.final[0][1]).toBeLessThan(-0.02); // sang phải hướng ngắm
    expect(Math.abs(right.final[0][0])).toBeLessThan(1e-9);
    for (const r of [front, right])
      expect(r.events.filter((e) => e.type === 'cushion')).toHaveLength(0);
  });
});

describe('Va chạm giữa cơ, bi và mặt bàn', () => {
  it('bi cái sát băng: cơ nằm ngang vướng băng, phải nâng cơ; 90° luôn đánh được', () => {
    const pos = lone(-C.tableWidth / 2 + R + 0.002);
    const low = checkCueClearance(pos, shot({ elevation: 0 }), C);
    expect(low.ok).toBe(false);
    expect(low.blockedBy).toBe('rail');
    expect(low.minElevation).not.toBeNull();
    const ok = checkCueClearance(
      pos,
      shot({ elevation: low.minElevation ?? 0 }),
      C,
    );
    expect(ok.ok).toBe(true);
    expect(checkCueClearance(pos, shot({ elevation: 90 }), C).ok).toBe(true);
  });

  it('bi khác nằm sát phía sau bi cái: cơ nằm ngang vướng bi, nâng cơ thì qua được', () => {
    const pos: BallPositions = [
      [0.2, 0],
      [0.2 - 2 * R - 0.001, 0],
      [1, 0.5],
    ];
    const low = checkCueClearance(pos, shot({ elevation: 0 }), C);
    expect(low.ok).toBe(false);
    expect(low.blockedBy).toBe('ball');
    expect(low.minElevation).toBeGreaterThan(0);
    expect(
      checkCueClearance(pos, shot({ elevation: low.minElevation ?? 90 }), C).ok,
    ).toBe(true);
  });

  it('băng nằm ngoài tầm cây cơ: mọi góc 0° → 90° đều đánh được', () => {
    // Bi cái gần băng phải, đánh về phía băng phải -> phía sau là ~1.5 m bàn trống (> chiều dài cơ)
    for (const el of ANGLES)
      expect(checkCueClearance(lone(0.2), shot({ elevation: el }), C).ok).toBe(
        true,
      );
  });

  it('giữa bàn, cơ nằm ngang tuyệt đối: đuôi cơ chạm băng, chỉ cần nâng ~1°', () => {
    const res = checkCueClearance(lone(0), shot({ elevation: 0 }), C);
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toBe('rail');
    expect(res.minElevation).toBeGreaterThan(0);
    expect(res.minElevation).toBeLessThanOrEqual(2);
  });

  it('đầu cơ chạm mặt vải trước bi (điểm chạm quá thấp) bị chặn', () => {
    const cfg = { ...C, maxTipOffset: 0.98 };
    const s = sanitizeShot(
      { dirX: 1, dirY: 0, power: 0.3, tipY: -1, elevation: 0 },
      0,
    );
    const res = checkCueClearance(lone(0.2), s, cfg);
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toBe('cloth');
  });

  it('góc nâng bị giới hạn 0..90° khi chuẩn hoá lệnh đánh', () => {
    expect(sanitizeShot({ elevation: 150 }, 0).elevation).toBe(90);
    expect(sanitizeShot({ elevation: -20 }, 0).elevation).toBe(0);
    expect(sanitizeShot({ elevation: 'x' }, 0).elevation).toBe(0);
  });
});
