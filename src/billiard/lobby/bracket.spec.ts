/// <reference types="jest" />
import {
  champion,
  createBracket,
  readyMatches,
  reportWinner,
  roundName,
  seedOrder,
  seedPlayers,
  totalMatches,
} from './bracket';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

describe('Nhánh đấu loại trực tiếp', () => {
  it('8 người: tứ kết 4 trận, bán kết 2, chung kết 1 — tổng 7 trận', () => {
    const b = createBracket(ids(8));
    expect(b.rounds.map((r) => r.length)).toEqual([4, 2, 1]);
    expect(totalMatches(b)).toBe(7);
    expect(readyMatches(b)).toHaveLength(4);
    expect(roundName(0, 3)).toBe('Tứ kết');
    expect(roundName(2, 3)).toBe('Chung kết');
  });
  it('hạt giống chuẩn: 1 gặp 8, 2 gặp 7', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    const b = createBracket(ids(8));
    expect([b.rounds[0][0].playerA, b.rounds[0][0].playerB]).toEqual([
      'p1',
      'p8',
    ]);
  });
  it('bye khi số người không phải luỹ thừa của 2: hạt giống cao đi thẳng', () => {
    const b = createBracket(ids(5));
    expect(b.size).toBe(8);
    const byes = b.rounds[0].filter((m) => m.status === 'BYE');
    expect(byes).toHaveLength(3);
    expect(byes.map((m) => m.winner).sort()).toEqual(['p1', 'p2', 'p3']);
    // p2 & p3 gặp nhau ngay ở vòng 2 (cả hai được bye)
    expect(b.rounds[1].some((m) => m.status === 'READY')).toBe(true);
    expect(totalMatches(b)).toBe(4);
  });
  it('báo kết quả: người thắng đi tiếp, tạo trận kế, xác định vô địch', () => {
    const b = createBracket(ids(4));
    const [m1, m2] = b.rounds[0];
    const r1 = reportWinner(b, m1.id, m1.playerA!, [5, 2], 1);
    expect(r1.ok && r1.ready).toHaveLength(0);
    const r2 = reportWinner(b, m2.id, m2.playerB!, [3, 5], 2);
    expect(r2.ok && r2.ready.map((m) => m.id)).toEqual(['r1m0']);
    const final = b.rounds[1][0];
    expect([final.playerA, final.playerB]).toEqual([m1.playerA, m2.playerB]);
    const r3 = reportWinner(b, final.id, final.playerB!, [4, 5], 3);
    expect(r3.ok && r3.champion).toBe(m2.playerB);
    expect(champion(b)).toBe(m2.playerB);
  });
  it('không cho sửa kết quả: người thắng lạ, trận đã xong, trận chưa sẵn sàng', () => {
    const b = createBracket(ids(4));
    const m = b.rounds[0][0];
    expect(reportWinner(b, m.id, 'hacker', null, 1).ok).toBe(false);
    expect(reportWinner(b, m.id, m.playerA!, null, 1).ok).toBe(true);
    expect(reportWinner(b, m.id, m.playerB!, null, 2).ok).toBe(false);
    expect(reportWinner(b, 'r1m0', 'p1', null, 3).ok).toBe(false);
  });
  it('xếp hạt giống theo rating hoặc ngẫu nhiên', () => {
    const players = [
      { userId: 'a', rating: 900 },
      { userId: 'b', rating: 1500 },
      { userId: 'c', rating: 1200 },
    ];
    expect(seedPlayers(players, 'rating', Math.random)).toEqual([
      'b',
      'c',
      'a',
    ]);
    let x = 0;
    const rng = () => (x = (x * 9301 + 49297) % 233280) / 233280;
    expect(seedPlayers(players, 'random', rng).sort()).toEqual(['a', 'b', 'c']);
    expect(() => createBracket(['solo'])).toThrow();
  });
});
