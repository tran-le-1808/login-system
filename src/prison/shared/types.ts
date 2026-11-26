// ⚠️ BẢN SAO TỰ ĐỘNG — KHÔNG SỬA Ở ĐÂY. Nguồn: chat-zone/app/games/prison/_lib/engine (npm run prison:sync-shared)
/* eslint-disable */
/** Kiểu dữ liệu dùng chung client/server. WorldState là JSON thuần (để checkpoint / lưu ván). */
import type itemsJson from './data/items.json';

export type Difficulty = 'NORMAL' | 'HARD' | 'HARDCORE';
export type Role = 'HACKER' | 'FIGHTER' | 'MECHANIC' | 'SCOUT';
export type GameMode = 'single' | 'multi';

/** Trạng thái gameplay. Mất kết nối là cờ `connected` riêng. */
export type PlayerStatus = 'ACTIVE' | 'KNOCKED_OUT' | 'CAPTURED' | 'ESCAPED';
export type GuardAIState =
  | 'PATROL'
  | 'SUSPICIOUS'
  | 'INVESTIGATE'
  | 'CHASE'
  | 'SEARCH'
  | 'RETURN';
export type PrisonState = 'NORMAL' | 'LOCKDOWN';
export type EscapeStatus =
  | 'PREPARING'
  | 'READY_CHECK'
  | 'EXECUTING'
  | 'RESCUE_REQUIRED'
  | 'FAILED'
  | 'ALL_ESCAPED';
export type EscapePlayerStatus =
  | 'INSIDE'
  | 'ESCAPING'
  | 'ESCAPED'
  | 'CAPTURED'
  | 'KNOCKED_OUT';
/** 5 lối của bản đồ Đá Xám (data/escapes.json) */
export type EscapeMethod =
  | 'TUNNEL'
  | 'VENT'
  | 'GATE'
  | 'LAUNDRY'
  | 'FENCE'
  | 'WALL'
  | 'TRUCK';
/** id khung giờ trong data/routines.json */
export type SchedulePeriod = string;
export type ItemId = keyof typeof itemsJson;
/** Đổi khi cấu trúc WorldState đổi: bản lưu / checkpoint cũ sẽ bị bỏ qua */
export const WORLD_SCHEMA_VERSION = 12;
export type Outcome = 'ALL_ESCAPED' | 'TIME_UP';

export interface InventoryItem {
  itemId: ItemId;
  quantity: number;
  durability?: number;
  /** Chất lượng (vd. độ chân thực của hình nộm 0–100) */
  quality?: number;
  /** Mã in trên quần áo (mã tù nhân / mã cai ngục) */
  owner?: string;
  /** Tình trạng quần áo 0–100 (bẩn / rách làm dễ bị nhận ra) */
  condition?: number;
}

export type SlotType = 'bag' | 'weapon' | 'outfit';

/** Ô riêng: vũ khí, bộ đồ (không chiếm túi chính). Không mặc bộ đồ = chỉ còn đồ lót. */
export interface Gear {
  weapon: InventoryItem | null;
  outfit: InventoryItem | null;
}

export interface Point {
  x: number;
  y: number;
}

export type ChannelKind =
  | 'read'
  | 'breakIn'
  | 'openVent'
  | 'attachRope'
  | 'revive'
  | 'rescue'
  | 'craft'
  | 'hide'
  | 'flush'
  | 'dig'
  | 'support'
  | 'cover'
  | 'work'
  | 'sleep'
  | 'cameraPanel'
  | 'gym'
  | 'shower'
  | 'loot'
  | 'lootTake'
  | 'cutFence'
  | 'digWall'
  | 'digFloor'
  | 'digTunnel'
  | 'board'
  | 'blackout';

/** Thao tác giữ có thời gian — tiến trình do server tính */
export interface Channel {
  kind: ChannelKind;
  targetId: string;
  elapsed: number;
  /** Infinity không dùng được trong JSON -> sleep dùng 1e9 */
  duration: number;
  startX: number;
  startY: number;
  itemId?: ItemId;
  quantity?: number;
  recipeId?: string;
  /** Lục soát: ô và vị trí cần lấy */
  slot?: SlotType;
  index?: number;
}

/** Một món trong kho tịch thu */
export interface ConfiscatedEntry {
  id: string;
  playerId: string;
  item: InventoryItem;
  /** Ngày bị tịch thu */
  day: number;
}

export type GymKind = 'pressBench' | 'treadmill';

/** Một lượt tập trên máy: đếm nhịp trái–phải xen kẽ. Lần dở không cộng điểm. */
export interface GymSession {
  machineId: string;
  kind: GymKind;
  /** Nhịp hợp lệ trong lần (rep) đang tập */
  beats: number;
  /** Đã bấm nửa đầu của nhịp hiện tại */
  half: boolean;
  /** Bên vừa bấm: 0 = trái, 1 = phải, -1 = chưa bấm */
  lastSide: number;
  /** Thanh đà 0..1 */
  momentum: number;
  /** Số lần hoàn thành trong lượt tập này */
  reps: number;
}

/** Tù nhân khác muốn dùng máy người chơi đang tập */
export interface GymRequest {
  npcId: string;
  machineId: string;
  aggressive: boolean;
  until: number;
}

export interface PlayerStats {
  health: number;
  maxHealth: number;
  /** Thể lực 0–100: giảm khi vận động (gym, chạy, đào, trèo, chế tạo); hồi khi ngủ, tắm, ăn đồ bổ sung */
  energy: number;
  maxEnergy: number;
  /** 0 = no, 100 = đói lả */
  hunger: number;
  strength: number;
  /** Điểm thông minh 0–50: đọc kệ sách +1, mỗi 08:00 −2; quyết định bậc chế tạo */
  intelligence: number;
  stamina: number;
  agility: number;
  personalHeat: number;
}

export interface PlayerSkills {
  crafting: number;
  fitness: number;
  dexterity: number;
  social: number;
}

export interface PlayerState {
  id: string;
  name: string;
  role: Role;
  colorIndex: number;
  cellIndex: number;
  x: number;
  y: number;
  facing: number;
  status: PlayerStatus;
  connected: boolean;
  stats: PlayerStats;
  skills: PlayerSkills;
  reputation: { guards: number; inmates: number };
  money: number;
  level: number;
  experience: number;
  inventory: InventoryItem[];
  /** Lần đọc gần nhất mỗi kệ sách (phút game tuyệt đối) */
  shelfReads: Record<string, number>;
  /** Hết hạn chờ ăn lại từng món (thời gian mô phỏng) */
  foodCooldowns: Record<string, number>;
  /** Chơi một mình bị bắt: chờ "qua ngày mới" trong phòng biệt giam (xử lý cuối tick) */
  soloNightPending: boolean;
  /** Lần chế tạo gần nhất (thời gian mô phỏng) & có phải đồ cấm — cai ngục / camera thấy trong cửa sổ này là vi phạm */
  lastCraftAt: number;
  lastCraftContraband: boolean;
  /** Ô vũ khí / áo / quần (túi chính là `inventory`, tối đa 6 ô) */
  gear: Gear;
  /** Đang rút vũ khí ra tay (R) — cất đi thì đánh tay không, không bị coi là cầm vũ khí */
  weaponDrawn: boolean;
  /** Đang mở túi đồ của người bị ngất (id cai ngục / tù nhân) */
  lootTarget: string | null;
  /** Lần cai ngục (id) nhìn thoáng / hỏi gần nhất — chống kiểm tra liên tục (giây mô phỏng) */
  disguiseChecks: Record<string, number>;
  lastSeq: number;
  moving: boolean;
  sprinting: boolean;
  knockoutDeadline: number | null;
  /** Mốc hết biệt giam: đơn vị phút game (chơi đơn) hoặc giây mô phỏng (co-op) — xem solitaryClock */
  solitaryUntil: number | null;
  solitaryClock: 'game' | 'sim' | null;
  solitaryCell: number | null;
  invulnerableUntil: number;
  breakFreeReadyAt: number;
  assistReadyAt: number;
  channel: Channel | null;
  visitedZones: string[];
  escapeReady: boolean;
  /** Vi phạm trong ngày (để leo thang nhắc nhở -> phạt -> nghiêm trọng) */
  violationsToday: { day: number; count: number };
  /** Khoá chống ghi trùng một vi phạm theo khung giờ */
  violationKeys: string[];
  /** Mức truy nã 0–3 sao (0 = không bị truy nã) */
  wantedLevel: number;
  /** Lần cuối bị phát hiện khi đang / bị truy nã (phút game) */
  wantedSeenAt: number;
  /** Bắt đầu bị truy nã (phút game) — ở ngoài lâu thì tăng sao */
  wantedSince: number;
  /** Ngày đã tắm gần nhất */
  showeredDay: number;
  /** Ngày đã tập gym gần nhất */
  gymDay: number;
  /** Đang tập trên máy gym (null = không) */
  gym: GymSession | null;
  /** Máy gym đang xếp hàng chờ (hàng chờ 1 người) */
  gymQueued: string | null;
  /** Uy tín với từng nhóm tù nhân (groupId -> 0..100) */
  groupRep: Record<string, number>;
  attackReadyAt: number;
  /** Thời điểm mô phỏng của đòn đánh gần nhất (cai ngục thấy trong cửa sổ này là vi phạm) */
  lastAttackAt: number;
  /** Bị hạ gục trong một trận đánh (không phải do lính bắt): hết thời gian sẽ tự tỉnh, không bị bắt */
  knockoutRecover: boolean;
  timesCaught: number;
  /** Đang nằm trốn trong xe (id xe trong data/vehicles.json) — không đi được, cai ngục không thấy */
  vehicle: string | null;
  /** Đang nằm trên giường (id giường): ngủ, hoặc vừa tỉnh dậy ở phòng y tế */
  bed: string | null;
  /** Nằm yên trên giường tới khi tự đứng dậy (bấm di chuyển) — dùng khi tỉnh dậy ở phòng y tế */
  bedHold: boolean;
  /** Chơi một mình bị đánh ngất: cuối tick tua nhanh 30 phút rồi tỉnh dậy ở phòng y tế */
  soloKoPending: boolean;
  /** Có lý do y tế tới mốc này (phút game tuyệt đối): điểm danh không ghi vắng mặt */
  excusedUntil: number;
  /** Lần nằm xuống / dậy gần nhất (giây mô phỏng) — chống bấm lặp Ngủ/Dậy */
  bedToggleAt: number;
  /** Bộ đồ để trên giá khi đứng dưới vòi sen (tự mặc lại khi bước ra) */
  showerOutfit: InventoryItem | null;
  /** Lần cuối bị tù nhân tấn công trước (giây mô phỏng) — đánh trả trong cửa sổ này là phòng vệ chính đáng */
  attackedAt: number;
  /** Đang ở dưới hầm (tầng ẩn) */
  underground: boolean;
}

/** Dấu vết đào: lỗ tường, miệng hầm, ô hầm dưới đất, vật trang trí / che đặt trên ô ("x,y") */
export interface DigState {
  holes: Record<string, { by: string; day: number }>;
  entrances: Record<string, { by: string; day: number }>;
  tunnels: Record<string, string>;
  decor: Record<string, ItemId>;
}

export interface GuardTask {
  kind: 'roomSearch';
  cellIndex: number;
  stage: 'going' | 'searching';
  elapsed: number;
}

export interface GuardEntity {
  id: string;
  name: string;
  routeId: string;
  x: number;
  y: number;
  facing: number;
  state: GuardAIState;
  waypointIndex: number;
  path: Point[];
  targetPlayerId: string | null;
  lastKnown: Point | null;
  stateTime: number;
  suspicion: number;
  lostSightTime: number;
  stunnedUntil: number;
  repathAt: number;
  pauseUntil: number;
  task: GuardTask | null;
  health: number;
  maxHealth: number;
  /** > 0: đang nằm bất tỉnh tới mốc này (giây mô phỏng); 0 = bình thường */
  downUntil: number;
  code: string;
  gear: Gear;
  bag: InventoryItem[];
  /** Ngày bị đánh ngất gần nhất (mỗi ngày chỉ một lần) */
  koDay: number;
  koBy: string | null;
  /** Đã được tăng cường sau khi bị đánh ngất */
  reinforced: boolean;
  /** Đồng nghiệp đã phát hiện cai ngục này mất tích */
  missingReported: boolean;
  /** Thời gian đã ở trong tầm tóm — cần đủ catchSeconds mới khống chế được */
  catchTimer: number;
  /** Vị trí trong bảng ca trực (data/patrols.json) — đổi tuyến khi sang ca */
  shiftIndex: number;
  /** Cai ngục tháp canh: đứng yên, quét nhìn, báo động thay vì đuổi */
  tower: boolean;
  /** Đang can thiệp một tù nhân gây hấn (id tù nhân) */
  targetInmateId: string | null;
}

export type InmateState = 'IDLE' | 'WALK' | 'SLEEP' | 'DOWN';
export type InmateCombatState =
  | 'idle'
  | 'threatened'
  | 'fighting'
  | 'retreating'
  | 'knockedOut';

export interface InmateEntity {
  id: string;
  /** Máy gym đang dùng */
  gymMachine: string | null;
  /** Lượt (rep) kế tiếp của NPC trên máy */
  gymRepAt: number;
  /** Ngày đã tranh máy với người chơi (mỗi ngày tối đa 1 lần) */
  gymAskedDay: number;
  defId: string;
  x: number;
  y: number;
  facing: number;
  state: InmateState;
  path: Point[];
  waitUntil: number;
  goalZone: string | null;
  snitchTarget: string | null;
  snitchTimer: number;
  health: number;
  downUntil: number;
  gear: Gear;
  bag: InventoryItem[];
  /** Người đã lấy đồ của tù nhân khi họ ngất */
  robbedBy: string | null;
  combat: InmateCombatState;
  /** Đối thủ đang đánh / đang bị dọa (id người chơi) */
  fightWith: string | null;
  /** Lần chủ động gây hấn gần nhất (giây mô phỏng) — cai ngục thấy thì can thiệp tù nhân này */
  aggressorAt: number;
  /** Thời điểm sẽ phản ứng (0.3–0.8 giây sau khi bị đánh) */
  reactAt: number;
  retreatUntil: number;
  attackReadyAt: number;
  /** Người chơi mà tù nhân này đang thù (từng đánh họ / nhóm họ) */
  grudges: string[];
  /** Lần chủ động gây sự gần nhất */
  provokedAt: number;
}

/** Tủ / thùng / bàn: lưới ô thật — người chơi cất vào, lấy ra như rương */
export interface ContainerState {
  id: string;
  items: InventoryItem[];
}

export type BedItem = 'pillow' | 'blanket' | 'dummy';

/** Giường: có gối, chăn; có thể đặt Hình nộm lên để qua mặt kiểm tra đêm */
export interface BedState {
  pillow: boolean;
  blanket: boolean;
  dummy: boolean;
  /** Độ chân thực của hình nộm đang nằm trên giường (0–100) */
  realism: number;
  /** Thanh nghi ngờ phụ của hình nộm (0–100) — đầy thì bị lộ */
  meter: number;
}

export interface FloorItem {
  id: string;
  x: number;
  y: number;
  item: InventoryItem;
  /** Phút game lúc rơi (totalGameMinutes) — để tự biến mất sau worldItemDespawnDays */
  droppedAt?: number;
  /** Người chơi đã vứt / ném (nếu có) */
  droppedBy?: string;
}

export interface TeamStorage {
  items: InventoryItem[];
  maxSlots: number;
  authorizedPlayerIds: string[];
  version: number;
}

export interface TunnelState {
  progress: number;
  supports: number;
  covered: boolean;
}

export type JournalKind =
  | 'warning'
  | 'penalty'
  | 'violation'
  | 'event'
  | 'search'
  | 'capture'
  | 'escape'
  | 'tip'
  | 'craft';

export interface JournalEntry {
  id: string;
  /** totalGameMinutes lúc ghi */
  t: number;
  playerId?: string;
  kind: JournalKind;
  text: string;
}

export type QuestType = 'PERSONAL' | 'TEAM' | 'DYNAMIC';
export type QuestStatus =
  | 'AVAILABLE'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABANDONED';

export interface QuestProgress {
  questId: string;
  playerId?: string;
  status: QuestStatus;
  objectiveProgress: Record<string, number>;
  completedAt: number | null;
  version: number;
  targetPlayerId?: string;
}

export interface Trade {
  id: string;
  fromId: string;
  toId: string;
  offered: { itemId: ItemId; quantity: number }[];
  requested: { itemId: ItemId; quantity: number }[];
  createdAt: number;
}

export interface EscapeSessionState {
  id: string;
  status: EscapeStatus;
  method: EscapeMethod | null;
  playerStatuses: Record<
    string,
    { status: EscapePlayerStatus; escapedAt: number | null }
  >;
  allPlayersReady: boolean;
  failedAt: number | null;
  attempts: number;
}

export interface CachedResult {
  requestId: string;
  result: ActionResult;
}

export interface WorldState {
  schemaVersion: 12;
  prisonId: string;
  seed: number;
  rngState: number;
  mode: GameMode;
  difficulty: Difficulty;
  /** Giới hạn số ngày (null = không giới hạn) */
  dayLimit: number | null;
  tick: number;
  /** Thời gian mô phỏng (giây thật kể từ lúc bắt đầu) */
  time: number;
  /** Tổng số phút game đã trôi kể từ Ngày 1 00:00 (KHÔNG phải phút trong ngày) */
  totalGameMinutes: number;
  prisonState: PrisonState;
  lockdownUntil: number | null;
  teamHeat: number;
  players: Record<string, PlayerState>;
  playerOrder: string[];
  requiredPlayerIds: string[];
  guards: GuardEntity[];
  inmates: InmateEntity[];
  containers: Record<string, ContainerState>;
  lastRefillDay: number;
  floorItems: Record<string, FloorItem>;
  /** Lưới thông gió đã cậy; các ô hàng rào đã cắt / buộc dây ("x,y") */
  routes: { ventOpen: boolean; fenceGaps: string[] };
  /** Mất điện (thiết bị phá điện): camera và đèn tắt tới mốc này (giây mô phỏng) */
  blackoutUntil: number;
  /** Lỗ tường / hầm tự đào / vật che */
  dig: DigState;
  /** Dấu vết mở khoá lén: cai ngục có thể phát hiện khi kiểm tra buổi sáng */
  doorTraces: { playerId: string; door: string; day: number }[];
  tunnels: Record<string, TunnelState>;
  hideSpots: Record<string, InventoryItem[]>;
  beds: Record<string, BedState>;
  market: Record<string, number>;
  camerasOffUntil: number;
  bribedCells: Record<string, number>;
  teamStorage: TeamStorage;
  personalQuests: Record<string, Record<string, QuestProgress>>;
  teamQuests: Record<string, QuestProgress>;
  contributionLedger: string[];
  trades: Record<string, Trade>;
  closedTradeIds: string[];
  escape: EscapeSessionState;
  intelUntil: number;
  outcome: Outcome | null;
  /** Khoá sự kiện lịch đã chạy (chuông, khám phòng, điểm danh) */
  scheduleKeys: string[];
  /** Điểm danh đêm đang diễn ra: chờ tới `until` (giây mô phỏng), các xà lim đã có người trả lời thay */
  nightRollcall: { until: number; answered: number[] } | null;
  /** Cai ngục đồng nghiệp đang hỏi người chơi cải trang: câu hỏi & hạn trả lời */
  challenges: Record<
    string,
    { guardId: string; question: number; until: number }
  >;
  /** Chế độ chơi một mình: bị bắt thì "qua ngày mới" thay cho biệt giam nhiều ngày */
  soloMode: boolean;
  /** Kho tịch thu của trại */
  confiscation: { items: ConfiscatedEntry[] };
  /** Phòng gym: ai đang dùng máy nào, hàng chờ (1 người / máy), tù nhân đang xin máy của người chơi */
  gym: {
    occupants: Record<string, string>;
    queue: Record<string, string>;
    requests: Record<string, GymRequest>;
  };
  journal: JournalEntry[];
  idSeq: number;
  requestLog: Record<string, CachedResult[]>;
}

// ------------------------------------------------------------------ Hành động (intent) của người chơi

export type TunnelOp = 'dig' | 'support' | 'cover' | 'crawl';

export type PlayerAction =
  | { type: 'interact'; targetId: string }
  | { type: 'cancelChannel' }
  | { type: 'useItem'; itemId: ItemId }
  | { type: 'dropItem'; itemId: ItemId; quantity: number }
  | { type: 'throwItem'; itemId: ItemId; dirX: number; dirY: number }
  | { type: 'pickupAll' }
  | { type: 'craft'; recipeId: string; quantity?: number }
  | { type: 'deposit'; itemId: ItemId; quantity: number }
  | { type: 'withdraw'; itemId: ItemId; quantity: number }
  | { type: 'attack' }
  | { type: 'lootStart'; targetId: string }
  | { type: 'lootTake'; targetId: string; slot: SlotType; index: number }
  | { type: 'lootClose' }
  | { type: 'wear'; index: number }
  | { type: 'takeOff'; slot: 'outfit' }
  | { type: 'dropWeapon' }
  | { type: 'answerChallenge'; choice: number }
  | { type: 'gymStart'; machineId: string }
  | { type: 'gymPress'; side: 0 | 1 }
  | { type: 'gymStop' }
  | { type: 'gymAnswer'; yield: boolean }
  | { type: 'report'; npcId: string }
  | { type: 'answerRollcall' }
  | { type: 'equip'; itemId: ItemId | null }
  | {
      type: 'containerTake';
      containerId: string;
      index: number;
      itemId: ItemId;
      quantity: number;
    }
  | {
      type: 'containerPut';
      containerId: string;
      index: number;
      itemId: ItemId;
      quantity: number;
    }
  | { type: 'bedTake'; bedId: string; what: BedItem }
  | { type: 'bedPlace'; bedId: string; what: BedItem }
  | { type: 'hide'; spotId: string; itemId: ItemId; quantity: number }
  | { type: 'retrieve'; spotId: string; itemId: ItemId; quantity: number }
  | { type: 'flush'; spotId: string }
  | { type: 'tunnel'; cellIndex: number; op: TunnelOp }
  | { type: 'wake' }
  | { type: 'dig'; x: number; y: number }
  | { type: 'hatch' }
  | { type: 'placeDecor'; itemId: ItemId; x: number; y: number }
  | { type: 'takeDecor'; x: number; y: number }
  | { type: 'buy'; itemId: ItemId }
  | { type: 'sell'; itemId: ItemId }
  | { type: 'npcTalk'; npcId: string }
  | { type: 'npcBuy'; npcId: string; itemId: ItemId }
  | { type: 'bribe'; guardId: string }
  | { type: 'reclaimConfiscated'; guardId: string }
  | {
      type: 'tradeRequest';
      targetPlayerId: string;
      offered: { itemId: ItemId; quantity: number }[];
      requested: { itemId: ItemId; quantity: number }[];
    }
  | { type: 'tradeAccept'; tradeId: string }
  | { type: 'tradeDecline'; tradeId: string }
  | { type: 'questAccept'; questId: string }
  | { type: 'questComplete'; questId: string }
  | { type: 'questAbandon'; questId: string }
  | {
      type: 'questContribute';
      questId: string;
      objectiveId: string;
      quantity: number;
    }
  | { type: 'revive'; targetPlayerId: string }
  | { type: 'rescueStart'; targetPlayerId: string; rescuePointId: string }
  | { type: 'rescueCancel' }
  | { type: 'assist'; assistType: 'INTEL' }
  | { type: 'escapePrepare'; escapeMethod: EscapeMethod }
  | { type: 'escapeReady'; ready: boolean }
  | { type: 'escapeStart' }
  | { type: 'escapeEnterPoint'; escapePointId: string }
  | { type: 'escapeCancel' };

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'NOT_ROOM_MEMBER'
  | 'FORBIDDEN'
  | 'INVALID_STATE'
  | 'INVALID_PAYLOAD'
  | 'OUT_OF_RANGE'
  | 'ITEM_NOT_OWNED'
  | 'INSUFFICIENT_ITEMS'
  | 'OVER_CAPACITY'
  | 'RATE_LIMITED'
  | 'DUPLICATE_REQUEST'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'REQUIREMENTS_NOT_MET';

export type ActionResult =
  | {
      ok: true;
      data?: Record<string, string | number | boolean>;
      duplicate?: boolean;
    }
  | { ok: false; code: ErrorCode; message: string; duplicate?: boolean };

/** Sự kiện gameplay phát ra từ engine — dùng cho thông báo, âm thanh, quest và audit log (bus sự kiện) */
export interface EngineEvent {
  id: string;
  type: string;
  playerId?: string;
  targetId?: string;
  text?: string;
  audit?: boolean;
  /** Toạ độ để phát âm thanh theo khoảng cách */
  x?: number;
  y?: number;
  data?: Record<string, string | number | boolean>;
}

/** Hộp thư đi của engine — không nằm trong WorldState (không được checkpoint) */
export interface Outbox {
  events: EngineEvent[];
  dirtyInventories: Set<string>;
  dirtyQuests: Set<string>;
  dirtyTeamStorage: boolean;
  dirtyMeta: boolean;
  dirtyTrades: Set<string>;
}

export function createOutbox(): Outbox {
  return {
    events: [],
    dirtyInventories: new Set(),
    dirtyQuests: new Set(),
    dirtyTeamStorage: false,
    dirtyMeta: false,
    dirtyTrades: new Set(),
  };
}

export interface MoveInput {
  sequence: number;
  directionX: number;
  directionY: number;
  sprint: boolean;
}
