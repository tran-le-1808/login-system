/**
 * NÉT VẼ (dùng chung trình duyệt & server): toạ độ chuẩn hoá 0..1000 trên khung 4:3,
 * màu / cỡ là chỉ số trong bảng. Mỗi nét / lần đổ màu / xoá bảng là một "nhóm" (g) để Hoàn tác.
 */
export const PALETTE = [
  '#ffffff',
  '#000000',
  '#7a7a7a',
  '#c1c1c1',
  '#e53935',
  '#ff8a65',
  '#fb8c00',
  '#ffd54f',
  '#fdd835',
  '#43a047',
  '#9ccc65',
  '#00897b',
  '#1e88e5',
  '#81d4fa',
  '#3949ab',
  '#8e24aa',
  '#f06292',
  '#6d4c41',
  '#d7a86e',
  '#ffcdd2',
];
export const SIZES = [3, 8, 16, 32];
export const W = 800;
export const H = 600;

export type DrawOp =
  | { k: 'l'; g: number; c: number; s: number; p: number[] }
  | { k: 'f'; g: number; c: number; x: number; y: number }
  | { k: 'x'; g: number }
  | { k: 'u' };

const MAX_POINTS = 400;
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Kiểm tra gói nét vẽ gửi lên (null = không hợp lệ) */
export function sanitizeOps(raw: unknown): DrawOp[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 60) return null;
  const out: DrawOp[] = [];
  for (const o of raw as Record<string, unknown>[]) {
    if (!o || typeof o !== 'object') return null;
    if (o.k === 'u') out.push({ k: 'u' });
    else if (o.k === 'x' && isInt(o.g, 0, 1e9)) out.push({ k: 'x', g: o.g });
    else if (
      o.k === 'f' &&
      isInt(o.g, 0, 1e9) &&
      isInt(o.c, 0, PALETTE.length - 1) &&
      isInt(o.x, 0, 1000) &&
      isInt(o.y, 0, 1000)
    )
      out.push({ k: 'f', g: o.g, c: o.c, x: o.x, y: o.y });
    else if (
      o.k === 'l' &&
      isInt(o.g, 0, 1e9) &&
      isInt(o.c, 0, PALETTE.length - 1) &&
      isInt(o.s, 0, SIZES.length - 1) &&
      Array.isArray(o.p)
    ) {
      const p = o.p as unknown[];
      if (
        p.length < 2 ||
        p.length % 2 ||
        p.length > MAX_POINTS * 2 ||
        !p.every((v) => isInt(v, 0, 1000))
      )
        return null;
      out.push({ k: 'l', g: o.g, c: o.c, s: o.s, p });
    } else return null;
  }
  return out;
}

/** Bỏ các nhóm đã bị Hoàn tác */
export function effectiveOps(ops: DrawOp[]): DrawOp[] {
  const groups: { g: number; ops: DrawOp[] }[] = [];
  for (const op of ops) {
    if (op.k === 'u') {
      groups.pop();
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.g === op.g) last.ops.push(op);
    else groups.push({ g: op.g, ops: [op] });
  }
  return groups.flatMap((x) => x.ops);
}

/** Gộp các đoạn liên tiếp của cùng một nét để gửi gọn hơn */
export function mergeOps(ops: DrawOp[]): DrawOp[] {
  const out: DrawOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (
      op.k === 'l' &&
      last?.k === 'l' &&
      last.g === op.g &&
      last.c === op.c &&
      last.s === op.s &&
      last.p.length + op.p.length <= MAX_POINTS * 2
    ) {
      const [lx, ly] = last.p.slice(-2);
      const p = op.p[0] === lx && op.p[1] === ly ? op.p.slice(2) : op.p;
      out[out.length - 1] = { ...last, p: [...last.p, ...p] };
    } else out.push(op.k === 'l' ? { ...op, p: op.p.slice() } : op);
  }
  return out;
}
