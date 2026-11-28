import { SacMauRoomService } from './sacmau-room.service';

const mk = (bots = 2) => {
  const svc = new SacMauRoomService();
  let seed = 9;
  svc.rng = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const room = svc.create({ userId: 'a', name: 'An', socketId: 's1' });
  svc.addPlayer(room, { userId: 'b', name: 'Bình', socketId: 's2' });
  for (let i = 0; i < bots; i++) svc.addBot(room, 'hard');
  return { svc, room };
};

describe('SacMauRoomService', () => {
  it('chia 7 lá mỗi người, mỗi người chỉ thấy bài của mình', () => {
    const { svc, room } = mk();
    svc.startGame(room);
    const s = room.match!.state;
    expect(s.hands.map((h) => h.length)).toEqual([7, 7, 7, 7]);
    const snap = svc.snapshotFor(room, 'a')!;
    expect(snap.hand).toEqual(s.hands[0]);
    expect(snap.counts).toEqual([7, 7, 7, 7]);
    expect(snap.revealed).toBeNull();
    expect(JSON.stringify(snap)).not.toContain(JSON.stringify(s.hands[1]));
  });

  it('máy / hết giờ đánh thay tới hết ván; điểm tổng bằng 0; người thắng đi trước ván sau', () => {
    const { svc, room } = mk();
    for (let g = 0; g < 8; g++) {
      svc.startGame(room);
      let guard = 0;
      while (room.status === 'playing' && guard++ < 3000)
        svc.autoAct(room, svc.turnIsBot(room));
      expect(room.status).toBe('finished');
      const total = Object.values(room.scores).reduce((x, y) => x + y, 0);
      expect(total).toBe(0);
      const winner = room.lastWinner!;
      svc.startGame(room);
      expect(room.match!.players[room.match!.state.turn]).toBe(winner);
      while (room.status === 'playing') svc.autoAct(room, true);
    }
  });

  it('cài đặt cộng dồn được áp vào ván', () => {
    const { svc, room } = mk();
    svc.updateSettings(room, { stack: false });
    svc.startGame(room);
    expect(room.match!.state.settings.stack).toBe(false);
  });

  it('người rời giữa ván -> máy đánh thay; sai lượt bị từ chối', () => {
    const { svc, room } = mk();
    svc.startGame(room);
    const turnUser = room.match!.players[room.match!.state.turn];
    const other = ['a', 'b'].find((u) => u !== turnUser) ?? 'a';
    if (!turnUser.startsWith('bot:'))
      expect(svc.act(room, other, { kind: 'draw' }).ok).toBe(false);
    svc.replaceWithBot(room, 'b');
    expect(room.match!.bots[1]).toBe('normal');
    expect(svc.removeUser(room, 'b')).toBe(false);
    expect(svc.removeUser(room, 'a')).toBe(true);
  });
});
