import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema } from 'mongoose';
import type { Room } from './pool.types';
import type { GameType } from './shared/rules/types';

/** ELO riêng cho 8 bi và 9 bi */
export interface RatingEntry {
  elo: number;
  games: number;
  wins: number;
}
export interface PoolRatingDoc {
  userId: string;
  eight: RatingEntry;
  nine: RatingEntry;
}

const entry = {
  elo: { type: Number, default: 1200 },
  games: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
};
export const PoolRatingSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    eight: { type: entry, default: () => ({}) },
    nine: { type: entry, default: () => ({}) },
  },
  { timestamps: true },
);

/** Lịch sử trận + replay (seed + danh sách input) để xem lại & xử lý khiếu nại */
export const PoolMatchSchema = new Schema(
  {
    code: String,
    type: String,
    ranked: Boolean,
    preset: String,
    raceTo: Number,
    players: [
      { userId: { type: String, index: true }, name: String, seat: Number },
    ],
    score: [Number],
    winner: Number,
    reason: String,
    stats: Schema.Types.Mixed,
    eloChange: [Number],
    replay: Schema.Types.Mixed,
    startedAt: Date,
    endedAt: Date,
  },
  { timestamps: true },
);

export const DEFAULT_ELO = 1200;
const K = 32;

/** ELO chuẩn: kỳ vọng E = 1 / (1 + 10^((Rb − Ra)/400)) */
export function eloDelta(ra: number, rb: number, aWon: boolean): number {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return Math.round(K * ((aWon ? 1 : 0) - ea));
}

@Injectable()
export class PoolStatsService {
  private readonly logger = new Logger('PoolStats');
  constructor(
    @InjectModel('PoolRating') private readonly ratings: Model<PoolRatingDoc>,
    @InjectModel('PoolMatch')
    private readonly matches: Model<Record<string, unknown>>,
  ) {}

  async getRating(userId: string): Promise<PoolRatingDoc> {
    const doc = await this.ratings.findOne({ userId }).lean();
    const def = { elo: DEFAULT_ELO, games: 0, wins: 0 };
    return { userId, eight: doc?.eight ?? def, nine: doc?.nine ?? def };
  }

  async getElo(userId: string, type: GameType): Promise<number> {
    return (await this.getRating(userId))[type].elo;
  }

  /** Lưu trận đã kết thúc; trận xếp hạng thì cập nhật ELO. Trả về thay đổi ELO theo ghế. */
  async recordMatch(room: Room): Promise<[number, number] | undefined> {
    const g = room.game;
    if (!g || g.match.matchWinner === null) return undefined;
    const type = room.settings.type;
    const winner = g.match.matchWinner;
    // Trận giao hữu bỏ ngang khi chưa xong ván nào: không lưu (không có kết quả ý nghĩa)
    if (!room.settings.ranked && g.match.score[0] + g.match.score[1] === 0)
      return undefined;
    let change: [number, number] | undefined;
    try {
      if (room.settings.ranked) {
        const [a, b] = await Promise.all(
          g.players.map((u) => this.getRating(u)),
        );
        const d = eloDelta(a[type].elo, b[type].elo, winner === 0);
        change = [d, -d];
        await Promise.all(
          g.players.map((userId, i) =>
            this.ratings.updateOne(
              { userId },
              {
                $inc: {
                  [`${type}.elo`]: change![i],
                  [`${type}.games`]: 1,
                  [`${type}.wins`]: winner === i ? 1 : 0,
                },
              },
              { upsert: true },
            ),
          ),
        );
      }
      await this.matches.create({
        code: room.code,
        type,
        ranked: room.settings.ranked,
        preset: room.settings.pocketPreset,
        raceTo: room.settings.raceTo,
        players: g.players.map((userId, seat) => ({
          userId,
          name: g.names[seat],
          seat,
        })),
        score: g.match.score,
        winner,
        reason: g.endReason,
        stats: g.stats,
        eloChange: change,
        replay: g.replay,
        startedAt: new Date(g.startedAt),
        endedAt: new Date(g.endedAt ?? Date.now()),
      });
    } catch (e) {
      this.logger.error(`Không lưu được trận ${room.code}: ${String(e)}`);
    }
    return change;
  }

  async history(userId: string, limit = 20) {
    return this.matches
      .find({ 'players.userId': userId })
      .sort({ endedAt: -1 })
      .limit(limit)
      .select('-replay')
      .lean();
  }

  async replay(id: string, userId: string) {
    const m = await this.matches.findById(id).lean();
    if (!m) return null;
    const players = (m.players as { userId: string }[]) ?? [];
    return players.some((p) => p.userId === userId) ? m : null;
  }
}
