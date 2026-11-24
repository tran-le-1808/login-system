import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import {
  applyMove,
  MOVE_ERROR_VI,
  newGame,
  type CaroRule,
  type Stone,
} from './shared/rules';
import {
  CARO_MAX_PLAYERS,
  CaroRoomSettings,
  CaroSnapshot,
  PublicRoom,
  Room,
  RoomChatMessage,
  RoomPlayer,
  TURN_SECONDS_OPTIONS,
} from './caro.types';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAT = 100;
/** Người đến lượt mất kết nối: đồng hồ dừng tối đa chừng này rồi chạy tiếp */
export const DISCONNECT_PAUSE_MS = 60_000;

export const DEFAULT_SETTINGS: CaroRoomSettings = {
  isPrivate: false,
  rule: 'block2',
  turnSeconds: 30,
  quick: false,
};

type NewPlayer = Pick<RoomPlayer, 'userId' | 'name' | 'avatar' | 'socketId'>;
export type MoveResult = { ok: true } | { ok: false; error: string };

/**
 * PHÒNG CỜ CARO (bộ nhớ trong) — server có thẩm quyền: luật, lượt, đồng hồ, thắng thua đều tính ở đây.
 */
@Injectable()
export class CaroRoomService {
  private rooms = new Map<string, Room>();
  private userRoom = new Map<string, string>();
  /** Đồng hồ giả lập cho test */
  now: () => number = () => Date.now();

  normalizeCode(code: unknown): string {
    return typeof code === 'string'
      ? code.trim().toUpperCase().slice(0, 6)
      : '';
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  getRoomOfUser(userId: string): Room | undefined {
    const code = this.userRoom.get(userId);
    return code ? this.rooms.get(code) : undefined;
  }

  findPlayer(room: Room, userId: string) {
    return room.players.find((p) => p.userId === userId);
  }

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < 6; i++)
        c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  sanitizeSettings(
    patch: Partial<CaroRoomSettings> | undefined,
    base: CaroRoomSettings,
  ): CaroRoomSettings {
    const p = patch ?? {};
    const rule: CaroRule =
      p.rule === 'free' || p.rule === 'block2' ? p.rule : base.rule;
    const turnSeconds = TURN_SECONDS_OPTIONS.includes(Number(p.turnSeconds))
      ? Number(p.turnSeconds)
      : base.turnSeconds;
    return {
      isPrivate:
        typeof p.isPrivate === 'boolean' ? p.isPrivate : base.isPrivate,
      rule,
      turnSeconds,
      quick: typeof p.quick === 'boolean' ? p.quick : base.quick,
    };
  }

  create(user: NewPlayer, settings?: Partial<CaroRoomSettings>): Room {
    const room: Room = {
      code: this.newCode(),
      hostId: user.userId,
      status: 'lobby',
      settings: this.sanitizeSettings(settings, DEFAULT_SETTINGS),
      players: [],
      chat: [],
      match: null,
      score: [0, 0],
      games: 0,
      createdAt: this.now(),
    };
    this.rooms.set(room.code, room);
    this.addPlayer(room, user);
    return room;
  }

  addPlayer(room: Room, user: NewPlayer): RoomPlayer | null {
    if (room.players.length >= CARO_MAX_PLAYERS) return null;
    const used = new Set(room.players.map((p) => p.seat));
    const seat = [0, 1].find((s) => !used.has(s)) ?? 0;
    const p: RoomPlayer = {
      ...user,
      seat,
      ready: false,
      connected: true,
      joinedAt: this.now(),
    };
    room.players.push(p);
    room.players.sort((a, b) => a.seat - b.seat);
    this.userRoom.set(user.userId, room.code);
    return p;
  }

  /** Xoá người khỏi phòng; trả về true nếu phòng bị xoá (không còn ai) */
  removeUser(room: Room, userId: string): boolean {
    room.players = room.players.filter((p) => p.userId !== userId);
    if (this.userRoom.get(userId) === room.code) this.userRoom.delete(userId);
    if (!room.players.length) {
      this.rooms.delete(room.code);
      return true;
    }
    if (room.hostId === userId) this.transferHost(room);
    room.players.forEach((p) => (p.ready = false));
    return false;
  }

  transferHost(room: Room): RoomPlayer | undefined {
    const next =
      room.players.find((p) => p.userId !== room.hostId && p.connected) ??
      room.players.find((p) => p.userId !== room.hostId);
    if (next) room.hostId = next.userId;
    return next;
  }

  changeSeat(room: Room, userId: string, seat: number): boolean {
    if (seat !== 0 && seat !== 1) return false;
    const p = this.findPlayer(room, userId);
    if (!p || room.players.some((o) => o.seat === seat && o.userId !== userId))
      return false;
    p.seat = seat;
    room.players.sort((a, b) => a.seat - b.seat);
    return true;
  }

  updateSettings(room: Room, patch: Partial<CaroRoomSettings>) {
    room.settings = this.sanitizeSettings(
      { ...patch, quick: room.settings.quick },
      room.settings,
    );
    room.players.forEach((p) => (p.ready = false));
  }

  addChat(
    room: Room,
    msg: Omit<RoomChatMessage, 'id' | 'createdAt'>,
  ): RoomChatMessage {
    const m: RoomChatMessage = {
      ...msg,
      id: `${this.now()}-${randomInt(1e9)}`,
      createdAt: this.now(),
    };
    room.chat.push(m);
    if (room.chat.length > MAX_CHAT)
      room.chat.splice(0, room.chat.length - MAX_CHAT);
    return m;
  }

  toPublic(room: Room): PublicRoom {
    return {
      code: room.code,
      hostId: room.hostId,
      status: room.status,
      settings: room.settings,
      players: room.players.map(({ socketId: _s, ...p }) => {
        void _s;
        return p;
      }),
      createdAt: room.createdAt,
    };
  }

  listPublic(): PublicRoom[] {
    return [...this.rooms.values()]
      .filter((r) => !r.settings.isPrivate && !r.settings.quick)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((r) => this.toPublic(r));
  }

  // ------------------------------------------------------------------ ván đấu

  startGame(room: Room): void {
    const seats = [0, 1].map((s) => room.players.find((p) => p.seat === s)!);
    // ván lẻ / chẵn đổi người cầm X (đi trước)
    const xSeat = room.games % 2;
    const t = this.now();
    room.games += 1;
    room.status = 'playing';
    room.match = {
      state: newGame(room.settings.rule),
      xSeat,
      players: [seats[0].userId, seats[1].userId],
      names: [seats[0].name, seats[1].name],
      deadline: t + room.settings.turnSeconds * 1000,
      pausedAt: null,
      winnerSeat: null,
      endReason: null,
      startedAt: t,
      endedAt: null,
      seq: 0,
    };
  }

  /** Ghế đang đến lượt */
  turnSeat(room: Room): number {
    const m = room.match!;
    return m.state.turn === 1 ? m.xSeat : 1 - m.xSeat;
  }

  seatOf(room: Room, userId: string): number {
    return room.match ? room.match.players.indexOf(userId) : -1;
  }

  stoneOfSeat(room: Room, seat: number): Stone {
    return seat === room.match!.xSeat ? 1 : 2;
  }

  move(room: Room, userId: string, body: unknown): MoveResult {
    const m = room.match;
    if (room.status !== 'playing' || !m)
      return { ok: false, error: 'Ván chưa bắt đầu' };
    const seat = this.seatOf(room, userId);
    if (seat < 0) return { ok: false, error: 'Bạn không phải người chơi' };
    if (seat !== this.turnSeat(room))
      return { ok: false, error: MOVE_ERROR_VI.NOT_YOUR_TURN };
    const b = (body ?? {}) as { x?: unknown; y?: unknown; seq?: unknown };
    if (typeof b.seq === 'number' && b.seq !== m.seq)
      return { ok: false, error: 'Bàn cờ đã thay đổi, hãy thử lại' };
    const r = applyMove(m.state, Number(b.x), Number(b.y));
    if (!r.ok) return { ok: false, error: MOVE_ERROR_VI[r.error] };
    m.state = r.state;
    m.seq += 1;
    const t = this.now();
    if (r.state.winner !== null)
      this.finish(room, seat, `${m.names[seat]} thắng — đủ 5 quân liền`);
    else if (r.state.draw) this.finish(room, null, 'Hoà — bàn cờ đã kín');
    else {
      m.deadline = t + room.settings.turnSeconds * 1000;
      m.pausedAt = null;
    }
    return { ok: true };
  }

  private finish(room: Room, winnerSeat: number | null, reason: string) {
    const m = room.match!;
    m.winnerSeat = winnerSeat;
    m.endReason = reason;
    m.endedAt = this.now();
    m.seq += 1;
    room.status = 'finished';
    if (winnerSeat !== null) room.score[winnerSeat] += 1;
  }

  /** Hết giờ nước đi -> người đến lượt thua. Trả về true nếu ván kết thúc. */
  timeout(room: Room): boolean {
    const m = room.match;
    if (room.status !== 'playing' || !m || m.pausedAt !== null) return false;
    if (this.now() < m.deadline) return false;
    const loser = this.turnSeat(room);
    this.finish(room, 1 - loser, `${m.names[loser]} hết giờ — xử thua`);
    return true;
  }

  /** Xin thua / rời trận / mất kết nối quá lâu */
  forfeit(room: Room, userId: string, reason: string): boolean {
    if (room.status !== 'playing' || !room.match) return false;
    const seat = this.seatOf(room, userId);
    if (seat < 0) return false;
    this.finish(room, 1 - seat, reason);
    return true;
  }

  pauseClock(room: Room) {
    const m = room.match;
    if (!m || m.pausedAt !== null || room.status !== 'playing') return;
    m.pausedAt = this.now();
  }

  resumeClock(room: Room) {
    const m = room.match;
    if (!m || m.pausedAt === null) return;
    m.deadline += this.now() - m.pausedAt;
    m.pausedAt = null;
  }

  resetToLobby(room: Room) {
    room.status = 'lobby';
    room.match = null;
    room.players.forEach((p) => (p.ready = false));
  }

  snapshot(room: Room): CaroSnapshot | null {
    const m = room.match;
    if (!m) return null;
    return {
      seq: m.seq,
      rule: m.state.rule,
      size: m.state.size,
      board: m.state.board,
      moves: m.state.moves,
      turn: m.state.turn,
      xSeat: m.xSeat,
      players: m.players,
      names: m.names,
      deadline: m.deadline,
      pausedAt: m.pausedAt,
      serverNow: this.now(),
      winnerSeat: m.winnerSeat,
      winLine: m.state.winLine,
      draw: m.state.draw,
      endReason: m.endReason,
      score: room.score,
      turnSeconds: room.settings.turnSeconds,
    };
  }
}
