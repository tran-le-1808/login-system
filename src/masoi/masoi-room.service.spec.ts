import { MaSoiRoomService, parseAction } from './masoi-room.service';

const user = (id: string) => ({ userId: id, name: id, socketId: null });

describe('MaSoiRoomService', () => {
  let svc: MaSoiRoomService;
  beforeEach(() => {
    svc = new MaSoiRoomService();
    let t = 1000;
    svc.now = () => t++;
  });

  function started(n = 6) {
    const room = svc.create(user('h'));
    svc.addPlayer(room, user('p2'));
    while (room.players.length < n) svc.addBot(room, 'normal');
    expect(svc.startGame(room)).toBe(true);
    return room;
  }

  it('cần ít nhất 5 người; chia vai và hẹn giờ đêm 30 giây', () => {
    const room = svc.create(user('h'));
    svc.addBot(room, 'easy');
    expect(svc.startGame(room)).toBe(false);
    const r = started(6);
    expect(r.match!.state.phase).toBe('night');
    expect(r.match!.deadline - r.match!.startedAt).toBeGreaterThanOrEqual(
      30000,
    );
  });

  it('góc nhìn riêng: không thấy vai người khác (trừ đồng bọn Sói)', () => {
    const room = started(8);
    const m = room.match!;
    for (const id of ['h', 'p2']) {
      const seat = m.players.indexOf(id);
      const v = svc.snapshotFor(room, id)!;
      expect(v.myRole).toBe(m.state.roles[seat]);
      v.roles.forEach((r, i) => {
        if (i === seat) return;
        if (v.myRole === 'wolf' && m.state.roles[i] === 'wolf')
          expect(r).toBe('wolf');
        else expect(r).toBeNull();
      });
    }
  });

  it('kênh chat: đêm chỉ Sói nói (kênh Sói), người chết nói kênh riêng, ngày nói chung', () => {
    const room = started(8);
    const m = room.match!;
    const s = m.state;
    const wolf = s.roles.indexOf('wolf');
    const vill = s.roles.findIndex((r) => r !== 'wolf');
    m.players[wolf] = 'W';
    m.players[vill] = 'V';
    expect(svc.channelFor(room, 'W')).toBe('wolf');
    expect(svc.channelFor(room, 'V')).toBeNull();
    expect(svc.canRead(room, 'V', 'wolf')).toBe(false);
    expect(svc.canRead(room, 'W', 'wolf')).toBe(true);
    s.phase = 'day';
    expect(svc.channelFor(room, 'V')).toBe('all');
    s.alive[vill] = false;
    expect(svc.channelFor(room, 'V')).toBe('dead');
    expect(svc.canRead(room, 'W', 'dead')).toBe(false);
    expect(svc.canRead(room, 'V', 'wolf')).toBe(true);
  });

  it('hết giờ đêm thì sang giai đoạn kế; pid cũ không có tác dụng', () => {
    const room = started(6);
    const pid = room.match!.state.pid;
    expect(svc.expire(room, pid + 5)).toBe(false);
    expect(svc.expire(room, pid)).toBe(true);
    expect(room.match!.state.pid).toBeGreaterThan(pid);
  });

  it('chuẩn hoá hành động gửi lên', () => {
    expect(parseAction({ k: 'vote', target: 3 })).toEqual({
      k: 'vote',
      target: 3,
    });
    expect(parseAction({ k: 'claim', target: 1, wolf: 'yes' })).toEqual({
      k: 'claim',
      target: 1,
      wolf: false,
    });
    expect(parseAction({ k: 'hack' })).toBeNull();
    expect(parseAction({ k: 'kill', target: '1' })).toEqual({
      k: 'kill',
      target: -99,
    });
    const room = started(6);
    expect(svc.act(room, 'h', { k: 'vote', target: 0 })).toEqual({
      ok: false,
      error: 'Chưa tới lúc làm việc này',
    });
  });

  it('máy chơi hết ván (người rời -> máy thay)', () => {
    const room = started(7);
    svc.replaceWithBot(room, 'h');
    svc.replaceWithBot(room, 'p2');
    let guard = 0;
    while (room.status === 'playing' && guard++ < 3000) {
      const bots = svc.pendingBots(room);
      if (bots.length) svc.botStep(room, bots[0]);
      else svc.expire(room, room.match!.state.pid);
    }
    expect(room.status).toBe('finished');
    expect(room.match!.state.winner).not.toBeNull();
  });
});
