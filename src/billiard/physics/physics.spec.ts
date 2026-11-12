/// <reference types="jest" />
import {
  DEFAULT_PHYSICS as C,
  PhysicsWorld,
  initialPositions,
  judgeShot,
  kineticEnergy,
  resolveBallBall,
  resolveBallCushion,
  sanitizeShot,
  simulateShot,
  makeBalls,
  type BallPositions,
  type BallState,
  type ShotCommand,
} from './index';

const R = C.ballRadius;
const shot = (p: Partial<ShotCommand>): ShotCommand =>
  sanitizeShot(
    { dirX: 1, dirY: 0, power: 0.4, tipX: 0, tipY: 0, ...p },
    p.cue ?? 0,
  );

/** Bàn trống: chỉ có bi cái ở vị trí cho trước, 2 bi kia đặt ở góc xa */
const lone = (x: number, y: number): BallPositions => [
  [x, y],
  [-1.3, 0.62],
  [-1.3, -0.62],
];

const allFinite = (balls: BallState[]) =>
  balls.every((b) =>
    [b.p.x, b.p.y, b.v.x, b.v.y, b.w.x, b.w.y, b.w.z].every(Number.isFinite),
  );

const inside = (pos: BallPositions) =>
  pos.every(
    ([x, y]) =>
      Math.abs(x) <= C.tableWidth / 2 - R + 1e-6 &&
      Math.abs(y) <= C.tableHeight / 2 - R + 1e-6,
  );

describe('Vật lý bida — chuyển động trên mặt vải', () => {
  it('bi lăn thẳng, giảm tốc mượt và dừng hẳn', () => {
    const r = simulateShot(lone(-1, 0), shot({ power: 0.12 }), C, {
      recordFrames: true,
    });
    expect(r.duration).toBeGreaterThan(1);
    expect(r.duration).toBeLessThan(C.maxSimTime);
    expect(Math.abs(r.final[0][1])).toBeLessThan(1e-9); // đi thẳng
    // Vị trí tăng đơn điệu (không giật lùi), tốc độ giảm dần
    const xs = r.frames.map((f) => f.balls[0][0]);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-9);
    expect(r.stats.finalEnergy).toBe(0);
  });

  it('đánh giữa tâm: trượt rồi chuyển sang lăn đúng thời điểm lý thuyết', () => {
    const w = new PhysicsWorld(lone(-1, 0), C);
    w.strike(shot({ power: 0.3 }));
    const v0 = w.balls[0].v.x;
    // Lý thuyết: u0 = v0, u giảm với tốc độ 3.5·μs·g -> t = v0 / (3.5 μs g)
    const tRoll = v0 / (3.5 * C.clothSlidingFriction * C.gravity);
    let tSeen = -1;
    while (w.time < 2) {
      w.step();
      if (tSeen < 0 && w.balls[0].state === 'rolling') tSeen = w.time;
    }
    expect(tSeen).toBeGreaterThan(0);
    expect(Math.abs(tSeen - tRoll)).toBeLessThan(0.02);
    // Khi lăn: ràng buộc ω = v/R thoả mãn
    const b = w.balls[0];
    expect(Math.abs(b.w.y - b.v.x / R)).toBeLessThan(1e-6);
    // Vận tốc khi bắt đầu lăn = 5/7 v0 (bảo toàn mô-men động lượng quanh điểm tiếp xúc)
  });

  it('top spin làm bi lăn xa hơn, back spin làm bi đi ngắn hơn (cùng lực)', () => {
    const dist = (tipY: number) =>
      simulateShot(lone(-1.2, 0), shot({ power: 0.08, tipY }), C).final[0][0] +
      1.2;
    const center = dist(0);
    expect(dist(0.8)).toBeGreaterThan(center);
    expect(dist(-0.8)).toBeLessThan(center);
  });

  it('side spin suy giảm dần và không làm bi đi lệch trên mặt vải phẳng', () => {
    const w = new PhysicsWorld(lone(-1.2, 0), C);
    w.strike(shot({ power: 0.15, tipX: 0.8 }));
    const wz0 = w.balls[0].w.z;
    expect(wz0).toBeGreaterThan(0);
    for (let i = 0; i < 240; i++) w.step();
    expect(Math.abs(w.balls[0].w.z)).toBeLessThan(Math.abs(wz0));
    expect(Math.abs(w.balls[0].p.y)).toBeLessThan(1e-6);
  });

  it('kết quả không phụ thuộc FPS hiển thị (accumulator)', () => {
    const run = (fps: number) => {
      const w = new PhysicsWorld(initialPositions(C), C);
      w.strike(shot({ dirX: 1, dirY: 0.18, power: 0.7, tipX: 0.3, tipY: 0.4 }));
      for (let i = 0; i < fps * 3; i++) w.advance(1 / fps);
      return w.positions();
    };
    const a = run(30);
    const b = run(144);
    // Cùng số bước cố định trong 3 giây -> cùng trạng thái (sai lệch <= 1 bước)
    a.forEach((p, i) => {
      expect(Math.abs(p[0] - b[i][0])).toBeLessThan(0.01);
      expect(Math.abs(p[1] - b[i][1])).toBeLessThan(0.01);
    });
  });
});

describe('Vật lý bida — va chạm bi với bi', () => {
  it('va chạm trực diện: bi cái gần như dừng (stun), bi mục tiêu đi tiếp', () => {
    // Bi cái đánh giữa tâm từ xa -> đã lăn khi tới, nên sẽ lăn theo một chút
    // Dùng va chạm trực tiếp bằng resolveBallBall với bi đang trượt không spin
    const [a, b] = makeBalls([
      [0, 0],
      [2 * R - 1e-4, 0],
      [1, 0.5],
    ]);
    a.v.x = 2;
    a.state = 'sliding';
    const e0 = kineticEnergy([a, b], C);
    resolveBallBall(a, b, C);
    expect(b.v.x).toBeGreaterThan(1.8);
    expect(Math.abs(a.v.x)).toBeLessThan(0.1);
    expect(kineticEnergy([a, b], C)).toBeLessThanOrEqual(e0 + 1e-12);
  });

  it('va chạm lệch tâm: 2 bi tách theo góc ~90° và không sinh năng lượng', () => {
    const [a, b] = makeBalls([
      [0, 0],
      [Math.sqrt(3) * R - 1e-5, R],
      [1, 0.5],
    ]);
    a.v.x = 2;
    a.state = 'sliding';
    const e0 = kineticEnergy([a, b], C);
    resolveBallBall(a, b, C);
    const dotv = a.v.x * b.v.x + a.v.y * b.v.y;
    const cosAng = dotv / (Math.hypot(a.v.x, a.v.y) * Math.hypot(b.v.x, b.v.y));
    expect(Math.abs(cosAng)).toBeLessThan(0.15); // gần vuông góc
    expect(kineticEnergy([a, b], C)).toBeLessThanOrEqual(e0 + 1e-12);
  });

  it('bi lăn top spin chạm thẳng bi đứng yên -> bi cái lăn theo (follow)', () => {
    const r = simulateShot(
      [
        [-0.6, 0],
        [-1.3, 0.6],
        [0, 0],
      ],
      shot({ power: 0.35, tipY: 0.8 }),
      C,
    );
    expect(r.final[0][0]).toBeGreaterThan(0.05); // bi cái vượt qua chỗ bi đỏ
  });

  it('back spin chạm thẳng -> bi cái kéo ngược lại (draw)', () => {
    const r = simulateShot(
      [
        [-0.3, 0],
        [-1.3, 0.6],
        [0, 0],
      ],
      shot({ power: 0.5, tipY: -0.9 }),
      C,
    );
    expect(r.final[0][0]).toBeLessThan(-0.3); // lùi về sau điểm xuất phát
  });

  it('chuỗi va chạm 3 bi gần đồng thời vẫn ổn định, không xuyên bi', () => {
    const r = simulateShot(
      [
        [-0.5, 0],
        [0, 0],
        [2 * R + 0.0005, 0],
      ],
      shot({ power: 0.8 }),
      C,
      { recordFrames: true },
    );
    for (const f of r.frames) {
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++) {
          const d = Math.hypot(
            f.balls[i][0] - f.balls[j][0],
            f.balls[i][1] - f.balls[j][1],
          );
          expect(d).toBeGreaterThan(2 * R - 0.002);
        }
    }
    expect(r.stats.finalEnergy).toBe(0);
  });
});

describe('Vật lý bida — va chạm băng', () => {
  const hitRail = (vx: number, vy: number, w = { x: 0, y: 0, z: 0 }) => {
    const [b] = makeBalls([
      [C.tableWidth / 2 - R + 0.0005, 0],
      [0, 0.5],
      [0, -0.5],
    ]);
    b.v.x = vx;
    b.v.y = vy;
    b.w = { ...w };
    b.state = 'sliding';
    const e0 = kineticEnergy([b], C);
    resolveBallCushion(b, 'right', C);
    return { b, e0, e1: kineticEnergy([b], C) };
  };

  it('đi vuông góc vào băng: bật ngược, mất năng lượng hợp lý, không dính băng', () => {
    const { b, e0, e1 } = hitRail(2, 0);
    expect(b.v.x).toBeLessThan(-1.2);
    expect(b.v.x).toBeGreaterThan(-2);
    expect(Math.abs(b.v.y)).toBeLessThan(1e-9);
    expect(e1).toBeLessThan(e0);
  });

  it('đi xiên vào băng: giữ hướng tiếp tuyến, không tạo năng lượng', () => {
    const { b, e0, e1 } = hitRail(1.5, 1.5);
    expect(b.v.x).toBeLessThan(0);
    expect(b.v.y).toBeGreaterThan(0.8);
    expect(e1).toBeLessThanOrEqual(e0 + 1e-12);
  });

  it('running English làm góc bật mở rộng, reverse English làm góc bật hẹp lại', () => {
    // Bi đi lên-phải (vy > 0) chạm băng phải. Side spin cùng chiều chuyển động
    // tiếp tuyến tại điểm chạm = running.
    const base = hitRail(1.5, 1.0).b.v.y;
    const spinA = hitRail(1.5, 1.0, { x: 0, y: 0, z: 60 }).b.v.y;
    const spinB = hitRail(1.5, 1.0, { x: 0, y: 0, z: -60 }).b.v.y;
    // Một chiều xoáy làm vy tăng (running), chiều kia làm vy giảm (reverse)
    expect(Math.sign(spinA - base)).toBe(-Math.sign(spinB - base));
    expect(Math.abs(spinA - base)).toBeGreaterThan(0.05);
  });

  it('top spin / back spin thay đổi phản ứng sau băng (theo ma sát tại điểm tiếp xúc)', () => {
    const top = hitRail(2, 0, { x: 0, y: 65, z: 0 }).b;
    const back = hitRail(2, 0, { x: 0, y: -65, z: 0 }).b;
    expect(top.w.y).not.toBeCloseTo(back.w.y, 3);
  });

  it('tốc độ cao không xuyên băng, chạm góc bàn & nhiều băng liên tiếp vẫn ổn định', () => {
    for (const [dx, dy] of [
      [1, 0.5],
      [1, 1],
      [-0.7, 1],
      [0.3, -1],
    ]) {
      const r = simulateShot(
        initialPositions(C),
        shot({ dirX: dx, dirY: dy, power: 1, tipX: 0.5, tipY: -0.4 }),
        C,
        { recordFrames: true },
      );
      for (const f of r.frames)
        expect(inside(f.balls.map((b) => [b[0], b[1]]))).toBe(true);
      expect(r.stats.finalEnergy).toBe(0);
      expect(r.duration).toBeLessThan(C.maxSimTime);
    }
  });

  it('chạm vào góc bàn được tính 2 băng riêng biệt, không đếm trùng do rung', () => {
    const r = simulateShot(
      lone(1.2, 0.5),
      shot({ dirX: 1, dirY: 0.95, power: 0.4 }),
      C,
    );
    const cushions = r.events.filter(
      (e) => e.type === 'cushion' && e.ball === 0,
    );
    const rails = cushions.map((e) => (e.type === 'cushion' ? e.rail : ''));
    // Không có 2 sự kiện liên tiếp cùng 1 băng trong cùng một lần chạm
    for (let i = 1; i < cushions.length; i++) {
      if (rails[i] === rails[i - 1])
        expect(cushions[i].t - cushions[i - 1].t).toBeGreaterThan(0.05);
    }
    expect(rails.slice(0, 2).sort()).toEqual(['right', 'top']);
  });
});

describe('Ổn định số học', () => {
  it('ngẫu nhiên 300 cú đánh: không NaN, không ra ngoài bàn, luôn dừng, không sinh năng lượng', () => {
    let seed = 12345;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 300; i++) {
      const s = shot({
        dirX: rnd() * 2 - 1,
        dirY: rnd() * 2 - 1,
        power: rnd(),
        tipX: rnd() * 2 - 1,
        tipY: rnd() * 2 - 1,
      });
      const w = new PhysicsWorld(initialPositions(C), C);
      w.strike(s);
      const e0 = kineticEnergy(w.balls, C);
      let prevE = e0;
      while (w.isMoving() && w.time < C.maxSimTime) {
        w.step();
        const e = kineticEnergy(w.balls, C);
        // Năng lượng không bao giờ tăng (cho phép sai số rất nhỏ)
        expect(e).toBeLessThanOrEqual(prevE * 1.0001 + 1e-9);
        prevE = e;
      }
      expect(allFinite(w.balls)).toBe(true);
      expect(inside(w.positions())).toBe(true);
      expect(w.isMoving()).toBe(false);
    }
  });

  it('dữ liệu đánh bậy được chuẩn hoá, điểm chạm bị giới hạn trong hình tròn', () => {
    const s = sanitizeShot(
      { dirX: NaN, dirY: Infinity, power: 50, tipX: 9, tipY: -9 },
      0,
    );
    expect(s.power).toBe(1);
    expect(Math.hypot(s.tipX, s.tipY)).toBeLessThanOrEqual(1 + 1e-12);
    expect(Math.hypot(s.dirX, s.dirY)).toBeCloseTo(1, 9);
  });
});

describe('Luật carom', () => {
  const ev = (list: string[]) =>
    list.map((s, i) =>
      s.startsWith('C')
        ? {
            t: i,
            type: 'cushion' as const,
            ball: 0 as const,
            rail: 'top' as const,
            speed: 1,
          }
        : {
            t: i,
            type: 'ball' as const,
            a: 0 as const,
            b: Number(s[1]) as 1 | 2,
            speed: 1,
          },
    );

  it('phăng: chạm đủ 2 bi thì ghi điểm', () => {
    expect(judgeShot(ev(['B2', 'B1']), 0, { mode: 'free' }).scored).toBe(true);
    expect(judgeShot(ev(['B2', 'C', 'B2']), 0, { mode: 'free' }).scored).toBe(
      false,
    );
    expect(judgeShot(ev(['C', 'C']), 0, { mode: 'free' }).missedAll).toBe(true);
  });

  it('3 băng: cần ≥ 3 băng trước bi thứ hai', () => {
    expect(
      judgeShot(ev(['B2', 'C', 'C', 'C', 'B1']), 0, { mode: 'three' }).scored,
    ).toBe(true);
    expect(
      judgeShot(ev(['B2', 'C', 'C', 'B1', 'C']), 0, { mode: 'three' }).scored,
    ).toBe(false);
    // Luật UMB: băng trước bi thứ nhất cũng được tính
    expect(
      judgeShot(ev(['C', 'C', 'B2', 'C', 'B1']), 0, { mode: 'three' }).scored,
    ).toBe(true);
    // Tuỳ chọn chỉ tính băng sau bi thứ nhất
    expect(
      judgeShot(ev(['C', 'C', 'B2', 'C', 'B1']), 0, {
        mode: 'three',
        cushionsAfterFirstBallOnly: true,
      }).scored,
    ).toBe(false);
  });

  it('va chạm giữa 2 bi mục tiêu không tính cho bi cái', () => {
    const events = [
      { t: 0, type: 'ball' as const, a: 0 as const, b: 2 as const, speed: 1 },
      { t: 1, type: 'ball' as const, a: 1 as const, b: 2 as const, speed: 1 },
    ];
    expect(judgeShot(events, 0, { mode: 'free' }).scored).toBe(false);
  });
});
