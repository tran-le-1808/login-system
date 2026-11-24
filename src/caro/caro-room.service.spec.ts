import { CaroRoomService } from './caro-room.service';

const user = (id: string) => ({
  userId: id,
  name: id.toUpperCase(),
  socketId: `s-${id}`,
});

function setup(rule: 'free' | 'block2' = 'block2') {
  const svc = new CaroRoomService();
  let t = 1_000_000;
  svc.now = () => t;
  const room = svc.create(user('a'), { rule, turnSeconds: 30 });
  svc.addPlayer(room, user('b'));
  svc.startGame(room);
  return { svc, room, advance: (ms: number) => (t += ms) };
}

describe('CaroRoomService', () => {
  it('ván 1: ghế 0 cầm X đi trước; đúng lượt mới được đi; ô đã có quân bị từ chối', () => {
    const { svc, room } = setup();
    expect(room.match!.xSeat).toBe(0);
    expect(svc.move(room, 'b', { x: 1, y: 1 })).toEqual({
      ok: false,
      error: 'Chưa tới lượt bạn',
    });
    expect(svc.move(room, 'a', { x: 1, y: 1 })).toEqual({ ok: true });
    expect(svc.move(room, 'b', { x: 1, y: 1 })).toEqual({
      ok: false,
      error: 'Ô này đã có quân',
    });
    expect(svc.move(room, 'b', { x: 25, y: 1 }).ok).toBe(false);
    expect(svc.move(room, 'b', { x: 2, y: 2, seq: 0 })).toEqual({
      ok: false,
      error: 'Bàn cờ đã thay đổi, hãy thử lại',
    });
    expect(svc.move(room, 'b', { x: 2, y: 2, seq: 1 })).toEqual({ ok: true });
  });

  it('5 quân liền -> thắng, cộng tỉ số; ván sau đổi người cầm X', () => {
    const { svc, room } = setup();
    for (let i = 0; i < 4; i++) {
      svc.move(room, 'a', { x: i, y: 0 });
      svc.move(room, 'b', { x: i, y: 5 });
    }
    svc.move(room, 'a', { x: 4, y: 0 });
    expect(room.status).toBe('finished');
    expect(room.match!.winnerSeat).toBe(0);
    expect(room.score).toEqual([1, 0]);
    expect(svc.snapshot(room)!.winLine).toHaveLength(5);
    svc.startGame(room);
    expect(room.match!.xSeat).toBe(1);
    expect(svc.move(room, 'b', { x: 9, y: 9 }).ok).toBe(true);
  });

  it('luật chặn 2 đầu: 5 quân bị chặn hai đầu không thắng', () => {
    const { svc, room } = setup('block2');
    // X: (3..7,5), O chặn (2,5) và (8,5)
    const xs = [
      [3, 5],
      [4, 5],
      [5, 5],
      [6, 5],
      [7, 5],
    ];
    const os = [
      [2, 5],
      [8, 5],
      [0, 0],
      [0, 2],
    ];
    for (let i = 0; i < 4; i++) {
      svc.move(room, 'a', { x: xs[i][0], y: xs[i][1] });
      svc.move(room, 'b', { x: os[i][0], y: os[i][1] });
    }
    svc.move(room, 'a', { x: 7, y: 5 });
    expect(room.status).toBe('playing');
  });

  it('hết giờ -> người đến lượt thua; mất kết nối thì đồng hồ dừng và cộng bù khi vào lại', () => {
    const { svc, room, advance } = setup();
    advance(10_000);
    svc.pauseClock(room);
    advance(40_000);
    expect(svc.timeout(room)).toBe(false);
    svc.resumeClock(room);
    advance(19_000);
    expect(svc.timeout(room)).toBe(false);
    advance(2_000);
    expect(svc.timeout(room)).toBe(true);
    expect(room.match!.winnerSeat).toBe(1);
    expect(room.match!.endReason).toContain('hết giờ');
  });

  it('xin thua; rời phòng khi còn người -> chuyển chủ phòng; phòng trống thì xoá', () => {
    const { svc, room } = setup();
    expect(svc.forfeit(room, 'a', 'A xin thua')).toBe(true);
    expect(room.match!.winnerSeat).toBe(1);
    expect(svc.removeUser(room, 'a')).toBe(false);
    expect(room.hostId).toBe('b');
    expect(svc.removeUser(room, 'b')).toBe(true);
    expect(svc.get(room.code)).toBeUndefined();
  });

  it('cài đặt được làm sạch; phòng ghép nhanh / riêng tư không hiện ở danh sách công khai', () => {
    const svc = new CaroRoomService();
    const r = svc.create(user('a'), { rule: 'xyz' as never, turnSeconds: 999 });
    expect(r.settings.rule).toBe('block2');
    expect(r.settings.turnSeconds).toBe(30);
    svc.updateSettings(r, { rule: 'free', turnSeconds: 15 });
    expect(r.settings).toMatchObject({ rule: 'free', turnSeconds: 15 });
    svc.create(user('b'), { quick: true });
    svc.create(user('c'), { isPrivate: true });
    expect(svc.listPublic().map((x) => x.code)).toEqual([r.code]);
  });
});
