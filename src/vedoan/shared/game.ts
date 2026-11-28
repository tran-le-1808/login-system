/**
 * VẼ ĐOÁN — luật thuần (dùng chung cho trình duyệt và server):
 * so đáp án (bỏ dấu / hoa thường / khoảng trắng), "gần đúng", gợi ý chữ cái, chấm điểm, chọn từ.
 */
import { WORDS } from './words';

/** Chuẩn hoá để so đáp án: chữ thường, bỏ dấu, đ -> d, bỏ ký tự lạ, gộp khoảng trắng */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bỏ chữ "con / cái / quả…" ở đầu để chấp nhận "mèo" cho "con mèo" */
const LEADING = [
  'con',
  'cai',
  'qua',
  'cay',
  'chiec',
  'doi',
  'ly',
  'to',
  'o',
  'cu',
  'bong',
  'ngon',
  'dam',
  'quyen',
  'ngoi',
  'bap',
  'phong bao',
];
function core(s: string): string {
  const n = normalize(s);
  for (const l of LEADING)
    if (n.startsWith(l + ' ') && n.length > l.length + 2)
      return n.slice(l.length + 1);
  return n;
}

export function isCorrect(guess: string, word: string): boolean {
  const g = normalize(guess);
  if (!g) return false;
  return (
    g === normalize(word) ||
    (core(word) !== normalize(word) && g === core(word))
  );
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...new Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length][b.length];
}

/** Gần đúng: sai 1 ký tự (từ dài ≥ 5 thì cho 2) */
export function isClose(guess: string, word: string): boolean {
  if (isCorrect(guess, word)) return false;
  const g = normalize(guess);
  if (g.length < 3) return false;
  return [normalize(word), core(word)].some((t) => {
    const d = distance(g, t);
    return d <= (t.length >= 8 ? 2 : 1);
  });
}

/** Mẫu gợi ý: "c _ _   m _ _" (khoảng trắng giữa các tiếng hiện rõ). `revealed` = vị trí ký tự đã lộ. */
export function hintMask(word: string, revealed: number[] = []): string {
  const set = new Set(revealed);
  return [...word]
    .map((ch, i) => (ch === ' ' ? ' ' : set.has(i) ? ch : '_'))
    .join('');
}

/** Chọn thêm vị trí chữ cái để lộ (không lộ khoảng trắng, tối đa ~40% số chữ) */
export function nextReveal(
  word: string,
  revealed: number[],
  rng: () => number = Math.random,
): number[] {
  const letters = [...word]
    .map((ch, i) => (ch === ' ' ? -1 : i))
    .filter((i) => i >= 0);
  const limit = Math.floor(letters.length * 0.4);
  if (revealed.length >= limit) return revealed;
  const left = letters.filter((i) => !revealed.includes(i));
  if (!left.length) return revealed;
  return [...revealed, left[Math.floor(rng() * left.length)]].sort(
    (a, b) => a - b,
  );
}

const round5 = (x: number) => Math.round(x / 5) * 5;

/** Điểm người đoán: nhanh hơn thì nhiều hơn; 3 người đoán đầu có thưởng thêm */
export function guessPoints(remainingFrac: number, order: number): number {
  const f = Math.max(0, Math.min(1, remainingFrac));
  return round5(50 + 250 * f) + ([30, 20, 10][order] ?? 0);
}

/** Điểm người vẽ: theo tỉ lệ người đoán đúng */
export function drawerPoints(correct: number, others: number): number {
  if (!others || !correct) return 0;
  return round5(50 + 200 * (correct / others));
}

/** 3 từ để người vẽ chọn (dễ / vừa / khó nếu có), tránh từ đã dùng */
export function pickChoices(
  used: Set<string>,
  custom: string[] = [],
  onlyCustom = false,
  rng: () => number = Math.random,
): string[] {
  const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
  const customLeft = custom.filter((w) => !used.has(w));
  const out: string[] = [];
  if (onlyCustom && customLeft.length) {
    const pool = customLeft.slice();
    while (out.length < 3 && pool.length)
      out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    return out;
  }
  for (const d of [1, 2, 3] as const) {
    if (customLeft.length && rng() < 0.4) {
      const w = pick(customLeft.filter((x) => !out.includes(x)));
      if (w) {
        out.push(w);
        continue;
      }
    }
    const pool = WORDS.filter(
      (x) => x.d === d && !used.has(x.w) && !out.includes(x.w),
    );
    const any = pool.length ? pool : WORDS.filter((x) => !out.includes(x.w));
    out.push(pick(any).w);
  }
  return out;
}

/** Chuẩn hoá danh sách từ tự nhập (mỗi dòng / dấu phẩy một từ) */
export function parseCustomWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const w = raw.replace(/\s+/g, ' ').trim().slice(0, 30);
    const k = normalize(w);
    if (k.length < 2 || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= 200) break;
  }
  return out;
}

/** Tin nhắn có lộ đáp án không (dùng chặn người vẽ / người đã đoán đúng nói lộ) */
export function leaksWord(text: string, word: string): boolean {
  const t = ` ${normalize(text).replace(/ /g, '')} `;
  const w = normalize(word).replace(/ /g, '');
  const c = core(word).replace(/ /g, '');
  return (w.length >= 2 && t.includes(w)) || (c.length >= 3 && t.includes(c));
}
