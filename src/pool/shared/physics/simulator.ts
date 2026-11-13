// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import { POOL_PHYSICS, inertia, type PoolConfig } from './config';
import { applyStrike } from './cue';
import { resolveBallBall, resolveBallCushion } from './collisions';
import { dlen, hashNumbers } from './math';
import { advanceBall, classify } from './motion';
import { closestOnSegment, tableFor, type TableGeometry } from './table';
import {
  FRAME_STRIDE,
  type Ball,
  type BallSpot,
  type CushionPart,
  type ShotCommand,
  type ShotResult,
  type ShotTrace,
  type SimEvent,
} from './types';

export function createBalls(spots: BallSpot[]): Ball[] {
  return spots.map((s) => ({
    n: s.n,
    p: { x: s.x, y: s.y },
    v: { x: 0, y: 0 },
    w: { x: 0, y: 0, z: 0 },
    state: 'stationary' as const,
    pocket: -1,
    dropTime: 0,
    z: 0,
    h: 0,
    vz: 0,
  }));
}

export function kineticEnergy(balls: Ball[], c: PoolConfig): number {
  const I = inertia(c);
  let e = 0;
  for (const b of balls) {
    if (b.state === 'pocketed' || b.state === 'offTable') continue;
    // Động năng tịnh tiến (cả phương đứng khi bay) + quay
    e += 0.5 * c.ballMass * (b.v.x * b.v.x + b.v.y * b.v.y + b.vz * b.vz);
    e += 0.5 * I * (b.w.x * b.w.x + b.w.y * b.w.y + b.w.z * b.w.z);
  }
  return e;
}

/** Băm vị trí cuối + bi vào lỗ: client & server phải ra cùng chuỗi */
export function stateHash(
  final: BallSpot[],
  pocketed: { ball: number; pocket: number }[],
): string {
  const nums: number[] = [];
  for (const b of final) nums.push(b.n, b.x, b.y);
  nums.push(-1);
  for (const p of pocketed) nums.push(p.ball, p.pocket);
  return hashNumbers(nums);
}

type Contact =
  | { kind: 'ball'; i: number; j: number; s: number }
  | {
      kind: 'cushion';
      i: number;
      ox: number;
      oy: number;
      s: number;
      part: CushionPart;
    };

/**
 * MÔ PHỎNG BƯỚC CỐ ĐỊNH 0.5 ms + VA CHẠM LIÊN TỤC (CCD) — XÁC ĐỊNH.
 *
 * Mỗi bước:
 *  1. Tiến bi bằng nghiệm giải tích của pha trượt / lăn / xoáy (motion.ts).
 *  2. Tìm va chạm SỚM NHẤT (bi–bi, bi–mũi băng, bi–mặt vát, bi–mũi lỗ bo tròn): lùi về đúng
 *     thời điểm tiếp xúc, áp xung lực, tiến lại; lặp tới khi hết va chạm.
 *  3. Tâm bi vượt qua mép hố -> bi bắt đầu RƠI (rơi tự do theo phương đứng, vẫn bay ngang).
 *     Trong lúc rơi bi có thể đập THÀNH SAU LỖ; nếu bị hất ra khỏi hố khi chưa tụt quá
 *     dropEscapeDepth·R thì bi trở lại mặt bàn (bị lỗ "từ chối"). Tụt quá R -> vào lỗ.
 * Chỉ dùng + − × ÷ √ nên cùng đầu vào cho kết quả bit-giống-nhau trên mọi máy.
 */
export class PoolSim {
  readonly balls: Ball[];
  readonly events: SimEvent[] = [];
  time = 0;
  steps = 0;
  maxPasses = 0;
  firstHit: number | null = null;
  miscue = false;
  readonly cushionAfter = new Set<number>();
  readonly objectCushion = new Set<number>();
  readonly pocketed: { ball: number; pocket: number }[] = [];
  readonly offTable: number[] = [];
  readonly c: PoolConfig;
  readonly table: TableGeometry;
  private readonly nearRail: number;

  constructor(
    spots: BallSpot[],
    c: PoolConfig = POOL_PHYSICS,
    table?: TableGeometry,
  ) {
    this.c = c;
    this.table = table ?? tableFor(c);
    this.balls = createBalls(spots);
    this.nearRail = c.ballRadius + 0.002;
  }

  cueBall(): Ball | undefined {
    return this.balls.find(
      (b) => b.n === 0 && b.state !== 'pocketed' && b.state !== 'offTable',
    );
  }

  strike(cmd: ShotCommand): void {
    const cue = this.cueBall();
    if (!cue) return;
    const o = applyStrike(cue, cmd, this.c);
    this.miscue = o.miscue;
    this.events.push({
      t: this.time,
      type: 'cue',
      speed: o.speed,
      miscue: o.miscue,
      x: cue.p.x,
      y: cue.p.y,
    });
    if (o.jump)
      this.events.push({
        t: this.time,
        type: 'jump',
        ball: cue.n,
        vz: o.vz,
        x: cue.p.x,
        y: cue.p.y,
      });
  }

  isMoving(): boolean {
    for (const b of this.balls)
      if (
        b.state !== 'stationary' &&
        b.state !== 'pocketed' &&
        b.state !== 'offTable'
      )
        return true;
    return false;
  }

  step(): void {
    const c = this.c;
    const dt = c.dt;
    for (const b of this.balls) {
      if (b.state === 'dropping') this.advanceDropping(b, dt);
      else {
        const landed = advanceBall(b, dt, c);
        if (landed > 0)
          this.events.push({
            t: this.time + dt,
            type: 'land',
            ball: b.n,
            speed: landed,
            x: b.p.x,
            y: b.p.y,
          });
      }
    }
    let pass = 0;
    for (; pass < c.maxCollisionPasses; pass++) {
      const ct = this.earliestContact(dt);
      if (!ct) break;
      this.resolve(ct);
    }
    this.maxPasses = Math.max(this.maxPasses, pass);
    this.separateOverlaps();
    this.checkPockets();
    this.checkOffTable();
    this.time += dt;
    this.steps++;
  }

  private onTable(b: Ball) {
    return (
      b.state !== 'pocketed' && b.state !== 'dropping' && b.state !== 'offTable'
    );
  }

  /**
   * Bán kính tiếp xúc ngang giữa tâm bi và mũi băng / mũi lỗ khi bi nâng lên độ cao h.
   * Mũi băng cao hc: bi nâng ≥ hc thì BAY QUA băng (0); thấp hơn thì chạm ở độ cao nhỏ hơn
   * đường kính nên bán kính tiếp xúc ngang co lại. h = 0 -> đúng R (không đổi hành vi cũ).
   */
  private reach(h: number): number {
    const R = this.c.ballRadius;
    if (h <= 0) return R;
    const hc = this.c.cushionHeight;
    if (h >= hc) return 0;
    const dz = R + h - hc;
    const r2 = R * R - dz * dz;
    if (r2 <= 0) return 0;
    const d0 = R - hc;
    return R * Math.sqrt(r2 / (R * R - d0 * d0));
  }

  private earliestContact(dt: number): Contact | null {
    const { balls, c } = this;
    const R = c.ballRadius;
    const D2 = 4 * R * R;
    let best: Contact | null = null;
    const n = balls.length;
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      if (!this.onTable(a)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (!this.onTable(b)) continue;
        if (a.state === 'stationary' && b.state === 'stationary') continue;
        const dx = b.p.x - a.p.x;
        const dy = b.p.y - a.p.y;
        const dz = b.h - a.h; // bi bay cao hơn 2R thì không chạm (nhảy qua bi)
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= D2) continue;
        const dvx = b.v.x - a.v.x;
        const dvy = b.v.y - a.v.y;
        const dvz = b.vz - a.vz;
        if (dx * dvx + dy * dvy + dz * dvz >= 0) continue;
        const A = dvx * dvx + dvy * dvy + dvz * dvz;
        let s = 0;
        if (A > 1e-14) {
          const B = -2 * (dx * dvx + dy * dvy + dz * dvz);
          const C = d2 - D2;
          // Nghiệm dương duy nhất của |d − Δv·s| = 2R (thời gian lùi về lúc vừa chạm)
          s = (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
        }
        s = Math.max(0, Math.min(dt, s));
        if (!best || s > best.s) best = { kind: 'ball', i, j, s };
      }
    }
    const hx = this.table.L / 2 - this.nearRail;
    const hy = this.table.W / 2 - this.nearRail;
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (!this.onTable(b) || b.state === 'stationary') continue;
      if (Math.abs(b.p.x) < hx && Math.abs(b.p.y) < hy) continue;
      const reach = this.reach(b.h);
      if (reach <= 0) continue; // đã bay qua mũi băng
      for (const seg of this.table.segments) {
        const q = closestOnSegment(seg, b.p.x, b.p.y);
        const qx = q.x - b.p.x;
        const qy = q.y - b.p.y;
        const dist = dlen(qx, qy);
        if (dist >= reach || dist === 0) continue;
        const ox = qx / dist;
        const oy = qy / dist;
        const vn = b.v.x * ox + b.v.y * oy;
        if (vn <= 0) continue;
        const s = Math.max(0, Math.min(dt, (reach - dist) / vn));
        if (!best || s > best.s)
          best = { kind: 'cushion', i, ox, oy, s, part: seg.kind };
      }
      for (const nz of this.table.noses) {
        const qx = nz.x - b.p.x;
        const qy = nz.y - b.p.y;
        const dist = dlen(qx, qy);
        const lim = reach + nz.r;
        if (dist >= lim || dist === 0) continue;
        const ox = qx / dist;
        const oy = qy / dist;
        const vn = b.v.x * ox + b.v.y * oy;
        if (vn <= 0) continue;
        const s = Math.max(0, Math.min(dt, (lim - dist) / vn));
        if (!best || s > best.s)
          best = { kind: 'cushion', i, ox, oy, s, part: 'nose' };
      }
    }
    return best;
  }

  private resolve(ct: Contact): void {
    const { balls, c } = this;
    const t = this.time + c.dt - ct.s;
    if (ct.kind === 'ball') {
      const a = balls[ct.i];
      const b = balls[ct.j];
      a.p.x -= a.v.x * ct.s;
      a.p.y -= a.v.y * ct.s;
      b.p.x -= b.v.x * ct.s;
      b.p.y -= b.v.y * ct.s;
      const speed = resolveBallBall(a, b, c);
      const ex = (a.p.x + b.p.x) / 2;
      const ey = (a.p.y + b.p.y) / 2;
      a.p.x += a.v.x * ct.s;
      a.p.y += a.v.y * ct.s;
      b.p.x += b.v.x * ct.s;
      b.p.y += b.v.y * ct.s;
      classify(a, c);
      classify(b, c);
      if (speed > 0) {
        this.events.push({
          t,
          type: 'ball',
          a: a.n,
          b: b.n,
          speed,
          x: ex,
          y: ey,
        });
        if (this.firstHit === null && (a.n === 0 || b.n === 0))
          this.firstHit = a.n === 0 ? b.n : a.n;
      }
      return;
    }
    const b = balls[ct.i];
    b.p.x -= b.v.x * ct.s;
    b.p.y -= b.v.y * ct.s;
    const e = ct.part === 'rail' ? undefined : c.jawRestitution;
    const speed = resolveBallCushion(b, ct.ox, ct.oy, c, e);
    const ex = b.p.x;
    const ey = b.p.y;
    b.p.x += b.v.x * ct.s;
    b.p.y += b.v.y * ct.s;
    classify(b, c);
    if (speed > 0) this.cushionEvent(b, speed, ct.part, ex, ey, t);
  }

  private cushionEvent(
    b: Ball,
    speed: number,
    part: CushionPart,
    x: number,
    y: number,
    t: number,
  ) {
    this.events.push({ t, type: 'cushion', ball: b.n, speed, part, x, y });
    if (b.n !== 0) this.objectCushion.add(b.n);
    if (this.firstHit !== null) this.cushionAfter.add(b.n);
  }

  /** Bi đang rơi: bay ngang không ma sát, tụt theo ½·g·t², có thể đập thành sau lỗ */
  private advanceDropping(b: Ball, dt: number) {
    const c = this.c;
    const R = c.ballRadius;
    const pk = this.table.pockets[b.pocket];
    b.p.x += b.v.x * dt;
    b.p.y += b.v.y * dt;
    b.dropTime += dt;
    b.z = 0.5 * c.gravity * b.dropTime * b.dropTime;
    // Họng lỗ: mặt vát & mũi lỗ kéo dài xuống dưới — bi đang rơi (chưa tụt sâu) vẫn đập vào
    // và có thể bị hất ngược ra. Bi nhanh đi chéo tới mặt vát xa trước khi kịp tụt xuống.
    if (b.z < R) {
      for (const seg of this.table.segments) {
        if (seg.kind !== 'jaw') continue;
        const q = closestOnSegment(seg, b.p.x, b.p.y);
        this.dropContact(b, q.x, q.y, R, dt);
      }
      for (const nz of this.table.noses)
        if (nz.pocket === pk.id) this.dropContact(b, nz.x, nz.y, R + nz.r, dt);
    }
    let dx = b.p.x - pk.x;
    let dy = b.p.y - pk.y;
    let d = dlen(dx, dy);
    if (d > 0) {
      const nx = dx / d;
      const ny = dy / d;
      const vr = b.v.x * nx + b.v.y * ny;
      // Thành sau lỗ: phần hố phía xa mặt bàn
      const back = dx * pk.axisX + dy * pk.axisY > -0.3 * pk.r;
      if (back && d + R > pk.backR && vr > 0) {
        b.v.x -= (1 + c.backRestitution) * vr * nx;
        b.v.y -= (1 + c.backRestitution) * vr * ny;
        b.v.x *= 0.85;
        b.v.y *= 0.85;
        this.cushionEvent(b, vr, 'back', b.p.x, b.p.y, this.time + dt);
      }
    }
    dx = b.p.x - pk.x;
    dy = b.p.y - pk.y;
    d = dlen(dx, dy);
    if (d > pk.r) {
      // Chỉ bật ra được qua phía miệng lỗ (hướng về mặt bàn), các phía khác là thành lỗ
      const towardTable = dx * pk.axisX + dy * pk.axisY < -0.5 * pk.r;
      if (towardTable && b.z < c.dropEscapeDepth * R) {
        // Bị hất ra khỏi hố khi chưa tụt sâu: trở lại mặt bàn
        b.state = 'sliding';
        b.pocket = -1;
        b.dropTime = 0;
        b.z = 0;
        classify(b, c);
        return;
      }
      // Đã tụt sâu: mép hố giữ bi lại
      const nx = dx / d;
      const ny = dy / d;
      b.p.x = pk.x + nx * pk.r * 0.999;
      b.p.y = pk.y + ny * pk.r * 0.999;
      const vr = b.v.x * nx + b.v.y * ny;
      if (vr > 0) {
        b.v.x -= 1.5 * vr * nx;
        b.v.y -= 1.5 * vr * ny;
      }
    }
    if (b.z >= R) {
      const speed = dlen(b.v.x, b.v.y);
      b.state = 'pocketed';
      b.v.x = b.v.y = 0;
      b.w.x = b.w.y = b.w.z = 0;
      this.pocketed.push({ ball: b.n, pocket: b.pocket });
      this.events.push({
        t: this.time + dt,
        type: 'pocket',
        ball: b.n,
        pocket: b.pocket,
        speed,
        x: b.p.x,
        y: b.p.y,
      });
    }
  }

  /** Va chạm của bi đang rơi với thành họng lỗ (điểm gần nhất qx, qy, khoảng cách tiếp xúc lim) */
  private dropContact(
    b: Ball,
    qx: number,
    qy: number,
    lim: number,
    dt: number,
  ) {
    const ox = qx - b.p.x;
    const oy = qy - b.p.y;
    const dist = dlen(ox, oy);
    if (dist >= lim || dist === 0) return;
    const nx = ox / dist;
    const ny = oy / dist;
    // Đẩy ra khỏi thành
    b.p.x -= nx * (lim - dist);
    b.p.y -= ny * (lim - dist);
    const speed = resolveBallCushion(b, nx, ny, this.c, this.c.jawRestitution);
    if (speed > 0)
      this.cushionEvent(
        b,
        speed,
        lim > this.c.ballRadius ? 'nose' : 'jaw',
        b.p.x,
        b.p.y,
        this.time + dt,
      );
  }

  /** Sửa chồng lấn còn sót (sai số làm tròn) — chỉ dời vị trí */
  private separateOverlaps(): void {
    const { balls, c } = this;
    const R = c.ballRadius;
    const n = balls.length;
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      if (!this.onTable(a)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (!this.onTable(b)) continue;
        if (a.state === 'stationary' && b.state === 'stationary') continue;
        // Bi đang bay: va chạm 3D đã xử lý ở earliestContact, không dời vị trí ngang
        if (a.state === 'airborne' || b.state === 'airborne') continue;
        const dx = b.p.x - a.p.x;
        const dy = b.p.y - a.p.y;
        const d = dlen(dx, dy);
        const ov = 2 * R - d;
        if (ov <= 1e-12 || d === 0) continue;
        const k = ov / 2 / d;
        a.p.x -= dx * k;
        a.p.y -= dy * k;
        b.p.x += dx * k;
        b.p.y += dy * k;
      }
    }
    const hx = this.table.L / 2 - this.nearRail;
    const hy = this.table.W / 2 - this.nearRail;
    for (const b of balls) {
      if (!this.onTable(b)) continue;
      if (Math.abs(b.p.x) < hx && Math.abs(b.p.y) < hy) continue;
      const rr = this.reach(b.h);
      if (rr <= 0) continue;
      for (const seg of this.table.segments) {
        const q = closestOnSegment(seg, b.p.x, b.p.y);
        const dx = b.p.x - q.x;
        const dy = b.p.y - q.y;
        const d = dlen(dx, dy);
        if (d > 0 && d < rr - 1e-12) {
          b.p.x = q.x + (dx / d) * rr;
          b.p.y = q.y + (dy / d) * rr;
        }
      }
      for (const nz of this.table.noses) {
        const dx = b.p.x - nz.x;
        const dy = b.p.y - nz.y;
        const d = dlen(dx, dy);
        const lim = rr + nz.r;
        if (d > 0 && d < lim - 1e-12) {
          b.p.x = nz.x + (dx / d) * lim;
          b.p.y = nz.y + (dy / d) * lim;
        }
      }
    }
  }

  /** Tâm bi vượt qua mép hố -> bắt đầu rơi */
  private checkPockets(): void {
    const { L, W, pockets } = this.table;
    for (const b of this.balls) {
      if (!this.onTable(b)) continue;
      // Bi đang bay cao hơn 1 bán kính bay qua miệng lỗ, chưa rơi
      if (b.state === 'airborne' && b.h > this.c.ballRadius) continue;
      let hit = -1;
      for (const pk of pockets) {
        const dx = b.p.x - pk.x;
        const dy = b.p.y - pk.y;
        if (dx * dx + dy * dy < pk.r * pk.r) {
          hit = pk.id;
          break;
        }
      }
      // Lưới an toàn: bi lọt hẳn ra ngoài khung băng thì tính vào lỗ gần nhất (chỉ bi lăn trên bàn)
      if (
        hit < 0 &&
        b.state !== 'airborne' &&
        (Math.abs(b.p.x) > L / 2 + 0.1 || Math.abs(b.p.y) > W / 2 + 0.1)
      ) {
        let bd = Infinity;
        for (const pk of pockets) {
          const d = dlen(b.p.x - pk.x, b.p.y - pk.y);
          if (d < bd) {
            bd = d;
            hit = pk.id;
          }
        }
        b.p.x = pockets[hit].x;
        b.p.y = pockets[hit].y;
      }
      if (hit >= 0) {
        b.h = 0;
        b.vz = 0;
        b.state = 'dropping';
        b.pocket = hit;
        b.dropTime = 0;
        b.z = 0;
      }
    }
  }

  /**
   * BI VĂNG KHỎI BÀN: tâm bi vượt qua đường mũi băng mà không phải vào lỗ (bay qua băng).
   * Bi bị loại khỏi ván (luật: lỗi; bi 9 / bi 8 xử lý riêng ở trọng tài).
   */
  private checkOffTable(): void {
    const { L, W, pockets } = this.table;
    for (const b of this.balls) {
      if (
        b.state !== 'airborne' &&
        b.state !== 'sliding' &&
        b.state !== 'rolling' &&
        b.state !== 'spinning'
      )
        continue;
      if (Math.abs(b.p.x) <= L / 2 && Math.abs(b.p.y) <= W / 2) continue;
      // Còn trong vùng miệng lỗ -> để cơ chế rơi lỗ xử lý
      let nearPocket = false;
      for (const pk of pockets) {
        const d = dlen(b.p.x - pk.x, b.p.y - pk.y);
        if (d < pk.backR + this.c.ballRadius) nearPocket = true;
      }
      if (nearPocket) continue;
      this.events.push({
        t: this.time + this.c.dt,
        type: 'offtable',
        ball: b.n,
        x: b.p.x,
        y: b.p.y,
        vx: b.v.x,
        vy: b.v.y,
        vz: b.vz,
        h: b.h,
      });
      b.state = 'offTable';
      b.v.x = b.v.y = b.vz = 0;
      b.w.x = b.w.y = b.w.z = 0;
      b.h = 0;
      this.offTable.push(b.n);
    }
  }

  result(): ShotResult {
    const final = this.balls
      .filter((b) => b.state !== 'pocketed' && b.state !== 'offTable')
      .map((b) => ({ n: b.n, x: b.p.x, y: b.p.y }));
    return {
      firstHit: this.firstHit,
      pocketed: this.pocketed.slice(),
      cushionAfterContact: Array.from(this.cushionAfter).sort((a, b) => a - b),
      objectBallsToCushion: Array.from(this.objectCushion).sort(
        (a, b) => a - b,
      ),
      offTable: this.offTable.slice(),
      scratch: this.pocketed.some((p) => p.ball === 0),
      miscue: this.miscue,
      final,
      duration: this.time,
    };
  }

  writeFrame(out: number[]): void {
    for (const b of this.balls) {
      const status =
        b.state === 'pocketed'
          ? b.pocket + 1
          : b.state === 'offTable'
            ? 100
            : 0;
      // z > 0: độ tụt xuống lỗ; z < 0: độ cao khi bay
      out.push(
        b.p.x,
        b.p.y,
        b.w.x,
        b.w.y,
        b.w.z,
        status,
        b.state === 'airborne' ? -b.h : b.z,
      );
    }
  }
}

export interface SimulateOptions {
  record?: boolean;
  config?: PoolConfig;
  table?: TableGeometry;
  maxTime?: number;
}

/** Mô phỏng trọn 1 cú đánh tới khi mọi bi dừng hẳn */
export function simulateShot(
  spots: BallSpot[],
  cmd: ShotCommand,
  opts: SimulateOptions = {},
): ShotTrace {
  const c = opts.config ?? POOL_PHYSICS;
  const sim = new PoolSim(spots, c, opts.table);
  sim.strike(cmd);
  const initialEnergy = kineticEnergy(sim.balls, c);
  const frames: number[] = [];
  const every = 1 / c.frameRate;
  let next = every;
  if (opts.record) sim.writeFrame(frames);
  const maxTime = opts.maxTime ?? c.maxSimTime;
  while (sim.isMoving() && sim.time < maxTime) {
    sim.step();
    if (opts.record && sim.time >= next) {
      next += every;
      sim.writeFrame(frames);
    }
  }
  for (const b of sim.balls) {
    if (b.state === 'dropping') {
      b.state = 'pocketed';
      sim.pocketed.push({ ball: b.n, pocket: b.pocket });
    } else if (b.state !== 'pocketed' && b.state !== 'offTable') {
      b.h = 0;
      b.vz = 0;
      b.v.x = b.v.y = 0;
      b.w.x = b.w.y = b.w.z = 0;
      b.state = 'stationary';
    }
  }
  if (opts.record) sim.writeFrame(frames);
  const result = sim.result();
  return {
    result,
    events: sim.events,
    ballIds: sim.balls.map((b) => b.n),
    fps: c.frameRate,
    frameCount: frames.length / (FRAME_STRIDE * sim.balls.length),
    frames: new Float32Array(frames),
    stats: {
      steps: sim.steps,
      maxPasses: sim.maxPasses,
      initialEnergy,
      finalEnergy: kineticEnergy(sim.balls, c),
    },
    hash: stateHash(result.final, result.pocketed),
  };
}
