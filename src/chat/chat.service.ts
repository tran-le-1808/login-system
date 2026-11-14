import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { InjectModel } from '@nestjs/mongoose';

import { FilterQuery, Model } from 'mongoose';
import {
  Conversation,
  ConversationDocument,
} from './entities/conversation.entity';
import {
  Message,
  MessageDocument,
  MessageType,
} from './entities/message.entity';
import { User, UserDocument } from 'src/users/entities/user.entity';
import { ChatGateway } from './chat.gateway';
import { CloudinaryService } from 'src/common/cloudinary/cloudinary.service';
import { normalizeVi } from 'src/common/normalize-vi';
import {
  buildReplyPreview,
  canEditMessage,
  canRecallMessage,
  minutesFromEnv,
  type ReplyPreview,
} from './message-rules';

/** Nội dung tối đa của một tin nhắn */
const MAX_TEXT_LENGTH = 4000;

/** Tin nhắn trả cho client: bỏ trường nội bộ, thêm bản xem trước của tin được trả lời */
export type ClientMessage = Record<string, unknown> & {
  _id: unknown;
  replyPreview?: ReplyPreview | null;
};

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(Conversation.name)
    private conversationModel: Model<ConversationDocument>,

    @InjectModel(Message.name)
    private messageModel: Model<MessageDocument>,

    @InjectModel(User.name)
    private userModel: Model<UserDocument>,

    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,

    private readonly cloudinaryService: CloudinaryService,
  ) {}

  private readonly logger = new Logger(ChatService.name);

  /** Lấy hội thoại và bảo đảm `userId` là thành viên (chống IDOR) */
  private async requireMembership(conversationId: string, userId: string) {
    const conversation = await this.conversationModel
      .findById(conversationId)
      .catch(() => null);
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (!conversation.participants.map(String).includes(String(userId)))
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');
    return conversation;
  }

  /**
   * Chuyển tin nhắn sang dạng trả cho client: gắn bản xem trước của tin được trả lời
   * (tin gốc thu hồi / đã xoá ở phía người xem thì không lộ nội dung).
   */
  private async toClient(
    docs: (Message & { _id: unknown })[],
    viewerId?: string,
  ): Promise<ClientMessage[]> {
    const replyIds = [...new Set(docs.map((m) => m.replyTo).filter(Boolean))];
    const originals = replyIds.length
      ? await this.messageModel
          .find({ _id: { $in: replyIds } })
          .select('_id senderId text type attachments recalledAt deletedFor')
          .lean()
          .exec()
          .catch(() => [])
      : [];
    const byId = new Map(originals.map((o) => [String(o._id), o]));
    return docs.map((m) => {
      const plain = { ...m } as Record<string, unknown>;
      delete plain.searchText;
      delete plain.edits;
      const orig = m.replyTo ? byId.get(String(m.replyTo)) : undefined;
      return {
        ...plain,
        _id: m._id,
        replyPreview: orig
          ? buildReplyPreview(
              orig,
              !!viewerId && (orig.deletedFor ?? []).includes(viewerId),
            )
          : m.replyTo
            ? ({
                messageId: String(m.replyTo),
                senderId: '',
                text: '',
                type: 'TEXT',
                attachments: [],
                unavailable: true,
              } as ReplyPreview)
            : null,
      };
    });
  }

  private emitToConversation(
    conversationId: string,
    event: string,
    payload: unknown,
  ) {
    this.chatGateway.server?.to(conversationId).emit(event, payload);
  }

  async createConversation(
    senderId: string,

    receiverId: string,
  ) {
    let conversation = await this.conversationModel.findOne({
      isGroup: false,

      participants: {
        $all: [senderId, receiverId],
      },

      $expr: {
        $eq: [
          {
            $size: '$participants',
          },
          2,
        ],
      },
    });

    if (!conversation) {
      const receiver = await this.userModel.findById(receiverId);

      if (!receiver) {
        throw new BadRequestException('Receiver not found');
      }
      conversation = await this.conversationModel.create({
        participants: [senderId, receiverId],

        groupName: receiver?.name,

        groupAvatar: receiver?.avatar || '',

        isGroup: false,

        lastMessage: '',

        lastMessageAt: new Date(),

        participantsSettings: [senderId, receiverId].map((userId) => ({
          userId,
        })),
      });
    }

    return conversation;
  }

  async sendMessage(data: {
    senderId: string;

    receiverId?: string;

    conversationId?: string;

    text?: string;

    type?: MessageType;

    attachments?: {
      url: string;
      name: string;
      type: string;
      size: number;
    }[];

    replyTo?: string | null;

    /** Khoá chống gửi trùng (client sinh) */
    clientId?: string;
  }) {
    data = { ...data, senderId: String(data.senderId) };
    if ((data.text ?? '').length > MAX_TEXT_LENGTH) {
      throw new BadRequestException(`Tin nhắn tối đa ${MAX_TEXT_LENGTH} ký tự`);
    }

    // Gửi lặp (mất mạng / bấm lại / tự thử lại): trả về tin đã có, không tạo mới
    if (data.clientId) {
      const existing = await this.messageModel
        .findOne({ senderId: data.senderId, clientId: data.clientId })
        .lean()
        .exec();
      if (existing) return (await this.toClient([existing], data.senderId))[0];
    }

    if (
      !data.text?.trim() &&
      (!data.attachments || data.attachments.length === 0)
    ) {
      throw new BadRequestException('Message content is required');
    }

    let conversation: ConversationDocument | null = null;

    if (data.conversationId) {
      conversation = await this.conversationModel.findById(data.conversationId);

      if (!conversation) {
        throw new BadRequestException('Conversation not found');
      }
    } else {
      if (!data.receiverId) {
        throw new BadRequestException('ReceiverId is required');
      }

      conversation = await this.createConversation(
        data.senderId,
        data.receiverId,
      );
    }

    if (
      !conversation.participants.map(String).includes(String(data.senderId))
    ) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');
    }

    // Trả lời: tin gốc phải thuộc cùng hội thoại và chưa bị thu hồi
    let replyTo: string | null = null;
    if (data.replyTo) {
      const original = await this.messageModel
        .findById(data.replyTo)
        .select('conversationId recalledAt')
        .lean()
        .catch(() => null);
      if (
        !original ||
        original.conversationId !== conversation._id.toString() ||
        original.recalledAt
      ) {
        throw new BadRequestException('Không thể trả lời tin nhắn này');
      }
      replyTo = String(data.replyTo);
    }

    // Cấp seq theo hội thoại (nguyên tử, không trùng / hụt dưới tải đồng thời)
    const bumped = await this.conversationModel.findByIdAndUpdate(
      conversation._id,
      { $inc: { lastSeq: 1 } },
      { new: true },
    );
    const seq = bumped?.lastSeq ?? null;

    const messageType =
      data.type ||
      (data.attachments && data.attachments.length > 0
        ? data.text
          ? MessageType.MIXED
          : MessageType.FILE
        : MessageType.TEXT);

    let message: MessageDocument;
    try {
      message = await this.messageModel.create({
        conversationId: conversation._id.toString(),
        senderId: data.senderId,
        text: data.text || '',
        searchText: normalizeVi(data.text || ''),
        type: messageType,
        attachments: data.attachments || [],
        replyTo,
        seq,
        ...(data.clientId ? { clientId: data.clientId } : {}),
      });
    } catch (err) {
      // Hai yêu cầu cùng clientId chạy đồng thời: bên thua trả về tin của bên thắng
      if ((err as { code?: number }).code === 11000 && data.clientId) {
        const existing = await this.messageModel
          .findOne({ senderId: data.senderId, clientId: data.clientId })
          .lean()
          .exec();
        if (existing)
          return (await this.toClient([existing], data.senderId))[0];
      }
      throw err;
    }

    const senderId = data.senderId.toString();

    const participantsSettings = conversation.participantsSettings || [];

    const updatedParticipantsSettings = conversation.participants.map(
      (userId) => {
        const userIdString = userId.toString();

        const existingSetting = participantsSettings.find(
          (setting) => setting.userId.toString() === userIdString,
        );

        return {
          userId: userIdString,
          pinned: existingSetting?.pinned ?? false,
          muted: existingSetting?.muted ?? false,
          hidden: existingSetting?.hidden ?? false,
          blocked: existingSetting?.blocked ?? false,
          deleted: existingSetting?.deleted ?? false,
          lastSeenAt: existingSetting?.lastSeenAt ?? null,

          // Sender = 0
          // Others = current unreadCount + 1
          unreadCount:
            userIdString === senderId
              ? 0
              : (existingSetting?.unreadCount ?? 0) + 1,
        };
      },
    );

    await this.conversationModel.findByIdAndUpdate(
      conversation._id,
      {
        $set: {
          lastMessage:
            data.text || (data.attachments?.length ? '📎 Attachment' : ''),
          lastMessageAt: new Date(),
          participantsSettings: updatedParticipantsSettings,
        },
      },
      {
        new: true,
      },
    );

    const saved = await this.messageModel.findById(message._id).lean().exec();
    const [populatedMessage] = saved ? await this.toClient([saved]) : [null];

    this.emitToConversation(
      conversation._id.toString(),
      'newMessage',
      populatedMessage,
    );

    conversation.participants.forEach((userId) => {
      this.chatGateway.server?.to(userId).emit('conversationUpdated', {
        conversationId: conversation._id.toString(),
      });
    });

    return populatedMessage;
  }

  async getConversations(data: {
    userId: string;
    page: number;
    limit: number;
    search?: string;
  }) {
    const skip = (data.page - 1) * data.limit;

    const query: Record<string, unknown> = {
      participants: {
        $eq: data.userId,
        $ne: 'AI_ASSISTANT',
      },
    };

    if (data.search) {
      query.groupName = {
        $regex: data.search,
        $options: 'i',
      };
    }

    const conversations = await this.conversationModel
      .find(query)
      .sort({
        lastMessageAt: -1,
      })
      .skip(skip)
      .limit(data.limit);

    const userIds = conversations.flatMap(
      (conversation) => conversation.participants,
    );

    const users = await this.userModel
      .find({
        _id: { $in: userIds },
      })
      .select('_id name email avatar');

    const usersMap = new Map(users.map((user) => [user._id.toString(), user]));

    const total = await this.conversationModel.countDocuments(query);

    return {
      conversations: conversations.map((conversation) => ({
        ...conversation.toObject(),

        participants: conversation.participants.map((participantId) =>
          usersMap.get(participantId),
        ),
      })),
      total,
      hasMore: skip + conversations.length < total,
    };
  }

  /**
   * Danh sách tin của một hội thoại (người xem phải là thành viên).
   *  - `before`: trang tin cũ hơn (cursor = createdAt)
   *  - `around`: cửa sổ quanh một tin (nhảy tới kết quả tìm kiếm / tin được trả lời)
   * Ẩn các tin tôi đã "xoá ở phía bạn".
   */
  async getMessages(
    conversationId: string,
    limit = 20,
    before?: string,
    viewerId?: string,
    around?: string,
  ) {
    if (viewerId) {
      viewerId = String(viewerId);
      await this.requireMembership(conversationId, viewerId);
    }
    limit = Math.min(Math.max(1, limit), 100);

    const base: FilterQuery<Message> = { conversationId };
    if (viewerId) base.deletedFor = { $ne: viewerId };
    const projection = '-searchText';

    if (around) {
      const target = await this.messageModel
        .findOne({ ...base, _id: around })
        .lean()
        .exec()
        .catch(() => null);
      if (!target) throw new NotFoundException('Không tìm thấy tin nhắn');
      const half = Math.max(5, Math.floor(limit / 2));
      const older = await this.messageModel
        .find({ ...base, createdAt: { $lt: target.createdAt } })
        .select(projection)
        .sort({ createdAt: -1 })
        .limit(half + 1)
        .lean()
        .exec();
      const newer = await this.messageModel
        .find({ ...base, createdAt: { $gt: target.createdAt } })
        .select(projection)
        .sort({ createdAt: 1 })
        .limit(half + 1)
        .lean()
        .exec();
      const hasMore = older.length > half;
      const hasNewer = newer.length > half;
      if (hasMore) older.pop();
      if (hasNewer) newer.pop();
      const window = [...older.reverse(), target, ...newer];
      return {
        messages: await this.toClient(window, viewerId),
        hasMore,
        hasNewer,
        nextCursor: hasMore ? (window[0]?.createdAt ?? null) : null,
      };
    }

    const query: FilterQuery<Message> = { ...base };
    if (before) {
      query.createdAt = {
        $lt: new Date(before),
      };
    }

    const messages = await this.messageModel
      .find(query)
      .select(projection)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean()
      .exec();

    const hasMore = messages.length > limit;

    if (hasMore) {
      messages.pop();
    }

    messages.reverse();

    return {
      messages: await this.toClient(messages, viewerId),
      hasMore,
      hasNewer: false,
      nextCursor: hasMore ? (messages[0]?.createdAt ?? null) : null,
    };
  }

  // -------------------------------------------------------------------------
  // SỬA / XOÁ Ở PHÍA TÔI / THU HỒI
  // -------------------------------------------------------------------------

  /** Chỉnh sửa nội dung tin (xem quy tắc ở message-rules.ts) */
  async editMessage(userId: string, messageId: string, newText: string) {
    userId = String(userId);
    const text = (newText ?? '').trim();
    if (!text) throw new BadRequestException('Nội dung không được để trống');
    if (text.length > MAX_TEXT_LENGTH)
      throw new BadRequestException(`Tin nhắn tối đa ${MAX_TEXT_LENGTH} ký tự`);

    const message = await this.messageModel
      .findById(messageId)
      .catch(() => null);
    if (!message) throw new NotFoundException('Không tìm thấy tin nhắn');
    await this.requireMembership(message.conversationId, userId);

    const verdict = canEditMessage(
      message,
      userId,
      new Date(),
      minutesFromEnv('EDIT_WINDOW_MINUTES', 15),
    );
    if (!verdict.ok) {
      throw verdict.code === 'NOT_OWNER'
        ? new ForbiddenException(verdict.message)
        : new BadRequestException(verdict.message);
    }
    if (text === message.text)
      throw new BadRequestException('Nội dung không thay đổi');

    const editedAt = new Date();
    // Điều kiện recalledAt:null chặn tranh chấp "thu hồi trong lúc đang sửa"
    const updated = await this.messageModel.findOneAndUpdate(
      { _id: messageId, recalledAt: null },
      {
        $set: { text, searchText: normalizeVi(text), editedAt },
        $push: { edits: { oldText: message.text, editedAt } },
      },
      { new: true },
    );
    if (!updated) throw new BadRequestException('Tin nhắn đã bị thu hồi');

    const payload = {
      messageId,
      conversationId: message.conversationId,
      text,
      editedAt,
    };
    this.emitToConversation(message.conversationId, 'messageEdited', payload);
    await this.refreshLastMessage(message.conversationId, messageId, text);
    return payload;
  }

  /** "Xoá ở phía bạn": chỉ ẩn khỏi tài khoản này (mọi thiết bị của tôi) */
  async deleteForMe(userId: string, messageId: string) {
    userId = String(userId);
    const message = await this.messageModel
      .findById(messageId)
      .select('conversationId')
      .lean()
      .catch(() => null);
    if (!message) throw new NotFoundException('Không tìm thấy tin nhắn');
    await this.requireMembership(message.conversationId, userId);

    await this.messageModel.updateOne(
      { _id: messageId },
      { $addToSet: { deletedFor: userId } },
    );
    // Báo cho các thiết bị khác của chính tôi (mỗi người có phòng riêng theo userId)
    this.chatGateway.server?.to(userId).emit('messageDeletedForMe', {
      messageId,
      conversationId: message.conversationId,
    });
    return { messageId, conversationId: message.conversationId, scope: 'me' };
  }

  /**
   * Thu hồi với mọi người: XOÁ THẬT nội dung, chỉ mục tìm kiếm, lịch sử sửa và tệp đính kèm
   * (kho lưu trữ xoá nền, có log). Giữ lại id/seq/senderId/createdAt để không lệch thứ tự.
   */
  async recallMessage(userId: string, messageId: string) {
    userId = String(userId);
    const message = await this.messageModel
      .findById(messageId)
      .catch(() => null);
    if (!message) throw new NotFoundException('Không tìm thấy tin nhắn');
    await this.requireMembership(message.conversationId, userId);

    const verdict = canRecallMessage(
      message,
      userId,
      new Date(),
      minutesFromEnv('RECALL_WINDOW_MINUTES', 0),
    );
    if (!verdict.ok) {
      throw verdict.code === 'NOT_OWNER'
        ? new ForbiddenException(verdict.message)
        : new BadRequestException(verdict.message);
    }

    const urls = (message.attachments ?? []).map((a) => a.url);
    const recalledAt = new Date();
    await this.messageModel.updateOne(
      { _id: messageId },
      {
        $set: {
          text: '',
          searchText: null,
          attachments: [],
          edits: [],
          recalledAt,
          recalledBy: userId,
        },
      },
    );

    // Xoá tệp khỏi kho lưu trữ ở nền (URL đã ký cũ không còn tải được)
    if (urls.length) {
      void Promise.all(
        urls.map((u) => this.cloudinaryService.destroyChatAttachment(u)),
      ).then((r) => {
        if (r.some((ok) => !ok))
          this.logger.warn(
            `Thu hồi ${messageId}: một số tệp không xoá được khỏi kho lưu trữ`,
          );
      });
    }

    const payload = {
      messageId,
      conversationId: message.conversationId,
      recalledAt,
      recalledBy: userId,
    };
    this.emitToConversation(message.conversationId, 'messageRecalled', payload);
    await this.refreshLastMessage(
      message.conversationId,
      messageId,
      'Tin nhắn đã bị thu hồi',
    );
    return payload;
  }

  /** Cập nhật xem trước ở danh sách hội thoại nếu tin vừa sửa / thu hồi là tin cuối */
  private async refreshLastMessage(
    conversationId: string,
    messageId: string,
    preview: string,
  ) {
    const last = await this.messageModel
      .findOne({ conversationId })
      .sort({ createdAt: -1 })
      .select('_id')
      .lean()
      .exec();
    if (!last || String(last._id) !== String(messageId)) return;
    const conversation = await this.conversationModel.findByIdAndUpdate(
      conversationId,
      { $set: { lastMessage: preview } },
      { new: true },
    );
    conversation?.participants.forEach((uid) => {
      this.chatGateway.server?.to(uid).emit('conversationUpdated', {
        conversationId,
      });
    });
  }

  // -------------------------------------------------------------------------
  // ẢNH / TỆP ĐÃ CHIA SẺ
  // -------------------------------------------------------------------------

  /**
   * Ảnh (hoặc tệp) đã chia sẻ trong hội thoại, mới nhất trước — lấy thẳng từ CSDL,
   * không phụ thuộc các tin đã tải ở client. Bỏ tin đã thu hồi / tôi đã xoá ở phía mình.
   */
  async getMedia(
    userId: string,
    conversationId: string,
    opts: { kind: 'image' | 'file'; offset: number; limit: number },
  ) {
    userId = String(userId);
    await this.requireMembership(conversationId, userId);
    const limit = Math.min(Math.max(1, opts.limit), 50);
    const offset = Math.max(0, opts.offset || 0);
    const typeMatch =
      opts.kind === 'image'
        ? { 'attachments.type': { $regex: '^image/' } }
        : { 'attachments.type': { $not: { $regex: '^(image|video)/' } } };

    const rows = await this.messageModel
      .aggregate<{
        _id: unknown;
        senderId: string;
        createdAt: Date;
        attachments: { url: string; name: string; type: string; size: number };
        idx: number;
      }>([
        {
          $match: {
            conversationId,
            recalledAt: null,
            deletedFor: { $ne: userId },
            'attachments.0': { $exists: true },
          },
        },
        { $unwind: { path: '$attachments', includeArrayIndex: 'idx' } },
        { $match: typeMatch },
        { $sort: { createdAt: -1, _id: -1, idx: 1 } },
        { $skip: offset },
        { $limit: limit + 1 },
        { $project: { senderId: 1, createdAt: 1, attachments: 1, idx: 1 } },
      ])
      .exec();
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      items: rows.map((r) => ({
        messageId: String(r._id),
        senderId: r.senderId,
        createdAt: r.createdAt,
        ...r.attachments,
      })),
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    };
  }

  // -------------------------------------------------------------------------
  // TÌM KIẾM
  // -------------------------------------------------------------------------

  /**
   * Tìm tin nhắn không phân biệt dấu tiếng Việt, chỉ trong các hội thoại tôi tham gia.
   * Loại: tin đã thu hồi, tin tôi đã xoá ở phía mình. Không ghi từ khoá vào log.
   */
  async searchMessages(
    userId: string,
    params: {
      q: string;
      conversationId?: string;
      senderId?: string;
      type?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    userId = String(userId);
    const needle = normalizeVi(params.q ?? '');
    if (!needle) return { items: [], hasMore: false, nextCursor: null };
    const limit = Math.min(Math.max(1, params.limit ?? 20), 50);

    let conversationIds: string[];
    if (params.conversationId) {
      await this.requireMembership(params.conversationId, userId);
      conversationIds = [params.conversationId];
    } else {
      const mine = await this.conversationModel
        .find({ participants: userId })
        .select('_id')
        .lean()
        .exec();
      conversationIds = mine.map((c) => String(c._id));
    }
    if (!conversationIds.length)
      return { items: [], hasMore: false, nextCursor: null };

    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const createdAt: Record<string, Date> = {};
    if (params.cursor) createdAt.$lt = new Date(params.cursor);
    if (params.from) createdAt.$gte = new Date(params.from);
    if (params.to) createdAt.$lte = new Date(params.to);

    const query: FilterQuery<Message> = {
      conversationId: { $in: conversationIds },
      recalledAt: null,
      deletedFor: { $ne: userId },
      searchText: { $regex: escaped },
    };
    if (Object.keys(createdAt).length) query.createdAt = createdAt;
    if (params.senderId) query.senderId = params.senderId;
    if (params.type) query.type = params.type;

    const rows = await this.messageModel
      .find(query)
      .select('_id conversationId senderId text type createdAt seq')
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean()
      .exec();
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      items: rows.map((m) => ({
        messageId: String(m._id),
        conversationId: m.conversationId,
        senderId: m.senderId,
        text: m.text,
        type: m.type,
        createdAt: m.createdAt,
      })),
      hasMore,
      nextCursor: hasMore ? (rows[rows.length - 1]?.createdAt ?? null) : null,
    };
  }

  async createGroup(data: {
    adminId: string;

    groupName: string;

    participants: string[];

    groupAvatar?: string;
  }) {
    const conversation = await this.conversationModel.create({
      participants: [data.adminId, ...data.participants],

      isGroup: true,

      groupName: data.groupName,

      groupAvatar: data.groupAvatar || '',

      adminId: data.adminId,

      participantsSettings: [data.adminId, ...data.participants].map(
        (userId) => ({
          userId,
        }),
      ),
    });

    return conversation;
  }
}
