/// <reference types="jest" />
import {
  DEFAULT_MATCH_TARGET,
  RANKING_CONFIG as R,
  RULE_SETS,
} from './ranking.config';
import {
  eloUpdate,
  expectedScore,
  kFactorFor,
  levelOf,
  rankOf,
  rankProgress,
  searchRange,
  softReset,
  winRate,
} from './ranking';

describe('Elo & rank', () => {
  it('điểm kỳ vọng cân bằng khi bằng rating, đúng công thức khi chênh', () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5);
    expect(expectedScore(1400, 1000)).toBeCloseTo(
      1 / (1 + Math.pow(10, -400 / 400)),
    );
  });
  it('thắng tăng, thua giảm; tổng thay đổi bằng 0 khi K bằng nhau', () => {
    const r = eloUpdate(1000, 1000, 1, 32, 32);
    expect(r.deltaA).toBe(16);
    expect(r.deltaB).toBe(-16);
    const upset = eloUpdate(1000, 1400, 1, 32, 32);
    expect(upset.deltaA).toBeGreaterThan(25); // thắng người mạnh hơn được nhiều điểm
    const lose = eloUpdate(1000, 1000, 0, 32, 32);
    expect(lose.a).toBe(984);
  });
  it('rating không âm; K tạm thời cho người mới', () => {
    expect(eloUpdate(5, 2000, 0, 48, 32).a).toBeGreaterThanOrEqual(0);
    expect(kFactorFor(0)).toBe(R.kFactorProvisional);
    expect(kFactorFor(R.provisionalMatches)).toBe(R.kFactor);
  });
  it('mốc rank theo cấu hình; tiến độ tới rank kế', () => {
    expect(rankOf(999).id).toBe('BRONZE');
    expect(rankOf(1000).id).toBe('SILVER');
    expect(rankOf(1399).id).toBe('GOLD');
    expect(rankOf(2500).id).toBe('GRANDMASTER');
    const p = rankProgress(1100);
    expect(p.next?.id).toBe('GOLD');
    expect(p.progress).toBeCloseTo(0.5);
    expect(rankProgress(2100).next).toBeNull();
  });
  it('thăng hạng / tụt hạng qua một trận', () => {
    const up = eloUpdate(1195, 1195, 1, 32, 32);
    expect(rankOf(1195).id).toBe('SILVER');
    expect(rankOf(up.a).id).toBe('GOLD');
    expect(rankOf(up.b).id).toBe('SILVER');
    const down = eloUpdate(1205, 1205, 0, 32, 32);
    expect(rankOf(down.a).id).toBe('SILVER');
  });
  it('khoảng tìm trận nới theo thời gian chờ: 50 / 100 / 150 rồi tiếp tục, có trần', () => {
    expect(searchRange(0)).toBe(50);
    expect(searchRange(9)).toBe(50);
    expect(searchRange(10)).toBe(100);
    expect(searchRange(25)).toBe(150);
    expect(searchRange(40)).toBeGreaterThan(150);
    expect(searchRange(100000)).toBe(R.matchmaking.maxRange);
  });
  it('reset mềm, level, tỉ lệ thắng', () => {
    expect(softReset(1600)).toBe(1300);
    expect(softReset(800)).toBe(900);
    expect(levelOf(0).level).toBe(1);
    expect(levelOf(50).level).toBe(2);
    expect(winRate(3, 1)).toBe(75);
    expect(winRate(0, 0)).toBe(0);
  });
  it('quick & ranked: chỉ đánh 15 điểm, cả Libre và 3 băng', () => {
    expect(RULE_SETS.map((r) => r.id)).toEqual(['free-15', 'three-15']);
    expect(R.matchmaking.quickRuleSets).toEqual(['free-15', 'three-15']);
    expect(DEFAULT_MATCH_TARGET).toBe(15);
    expect(R.matchmaking.rankedRuleSets).toEqual({
      free: ['free-15'],
      three: ['three-15'],
    });
  });
});
