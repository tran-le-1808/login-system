import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import {
  deal,
  draw,
  pass,
  play,
  playable,
  scoreOf,
  SM_ERROR_VI,
  type ActResult as SMActResult,
} from './shared/cards';
import { botAction, type SMBotLevel } from './shared/bot';
import {
  PublicRoom,
  Room,
  RoomChatMessage,
  RoomPlayer,
  SM_MAX_PLAYERS,
  SMRoomSettings,
  SMSnapshot,
  TURN_OPTIONS,
} from './sacmau.types';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAT = 100;
const BOT_NAMES = ['Máy Ba', 'Máy Tư', 'Máy Năm', 'Máy Sáu'];

export const DEFAULT_SETTINGS: SMRoomSettings = {
  isPrivate: false,
  turnSeconds: 20,
  quick: false,
  stack: true,
};

type NewPlayer = Pick<RoomPlayer, 'userId' | 'name' | 'avatar' | 'socketId'>;
export type ActResult = { ok: true } | { ok: false; error: string };

/**
 * PHÒNG SẮC MÀU (bộ nhớ trong) — server có thẩm quyền: chia bài, lượt, luật, đồng hồ, điểm.
 * Máy (bot) là người chơi trong phòng (userId "bot:..."), server tự đánh cho máy.
 */
@Injectable()
export class SacMauRoomService {
  private rooms = new Map<string, Room>();
  private userRoom = new Map<string, string>();
  now: () => number = () => Date.now();
  rng: () => number = Math.random;

  normalizeCode(code: unknown): string {
    return typeof code === 'string'
      ? code.trim().toUpperCase().slice(0, 6)
      : '';
  }
  get(code: string) {
    return this.rooms.get(code);
  }
  getRoomOfUser(userId: string) {
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
    patch: Partial<SMRoomSettings> | undefined,
    base: SMRoomSettings,
  ): SMRoomSettings {
    const p = patch ?? {};
    return {
      isPrivate:
        typeof p.isPrivate === 'boolean' ? p.isPrivate : base.isPrivate,
      turnSeconds: TURN_OPTIONS.includes(Number(p.turnSeconds))
        ? Number(p.turnSeconds)
        : base.turnSeconds,
      quick: typeof p.quick === 'boolean' ? p.quick : base.quick,
      stack: typeof p.stack === 'boolean' ? p.stack : base.stack,
    };
  }

  create(user: NewPlayer, settings?: Partial<SMRoomSettings>): Room {
    const room: Room = {
      code: this.newCode(),
      hostId: user.userId,
      status: 'lobby',
      settings: this.sanitizeSettings(settings, DEFAULT_SETTINGS),
      players: [],
      chat: [],
      match: null,
      scores: {},
      lastWinner: null,
      games: 0,
      createdAt: this.now(),
    };
    this.rooms.set(room.code, room);
    this.addPlayer(room, user);
    return room;
  }

  private freeSeat(room: Room): number {
    const used = new Set(room.players.map((p) => p.seat));
    return [0, 1, 2, 3].find((s) => !used.has(s)) ?? -1;
  }

  addPlayer(room: Room, user: NewPlayer): RoomPlayer | null {
    if (room.players.length >= SM_MAX_PLAYERS) return null;
    const p: RoomPlayer = {
      ...user,
      seat: this.freeSeat(room),
      ready: false,
      connected: true,
      joinedAt: this.now(),
      botLevel: null,
    };
    room.players.push(p);
    room.players.sort((a, b) => a.seat - b.seat);
    this.userRoom.set(user.userId, room.code);
    return p;
  }

  addBot(room: Room, level: SMBotLevel): RoomPlayer | null {
    if (room.players.length >= SM_MAX_PLAYERS) return null;
    const used = new Set(room.players.map((p) => p.name));
    const p: RoomPlayer = {
      userId: `bot:${room.code}:${randomInt(1e9)}`,
      name: BOT_NAMES.find((n) => !used.has(n)) ?? 'Máy',
      seat: this.freeSeat(room),
      ready: true,
      connected: true,
      socketId: null,
      joinedAt: this.now(),
      botLevel: level,
    };
    room.players.push(p);
    room.players.sort((a, b) => a.seat - b.seat);
    return p;
  }

  /** Xoá người khỏi phòng; trả về true nếu phòng bị xoá (không còn người thật) */
  removeUser(room: Room, userId: string): boolean {
    room.players = room.players.filter((p) => p.userId !== userId);
    if (this.userRoom.get(userId) === room.code) this.userRoom.delete(userId);
    if (!room.players.some((p) => !p.botLevel)) {
      for (const p of room.players) this.userRoom.delete(p.userId);
      this.rooms.delete(room.code);
      return true;
    }
    if (room.hostId === userId) this.transferHost(room);
    room.players.forEach((p) => (p.ready = !!p.botLevel));
    return false;
  }

  transferHost(room: Room) {
    const next =
      room.players.find(
        (p) => !p.botLevel && p.userId !== room.hostId && p.connected,
      ) ?? room.players.find((p) => !p.botLevel && p.userId !== room.hostId);
    if (next) room.hostId = next.userId;
    return next;
  }

  updateSettings(room: Room, patch: Partial<SMRoomSettings>) {
    room.settings = this.sanitizeSettings(
      { ...patch, quick: room.settings.quick },
      room.settings,
    );
    room.players.forEach((p) => (p.ready = !!p.botLevel));
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

  // ------------------------------------------------------------------ ván bài

  startGame(room: Room) {
    const ps = room.players.slice().sort((a, b) => a.seat - b.seat);
    const players = ps.map((p) => p.userId);
    const starterIdx =
      room.lastWinner !== null ? players.indexOf(room.lastWinner) : -1;
    const state = deal(
      ps.length,
      starterIdx >= 0 ? starterIdx : Math.floor(this.rng() * ps.length),
      { stack: room.settings.stack },
      this.rng,
    );
    room.games += 1;
    room.status = 'playing';
    for (const id of players) room.scores[id] ??= 0;
    room.match = {
      state,
      players,
      names: ps.map((p) => p.name),
      bots: ps.map((p) => p.botLevel ?? null),
      deadline: this.now() + room.settings.turnSeconds * 1000,
      lastScores: null,
      seq: 0,
    };
    if (state.over) this.finish(room);
  }

  seatOf(room: Room, userId: string) {
    return room.match ? room.match.players.indexOf(userId) : -1;
  }

  private after(room: Room) {
    const m = room.match!;
    m.seq += 1;
    if (m.state.over) this.finish(room);
    else m.deadline = this.now() + room.settings.turnSeconds * 1000;
  }

  private finish(room: Room) {
    const m = room.match!;
    m.lastScores = scoreOf(m.state);
    m.players.forEach(
      (id, i) => (room.scores[id] = (room.scores[id] ?? 0) + m.lastScores![i]),
    );
    room.lastWinner =
      m.state.winner !== null ? (m.players[m.state.winner] ?? null) : null;
    room.status = 'finished';
  }

  act(
    room: Room,
    userId: string,
    body: {
      kind: 'play' | 'draw' | 'pass';
      card?: unknown;
      color?: unknown;
      call?: unknown;
      seq?: unknown;
    },
  ): ActResult {
    const m = room.match;
    if (room.status !== 'playing' || !m)
      return { ok: false, error: 'Ván chưa bắt đầu' };
    const seat = this.seatOf(room, userId);
    if (seat < 0) return { ok: false, error: 'Bạn không ở trong ván' };
    if (typeof body.seq === 'number' && body.seq !== m.seq)
      return { ok: false, error: 'Bàn đã thay đổi, hãy thử lại' };
    let r: SMActResult;
    if (body.kind === 'draw') r = draw(m.state, seat, this.rng);
    else if (body.kind === 'pass') r = pass(m.state, seat, this.rng);
    else
      r = play(
        m.state,
        seat,
        Number(body.card),
        body.color === undefined ? undefined : Number(body.color),
        body.call === true,
        this.rng,
      );
    if (!r.ok) return { ok: false, error: SM_ERROR_VI[r.error] };
    m.state = r.state;
    this.after(room);
    return { ok: true };
  }

  /** Máy đi cho máy; người hết giờ: bốc bài rồi bỏ lượt */
  autoAct(room: Room, asBot: boolean): boolean {
    const m = room.match;
    if (room.status !== 'playing' || !m) return false;
    const seat = m.state.turn;
    const level = m.bots[seat];
    let r: SMActResult;
    if (asBot && level) {
      const a = botAction(m.state, seat, level, this.rng);
      r =
        a.kind === 'play'
          ? play(m.state, seat, a.card, a.color, a.call, this.rng)
          : a.kind === 'draw'
            ? draw(m.state, seat, this.rng)
            : pass(m.state, seat, this.rng);
    } else {
      r =
        m.state.drawn !== null
          ? pass(m.state, seat, this.rng)
          : draw(m.state, seat, this.rng);
      if (r.ok && r.state.drawn !== null && r.state.turn === seat)
        r = pass(r.state, seat, this.rng);
    }
    if (!r.ok) return false;
    m.state = r.state;
    this.after(room);
    return true;
  }

  /** Người rời giữa ván: máy chơi thay cho hết ván */
  replaceWithBot(room: Room, userId: string) {
    const m = room.match;
    if (!m || room.status !== 'playing') return;
    const seat = this.seatOf(room, userId);
    if (seat < 0) return;
    m.bots[seat] = 'normal';
    m.names[seat] = `${m.names[seat]} (máy đánh thay)`;
    m.players[seat] = `bot:left:${userId}`;
  }

  turnIsBot(room: Room): boolean {
    const m = room.match;
    return (
      !!m &&
      room.status === 'playing' &&
      !!m.bots[m.state.turn] &&
      !m.state.over
    );
  }

  resetToLobby(room: Room) {
    room.status = 'lobby';
    room.match = null;
    room.players.forEach((p) => (p.ready = !!p.botLevel));
  }

  snapshotFor(room: Room, userId: string): SMSnapshot | null {
    const m = room.match;
    if (!m) return null;
    const s = m.state;
    const mySeat = m.players.indexOf(userId);
    const conn = m.players.map(
      (id) => room.players.find((p) => p.userId === id)?.connected ?? false,
    );
    const myTurn = mySeat >= 0 && s.turn === mySeat && !s.over;
    return {
      seq: m.seq,
      n: s.n,
      mySeat,
      players: m.players,
      names: m.names,
      bots: m.bots.map((b) => !!b),
      connected: conn,
      counts: s.hands.map((h) => h.length),
      hand: mySeat >= 0 ? s.hands[mySeat] : [],
      top: s.discard[s.discard.length - 1],
      color: s.color,
      dir: s.dir,
      turn: s.turn,
      pending: s.pending,
      drawn: myTurn ? s.drawn : null,
      playable: myTurn ? playable(s, mySeat) : [],
      pileCount: s.pile.length,
      called: s.called,
      stack: s.settings.stack,
      over: s.over,
      winner: s.winner,
      events: s.events.slice(-6),
      deadline: m.deadline,
      serverNow: this.now(),
      turnSeconds: room.settings.turnSeconds,
      scores: m.players.map((id) => room.scores[id] ?? 0),
      lastScores: m.lastScores,
      revealed: s.over ? s.hands : null,
      games: room.games,
    };
  }
}
