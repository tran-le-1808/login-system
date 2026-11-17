/// <reference types="jest" />
import { BilliardRoomService } from '../billiard-room.service';
import { BilliardEventsService } from './events.service';
import {
  BilliardMatchFlowService,
  type FinishOutcome,
} from './match-flow.service';
import { MemoryBilliardStore } from './memory.store';
import { normalizeProfile, normalizeSeason } from './profile.factory';
import { RANKING_CONFIG as R, ruleSetById } from './ranking.config';
import {
  BilliardRankingService,
  type MatchResultInput,
} from './ranking.service';
import {
  BilliardTournamentService,
  tournamentView,
} from './tournament.service';

function setup(start = 1_700_000_000_000) {
  let now = start;
  const clock = {
    now: () => now,
    advance: (ms: number) => (now += ms),
    set: (t: number) => (now = t),
  };
  const store = new MemoryBilliardStore();
  const ranking = new BilliardRankingService(store, clock.now);
  const events = new BilliardEventsService();
  let x = 1;
  const rng = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const tournaments = new BilliardTournamentService(
    store,
    ranking,
    events,
    clock.now,
    rng,
  );
  const flow = new BilliardMatchFlowService(ranking, tournaments, events);
  const rooms = new BilliardRoomService();
  return { store, ranking, tournaments, flow, rooms, clock };
}

let n = 0;
const result = (
  mode: MatchResultInput['gameMode'],
  a: string,
  b: string,
  winnerIndex: 0 | 1,
  t: number,
  extra: Partial<MatchResultInput> = {},
): MatchResultInput => ({
  matchId: `m${++n}`,
  roomCode: 'ABCDEF',
  gameMode: mode,
  ruleSet: 'three-5',
  players: [a, b],
  names: ['A', 'B'],
  winnerIndex,
  score: winnerIndex === 0 ? [5, 2] : [2, 5],
  endReason: null,
  startedAt: t - 60_000,
  endedAt: t,
  tournamentId: null,
  tournamentMatchId: null,
  ...extra,
});

describe('Xếp hạng (ranked)', () => {
  it('thắng / thua cập nhật rating Elo, thống kê, lịch sử rank', async () => {
    const { ranking, store, clock } = setup();
    const out = (await ranking.recordResult(
      result('RANKED', 'a', 'b', 0, clock.now()),
    ))!;
    expect(out.rated).toBe(true);
    expect(out.players[0].delta).toBe(24); // K tạm thời 48, kỳ vọng 0.5
    expect(out.players[1].delta).toBe(-24);
    const pa = (await store.getProfile('a'))!;
    const pb = (await store.getProfile('b'))!;
    expect(pa.ladders.three.rating).toBe(R.startRating + 24);
    expect(pa.ladders.three.ranked).toEqual({ wins: 1, losses: 0 });
    expect(pb.ladders.three.ranked).toEqual({ wins: 0, losses: 1 });
    expect(pa.ladders.three.season.wins).toBe(1);
    expect(store.rankHistory).toHaveLength(2);
    const m = (await store.getMatch(out.match.matchId))!;
    expect(m.status).toBe('COMPLETED');
    expect(m.ratingChanges).toEqual([24, -24]);
  });
  it('kết quả trùng (gửi lại / reconnect) chỉ được tính một lần', async () => {
    const { ranking, store, clock } = setup();
    const input = result('RANKED', 'a', 'b', 0, clock.now());
    const [r1, r2] = await Promise.all([
      ranking.recordResult(input),
      ranking.recordResult(input),
    ]);
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
    expect(await ranking.recordResult(input)).toBeNull();
    expect((await store.getProfile('a'))!.totalMatches).toBe(1);
  });
  it('kết quả không hợp lệ (tự đấu với mình) bị bỏ qua', async () => {
    const { ranking, clock } = setup();
    expect(
      await ranking.recordResult(result('RANKED', 'a', 'a', 0, clock.now())),
    ).toBeNull();
  });
  it('thăng hạng / tụt hạng được ghi nhận', async () => {
    const { ranking, store, clock } = setup();
    const a = await ranking.profile('a');
    a.ladders.three.rating = 1190;
    a.ladders.three.ranked = { wins: 20, losses: 20 };
    await store.saveProfile(a);
    const b = await ranking.profile('b');
    b.ladders.three.rating = 1190;
    b.ladders.three.ranked = { wins: 20, losses: 20 };
    await store.saveProfile(b);
    const out = (await ranking.recordResult(
      result('RANKED', 'a', 'b', 0, clock.now()),
    ))!;
    expect(out.players[0].promoted).toBe(true);
    expect(out.players[0].rankAfter).toBe('GOLD');
    expect((await store.getProfile('a'))!.ladders.three.bestRankId).toBe(
      'GOLD',
    );
  });
  it('casual / quick không ảnh hưởng rating xếp hạng', async () => {
    const { ranking, store, clock } = setup();
    await ranking.recordResult(result('CASUAL', 'a', 'b', 0, clock.now()));
    await ranking.recordResult(result('QUICK', 'a', 'b', 1, clock.now()));
    const a = (await store.getProfile('a'))!;
    expect(a.ladders.three.rating).toBe(R.startRating);
    expect(a.casual).toEqual({ wins: 1, losses: 0 });
    expect(a.quick).toEqual({ wins: 0, losses: 1 });
    expect(a.ladders.three.ranked).toEqual({ wins: 0, losses: 0 });
    expect(a.totalMatches).toBe(2);
  });
  it('chống farm điểm: quá số trận với cùng đối thủ trong 24h thì không tính rating', async () => {
    const { ranking, clock } = setup();
    for (let i = 0; i < R.antiAbuse.maxRankedVsSameOpponentPerDay; i++) {
      clock.advance(60_000);
      expect(
        (await ranking.recordResult(
          result('RANKED', 'a', 'b', 0, clock.now()),
        ))!.rated,
      ).toBe(true);
    }
    clock.advance(60_000);
    const out = (await ranking.recordResult(
      result('RANKED', 'a', 'b', 0, clock.now()),
    ))!;
    expect(out.rated).toBe(false);
    expect(out.unratedReason).toMatch(/không tính/);
  });
  it('bảng xếp hạng theo rating, vị trí của tôi, tìm theo tên', async () => {
    const { ranking, store, clock } = setup();
    store.users.set('a', { name: 'An' });
    store.users.set('b', { name: 'Bình' });
    store.users.set('c', { name: 'Cường' });
    await ranking.recordResult(result('RANKED', 'a', 'b', 0, clock.now()));
    await ranking.recordResult(result('RANKED', 'c', 'b', 0, clock.now()));
    const lb = await ranking.leaderboard({
      discipline: 'three',
      page: 1,
      pageSize: 10,
    });
    expect(lb.items.map((r) => r.userId)).toEqual(['a', 'c', 'b']);
    expect(lb.items[0].position).toBe(1);
    expect((await ranking.profileView('b')).ladders.three.position).toBe(3);
    const found = await ranking.leaderboard({
      discipline: 'three',
      page: 1,
      pageSize: 10,
      search: 'cườ',
    });
    expect(found.items.map((r) => [r.userId, r.position])).toEqual([['c', 2]]);
  });
  it('kết thúc mùa: lưu thứ hạng cuối mùa, reset mềm rating, mở mùa mới', async () => {
    const { ranking, store, clock } = setup();
    await ranking.recordResult(result('RANKED', 'a', 'b', 0, clock.now()));
    const s1 = await ranking.currentSeason();
    clock.set(s1.endAt + 1);
    const s2 = await ranking.currentSeason();
    expect(s2.number).toBe(2);
    const old = (await store.seasons()).find(
      (s) => s.seasonId === s1.seasonId,
    )!;
    expect(old.status).toBe('ENDED');
    expect(old.finalStandings.three.map((x) => x.userId)).toEqual(['a', 'b']);
    expect(old.finalStandings.free).toEqual([]);
    const a = await ranking.profile('a');
    expect(a.seasonId).toBe(s2.seasonId);
    expect(a.ladders.three.rating).toBe(R.startRating + 12);
    expect(a.ladders.three.seasonHistory[0]).toMatchObject({
      seasonId: s1.seasonId,
      position: 1,
    });
    expect(a.ladders.three.season).toEqual({ wins: 0, losses: 0 });
    expect(a.ladders.free.seasonHistory).toEqual([]);
  });
  it('hai thang hạng riêng: xếp hạng Libre không ảnh hưởng 3 băng và ngược lại; bảng xếp hạng tách riêng', async () => {
    const { ranking, store, clock } = setup();
    await ranking.recordResult(
      result('RANKED', 'a', 'b', 0, clock.now(), { ruleSet: 'free-15' }),
    );
    await ranking.recordResult(
      result('RANKED', 'c', 'a', 0, clock.now(), { ruleSet: 'three-5' }),
    );
    const a = (await store.getProfile('a'))!;
    expect(a.ladders.free.rating).toBe(R.startRating + 24);
    expect(a.ladders.free.ranked).toEqual({ wins: 1, losses: 0 });
    expect(a.ladders.three.rating).toBe(R.startRating - 24);
    expect(a.ladders.three.ranked).toEqual({ wins: 0, losses: 1 });
    expect((await store.getMatch('m' + (n - 1)))!.discipline).toBe('free');
    const free = await ranking.leaderboard({
      discipline: 'free',
      page: 1,
      pageSize: 10,
    });
    const three = await ranking.leaderboard({
      discipline: 'three',
      page: 1,
      pageSize: 10,
    });
    expect(free.items.map((r) => r.userId)).toEqual(['a', 'b']);
    expect(three.items.map((r) => r.userId)).toEqual(['c', 'a']);
    const view = await ranking.profileView('a');
    expect(view.ladders.free.position).toBe(1);
    expect(view.ladders.three.position).toBe(2);
    expect(view.ladders.free.rankedRuleSets).toEqual(['free-15']);
    expect(view.ladders.three.rankedRuleSets).toEqual(['three-15']);
    expect(await ranking.rating('a', 'three')).toBe(R.startRating - 24);
  });
  it('chống farm điểm tính riêng từng thể loại', async () => {
    const { ranking, clock } = setup();
    for (let i = 0; i < R.antiAbuse.maxRankedVsSameOpponentPerDay; i++) {
      clock.advance(60_000);
      await ranking.recordResult(result('RANKED', 'a', 'b', 0, clock.now()));
    }
    clock.advance(60_000);
    const libre = (await ranking.recordResult(
      result('RANKED', 'a', 'b', 0, clock.now(), { ruleSet: 'free-15' }),
    ))!;
    expect(libre.rated).toBe(true);
  });
  it('hồ sơ dạng cũ (một rating chung) được chuyển thành thang Libre', () => {
    const p = normalizeProfile({
      userId: 'old',
      seasonId: 'S1',
      rating: 1333,
      peakRating: 1400,
      bestRankId: 'GOLD',
      season: { wins: 3, losses: 1 },
      ranked: { wins: 5, losses: 2 },
      seasonHistory: [],
    } as unknown as Parameters<typeof normalizeProfile>[0]);
    expect(p.ladders.free).toMatchObject({
      rating: 1333,
      peakRating: 1400,
      bestRankId: 'GOLD',
      ranked: { wins: 5, losses: 2 },
    });
    expect(p.ladders.three.rating).toBe(R.startRating);
    expect(
      normalizeSeason({
        seasonId: 'S0',
        name: 'x',
        number: 0,
        startAt: 0,
        endAt: 1,
        status: 'ENDED',
        finalStandings: [
          {
            position: 1,
            userId: 'u',
            rating: 1,
            rankId: 'B',
            wins: 1,
            losses: 0,
          },
        ],
      }).finalStandings.free,
    ).toHaveLength(1);
  });
  it('trận dở dang khi máy chủ khởi động lại bị huỷ, không tính điểm', async () => {
    const { ranking, store, clock } = setup();
    await ranking.recordStart({
      matchId: 'x',
      roomCode: 'R',
      gameMode: 'RANKED',
      ruleSet: 'three-5',
      players: ['a', 'b'],
      names: ['A', 'B'],
      tournamentId: null,
      tournamentMatchId: null,
      startedAt: clock.now() - 1000,
    });
    await ranking.onModuleInit();
    expect((await store.getMatch('x'))!.status).toBe('CANCELLED');
  });
});

describe('Giải đấu', () => {
  const user = (id: string) => ({ userId: id, name: id.toUpperCase() });
  async function make(
    s: ReturnType<typeof setup>,
    size = 4,
    extra: Record<string, unknown> = {},
  ) {
    const now = s.clock.now();
    const r = await s.tournaments.create(user('org'), {
      name: 'Cúp Carom',
      maxParticipants: size,
      mode: 'three',
      target: 5,
      startAt: now + 3600_000,
      registrationDeadline: now + 1800_000,
      format: 'SINGLE_ELIMINATION',
      visibility: 'PUBLIC',
      joinAsPlayer: false,
      ...extra,
    });
    if (!r.ok) throw new Error(r.error);
    return r.data.tournamentId;
  }

  it('tạo giải: kiểm tra số người, thời gian, mật khẩu riêng tư, giới hạn tạo liên tục', async () => {
    const s = setup();
    const now = s.clock.now();
    const base = {
      name: 'X',
      mode: 'three' as const,
      target: 5,
      startAt: now + 3600_000,
      registrationDeadline: now + 1800_000,
      format: 'SINGLE_ELIMINATION' as const,
      visibility: 'PUBLIC' as const,
    };
    expect(
      (await s.tournaments.create(user('o'), { ...base, maxParticipants: 6 }))
        .ok,
    ).toBe(false);
    expect(
      (
        await s.tournaments.create(user('o'), {
          ...base,
          maxParticipants: 8,
          startAt: now,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await s.tournaments.create(user('o'), {
          ...base,
          maxParticipants: 8,
          visibility: 'PRIVATE',
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await s.tournaments.create(user('o'), {
          ...base,
          maxParticipants: 8,
          format: 'DOUBLE_ELIMINATION',
        })
      ).ok,
    ).toBe(false);
    expect(
      (await s.tournaments.create(user('o'), { ...base, maxParticipants: 8 }))
        .ok,
    ).toBe(true);
    expect(
      (await s.tournaments.create(user('o'), { ...base, maxParticipants: 8 }))
        .ok,
    ).toBe(false); // chờ giữa 2 lần tạo
  });
  it('luật giải đấu = loại bida (Libre / 3 băng) + số điểm 5–30', async () => {
    const s = setup();
    const now = s.clock.now();
    const base = {
      name: 'Điểm tuỳ chỉnh',
      maxParticipants: 4,
      startAt: now + 3600_000,
      registrationDeadline: now + 1800_000,
      format: 'SINGLE_ELIMINATION' as const,
      visibility: 'PUBLIC' as const,
    };
    for (const target of [4, 31, 7.5]) {
      const r = await s.tournaments.create(user(`o${target}`), {
        ...base,
        mode: 'free',
        target,
      });
      expect(r.ok).toBe(false);
    }
    const ok = await s.tournaments.create(user('o1'), {
      ...base,
      mode: 'free',
      target: 30,
    });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.data.ruleSet).toBe('free-30');
    expect(tournamentView(ok.data).ruleName).toBe('Libre (phăng) 30 điểm');
    const three = await s.tournaments.create(user('o2'), {
      ...base,
      mode: 'three',
      target: 7,
    });
    if (!three.ok) throw new Error(three.error);
    expect(ruleSetById(three.data.ruleSet)).toEqual({
      id: 'three-7',
      name: '3 băng 7 điểm',
      mode: 'three',
      target: 7,
    });
    expect(ruleSetById('three-40')).toBeUndefined();
  });
  it('ảnh giải đấu: chỉ nhận ảnh đã tải lên Cloudinary của hệ thống', async () => {
    const s = setup();
    s.tournaments.isAllowedThumbnail = (url) =>
      url.startsWith('https://res.cloudinary.com/x/');
    const now = s.clock.now();
    const base = {
      name: 'Có ảnh',
      maxParticipants: 4,
      mode: 'free' as const,
      target: 10,
      startAt: now + 3600_000,
      registrationDeadline: now + 1800_000,
      format: 'SINGLE_ELIMINATION' as const,
      visibility: 'PUBLIC' as const,
    };
    const bad = await s.tournaments.create(user('p1'), {
      ...base,
      thumbnail: 'https://evil.example.com/a.jpg',
    });
    expect(!bad.ok && bad.error).toMatch(/Ảnh giải đấu không hợp lệ/);
    const good = await s.tournaments.create(user('p2'), {
      ...base,
      thumbnail: 'https://res.cloudinary.com/x/image/upload/a.jpg',
    });
    expect(good.ok && good.data.thumbnail).toBe(
      'https://res.cloudinary.com/x/image/upload/a.jpg',
    );
  });
  it('tham gia, đủ người thì khoá đăng ký; không đăng ký trùng; mật khẩu giải riêng', async () => {
    const s = setup();
    const id = await make(s, 4);
    for (const u of ['a', 'b', 'c', 'd'])
      expect((await s.tournaments.join(id, user(u))).ok).toBe(true);
    expect((await s.tournaments.get(id))!.status).toBe('FULL');
    const extra = await s.tournaments.join(id, user('e'));
    expect(!extra.ok && extra.error).toMatch(/đủ người/);
    const s2 = setup();
    const pid = await make(s2, 4, {
      visibility: 'PRIVATE',
      password: 'bida123',
    });
    expect((await s2.tournaments.join(pid, user('a'), 'sai')).ok).toBe(false);
    expect((await s2.tournaments.join(pid, user('a'), 'bida123')).ok).toBe(
      true,
    );
    expect((await s2.tournaments.join(pid, user('a'), 'bida123')).ok).toBe(
      false,
    );
  });
  it('nhiều người cùng giành chỗ cuối: không vượt quá số người tối đa', async () => {
    const s = setup();
    const id = await make(s, 4);
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((u) =>
        s.tournaments.join(id, user(u)),
      ),
    );
    expect((await s.tournaments.get(id))!.participants).toHaveLength(4);
  });
  it('check-in, bắt đầu: người không check-in bị loại, có bye, chạy tới vô địch', async () => {
    const s = setup();
    const id = await make(s, 8);
    for (const u of ['a', 'b', 'c', 'd', 'e', 'f'])
      await s.tournaments.join(id, user(u));
    expect((await s.tournaments.checkIn(id, 'a')).ok).toBe(false); // chưa tới giờ
    // tới giờ check-in
    s.clock.set((await s.tournaments.get(id))!.checkInAt);
    await s.tournaments.tick();
    expect((await s.tournaments.get(id))!.status).toBe('CHECK_IN');
    for (const u of ['a', 'b', 'c', 'd', 'e'])
      await s.tournaments.checkIn(id, u);
    s.clock.set((await s.tournaments.get(id))!.startAt);
    const ready = await s.tournaments.tick();
    const t = (await s.tournaments.get(id))!;
    expect(t.status).toBe('IN_PROGRESS');
    expect(t.participants.map((p) => p.userId)).not.toContain('f');
    expect(t.bracket!.size).toBe(8);
    expect(t.bracket!.rounds[0].filter((m) => m.status === 'BYE')).toHaveLength(
      3,
    );
    // chơi hết các trận: người A luôn thắng
    let queue = ready.map((r) => r.match);
    let champion: string | null = null;
    for (let guard = 0; guard < 10 && queue.length; guard++) {
      const next: typeof queue = [];
      for (const m of queue) {
        await s.tournaments.assignRoom(id, m.id, `R${m.id}`);
        const r = await s.tournaments.reportResult(
          id,
          m.id,
          m.playerA!,
          [5, 1],
        );
        if (!r.ok) throw new Error(r.error);
        next.push(...r.data.ready);
        champion = r.data.champion ?? champion;
      }
      queue = next;
    }
    const done = (await s.tournaments.get(id))!;
    expect(done.status).toBe('COMPLETED');
    expect(done.championId).toBe(champion);
    expect((await s.store.getProfile(champion!))!.tournament.titles).toBe(1);
  });
  it('không đủ người check-in -> huỷ; người tổ chức huỷ giải trước khi bắt đầu', async () => {
    const s = setup();
    const id = await make(s, 4);
    await s.tournaments.join(id, user('a'));
    await s.tournaments.join(id, user('b'));
    await s.tournaments.openCheckIn(id, 'org');
    await s.tournaments.checkIn(id, 'a');
    const r = await s.tournaments.begin(id, 'org');
    expect(r.ok).toBe(true);
    expect((await s.tournaments.get(id))!.status).toBe('CANCELLED');
    const s2 = setup();
    const id2 = await make(s2, 4);
    expect((await s2.tournaments.cancel(id2, 'stranger', 'x')).ok).toBe(false);
    expect((await s2.tournaments.cancel(id2, 'org', 'x')).ok).toBe(true);
    expect((await s2.tournaments.join(id2, user('a'))).ok).toBe(false);
  });
});

describe('Tích hợp phòng game -> kết quả', () => {
  it('trận ranked: người thắng do server quyết định (bỏ cuộc), ghi kết quả đúng 1 lần dù gọi nhiều lần', async () => {
    const s = setup();
    const room = s.rooms.createMatchRoom(
      'ranked',
      [
        { userId: 'a', name: 'A' },
        { userId: 'b', name: 'B' },
      ],
      { mode: 'three', target: 5, name: '3 băng 5' },
      {
        matchId: 'mm-1',
        ruleSet: 'three-5',
        tournamentId: null,
        tournamentMatchId: null,
        joinDeadline: null,
      },
    );
    expect(room.kind).toBe('ranked');
    expect(s.rooms.busyReason('a')).toMatch(/trận chờ/);
    s.rooms.startGame(room);
    expect(room.matchId).toBe('mm-1');
    await s.flow.onStarted(room);
    s.rooms.forfeit(room, 'b', 'B bỏ trận');
    const [o1, o2] = await Promise.all([
      s.flow.onFinished(room),
      s.flow.onFinished(room),
    ]);
    expect([o1.result, o2.result].filter(Boolean)).toHaveLength(1);
    const a = (await s.store.getProfile('a'))!;
    expect(a.ladders.three.ranked.wins).toBe(1);
    expect(a.ladders.three.rating).toBeGreaterThan(R.startRating);
    expect((await s.store.getMatch('mm-1'))!.winnerId).toBe('a');
  });
  it('trận giải đấu xong -> cập nhật nhánh đấu và trả về trận kế tiếp', async () => {
    const s = setup();
    const now = s.clock.now();
    const c = await s.tournaments.create(
      { userId: 'org', name: 'Org' },
      {
        name: 'Mini',
        maxParticipants: 4,
        mode: 'free',
        target: 10,
        startAt: now + 120_000,
        registrationDeadline: now + 60_000,
        format: 'SINGLE_ELIMINATION',
        visibility: 'PUBLIC',
        joinAsPlayer: false,
        seeding: 'rating',
      },
    );
    if (!c.ok) throw new Error(c.error);
    const id = c.data.tournamentId;
    for (const u of ['a', 'b', 'c', 'd'])
      await s.tournaments.join(id, { userId: u, name: u });
    await s.tournaments.openCheckIn(id, 'org');
    for (const u of ['a', 'b', 'c', 'd']) await s.tournaments.checkIn(id, u);
    const begun = await s.tournaments.begin(id, 'org');
    if (!begun.ok) throw new Error(begun.error);
    const outs: FinishOutcome[] = [];
    for (const m of begun.data.ready) {
      const room = s.rooms.createMatchRoom(
        'tournament',
        [
          { userId: m.playerA!, name: 'x' },
          { userId: m.playerB!, name: 'y' },
        ],
        { mode: 'free', target: 10, name: 'Phăng 10' },
        {
          matchId: `t-${id}-${m.id}`,
          ruleSet: 'free-10',
          tournamentId: id,
          tournamentMatchId: m.id,
          joinDeadline: null,
        },
      );
      await s.tournaments.assignRoom(id, m.id, room.code);
      s.rooms.startGame(room);
      s.rooms.forfeit(room, m.playerB!, 'thua');
      outs.push(await s.flow.onFinished(room));
    }
    const ready = outs.flatMap((o) => o.ready);
    expect(ready).toHaveLength(1);
    expect(ready[0].match.round).toBe(1);
    const t = (await s.tournaments.get(id))!;
    expect(t.bracket!.rounds[0].every((m) => m.status === 'COMPLETED')).toBe(
      true,
    );
  });
  it('phòng casual: tạo, mật khẩu, danh sách có lọc, đầy phòng, chủ phòng rời thì chuyển quyền', () => {
    const s = setup();
    const room = s.rooms.create({ userId: 'h', name: 'Host', socketId: 's1' });
    s.rooms.updateSettings(room, {
      name: 'Phòng vui',
      mode: 'three',
      isPrivate: false,
      turnSeconds: 60,
    });
    expect(room.settings.turnSeconds).toBe(60);
    expect(s.rooms.listPublicLobbies({ search: 'vui' })).toHaveLength(1);
    expect(s.rooms.listPublicLobbies({ mode: 'free' })).toHaveLength(0);
    expect(s.rooms.listPublicLobbies({ status: 'playing' })).toHaveLength(0);
    s.rooms.setPassword(room, 'abc123');
    expect(s.rooms.toPublic(room).hasPassword).toBe(true);
    s.rooms.addPlayer(room, { userId: 'g', name: 'Guest', socketId: 's2' });
    expect(s.rooms.removePlayer(room, 'h')).toBe(false);
    expect(room.hostId).toBe('g');
    s.rooms.startGame(room);
    expect(room.matchId).toMatch(/^c-/);
    expect(room.snapshot!.turnSeconds).toBe(60);
  });
});
