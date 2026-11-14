import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { MessageType } from './entities/message.entity';

/** Chuỗi truy vấn mongoose giả: find().select().sort().limit().lean().exec() -> value */
const chain = <T>(value: T) => {
  const c: Record<string, jest.Mock> = {};
  for (const k of ['select', 'sort', 'limit', 'skip', 'lean'])
    c[k] = jest.fn(() => c);
  c.exec = jest.fn(() => Promise.resolve(value));
  (c as unknown as { then: unknown }).then = (
    res: (v: T) => unknown,
    rej: unknown,
  ) => Promise.resolve(value).then(res, rej as never);
  (c as unknown as { catch: unknown }).catch = (rej: (e: unknown) => unknown) =>
    Promise.resolve(value).catch(rej);
  return c;
};

function setup() {
  const emitted: { room: string; event: string; payload: unknown }[] = [];
  const server = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) =>
        emitted.push({ room, event, payload }),
    }),
  };
  const conv = {
    _id: 'c1',
    participants: ['a', 'b'],
    participantsSettings: [],
    lastSeq: 0,
  };
  const conversationModel = {
    findById: jest.fn(() => chain(conv)),
    find: jest.fn(() => chain([{ _id: 'c1' }])),
    findByIdAndUpdate: jest.fn((_id: string, upd: { $inc?: unknown }) =>
      Promise.resolve(
        upd.$inc
          ? { ...conv, lastSeq: 7 }
          : { ...conv, participants: conv.participants },
      ),
    ),
  };
  const store: Record<string, Record<string, unknown>> = {};
  const messageModel = {
    findById: jest.fn((id: string) => chain(store[id] ?? null)),
    findOne: jest.fn(() => chain(null)),
    find: jest.fn(() => chain([])),
    create: jest.fn((doc: Record<string, unknown>) =>
      Promise.resolve({ _id: 'm-new', ...doc }),
    ),
    updateOne: jest.fn(() => Promise.resolve({})),
    findOneAndUpdate: jest.fn(() => Promise.resolve({ ok: true })),
  };
  const cloudinary = {
    destroyChatAttachment: jest.fn(() => Promise.resolve(true)),
  };
  const svc = new ChatService(
    conversationModel as never,
    messageModel as never,
    {} as never,
    { server } as never,
    cloudinary as never,
  );
  return {
    svc,
    emitted,
    conversationModel,
    messageModel,
    cloudinary,
    store,
    conv,
  };
}

const msg = (over: Record<string, unknown> = {}) => ({
  _id: 'm1',
  conversationId: 'c1',
  senderId: 'a',
  type: MessageType.TEXT,
  text: 'xin chào',
  attachments: [],
  createdAt: new Date(),
  recalledAt: null,
  ...over,
});

describe('ChatService — sửa / xoá / thu hồi / tìm kiếm', () => {
  it('sửa: người khác bị từ chối; tin trống bị từ chối', async () => {
    const { svc, store } = setup();
    store.m1 = msg();
    await expect(svc.editMessage('b', 'm1', 'x')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.editMessage('a', 'm1', '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.editMessage('a', 'm1', 'xin chào')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sửa: người ngoài hội thoại bị từ chối (IDOR)', async () => {
    const { svc, store } = setup();
    store.m1 = msg({ senderId: 'z' });
    await expect(svc.editMessage('z', 'm1', 'hack')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('sửa thành công: cập nhật chỉ mục tìm kiếm không dấu, ghi lịch sử, phát realtime', async () => {
    const { svc, store, messageModel, emitted } = setup();
    store.m1 = msg();
    const r = await svc.editMessage('a', 'm1', 'Nguyễn Văn A');
    expect(r.text).toBe('Nguyễn Văn A');
    const call = (
      messageModel.findOneAndUpdate.mock.calls as unknown as [
        unknown,
        Record<string, Record<string, unknown>>,
      ][]
    )[0];
    expect(call[1].$set.searchText).toBe('nguyen van a');
    expect(call[1].$push.edits).toMatchObject({ oldText: 'xin chào' });
    expect(
      emitted.some((e) => e.room === 'c1' && e.event === 'messageEdited'),
    ).toBe(true);
  });

  it('sửa lúc tin vừa bị thu hồi (tranh chấp): báo lỗi', async () => {
    const { svc, store, messageModel } = setup();
    store.m1 = msg();
    messageModel.findOneAndUpdate.mockResolvedValueOnce(null as never);
    await expect(svc.editMessage('a', 'm1', 'mới')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('xoá ở phía tôi: chỉ ghi deletedFor của tôi và báo các thiết bị của chính tôi', async () => {
    const { svc, store, messageModel, emitted } = setup();
    store.m1 = msg({ senderId: 'b' });
    await svc.deleteForMe('a', 'm1');
    expect(messageModel.updateOne).toHaveBeenCalledWith(
      { _id: 'm1' },
      { $addToSet: { deletedFor: 'a' } },
    );
    expect(emitted).toEqual([
      {
        room: 'a',
        event: 'messageDeletedForMe',
        payload: { messageId: 'm1', conversationId: 'c1' },
      },
    ]);
  });

  it('thu hồi: chỉ người gửi; xoá thật nội dung, chỉ mục & tệp; phát realtime không kèm nội dung', async () => {
    const { svc, store, messageModel, emitted, cloudinary } = setup();
    store.m1 = msg({
      attachments: [
        {
          url: 'https://res.cloudinary.com/x/image/upload/v1/chat-zone/messages/a.png',
          name: 'a.png',
          type: 'image/png',
          size: 1,
        },
      ],
    });
    await expect(svc.recallMessage('b', 'm1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await svc.recallMessage('a', 'm1');
    const set = (
      messageModel.updateOne.mock.calls as unknown as [
        unknown,
        { $set: Record<string, unknown> },
      ][]
    )[0][1].$set;
    expect(set).toMatchObject({
      text: '',
      searchText: null,
      attachments: [],
      edits: [],
      recalledBy: 'a',
    });
    await new Promise((r) => setImmediate(r));
    expect(cloudinary.destroyChatAttachment).toHaveBeenCalledTimes(1);
    const ev = emitted.find((e) => e.event === 'messageRecalled');
    expect(ev?.payload).toMatchObject({ messageId: 'm1', recalledBy: 'a' });
    expect(JSON.stringify(ev?.payload)).not.toContain('xin chào');
  });

  it('thu hồi lần hai bị từ chối', async () => {
    const { svc, store } = setup();
    store.m1 = msg({ recalledAt: new Date() });
    await expect(svc.recallMessage('a', 'm1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('gửi lặp cùng clientId trả về tin đã có, không tạo mới', async () => {
    const { svc, messageModel } = setup();
    messageModel.findOne.mockReturnValueOnce(
      chain(msg({ _id: 'old', clientId: 'k1' })) as never,
    );
    const r = await svc.sendMessage({
      senderId: 'a',
      conversationId: 'c1',
      text: 'hi',
      clientId: 'k1',
    });
    expect((r as { _id: unknown })._id).toBe('old');
    expect(messageModel.create).not.toHaveBeenCalled();
  });

  it('gửi: cấp seq theo hội thoại, lưu searchText chuẩn hoá, người ngoài bị từ chối', async () => {
    const { svc, messageModel } = setup();
    await svc.sendMessage({
      senderId: 'a',
      conversationId: 'c1',
      text: 'Đặng Văn',
      clientId: 'k2',
    });
    const doc = (
      messageModel.create.mock.calls as unknown as [Record<string, unknown>][]
    )[0][0];
    expect(doc).toMatchObject({
      seq: 7,
      searchText: 'dang van',
      clientId: 'k2',
    });
    await expect(
      svc.sendMessage({
        senderId: 'z',
        conversationId: 'c1',
        text: 'xâm nhập',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('đọc tin: người ngoài hội thoại bị từ chối; lọc tin tôi đã xoá ở phía mình', async () => {
    const { svc, messageModel } = setup();
    await expect(
      svc.getMessages('c1', 20, undefined, 'z'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await svc.getMessages('c1', 20, undefined, 'a');
    const q = (
      messageModel.find.mock.calls as unknown as [Record<string, unknown>][]
    )[0][0];
    expect(q).toMatchObject({ conversationId: 'c1', deletedFor: { $ne: 'a' } });
  });

  it('tìm kiếm: chuẩn hoá không dấu, chỉ hội thoại của tôi, loại tin thu hồi / đã xoá phía tôi', async () => {
    const { svc, messageModel } = setup();
    await svc.searchMessages('a', { q: 'Nguyễn' });
    const q = (
      messageModel.find.mock.calls as unknown as [Record<string, unknown>][]
    )[0][0];
    expect(q).toMatchObject({
      conversationId: { $in: ['c1'] },
      recalledAt: null,
      deletedFor: { $ne: 'a' },
      searchText: { $regex: 'nguyen' },
    });
    // tìm trong hội thoại không thuộc về tôi -> từ chối
    await expect(
      svc.searchMessages('z', { q: 'x', conversationId: 'c1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // ký tự đặc biệt regex được escape
    await svc.searchMessages('a', { q: 'a.b*' });
    const q2 = (
      messageModel.find.mock.calls as unknown as [Record<string, unknown>][]
    )[1][0];
    expect((q2.searchText as { $regex: string }).$regex).toBe('a\\.b\\*');
  });

  it('id người dùng dạng ObjectId (req.user._id) vẫn được nhận là người gửi', async () => {
    const { svc, store } = setup();
    const oid = { toString: () => 'a' } as unknown as string; // giống ObjectId của Mongoose
    store.m1 = msg();
    await expect(svc.recallMessage(oid, 'm1')).resolves.toMatchObject({
      recalledBy: 'a',
    });
    store.m2 = msg({ _id: 'm2' });
    await expect(svc.editMessage(oid, 'm2', 'mới')).resolves.toMatchObject({
      text: 'mới',
    });
    store.m3 = msg({ _id: 'm3', senderId: 'b' });
    await expect(svc.deleteForMe(oid, 'm3')).resolves.toMatchObject({
      scope: 'me',
    });
  });

  it('gửi tin trả lời: trả kèm bản xem trước của tin gốc', async () => {
    const { svc, store, messageModel } = setup();
    store.m1 = msg({ text: 'tin gốc' });
    // tin vừa tạo (đọc lại) + tin gốc (cho bản xem trước)
    messageModel.findById.mockImplementation(((id: string) =>
      chain(
        id === 'm-new'
          ? {
              _id: 'm-new',
              conversationId: 'c1',
              senderId: 'b',
              text: 'trả lời',
              type: 'TEXT',
              attachments: [],
              replyTo: 'm1',
            }
          : (store[id] ?? null),
      )) as never);
    messageModel.find.mockReturnValueOnce(chain([store.m1]) as never);
    const r = (await svc.sendMessage({
      senderId: 'b',
      conversationId: 'c1',
      text: 'trả lời',
      replyTo: 'm1',
    })) as { replyPreview: { text: string; unavailable: boolean } };
    expect(r.replyPreview).toMatchObject({
      text: 'tin gốc',
      unavailable: false,
    });
  });

  it('ảnh đã chia sẻ: người ngoài bị từ chối; lấy theo trang, mới nhất trước', async () => {
    const { svc, messageModel } = setup();
    await expect(
      svc.getMedia('z', 'c1', { kind: 'image', offset: 0, limit: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const rows = Array.from({ length: 6 }, (_, i) => ({
      _id: `m${i}`,
      senderId: 'a',
      createdAt: new Date(),
      idx: 0,
      attachments: { url: `u${i}`, name: `n${i}`, type: 'image/png', size: 1 },
    }));
    (messageModel as unknown as { aggregate: jest.Mock }).aggregate = jest.fn(
      () => ({ exec: () => Promise.resolve(rows) }),
    );
    const r = await svc.getMedia('a', 'c1', {
      kind: 'image',
      offset: 0,
      limit: 5,
    });
    expect(r.items).toHaveLength(5);
    expect(r).toMatchObject({ hasMore: true, nextOffset: 5 });
    expect(r.items[0]).toMatchObject({ url: 'u0', messageId: 'm0' });
  });
});
