import { PrisonRoomService } from './prison-room.service';

const U = (n: number) => ({ userId: `u${n}`, name: `User ${n}` });

function setup() {
  const svc = new PrisonRoomService();
  let now = 1_000;
  svc.now = () => (now += 10);
  const created = svc.create(U(1), 's1');
  if (!created.ok) throw new Error('create failed');
  return { svc, room: created.value };
}

describe('PrisonRoomService', () => {
  it('tạo phòng: host là người tạo, trạng thái WAITING, mã 6 ký tự', () => {
    const { room } = setup();
    expect(room.hostId).toBe('u1');
    expect(room.status).toBe('WAITING');
    expect(room.roomCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(room.members).toHaveLength(1);
  });

  it('không cho một người tạo / vào hai phòng cùng lúc', () => {
    const { svc, room } = setup();
    const again = svc.create(U(1), 's1b');
    expect(!again.ok && again.code).toBe('CONFLICT');
    expect(svc.create(U(2), 's2').ok).toBe(true);
    const join = svc.join(U(2), 's2', room.roomCode);
    expect(!join.ok && join.code).toBe('CONFLICT');
    expect(room.members).toHaveLength(1);
  });

  it('tối đa 4 người; người thứ 5 -> ROOM_FULL; vào lại không nhân bản', () => {
    const { svc, room } = setup();
    for (const n of [2, 3, 4])
      expect(svc.join(U(n), `s${n}`, room.roomCode).ok).toBe(true);
    const fifth = svc.join(U(5), 's5', room.roomCode);
    expect(fifth.ok).toBe(false);
    expect(!fifth.ok && fifth.code).toBe('ROOM_FULL');
    const rejoin = svc.join(U(2), 's2-new', room.roomCode);
    expect(rejoin.ok && rejoin.value.rejoined).toBe(true);
    expect(room.members).toHaveLength(4);
    expect(svc.member(room, 'u2')?.socketId).toBe('s2-new');
    // vai trò mặc định không trùng
    expect(new Set(room.members.map((m) => m.role)).size).toBe(4);
  });

  it('maxPlayers trong settings được tôn trọng', () => {
    const { svc, room } = setup();
    svc.updateSettings('u1', { maxPlayers: 2 });
    expect(svc.join(U(2), 's2', room.roomCode).ok).toBe(true);
    const r = svc.join(U(3), 's3', room.roomCode);
    expect(!r.ok && r.code).toBe('ROOM_FULL');
    const shrink = svc.updateSettings('u1', { maxPlayers: 1 });
    expect(shrink.ok).toBe(false);
  });

  it('trường settings undefined không ghi đè mặc định (DTO class)', () => {
    const svc = new PrisonRoomService();
    const r = svc.create(U(9), 's9', {
      maxPlayers: undefined,
      difficulty: 'HARD',
    });
    expect(r.ok && r.value.settings.maxPlayers).toBe(4);
    expect(r.ok && r.value.settings.difficulty).toBe('HARD');
  });

  it('phòng không tồn tại -> ROOM_NOT_FOUND', () => {
    const { svc } = setup();
    const r = svc.join(U(2), 's2', 'NOPE42');
    expect(!r.ok && r.code).toBe('ROOM_NOT_FOUND');
  });

  it('host rời -> chuyển host cho người đang kết nối vào sớm nhất; phòng trống -> CLOSED', () => {
    const { svc, room } = setup();
    svc.join(U(2), 's2', room.roomCode);
    svc.join(U(3), 's3', room.roomCode);
    svc.setConnected('u2', null, false);
    const res = svc.leave('u1');
    expect(res?.hostChanged).toBe(true);
    expect(room.hostId).toBe('u3');
    svc.leave('u2');
    const last = svc.leave('u3');
    expect(last?.closed).toBe(true);
    expect(svc.get(room.roomCode)).toBeUndefined();
    expect(svc.roomOf('u3')).toBeUndefined();
  });

  it('chỉ host được đổi cấu hình; đổi cấu hình reset ready', () => {
    const { svc, room } = setup();
    svc.join(U(2), 's2', room.roomCode);
    svc.setReady('u2', true);
    const notHost = svc.updateSettings('u2', { difficulty: 'HARD' });
    expect(!notHost.ok && notHost.code).toBe('FORBIDDEN');
    expect(svc.updateSettings('u1', { difficulty: 'HARD' }).ok).toBe(true);
    expect(room.settings.difficulty).toBe('HARD');
    expect(svc.member(room, 'u2')?.ready).toBe(false);
  });

  it('bắt đầu: chỉ host, mọi người khác phải sẵn sàng & đang kết nối; host chơi 1 mình được', () => {
    const { svc, room } = setup();
    expect(svc.startCheck(room, 'u1').ok).toBe(true);
    svc.join(U(2), 's2', room.roomCode);
    const notReady = svc.startCheck(room, 'u1');
    expect(!notReady.ok && notReady.code).toBe('INVALID_STATE');
    const notHost = svc.startCheck(room, 'u2');
    expect(!notHost.ok && notHost.code).toBe('FORBIDDEN');
    svc.setReady('u2', true);
    expect(svc.startCheck(room, 'u1').ok).toBe(true);
    svc.setConnected('u2', null, false);
    expect(svc.startCheck(room, 'u1').ok).toBe(false);
  });

  it('đang chơi: không vào được trừ khi allowLateJoin', () => {
    const { svc, room } = setup();
    svc.setStatus(room, 'PLAYING');
    const r = svc.join(U(2), 's2', room.roomCode);
    expect(!r.ok && r.code).toBe('INVALID_STATE');
    room.settings.allowLateJoin = true;
    const late = svc.join(U(2), 's2', room.roomCode);
    expect(late.ok && late.value.lateJoin).toBe(true);
    // ready / role bị khoá khi đang chơi
    expect(svc.setReady('u2', true).ok).toBe(false);
  });

  it('danh sách công khai bỏ phòng riêng tư và phòng đầy', () => {
    const { svc, room } = setup();
    const b = svc.create(U(2), 's2', { privateRoom: true });
    expect(b.ok).toBe(true);
    const list = svc.listPublic();
    expect(list.map((r) => r.roomCode)).toEqual([room.roomCode]);
  });
});
