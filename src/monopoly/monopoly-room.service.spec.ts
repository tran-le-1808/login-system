import { MonopolyRoomService } from './monopoly-room.service';

const human = (id: string) => ({
  userId: id,
  name: id,
  socketId: `s-${id}`,
});

describe('MonopolyRoomService bots', () => {
  let svc: MonopolyRoomService;
  beforeEach(() => (svc = new MonopolyRoomService()));

  it('adds ready bots into free seats with unique names', () => {
    const room = svc.create(human('a'));
    const b1 = svc.addBot(room, 'hard');
    const b2 = svc.addBot(room, 'easy', 3);
    expect(b1).toMatchObject({ seat: 1, ready: true, botLevel: 'hard' });
    expect(b2?.seat).toBe(3);
    expect(b1?.name).not.toBe(b2?.name);
    expect(svc.toPublic(room).players.map((p) => p.botLevel)).toEqual([
      undefined,
      'hard',
      'easy',
    ]);
    svc.addBot(room, 'normal');
    expect(svc.addBot(room, 'normal')).toBeNull();
  });

  it('never makes a bot host and deletes the room when only bots remain', () => {
    const room = svc.create(human('a'));
    svc.addPlayer(room, human('b'));
    svc.addBot(room, 'normal');
    expect(svc.removePlayer(room, 'a')).toBe(false);
    expect(room.hostId).toBe('b');
    expect(svc.removePlayer(room, 'b')).toBe(true);
    expect(svc.get(room.code)).toBeUndefined();
  });

  it('keeps bots ready after returning to the lobby', () => {
    const room = svc.create(human('a'));
    svc.addPlayer(room, human('b'));
    svc.addBot(room, 'easy');
    room.players.forEach((p) => (p.ready = true));
    svc.resetToLobby(room);
    expect(room.players.map((p) => p.ready)).toEqual([false, false, true]);
  });
});
