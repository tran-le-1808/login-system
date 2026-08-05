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

  createdAt!: Date;

  updatedAt!: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);
