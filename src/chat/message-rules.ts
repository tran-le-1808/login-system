import { MessageType } from './entities/message.entity';

/** Cấu hình thời hạn (phút) đọc từ biến môi trường; 0 = không giới hạn */
export function minutesFromEnv(
  name: 'EDIT_WINDOW_MINUTES' | 'RECALL_WINDOW_MINUTES',
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface RuleMessage {
  senderId: string;
  type: MessageType;
  createdAt: Date | string;
  recalledAt?: Date | string | null;
}

export type RuleResult =
  | { ok: true }
  | {
      ok: false;
      code: 'NOT_OWNER' | 'RECALLED' | 'NOT_EDITABLE' | 'EXPIRED';
      message: string;
    };

const withinWindow = (createdAt: Date | string, windowMin: number, now: Date) =>
  windowMin === 0 ||
  now.getTime() - new Date(createdAt).getTime() <= windowMin * 60_000;

/**
 * Chỉ người gửi sửa được, chỉ tin có chữ (TEXT, hoặc MIXED = chữ + tệp), không sửa tin đã
 * thu hồi, trong thời hạn EDIT_WINDOW_MINUTES (0 = không giới hạn).
 */
export function canEditMessage(
  msg: RuleMessage,
  userId: string,
  now: Date,
  windowMin: number,
): RuleResult {
  if (msg.senderId !== userId)
    return {
      ok: false,
      code: 'NOT_OWNER',
      message: 'Chỉ người gửi mới sửa được',
    };
  if (msg.recalledAt)
    return { ok: false, code: 'RECALLED', message: 'Tin nhắn đã bị thu hồi' };
  if (msg.type !== MessageType.TEXT && msg.type !== MessageType.MIXED)
    return {
      ok: false,
      code: 'NOT_EDITABLE',
      message: 'Chỉ sửa được tin nhắn có nội dung chữ',
    };
  if (!withinWindow(msg.createdAt, windowMin, now))
    return {
      ok: false,
      code: 'EXPIRED',
      message: `Đã quá ${windowMin} phút, không thể chỉnh sửa`,
    };
  return { ok: true };
}

/** Thu hồi: chỉ người gửi, tin chưa thu hồi, trong thời hạn RECALL_WINDOW_MINUTES (0 = không giới hạn) */
export function canRecallMessage(
  msg: RuleMessage,
  userId: string,
  now: Date,
  windowMin: number,
): RuleResult {
  if (msg.senderId !== userId)
    return {
      ok: false,
      code: 'NOT_OWNER',
      message: 'Chỉ người gửi mới thu hồi được',
    };
  if (msg.recalledAt)
    return { ok: false, code: 'RECALLED', message: 'Tin nhắn đã bị thu hồi' };
  if (!withinWindow(msg.createdAt, windowMin, now))
    return {
      ok: false,
      code: 'EXPIRED',
      message: `Đã quá ${windowMin} phút, không thể thu hồi`,
    };
  return { ok: true };
}

export interface ReplyPreview {
  messageId: string;
  senderId: string;
  /** 1–2 dòng đầu của nội dung (rỗng nếu chỉ có tệp) */
  text: string;
  type: string;
  /** Tên + loại tệp để hiện biểu tượng / hình thu nhỏ */
  attachments: { name: string; type: string; url?: string }[];
  /** Tin gốc đã bị thu hồi (hoặc tôi đã xoá ở phía mình) -> hiện "Tin nhắn đã bị thu hồi" */
  unavailable: boolean;
}

const PREVIEW_CHARS = 120;

/** Bản xem trước gọn của tin được trả lời. Tin đã thu hồi KHÔNG lộ nội dung cũ. */
export function buildReplyPreview(
  original: {
    _id: unknown;
    senderId: string;
    text?: string;
    type: string;
    attachments?: { name: string; type: string; url: string }[];
    recalledAt?: Date | string | null;
  },
  hiddenForViewer = false,
): ReplyPreview {
  const unavailable = !!original.recalledAt || hiddenForViewer;
  const text = unavailable
    ? ''
    : (original.text ?? '')
        .split('\n')
        .slice(0, 2)
        .join('\n')
        .slice(0, PREVIEW_CHARS);
  return {
    messageId: String(original._id),
    senderId: original.senderId,
    text,
    type: String(original.type),
    attachments: unavailable
      ? []
      : (original.attachments ?? []).slice(0, 3).map((a) => ({
          name: a.name,
          type: a.type,
          url: a.type.startsWith('image') ? a.url : undefined,
        })),
    unavailable,
  };
}
