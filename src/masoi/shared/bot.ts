/**
 * MÁY CHƠI MA SÓI — chỉ dùng thông tin mà ghế đó được biết (vai mình, đồng đội Sói, kết quả soi,
 * vai đã lộ, lời tuyên bố / tố cáo / phiếu bầu công khai).
 */
import {
  aliveSeats,
  isWolf,
  knownRole,
  pendingSeats,
  type MSAction,
  type MSEvent,
  type MSState,
} from './game';

export type MSBotLevel = 'easy' | 'normal' | 'hard';
export const MS_BOT_LEVELS: Record<MSBotLevel, string> = {
  easy: 'Dễ',
  normal: 'Vừa',
  hard: 'Khó',
};

const NOISE: Record<MSBotLevel, number> = { easy: 6, normal: 1.5, hard: 0.6 };

interface ClaimInfo {
  seat: number;
  status: 'true' | 'liar' | 'unknown';
}

/** Đánh giá các "Tiên Tri" tự xưng theo góc nhìn của `me` */
function claimers(s: MSState, me: number): ClaimInfo[] {
  const by = new Map<number, { target: number; wolf: boolean }[]>();
  for (const e of s.events)
    if (e.k === 'claim')
      by.set(e.seat, [
        ...(by.get(e.seat) ?? []),
        { target: e.target, wolf: e.wolf },
      ]);
  const out: ClaimInfo[] = [];
  for (const [c, list] of by) {
    const role = knownRole(s, me, c);
    let status: ClaimInfo['status'] = 'unknown';
    if (role === 'seer') status = 'true';
    else if (role !== null) status = 'liar';
    else if (s.roles[me] === 'seer' && c !== me) status = 'liar';
    else {
      for (const cl of list) {
        const tr = knownRole(s, me, cl.target);
        if (tr === null) continue;
        if (isWolf(tr) !== cl.wolf) status = 'liar';
        else if (cl.wolf && status === 'unknown') status = 'true';
      }
    }
    out.push({ seat: c, status });
  }
  return out;
}

/** Điểm nghi ngờ là Sói của từng ghế (theo góc nhìn phe Dân) */
export function suspicion(
  s: MSState,
  me: number,
  level: MSBotLevel,
  rng: () => number = Math.random,
): number[] {
  const sc = new Array<number>(s.n).fill(0);
  const cl = claimers(s, me);
  const trusted = cl.filter((c) => c.status === 'true');
  const unknown = cl.filter((c) => c.status === 'unknown');
  const weight = new Map<number, number>();
  for (const c of trusted) weight.set(c.seat, 1);
  if (!trusted.length)
    for (const c of unknown)
      weight.set(c.seat, unknown.length === 1 ? 0.8 : 0.4);
  if (unknown.length > 1 && !trusted.length)
    for (const c of unknown) sc[c.seat] += 3;
  if (trusted.length) for (const c of unknown) sc[c.seat] += 8;
  for (const c of cl) if (c.status === 'liar') sc[c.seat] += 15;
  for (const e of s.events) {
    if (e.k === 'claim') {
      const w = weight.get(e.seat) ?? 0;
      sc[e.target] += e.wolf ? 10 * w : -6 * w;
    } else if (e.k === 'accuse') {
      const tr = knownRole(s, me, e.target);
      if (tr !== null && !s.alive[e.target])
        sc[e.seat] += isWolf(tr) ? -0.8 : 0.8;
      if (e.day === s.day) sc[e.target] += 0.5;
    }
  }
  for (const v of s.voteLog) {
    if (v.lynched < 0) continue;
    const tr = knownRole(s, me, v.lynched);
    if (tr === null) continue;
    v.votes.forEach((t, i) => {
      if (t === v.lynched) sc[i] += isWolf(tr) ? -1 : 1.2;
    });
  }
  if (s.roles[me] === 'seer')
    for (const r of s.seerLog) sc[r.target] += r.wolf ? 100 : -100;
  for (let p = 0; p < s.n; p++) {
    const kr = knownRole(s, me, p);
    if (kr !== null && p !== me) sc[p] = isWolf(kr) ? 200 : -200;
    sc[p] += rng() * NOISE[level];
    if (p === me || !s.alive[p]) sc[p] = -Infinity;
  }
  return sc;
}

/** Độ "nguy hiểm" với bầy Sói */
function threat(s: MSState, me: number, rng: () => number): number[] {
  const t = new Array<number>(s.n).fill(0);
  for (const e of s.events) {
    if (e.k === 'claim') {
      t[e.seat] += 6;
      if (e.wolf && isWolf(s.roles[e.target])) t[e.seat] += 6;
    }
    if (e.k === 'accuse' && isWolf(s.roles[e.target])) t[e.seat] += 1.5;
  }
  for (const v of s.voteLog)
    v.votes.forEach((x, i) => x >= 0 && isWolf(s.roles[x]) && (t[i] += 1));
  for (let p = 0; p < s.n; p++) {
    t[p] += rng() * 2;
    if (!s.alive[p] || isWolf(s.roles[p]) || p === me) t[p] = -Infinity;
  }
  return t;
}

const argmax = (a: number[]) => {
  let b = -1;
  for (let i = 0; i < a.length; i++)
    if (a[i] > -Infinity && (b < 0 || a[i] > a[b])) b = i;
  return b;
};
const pick = <T>(a: T[], rng: () => number): T | undefined =>
  a[Math.floor(rng() * a.length)];

function teamVote(s: MSState, me: number, votes: number[]): number {
  const c = new Map<number, number>();
  for (let i = 0; i < s.n; i++)
    if (
      i !== me &&
      s.alive[i] &&
      isWolf(s.roles[i]) &&
      votes[i] >= 0 &&
      !isWolf(s.roles[votes[i]])
    )
      c.set(votes[i], (c.get(votes[i]) ?? 0) + 1);
  let best = -1;
  let bc = 0;
  for (const [t, k] of c) if (s.alive[t] && k > bc) [best, bc] = [t, k];
  return best;
}

/** Hành động kế tiếp của máy ở ghế `seat` (null nếu không cần làm gì) */
export function botAction(
  s: MSState,
  seat: number,
  level: MSBotLevel,
  rng: () => number = Math.random,
): MSAction | null {
  if (!pendingSeats(s).includes(seat)) return null;
  const role = s.roles[seat];
  const alive = aliveSeats(s).filter((p) => p !== seat);
  const rnd = () => pick(alive, rng) ?? -1;
  const sus = () => suspicion(s, seat, level, rng);

  switch (s.phase) {
    case 'night': {
      if (role === 'wolf') {
        const mate = teamVote(s, seat, s.wolfVotes);
        if (mate >= 0) return { k: 'kill', target: mate };
        const t =
          level === 'easy'
            ? (pick(
                alive.filter((p) => !isWolf(s.roles[p])),
                rng,
              ) ?? -1)
            : argmax(threat(s, seat, rng));
        return { k: 'kill', target: t };
      }
      if (role === 'seer') {
        const seen = new Set(s.seerLog.map((r) => r.target));
        const cand = alive.filter((p) => !seen.has(p));
        const pool = cand.length ? cand : alive;
        if (level === 'easy')
          return { k: 'see', target: pick(pool, rng) ?? -1 };
        const sc = sus();
        const masked = sc.map((v, i) => (pool.includes(i) ? v : -Infinity));
        return { k: 'see', target: argmax(masked) };
      }
      if (role === 'guard') {
        const opts = [...alive, seat].filter((p) => p !== s.lastGuard);
        if (level !== 'easy') {
          const cl = claimers(s, seat).filter(
            (c) =>
              c.status !== 'liar' && s.alive[c.seat] && opts.includes(c.seat),
          );
          if (cl.length === 1 || cl.some((c) => c.status === 'true'))
            return {
              k: 'guard',
              target: (cl.find((c) => c.status === 'true') ?? cl[0]).seat,
            };
          const sc = sus();
          const safe = opts.filter((p) => p === seat || sc[p] < 2);
          return {
            k: 'guard',
            target: pick(safe.length ? safe : opts, rng) ?? opts[0],
          };
        }
        return { k: 'guard', target: pick(opts, rng) ?? opts[0] };
      }
      return null;
    }
    case 'witch': {
      const v = s.victim;
      if (s.potions.heal && v >= 0) {
        const cl = claimers(s, seat).find(
          (c) => c.seat === v && c.status !== 'liar',
        );
        const p =
          v === seat
            ? 1
            : cl
              ? 0.95
              : level === 'easy'
                ? 0.5
                : s.day === 1
                  ? 0.7
                  : 0.45;
        if (rng() < p) return { k: 'witch', save: true, poison: -1 };
      }
      if (s.potions.poison) {
        const sc = sus();
        const t = argmax(sc);
        const th = level === 'hard' ? 8 : level === 'normal' ? 10 : 99;
        if (t >= 0 && sc[t] >= th)
          return { k: 'witch', save: false, poison: t };
        if (level === 'easy' && s.day > 1 && rng() < 0.12)
          return { k: 'witch', save: false, poison: rnd() };
      }
      return { k: 'witch', save: false, poison: -1 };
    }
    case 'day':
      return dayTalk(s, seat, level, rng);
    case 'vote': {
      if (role === 'wolf') {
        const mate = teamVote(s, seat, s.votes);
        if (mate >= 0) return { k: 'vote', target: mate };
        // nhập đoàn nếu cả làng đang dồn phiếu vào một người phe Dân
        const lead = leader(s);
        if (lead >= 0 && !isWolf(s.roles[lead]) && lead !== seat)
          return { k: 'vote', target: lead };
        return { k: 'vote', target: argmax(threat(s, seat, rng)) };
      }
      if (level === 'easy')
        return { k: 'vote', target: rng() < 0.2 ? -1 : rnd() };
      const sc = sus();
      const t = argmax(sc);
      if (t >= 0 && sc[t] >= 0.9) return { k: 'vote', target: t };
      const lead = leader(s);
      if (lead >= 0 && lead !== seat && sc[lead] > -2 && rng() < 0.6)
        return { k: 'vote', target: lead };
      return { k: 'vote', target: rng() < 0.35 ? -1 : t };
    }
    case 'hunter': {
      const sc = role === 'hunter' ? sus() : [];
      const t = argmax(sc);
      if (t < 0) return { k: 'shoot', target: -1 };
      if (level !== 'easy' && sc[t] < 0.5 && rng() < 0.5)
        return { k: 'shoot', target: -1 };
      return { k: 'shoot', target: t };
    }
    default:
      return null;
  }
}

/** Người đang dẫn phiếu */
function leader(s: MSState): number {
  const c = new Array<number>(s.n).fill(0);
  for (let i = 0; i < s.n; i++)
    if (s.alive[i] && s.votes[i] >= 0) c[s.votes[i]] += 1;
  const m = Math.max(...c);
  if (m < 1) return -1;
  const top = c.map((v, i) => (v === m ? i : -1)).filter((i) => i >= 0);
  return top.length === 1 ? top[0] : -1;
}

type TalkEvent = Extract<MSEvent, { k: 'claim' | 'accuse' }>;
function said(s: MSState, seat: number, f: (e: TalkEvent) => boolean) {
  return s.events.some(
    (e) => (e.k === 'claim' || e.k === 'accuse') && e.seat === seat && f(e),
  );
}

function dayTalk(
  s: MSState,
  seat: number,
  level: MSBotLevel,
  rng: () => number,
): MSAction {
  const role = s.roles[seat];
  const today = s.events.filter((e) => e.k === 'accuse' && e.day === s.day);
  const onMe = today.filter(
    (e) => e.k === 'accuse' && e.target === seat,
  ).length;
  // Tiên Tri: công bố kết quả soi
  if (role === 'seer') {
    const hasWolf = s.seerLog.some((r) => r.wolf && s.alive[r.target]);
    const want =
      level === 'easy' ||
      hasWolf ||
      onMe >= 2 ||
      (level === 'hard' && s.day >= 3);
    if (want) {
      const order = s.seerLog
        .slice()
        .sort((a, b) => Number(b.wolf) - Number(a.wolf));
      for (const r of order)
        if (!said(s, seat, (e) => e.k === 'claim' && e.target === r.target))
          return { k: 'claim', target: r.target, wolf: r.wolf };
    }
  }
  if (role === 'wolf') {
    // bị "Tiên Tri" tố là Sói: một con Sói nhận vơ là Tiên Tri, tố ngược lại
    const prob = level === 'hard' ? 0.8 : level === 'normal' ? 0.4 : 0;
    const accusers = s.events.filter(
      (e): e is TalkEvent =>
        e.k === 'claim' &&
        e.day === s.day &&
        e.wolf &&
        isWolf(s.roles[e.target]) &&
        s.alive[e.seat],
    );
    const already = s.events.some(
      (e) => e.k === 'claim' && isWolf(s.roles[e.seat]),
    );
    if (accusers.length && !already) {
      const wolves = aliveSeats(s).filter((p) => isWolf(s.roles[p]));
      const hitTarget = accusers[0].target;
      const fake = wolves.includes(hitTarget) ? hitTarget : wolves[0];
      if (fake === seat && rng() < prob)
        return { k: 'claim', target: accusers[0].seat, wolf: true };
    }
    // chủ động giả làm Tiên Tri (bàn đông dễ trà trộn hơn)
    const wolvesAlive = aliveSeats(s).filter((p) => isWolf(s.roles[p]));
    const bold =
      (level === 'hard' ? 0.3 : level === 'normal' ? 0.18 : 0) *
      (s.n >= 9 ? 1.5 : 1);
    if (
      !already &&
      wolvesAlive[0] === seat &&
      !said(s, seat, (e) => e.day === s.day) &&
      rng() < bold
    ) {
      const t = argmax(threat(s, seat, rng));
      if (t >= 0) return { k: 'claim', target: t, wolf: true };
    }
    if (!said(s, seat, (e) => e.day === s.day) && rng() < 0.5) {
      const t = argmax(threat(s, seat, rng));
      if (t >= 0) return { k: 'accuse', target: t };
    }
    return { k: 'ready' };
  }
  if (!said(s, seat, (e) => e.k === 'accuse' && e.day === s.day)) {
    const sc = suspicion(s, seat, level, rng);
    const t = argmax(sc);
    if (t >= 0 && (sc[t] >= 3 || rng() < (level === 'easy' ? 0.5 : 0.25)))
      return { k: 'accuse', target: t };
  }
  return { k: 'ready' };
}
