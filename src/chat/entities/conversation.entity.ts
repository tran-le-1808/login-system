import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

export type ConversationDocument = HydratedDocument<Conversation>;

@Schema({
  _id: false,
})
export class ParticipantSetting {
  @Prop({
    type: String,
    required: true,
  })
  userId!: string;

  @Prop({
    type: Boolean,
    default: false,
  })
  pinned!: boolean;

  @Prop({
    type: Boolean,
    default: false,
  })
  muted!: boolean;

  @Prop({
    type: Boolean,
    default: false,
  })
  hidden!: boolean;

  @Prop({
    type: Boolean,
    default: false,
  })
  blocked!: boolean;

  @Prop({
    type: Boolean,
    default: false,
  })
  deleted!: boolean;

  @Prop({
    type: Date,
    default: null,
  })
  lastSeenAt!: Date | null;

  @Prop({
    type: Number,
    default: 0,
  })
  unreadCount!: number;
}

export const ParticipantSettingSchema =
  SchemaFactory.createForClass(ParticipantSetting);

@Schema({
  timestamps: true,
})
export class Conversation {
  // USERS
  @Prop({
    type: [String],
    required: true,
  })
  participants!: string[];

  // GROUP CHAT
  @Prop({
    type: Boolean,
    default: false,
  })
  isGroup!: boolean;

  @Prop({
    type: String,
    default: '',
  })
  groupName!: string;

  @Prop({
    type: String,
    default: '',
  })
  groupAvatar!: string;

  @Prop({
    type: String,
    default: '',
  })
  groupDescription!: string;

  @Prop({
    type: String,
    default: '',
  })
  adminId!: string;

  @Prop({
    type: [String],
    default: [],
  })
  moderators!: string[];

  // LAST MESSAGE
  @Prop({
    type: String,
    default: '',
  })
  lastMessage!: string;

  @Prop({
    type: Date,
    default: null,
  })
  lastMessageAt!: Date | null;

  // USER SETTINGS
  @Prop({
    type: [ParticipantSettingSchema],

    default: [],
  })
  participantsSettings!: ParticipantSetting[];

  // GROUP SETTINGS
  @Prop({
    type: Boolean,
    default: true,
  })
  allowSendMessage!: boolean;

  @Prop({
    type: Boolean,
    default: true,
  })
  allowSendMedia!: boolean;

  @Prop({
    type: Boolean,
    default: true,
  })
  allowMemberInvite!: boolean;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);
