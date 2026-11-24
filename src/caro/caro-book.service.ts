import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema } from 'mongoose';
import { BOOK_PLIES, canonical, type BookMove, type Move } from './shared/book';
import { applyMove, newGame, type CaroRule, type Stone } from './shared/rules';

/**
 * SÁCH KHAI CUỘC HỌC TỪ CÁC VÁN ĐÃ CHƠI (dùng chung cho mọi người chơi).
 * Mỗi ván kết thúc: server đi lại toàn bộ ván bằng luật của game (không tin kết quả client gửi), rồi với
 * BOOK_PLIES nước đầu cộng thống kê "ở thế này, đi nước kia -> bên đi nước đó thắng / hoà / thua".
 * Bot đọc sách để lặp lại nước hay và tránh nước từng thua — tức là học cả cách đi của đối thủ.
 */
export const CaroBookSchema = new Schema(
  {
    rule: { type: String, required: true },
    key: { type: String, required: true },
    /** "x,y" (toạ độ chuẩn) -> { n: số ván, s: tổng điểm cho bên đi nước đó } */
    moves: { type: Schema.Types.Mixed, default: {} },
  },
  { minimize: false },
);
CaroBookSchema.index({ rule: 1, key: 1 }, { unique: true });

interface BookDoc {
  rule: string;
  key: string;
  moves: Record<string, { n: number; s: number }>;
}

/** Nơi lưu (Mongo khi chạy thật; bộ nhớ khi test) */
export interface CaroBookStore {
  add(
    rule: string,
    entries: { key: string; mv: string; score: number }[],
  ): Promise<void>;
  get(
    rule: string,
    key: string,
  ): Promise<Record<string, { n: number; s: number }> | null>;
}

export const MIN_LEARN_MOVES = 7;
export const MAX_MOVES = 400;

export type LearnResult =
  | { ok: true; learned: number; winner: Stone | null }
  | { ok: false; error: string };

export function validMoves(raw: unknown): Move[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_MOVES) return null;
  const out: Move[] = [];
  for (const m of raw) {
    if (
      !Array.isArray(m) ||
      m.length !== 2 ||
      !Number.isInteger(m[0]) ||
      !Number.isInteger(m[1])
    )
      return null;
    out.push([m[0] as number, m[1] as number]);
  }
  return out;
}

export const isRule = (r: unknown): r is CaroRule =>
  r === 'free' || r === 'block2';

@Injectable()
export class CaroBookService {
  private readonly logger = new Logger('CaroBook');
  constructor(private readonly store: CaroBookStore) {}

  /**
   * Học một ván. `result`: chỉ server (ván online) mới được chỉ định kết quả khi ván kết thúc do xin thua / hết giờ;
   * ván gửi từ client phải tự kết thúc bằng 5 quân (hoặc hoà kín bàn) mới được học.
   */
  async learnGame(
    rule: CaroRule,
    rawMoves: unknown,
    result?: { winner: Stone | null },
  ): Promise<LearnResult> {
    const moves = validMoves(rawMoves);
    if (!moves) return { ok: false, error: 'Danh sách nước đi không hợp lệ' };
    if (moves.length < MIN_LEARN_MOVES)
      return { ok: false, error: 'Ván quá ngắn để học' };
    let g = newGame(rule);
    for (const [x, y] of moves) {
      const r = applyMove(g, x, y);
      if (!r.ok) return { ok: false, error: 'Ván có nước đi không hợp lệ' };
      g = r.state;
    }
    let winner: Stone | null;
    if (g.winner !== null) winner = g.winner;
    else if (g.draw) winner = null;
    else if (result) winner = result.winner;
    else return { ok: false, error: 'Ván chưa kết thúc' };
    const entries: { key: string; mv: string; score: number }[] = [];
    const plies = Math.min(BOOK_PLIES, moves.length);
    for (let i = 0; i < plies; i++) {
      const c = canonical(moves.slice(0, i));
      const mover: Stone = i % 2 === 0 ? 1 : 2;
      const score = winner === null ? 0.5 : winner === mover ? 1 : 0;
      entries.push({ key: c.key, mv: c.toCanon(moves[i]), score });
    }
    await this.store.add(rule, entries);
    return { ok: true, learned: entries.length, winner };
  }

  /** Các nước đã biết cho thế cờ hiện tại (toạ độ thật trên bàn) */
  async query(rule: CaroRule, rawMoves: unknown): Promise<BookMove[]> {
    const moves = validMoves(rawMoves);
    if (!moves || moves.length >= BOOK_PLIES) return [];
    const c = canonical(moves);
    const doc = await this.store.get(rule, c.key);
    if (!doc) return [];
    return Object.entries(doc)
      .map(([mv, v]) => {
        const [x, y] = c.fromCanon(mv);
        return { x, y, n: v.n, score: v.n ? v.s / v.n : 0 };
      })
      .sort((a, b) => b.n - a.n);
  }
}

/** Lưu MongoDB: cộng dồn bằng $inc (an toàn khi nhiều ván kết thúc cùng lúc) */
@Injectable()
export class MongoCaroBookStore implements CaroBookStore {
  constructor(
    @InjectModel('CaroBook') private readonly model: Model<BookDoc>,
  ) {}

  async add(
    rule: string,
    entries: { key: string; mv: string; score: number }[],
  ) {
    if (!entries.length) return;
    await this.model.bulkWrite(
      entries.map((e) => ({
        updateOne: {
          filter: { rule, key: e.key },
          update: {
            $inc: { [`moves.${e.mv}.n`]: 1, [`moves.${e.mv}.s`]: e.score },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async get(rule: string, key: string) {
    const d = await this.model.findOne({ rule, key }).lean<BookDoc>();
    return d?.moves ?? null;
  }
}

/** Lưu trong bộ nhớ (test) */
export class MemoryCaroBookStore implements CaroBookStore {
  data = new Map<string, Record<string, { n: number; s: number }>>();
  add(rule: string, entries: { key: string; mv: string; score: number }[]) {
    for (const e of entries) {
      const k = `${rule}|${e.key}`;
      const m = this.data.get(k) ?? {};
      const v = (m[e.mv] ??= { n: 0, s: 0 });
      v.n += 1;
      v.s += e.score;
      this.data.set(k, m);
    }
    return Promise.resolve();
  }
  get(rule: string, key: string) {
    return Promise.resolve(this.data.get(`${rule}|${key}`) ?? null);
  }
}
