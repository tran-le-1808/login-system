import { TienLenRoomService } from './tienlen-room.service';

const mk = (bots = 2) => {
  const svc = new TienLenRoomService();
  let seed = 42;
  svc.rng = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const room = svc.create({ userId: 'a', name: 'An', socketId: 's1' });
  svc.addPlayer(room, { userId: 'b', name: 'Bình', socketId: 's2' });
  for (let i = 0; i < bots; i++) svc.addBot(room, 'hard');
  return { svc, room };
};

describe('TienLenRoomService', () => {
  it('chia 13 lá mỗi người, ván đầu người có lá nhỏ nhất đi trước', () => {
    const { svc, room } = mk();
    svc.startGame(room);
    const s = room.match!.state;
    expect(s.hands.map((h) => h.length)).toEqual([13, 13, 13, 13]);
    if (!s.instant) expect(s.hands[s.turn]).toContain(0);
  });

  it('mỗi người chỉ thấy bài của mình', () => {
    const { svc, room } = mk();
    svc.startGame(room);
    const snap = svc.snapshotFor(room, 'a')!;
    expect(snap.hand).toEqual(room.match!.state.hands[0]);
    expect(snap.counts).toEqual([13, 13, 13, 13]);
    expect(JSON.stringify(snap)).not.toContain(
      JSON.stringify(room.match!.state.hands[1]),
    );
    expect(snap.revealed).toBeNull();
  });

  it('cả bàn do máy / hết giờ đánh thay tới hết ván; điểm cộng dồn tổng bằng 0; ván sau người nhất đi trước', () => {
    const { svc, room } = mk();
    for (let g = 0; g < 5; g++) {
      svc.startGame(room);
      let guard = 0;
      while (room.status === 'playing' && guard++ < 500)
        svc.autoAct(room, svc.turnIsBot(room));
      expect(room.status).toBe('finished');
      const total = Object.values(room.scores).reduce((a, b) => a + b, 0);
      expect(total).toBe(0);
      const winner = room.lastWinner!;
      svc.startGame(room);
      const s = room.match!.state;
      if (!s.instant) expect(room.match!.players[s.turn]).toBe(winner);
      while (room.status === 'playing') svc.autoAct(room, true);
    }
  });

  it('người rời giữa ván -> máy đánh thay; phòng chỉ còn máy thì bị xoá', () => {
    const { svc, room } = mk();
    svc.startGame(room);
    svc.replaceWithBot(room, 'b');
    expect(room.match!.bots[1]).toBe('normal');
    expect(svc.removeUser(room, 'b')).toBe(false);
    expect(svc.removeUser(room, 'a')).toBe(true);
    expect(svc.get(room.code)).toBeUndefined();
  });

  it('đánh sai lượt / sai luật bị từ chối', () => {
    const { svc, room } = mk(0);
    svc.startGame(room);
    const s = room.match!.state;
    if (s.instant) return;
    const other = room.match!.players[1 - s.turn];
    expect(svc.act(room, other, { kind: 'pass' }).ok).toBe(false);
    const me = room.match!.players[s.turn];
    const r = svc.act(room, me, { kind: 'play', cards: [51] });
    expect(r.ok).toBe(false);
  });
});
