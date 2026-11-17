import { Injectable } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import {
  ALLOWED_TARGETS,
  BILLIARD_MAX_PLAYERS,
  BILLIARD_TURN_SECONDS,
  BilliardMatch,
  CompactEvent,
  RoomKind,
  RoomMatchMeta,
  TURN_SECONDS_OPTIONS,
  PlayerStats,
  PublicRoom,
  Room,
  RoomChatMessage,
  RoomPlayer,
  RoomSettings,
} from './billiard.types';
import {
  BallId,
  checkCueClearance,
  DEFAULT_PHYSICS,
  initialPositions,
  judgeShot,
  sanitizeShot,
  ShotCommand,
  simulateShot,
  validateShotInput,
} from './physics';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_CHAT_HISTORY = 50;

export const DEFAULT_SETTINGS: RoomSettings = {
  isPrivate: false,
  mode: 'free',
  target: 10,
  guideline: true,
  name: '',
  turnSeconds: BILLIARD_TURN_SECONDS,
};

const MAX_ROOM_NAME = 40;

export function hashPassword(password: string): string {
  const salt = randomBytes(8).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function checkPassword(
  password: string,
  stored: string | null,
): boolean {
  if (!stored) return true;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const got = scryptSync(password, salt, 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface RoomListQuery {
  search?: string;
  mode?: 'free' | 'three';
  status?: 'lobby' | 'playing';
  sort?: 'newest' | 'players';
}
/** Kết quả xử lý 1 lệnh đánh */
export type ShootOutcome =
  | { error: string }
  | { duplicate: true }
  | { match: BilliardMatch };

/** Giới hạn shotId đã lưu để chống xử lý trùng */
const MAX_PROCESSED_SHOTS = 200;

/** Thời gian chờ sau khi bi dừng trước khi được đánh tiếp (ms) */
const SETTLE_MS = 700;

/**
 * Lưu trữ phòng Bida Carom trong bộ nhớ.
 * Phòng chỉ tồn tại khi server đang chạy (đủ cho chơi online thời gian thực).
 */
@Injectable()
export class BilliardRoomService {
  private rooms = new Map<string, Room>();
  /** userId -> code phòng hiện tại (1 người chỉ ở 1 phòng) */
  private userRoom = new Map<string, string>();

  private generateCode(): string {
    let code = '';
    do {
      code = Array.from(
        { length: CODE_LENGTH },
        () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  normalizeCode(code: unknown): string {
    return typeof code === 'string' ? code.trim().toUpperCase() : '';
  }

  get(code: string): Room | undefined {
    return this.rooms.get(this.normalizeCode(code));
  }

  getRoomOfUser(userId: string): Room | undefined {
    const code = this.userRoom.get(userId);
    return code ? this.rooms.get(code) : undefined;
  }

  toPublic(room: Room): PublicRoom {
    return {
      code: room.code,
      kind: room.kind,
      hasPassword: !!room.passwordHash,
      hostName: this.findPlayer(room, room.hostId)?.name ?? '',
      meta: room.meta,
      hostId: room.hostId,
      status: room.status,
      settings: room.settings,
      createdAt: room.createdAt,
      players: room.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          userId: p.userId,
          name: p.name,
          avatar: p.avatar,
          seat: p.seat,
          ready: p.ready,
          connected: p.connected,
          joinedAt: p.joinedAt,
        })),
    };
  }

  /** Danh sách phòng casual công khai (tìm kiếm / lọc / sắp xếp ở server) */
  listPublicLobbies(q: RoomListQuery = {}): PublicRoom[] {
    const search = q.search?.trim().toLowerCase();
    return Array.from(this.rooms.values())
      .filter(
        (r) =>
          r.kind === 'casual' &&
          !r.settings.isPrivate &&
          (q.status
            ? q.status === 'playing'
              ? r.status !== 'lobby'
              : r.status === 'lobby'
            : true) &&
          (!q.mode || r.settings.mode === q.mode) &&
          (!search ||
            r.settings.name.toLowerCase().includes(search) ||
            r.code.toLowerCase().includes(search) ||
            (this.findPlayer(r, r.hostId)?.name ?? '')
              .toLowerCase()
              .includes(search)),
      )
      .sort(
        (a, b) =>
          (q.sort === 'players' ? b.players.length - a.players.length : 0) ||
          b.createdAt - a.createdAt,
      )
      .slice(0, 50)
      .map((r) => this.toPublic(r));
  }

  /** Thống kê nhanh cho sảnh */
  stats(): { rooms: number; playing: number; players: number } {
    let playing = 0;
    let players = 0;
    for (const r of this.rooms.values()) {
      if (r.status === 'playing') playing++;
      players += r.players.filter((p) => p.connected).length;
    }
    return { rooms: this.rooms.size, playing, players };
  }

  /** Người chơi đang trong một trận (đang chơi, hoặc phòng ghép trận / giải đấu chưa kết thúc) */
  busyReason(userId: string): string | null {
    const r = this.getRoomOfUser(userId);
    if (!r) return null;
    if (r.status === 'playing') return 'Bạn đang trong một trận đấu';
    if (r.kind !== 'casual' && r.status === 'lobby')
      return 'Bạn đang có trận chờ bắt đầu';
    return null;
  }

  /**
   * Phòng cho trận ghép tự động / giải đấu: dành sẵn 2 ghế cho đúng 2 người, chưa ai kết nối.
   * Người chơi vào bằng `bida:join` như phòng thường; đủ người thì trận tự bắt đầu.
   */
  createMatchRoom(
    kind: Exclude<RoomKind, 'casual'>,
    users: { userId: string; name: string; avatar?: string }[],
    rule: { mode: 'free' | 'three'; target: number; name: string },
    meta: RoomMatchMeta,
  ): Room {
    const code = this.generateCode();
    const room: Room = {
      code,
      kind,
      matchId: meta.matchId,
      meta,
      passwordHash: null,
      hostId: users[0].userId,
      status: 'lobby',
      settings: {
        ...DEFAULT_SETTINGS,
        isPrivate: true,
        mode: rule.mode,
        target: rule.target,
        name: rule.name,
      },
      players: [],
      snapshot: null,
      chat: [],
      voice: {},
      processedShots: new Set<string>(),
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    for (const u of users) {
      // rời phòng casual đang chờ (nếu có) để không ở 2 phòng cùng lúc
      const old = this.getRoomOfUser(u.userId);
      if (old && old.code !== code && old.status !== 'playing')
        this.removePlayer(old, u.userId);
      const p = this.addPlayer(room, { ...u, socketId: null });
      p.connected = false;
    }
    return room;
  }

  /** Xoá phòng (huỷ trận) */
  closeRoom(room: Room): void {
    for (const p of room.players)
      if (this.userRoom.get(p.userId) === room.code)
        this.userRoom.delete(p.userId);
    this.rooms.delete(room.code);
  }

  setPassword(room: Room, password: string | null): void {
    room.passwordHash = password ? hashPassword(password) : null;
  }

  create(user: Omit<RoomPlayer, 'seat' | 'ready' | 'connected' | 'joinedAt'>) {
    const code = this.generateCode();
    const room: Room = {
      code,
      kind: 'casual',
      matchId: null,
      meta: null,
      passwordHash: null,
      hostId: user.userId,
      status: 'lobby',
      settings: { ...DEFAULT_SETTINGS },
      players: [],
      snapshot: null,
      chat: [],
      voice: {},
      processedShots: new Set<string>(),
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    this.addPlayer(room, user);
    return room;
  }

  private firstFreeSeat(room: Room): number {
    const taken = new Set(room.players.map((p) => p.seat));
    for (let s = 0; s < BILLIARD_MAX_PLAYERS; s++) {
      if (!taken.has(s)) return s;
    }
    return -1;
  }

  addPlayer(
    room: Room,
    user: Omit<RoomPlayer, 'seat' | 'ready' | 'connected' | 'joinedAt'>,
  ): RoomPlayer {
    const seat = this.firstFreeSeat(room);
    const player: RoomPlayer = {
      ...user,
      seat,
      ready: false,
      connected: true,
      joinedAt: Date.now(),
    };
    room.players.push(player);
    this.userRoom.set(user.userId, room.code);
    return player;
  }

  findPlayer(room: Room, userId: string) {
    return room.players.find((p) => p.userId === userId);
  }

  /** Xoá người chơi khỏi phòng. Trả về true nếu phòng bị xoá vì trống. */
  removePlayer(room: Room, userId: string): boolean {
    room.players = room.players.filter((p) => p.userId !== userId);
    if (this.userRoom.get(userId) === room.code) this.userRoom.delete(userId);

    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      return true;
    }

    if (room.hostId === userId) {
      this.transferHost(room);
    }
    return false;
  }

  /** Chuyển quyền host cho người đang kết nối có ghế nhỏ nhất */
  transferHost(room: Room): RoomPlayer | undefined {
    const candidates = room.players
      .filter((p) => p.userId !== room.hostId)
      .sort(
        (a, b) => Number(b.connected) - Number(a.connected) || a.seat - b.seat,
      );
    const next = candidates[0];
    if (next) {
      room.hostId = next.userId;
      next.ready = false;
    }
    return next;
  }

  changeSeat(room: Room, userId: string, seat: number): boolean {
    if (!Number.isInteger(seat) || seat < 0 || seat >= BILLIARD_MAX_PLAYERS)
      return false;
    if (room.players.some((p) => p.seat === seat)) return false;
    const player = this.findPlayer(room, userId);
    if (!player) return false;
    player.seat = seat;
    return true;
  }

  updateSettings(room: Room, patch: Partial<RoomSettings>) {
    const next = { ...room.settings };
    if (typeof patch.isPrivate === 'boolean') next.isPrivate = patch.isPrivate;
    if (patch.mode === 'free' || patch.mode === 'three') {
      if (patch.mode !== next.mode) {
        next.mode = patch.mode;
        // Đổi chế độ -> điểm thắng mặc định của chế độ đó
        next.target = ALLOWED_TARGETS[patch.mode][1];
      }
    }
    if (typeof patch.guideline === 'boolean') next.guideline = patch.guideline;
    if (typeof patch.name === 'string')
      next.name = patch.name.trim().slice(0, MAX_ROOM_NAME);
    if (
      typeof patch.turnSeconds === 'number' &&
      TURN_SECONDS_OPTIONS.includes(patch.turnSeconds)
    )
      next.turnSeconds = patch.turnSeconds;
    if (
      typeof patch.target === 'number' &&
      ALLOWED_TARGETS[next.mode].includes(patch.target)
    ) {
      next.target = patch.target;
    }
    room.settings = next;
  }

  addChat(room: Room, msg: Omit<RoomChatMessage, 'id' | 'createdAt'>) {
    const message: RoomChatMessage = {
      ...msg,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    };
    room.chat = [...room.chat.slice(-(MAX_CHAT_HISTORY - 1)), message];
    return message;
  }

  // =====================================================
  // TRẬN ĐẤU (server-authoritative)
  // =====================================================
  /** Khai cuộc: ghế 0 (bi trắng) đánh trước */
  startGame(room: Room): BilliardMatch {
    const players = room.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.userId);
    const now = Date.now();
    const emptyStats = (): PlayerStats => ({
      shots: 0,
      points: 0,
      bestRun: 0,
      currentRun: 0,
      innings: 0,
    });
    const turnSeconds = room.settings.turnSeconds;
    const match: BilliardMatch = {
      turnSeconds,
      seq: 0,
      mode: room.settings.mode,
      target: room.settings.target,
      guideline: room.settings.guideline,
      balls: initialPositions(DEFAULT_PHYSICS),
      players,
      scores: players.map(() => 0),
      stats: players.map(emptyStats),
      turn: 0,
      busyUntil: now,
      turnDeadline: now + turnSeconds * 1000,
      lastShot: null,
      winner: null,
      startedAt: now,
    };
    match.stats[0].innings = 1;
    // mỗi ván casual một mã trận mới; phòng ghép trận / giải đấu dùng mã được cấp sẵn
    if (room.kind === 'casual')
      room.matchId = `c-${room.code}-${now.toString(36)}`;
    room.status = 'playing';
    room.snapshot = match;
    room.processedShots = new Set();
    return match;
  }

  /**
   * Người chơi gửi ShotCommand: server kiểm tra quyền, chuẩn hoá tham số,
   * mô phỏng vật lý, chấm điểm bằng rule engine rồi đổi lượt.
   * Trả về chuỗi lỗi nếu không hợp lệ, 'duplicate' nếu cú đánh đã xử lý.
   */
  shoot(
    room: Room,
    userId: string,
    input: Partial<Record<keyof ShotCommand, unknown>> & {
      shotId?: unknown;
      expectedSeq?: unknown;
    },
  ): ShootOutcome {
    const match = room.snapshot;
    if (room.status !== 'playing' || !match)
      return { error: 'Trận đấu chưa bắt đầu' };
    const shotId =
      typeof input.shotId === 'string' ? input.shotId.slice(0, 64) : '';
    if (!shotId) return { error: 'Thiếu mã cú đánh' };
    if (room.processedShots.has(shotId)) return { duplicate: true };
    if (match.winner !== null) return { error: 'Trận đấu đã kết thúc' };
    if (match.players[match.turn] !== userId)
      return { error: 'Chưa tới lượt của bạn' };
    if (input.expectedSeq !== match.seq)
      return { error: 'Trạng thái bàn đã thay đổi, hãy thử lại' };
    const now = Date.now();
    if (now < match.busyUntil) return { error: 'Bi vẫn đang lăn' };

    const cue = match.turn as BallId; // ghế 0 = bi trắng (0), ghế 1 = bi vàng (1)
    // Từ chối dữ liệu sai (góc cơ ngoài 0–90°, NaN / Infinity...) thay vì âm thầm sửa
    const invalid = validateShotInput(input);
    if (invalid) return { error: invalid };
    const shot = sanitizeShot(input, cue);
    const start = match.balls;
    // Cơ phải thực hiện được về hình học (không xuyên mặt bàn / băng / bi khác)
    const clearance = checkCueClearance(start, shot, DEFAULT_PHYSICS);
    if (!clearance.ok) {
      const hint =
        clearance.minElevation !== null
          ? ` — hãy nâng cơ tối thiểu ${clearance.minElevation}°`
          : '';
      return { error: `${clearance.reason}${hint}` };
    }
    const res = simulateShot(start, shot, DEFAULT_PHYSICS, {
      recordFrames: true,
    });
    const verdict = judgeShot(res.events, cue, { mode: match.mode });

    room.processedShots.add(shotId);
    if (room.processedShots.size > MAX_PROCESSED_SHOTS) {
      const [first] = Array.from(room.processedShots);
      room.processedShots.delete(first);
    }

    const by = match.turn;
    const st = match.stats[by];
    st.shots += 1;
    match.seq += 1;
    match.balls = res.final;
    match.lastShot = {
      seq: match.seq,
      shotId,
      by,
      shot,
      start,
      final: res.final,
      frames: res.frames,
      events: res.events.map(
        (e): CompactEvent => ({
          t: Math.round(e.t * 1000) / 1000,
          type: e.type,
          speed: Math.round(e.speed * 100) / 100,
          ball: e.type === 'cushion' ? e.ball : undefined,
        }),
      ),
      verdict,
      duration: res.duration,
      at: now,
    };

    if (verdict.scored) {
      match.scores[by] += 1;
      st.points += 1;
      st.currentRun += 1;
      st.bestRun = Math.max(st.bestRun, st.currentRun);
      if (match.scores[by] >= match.target) {
        match.winner = by;
        match.endedAt = now;
        room.status = 'finished';
      }
    } else {
      st.currentRun = 0;
      this.passTurn(match);
    }
    match.busyUntil = now + Math.ceil(res.duration * 1000) + SETTLE_MS;
    match.turnDeadline = match.busyUntil + match.turnSeconds * 1000;
    return { match };
  }

  private passTurn(match: BilliardMatch) {
    match.turn = (match.turn + 1) % match.players.length;
    match.stats[match.turn].innings += 1;
  }

  /** Hết giờ lượt -> mất lượt. Trả về true nếu đã đổi lượt. */
  timeoutTurn(room: Room): boolean {
    const match = room.snapshot;
    if (room.status !== 'playing' || !match || match.winner !== null)
      return false;
    if (Date.now() < match.turnDeadline) return false;
    match.stats[match.turn].currentRun = 0;
    this.passTurn(match);
    match.seq += 1;
    match.lastShot = null;
    match.busyUntil = Date.now();
    match.turnDeadline = match.busyUntil + match.turnSeconds * 1000;
    return true;
  }

  /** Người chơi rời trận -> người còn lại thắng */
  forfeit(room: Room, userId: string, reason: string): boolean {
    const match = room.snapshot;
    if (room.status !== 'playing' || !match || match.winner !== null)
      return false;
    const idx = match.players.indexOf(userId);
    if (idx < 0) return false;
    match.winner = (idx + 1) % match.players.length;
    match.endReason = reason;
    match.endedAt = Date.now();
    match.seq += 1;
    match.lastShot = null;
    room.status = 'finished';
    return true;
  }

  resetToLobby(room: Room) {
    room.status = 'lobby';
    room.snapshot = null;
    room.players.forEach((p) => (p.ready = false));
  }
}
