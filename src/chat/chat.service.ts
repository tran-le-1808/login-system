import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
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
  ) {}

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
  }) {
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

    const messageType =
      data.type ||
      (data.attachments && data.attachments.length > 0
        ? data.text
          ? MessageType.MIXED
          : MessageType.FILE
        : MessageType.TEXT);

    const message = await this.messageModel.create({
      conversationId: conversation._id.toString(),
      senderId: data.senderId,
      text: data.text || '',
      type: messageType,
      attachments: data.attachments || [],
      replyTo: data.replyTo || null,
    });

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

    const populatedMessage = await this.messageModel.findById(message._id);

    this.chatGateway.server
      .to(conversation._id.toString())
      .emit('newMessage', populatedMessage);

    conversation.participants.forEach((userId) => {
      this.chatGateway.server.to(userId).emit('conversationUpdated', {
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

  async getMessages(conversationId: string, limit = 20, before?: string) {
    const query: FilterQuery<Message> = {
      conversationId,
    };

    if (before) {
      query.createdAt = {
        $lt: new Date(before),
      };
    }

    const messages = await this.messageModel
      .find(query)
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
      messages,
      hasMore,
      nextCursor: hasMore ? (messages[0]?.createdAt ?? null) : null,
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
