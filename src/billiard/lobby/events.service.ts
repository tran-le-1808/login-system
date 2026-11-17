/** Phát sự kiện tới đúng người liên quan (không broadcast toàn hệ thống) */
import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

export const userRoomKey = (userId: string) => `bida:user:${userId}`;
export const tournamentRoomKey = (id: string) => `bida:tournament:${id}`;
export const LOBBY_ROOM = 'bida:lobby';

@Injectable()
export class BilliardEventsService {
  private server: Server | null = null;

  attach(server: Server): void {
    this.server = server;
  }

  toUsers(userIds: string[], event: string, data: unknown): void {
    if (!this.server || !userIds.length) return;
    this.server.to(userIds.map(userRoomKey)).emit(event, data);
  }

  toTournament(id: string, event: string, data: unknown): void {
    this.server?.to(tournamentRoomKey(id)).emit(event, data);
  }

  toLobby(event: string, data: unknown): void {
    this.server?.to(LOBBY_ROOM).emit(event, data);
  }

  async isOnline(userId: string): Promise<boolean> {
    if (!this.server) return false;
    return (
      (await this.server.in(userRoomKey(userId)).fetchSockets()).length > 0
    );
  }
}
