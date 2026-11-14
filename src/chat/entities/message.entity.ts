import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

export type MessageDocument = HydratedDocument<Message>;

export enum MessageType {
  TEXT = 'TEXT',

  IMAGE = 'IMAGE',

  FILE = 'FILE',

  VIDEO = 'VIDEO',

  MIXED = 'MIXED',
}

@Schema({
  _id: false,
})
export class Attachment {
  @Prop({
    type: String,
    required: true,
  })
  url!: string;

  @Prop({
    type: String,
    required: true,
  })
  name!: string;

  @Prop({
    type: String,
    required: true,
  })
  type!: string;

  @Prop({
    type: Number,
    required: true,
  })
  size!: number;
}

export const AttachmentSchema = SchemaFactory.createForClass(Attachment);

@Schema({
  timestamps: true,
})
export class Message {
  @Prop({
    type: String,
    required: true,
  })
  conversationId!: string;

  @Prop({
    type: String,
    required: true,
  })
  senderId!: string;

  @Prop({
    type: String,
    default: '',
  })
  text!: string;

  @Prop({
    type: String,
    enum: MessageType,
    default: MessageType.TEXT,
  })
  type!: MessageType;

  @Prop({
    type: [AttachmentSchema],
    default: [],
  })
  attachments!: Attachment[];

  @Prop({
    type: Boolean,
    default: false,
  })
  seen!: boolean;

  @Prop({
    type: Boolean,
    default: false,
  })
  deleted!: boolean;

  @Prop({
    type: String,
    default: null,
  })
  replyTo!: string | null;

  /** Số thứ tự tăng dần theo TỪNG hội thoại (cấp trong cùng thao tác cập nhật lastSeq) */
  @Prop({ type: Number, default: null })
  seq!: number | null;

  /** Khoá do client sinh: gửi lặp cùng clientId không tạo tin trùng */
  @Prop({ type: String, default: undefined })
  clientId?: string;

  @Prop({ type: Date, default: null })
  editedAt!: Date | null;

  /** Lịch sử sửa (chỉ lưu để kiểm tra, không trả cho người dùng) */
  @Prop({
    type: [{ oldText: String, editedAt: Date, _id: false }],
    default: [],
    select: false,
  })
  edits!: { oldText: string; editedAt: Date }[];

  /** Thu hồi với mọi người: nội dung & tệp đã bị xoá thật */
  @Prop({ type: Date, default: null })
  recalledAt!: Date | null;

  @Prop({ type: String, default: null })
  recalledBy!: string | null;

  /** "Xoá ở phía tôi": danh sách người dùng đã ẩn tin này khỏi tài khoản của họ */
  @Prop({ type: [String], default: [] })
  deletedFor!: string[];

  /** Nội dung đã chuẩn hoá (không dấu, chữ thường) để tìm kiếm; null khi thu hồi */
  @Prop({ type: String, default: null, select: false })
  searchText!: string | null;

  createdAt!: Date;

  updatedAt!: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

MessageSchema.index({ conversationId: 1, seq: -1 });
MessageSchema.index({ conversationId: 1, createdAt: -1 });
// Gửi lặp cùng clientId (mất mạng / bấm lại / tự thử lại) không tạo tin trùng
MessageSchema.index(
  { senderId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);
