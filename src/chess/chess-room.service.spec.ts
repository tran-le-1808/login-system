import { ChessRoomService } from './chess-room.service';
import { sq as idx } from './shared/rules';

const mk = () => {
  const svc = new ChessRoomService();
  let t = 1_000_000;
  svc.now = () => t;
  const room = svc.create({ userId: 'a', name: 'An', socketId: 's1' });
  svc.addPlayer(room, { userId: 'b', name: 'Bình', socketId: 's2' });
  svc.startGame(room);
  return {
    svc,
    room,
    advance: (ms: number) => (t += ms),
  };
};

describe('ChessRoomService', () => {
  it('ván đầu: ghế 0 cầm Trắng đi trước; sai lượt / sai luật bị từ chối', () => {
    const { svc, room } = mk();
    expect(room.match!.whiteSeat).toBe(0);
    expect(svc.move(room, 'b', { from: idx(4, 1), to: idx(4, 3) }).ok).toBe(
      false,
    );
    const bad = svc.move(room, 'a', { from: idx(0, 7), to: idx(1, 5) });
    expect(bad.ok).toBe(false);
    expect(svc.move(room, 'a', { from: idx(4, 6), to: idx(4, 4) }).ok).toBe(
      true,
    );
    expect(svc.turnSeat(room)).toBe(1);
  });

  it('đồng hồ: trừ thời gian đã nghĩ, hết giờ thì thua', () => {
    const { svc, room, advance } = mk();
    advance(30_000);
    svc.move(room, 'a', { from: idx(4, 6), to: idx(4, 4) });
    expect(room.match!.clocks[0]).toBe(10 * 60_000 - 30_000);
    advance(10 * 60_000);
    expect(svc.timeout(room)).toBe(true);
    expect(room.match!.winnerSeat).toBe(0);
    expect(room.score).toEqual([1, 0]);
  });

  it('tạm dừng đồng hồ khi mất kết nối không trừ thời gian', () => {
    const { svc, room, advance } = mk();
    advance(5_000);
    svc.pauseClock(room);
    advance(50_000);
    expect(svc.timeout(room)).toBe(false);
    svc.resumeClock(room);
    advance(1_000);
    svc.move(room, 'a', { from: idx(4, 6), to: idx(4, 4) });
    expect(room.match!.clocks[0]).toBe(10 * 60_000 - 6_000);
  });

  it('xin hoà: đối thủ đồng ý -> hoà; đi một nước -> lời xin hoà bị huỷ', () => {
    const { svc, room } = mk();
    expect(svc.offerDraw(room, 'a')).toEqual({ ok: true, agreed: false });
    // b đi một nước thay vì trả lời -> huỷ lời xin hoà của a
    svc.move(room, 'a', { from: idx(4, 6), to: idx(4, 4) });
    svc.move(room, 'b', { from: idx(4, 1), to: idx(4, 3) });
    expect(room.match!.drawOffer).toBeNull();
    svc.offerDraw(room, 'b');
    expect(svc.answerDraw(room, 'a', true)).toBe(true);
    expect(room.status).toBe('finished');
    expect(room.match!.winnerSeat).toBeNull();
    expect(svc.snapshot(room)!.draw).toBe(true);
  });

  it('ván sau đổi người cầm Trắng', () => {
    const { svc, room } = mk();
    svc.forfeit(room, 'a', 'An xin thua');
    svc.startGame(room);
    expect(room.match!.whiteSeat).toBe(1);
  });
});
