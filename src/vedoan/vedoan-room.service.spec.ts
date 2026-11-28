import { VeDoanRoomService } from './vedoan-room.service';

const user = (id: string) => ({ userId: id, name: id, socketId: null });

describe('VeDoanRoomService', () => {
  let svc: VeDoanRoomService;
  let t = 0;
  beforeEach(() => {
    svc = new VeDoanRoomService();
    t = 1_000_000;
    svc.now = () => t;
  });

  function started(ids = ['a', 'b', 'c'], rounds = 2) {
    const room = svc.create(user(ids[0]), { rounds, drawSeconds: 60 });
    ids.slice(1).forEach((id) => svc.addPlayer(room, user(id)));
    expect(svc.startGame(room)).toBe(true);
    return room;
  }

  it('cần ít nhất 2 người; người đầu tiên chọn 1 trong 3 từ', () => {
    const solo = svc.create(user('x'));
    expect(svc.startGame(solo)).toBe(false);
    const room = started();
    const turn = room.match!.turn;
    expect(turn.drawer).toBe('a');
    expect(turn.choices).toHaveLength(3);
    expect(svc.snapshotFor(room, 'a')!.choices).toHaveLength(3);
    expect(svc.snapshotFor(room, 'b')!.choices).toEqual([]);
    expect(svc.choose(room, 'b', 0).ok).toBe(false);
    expect(svc.choose(room, 'a', 1).ok).toBe(true);
    expect(turn.word).toBe(turn.choices[1]);
  });

  it('đáp án chỉ người vẽ & người đoán đúng thấy; điểm theo tốc độ; ai cũng đoán xong thì công bố', () => {
    const room = started();
    svc.choose(room, 'a', 0);
    const word = room.match!.turn.word!;
    expect(svc.snapshotFor(room, 'a')!.word).toBe(word);
    expect(svc.snapshotFor(room, 'b')!.word).toBeNull();
    expect(svc.snapshotFor(room, 'b')!.mask).toMatch(/^[_ ]+$/);
    expect(svc.guess(room, 'b', 'xyz hoàn toàn sai').kind).toBe('chat');
    expect(svc.guess(room, 'a', `là ${word} đó`).kind).toBe('blocked');
    t += 10_000;
    const r1 = svc.guess(room, 'b', word.toUpperCase());
    expect(r1.kind).toBe('correct');
    expect(svc.snapshotFor(room, 'b')!.word).toBe(word);
    expect(svc.guess(room, 'b', 'chat sau khi đoán').kind).toBe('guessed');
    t += 30_000;
    const r2 = svc.guess(room, 'c', word);
    expect(r2.kind === 'correct' && r2.ended).toBe(true);
    if (r1.kind === 'correct' && r2.kind === 'correct')
      expect(r1.points).toBeGreaterThan(r2.points);
    expect(room.match!.turn.phase).toBe('reveal');
    expect(room.match!.scores.a).toBe(250);
  });

  it('gợi ý chữ & hết giờ chuyển lượt; hết số vòng thì kết thúc', () => {
    const room = started(['a', 'b'], 2);
    let turns = 0;
    while (room.status === 'playing' && turns < 20) {
      const id = room.match!.turn.id;
      svc.expire(room, id); // chọn từ tự động
      expect(room.match!.turn.phase).toBe('draw');
      expect(svc.hint(room, id)).toBe(
        room.match!.turn.word!.replace(/ /g, '').length >= 3,
      );
      svc.expire(room, id); // hết giờ vẽ
      expect(room.match!.turn.phase).toBe('reveal');
      expect(svc.expire(room, id + 99)).toBe(false);
      svc.expire(room, id); // sang lượt kế
      turns++;
    }
    expect(turns).toBe(4); // 2 vòng × 2 người
    expect(room.status).toBe('finished');
    expect(svc.snapshotFor(room, 'a')!.phase).toBe('over');
  });

  it('nét vẽ: chỉ người vẽ, đúng lượt, hợp lệ', () => {
    const room = started();
    const id = room.match!.turn.id;
    const op = [{ k: 'l', g: 1, c: 1, s: 1, p: [0, 0, 100, 100] }];
    expect(svc.draw(room, 'a', op, id)).toBe('Chưa tới lúc vẽ');
    svc.choose(room, 'a', 0);
    expect(svc.draw(room, 'b', op, id)).toBe('Không phải lượt vẽ của bạn');
    expect(svc.draw(room, 'a', op, id + 1)).toBe('Lượt đã đổi');
    expect(svc.draw(room, 'a', [{ k: 'l', p: 'x' }], id)).toBe(
      'Nét vẽ không hợp lệ',
    );
    expect(Array.isArray(svc.draw(room, 'a', op, id))).toBe(true);
    expect(svc.opsFor(room)!.ops).toHaveLength(1);
  });

  it('người vẽ rời: kết thúc lượt; còn 1 người: kết thúc ván; người vào giữa ván được chơi', () => {
    const room = started();
    svc.choose(room, 'a', 0);
    svc.addPlayer(room, user('d'));
    expect(svc.snapshotFor(room, 'd')!.players.map((p) => p.userId)).toContain(
      'd',
    );
    svc.removeUser(room, 'a');
    expect(svc.onLeave(room, 'a')).toBe('turn');
    expect(room.match!.turn.phase).toBe('reveal');
    svc.removeUser(room, 'b');
    svc.removeUser(room, 'c');
    expect(svc.onLeave(room, 'c')).toBe('over');
    expect(room.status).toBe('finished');
  });

  it('từ tự nhập: chỉ dùng từ tự nhập khi bật và có ≥ 3 từ', () => {
    const room = svc.create(user('a'));
    svc.updateSettings(room, {
      customText: 'bánh mì, trà đá',
      onlyCustom: true,
    });
    expect(room.settings.onlyCustom).toBe(false);
    svc.updateSettings(room, {
      customText: 'bánh mì, trà đá, xe ôm, cà phê',
      onlyCustom: true,
    });
    expect(room.settings.onlyCustom).toBe(true);
    svc.addPlayer(room, user('b'));
    svc.startGame(room);
    expect(
      room.match!.turn.choices.every((w) =>
        room.settings.customWords.includes(w),
      ),
    ).toBe(true);
    expect(svc.toPublic(room).settings.customCount).toBe(4);
  });
});
