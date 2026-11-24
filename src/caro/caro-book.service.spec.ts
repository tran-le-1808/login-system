import { CaroBookService, MemoryCaroBookStore } from './caro-book.service';
import { canonical, type Move } from './shared/book';

/** X thắng hàng ngang y=10 (x=5..9), O đi hàng y=12 */
const xWins: Move[] = [];
for (let i = 0; i < 5; i++) {
  xWins.push([5 + i, 10]);
  if (i < 4) xWins.push([5 + i, 12]);
}

describe('CaroBookService', () => {
  it('học ván thắng: nước của bên thắng điểm 1, bên thua 0; tra cứu trả về toạ độ thật', async () => {
    const book = new CaroBookService(new MemoryCaroBookStore());
    const r = await book.learnGame('free', xWins);
    expect(r).toEqual({ ok: true, learned: 9, winner: 1 });
    const first = await book.query('free', []);
    // bàn trống: nước đầu lưu theo toạ độ thật
    expect(first).toEqual([{ x: 5, y: 10, n: 1, score: 1 }]);
    const afterOne = await book.query('free', xWins.slice(0, 1));
    expect(afterOne[0]).toMatchObject({ n: 1, score: 0 });
    // nước O ở thế sau nước đầu: (5,12) -> map ngược đúng ô trống trên bàn thật
    const [m] = afterOne;
    expect(Number.isInteger(m.x) && Number.isInteger(m.y)).toBe(true);
  });

  it('thế cờ xoay / lật / tịnh tiến dùng chung một khoá; nước học được map đúng sang thế đã xoay', async () => {
    const book = new CaroBookService(new MemoryCaroBookStore());
    await book.learnGame('free', xWins);
    // xoay 90° + tịnh tiến: (x, y) -> (15 - y, x + 1)
    const rot = (m: Move): Move => [15 - m[1], m[0] + 1];
    const k1 = canonical(xWins.slice(0, 4)).key;
    const k2 = canonical(xWins.slice(0, 4).map(rot)).key;
    expect(k1).toBe(k2);
    const q = await book.query('free', xWins.slice(0, 4).map(rot));
    expect(q).toHaveLength(1);
    expect([q[0].x, q[0].y]).toEqual(rot(xWins[4]));
  });

  it('không tin dữ liệu bậy: nước trùng / chưa kết thúc / quá ngắn bị từ chối; kết quả do server tự đi lại ván', async () => {
    const book = new CaroBookService(new MemoryCaroBookStore());
    expect(
      (
        await book.learnGame('free', [
          [1, 1],
          [1, 1],
          [2, 2],
          [3, 3],
          [4, 4],
          [5, 5],
          [6, 6],
        ])
      ).ok,
    ).toBe(false);
    expect((await book.learnGame('free', xWins.slice(0, 8))).ok).toBe(false);
    expect((await book.learnGame('free', xWins.slice(0, 4))).ok).toBe(false);
    expect((await book.learnGame('free', 'abc')).ok).toBe(false);
    // ván online kết thúc do xin thua: server chỉ định kết quả
    const r = await book.learnGame('free', xWins.slice(0, 8), { winner: 2 });
    expect(r).toMatchObject({ ok: true, winner: 2 });
  });

  it('luật chặn 2 đầu tách sách riêng với luật chặn 1 đầu', async () => {
    const book = new CaroBookService(new MemoryCaroBookStore());
    await book.learnGame('free', xWins);
    expect(await book.query('block2', [])).toEqual([]);
  });
});
