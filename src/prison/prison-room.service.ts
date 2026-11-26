import { Injectable } from '@nestjs/common';
import type {
  RoomMemberView,
  RoomSettings,
  RoomStatus,
  RoomView,
} from './shared/protocol';
import { MAX_PLAYERS } from './shared/protocol';
import type { ErrorCode, Role } from './shared/types';

export interface RoomUser {
  userId: string;
  name: string;
  avatar?: string;
}

export interface RoomMember extends RoomUser {
  role: Role;
  ready: boolean;
  connected: boolean;
  socketId: string | null;
  joinedAt: number;
}

export interface PrisonRoom {
  roomCode: string;
  hostId: string;
  status: RoomStatus;
  settings: RoomSettings;
  members: RoomMember[];
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
}

export type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROLES: Role[] = ['HACKER', 'FIGHTER', 'MECHANIC', 'SCOUT'];
export const DEFAULT_SETTINGS: RoomSettings = {
  prisonId: 'grey_stone',
  difficulty: 'NORMAL',
  allowLateJoin: false,
  privateRoom: false,
  maxPlayers: 4,
};

/** Bỏ khoá undefined (field tuỳ chọn của DTO class) để không ghi đè giá trị mặc định */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

const err = <T>(code: ErrorCode, message: string): RoomResult<T> => ({
  ok: false,
  code,
  message,
});

/**
 * Phòng chờ co-op 1–4 người (RAM, một instance). Mọi thao tác đồng bộ trong event loop
 * nên kiểm tra-rồi-ghi là nguyên tử (không có race giữa hai lệnh join).
 * Host chỉ là quyền ở phòng chờ — không phải quyền sửa game state.
 */
@Injectable()
export class PrisonRoomService {
  now = () => Date.now();
  random = () => Math.random();
  private rooms = new Map<string, PrisonRoom>();
  private userRoom = new Map<string, string>();

  normalizeCode(code: unknown): string {
    return typeof code === 'string'
      ? code
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 8)
      : '';
  }

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < 6; i++)
        c += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  get(code: string): PrisonRoom | undefined {
    return this.rooms.get(code);
  }

  all(): PrisonRoom[] {
    return [...this.rooms.values()];
  }

  roomOf(userId: string): PrisonRoom | undefined {
    const code = this.userRoom.get(userId);
    return code ? this.rooms.get(code) : undefined;
  }

  member(room: PrisonRoom, userId: string): RoomMember | undefined {
    return room.members.find((m) => m.userId === userId);
  }

  private freeRole(room: PrisonRoom): Role {
    return (
      ROLES.find((r) => !room.members.some((m) => m.role === r)) ?? 'SCOUT'
    );
  }

  create(
    user: RoomUser,
    socketId: string | null,
    settings: Partial<RoomSettings> = {},
  ): RoomResult<PrisonRoom> {
    if (this.userRoom.has(user.userId))
      return err('CONFLICT', 'Bạn đang ở trong một phòng khác');
    const now = this.now();
    const room: PrisonRoom = {
      roomCode: this.newCode(),
      hostId: user.userId,
      status: 'WAITING',
      settings: { ...DEFAULT_SETTINGS, ...defined(settings) },
      members: [],
      createdAt: now,
      updatedAt: now,
      sessionId: null,
    };
    room.members.push({
      ...user,
      role: 'HACKER',
      ready: false,
      connected: socketId !== null,
      socketId,
      joinedAt: now,
    });
    this.rooms.set(room.roomCode, room);
    this.userRoom.set(user.userId, room.roomCode);
    return { ok: true, value: room };
  }

  /** Dùng khi khôi phục phòng từ checkpoint sau khi server khởi động lại */
  restore(room: PrisonRoom): void {
    this.rooms.set(room.roomCode, room);
    for (const m of room.members) this.userRoom.set(m.userId, room.roomCode);
  }

  /** Vào phòng. Thành viên cũ vào lại = kết nối lại (idempotent, không nhân bản). */
  join(
    user: RoomUser,
    socketId: string | null,
    code: string,
  ): RoomResult<{ room: PrisonRoom; rejoined: boolean; lateJoin: boolean }> {
    const room = this.rooms.get(code);
    if (!room || room.status === 'CLOSED')
      return err('ROOM_NOT_FOUND', 'Không tìm thấy phòng');
    const existing = this.member(room, user.userId);
    if (existing) {
      existing.connected = socketId !== null;
      existing.socketId = socketId;
      existing.name = user.name;
      existing.avatar = user.avatar;
      room.updatedAt = this.now();
      return { ok: true, value: { room, rejoined: true, lateJoin: false } };
    }
    if (this.userRoom.has(user.userId))
      return err('CONFLICT', 'Bạn đang ở trong một phòng khác');
    if (room.members.length >= Math.min(MAX_PLAYERS, room.settings.maxPlayers))
      return err('ROOM_FULL', 'Phòng đã đủ người');
    const lateJoin = room.status === 'PLAYING' || room.status === 'PAUSED';
    if (lateJoin && !room.settings.allowLateJoin)
      return err(
        'INVALID_STATE',
        'Trận đã bắt đầu và không cho vào giữa chừng',
      );
    if (room.status !== 'WAITING' && !lateJoin)
      return err('INVALID_STATE', 'Phòng không nhận thêm người');
    room.members.push({
      ...user,
      role: this.freeRole(room),
      ready: false,
      connected: socketId !== null,
      socketId,
      joinedAt: this.now(),
    });
    room.updatedAt = this.now();
    this.userRoom.set(user.userId, code);
    return { ok: true, value: { room, rejoined: false, lateJoin } };
  }

  /** Rời phòng. Host rời -> chuyển host. Phòng trống -> CLOSED. */
  leave(userId: string): {
    room: PrisonRoom;
    closed: boolean;
    hostChanged: boolean;
  } | null {
    const room = this.roomOf(userId);
    if (!room) return null;
    room.members = room.members.filter((m) => m.userId !== userId);
    this.userRoom.delete(userId);
    room.updatedAt = this.now();
    if (!room.members.length) {
      room.status = 'CLOSED';
      this.rooms.delete(room.roomCode);
      return { room, closed: true, hostChanged: false };
    }
    let hostChanged = false;
    if (room.hostId === userId) hostChanged = this.transferHost(room);
    return { room, closed: false, hostChanged };
  }

  /** Chuyển host cho thành viên đang kết nối vào sớm nhất (hoặc bất kỳ ai còn lại) */
  transferHost(room: PrisonRoom): boolean {
    const next =
      [...room.members]
        .filter((m) => m.userId !== room.hostId && m.connected)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0] ??
      room.members.find((m) => m.userId !== room.hostId);
    if (!next) return false;
    room.hostId = next.userId;
    next.ready = false;
    return true;
  }

  setConnected(
    userId: string,
    socketId: string | null,
    connected: boolean,
  ): PrisonRoom | undefined {
    const room = this.roomOf(userId);
    const m = room && this.member(room, userId);
    if (!room || !m) return undefined;
    m.connected = connected;
    m.socketId = connected ? socketId : null;
    room.updatedAt = this.now();
    return room;
  }

  setReady(userId: string, ready: boolean): RoomResult<PrisonRoom> {
    const room = this.roomOf(userId);
    const m = room && this.member(room, userId);
    if (!room || !m) return err('NOT_ROOM_MEMBER', 'Bạn không ở trong phòng');
    if (room.status !== 'WAITING')
      return err('INVALID_STATE', 'Trận đã bắt đầu');
    m.ready = ready;
    return { ok: true, value: room };
  }

  setRole(userId: string, role: Role): RoomResult<PrisonRoom> {
    const room = this.roomOf(userId);
    const m = room && this.member(room, userId);
    if (!room || !m) return err('NOT_ROOM_MEMBER', 'Bạn không ở trong phòng');
    if (room.status !== 'WAITING')
      return err('INVALID_STATE', 'Trận đã bắt đầu');
    m.role = role;
    return { ok: true, value: room };
  }

  updateSettings(
    userId: string,
    patch: Partial<RoomSettings>,
  ): RoomResult<PrisonRoom> {
    const room = this.roomOf(userId);
    if (!room) return err('NOT_ROOM_MEMBER', 'Bạn không ở trong phòng');
    if (room.hostId !== userId)
      return err('FORBIDDEN', 'Chỉ chủ phòng được đổi cấu hình');
    if (room.status !== 'WAITING')
      return err('INVALID_STATE', 'Trận đã bắt đầu');
    const next = { ...room.settings, ...defined(patch) };
    if (next.maxPlayers < room.members.length)
      return err('INVALID_STATE', 'Số người tối đa nhỏ hơn số người đang có');
    room.settings = next;
    // Đổi luật -> mọi người phải xác nhận sẵn sàng lại
    for (const m of room.members) m.ready = false;
    room.updatedAt = this.now();
    return { ok: true, value: room };
  }

  startCheck(room: PrisonRoom, userId: string): RoomResult<PrisonRoom> {
    if (room.hostId !== userId)
      return err('FORBIDDEN', 'Chỉ chủ phòng được bắt đầu');
    if (room.status !== 'WAITING')
      return err('INVALID_STATE', 'Phòng không ở trạng thái chờ');
    const others = room.members.filter((m) => m.userId !== room.hostId);
    if (others.some((m) => !m.ready || !m.connected))
      return err('INVALID_STATE', 'Còn người chơi chưa sẵn sàng');
    if (!this.member(room, userId)?.connected)
      return err('INVALID_STATE', 'Chủ phòng đang mất kết nối');
    return { ok: true, value: room };
  }

  setStatus(room: PrisonRoom, status: RoomStatus): void {
    room.status = status;
    room.updatedAt = this.now();
  }

  close(room: PrisonRoom): void {
    room.status = 'CLOSED';
    for (const m of room.members) this.userRoom.delete(m.userId);
    this.rooms.delete(room.roomCode);
  }

  listPublic(): RoomView[] {
    return this.all()
      .filter(
        (r) =>
          !r.settings.privateRoom &&
          (r.status === 'WAITING' ||
            (r.settings.allowLateJoin &&
              (r.status === 'PLAYING' || r.status === 'PAUSED'))) &&
          r.members.length < r.settings.maxPlayers,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map((r) => this.toView(r));
  }

  toView(room: PrisonRoom): RoomView {
    return {
      roomCode: room.roomCode,
      hostId: room.hostId,
      status: room.status,
      settings: { ...room.settings },
      members: room.members.map(
        (m): RoomMemberView => ({
          userId: m.userId,
          name: m.name,
          avatar: m.avatar,
          role: m.role,
          ready: m.ready,
          connected: m.connected,
          isHost: m.userId === room.hostId,
          joinedAt: m.joinedAt,
        }),
      ),
      createdAt: room.createdAt,
    };
  }
}
