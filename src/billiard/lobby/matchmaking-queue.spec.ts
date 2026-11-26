/// <reference types="jest" />
import { MatchmakingQueue, type QueueEntry } from './matchmaking-queue';
import { RANKING_CONFIG as R } from './ranking.config';

const e = (
  userId: string,
  rating: number,
  joinedAt = 0,
  mode: QueueEntry['mode'] = 'RANKED',
  ruleSet = 'three-5',
): QueueEntry => ({ userId, rating, joinedAt, mode, ruleSet });

describe('Hàng chờ ghép trận', () => {
  it('hai người rating gần nhau được ghép, thành trận chờ xác nhận', () => {
    const q = new MatchmakingQueue();
    q.join(e('a', 1000), null);
    q.join(e('b', 1030), null);
    const found = q.tick(1000);
    expect(found).toHaveLength(1);
    expect(found[0].players.map((p) => p.userId).sort()).toEqual(['a', 'b']);
    expect(q.isQueued('a')).toBe(false);
    expect(q.pendingFor('a')?.id).toBe(found[0].id);
  });
  it('không cần cùng trình độ: rating chênh nhiều vẫn ghép ngay', () => {
    const q = new MatchmakingQueue();
    q.join(e('a', 1000), null);
    q.join(e('b', 2400), null);
    expect(q.tick(1000)).toHaveLength(1);
  });
  it('ghép theo thứ tự vào hàng chờ (người chờ lâu nhất trước), không chọn theo rating', () => {
    const q = new MatchmakingQueue();
    q.join(e('a', 1000, 0), null);
    q.join(e('far', 1900, 1000), null);
    q.join(e('near', 1005, 2000), null);
    const [m] = q.tick(3000);
    expect(m.players.map((p) => p.userId)).toEqual(['a', 'far']);
    expect(q.queuedIds()).toEqual(['near']);
  });
  it('khác chế độ / luật thì không ghép', () => {
    const q = new MatchmakingQueue();
    q.join(e('a', 1000, 0, 'QUICK', 'free-10'), null);
    q.join(e('b', 1000, 0, 'QUICK', 'three-5'), null);
    q.join(e('c', 1000, 0, 'RANKED'), null);
    expect(q.tick(5000)).toHaveLength(0);
  });
  it('một người chỉ ở một hàng chờ; không ghép khi đang bận; huỷ tìm trận xoá đúng', () => {
    const q = new MatchmakingQueue();
    expect(q.join(e('a', 1000), null).ok).toBe(true);
    expect(q.join(e('a', 1000, 0, 'QUICK', 'free-10'), null).ok).toBe(false);
    expect(q.join(e('b', 1000), 'Bạn đang trong một trận đấu').ok).toBe(false);
    expect(q.cancel('a')).toBe(true);
    expect(q.cancel('a')).toBe(false);
    expect(q.tick(0)).toHaveLength(0);
  });
  it('không tạo trận trùng: tick nhiều lần, nhiều người cùng lúc', () => {
    const q = new MatchmakingQueue();
    for (let i = 0; i < 7; i++) q.join(e(`u${i}`, 1000 + i), null);
    const a = q.tick(1000);
    const b = q.tick(1000);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(0);
    const all = a.flatMap((m) => m.players.map((p) => p.userId));
    expect(new Set(all).size).toBe(all.length);
    expect(q.queuedIds()).toHaveLength(1);
  });
  it('cả hai xác nhận -> trận hoàn tất đúng 1 lần', () => {
    const q = new MatchmakingQueue();
    q.join(e('a', 1000), null);
    q.join(e('b', 1000), null);
    const [pm] = q.tick(0);
    const r1 = q.accept('a', pm.id);
    expect(r1.ok && r1.complete).toBeNull();
    const r2 = q.accept('b', pm.id);
    expect(r2.ok && r2.complete?.id).toBe(pm.id);
    expect(q.accept('b', pm.id).ok).toBe(false);
    expect(q.pendingFor('a')).toBeUndefined();
  });
  it('một người từ chối: người kia quay lại hàng chờ, người từ chối bị khoá', () => {
    const q = new MatchmakingQueue();
    q.join(e('a', 1000), null);
    q.join(e('b', 1000), null);
    const [pm] = q.tick(0);
    q.accept('a', pm.id);
    const r = q.reject(pm.id, 1000, 'b')!;
    expect(r.requeued).toEqual(['a']);
    expect(r.penalized).toEqual(['b']);
    expect(q.isQueued('a')).toBe(true);
    expect(q.join(e('b', 1000, 2000), null).ok).toBe(false);
    expect(
      q.join(e('b', 1000, 1000 + R.matchmaking.declineLockSeconds * 1000), null)
        .ok,
    ).toBe(true);
  });
  it('hết giờ xác nhận: người đã xác nhận quay lại, người không xác nhận bị khoá; không kẹt trạng thái', () => {
    const q = new MatchmakingQueue();
    q.join(e('a', 1000), null);
    q.join(e('b', 1000), null);
    const [pm] = q.tick(0);
    q.accept('b', pm.id);
    expect(q.expired(R.matchmaking.acceptSeconds * 1000 - 1)).toHaveLength(0);
    const exp = q.expired(R.matchmaking.acceptSeconds * 1000);
    expect(exp).toHaveLength(1);
    const r = q.reject(exp[0].id, R.matchmaking.acceptSeconds * 1000, null)!;
    expect(r.requeued).toEqual(['b']);
    expect(r.penalized).toEqual(['a']);
    expect(q.pendingFor('a')).toBeUndefined();
    expect(q.pendingFor('b')).toBeUndefined();
  });
  it('mất kết nối khi đang chờ xác nhận = từ chối', () => {
    const q = new MatchmakingQueue();
    q.join(e('a', 1000), null);
    q.join(e('b', 1000), null);
    q.tick(0);
    const r = q.drop('a', 100)!;
    expect(r.requeued).toEqual(['b']);
    expect(q.isQueued('a')).toBe(false);
  });
});
