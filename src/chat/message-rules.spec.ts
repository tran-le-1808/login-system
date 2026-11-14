import { MessageType } from './entities/message.entity';
import {
  buildReplyPreview,
  canEditMessage,
  canRecallMessage,
  minutesFromEnv,
} from './message-rules';
import { normalizeVi } from '../common/normalize-vi';

const NOW = new Date('2026-01-01T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const text = (over = {}) => ({
  senderId: 'a',
  type: MessageType.TEXT,
  createdAt: ago(1),
  recalledAt: null,
  ...over,
});

describe('normalizeVi', () => {
  it('bỏ dấu, đ -> d, hạ chữ hoa, gọn khoảng trắng', () => {
    expect(normalizeVi('Nguyễn')).toBe('nguyen');
    expect(normalizeVi('  Đặng   Văn  ĐÔNG ')).toBe('dang van dong');
    expect(normalizeVi('đang')).toBe('dang');
  });
  it('"nguyen" khớp "Nguyễn" và "dang" khớp "Đặng/đang"', () => {
    expect(normalizeVi('Nguyễn Văn A')).toContain(normalizeVi('nguyen'));
    expect(normalizeVi('Đặng')).toContain(normalizeVi('dang'));
  });
});

describe('canEditMessage', () => {
  it('người gửi sửa được tin chữ trong thời hạn', () => {
    expect(canEditMessage(text(), 'a', NOW, 15)).toEqual({ ok: true });
  });
  it('người khác không sửa được', () => {
    expect(canEditMessage(text(), 'b', NOW, 15)).toMatchObject({
      ok: false,
      code: 'NOT_OWNER',
    });
  });
  it('quá hạn bị từ chối; 0 = không giới hạn', () => {
    expect(
      canEditMessage(text({ createdAt: ago(16) }), 'a', NOW, 15),
    ).toMatchObject({ ok: false, code: 'EXPIRED' });
    expect(
      canEditMessage(text({ createdAt: ago(99999) }), 'a', NOW, 0),
    ).toEqual({ ok: true });
  });
  it('không sửa tin đã thu hồi hoặc tin chỉ có ảnh/tệp', () => {
    expect(
      canEditMessage(text({ recalledAt: ago(1) }), 'a', NOW, 15),
    ).toMatchObject({ ok: false, code: 'RECALLED' });
    expect(
      canEditMessage(text({ type: MessageType.IMAGE }), 'a', NOW, 15),
    ).toMatchObject({ ok: false, code: 'NOT_EDITABLE' });
    expect(
      canEditMessage(text({ type: MessageType.MIXED }), 'a', NOW, 15),
    ).toEqual({ ok: true });
  });
});

describe('canRecallMessage', () => {
  it('chỉ người gửi, chưa thu hồi; mặc định không giới hạn thời gian', () => {
    expect(
      canRecallMessage(text({ createdAt: ago(100000) }), 'a', NOW, 0),
    ).toEqual({ ok: true });
    expect(canRecallMessage(text(), 'b', NOW, 0)).toMatchObject({
      ok: false,
      code: 'NOT_OWNER',
    });
    expect(
      canRecallMessage(text({ recalledAt: ago(1) }), 'a', NOW, 0),
    ).toMatchObject({ ok: false, code: 'RECALLED' });
  });
  it('có thời hạn thì quá hạn bị từ chối', () => {
    expect(
      canRecallMessage(text({ createdAt: ago(11) }), 'a', NOW, 10),
    ).toMatchObject({ ok: false, code: 'EXPIRED' });
  });
});

describe('minutesFromEnv', () => {
  it('đọc số hợp lệ, sai thì dùng mặc định', () => {
    expect(minutesFromEnv('EDIT_WINDOW_MINUTES', 15, {})).toBe(15);
    expect(
      minutesFromEnv('EDIT_WINDOW_MINUTES', 15, { EDIT_WINDOW_MINUTES: '0' }),
    ).toBe(0);
    expect(
      minutesFromEnv('EDIT_WINDOW_MINUTES', 15, { EDIT_WINDOW_MINUTES: 'abc' }),
    ).toBe(15);
    expect(
      minutesFromEnv('RECALL_WINDOW_MINUTES', 0, {
        RECALL_WINDOW_MINUTES: '30',
      }),
    ).toBe(30);
  });
});

describe('buildReplyPreview', () => {
  const orig = {
    _id: 'm1',
    senderId: 'a',
    text: 'dòng 1\ndòng 2\ndòng 3',
    type: 'TEXT',
    attachments: [{ name: 'x.png', type: 'image/png', url: 'https://u/x.png' }],
  };
  it('lấy 2 dòng đầu, kèm tệp', () => {
    const p = buildReplyPreview(orig);
    expect(p.text).toBe('dòng 1\ndòng 2');
    expect(p.unavailable).toBe(false);
    expect(p.attachments[0].url).toBe('https://u/x.png');
  });
  it('tin gốc đã thu hồi / đã xoá ở phía tôi: KHÔNG lộ nội dung cũ', () => {
    for (const p of [
      buildReplyPreview({ ...orig, recalledAt: NOW }),
      buildReplyPreview(orig, true),
    ]) {
      expect(p.unavailable).toBe(true);
      expect(p.text).toBe('');
      expect(p.attachments).toEqual([]);
    }
  });
});
