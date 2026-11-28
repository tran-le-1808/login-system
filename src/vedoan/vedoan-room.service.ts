import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import {
  drawerPoints,
  guessPoints,
  hintMask,
  isClose,
  isCorrect,
  leaksWord,
  nextReveal,
  parseCustomWords,
  pickChoices,
} from './shared/game';
import { sanitizeOps, type DrawOp } from './shared/draw';
import {
  CHOOSE_SECONDS,
  ChatKind,
  DRAW_OPTIONS,
  MAX_OPS,
  PublicRoom,
  REVEAL_SECONDS,
  ROUND_OPTIONS,
  Room,
  RoomChatMessage,
  RoomPlayer,
  VD_MAX_PLAYERS,
  VDRoomSettings,
  VDSnapshot,
  VDTurn,
} from './vedoan.types';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAT = 150;

export const DEFAULT_SETTINGS: VDRoomSettings = {
  isPrivate: false,
  quick: false,
  rounds: 3,
  drawSeconds: 80,
  hints: true,
  customWords: [],
  onlyCustom: false,
};

type NewPlayer = Pick<RoomPlayer, 'userId' | 'name' | 'avatar' | 'socketId'>;
export type ActResult = { ok: true } | { ok: false; error: string };

/** Kết quả xử lý một tin nhắn trong ván */
export type GuessResult =
  | { kind: 'correct'; points: number; ended: boolean }
  | { kind: 'close' }
  | { kind: 'chat' | 'guessed' }
  | { kind: 'blocked'; error: string };

/**
 * PHÒNG VẼ ĐOÁN (bộ nhớ trong) — server giữ đáp án, chấm đoán, đồng hồ, gợi ý, điểm, nét vẽ của lượt.
 * Đáp án chỉ gửi cho người vẽ và người đã đoán đúng.
 */
@Injectable()
export class VeDoanRoomService {
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
  all() {
    return [...this.rooms.values()];
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
    patch: (Partial<VDRoomSettings> & { customText?: unknown }) | undefined,
    base: VDRoomSettings,
  ): VDRoomSettings {
    const p = patch ?? {};
    const custom =
      typeof p.customText === 'string'
        ? parseCustomWords(p.customText)
        : Array.isArray(p.customWords)
          ? parseCustomWords(
              p.customWords.filter((w) => typeof w === 'string').join('\n'),
            )
          : base.customWords;
    return {
      isPrivate:
        typeof p.isPrivate === 'boolean' ? p.isPrivate : base.isPrivate,
      quick: typeof p.quick === 'boolean' ? p.quick : base.quick,
      rounds: ROUND_OPTIONS.includes(Number(p.rounds))
        ? Number(p.rounds)
        : base.rounds,
      drawSeconds: DRAW_OPTIONS.includes(Number(p.drawSeconds))
        ? Number(p.drawSeconds)
        : base.drawSeconds,
      hints: typeof p.hints === 'boolean' ? p.hints : base.hints,
      customWords: custom,
      onlyCustom:
        (typeof p.onlyCustom === 'boolean' ? p.onlyCustom : base.onlyCustom) &&
        custom.length >= 3,
    };
  }

  create(user: NewPlayer, settings?: Partial<VDRoomSettings>): Room {
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

  addPlayer(room: Room, user: NewPlayer): RoomPlayer | null {
    if (room.players.length >= VD_MAX_PLAYERS) return null;
    const used = new Set(room.players.map((p) => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
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
    if (room.match) {
      room.match.scores[user.userId] ??= 0;
      room.match.names[user.userId] = user.name;
    }
    return p;
  }

  /** Xoá người khỏi phòng; trả về true nếu phòng trống và bị xoá */
  removeUser(room: Room, userId: string): boolean {
    room.players = room.players.filter((p) => p.userId !== userId);
    if (this.userRoom.get(userId) === room.code) this.userRoom.delete(userId);
    delete room.voice[userId];
    if (!room.players.length) {
      this.rooms.delete(room.code);
      return true;
    }
    if (room.hostId === userId) this.transferHost(room);
    return false;
  }

  transferHost(room: Room) {
    const next =
      room.players.find((p) => p.userId !== room.hostId && p.connected) ??
      room.players.find((p) => p.userId !== room.hostId);
    if (next) room.hostId = next.userId;
    return next;
  }

  updateSettings(
    room: Room,
    patch: Partial<VDRoomSettings> & { customText?: unknown },
  ) {
    room.settings = this.sanitizeSettings(
      { ...patch, quick: room.settings.quick },
      room.settings,
    );
    room.players.forEach((p) => (p.ready = false));
  }

  toPublic(room: Room): PublicRoom {
    const { customWords, ...rest } = room.settings;
    return {
      code: room.code,
      hostId: room.hostId,
      status: room.status,
      settings: { ...rest, customCount: customWords.length },
      players: room.players.map(({ socketId: _s, ...p }) => {
        void _s;
        return p;
      }),
      createdAt: room.createdAt,
    };
  }

  listPublic(): PublicRoom[] {
    return this.all()
      .filter((r) => !r.settings.isPrivate && !r.settings.quick)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((r) => this.toPublic(r));
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

  /** Người này có đọc được tin loại `kind` không (tin của người đã đoán đúng chỉ người đoán đúng & người vẽ đọc) */
  canRead(room: Room, userId: string, kind: ChatKind): boolean {
    if (kind !== 'guessed') return true;
    const t = room.match?.turn;
    if (!t || room.status !== 'playing' || t.phase === 'reveal') return true;
    return t.drawer === userId || t.guessed.includes(userId);
  }
  chatFor(room: Room, userId: string) {
    return room.chat.filter(
      (c) => c.kind !== 'close' && this.canRead(room, userId, c.kind),
    );
  }

  // ------------------------------------------------------------------ ván chơi

  private presentIds(room: Room) {
    return room.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.userId);
  }

  startGame(room: Room): boolean {
    if (room.players.length < 2) return false;
    room.games += 1;
    room.status = 'playing';
    const order = this.presentIds(room);
    room.match = {
      round: 1,
      order,
      idx: 0,
      turn: this.blankTurn(order[0], 0),
      used: [],
      scores: Object.fromEntries(order.map((id) => [id, 0])),
      names: Object.fromEntries(room.players.map((p) => [p.userId, p.name])),
      turnSeq: 0,
      over: false,
      startedAt: this.now(),
    };
    this.startTurn(room);
    return true;
  }

  private blankTurn(drawer: string, id: number): VDTurn {
    return {
      id,
      drawer,
      choices: [],
      word: null,
      phase: 'choose',
      deadline: 0,
      drawStart: 0,
      revealed: [],
      guessed: [],
      gains: {},
      ops: [],
    };
  }

  /** Bắt đầu lượt của người kế tiếp (bỏ qua người đã rời) */
  private startTurn(room: Room) {
    const m = room.match!;
    const present = new Set(room.players.map((p) => p.userId));
    while (m.idx < m.order.length && !present.has(m.order[m.idx])) m.idx++;
    if (m.idx >= m.order.length) {
      m.round += 1;
      if (m.round > room.settings.rounds) return this.finish(room);
      m.order = this.presentIds(room);
      m.idx = 0;
    }
    m.turnSeq += 1;
    const t = this.blankTurn(m.order[m.idx], m.turnSeq);
    t.choices = pickChoices(
      new Set(m.used),
      room.settings.customWords,
      room.settings.onlyCustom,
      this.rng,
    );
    t.deadline = this.now() + CHOOSE_SECONDS * 1000;
    m.turn = t;
  }

  private finish(room: Room) {
    const m = room.match!;
    m.over = true;
    room.status = 'finished';
  }

  choose(room: Room, userId: string, index: unknown): ActResult {
    const t = room.match?.turn;
    if (room.status !== 'playing' || !t || t.phase !== 'choose')
      return { ok: false, error: 'Chưa tới lúc chọn từ' };
    if (t.drawer !== userId)
      return { ok: false, error: 'Không phải lượt vẽ của bạn' };
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= t.choices.length)
      return { ok: false, error: 'Từ không hợp lệ' };
    this.beginDraw(room, t.choices[i]);
    return { ok: true };
  }

  private beginDraw(room: Room, word: string) {
    const m = room.match!;
    const t = m.turn;
    t.word = word;
    t.phase = 'draw';
    t.drawStart = this.now();
    t.deadline = t.drawStart + room.settings.drawSeconds * 1000;
    m.used.push(word);
  }

  /** Lộ thêm 1 chữ cái (gọi theo mốc thời gian) */
  hint(room: Room, turnId: number): boolean {
    const t = room.match?.turn;
    if (
      !t ||
      t.id !== turnId ||
      t.phase !== 'draw' ||
      !t.word ||
      !room.settings.hints
    )
      return false;
    const next = nextReveal(t.word, t.revealed, this.rng);
    if (next.length === t.revealed.length) return false;
    t.revealed = next;
    return true;
  }

  /** Hết giờ giai đoạn hiện tại; trả về true nếu có thay đổi */
  expire(room: Room, turnId: number): boolean {
    const m = room.match;
    if (!m || room.status !== 'playing' || m.turn.id !== turnId) return false;
    const t = m.turn;
    if (t.phase === 'choose')
      this.beginDraw(
        room,
        t.choices[Math.floor(this.rng() * t.choices.length)],
      );
    else if (t.phase === 'draw') this.endTurn(room);
    else {
      m.idx += 1;
      this.startTurn(room);
    }
    return true;
  }

  /** Kết thúc phần vẽ: cộng điểm người vẽ, sang công bố đáp án */
  endTurn(room: Room) {
    const m = room.match!;
    const t = m.turn;
    if (t.phase === 'reveal') return;
    if (t.phase === 'choose' && !t.word) t.word = t.choices[0] ?? null;
    const others = room.players.filter((p) => p.userId !== t.drawer).length;
    const dp = drawerPoints(t.guessed.length, others);
    if (dp && room.players.some((p) => p.userId === t.drawer)) {
      t.gains[t.drawer] = dp;
      m.scores[t.drawer] = (m.scores[t.drawer] ?? 0) + dp;
    }
    t.phase = 'reveal';
    t.deadline = this.now() + REVEAL_SECONDS * 1000;
  }

  /** Còn ai chưa đoán đúng không (không tính người vẽ, người mất kết nối) */
  private allGuessed(room: Room) {
    const t = room.match!.turn;
    const need = room.players.filter(
      (p) => p.userId !== t.drawer && p.connected,
    );
    return need.length > 0 && need.every((p) => t.guessed.includes(p.userId));
  }

  /** Xử lý tin nhắn trong ván: đoán đúng / gần đúng / chat thường / chat của người đã đoán */
  guess(room: Room, userId: string, text: string): GuessResult {
    const m = room.match;
    if (room.status !== 'playing' || !m) return { kind: 'chat' };
    const t = m.turn;
    if (t.phase !== 'draw' || !t.word) return { kind: 'chat' };
    if (t.drawer === userId) {
      if (leaksWord(text, t.word))
        return { kind: 'blocked', error: 'Người vẽ không được nói đáp án' };
      return { kind: 'guessed' };
    }
    if (t.guessed.includes(userId)) return { kind: 'guessed' };
    if (isCorrect(text, t.word)) {
      const remaining = Math.max(0, t.deadline - this.now());
      const pts = guessPoints(
        remaining / (room.settings.drawSeconds * 1000),
        t.guessed.length,
      );
      t.guessed.push(userId);
      t.gains[userId] = pts;
      m.scores[userId] = (m.scores[userId] ?? 0) + pts;
      // người đoán đúng: rút ngắn giờ còn lại (giữ nhịp cho người chậm)
      const ended = this.allGuessed(room);
      if (ended) this.endTurn(room);
      return { kind: 'correct', points: pts, ended };
    }
    if (leaksWord(text, t.word)) return { kind: 'close' };
    if (isClose(text, t.word)) return { kind: 'close' };
    return { kind: 'chat' };
  }

  /** Thêm nét vẽ (chỉ người vẽ, đang vẽ) */
  draw(
    room: Room,
    userId: string,
    raw: unknown,
    turnId: unknown,
  ): DrawOp[] | string {
    const t = room.match?.turn;
    if (room.status !== 'playing' || !t || t.phase !== 'draw')
      return 'Chưa tới lúc vẽ';
    if (t.drawer !== userId) return 'Không phải lượt vẽ của bạn';
    if (turnId !== t.id) return 'Lượt đã đổi';
    const ops = sanitizeOps(raw);
    if (!ops) return 'Nét vẽ không hợp lệ';
    if (t.ops.length + ops.length > MAX_OPS) return 'Bức vẽ quá nhiều nét';
    t.ops.push(...ops);
    return ops;
  }

  /** Người rời / mất kết nối: người vẽ rời thì kết thúc lượt; còn < 2 người thì kết thúc ván */
  onLeave(room: Room, userId: string): 'none' | 'turn' | 'over' {
    const m = room.match;
    if (!m || room.status !== 'playing') return 'none';
    if (room.players.length < 2) {
      if (m.turn.phase !== 'reveal') this.endTurn(room);
      this.finish(room);
      return 'over';
    }
    if (m.turn.drawer === userId && m.turn.phase !== 'reveal') {
      this.endTurn(room);
      return 'turn';
    }
    if (m.turn.phase === 'draw' && this.allGuessed(room)) {
      this.endTurn(room);
      return 'turn';
    }
    return 'none';
  }

  resetToLobby(room: Room) {
    room.status = 'lobby';
    room.match = null;
    room.players.forEach((p) => (p.ready = false));
  }

  snapshotFor(room: Room, userId: string): VDSnapshot | null {
    const m = room.match;
    if (!m) return null;
    const t = m.turn;
    const isDrawer = t.drawer === userId;
    const knows =
      isDrawer || t.guessed.includes(userId) || t.phase === 'reveal' || m.over;
    const ids = [
      ...new Set([
        ...room.players
          .slice()
          .sort((a, b) => a.seat - b.seat)
          .map((p) => p.userId),
      ]),
    ];
    return {
      games: room.games,
      round: Math.min(m.round, room.settings.rounds),
      rounds: room.settings.rounds,
      phase: m.over ? 'over' : t.phase,
      turnId: t.id,
      drawer: t.drawer,
      isDrawer,
      choices: isDrawer && t.phase === 'choose' ? t.choices : [],
      word: knows ? t.word : null,
      mask: t.word ? hintMask(t.word, t.revealed) : '',
      deadline: t.deadline,
      serverNow: this.now(),
      drawSeconds: room.settings.drawSeconds,
      players: ids.map((id) => {
        const p = room.players.find((x) => x.userId === id);
        return {
          userId: id,
          name: p?.name ?? m.names[id] ?? '?',
          score: m.scores[id] ?? 0,
          gain: t.gains[id] ?? 0,
          connected: p?.connected ?? false,
          guessed: t.guessed.includes(id),
        };
      }),
      upcoming: m.order.slice(m.idx + 1),
      startedAt: m.startedAt,
    };
  }

  /** Nét vẽ hiện tại (cho người mới vào / kết nối lại) */
  opsFor(room: Room) {
    const t = room.match?.turn;
    return t ? { turnId: t.id, ops: t.ops } : null;
  }
}
