/**
 * Hàng chờ ghép trận (Quick / Ranked) — xử lý đồng bộ trong một tiến trình (thao tác nguyên tử).
 * Mỗi người chỉ ở 1 hàng chờ / 1 trận chờ xác nhận tại một thời điểm.
 * Chạy nhiều instance: thay bằng hàng chờ dùng chung (Redis) theo cùng giao diện.
 */
import { RANKING_CONFIG as R } from './ranking.config';

export type QueueMode = 'QUICK' | 'RANKED';

export interface QueueEntry {
  userId: string;
  mode: QueueMode;
  ruleSet: string;
  /** Rating lấy từ server (không tin client) */
  rating: number;
  joinedAt: number;
}

export interface PendingMatch {
  id: string;
  mode: QueueMode;
  ruleSet: string;
  players: [QueueEntry, QueueEntry];
  accepted: string[];
  deadline: number;
}

export type JoinResult =
  | { ok: true; entry: QueueEntry }
  | { ok: false; error: string };

export class MatchmakingQueue {
  private queue = new Map<string, QueueEntry>();
  private pending = new Map<string, PendingMatch>();
  private pendingOf = new Map<string, string>();
  private lockedUntil = new Map<string, number>();
  private seq = 0;

  constructor(private readonly idPrefix = 'mm') {}

  isQueued(userId: string): boolean {
    return this.queue.has(userId);
  }
  entryOf(userId: string): QueueEntry | undefined {
    return this.queue.get(userId);
  }
  pendingFor(userId: string): PendingMatch | undefined {
    const id = this.pendingOf.get(userId);
    return id ? this.pending.get(id) : undefined;
  }
  lockRemaining(userId: string, now: number): number {
    return Math.max(0, (this.lockedUntil.get(userId) ?? 0) - now);
  }
  queuedIds(): string[] {
    return [...this.queue.keys()];
  }
  pendingIds(): string[] {
    return [...this.pendingOf.keys()];
  }
  counts(): Record<QueueMode, number> {
    const c: Record<QueueMode, number> = { QUICK: 0, RANKED: 0 };
    for (const e of this.queue.values()) c[e.mode]++;
    return c;
  }

  /** Vào hàng chờ. `busy` = đang trong trận / giải đấu (kiểm tra ở ngoài, truyền vào). */
  join(entry: QueueEntry, busy: string | null): JoinResult {
    if (busy) return { ok: false, error: busy };
    if (this.queue.has(entry.userId))
      return { ok: false, error: 'Bạn đang tìm trận rồi' };
    if (this.pendingOf.has(entry.userId))
      return { ok: false, error: 'Bạn đang có trận chờ xác nhận' };
    const lock = this.lockRemaining(entry.userId, entry.joinedAt);
    if (lock > 0)
      return {
        ok: false,
        error: `Bạn bị khoá tìm trận ${Math.ceil(lock / 1000)} giây do từ chối trận`,
      };
    this.queue.set(entry.userId, entry);
    return { ok: true, entry };
  }

  cancel(userId: string): boolean {
    return this.queue.delete(userId);
  }

  /**
   * Ghép cặp theo thứ tự vào hàng chờ: người chờ lâu nhất gặp người chờ lâu kế tiếp cùng chế độ / luật.
   * KHÔNG lọc theo trình độ (rating chỉ dùng để tính điểm sau trận).
   */
  tick(now: number): PendingMatch[] {
    const created: PendingMatch[] = [];
    const waiting = [...this.queue.values()].sort(
      (a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId),
    );
    const used = new Set<string>();
    for (const a of waiting) {
      if (used.has(a.userId)) continue;
      const best =
        waiting.find(
          (b) =>
            b.userId !== a.userId &&
            !used.has(b.userId) &&
            b.mode === a.mode &&
            b.ruleSet === a.ruleSet,
        ) ?? null;
      if (!best) continue;
      used.add(a.userId).add(best.userId);
      this.queue.delete(a.userId);
      this.queue.delete(best.userId);
      const pm: PendingMatch = {
        id: `${this.idPrefix}-${now.toString(36)}-${++this.seq}`,
        mode: a.mode,
        ruleSet: a.ruleSet,
        players: [a, best],
        accepted: [],
        deadline: now + R.matchmaking.acceptSeconds * 1000,
      };
      this.pending.set(pm.id, pm);
      this.pendingOf.set(a.userId, pm.id).set(best.userId, pm.id);
      created.push(pm);
    }
    return created;
  }

  /** Xác nhận. Trả về trận khi cả hai đã xác nhận (trận được gỡ khỏi danh sách chờ — chỉ trả về đúng 1 lần). */
  accept(
    userId: string,
    pendingId: string,
  ):
    | { ok: false; error: string }
    | { ok: true; complete: PendingMatch | null } {
    const pm = this.pending.get(pendingId);
    if (!pm || this.pendingOf.get(userId) !== pendingId)
      return { ok: false, error: 'Trận không còn hiệu lực' };
    if (!pm.accepted.includes(userId)) pm.accepted.push(userId);
    if (pm.accepted.length < 2) return { ok: true, complete: null };
    this.closePending(pm);
    return { ok: true, complete: pm };
  }

  /**
   * Từ chối / hết giờ xác nhận: huỷ trận; người đã xác nhận quay lại hàng chờ (giữ thời gian chờ),
   * người từ chối / không xác nhận bị khoá tìm trận một lúc.
   */
  reject(
    pendingId: string,
    now: number,
    declinedBy: string | null,
  ): { pm: PendingMatch; requeued: string[]; penalized: string[] } | null {
    const pm = this.pending.get(pendingId);
    if (!pm) return null;
    this.closePending(pm);
    const requeued: string[] = [];
    const penalized: string[] = [];
    for (const p of pm.players) {
      const good = declinedBy
        ? p.userId !== declinedBy
        : pm.accepted.includes(p.userId);
      if (good) {
        this.queue.set(p.userId, { ...p });
        requeued.push(p.userId);
      } else {
        this.lockedUntil.set(
          p.userId,
          now + R.matchmaking.declineLockSeconds * 1000,
        );
        penalized.push(p.userId);
      }
    }
    return { pm, requeued, penalized };
  }

  expired(now: number): PendingMatch[] {
    return [...this.pending.values()].filter((p) => now >= p.deadline);
  }

  /** Mất kết nối hẳn: rời hàng chờ; nếu đang chờ xác nhận thì coi như từ chối */
  drop(userId: string, now: number): ReturnType<MatchmakingQueue['reject']> {
    this.queue.delete(userId);
    const pm = this.pendingFor(userId);
    return pm ? this.reject(pm.id, now, userId) : null;
  }

  private closePending(pm: PendingMatch): void {
    this.pending.delete(pm.id);
    for (const p of pm.players)
      if (this.pendingOf.get(p.userId) === pm.id)
        this.pendingOf.delete(p.userId);
  }
}
