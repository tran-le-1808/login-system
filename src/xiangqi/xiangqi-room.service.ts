import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import {
  applyMove,
  END_REASON_VI,
  MOVE_ERROR_VI,
  newGame,
  type Side,
} from './shared/rules';
import {
  PublicRoom,
  Room,
  RoomChatMessage,
  RoomPlayer,
  TIME_OPTIONS,
  XQ_MAX_PLAYERS,
  XqRoomSettings,
  XqSnapshot,
} from './xiangqi.types';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAT = 100;

export const DEFAULT_SETTINGS: XqRoomSettings = {
  isPrivate: false,
  timeMinutes: 10,
  quick: false,
};

type NewPlayer = Pick<RoomPlayer, 'userId' | 'name' | 'avatar' | 'socketId'>;
export type MoveResult = { ok: true } | { ok: false; error: string };

/**
 * PHÒNG CỜ TƯỚNG (bộ nhớ trong) — server có thẩm quyền: luật, lượt, đồng hồ, thắng thua, xin hoà.
 */
@Injectable()
export class XiangqiRoomService {
  private rooms = new Map<string, Room>();
  private userRoom = new Map<string, string>();
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
    patch: Partial<XqRoomSettings> | undefined,
    base: XqRoomSettings,
  ): XqRoomSettings {
    const p = patch ?? {};
    const timeMinutes = TIME_OPTIONS.includes(Number(p.timeMinutes))
      ? Number(p.timeMinutes)
      : base.timeMinutes;
    return {
      isPrivate:
        typeof p.isPrivate === 'boolean' ? p.isPrivate : base.isPrivate,
      timeMinutes,
      quick: typeof p.quick === 'boolean' ? p.quick : base.quick,
    };
  }

  create(user: NewPlayer, settings?: Partial<XqRoomSettings>): Room {
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
    if (room.players.length >= XQ_MAX_PLAYERS) return null;
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

  updateSettings(room: Room, patch: Partial<XqRoomSettings>) {
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
    const redSeat = room.games % 2;
    const t = this.now();
    const ms = room.settings.timeMinutes * 60_000;
    room.games += 1;
    room.status = 'playing';
    room.match = {
      state: newGame(),
      redSeat,
      players: [seats[0].userId, seats[1].userId],
      names: [seats[0].name, seats[1].name],
      clocks: [ms, ms],
      turnStart: t,
      pausedAt: null,
      drawOffer: null,
      winnerSeat: null,
      endReason: null,
      startedAt: t,
      endedAt: null,
      seq: 0,
    };
  }

  /** Ghế của một bên màu */
  seatOfSide(room: Room, side: Side): number {
    const m = room.match!;
    return side === 1 ? m.redSeat : 1 - m.redSeat;
  }

  turnSeat(room: Room): number {
    return this.seatOfSide(room, room.match!.state.turn);
  }

  seatOf(room: Room, userId: string): number {
    return room.match ? room.match.players.indexOf(userId) : -1;
  }

  /** Thời điểm hết giờ của bên đang tới lượt */
  deadline(room: Room): number {
    const m = room.match!;
    return m.turnStart + m.clocks[this.turnSeat(room)];
  }

  move(room: Room, userId: string, body: unknown): MoveResult {
    const m = room.match;
    if (room.status !== 'playing' || !m)
      return { ok: false, error: 'Ván chưa bắt đầu' };
    const seat = this.seatOf(room, userId);
    if (seat < 0) return { ok: false, error: 'Bạn không phải người chơi' };
    if (seat !== this.turnSeat(room))
      return { ok: false, error: MOVE_ERROR_VI.NOT_YOUR_TURN };
    const b = (body ?? {}) as { from?: unknown; to?: unknown; seq?: unknown };
    if (typeof b.seq === 'number' && b.seq !== m.seq)
      return { ok: false, error: 'Bàn cờ đã thay đổi, hãy thử lại' };
    const t = this.now();
    if (m.pausedAt === null && t >= this.deadline(room))
      return { ok: false, error: 'Bạn đã hết giờ' };
    const r = applyMove(m.state, Number(b.from), Number(b.to));
    if (!r.ok) return { ok: false, error: MOVE_ERROR_VI[r.error] };
    // trừ thời gian đã nghĩ
    if (m.pausedAt === null)
      m.clocks[seat] = Math.max(0, m.clocks[seat] - (t - m.turnStart));
    m.state = r.state;
    m.turnStart = t;
    m.pausedAt = null;
    // đi một nước = từ chối lời xin hoà của đối thủ (nếu có)
    if (m.drawOffer !== null && m.drawOffer !== seat) m.drawOffer = null;
    m.seq += 1;
    const s = r.state;
    if (s.winner !== null) {
      const ws = this.seatOfSide(room, s.winner);
      this.finish(
        room,
        ws,
        `${m.names[ws]} thắng — ${END_REASON_VI[s.endReason!]}`,
      );
    } else if (s.draw)
      this.finish(room, null, `Hoà — ${END_REASON_VI[s.endReason!]}`);
    return { ok: true };
  }

  private finish(room: Room, winnerSeat: number | null, reason: string) {
    const m = room.match!;
    m.winnerSeat = winnerSeat;
    m.endReason = reason;
    m.endedAt = this.now();
    m.drawOffer = null;
    m.seq += 1;
    room.status = 'finished';
    if (winnerSeat !== null) room.score[winnerSeat] += 1;
  }

  /** Hết giờ -> bên tới lượt thua. Trả về true nếu ván kết thúc. */
  timeout(room: Room): boolean {
    const m = room.match;
    if (room.status !== 'playing' || !m || m.pausedAt !== null) return false;
    if (this.now() < this.deadline(room)) return false;
    const loser = this.turnSeat(room);
    m.clocks[loser] = 0;
    this.finish(room, 1 - loser, `${m.names[loser]} hết giờ — xử thua`);
    return true;
  }

  forfeit(room: Room, userId: string, reason: string): boolean {
    if (room.status !== 'playing' || !room.match) return false;
    const seat = this.seatOf(room, userId);
    if (seat < 0) return false;
    this.finish(room, 1 - seat, reason);
    return true;
  }

  /** Xin hoà; nếu đối thủ cũng đang xin hoà thì hoà luôn (agreed) */
  offerDraw(
    room: Room,
    userId: string,
  ): { ok: true; agreed: boolean } | { ok: false; error: string } {
    const m = room.match;
    if (room.status !== 'playing' || !m)
      return { ok: false, error: 'Không có ván nào đang diễn ra' };
    const seat = this.seatOf(room, userId);
    if (seat < 0) return { ok: false, error: 'Bạn không phải người chơi' };
    if (m.drawOffer === 1 - seat) {
      this.finish(room, null, 'Hoà — hai bên đồng ý');
      return { ok: true, agreed: true };
    }
    if (m.drawOffer === seat)
      return { ok: false, error: 'Bạn đã xin hoà, đang chờ đối thủ' };
    m.drawOffer = seat;
    m.seq += 1;
    return { ok: true, agreed: false };
  }

  /** Đối thủ trả lời lời xin hoà */
  answerDraw(room: Room, userId: string, accept: boolean): boolean {
    const m = room.match;
    if (room.status !== 'playing' || !m || m.drawOffer === null) return false;
    const seat = this.seatOf(room, userId);
    if (seat < 0 || seat === m.drawOffer) return false;
    if (accept) this.finish(room, null, 'Hoà — hai bên đồng ý');
    else {
      m.drawOffer = null;
      m.seq += 1;
    }
    return true;
  }

  pauseClock(room: Room) {
    const m = room.match;
    if (!m || m.pausedAt !== null || room.status !== 'playing') return;
    const t = this.now();
    const seat = this.turnSeat(room);
    m.clocks[seat] = Math.max(0, m.clocks[seat] - (t - m.turnStart));
    m.turnStart = t;
    m.pausedAt = t;
  }

  resumeClock(room: Room) {
    const m = room.match;
    if (!m || m.pausedAt === null) return;
    m.turnStart = this.now();
    m.pausedAt = null;
  }

  resetToLobby(room: Room) {
    room.status = 'lobby';
    room.match = null;
    room.players.forEach((p) => (p.ready = false));
  }

  snapshot(room: Room): XqSnapshot | null {
    const m = room.match;
    if (!m) return null;
    return {
      seq: m.seq,
      board: m.state.board,
      moves: m.state.moves,
      captures: m.state.captures,
      checks: m.state.checks,
      turn: m.state.turn,
      redSeat: m.redSeat,
      players: m.players,
      names: m.names,
      clocks: m.clocks,
      turnStart: m.turnStart,
      pausedAt: m.pausedAt,
      serverNow: this.now(),
      drawOffer: m.drawOffer,
      winnerSeat: m.winnerSeat,
      draw:
        m.state.draw || (room.status === 'finished' && m.winnerSeat === null),
      endReason: m.endReason,
      score: room.score,
      timeMinutes: room.settings.timeMinutes,
    };
  }
}
