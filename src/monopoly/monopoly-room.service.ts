import { Injectable } from '@nestjs/common';
import {
  MONOPOLY_MAX_PLAYERS,
  PublicRoom,
  Room,
  RoomChatMessage,
  RoomPlayer,
  RoomSettings,
} from './monopoly.types';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_CHAT_HISTORY = 50;

export const DEFAULT_SETTINGS: RoomSettings = {
  isPrivate: false,
  startingMoney: 10000,
};

export const ALLOWED_STARTING_MONEY = [10000, 15000, 20000, 30000];

/**
 * Lưu trữ phòng Cờ Tỷ Phú trong bộ nhớ.
 * Phòng chỉ tồn tại khi server đang chạy (đủ cho chơi online thời gian thực).
 */
@Injectable()
export class MonopolyRoomService {
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

  listPublicLobbies(): PublicRoom[] {
    return Array.from(this.rooms.values())
      .filter(
        (r) =>
          r.status === 'lobby' &&
          !r.settings.isPrivate &&
          r.players.length < MONOPOLY_MAX_PLAYERS,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map((r) => this.toPublic(r));
  }

  create(user: Omit<RoomPlayer, 'seat' | 'ready' | 'connected' | 'joinedAt'>) {
    const code = this.generateCode();
    const room: Room = {
      code,
      hostId: user.userId,
      status: 'lobby',
      settings: { ...DEFAULT_SETTINGS },
      players: [],
      snapshot: null,
      chat: [],
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    this.addPlayer(room, user);
    return room;
  }

  private firstFreeSeat(room: Room): number {
    const taken = new Set(room.players.map((p) => p.seat));
    for (let s = 0; s < MONOPOLY_MAX_PLAYERS; s++) {
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
    if (!Number.isInteger(seat) || seat < 0 || seat >= MONOPOLY_MAX_PLAYERS)
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
    if (
      typeof patch.startingMoney === 'number' &&
      ALLOWED_STARTING_MONEY.includes(patch.startingMoney)
    ) {
      next.startingMoney = patch.startingMoney;
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

  resetToLobby(room: Room) {
    room.status = 'lobby';
    room.snapshot = null;
    room.players.forEach((p) => (p.ready = false));
  }
}
