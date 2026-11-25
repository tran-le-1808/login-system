import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema, Types } from 'mongoose';
import { PRISON_CONFIG as C } from './shared/config';
import type { EngineEvent, WorldState } from './shared/types';

export type PrisonSessionStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABANDONED';

export interface PrisonSessionDoc {
  _id: Types.ObjectId;
  roomCode: string;
  prisonId: string;
  hostId: string;
  memberIds: string[];
  members: { userId: string; name: string; role: string }[];
  requiredPlayerIds: string[];
  escapedPlayerIds: string[];
  difficulty: string;
  status: PrisonSessionStatus;
  currentDay: number;
  /** Tổng số phút game đã trôi (không phải phút trong ngày) */
  totalGameMinutes: number;
  prisonState: string;
  teamHeat: number;
  checkpointVersion: number;
  checkpointAt: Date | null;
  world: WorldState | null;
  startedAt: Date;
  endedAt: Date | null;
}

/** game_sessions của Prison Break (đặt tên riêng để không đụng game khác trong hub) */
export const PrisonSessionSchema = new Schema(
  {
    roomCode: { type: String, required: true },
    prisonId: { type: String, required: true },
    hostId: { type: String, required: true },
    memberIds: { type: [String], default: [] },
    members: {
      type: [{ userId: String, name: String, role: String }],
      default: [],
    },
    requiredPlayerIds: { type: [String], default: [] },
    escapedPlayerIds: { type: [String], default: [] },
    difficulty: { type: String, required: true },
    status: { type: String, required: true, default: 'ACTIVE' },
    currentDay: { type: Number, default: 1 },
    totalGameMinutes: { type: Number, default: 0 },
    prisonState: { type: String, default: 'NORMAL' },
    teamHeat: { type: Number, default: 0 },
    checkpointVersion: { type: Number, default: 0 },
    checkpointAt: { type: Date, default: null },
    world: { type: Schema.Types.Mixed, default: null },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'prison_sessions', minimize: false },
);
PrisonSessionSchema.index({ roomCode: 1, status: 1 });
PrisonSessionSchema.index({ status: 1, updatedAt: 1 });
PrisonSessionSchema.index({ memberIds: 1, status: 1 });

/** game_events — chỉ sự kiện gameplay quan trọng (audit), KHÔNG lưu input/tick */
export const PrisonEventSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, required: true },
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    actorPlayerId: { type: String },
    targetPlayerId: { type: String },
    payload: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'prison_events',
  },
);
PrisonEventSchema.index({ sessionId: 1, eventId: 1 }, { unique: true });
PrisonEventSchema.index({ sessionId: 1, createdAt: -1 });

interface QueuedEvent {
  sessionId: Types.ObjectId;
  eventId: string;
  type: string;
  actorPlayerId?: string;
  targetPlayerId?: string;
  payload: Record<string, string | number | boolean>;
}

/**
 * Lưu bền vững: checkpoint theo mốc (có version chống ghi đè ngược) và audit log theo lô.
 * Mọi lệnh ghi chạy bất đồng bộ, NGOÀI vòng tick; lỗi DB không làm dừng mô phỏng.
 */
@Injectable()
export class PrisonPersistenceService implements OnModuleDestroy {
  private readonly logger = new Logger('PrisonPersistence');
  private queue: QueuedEvent[] = [];
  private flushTimer: NodeJS.Timeout;
  /** Đếm số lệnh ghi (đo tải DB) */
  writes = 0;

  constructor(
    @InjectModel('PrisonSession')
    private readonly sessions: Model<PrisonSessionDoc>,
    @InjectModel('PrisonEvent')
    private readonly events: Model<QueuedEvent>,
  ) {
    this.flushTimer = setInterval(
      () => void this.flush(),
      C.persistence.eventFlushSeconds * 1000,
    );
    this.flushTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }

  async createSession(input: {
    roomCode: string;
    hostId: string;
    members: { userId: string; name: string; role: string }[];
    world: WorldState;
  }): Promise<string | null> {
    try {
      this.writes++;
      const doc = await this.sessions.create({
        roomCode: input.roomCode,
        prisonId: input.world.prisonId,
        hostId: input.hostId,
        memberIds: input.members.map((m) => m.userId),
        members: input.members,
        requiredPlayerIds: input.world.requiredPlayerIds,
        escapedPlayerIds: [],
        difficulty: input.world.difficulty,
        status: 'ACTIVE',
        totalGameMinutes: input.world.totalGameMinutes,
        checkpointVersion: 0,
        world: null,
        startedAt: new Date(),
      });
      return String(doc._id);
    } catch (e) {
      this.logger.error(`createSession lỗi: ${String(e)}`);
      return null;
    }
  }

  /**
   * Ghi checkpoint có điều kiện `checkpointVersion < version` — checkpoint cũ (đến muộn)
   * không thể ghi đè trạng thái mới hơn. Trả về true nếu đã ghi.
   */
  async saveCheckpoint(
    sessionId: string,
    version: number,
    world: WorldState,
    status: PrisonSessionStatus = 'ACTIVE',
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(sessionId)) return false;
    try {
      this.writes++;
      const day = Math.floor(world.totalGameMinutes / 1440) + 1;
      const res = await this.sessions.updateOne(
        {
          _id: new Types.ObjectId(sessionId),
          checkpointVersion: { $lt: version },
        },
        {
          $set: {
            checkpointVersion: version,
            checkpointAt: new Date(),
            world,
            status,
            currentDay: day,
            totalGameMinutes: world.totalGameMinutes,
            prisonState: world.prisonState,
            teamHeat: world.teamHeat,
            requiredPlayerIds: world.requiredPlayerIds,
            escapedPlayerIds: Object.values(world.players)
              .filter((p) => p.status === 'ESCAPED')
              .map((p) => p.id),
            ...(status === 'COMPLETED' ||
            status === 'FAILED' ||
            status === 'ABANDONED'
              ? { endedAt: new Date() }
              : {}),
          },
        },
      );
      return res.modifiedCount > 0;
    } catch (e) {
      this.logger.error(`saveCheckpoint lỗi: ${String(e)}`);
      return false;
    }
  }

  /** Phiên còn dở của người dùng trong phòng này (khôi phục sau khi server khởi động lại) */
  async findResumable(
    roomCode: string,
    userId: string,
  ): Promise<PrisonSessionDoc | null> {
    try {
      return await this.sessions
        .findOne({
          roomCode,
          memberIds: userId,
          status: { $in: ['ACTIVE', 'PAUSED'] },
          world: { $ne: null },
        })
        .sort({ updatedAt: -1 })
        .lean<PrisonSessionDoc>()
        .exec();
    } catch (e) {
      this.logger.error(`findResumable lỗi: ${String(e)}`);
      return null;
    }
  }

  queueEvents(sessionId: string | null, events: EngineEvent[]): void {
    if (!sessionId || !Types.ObjectId.isValid(sessionId)) return;
    const sid = new Types.ObjectId(sessionId);
    for (const ev of events) {
      if (!ev.audit) continue;
      this.queue.push({
        sessionId: sid,
        eventId: ev.id,
        type: ev.type,
        actorPlayerId: ev.playerId,
        targetPlayerId: ev.targetId,
        payload: ev.data ?? {},
      });
    }
    if (this.queue.length > 500) void this.flush();
  }

  /** Ghi theo lô; trùng eventId (unique index) bị bỏ qua -> retry an toàn */
  async flush(): Promise<void> {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      this.writes++;
      await this.events.insertMany(batch, { ordered: false });
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code !== 11000) this.logger.error(`flush sự kiện lỗi: ${String(e)}`);
    }
  }
}
