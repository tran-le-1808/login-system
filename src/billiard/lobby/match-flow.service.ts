/**
 * Cầu nối trận đấu trong phòng (server quyết định người thắng) <-> xếp hạng / giải đấu.
 * Người thắng lấy từ snapshot server, không bao giờ từ client. Ghi kết quả idempotent theo matchId.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Room } from '../billiard.types';
import type { BracketMatch } from './bracket';
import { BilliardEventsService } from './events.service';
import { rankOf } from './ranking';
import {
  BilliardRankingService,
  type MatchResultOutput,
} from './ranking.service';
import { BilliardTournamentService } from './tournament.service';
import type { GameMode } from './store.types';

const MODE_OF: Record<Room['kind'], GameMode> = {
  casual: 'CASUAL',
  quick: 'QUICK',
  ranked: 'RANKED',
  tournament: 'TOURNAMENT',
};

export interface FinishOutcome {
  result: MatchResultOutput | null;
  /** Trận giải đấu vừa sẵn sàng (cần mở phòng) */
  ready: { tournamentId: string; match: BracketMatch }[];
}

@Injectable()
export class BilliardMatchFlowService {
  private readonly logger = new Logger('BilliardMatchFlow');

  constructor(
    private readonly ranking: BilliardRankingService,
    private readonly tournaments: BilliardTournamentService,
    private readonly events: BilliardEventsService,
  ) {}

  private ruleSetOf(room: Room): string {
    return (
      room.meta?.ruleSet ?? `${room.settings.mode}-${room.settings.target}`
    );
  }

  async onStarted(room: Room): Promise<void> {
    const m = room.snapshot;
    if (!m || !room.matchId || m.players.length !== 2) return;
    const names = m.players.map(
      (id) => room.players.find((p) => p.userId === id)?.name ?? 'Người chơi',
    ) as [string, string];
    await this.ranking.recordStart({
      matchId: room.matchId,
      roomCode: room.code,
      gameMode: MODE_OF[room.kind],
      ruleSet: this.ruleSetOf(room),
      players: [m.players[0], m.players[1]],
      names,
      tournamentId: room.meta?.tournamentId ?? null,
      tournamentMatchId: room.meta?.tournamentMatchId ?? null,
      startedAt: m.startedAt,
    });
  }

  /** Trận kết thúc (thắng điểm / bỏ cuộc / không vào trận). Gọi lại nhiều lần vẫn chỉ ghi 1 lần. */
  async onFinished(room: Room): Promise<FinishOutcome> {
    const m = room.snapshot;
    const out: FinishOutcome = { result: null, ready: [] };
    if (!m || m.winner === null || !room.matchId || m.players.length !== 2)
      return out;
    const players: [string, string] = [m.players[0], m.players[1]];
    const names = players.map(
      (id) => room.players.find((p) => p.userId === id)?.name ?? 'Người chơi',
    ) as [string, string];
    const result = await this.ranking.recordResult({
      matchId: room.matchId,
      roomCode: room.code,
      gameMode: MODE_OF[room.kind],
      ruleSet: this.ruleSetOf(room),
      players,
      names,
      winnerIndex: m.winner as 0 | 1,
      score: [m.scores[0], m.scores[1]],
      endReason: m.endReason ?? null,
      startedAt: m.startedAt,
      endedAt: m.endedAt ?? Date.now(),
      tournamentId: room.meta?.tournamentId ?? null,
      tournamentMatchId: room.meta?.tournamentMatchId ?? null,
    });
    if (!result) return out; // đã ghi trước đó
    out.result = result;
    const payload = {
      matchId: room.matchId,
      roomCode: room.code,
      gameMode: MODE_OF[room.kind],
      discipline: result.discipline,
      rated: result.rated,
      unratedReason: result.unratedReason,
      tournamentId: room.meta?.tournamentId ?? null,
    };
    for (const r of result.players) {
      this.events.toUsers([r.userId], 'bida:match:result', {
        ...payload,
        me: r,
        opponent: result.players.find((x) => x.userId !== r.userId),
      });
      if (room.kind === 'ranked') {
        this.events.toUsers([r.userId], 'bida:ranked:result', {
          ...payload,
          ...r,
          rank: rankOf(r.after),
        });
        if (result.rated)
          this.events.toUsers([r.userId], 'bida:ranked:rating-updated', {
            rating: r.after,
            delta: r.delta,
          });
        if (r.promoted || r.demoted)
          this.events.toUsers([r.userId], 'bida:ranked:rank-updated', {
            rankBefore: r.rankBefore,
            rankAfter: r.rankAfter,
            promoted: r.promoted,
          });
      }
    }
    if (
      room.kind === 'tournament' &&
      room.meta?.tournamentId &&
      room.meta.tournamentMatchId
    ) {
      const tr = await this.tournaments.reportResult(
        room.meta.tournamentId,
        room.meta.tournamentMatchId,
        players[m.winner],
        [m.scores[0], m.scores[1]],
      );
      if (tr.ok)
        for (const x of tr.data.ready)
          out.ready.push({ tournamentId: room.meta.tournamentId, match: x });
      else this.logger.warn(`Không cập nhật được nhánh đấu: ${tr.error}`);
    }
    return out;
  }

  /** Huỷ trận (không ai vào). Giải đấu: hạt giống cao hơn đi tiếp để nhánh đấu không bị kẹt. */
  async onCancelled(room: Room, reason: string): Promise<FinishOutcome> {
    const out: FinishOutcome = { result: null, ready: [] };
    if (!room.matchId) return out;
    await this.ranking.cancelMatch(room.matchId, reason);
    const ids = room.players.map((p) => p.userId);
    this.events.toUsers(ids, 'bida:match:cancelled', {
      matchId: room.matchId,
      roomCode: room.code,
      reason,
    });
    if (
      room.kind === 'tournament' &&
      room.meta?.tournamentId &&
      room.meta.tournamentMatchId
    ) {
      const t = await this.tournaments.get(room.meta.tournamentId);
      const bm = t?.bracket?.rounds
        .flat()
        .find((x) => x.id === room.meta!.tournamentMatchId);
      if (bm?.playerA) {
        const tr = await this.tournaments.reportResult(
          room.meta.tournamentId,
          bm.id,
          bm.playerA,
          null,
        );
        if (tr.ok)
          for (const x of tr.data.ready)
            out.ready.push({ tournamentId: room.meta.tournamentId, match: x });
      }
    }
    return out;
  }
}
