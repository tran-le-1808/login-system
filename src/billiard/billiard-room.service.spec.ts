/// <reference types="jest" />
import {
  BilliardRoomService,
  type ShootOutcome,
} from './billiard-room.service';
import {
  checkCueClearance,
  DEFAULT_PHYSICS,
  judgeShot,
  sanitizeShot,
  simulateShot,
} from './physics';
import type { BilliardMatch, Room } from './billiard.types';

const matchOf = (o: ShootOutcome): BilliardMatch => {
  if (!('match' in o)) throw new Error(JSON.stringify(o));
  return o.match;
};
const errorOf = (o: ShootOutcome) => ('error' in o ? o.error : null);

let seq = 0;
const id = () => `shot-${++seq}`;

function setup(): { svc: BilliardRoomService; room: Room } {
  const svc = new BilliardRoomService();
  const room = svc.create({ userId: 'A', name: 'An', socketId: 's1' });
  svc.addPlayer(room, { userId: 'B', name: 'Bình', socketId: 's2' });
  svc.startGame(room);
  return { svc, room };
}

/** Tìm hướng đánh ghi điểm phăng cho người đang có lượt */
function scoringDir(match: BilliardMatch) {
  const cue = match.turn as 0 | 1;
  for (let i = 0; i < 1440; i++) {
    const a = (i / 1440) * Math.PI * 2;
    const s = sanitizeShot(
      { dirX: Math.cos(a), dirY: Math.sin(a), power: 0.5, elevation: 8 },
      cue,
    );
    if (!checkCueClearance(match.balls, s, DEFAULT_PHYSICS).ok) continue;
    const r = simulateShot(match.balls, s, DEFAULT_PHYSICS);
    if (judgeShot(r.events, cue, { mode: 'free' }).scored)
      return { dirX: s.dirX, dirY: s.dirY, power: 0.5, elevation: 8 };
  }
  throw new Error('Không tìm được hướng ghi điểm');
}

/** Cú đánh chắc chắn trượt: đánh rất nhẹ ra xa các bi */
// Đánh rất nhẹ sang trái: phía sau bi trắng là bàn trống nên cơ không vướng
const missShot = { dirX: -1, dirY: 0, power: 0.02, elevation: 8 };

describe('Phòng bida — luồng trận đấu server-authoritative', () => {
  it('khai cuộc: 2 người, bi trắng (ghế 0) đánh trước, đúng cấu hình phòng', () => {
    const { room } = setup();
    const m = room.snapshot!;
    expect(room.status).toBe('playing');
    expect(m.players).toEqual(['A', 'B']);
    expect(m.turn).toBe(0);
    expect(m.scores).toEqual([0, 0]);
  });

  it('chỉ người có lượt được đánh; người ngoài phòng bị chặn', () => {
    const { svc, room } = setup();
    expect(
      errorOf(
        svc.shoot(room, 'B', { ...missShot, shotId: id(), expectedSeq: 0 }),
      ),
    ).toBe('Chưa tới lượt của bạn');
    expect(
      errorOf(
        svc.shoot(room, 'X', { ...missShot, shotId: id(), expectedSeq: 0 }),
      ),
    ).toBe('Chưa tới lượt của bạn');
  });

  it('server tự chấm điểm: ghi điểm thì đánh tiếp, trượt thì đổi lượt', () => {
    const { svc, room } = setup();
    const m0 = room.snapshot!;
    const m1 = matchOf(
      svc.shoot(room, 'A', { ...scoringDir(m0), shotId: id(), expectedSeq: 0 }),
    );
    expect(m1.scores).toEqual([1, 0]);
    expect(m1.turn).toBe(0);
    expect(m1.lastShot?.verdict.scored).toBe(true);
    expect(m1.lastShot?.frames.length).toBeGreaterThan(5);
    m1.busyUntil = 0;
    const m2 = matchOf(
      svc.shoot(room, 'A', { ...missShot, shotId: id(), expectedSeq: m1.seq }),
    );
    expect(m2.turn).toBe(1);
    expect(m2.stats[0]).toMatchObject({
      shots: 2,
      points: 1,
      bestRun: 1,
      currentRun: 0,
    });
  });

  it('client không thể tự gửi điểm / kết quả (các trường lạ bị bỏ qua)', () => {
    const { svc, room } = setup();
    const m = matchOf(
      svc.shoot(room, 'A', {
        ...missShot,
        shotId: id(),
        expectedSeq: 0,
        scored: true,
        scores: [99, 0],
      } as never),
    );
    expect(m.scores).toEqual([0, 0]);
  });

  it('gửi lặp cùng shotId: chỉ xử lý 1 lần', () => {
    const { svc, room } = setup();
    const sid = id();
    const m1 = matchOf(
      svc.shoot(room, 'A', { ...missShot, shotId: sid, expectedSeq: 0 }),
    );
    const seqAfter = m1.seq;
    const again = svc.shoot(room, 'A', {
      ...missShot,
      shotId: sid,
      expectedSeq: 0,
    });
    expect('duplicate' in again).toBe(true);
    expect(room.snapshot!.seq).toBe(seqAfter);
  });

  it('2 cú đánh gửi gần đồng thời: cú thứ hai bị từ chối (bi đang lăn / sai trạng thái)', () => {
    const { svc, room } = setup();
    const s1 = svc.shoot(room, 'A', {
      ...scoringDir(room.snapshot!),
      shotId: id(),
      expectedSeq: 0,
    });
    expect('match' in s1).toBe(true);
    const s2 = svc.shoot(room, 'A', {
      ...missShot,
      shotId: id(),
      expectedSeq: 0,
    });
    expect(errorOf(s2)).toBe('Trạng thái bàn đã thay đổi, hãy thử lại');
    const s3 = svc.shoot(room, 'A', {
      ...missShot,
      shotId: id(),
      expectedSeq: room.snapshot!.seq,
    });
    expect(errorOf(s3)).toBe('Bi vẫn đang lăn');
  });

  it('hết giờ lượt -> mất lượt; chưa tới hạn thì không', () => {
    const { svc, room } = setup();
    expect(svc.timeoutTurn(room)).toBe(false);
    room.snapshot!.turnDeadline = Date.now() - 1;
    expect(svc.timeoutTurn(room)).toBe(true);
    expect(room.snapshot!.turn).toBe(1);
  });

  it('đủ điểm thì thắng; trận kết thúc không nhận thêm cú đánh', () => {
    const { svc, room } = setup();
    const m = room.snapshot!;
    m.scores[0] = m.target - 1;
    const end = matchOf(
      svc.shoot(room, 'A', { ...scoringDir(m), shotId: id(), expectedSeq: 0 }),
    );
    expect(end.winner).toBe(0);
    expect(room.status).toBe('finished');
    expect(
      errorOf(
        svc.shoot(room, 'A', {
          ...missShot,
          shotId: id(),
          expectedSeq: end.seq,
        }),
      ),
    ).toBeTruthy();
  });

  it('cơ vướng băng (cơ nằm ngang sát băng) bị server từ chối, gợi ý góc nâng tối thiểu', () => {
    const { svc, room } = setup();
    const m = room.snapshot!;
    m.balls[0] = [-1.38, 0];
    const res = svc.shoot(room, 'A', {
      dirX: 1,
      dirY: 0,
      power: 0.3,
      elevation: 0,
      shotId: id(),
      expectedSeq: 0,
    });
    expect(errorOf(res)).toMatch(/vướng thành băng.*nâng cơ tối thiểu \d+/);
    const ok = svc.shoot(room, 'A', {
      dirX: 1,
      dirY: 0,
      power: 0.3,
      elevation: 60,
      shotId: id(),
      expectedSeq: 0,
    });
    expect('match' in ok).toBe(true);
  });

  it('rời trận -> người còn lại thắng', () => {
    const { svc, room } = setup();
    expect(svc.forfeit(room, 'B', 'Bình đã rời phòng')).toBe(true);
    expect(room.snapshot!.winner).toBe(0);
    expect(room.status).toBe('finished');
  });

  it('reconnect: trạng thái trận (bi, điểm, lượt) được giữ nguyên trên server', () => {
    const { svc, room } = setup();
    matchOf(
      svc.shoot(room, 'A', { ...missShot, shotId: id(), expectedSeq: 0 }),
    );
    const before = JSON.stringify(room.snapshot);
    const p = svc.findPlayer(room, 'A')!;
    p.connected = false;
    p.socketId = null;
    p.connected = true;
    p.socketId = 's9';
    expect(JSON.stringify(room.snapshot)).toBe(before);
  });

  it('payload bậy (NaN / Infinity / góc cơ ngoài 0–90°) bị TỪ CHỐI, trạng thái không đổi', () => {
    const { svc, room } = setup();
    const before = JSON.stringify(room.snapshot);
    const base = {
      dirX: -1,
      dirY: 0,
      power: 0.3,
      elevation: 8,
      expectedSeq: 0,
    };
    const bad: Record<string, unknown>[] = [
      { dirX: NaN },
      { dirY: Infinity },
      { dirX: 0, dirY: 0 },
      { power: 999 },
      { power: -0.1 },
      { elevation: -5 },
      { elevation: 90.5 },
      { elevation: NaN },
      { elevation: undefined },
      { tipX: -50 },
      { tipY: 'x' },
    ];
    for (const patch of bad) {
      const res = svc.shoot(room, 'A', { ...base, ...patch, shotId: id() });
      expect(errorOf(res)).toBeTruthy();
    }
    expect(JSON.stringify(room.snapshot)).toBe(before);
    // Biên hợp lệ 0° và 90° được chấp nhận (cơ không vướng ở hướng này)
    const ok = svc.shoot(room, 'A', { ...base, elevation: 90, shotId: id() });
    expect('match' in ok).toBe(true);
  });

  it('cài đặt phòng: đổi chế độ cập nhật điểm thắng mặc định, giá trị lạ bị bỏ qua', () => {
    const svc = new BilliardRoomService();
    const room = svc.create({ userId: 'A', name: 'An', socketId: 's1' });
    svc.updateSettings(room, { mode: 'three' });
    expect(room.settings).toMatchObject({ mode: 'three', target: 5 });
    svc.updateSettings(room, { target: 7 });
    expect(room.settings.target).toBe(5);
    svc.updateSettings(room, { guideline: false });
    expect(room.settings.guideline).toBe(false);
  });
});
