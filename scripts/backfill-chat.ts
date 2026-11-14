/**
 * Migration: điền dữ liệu mới cho tin nhắn / hội thoại CŨ (không xoá gì, chỉ thêm trường).
 *   - messages.seq: 1,2,3… theo thứ tự createdAt, TỪNG hội thoại
 *   - conversations.lastSeq: = seq lớn nhất
 *   - messages.searchText: nội dung đã chuẩn hoá không dấu (để tìm kiếm thấy tin cũ)
 *
 * Chạy:   npm run chat:backfill            (cần MONGODB_URI trong .env)
 * Chạy thử (không ghi): npm run chat:backfill -- --dry-run
 * Có thể chạy lại nhiều lần (idempotent): chỉ xử lý tin chưa có seq / searchText.
 * Hoàn tác (rollback): npm run chat:backfill -- --rollback   (gỡ seq, lastSeq, searchText)
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { normalizeVi } from '../src/common/normalize-vi';

const dryRun = process.argv.includes('--dry-run');
const rollback = process.argv.includes('--rollback');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Thiếu MONGODB_URI');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Không kết nối được CSDL');
  const messages = db.collection('messages');
  const conversations = db.collection('conversations');

  if (rollback) {
    if (dryRun) console.log('[dry-run] sẽ gỡ seq/lastSeq/searchText');
    else {
      await messages.updateMany({}, { $unset: { seq: '', searchText: '' } });
      await conversations.updateMany({}, { $unset: { lastSeq: '' } });
      console.log('Đã gỡ seq, lastSeq, searchText.');
    }
    await mongoose.disconnect();
    return;
  }

  const convIds = await messages.distinct('conversationId');
  let seqDone = 0;
  let textDone = 0;
  for (const conversationId of convIds) {
    const maxExisting = await messages
      .find({ conversationId, seq: { $type: 'number' } })
      .sort({ seq: -1 })
      .limit(1)
      .toArray();
    let seq = (maxExisting[0]?.seq as number | undefined) ?? 0;

    const missing = messages
      .find({ conversationId, seq: { $not: { $type: 'number' } } })
      .sort({ createdAt: 1, _id: 1 });
    for await (const m of missing) {
      seq += 1;
      seqDone += 1;
      if (!dryRun) await messages.updateOne({ _id: m._id }, { $set: { seq } });
    }
    if (!dryRun)
      await conversations.updateOne(
        { _id: new mongoose.Types.ObjectId(String(conversationId)) },
        { $max: { lastSeq: seq } },
      );
  }

  const needText = messages.find({
    recalledAt: null,
    searchText: { $in: [null, undefined] },
    text: { $type: 'string', $ne: '' },
  });
  for await (const m of needText) {
    textDone += 1;
    if (!dryRun)
      await messages.updateOne(
        { _id: m._id },
        { $set: { searchText: normalizeVi(String(m.text)) } },
      );
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Điền seq cho ${seqDone} tin, searchText cho ${textDone} tin, ${convIds.length} hội thoại.`,
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
