// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/pool/_lib (npm run pool:sync-shared)
/* eslint-disable */
import type { BallSpot } from '../physics/types';
import type { PocketPreset } from '../physics/config';

export type GameType = 'eight' | 'nine';
export type Group = 'solids' | 'stripes';
export type AiLevel = 'easy' | 'medium' | 'hard';
export type PlayerIndex = 0 | 1;
/** Bi trong tay: toàn bàn / chỉ sau head string (kitchen) */
export type BallInHand = null | 'table' | 'kitchen';

export interface PlayerSetup {
  name: string;
  ai: AiLevel | null;
}

export interface MatchConfig {
  type: GameType;
  players: [PlayerSetup, PlayerSetup];
  /** Thắng N ván */
  raceTo: number;
  /** Luân phiên phá hay người thắng ván phá */
  breakRule: 'alternate' | 'winner';
  /** 8 bi: tự gọi cú hiển nhiên */
  autoCall: boolean;
  seed: number;
  /** Độ khó lỗ (mặc định WPA Thi đấu; xếp hạng online khoá ở WPA) */
  pocketPreset?: PocketPreset;
  /** Cho phép đường dự đoán quỹ đạo đầy đủ (xếp hạng: tắt) */
  allowFullGuide?: boolean;
}

/** Gọi bi (8 bi): bi + lỗ */
export interface CallShot {
  ball: number;
  pocket: number;
}

export interface ShotDeclaration {
  call?: CallShot | null;
  /** 8 bi: đánh phòng thủ -> bi vào lỗ không được đánh tiếp */
  safety?: boolean;
  /** 9 bi: push out ngay sau cú phá */
  pushOut?: boolean;
}

/** Tình huống người chơi phải chọn theo luật */
export type PendingDecision =
  | { kind: 'illegalBreak'; by: PlayerIndex }
  | { kind: 'eightOnBreak'; by: PlayerIndex }
  | { kind: 'eightOnBreakScratch'; by: PlayerIndex }
  | { kind: 'pushOutResponse'; by: PlayerIndex };

export type DecisionChoice =
  | 'acceptTable'
  | 'rerackSelfBreak'
  | 'rerackOpponentBreak'
  | 'spotAndContinue'
  | 'rerack'
  | 'spotWithBallInHand'
  | 'shoot'
  | 'passBack';

export interface RackState {
  type: GameType;
  /** Bi đang trên bàn (n = 0 là bi cái; vắng bi cái = đang chờ đặt bi trong tay) */
  balls: BallSpot[];
  turn: PlayerIndex;
  breaker: PlayerIndex;
  isBreak: boolean;
  ballInHand: BallInHand;
  /** 8 bi sau scratch khi phá: chỉ được nhắm bi nằm trước head string */
  restrictToFrontOfHeadString: boolean;
  openTable: boolean;
  groups: [Group | null, Group | null];
  /** 9 bi: số lỗi liên tiếp */
  fouls: [number, number];
  pushOutAvailable: boolean;
  decision: PendingDecision | null;
  winner: PlayerIndex | null;
  winReason: string | null;
  shotNo: number;
  seed: number;
}

export type MessageTone = 'info' | 'good' | 'foul' | 'win' | 'warn';
export interface RuleMessage {
  tone: MessageTone;
  text: string;
}

export interface ShotVerdict {
  rack: RackState;
  messages: RuleMessage[];
  foul: string | null;
  /** Người đánh được tiếp tục */
  continues: boolean;
}
