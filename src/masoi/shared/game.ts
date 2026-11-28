/**
 * MA SÓI — luật chơi (thuần, dùng chung cho chơi với máy và server).
 * Vai: Ma Sói, Dân Làng, Tiên Tri, Bảo Vệ, Phù Thuỷ, Thợ Săn. 5–12 người.
 * Vòng: Đêm (Sói cắn, Tiên Tri soi, Bảo Vệ che) → Phù Thuỷ (cứu / độc) → Bình minh → Thảo luận → Bỏ phiếu treo cổ → Đêm…
 * Thợ Săn chết (bị cắn / bị treo, không phải bị độc) được bắn 1 người.
 * Sói thắng khi số Sói ≥ số người còn lại; Dân thắng khi hết Sói.
 */
export type Role = 'wolf' | 'villager' | 'seer' | 'guard' | 'witch' | 'hunter';
export type Phase = 'night' | 'witch' | 'day' | 'vote' | 'hunter' | 'over';
export type Team = 'wolf' | 'village';
export type Cause = 'wolf' | 'poison' | 'lynch' | 'shot';

export const MS_MIN = 5;
export const MS_MAX = 12;

/** Bộ vai theo số người (cân bằng bằng mô phỏng máy đấu máy) */
const SETS: Record<number, [number, Role[]]> = {
  5: [1, ['seer', 'guard']],
  6: [2, ['seer', 'guard', 'witch']],
  7: [2, ['seer', 'guard']],
  8: [2, ['seer', 'guard', 'hunter']],
  9: [3, ['seer', 'guard', 'witch']],
  10: [3, ['seer', 'guard', 'hunter']],
  11: [4, ['seer', 'guard', 'witch']],
  12: [4, ['seer', 'guard', 'witch', 'hunter']],
};
export function rolesFor(n: number): Role[] {
  const [wolves, special] = SETS[Math.min(MS_MAX, Math.max(MS_MIN, n))];
  const r: Role[] = [];
  for (let i = 0; i < wolves; i++) r.push('wolf');
  r.push(...special);
  while (r.length < n) r.push('villager');
  return r;
}

export interface MSSettings {
  /** Lộ vai khi chết */
  reveal: boolean;
}

export type MSEvent =
  | { k: 'dawn'; day: number; deaths: number[]; causes: Cause[] }
  | { k: 'claim'; day: number; seat: number; target: number; wolf: boolean }
  | { k: 'accuse'; day: number; seat: number; target: number }
  | { k: 'lynch'; day: number; seat: number; tally: number[]; skips: number }
  | { k: 'shot'; day: number; seat: number; target: number }
  | { k: 'over'; winner: Team };

export interface SeerResult {
  day: number;
  target: number;
  wolf: boolean;
}

export interface MSState {
  n: number;
  roles: Role[];
  alive: boolean[];
  settings: MSSettings;
  phase: Phase;
  /** Số đêm/ngày hiện tại (Đêm 1 → Ngày 1 → Đêm 2…) */
  day: number;
  /** Tăng mỗi lần đổi giai đoạn */
  pid: number;
  /** Ai đã hành động trong giai đoạn này (ngày: đã sẵn sàng; bỏ phiếu: đã bầu) */
  acted: boolean[];
  wolfVotes: number[];
  seerPick: number;
  guardPick: number;
  lastGuard: number;
  victim: number;
  witchSave: boolean;
  witchPoison: number;
  potions: { heal: boolean; poison: boolean };
  seerLog: SeerResult[];
  /** Phiếu ngày hiện tại (-1 = bỏ qua, -2 = chưa bầu) */
  votes: number[];
  voteLog: { day: number; votes: number[]; lynched: number }[];
  hunter: { seat: number; then: 'day' | 'night' } | null;
  cause: (Cause | null)[];
  events: MSEvent[];
  winner: Team | null;
}

export type MSAction =
  | { k: 'kill'; target: number }
  | { k: 'see'; target: number }
  | { k: 'guard'; target: number }
  | { k: 'witch'; save: boolean; poison: number }
  | { k: 'claim'; target: number; wolf: boolean }
  | { k: 'accuse'; target: number }
  | { k: 'ready' }
  | { k: 'vote'; target: number }
  | { k: 'shoot'; target: number };

export type MSError =
  | 'phase'
  | 'dead'
  | 'role'
  | 'target'
  | 'done'
  | 'potion'
  | 'spam';
export const MS_ERROR_VI: Record<MSError, string> = {
  phase: 'Chưa tới lúc làm việc này',
  dead: 'Bạn đã chết',
  role: 'Vai của bạn không làm được việc này',
  target: 'Mục tiêu không hợp lệ',
  done: 'Bạn đã hành động rồi',
  potion: 'Không còn bình thuốc này',
  spam: 'Bạn đã nói việc này rồi (mỗi ngày tố tối đa 2 người)',
};

export type ActResult =
  | { ok: true; state: MSState }
  | { ok: false; error: MSError };

export const isWolf = (r: Role) => r === 'wolf';
export const teamOf = (r: Role): Team => (r === 'wolf' ? 'wolf' : 'village');

function shuffle<T>(a: T[], rng: () => number): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/** Chia vai. `fixed` cố định vai cho vài ghế (vd. người chơi chọn vai khi đấu máy). */
export function deal(
  n: number,
  settings: MSSettings,
  rng: () => number = Math.random,
  fixed: Partial<Record<number, Role>> = {},
): MSState {
  const pool = rolesFor(n);
  for (const r of Object.values(fixed)) {
    const i = pool.indexOf(r as Role);
    if (i >= 0) pool.splice(i, 1);
  }
  const rest = shuffle(pool, rng);
  const roles: Role[] = [];
  for (let i = 0; i < n; i++) roles.push(fixed[i] ?? rest.pop()!);
  return {
    n,
    roles,
    alive: new Array<boolean>(n).fill(true),
    settings,
    phase: 'night',
    day: 1,
    pid: 1,
    acted: new Array<boolean>(n).fill(false),
    wolfVotes: new Array<number>(n).fill(-1),
    seerPick: -1,
    guardPick: -1,
    lastGuard: -1,
    victim: -1,
    witchSave: false,
    witchPoison: -1,
    potions: { heal: true, poison: true },
    seerLog: [],
    votes: new Array<number>(n).fill(-2),
    voteLog: [],
    hunter: null,
    cause: new Array<Cause | null>(n).fill(null),
    events: [],
    winner: null,
  };
}

const clone = (s: MSState): MSState => ({
  ...s,
  roles: s.roles.slice(),
  alive: s.alive.slice(),
  acted: s.acted.slice(),
  wolfVotes: s.wolfVotes.slice(),
  potions: { ...s.potions },
  seerLog: s.seerLog.slice(),
  votes: s.votes.slice(),
  voteLog: s.voteLog.slice(),
  cause: s.cause.slice(),
  events: s.events.slice(),
});

export const seatsOf = (s: MSState, role: Role) =>
  s.roles.map((r, i) => (r === role ? i : -1)).filter((i) => i >= 0);
export const aliveSeats = (s: MSState) =>
  s.alive.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);

function witchNeeded(s: MSState): boolean {
  const w = seatsOf(s, 'witch')[0];
  return (
    w !== undefined &&
    s.alive[w] &&
    (s.potions.poison || (s.potions.heal && s.victim >= 0))
  );
}

/** Ghế còn phải hành động trong giai đoạn hiện tại */
export function pendingSeats(s: MSState): number[] {
  const need: number[] = [];
  for (let i = 0; i < s.n; i++) {
    if (!s.alive[i] && !(s.phase === 'hunter' && s.hunter?.seat === i))
      continue;
    if (s.acted[i]) continue;
    const r = s.roles[i];
    if (s.phase === 'night' && (r === 'wolf' || r === 'seer' || r === 'guard'))
      need.push(i);
    else if (s.phase === 'witch' && r === 'witch') need.push(i);
    else if (s.phase === 'day' || s.phase === 'vote') need.push(i);
    else if (s.phase === 'hunter' && s.hunter?.seat === i) need.push(i);
  }
  return need;
}

function nextPhase(s: MSState, phase: Phase) {
  s.phase = phase;
  s.pid += 1;
  s.acted = new Array<boolean>(s.n).fill(false);
}

function checkWin(s: MSState): boolean {
  let w = 0;
  let o = 0;
  for (let i = 0; i < s.n; i++) {
    if (!s.alive[i]) continue;
    if (isWolf(s.roles[i])) w++;
    else o++;
  }
  const winner: Team | null = w === 0 ? 'village' : w >= o ? 'wolf' : null;
  if (!winner) return false;
  s.winner = winner;
  s.hunter = null;
  nextPhase(s, 'over');
  s.events.push({ k: 'over', winner });
  return true;
}

function kill(s: MSState, seat: number, cause: Cause) {
  if (!s.alive[seat]) return;
  s.alive[seat] = false;
  s.cause[seat] = cause;
}

function startNight(s: MSState) {
  s.day += 1;
  nextPhase(s, 'night');
  s.wolfVotes = new Array<number>(s.n).fill(-1);
  s.seerPick = -1;
  s.guardPick = -1;
  s.victim = -1;
  s.witchSave = false;
  s.witchPoison = -1;
}

function startDay(s: MSState) {
  nextPhase(s, 'day');
  s.votes = new Array<number>(s.n).fill(-2);
}

/** Hết phần Sói / Tiên Tri / Bảo Vệ: chốt mục tiêu của Sói */
function endNightStep(s: MSState, rng: () => number) {
  const tally = new Map<number, number>();
  for (let i = 0; i < s.n; i++) {
    const t = s.wolfVotes[i];
    if (s.alive[i] && isWolf(s.roles[i]) && t >= 0)
      tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  const max = Math.max(0, ...tally.values());
  const top = [...tally.entries()]
    .filter(([, c]) => c === max && max > 0)
    .map(([t]) => t);
  s.victim = top.length ? top[Math.floor(rng() * top.length)] : -1;
  if (s.seerPick >= 0)
    s.seerLog.push({
      day: s.day,
      target: s.seerPick,
      wolf: isWolf(s.roles[s.seerPick]),
    });
  if (witchNeeded(s)) nextPhase(s, 'witch');
  else dawn(s);
}

function dawn(s: MSState) {
  const deaths: number[] = [];
  const causes: Cause[] = [];
  if (
    s.victim >= 0 &&
    s.victim !== s.guardPick &&
    !s.witchSave &&
    s.alive[s.victim]
  ) {
    kill(s, s.victim, 'wolf');
    deaths.push(s.victim);
    causes.push('wolf');
  }
  if (s.witchPoison >= 0 && s.alive[s.witchPoison]) {
    kill(s, s.witchPoison, 'poison');
    deaths.push(s.witchPoison);
    causes.push('poison');
  }
  s.lastGuard = s.guardPick;
  s.events.push({ k: 'dawn', day: s.day, deaths, causes });
  if (checkWin(s)) return;
  const h = deaths.find(
    (d) => s.roles[d] === 'hunter' && s.cause[d] === 'wolf',
  );
  if (h !== undefined) {
    s.hunter = { seat: h, then: 'day' };
    nextPhase(s, 'hunter');
  } else startDay(s);
}

function endVote(s: MSState) {
  const tally = new Array<number>(s.n).fill(0);
  let skips = 0;
  for (let i = 0; i < s.n; i++) {
    if (!s.alive[i]) continue;
    const v = s.votes[i];
    if (v >= 0) tally[v] += 1;
    else skips += 1;
  }
  const max = Math.max(...tally);
  const top = tally.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0);
  const lynched = max > 0 && top.length === 1 && max > skips ? top[0] : -1;
  s.voteLog.push({ day: s.day, votes: s.votes.slice(), lynched });
  s.events.push({ k: 'lynch', day: s.day, seat: lynched, tally, skips });
  if (lynched >= 0) kill(s, lynched, 'lynch');
  if (checkWin(s)) return;
  if (lynched >= 0 && s.roles[lynched] === 'hunter') {
    s.hunter = { seat: lynched, then: 'night' };
    nextPhase(s, 'hunter');
  } else startNight(s);
}

function completeIfDone(s: MSState, rng: () => number) {
  if (pendingSeats(s).length) return;
  finishPhase(s, rng);
}

function finishPhase(s: MSState, rng: () => number) {
  if (s.phase === 'night') endNightStep(s, rng);
  else if (s.phase === 'witch') {
    if (s.witchSave) s.potions.heal = false;
    if (s.witchPoison >= 0) s.potions.poison = false;
    dawn(s);
  } else if (s.phase === 'day') nextPhase(s, 'vote');
  else if (s.phase === 'vote') endVote(s);
  else if (s.phase === 'hunter') {
    const then = s.hunter?.then ?? 'night';
    s.hunter = null;
    if (checkWin(s)) return;
    if (then === 'day') startDay(s);
    else startNight(s);
  }
}

const valid = (s: MSState, t: number) =>
  Number.isInteger(t) && t >= 0 && t < s.n && s.alive[t];

export function act(
  state: MSState,
  seat: number,
  a: MSAction,
  rng: () => number = Math.random,
): ActResult {
  const s = state;
  if (s.phase === 'over') return { ok: false, error: 'phase' };
  if (seat < 0 || seat >= s.n) return { ok: false, error: 'target' };
  const r = s.roles[seat];
  const hunterTurn = s.phase === 'hunter' && s.hunter?.seat === seat;
  if (!s.alive[seat] && !hunterTurn) return { ok: false, error: 'dead' };
  const n = clone(s);
  switch (a.k) {
    case 'kill':
      if (s.phase !== 'night') return { ok: false, error: 'phase' };
      if (r !== 'wolf') return { ok: false, error: 'role' };
      if (!valid(s, a.target) || isWolf(s.roles[a.target]))
        return { ok: false, error: 'target' };
      n.wolfVotes[seat] = a.target;
      n.acted[seat] = true;
      break;
    case 'see':
      if (s.phase !== 'night') return { ok: false, error: 'phase' };
      if (r !== 'seer') return { ok: false, error: 'role' };
      if (s.acted[seat]) return { ok: false, error: 'done' };
      if (!valid(s, a.target) || a.target === seat)
        return { ok: false, error: 'target' };
      n.seerPick = a.target;
      n.acted[seat] = true;
      break;
    case 'guard':
      if (s.phase !== 'night') return { ok: false, error: 'phase' };
      if (r !== 'guard') return { ok: false, error: 'role' };
      if (s.acted[seat]) return { ok: false, error: 'done' };
      if (!valid(s, a.target) || a.target === s.lastGuard)
        return { ok: false, error: 'target' };
      n.guardPick = a.target;
      n.acted[seat] = true;
      break;
    case 'witch':
      if (s.phase !== 'witch') return { ok: false, error: 'phase' };
      if (r !== 'witch') return { ok: false, error: 'role' };
      if (s.acted[seat]) return { ok: false, error: 'done' };
      if (a.save && a.poison >= 0) return { ok: false, error: 'potion' };
      if (a.save && (!s.potions.heal || s.victim < 0))
        return { ok: false, error: 'potion' };
      if (a.poison >= 0 && !s.potions.poison)
        return { ok: false, error: 'potion' };
      if (a.poison >= 0 && (!valid(s, a.poison) || a.poison === seat))
        return { ok: false, error: 'target' };
      n.witchSave = !!a.save;
      n.witchPoison = a.poison >= 0 ? a.poison : -1;
      n.acted[seat] = true;
      break;
    case 'claim': {
      if (s.phase !== 'day') return { ok: false, error: 'phase' };
      if (
        !Number.isInteger(a.target) ||
        a.target < 0 ||
        a.target >= s.n ||
        a.target === seat
      )
        return { ok: false, error: 'target' };
      if (
        s.events.some(
          (e) =>
            e.k === 'claim' &&
            e.seat === seat &&
            e.target === a.target &&
            e.wolf === !!a.wolf,
        )
      )
        return { ok: false, error: 'spam' };
      n.events.push({
        k: 'claim',
        day: s.day,
        seat,
        target: a.target,
        wolf: !!a.wolf,
      });
      return { ok: true, state: n };
    }
    case 'accuse':
      if (s.phase !== 'day') return { ok: false, error: 'phase' };
      if (!valid(s, a.target) || a.target === seat)
        return { ok: false, error: 'target' };
      if (
        s.events.filter(
          (e) => e.k === 'accuse' && e.day === s.day && e.seat === seat,
        ).length >= 2
      )
        return { ok: false, error: 'spam' };
      if (
        s.events.some(
          (e) =>
            e.k === 'accuse' &&
            e.day === s.day &&
            e.seat === seat &&
            e.target === a.target,
        )
      )
        return { ok: false, error: 'spam' };
      n.events.push({ k: 'accuse', day: s.day, seat, target: a.target });
      return { ok: true, state: n };
    case 'ready':
      if (s.phase !== 'day') return { ok: false, error: 'phase' };
      n.acted[seat] = true;
      break;
    case 'vote':
      if (s.phase !== 'vote') return { ok: false, error: 'phase' };
      if (a.target !== -1 && (!valid(s, a.target) || a.target === seat))
        return { ok: false, error: 'target' };
      n.votes[seat] = a.target;
      n.acted[seat] = true;
      break;
    case 'shoot':
      if (!hunterTurn) return { ok: false, error: 'phase' };
      if (a.target !== -1 && (!valid(s, a.target) || a.target === seat))
        return { ok: false, error: 'target' };
      if (a.target >= 0) {
        kill(n, a.target, 'shot');
        n.events.push({ k: 'shot', day: s.day, seat, target: a.target });
      }
      n.acted[seat] = true;
      break;
    default:
      return { ok: false, error: 'phase' };
  }
  completeIfDone(n, rng);
  return { ok: true, state: n };
}

/** Hết giờ: ai chưa làm coi như bỏ qua, rồi sang giai đoạn kế */
export function timeout(
  state: MSState,
  rng: () => number = Math.random,
): MSState {
  if (state.phase === 'over') return state;
  const n = clone(state);
  if (n.phase === 'vote')
    for (let i = 0; i < n.n; i++)
      if (n.alive[i] && n.votes[i] === -2) n.votes[i] = -1;
  finishPhase(n, rng);
  return n;
}

// ------------------------------------------------------------------ góc nhìn riêng

/** Vai mà `viewer` biết về ghế `p` (null = chưa biết). viewer = -1: khán giả (chỉ thấy vai đã lộ). */
export function knownRole(s: MSState, viewer: number, p: number): Role | null {
  if (s.phase === 'over') return s.roles[p];
  if (viewer === p && viewer >= 0) return s.roles[p];
  if (viewer >= 0 && !s.alive[viewer]) return s.roles[p];
  if (viewer >= 0 && isWolf(s.roles[viewer]) && isWolf(s.roles[p]))
    return s.roles[p];
  if (!s.alive[p] && s.settings.reveal) return s.roles[p];
  if (s.phase === 'hunter' && s.hunter?.seat === p) return s.roles[p];
  return null;
}

export interface MSView {
  n: number;
  mySeat: number;
  myRole: Role | null;
  phase: Phase;
  day: number;
  pid: number;
  alive: boolean[];
  roles: (Role | null)[];
  composition: Role[];
  /** Mình đã hành động trong giai đoạn này */
  done: boolean;
  /** Sẵn sàng / đã bầu (công khai khi ngày & bỏ phiếu) */
  acted: boolean[];
  votes: number[];
  wolfVotes: number[] | null;
  victim: number;
  potions: { heal: boolean; poison: boolean } | null;
  lastGuard: number;
  seerLog: SeerResult[];
  hunterSeat: number;
  cause: (Cause | null)[];
  events: MSEvent[];
  winner: Team | null;
  reveal: boolean;
}

export function viewFor(s: MSState, seat: number): MSView {
  const me = seat >= 0 && seat < s.n ? s.roles[seat] : null;
  const pub = s.phase === 'day' || s.phase === 'vote';
  const deadView = seat >= 0 && !s.alive[seat];
  return {
    n: s.n,
    mySeat: seat,
    myRole: me,
    phase: s.phase,
    day: s.day,
    pid: s.pid,
    alive: s.alive,
    roles: s.roles.map((_, p) => knownRole(s, seat, p)),
    composition: rolesFor(s.n),
    done: seat >= 0 ? s.acted[seat] : true,
    acted:
      pub || deadView
        ? s.acted
        : s.acted.map((a, i) => (i === seat ? a : false)),
    votes:
      s.phase === 'vote' || deadView
        ? s.votes
        : new Array<number>(s.n).fill(-2),
    wolfVotes: me === 'wolf' || deadView ? s.wolfVotes : null,
    victim:
      (me === 'witch' && s.phase === 'witch') ||
      (me === 'wolf' && s.phase === 'witch') ||
      deadView
        ? s.victim
        : -1,
    potions: me === 'witch' || deadView ? s.potions : null,
    lastGuard: me === 'guard' || deadView ? s.lastGuard : -1,
    seerLog: me === 'seer' || deadView || s.phase === 'over' ? s.seerLog : [],
    hunterSeat: s.phase === 'hunter' ? (s.hunter?.seat ?? -1) : -1,
    cause: s.cause,
    events: s.events,
    winner: s.winner,
    reveal: s.settings.reveal,
  };
}
