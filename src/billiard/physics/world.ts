import { applyClothFriction } from './cloth';
import {
  RAILS,
  railGap,
  resolveBallBall,
  resolveBallCushion,
} from './collisions';
import { DEFAULT_PHYSICS, inertia, type PhysicsConfig } from './config';
import { applyCueStrike } from './cue';
import type {
  BallId,
  BallPositions,
  BallState,
  PhysicsEvent,
  Rail,
  ShotCommand,
  SimulationResult,
  TrajectoryFrame,
} from './types';
import { isFiniteVec2, isFiniteVec3 } from './vector';

/** Khoảng cách tách ra khỏi băng để tính là "rời băng" (chống đếm trùng do rung) */
const RAIL_RELEASE = 0.0015;
/** Khoảng cách tách giữa 2 bi để tính là "rời nhau" */
const BALL_RELEASE = 0.0015;

const round = (v: number, d: number) => Math.round(v * d) / d;

export function makeBalls(positions: BallPositions): BallState[] {
  return positions.map(([x, y], i) => ({
    id: i as BallId,
    p: { x, y },
    v: { x: 0, y: 0 },
    w: { x: 0, y: 0, z: 0 },
    state: 'stationary' as const,
  }));
}

/** Động năng tịnh tiến + quay (để kiểm tra không sinh năng lượng) */
export function kineticEnergy(balls: BallState[], c: PhysicsConfig): number {
  const I = inertia(c);
  let e = 0;
  for (const b of balls) {
    e += 0.5 * c.ballMass * (b.v.x * b.v.x + b.v.y * b.v.y);
    e += 0.5 * I * (b.w.x * b.w.x + b.w.y * b.w.y + b.w.z * b.w.z);
  }
  return e;
}

/**
 * Thế giới vật lý với bước thời gian CỐ ĐỊNH (1/tickRate, chia substeps).
 * `advance(frameDt)` dùng accumulator nên kết quả không phụ thuộc FPS hiển thị.
 */
export class PhysicsWorld {
  readonly balls: BallState[];
  readonly events: PhysicsEvent[] = [];
  time = 0;
  steps = 0;
  maxIterations = 0;
  private accumulator = 0;
  private readonly railContact = new Set<string>();
  private readonly ballContact = new Set<string>();

  constructor(
    positions: BallPositions,
    readonly config: PhysicsConfig = DEFAULT_PHYSICS,
  ) {
    this.balls = makeBalls(positions);
  }

  strike(shot: ShotCommand): number {
    const speed = applyCueStrike(this.balls[shot.cue], shot, this.config);
    this.events.push({ t: this.time, type: 'cue', ball: shot.cue, speed });
    return speed;
  }

  isMoving(): boolean {
    return this.balls.some((b) => b.state !== 'stationary');
  }

  /** Tiến thời gian thực frameDt (giây) theo các bước cố định */
  advance(frameDt: number): void {
    const tick = 1 / this.config.tickRate;
    this.accumulator += Math.min(frameDt, 0.25);
    while (this.accumulator >= tick) {
      this.step();
      this.accumulator -= tick;
    }
  }

  /** 1 bước cố định = nhiều substep (semi-implicit Euler) */
  step(): void {
    const c = this.config;
    const dt = 1 / c.tickRate / c.substeps;
    for (let s = 0; s < c.substeps; s++) {
      // 1. Lực ma sát vải -> cập nhật vận tốc, rồi vị trí (semi-implicit)
      for (const b of this.balls) {
        if (b.state === 'stationary') continue;
        applyClothFriction(b, dt, c);
        b.p.x += b.v.x * dt;
        b.p.y += b.v.y * dt;
      }
      // 2. Va chạm (lặp có giới hạn để xử lý chuỗi va chạm gần đồng thời)
      let iter = 0;
      for (; iter < c.collisionIterations; iter++) {
        if (!this.resolveCollisions()) break;
      }
      this.maxIterations = Math.max(this.maxIterations, iter);
      this.updateContacts();
      this.guardNumerics();
      this.time += dt;
    }
    this.steps++;
  }

  /** Trả về true nếu có va chạm được xử lý */
  private resolveCollisions(): boolean {
    const c = this.config;
    let any = false;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const a = this.balls[i];
        const b = this.balls[j];
        const speed = resolveBallBall(a, b, c);
        if (speed > 0) {
          any = true;
          const key = `${i}${j}`;
          if (!this.ballContact.has(key)) {
            this.ballContact.add(key);
            this.events.push({
              t: this.time,
              type: 'ball',
              a: i as BallId,
              b: j as BallId,
              speed,
            });
          }
        }
      }
    }
    for (const b of this.balls) {
      for (const rail of RAILS) {
        const speed = resolveBallCushion(b, rail, c);
        if (speed > 0) {
          any = true;
          const key = `${b.id}${rail}`;
          if (!this.railContact.has(key)) {
            this.railContact.add(key);
            this.events.push({
              t: this.time,
              type: 'cushion',
              ball: b.id,
              rail: rail,
              speed,
            });
          }
        }
      }
    }
    return any;
  }

  /** Bỏ trạng thái "đang chạm" khi bi đã rời hẳn (chống đếm trùng do rung / sửa xuyên) */
  private updateContacts(): void {
    const c = this.config;
    for (const key of Array.from(this.railContact)) {
      const b = this.balls[Number(key[0])];
      const rail = key.slice(1) as Rail;
      if (railGap(b, rail, c) > RAIL_RELEASE) this.railContact.delete(key);
    }
    for (const key of Array.from(this.ballContact)) {
      const a = this.balls[Number(key[0])];
      const b = this.balls[Number(key[1])];
      const d = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y);
      if (d > 2 * c.ballRadius + BALL_RELEASE) this.ballContact.delete(key);
    }
  }

  /** Không bao giờ để NaN / Infinity lan ra (đưa bi về trạng thái dừng an toàn) */
  private guardNumerics(): void {
    const c = this.config;
    for (const b of this.balls) {
      if (!isFiniteVec2(b.p)) {
        b.p.x = 0;
        b.p.y = 0;
      }
      if (!isFiniteVec2(b.v) || !isFiniteVec3(b.w)) {
        b.v.x = b.v.y = 0;
        b.w.x = b.w.y = b.w.z = 0;
        b.state = 'stationary';
      }
      // Kẹp trong bàn phòng trường hợp cực đoan
      const hx = c.tableWidth / 2 - c.ballRadius;
      const hy = c.tableHeight / 2 - c.ballRadius;
      b.p.x = Math.max(-hx, Math.min(hx, b.p.x));
      b.p.y = Math.max(-hy, Math.min(hy, b.p.y));
    }
  }

  positions(): BallPositions {
    return this.balls.map((b) => [b.p.x, b.p.y]);
  }

  frame(): TrajectoryFrame {
    return {
      t: round(this.time, 1000),
      balls: this.balls.map((b) => [
        round(b.p.x, 1e4),
        round(b.p.y, 1e4),
        round(b.w.x, 100),
        round(b.w.y, 100),
        round(b.w.z, 100),
      ]),
    };
  }
}

/** Mô phỏng trọn 1 cú đánh tới khi mọi bi dừng (server dùng làm kết quả chính thức) */
export function simulateShot(
  start: BallPositions,
  shot: ShotCommand,
  config: PhysicsConfig = DEFAULT_PHYSICS,
  options: { recordFrames?: boolean } = {},
): SimulationResult {
  const world = new PhysicsWorld(start, config);
  world.strike(shot);
  const initialEnergy = kineticEnergy(world.balls, config);
  const frames: TrajectoryFrame[] = [];
  const frameEvery = 1 / config.frameRate;
  let nextFrame = 0;
  if (options.recordFrames) frames.push(world.frame());

  while (world.isMoving() && world.time < config.maxSimTime) {
    world.step();
    if (options.recordFrames && world.time >= nextFrame + frameEvery) {
      nextFrame += frameEvery;
      frames.push(world.frame());
    }
  }
  if (options.recordFrames) frames.push(world.frame());

  return {
    final: world.positions(),
    events: world.events,
    frames,
    duration: world.time,
    stats: {
      steps: world.steps,
      maxCollisionIterations: world.maxIterations,
      initialEnergy,
      finalEnergy: kineticEnergy(world.balls, config),
    },
  };
}

/** Vị trí khai cuộc carom: bi đỏ ở điểm chân bàn, bi vàng ở điểm đầu bàn, bi trắng cạnh bi vàng */
export function initialPositions(
  config: PhysicsConfig = DEFAULT_PHYSICS,
): BallPositions {
  return [
    [-config.tableWidth / 4, -0.1825],
    [-config.tableWidth / 4, 0],
    [config.tableWidth / 4, 0],
  ];
}
