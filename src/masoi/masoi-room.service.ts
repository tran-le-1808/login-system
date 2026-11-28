import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import {
  act,
  deal,
  isWolf,
  MS_ERROR_VI,
  MS_MIN,
  pendingSeats,
  timeout,
  viewFor,
  type MSAction,
} from './shared/game';
import { botAction, type MSBotLevel } from './shared/bot';
import {
  ChatChannel,
  DISCUSS_OPTIONS,
  MS_MAX_PLAYERS,
  MSRoomSettings,
  MSSnapshot,
  PHASE_SECONDS,
  PublicRoom,
  Room,
  RoomChatMessage,
  RoomPlayer,
} from './masoi.types';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAT = 150;
const BOT_NAMES = [
  'Tí',
  'Tèo',
  'Bà Ba',
  'Chú Tư',
  'Cô Năm',
  'Ông Sáu',
  'Bé Bảy',
  'Anh Tám',
  'Chị Chín',
  'Lão Mười',
  'Út Mót',
];

export const DEFAULT_SETTINGS: MSRoomSettings = {
  isPrivate: false,
  discussSeconds: 90,
  quick: false,
  reveal: true,
};

type NewPlayer = Pick<RoomPlayer, 'userId' | 'name' | 'avatar' | 'socketId'>;
export type ActResult = { ok: true } | { ok: false; error: string };

const ACTION_KINDS = new Set([
  'kill',
  'see',
  'guard',
  'witch',
  'claim',
  'accuse',
  'ready',
  'vote',
  'shoot',
]);

/** Kiểm tra & chuẩn hoá hành động người chơi gửi lên */
export function parseAction(raw: unknown): MSAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.k !== 'string' || !ACTION_KINDS.has(a.k)) return null;
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) ? v : -99;
  switch (a.k) {
    case 'kill':
    case 'see':
    case 'guard':
    case 'accuse':
    case 'vote':
    case 'shoot':
      return { k: a.k, target: num(a.target) } as MSAction;
    case 'claim':
      return { k: 'claim', target: num(a.target), wolf: a.wolf === true };
    case 'witch':
      return {
        k: 'witch',
        save: a.save === true,
        poison: a.poison === undefined ? -1 : num(a.poison),
      };
    default:
      return { k: 'ready' };
  }
}

/**
 * PHÒNG MA SÓI (bộ nhớ trong) — server có thẩm quyền: chia vai, giai đoạn, đồng hồ, kết quả đêm, bỏ phiếu.
 * Mỗi người chỉ nhận góc nhìn của mình (viewFor). Máy (userId "bot:...") do server chơi.
 */
@Injectable()
export class MaSoiRoomService {
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
    patch: Partial<MSRoomSettings> | undefined,
    base: MSRoomSettings,
  ): MSRoomSettings {
    const p = patch ?? {};
    return {
      isPrivate:
        typeof p.isPrivate === 'boolean' ? p.isPrivate : base.isPrivate,
      discussSeconds: DISCUSS_OPTIONS.includes(Number(p.discussSeconds))
        ? Number(p.discussSeconds)
        : base.discussSeconds,
      quick: typeof p.quick === 'boolean' ? p.quick : base.quick,
      reveal: typeof p.reveal === 'boolean' ? p.reveal : base.reveal,
    };
  }

  create(user: NewPlayer, settings?: Partial<MSRoomSettings>): Room {
    const room: Room = {
      code: this.newCode(),
      hostId: user.userId,
      status: 'lobby',
      settings: this.sanitizeSettings(settings, DEFAULT_SETTINGS),
      players: [],
      chat: [],
      match: null,
      voice: {},
      games: 0,
      createdAt: this.now(),
    };
    this.rooms.set(room.code, room);
    this.addPlayer(room, user);
    return room;
  }

  private freeSeat(room: Room): number {
    const used = new Set(room.players.map((p) => p.seat));
    for (let s = 0; s < MS_MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return -1;
  }

  addPlayer(room: Room, user: NewPlayer): RoomPlayer | null {
    if (room.players.length >= MS_MAX_PLAYERS) return null;
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

  addBot(room: Room, level: MSBotLevel): RoomPlayer | null {
    if (room.players.length >= MS_MAX_PLAYERS) return null;
    const used = new Set(room.players.map((p) => p.name));
    const free = BOT_NAMES.filter((n) => !used.has(n));
    const p: RoomPlayer = {
      userId: `bot:${room.code}:${randomInt(1e9)}`,
      name: free.length ? free[randomInt(free.length)] : 'Máy',
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

  updateSettings(room: Room, patch: Partial<MSRoomSettings>) {
    room.settings = this.sanitizeSettings(
      { ...patch, quick: room.settings.quick },
      room.settings,
    );
    room.players.forEach((p) => (p.ready = !!p.botLevel));
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

  // ------------------------------------------------------------------ chat theo kênh

  seatOf(room: Room, userId: string) {
    return room.match ? room.match.players.indexOf(userId) : -1;
  }

  /** Kênh chat của người gửi (null = không được nói lúc này) */
  channelFor(room: Room, userId: string): ChatChannel | null {
    const m = room.match;
    if (room.status !== 'playing' || !m || m.state.phase === 'over')
      return 'all';
    const seat = this.seatOf(room, userId);
    if (seat < 0) return 'dead';
    const s = m.state;
    if (!s.alive[seat]) return 'dead';
    if (s.phase === 'night' || s.phase === 'witch')
      return isWolf(s.roles[seat]) ? 'wolf' : null;
    return 'all';
  }

  /** Người này có được đọc kênh đó không */
  canRead(room: Room, userId: string, channel: ChatChannel): boolean {
    if (channel === 'all') return true;
    const m = room.match;
    if (!m) return false;
    if (m.state.phase === 'over') return true;
    const seat = this.seatOf(room, userId);
    if (seat < 0 || !m.state.alive[seat]) return true;
    return channel === 'wolf' && isWolf(m.state.roles[seat]);
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

  chatFor(room: Room, userId: string) {
    return room.chat.filter((c) => this.canRead(room, userId, c.channel));
  }

  // ------------------------------------------------------------------ ván chơi

  startGame(room: Room) {
    const ps = room.players.slice().sort((a, b) => a.seat - b.seat);
    if (ps.length < MS_MIN) return false;
    const state = deal(ps.length, { reveal: room.settings.reveal }, this.rng);
    room.games += 1;
    room.status = 'playing';
    room.match = {
      state,
      players: ps.map((p) => p.userId),
      names: ps.map((p) => p.name),
      bots: ps.map((p) => p.botLevel ?? null),
      deadline: 0,
      deadlinePid: -1,
      startedAt: this.now(),
      seq: 0,
    };
    this.after(room);
    return true;
  }

  phaseSeconds(room: Room): number {
    const ph = room.match?.state.phase;
    if (ph === 'day') return room.settings.discussSeconds;
    return ph && ph in PHASE_SECONDS
      ? PHASE_SECONDS[ph as keyof typeof PHASE_SECONDS]
      : 0;
  }

  private after(room: Room) {
    const m = room.match!;
    m.seq += 1;
    if (m.state.phase === 'over') {
      room.status = 'finished';
      return;
    }
    if (m.deadlinePid !== m.state.pid) {
      m.deadlinePid = m.state.pid;
      m.deadline = this.now() + this.phaseSeconds(room) * 1000;
    }
  }

  act(room: Room, userId: string, raw: unknown): ActResult {
    const m = room.match;
    if (room.status !== 'playing' || !m)
      return { ok: false, error: 'Ván chưa bắt đầu' };
    const seat = this.seatOf(room, userId);
    if (seat < 0) return { ok: false, error: 'Bạn không ở trong ván' };
    const a = parseAction(raw);
    if (!a) return { ok: false, error: 'Hành động không hợp lệ' };
    const r = act(m.state, seat, a, this.rng);
    if (!r.ok) return { ok: false, error: MS_ERROR_VI[r.error] };
    m.state = r.state;
    this.after(room);
    return { ok: true };
  }

  /** Ghế máy còn phải hành động */
  pendingBots(room: Room): number[] {
    const m = room.match;
    if (!m || room.status !== 'playing') return [];
    return pendingSeats(m.state).filter((p) => !!m.bots[p]);
  }

  /** Máy ở ghế `seat` hành động một bước */
  botStep(room: Room, seat: number): boolean {
    const m = room.match;
    if (!m || room.status !== 'playing') return false;
    const level = m.bots[seat];
    if (!level) return false;
    const a = botAction(m.state, seat, level, this.rng);
    if (!a) return false;
    const r = act(m.state, seat, a, this.rng);
    if (!r.ok) return false;
    m.state = r.state;
    this.after(room);
    return true;
  }

  /** Hết giờ giai đoạn */
  expire(room: Room, pid: number): boolean {
    const m = room.match;
    if (!m || room.status !== 'playing' || m.state.pid !== pid) return false;
    m.state = timeout(m.state, this.rng);
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
    m.names[seat] = `${m.names[seat]} (máy thay)`;
    m.players[seat] = `bot:left:${userId}`;
  }

  resetToLobby(room: Room) {
    room.status = 'lobby';
    room.match = null;
    room.players.forEach((p) => (p.ready = !!p.botLevel));
  }

  snapshotFor(room: Room, userId: string): MSSnapshot | null {
    const m = room.match;
    if (!m) return null;
    const seat = m.players.indexOf(userId);
    return {
      ...viewFor(m.state, seat),
      seq: m.seq,
      players: m.players,
      names: m.names,
      bots: m.bots.map((b) => !!b),
      connected: m.players.map(
        (id) =>
          room.players.find((p) => p.userId === id)?.connected ??
          id.startsWith('bot:'),
      ),
      deadline: m.deadline,
      serverNow: this.now(),
      games: room.games,
      startedAt: m.startedAt,
    };
  }
}
