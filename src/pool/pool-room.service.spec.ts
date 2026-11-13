import { PoolRoomService } from './pool-room.service';
import type { Room } from './pool.types';
import type { BallSpot } from './shared/physics/types';
import { ballsHash, POOL_PROTOCOL_VERSION } from './shared/protocol';
import { POOL_TABLE } from './shared/physics/table';
import { liftShot } from './shared/physics/clearance';
import { configForPreset } from './shared/physics/config';
import { simulateShot } from './shared/physics/simulator';
import { shotCommandFromInput } from './shared/protocol';

const A = { userId: 'a', name: 'An', socketId: 's1' };
const B = { userId: 'b', name: 'Bình', socketId: 's2' };

function setup(type: 'eight' | 'nine' = 'nine') {
  const svc = new PoolRoomService();
  let now = 1_000_000;
  svc.now = () => now;
  const room: Room = svc.create(A, { type, shotClock: true });
  svc.addPlayer(room, B);
  const g = svc.startGame(room, 0); // ghế 0 (An) phá
  return { svc, room, g, tick: (ms: number) => (now += ms) };
}

/** Góc nâng cơ nhỏ nhất để cú đánh không vướng bi / băng (như người chơi thật nâng cơ khi cần) */
function freeElevation(balls: BallSpot[], aimAngle: number, base = 2) {
  const cmd = shotCommandFromInput({
    aimAngle,
    power: 0.5,
    tipX: 0,
    tipY: 0,
    elevation: base,
  });
  const lift = liftShot(balls, cmd, configForPreset('wpa'));
  return lift.clearance.ok ? base : (lift.clearance.minElevation ?? 80);
}

let n = 0;
function shot(room: Room, over: Record<string, unknown> = {}) {
  const g = room.game!;
  const balls = g.match.rack.balls;
  const cue = balls.find((b) => b.n === 0)!;
  const target = balls.find((b) => b.n !== 0)!;
  const aimAngle = Math.atan2(target.y - cue.y, target.x - cue.x);
  return {
    v: POOL_PROTOCOL_VERSION,
    seq: g.seq,
    shotId: `s${++n}`,
    aimAngle,
    power: 0.9,
    tipX: 0,
    tipY: 0,
    elevation: freeElevation(balls, aimAngle),
    clientStateHash: ballsHash(balls),
    ...over,
  };
}

describe('PoolRoomService — server có thẩm quyền', () => {
  it('từ chối SHOT sai lượt', () => {
    const { svc, room } = setup();
    const r = svc.shoot(room, 'b', shot(room));
    expect(r).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
  });

  it('từ chối lực vượt giới hạn / điểm chạm ngoài vùng / sai phiên bản giao thức', () => {
    const { svc, room } = setup();
    expect(svc.shoot(room, 'a', shot(room, { power: 1.5 }))).toMatchObject({
      ok: false,
      code: 'OUT_OF_RANGE',
    });
    expect(
      svc.shoot(room, 'a', shot(room, { tipX: 0.9, tipY: 0.9 })),
    ).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' });
    expect(svc.shoot(room, 'a', shot(room, { v: 99 }))).toMatchObject({
      ok: false,
      code: 'BAD_VERSION',
    });
    expect(svc.shoot(room, 'a', { foo: 1 })).toMatchObject({ ok: false });
  });

  it('từ chối seq cũ và hash trạng thái không khớp', () => {
    const { svc, room } = setup();
    expect(svc.shoot(room, 'a', shot(room, { seq: 0 }))).toMatchObject({
      ok: false,
      code: 'STALE_SEQ',
    });
    expect(
      svc.shoot(room, 'a', shot(room, { clientStateHash: 'deadbeef' })),
    ).toMatchObject({
      ok: false,
      code: 'STATE_MISMATCH',
    });
  });

  it('đặt bi cái chồng lên bi khác / ngoài kitchen -> từ chối; hợp lệ -> nhận', () => {
    const { svc, room } = setup();
    const g = room.game!;
    const ball = g.match.rack.balls.find((b) => b.n === 1)!;
    const place = (x: number, y: number) => ({
      v: POOL_PROTOCOL_VERSION,
      seq: g.seq,
      x,
      y,
    });
    expect(svc.placeCue(room, 'a', place(ball.x, ball.y))).toMatchObject({
      ok: false,
      code: 'INVALID_PLACEMENT',
    });
    expect(svc.placeCue(room, 'a', place(0.5, 0))).toMatchObject({
      ok: false,
      code: 'INVALID_PLACEMENT',
    });
    expect(svc.placeCue(room, 'b', place(-0.9, 0.1))).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    expect(svc.placeCue(room, 'a', place(-0.9, 0.1))).toMatchObject({
      ok: true,
    });
  });

  it('SHOT hợp lệ: server mô phỏng, tăng seq, gửi kết quả có hash; gửi lặp shotId -> bỏ qua', () => {
    const { svc, room } = setup();
    const s = shot(room);
    const r = svc.shoot(room, 'a', s);
    expect(r.ok).toBe(true);
    if (!r.ok || 'duplicate' in r) throw new Error('fail');
    expect(r.shot.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(r.shot.events.length).toBeGreaterThan(5);
    expect(room.game!.seq).toBe(2);
    expect(svc.shoot(room, 'a', s)).toEqual({ ok: true, duplicate: true });
  });

  it('không cho đánh khi bi chưa dừng hẳn', () => {
    const { svc, room } = setup();
    svc.shoot(room, 'a', shot(room));
    const g = room.game!;
    const actor = g.players[svc.actor(g)];
    expect(svc.shoot(room, actor, shot(room))).toMatchObject({
      ok: false,
      code: 'WRONG_PHASE',
    });
  });

  it('hết giờ -> lỗi, đối thủ có bi trong tay', () => {
    const { svc, room, tick } = setup('nine');
    const g = room.game!;
    // Cú phá: hết giờ -> đối thủ được quyền phá
    tick(61_000);
    expect(svc.timeout(room)).toBe(true);
    expect(g.match.rack.turn).toBe(1);
    // Đối thủ phá xong, tới lượt ai đó; để hết giờ -> lỗi, bi trong tay toàn bàn
    const r = svc.shoot(room, 'b', shot(room));
    expect(r.ok).toBe(true);
    tick(20_000);
    while (g.match.rack.decision) {
      const by = g.players[g.match.rack.decision.by];
      svc.option(room, by, {
        v: POOL_PROTOCOL_VERSION,
        seq: g.seq,
        choice: 'shoot',
      });
    }
    const before = g.match.rack.turn;
    tick(61_000);
    expect(svc.timeout(room)).toBe(true);
    expect(g.match.rack.turn).toBe(1 - before);
    expect(g.match.rack.ballInHand).toBe('table');
    expect(g.match.rack.fouls[before]).toBe(1);
  });

  it('mất kết nối: đồng hồ tạm dừng, kết nối lại được cộng bù', () => {
    const { svc, room, tick } = setup();
    const g = room.game!;
    const deadline = g.clock.deadline;
    svc.pauseClock(room);
    tick(20_000);
    expect(svc.timeout(room)).toBe(false);
    svc.resumeClock(room);
    expect(g.clock.deadline).toBe(deadline + 20_000);
  });

  it('chơi trọn trận chạm 1 qua service (bot đánh vào bi hợp lệ gần nhất)', () => {
    for (const type of ['eight', 'nine'] as const) {
      const { svc, room, tick } = setup(type);
      room.settings.raceTo = 1;
      room.game!.match.config.raceTo = 1;
      const g = room.game!;
      let guard = 0;
      while (g.match.matchWinner === null && guard++ < 400) {
        tick(30_000);
        const r = g.match.rack;
        if (r.decision) {
          const by = g.players[r.decision.by];
          const choice =
            r.decision.kind === 'pushOutResponse'
              ? 'shoot'
              : r.decision.kind === 'illegalBreak'
                ? 'acceptTable'
                : r.decision.kind === 'eightOnBreak'
                  ? 'spotAndContinue'
                  : 'spotWithBallInHand';
          expect(
            svc.option(room, by, {
              v: POOL_PROTOCOL_VERSION,
              seq: g.seq,
              choice,
            }),
          ).toMatchObject({ ok: true });
          continue;
        }
        const res = svc.shoot(
          room,
          g.players[r.turn],
          shot(room, { power: r.isBreak ? 0.9 : 0.35 }),
        );
        expect(res.ok).toBe(true);
      }
      expect(g.match.matchWinner).not.toBeNull();
      expect(room.status).toBe('finished');
      expect(g.replay[0].actions.length).toBeGreaterThan(0);
    }
  });

  it('cài đặt xếp hạng khoá preset WPA & tắt dự đoán đầy đủ', () => {
    const svc = new PoolRoomService();
    const room = svc.create(A, {
      ranked: true,
      pocketPreset: 'easy',
      allowFullGuide: true,
    });
    expect(room.settings.pocketPreset).toBe('wpa');
    expect(room.settings.allowFullGuide).toBe(false);
    expect(POOL_TABLE.pockets[0].mouth).toBeCloseTo(0.1143, 6);
  });

  it('cơ vướng thành băng / bi: server từ chối CUE_BLOCKED; vướng nhẹ thì tự nâng đuôi cơ (cùng kết quả client)', () => {
    const { svc, room } = setup('nine');
    const g = room.game!;
    // Bi cái sát băng đầu bàn, đánh ra xa băng bằng cơ nằm ngang -> thân cơ đè lên băng
    const r = g.match.rack;
    g.match = {
      ...g.match,
      rack: {
        ...r,
        balls: [{ n: 0, x: -0.9, y: 0 }, ...r.balls.filter((b) => b.n !== 0)],
      },
    };
    const wall: BallSpot = { n: 0, x: -POOL_TABLE.L / 2 + 0.05, y: 0 };
    g.match.rack.balls = [wall, ...g.match.rack.balls.filter((b) => b.n !== 0)];
    const blocked = svc.shoot(
      room,
      'a',
      shot(room, { aimAngle: 0, elevation: 0 }),
    );
    expect(blocked).toMatchObject({ ok: false, code: 'CUE_BLOCKED' });
    // Seq không đổi, chưa ghi nhận cú đánh
    expect(g.seq).toBe(1);

    // Giữa bàn: cơ hơi nâng đuôi qua băng -> chấp nhận, mô phỏng đúng với góc đã nâng
    g.match.rack.balls = [
      { n: 0, x: 0, y: 0 },
      ...g.match.rack.balls.filter((b) => b.n !== 0 && b.x > 0.3),
    ];
    const start = g.match.rack.balls;
    const input = shot(room, { aimAngle: 0, elevation: 0, power: 0.4 });
    const ok = svc.shoot(room, 'a', input);
    expect(ok.ok).toBe(true);
    if (!ok.ok || 'duplicate' in ok) throw new Error('fail');
    const cfg = configForPreset('wpa');
    const lifted = liftShot(start, shotCommandFromInput(input), cfg);
    expect(lifted.lifted).toBe(true);
    expect(ok.shot.hash).toBe(
      simulateShot(start, lifted.shot, { config: cfg }).hash,
    );
  });
});
