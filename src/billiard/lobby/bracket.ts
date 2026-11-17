/**
 * Nhánh đấu loại trực tiếp (Single Elimination) — logic thuần, server là nơi duy nhất sửa kết quả.
 * Cấu trúc `rounds[r][i]` cho phép mở rộng Double Elimination (thêm nhánh thua) sau này.
 */
export type BracketFormat = 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION';
export type BracketMatchStatus =
  | 'PENDING'
  | 'READY'
  | 'PLAYING'
  | 'COMPLETED'
  | 'BYE';

export interface BracketMatch {
  id: string;
  round: number;
  slot: number;
  playerA: string | null;
  playerB: string | null;
  winner: string | null;
  status: BracketMatchStatus;
  score: [number, number] | null;
  roomCode: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface Bracket {
  format: BracketFormat;
  size: number;
  rounds: BracketMatch[][];
  /** Thứ tự hạt giống (userId) */
  seeds: string[];
}

export interface Seedable {
  userId: string;
  rating: number;
}

const nextPow2 = (n: number) => {
  let s = 1;
  while (s < n) s *= 2;
  return s;
};

/** Thứ tự đặt hạt giống chuẩn: 1 gặp N, 2 gặp N−1… (hạt giống cao nhận bye trước) */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

export function roundName(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round;
  if (fromEnd === 1) return 'Chung kết';
  if (fromEnd === 2) return 'Bán kết';
  if (fromEnd === 3) return 'Tứ kết';
  return `Vòng ${round + 1}`;
}

/** Xếp hạt giống: theo rating (cao trước) hoặc ngẫu nhiên (rng trả 0..1) */
export function seedPlayers(
  players: Seedable[],
  mode: 'random' | 'rating',
  rng: () => number,
): string[] {
  if (mode === 'rating')
    return [...players]
      .sort((a, b) => b.rating - a.rating || a.userId.localeCompare(b.userId))
      .map((p) => p.userId);
  const ids = players.map((p) => p.userId);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

const emptyMatch = (round: number, slot: number): BracketMatch => ({
  id: `r${round}m${slot}`,
  round,
  slot,
  playerA: null,
  playerB: null,
  winner: null,
  status: 'PENDING',
  score: null,
  roomCode: null,
  startedAt: null,
  endedAt: null,
});

/** Tạo nhánh đấu từ danh sách hạt giống; tự xử lý bye khi số người không phải luỹ thừa của 2 */
export function createBracket(
  seeds: string[],
  format: BracketFormat = 'SINGLE_ELIMINATION',
): Bracket {
  if (seeds.length < 2) throw new Error('Cần ít nhất 2 người chơi');
  if (format !== 'SINGLE_ELIMINATION')
    throw new Error('Chưa hỗ trợ thể thức này');
  const size = nextPow2(seeds.length);
  const totalRounds = Math.log2(size);
  const rounds: BracketMatch[][] = [];
  for (let r = 0; r < totalRounds; r++)
    rounds.push(
      Array.from({ length: size / 2 ** (r + 1) }, (_, i) => emptyMatch(r, i)),
    );
  const order = seedOrder(size);
  for (let i = 0; i < size / 2; i++) {
    const m = rounds[0][i];
    m.playerA = seeds[order[2 * i] - 1] ?? null;
    m.playerB = seeds[order[2 * i + 1] - 1] ?? null;
  }
  const b: Bracket = { format, size, rounds, seeds: [...seeds] };
  for (const m of rounds[0]) {
    if (m.playerA && m.playerB) m.status = 'READY';
    else {
      // bye: người duy nhất đi tiếp luôn
      m.status = 'BYE';
      m.winner = m.playerA ?? m.playerB;
      advance(b, m);
    }
  }
  return b;
}

function advance(b: Bracket, m: BracketMatch): void {
  const next = b.rounds[m.round + 1]?.[Math.floor(m.slot / 2)];
  if (!next || !m.winner) return;
  if (m.slot % 2 === 0) next.playerA = m.winner;
  else next.playerB = m.winner;
  if (next.playerA && next.playerB && next.status === 'PENDING')
    next.status = 'READY';
}

export function findMatch(
  b: Bracket,
  matchId: string,
): BracketMatch | undefined {
  for (const r of b.rounds) for (const m of r) if (m.id === matchId) return m;
  return undefined;
}

/**
 * Ghi người thắng một trận (chỉ server gọi). Trả về các trận vừa sẵn sàng.
 * Không cho ghi lại trận đã xong, không cho người thắng ngoài hai người của trận.
 */
export function reportWinner(
  b: Bracket,
  matchId: string,
  winnerId: string,
  score: [number, number] | null,
  now: number,
):
  | { ok: true; ready: BracketMatch[]; champion: string | null }
  | { ok: false; error: string } {
  const m = findMatch(b, matchId);
  if (!m) return { ok: false, error: 'Không có trận này' };
  if (m.status === 'COMPLETED' || m.status === 'BYE')
    return { ok: false, error: 'Trận đã có kết quả' };
  if (m.status !== 'READY' && m.status !== 'PLAYING')
    return { ok: false, error: 'Trận chưa sẵn sàng' };
  if (winnerId !== m.playerA && winnerId !== m.playerB)
    return { ok: false, error: 'Người thắng không hợp lệ' };
  const before = new Set(readyMatches(b).map((x) => x.id));
  m.winner = winnerId;
  m.score = score;
  m.status = 'COMPLETED';
  m.endedAt = now;
  advance(b, m);
  const ready = readyMatches(b).filter(
    (x) => !before.has(x.id) && x.id !== m.id,
  );
  return { ok: true, ready, champion: champion(b) };
}

export function readyMatches(b: Bracket): BracketMatch[] {
  return b.rounds.flat().filter((m) => m.status === 'READY' && !m.roomCode);
}

export function champion(b: Bracket): string | null {
  const final = b.rounds[b.rounds.length - 1][0];
  return final.status === 'COMPLETED' ? final.winner : null;
}

/** Tổng số trận thật (không tính bye) */
export function totalMatches(b: Bracket): number {
  return b.rounds.flat().filter((m) => m.status !== 'BYE').length;
}
