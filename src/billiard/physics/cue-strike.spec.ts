/// <reference types="jest" />
import {
  DEFAULT_PHYSICS as C,
  computeCueStrike,
  cueFrame,
  inertia,
  sanitizeShot,
  simulateShot,
  validateShotInput,
  type ShotCommand,
  type Vec3,
} from './index';

/**
 * Kiểm chứng định luật cơ học của cú đánh ở các góc cơ yêu cầu.
 * Hệ toạ độ vật lý: x, y nằm ngang, z hướng lên.
 */
const ANGLES = [0, 15, 30, 45, 60, 75, 89, 90];
const m = C.ballMass;
const R = C.ballRadius;
const I = inertia(C);

const CASES: { name: string; tipX: number; tipY: number; power: number }[] = [
  { name: 'giữa tâm', tipX: 0, tipY: 0, power: 0.5 },
  { name: 'top spin', tipX: 0, tipY: 0.8, power: 0.5 },
  { name: 'back spin', tipX: 0, tipY: -0.8, power: 0.5 },
  { name: 'English trái', tipX: -0.8, tipY: 0, power: 0.5 },
  { name: 'English phải', tipX: 0.8, tipY: 0, power: 0.5 },
  { name: 'xoáy kết hợp', tipX: 0.55, tipY: -0.55, power: 0.5 },
  { name: 'lực nhẹ', tipX: 0.3, tipY: 0.3, power: 0.02 },
  { name: 'lực mạnh', tipX: -0.3, tipY: 0.4, power: 1 },
];
const AZIMUTHS = [0, 37, 90, 155, 210, 300];

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const finite = (v: Vec3) => [v.x, v.y, v.z].every((n) => Number.isFinite(n));
const shotAt = (
  el: number,
  az: number,
  k: { tipX: number; tipY: number; power: number },
): ShotCommand =>
  sanitizeShot(
    {
      dirX: Math.cos((az * Math.PI) / 180),
      dirY: Math.sin((az * Math.PI) / 180),
      elevation: el,
      ...k,
    },
    0,
  );

describe.each(ANGLES)('Góc cơ %i°', (el) => {
  it.each(CASES)(
    '$name: động lượng, mô-men động lượng, phản lực bàn đúng định luật',
    (k) => {
      for (const az of AZIMUTHS) {
        const s = shotAt(el, az, k);
        const res = computeCueStrike(s, C);
        const P = res.cueImpulse;
        const F = res.tableFrictionImpulse;

        // Không có giá trị bất thường
        for (const v of [res.contact, P, F, res.dv, res.dw])
          expect(finite(v)).toBe(true);

        // Điểm chạm nằm đúng trên mặt cầu, phía đầu cơ tới
        expect(
          Math.hypot(res.contact.x, res.contact.y, res.contact.z),
        ).toBeCloseTo(R, 10);
        const d = res.direction;
        expect(
          res.contact.x * d.x + res.contact.y * d.y + res.contact.z * d.z,
        ).toBeLessThan(0);
        // Xung lực theo đúng hướng cơ 3D
        const Jmag = Math.hypot(P.x, P.y, P.z);
        expect(Jmag).toBeGreaterThan(0);
        expect((P.x * d.x + P.y * d.y + P.z * d.z) / Jmag).toBeCloseTo(1, 10);

        // Ràng buộc bàn: phản lực pháp tuyến = thành phần đi xuống của xung lực, ≥ 0
        expect(res.tableNormalImpulse).toBeGreaterThanOrEqual(0);
        expect(res.tableNormalImpulse).toBeCloseTo(Math.max(0, -P.z), 12);
        // Bi không nảy / không xuyên bàn
        expect(res.dv.z).toBe(0);
        // Ma sát Coulomb: |F| ≤ μN, nằm ngang
        expect(F.z).toBe(0);
        expect(Math.hypot(F.x, F.y)).toBeLessThanOrEqual(
          C.strikeTableFriction * res.tableNormalImpulse + 1e-12,
        );

        // Δp = P_ngang + F
        expect(m * res.dv.x).toBeCloseTo(P.x + F.x, 10);
        expect(m * res.dv.y).toBeCloseTo(P.y + F.y, 10);
        // ΔL = r × P + rb × F (mô-men lực tại điểm chạm & đáy bi)
        const L = cross(res.contact, P);
        const Lf = cross({ x: 0, y: 0, z: -R }, F);
        expect(I * res.dw.x).toBeCloseTo(L.x + Lf.x, 10);
        expect(I * res.dw.y).toBeCloseTo(L.y + Lf.y, 10);
        expect(I * res.dw.z).toBeCloseTo(L.z + Lf.z, 10);

        // Không sinh năng lượng: động năng bi ≤ động năng cơ
        const ke =
          0.5 * m * (res.dv.x ** 2 + res.dv.y ** 2) +
          0.5 * I * (res.dw.x ** 2 + res.dw.y ** 2 + res.dw.z ** 2);
        expect(ke).toBeLessThanOrEqual(res.cueEnergy + 1e-12);
      }
    },
  );

  it.each(CASES)(
    '$name: kết quả xoay đúng theo hướng ngắm ngang (đối xứng quay)',
    (k) => {
      const base = computeCueStrike(shotAt(el, 0, k), C);
      for (const az of AZIMUTHS) {
        const a = (az * Math.PI) / 180;
        const rot = (v: Vec3): Vec3 => ({
          x: v.x * Math.cos(a) - v.y * Math.sin(a),
          y: v.x * Math.sin(a) + v.y * Math.cos(a),
          z: v.z,
        });
        const res = computeCueStrike(shotAt(el, az, k), C);
        const dv = rot(base.dv);
        const dw = rot(base.dw);
        expect(res.dv.x).toBeCloseTo(dv.x, 9);
        expect(res.dv.y).toBeCloseTo(dv.y, 9);
        expect(res.dw.x).toBeCloseTo(dw.x, 7);
        expect(res.dw.y).toBeCloseTo(dw.y, 7);
        expect(res.dw.z).toBeCloseTo(dw.z, 7);
      }
    },
  );

  it('mô phỏng trọn cú đánh ổn định: bi luôn trên bàn, không NaN, dừng hẳn', () => {
    for (const k of CASES) {
      const r = simulateShot(
        [
          [0, 0],
          [1.2, 0.55],
          [-1.2, -0.55],
        ],
        shotAt(el, 20, k),
        C,
        { recordFrames: true },
      );
      for (const f of r.frames)
        for (const b of f.balls) {
          expect(b.every(Number.isFinite)).toBe(true);
          expect(Math.abs(b[0])).toBeLessThanOrEqual(
            C.tableWidth / 2 - R + 1e-6,
          );
          expect(Math.abs(b[1])).toBeLessThanOrEqual(
            C.tableHeight / 2 - R + 1e-6,
          );
        }
      expect(r.stats.finalEnergy).toBe(0);
    }
  });
});

describe('Đặc trưng vật lý theo góc cơ', () => {
  it('phản lực bàn tăng dần theo góc cơ (đánh giữa tâm, cùng lực)', () => {
    const N = ANGLES.map(
      (el) => computeCueStrike(shotAt(el, 0, CASES[0]), C).tableNormalImpulse,
    );
    expect(N[0]).toBe(0);
    for (let i = 1; i < N.length; i++) expect(N[i]).toBeGreaterThan(N[i - 1]);
  });

  it('90° là biên hình học: hướng cơ thẳng đứng chính xác, không có thành phần ngang giả', () => {
    const { d } = cueFrame(shotAt(90, 37, CASES[0]));
    expect(d).toEqual({ x: 0, y: 0, z: -1 });
    const center = computeCueStrike(shotAt(90, 37, CASES[0]), C);
    expect(Math.hypot(center.dv.x, center.dv.y)).toBe(0);
    expect(Math.hypot(center.dw.x, center.dw.y, center.dw.z)).toBe(0);
    // Toàn bộ xung lực đi vào mặt bàn, bi không nảy
    expect(center.tableNormalImpulse).toBeCloseTo(-center.cueImpulse.z, 12);
  });

  it('89° và 90° cho kết quả liên tục (không mất ổn định số ở sát biên)', () => {
    for (const k of CASES.slice(1, 6)) {
      const a = computeCueStrike(shotAt(89, 0, k), C);
      const b = computeCueStrike(shotAt(90, 0, k), C);
      const diff = Math.hypot(a.dv.x - b.dv.x, a.dv.y - b.dv.y);
      const scale = Math.hypot(b.dv.x, b.dv.y) + 0.05;
      expect(diff / scale).toBeLessThan(0.2);
    }
  });

  it('không gán spin theo góc: đánh giữa tâm thì không có side spin ở mọi góc', () => {
    for (const el of ANGLES)
      expect(
        Math.abs(computeCueStrike(shotAt(el, 0, CASES[0]), C).dw.z),
      ).toBeLessThan(1e-12);
  });

  it('English trái / phải đối xứng gương ở mọi góc', () => {
    for (const el of ANGLES) {
      const l = computeCueStrike(shotAt(el, 0, CASES[3]), C);
      const r = computeCueStrike(shotAt(el, 0, CASES[4]), C);
      expect(l.dv.x).toBeCloseTo(r.dv.x, 10);
      expect(l.dv.y).toBeCloseTo(-r.dv.y, 10);
      expect(l.dw.z).toBeCloseTo(-r.dw.z, 10);
    }
  });
});

describe('Kiểm tra dữ liệu đầu vào (client & server dùng chung)', () => {
  const ok = { dirX: 1, dirY: 0, power: 0.5, elevation: 30, tipX: 0, tipY: 0 };
  it('chấp nhận biên hợp lệ 0° và 90°', () => {
    expect(validateShotInput({ ...ok, elevation: 0 })).toBeNull();
    expect(validateShotInput({ ...ok, elevation: 90 })).toBeNull();
  });
  it.each([
    ['góc âm', { elevation: -0.01 }],
    ['góc trên 90°', { elevation: 90.01 }],
    ['góc NaN', { elevation: NaN }],
    ['góc Infinity', { elevation: Infinity }],
    ['thiếu góc', { elevation: undefined }],
    ['hướng rỗng', { dirX: 0, dirY: 0 }],
    ['lực ngoài khoảng', { power: 1.5 }],
    ['điểm chạm ngoài khoảng', { tipX: 2 }],
  ])('từ chối: %s', (_, patch) => {
    expect(validateShotInput({ ...ok, ...patch })).not.toBeNull();
  });
});
