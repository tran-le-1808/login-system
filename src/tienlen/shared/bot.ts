/**
 * BOT TIẾN LÊN (dùng chung cho trình duyệt và server).
 *  - easy: đánh bộ hợp lệ bất kỳ, hay bỏ lượt
 *  - normal: cầm cái thì xả bộ dài chứa lá nhỏ nhất; đè thì dùng bộ yếu nhất, tiếc heo / bom
 *  - hard: như normal nhưng giữ bom để chặt, ép mạnh khi đối thủ sắp hết bài, không phá bộ khi không cần
 */
import {
  beats,
  comboOf,
  pass,
  play,
  rankOf,
  scoreOf,
  type Combo,
  type TLState,
} from './cards';

export type TLBotLevel = 'easy' | 'normal' | 'hard';
export const TL_BOT_LEVELS: Record<TLBotLevel, string> = {
  easy: 'Dễ',
  normal: 'Vừa',
  hard: 'Khó',
};

interface Cand {
  cards: number[];
  combo: Combo;
}

/** Mọi bộ có thể tạo từ bài trên tay (sảnh / đôi thông lấy lá nhỏ nhất mỗi nước để tránh bùng nổ tổ hợp) */
export function allCombos(hand: readonly number[]): Cand[] {
  const byRank = new Map<number, number[]>();
  for (const c of [...hand].sort((a, b) => a - b)) {
    const r = rankOf(c);
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(c);
  }
  const out: Cand[] = [];
  const add = (cards: number[]) => {
    const combo = comboOf(cards);
    if (combo) out.push({ cards, combo });
  };
  for (const c of hand) add([c]);
  for (const [, cs] of byRank) {
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) add([cs[i], cs[j]]);
    if (cs.length >= 3) {
      add(cs.slice(0, 3));
      add(cs.slice(-3));
    }
    if (cs.length === 4) add(cs.slice());
  }
  // sảnh: với mỗi nước đầu, kéo dài dần; lá cuối thử mọi chất để có thể đè
  for (let start = 0; start < 12; start++) {
    const run: number[] = [];
    for (let r = start; r < 12 && byRank.has(r); r++) {
      run.push(byRank.get(r)![0]);
      if (run.length >= 3)
        for (const last of byRank.get(r)!) add([...run.slice(0, -1), last]);
    }
  }
  // đôi thông
  for (let start = 0; start < 12; start++) {
    const run: number[] = [];
    for (let r = start; r < 12 && (byRank.get(r)?.length ?? 0) >= 2; r++) {
      const cs = byRank.get(r)!;
      run.push(cs[0], cs[1]);
      if (run.length >= 6)
        add([...run.slice(0, -2), cs[cs.length - 2], cs[cs.length - 1]]);
    }
  }
  return out;
}

const isBomb = (c: Combo) =>
  c.type === 'quad' || (c.type === 'pairs' && c.len >= 6);
const hasHeo = (cards: number[]) => cards.some((c) => rankOf(c) === 12);

/** Bộ này làm vỡ bao nhiêu bộ khác (đôi / sám / sảnh) trên tay — càng ít càng tốt */
function breakCost(hand: readonly number[], cards: number[]): number {
  const rest = hand.filter((c) => !cards.includes(c));
  const cnt = (h: readonly number[]) => {
    const m = new Map<number, number>();
    for (const c of h) m.set(rankOf(c), (m.get(rankOf(c)) ?? 0) + 1);
    return m;
  };
  const before = cnt(hand);
  const after = cnt(rest);
  let cost = 0;
  for (const c of cards) {
    const r = rankOf(c);
    const b = before.get(r) ?? 0;
    const a = after.get(r) ?? 0;
    if (b >= 2 && a === 1) cost += 2; // phá đôi
    if (b >= 3 && a < 3 && a > 0) cost += 1;
  }
  return cost;
}

export type BotAction = { kind: 'play'; cards: number[] } | { kind: 'pass' };

export function botAction(
  s: TLState,
  seat: number,
  level: TLBotLevel,
  rng: () => number = Math.random,
): BotAction {
  if (level === 'hard' && s.hands[seat].length <= 7) {
    const mc = monteCarlo(s, seat, rng);
    if (mc) return mc;
  }
  return heuristic(s, seat, level, rng);
}

/**
 * Tàn ván (mức Khó): thử từng lựa chọn, chia lại ngẫu nhiên bài chưa biết của đối thủ (giữ đúng số lá),
 * cho các bên đánh tiếp bằng bot "Vừa" tới hết ván, chọn lựa chọn có điểm trung bình cao nhất.
 */
function monteCarlo(
  s: TLState,
  seat: number,
  rng: () => number,
): BotAction | null {
  const hand = s.hands[seat];
  let cands = allCombos(hand);
  if (s.mustPlay >= 0)
    cands = cands.filter((c) => c.cards.includes(s.mustPlay));
  const prev = s.table?.combo ?? null;
  const legal = prev ? cands.filter((c) => beats(c.combo, prev)) : cands;
  const options: BotAction[] = legal
    .slice(0, 10)
    .map((c) => ({ kind: 'play', cards: c.cards }));
  if (prev) options.push({ kind: 'pass' });
  if (options.length <= 1) return options[0] ?? null;
  const unknown = s.hands.flatMap((h, i) => (i === seat ? [] : h));
  const SIMS = 24;
  let best: BotAction | null = null;
  let bestScore = -Infinity;
  for (const opt of options) {
    let total = 0;
    for (let k = 0; k < SIMS; k++) {
      // chia lại bài chưa biết
      const pool = unknown.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      let off = 0;
      const hands = s.hands.map((h, i) => {
        if (i === seat) return h.slice();
        const part = pool.slice(off, off + h.length).sort((a, b) => a - b);
        off += h.length;
        return part;
      });
      let st: TLState = { ...s, hands };
      const first =
        opt.kind === 'play' ? play(st, seat, opt.cards) : pass(st, seat);
      if (!first.ok) {
        total -= 100;
        continue;
      }
      st = first.state;
      let guard = 0;
      while (!st.over && guard++ < 300) {
        const a = heuristic(st, st.turn, 'normal', rng);
        const r =
          a.kind === 'play' ? play(st, st.turn, a.cards) : pass(st, st.turn);
        if (!r.ok) break;
        st = r.state;
      }
      total += scoreOf(st)[seat];
    }
    if (total > bestScore) {
      bestScore = total;
      best = opt;
    }
  }
  return best;
}

function heuristic(
  s: TLState,
  seat: number,
  level: TLBotLevel,
  rng: () => number,
): BotAction {
  const hand = s.hands[seat];
  let cands = allCombos(hand);
  if (s.mustPlay >= 0)
    cands = cands.filter((c) => c.cards.includes(s.mustPlay));
  const prev = s.table?.combo ?? null;
  const legal = prev ? cands.filter((c) => beats(c.combo, prev)) : cands;
  if (!legal.length) return { kind: 'pass' };
  // đánh hết bài trong một nước
  const finish = legal.find((c) => c.cards.length === hand.length);
  if (finish) return { kind: 'play', cards: finish.cards };

  // Khó: nếu đánh xong bộ này phần còn lại thành một bộ (nhất là bộ mạnh) -> lượt sau về luôn
  if (level !== 'easy') {
    const plan = legal
      .map((c) => {
        const rest = hand.filter((x) => !c.cards.includes(x));
        const rc = comboOf(rest);
        return rc ? { c, strong: rankOf(rc.top) === 12 || isBomb(rc) } : null;
      })
      .filter((x): x is { c: Cand; strong: boolean } => !!x)
      .sort((a, b) => Number(b.strong) - Number(a.strong));
    if (plan.length && plan[0].strong)
      return { kind: 'play', cards: plan[0].c.cards };
  }

  const others = Array.from({ length: s.n }, (_, i) => i).filter(
    (i) => i !== seat && !s.finished.includes(i),
  );
  const minOpp = Math.min(...others.map((i) => s.hands[i].length));
  const danger = minOpp <= 3;

  if (level === 'easy') {
    if (prev && rng() < 0.35) return { kind: 'pass' };
    const pick = legal[Math.floor(rng() * legal.length)];
    return { kind: 'play', cards: pick.cards };
  }

  if (!prev) {
    // cầm cái: xả bộ chứa lá nhỏ nhất, ưu tiên bộ nhiều lá; không mở bằng heo / bom nếu còn lựa chọn khác
    const low = s.mustPlay >= 0 ? s.mustPlay : Math.min(...hand);
    let pool = legal.filter((c) => c.cards.includes(low));
    if (!pool.length) pool = legal;
    const safe = pool.filter((c) => !isBomb(c.combo) && !hasHeo(c.cards));
    if (safe.length) pool = safe;
    pool.sort((a, b) => {
      const score = (c: Cand) =>
        c.cards.length * 3 -
        breakCost(hand, c.cards) * 2 -
        c.combo.top / (level === 'hard' ? 26 : 52);
      return score(b) - score(a);
    });
    // đối thủ sắp hết: tránh đánh rác lẻ yếu, đánh bộ lớn
    if (danger && level === 'hard') {
      const big = legal
        .filter((c) => c.cards.length >= 2 && !isBomb(c.combo))
        .sort((a, b) => b.cards.length - a.cards.length);
      if (big.length) return { kind: 'play', cards: big[0].cards };
      const highest = legal
        .filter((c) => c.cards.length === 1)
        .sort((a, b) => b.combo.top - a.combo.top)[0];
      if (highest) return { kind: 'play', cards: highest.cards };
    }
    return { kind: 'play', cards: pool[0].cards };
  }

  // đè: chọn bộ yếu nhất, ít phá bộ nhất
  const sorted = legal.slice().sort((a, b) => {
    const pen = (c: Cand) =>
      (isBomb(c.combo) ? 400 : 0) +
      (hasHeo(c.cards) ? 120 : 0) +
      breakCost(hand, c.cards) * 30 +
      c.combo.top;
    return pen(a) - pen(b);
  });
  const best = sorted[0];
  const precious = isBomb(best.combo) || hasHeo(best.cards);
  if (precious && !danger) {
    // chặt heo bằng bom là đáng; còn lại thì tiếc, bỏ lượt khi còn nhiều bài
    const choppingHeo = isBomb(best.combo) && rankOf(prev.top) === 12;
    if (!choppingHeo && hand.length > 4 && rng() < 0.6) return { kind: 'pass' };
  }
  if (level === 'normal' && !danger && rng() < 0.08) return { kind: 'pass' };
  return { kind: 'play', cards: best.cards };
}
