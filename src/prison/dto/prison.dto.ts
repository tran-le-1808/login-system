/**
 * DTO cho MỌI sự kiện client -> server ở namespace /game (class-validator).
 * Không có trường userId/playerId của chính mình — danh tính luôn lấy từ socket đã xác thực.
 */
import { plainToInstance, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { ITEM_IDS } from '../shared/items';
import type { ItemId } from '../shared/types';

const REQUEST_ID = /^[A-Za-z0-9_-]{6,64}$/;
const ROOM_CODE = /^[A-Z0-9]{4,8}$/;
const SAFE_ID = /^[A-Za-z0-9_:-]{1,64}$/;

/** Siêu dữ liệu bắt buộc cho thao tác thay đổi tài nguyên (idempotency) */
export class RequestMetaDto {
  @IsString()
  @Matches(REQUEST_ID)
  requestId!: string;
}

// ------------------------------------------------------------------ phòng

export class RoomSettingsDto {
  @IsOptional()
  @IsIn(['NORMAL', 'HARD', 'HARDCORE'])
  difficulty?: 'NORMAL' | 'HARD' | 'HARDCORE';

  @IsOptional()
  @IsBoolean()
  allowLateJoin?: boolean;

  @IsOptional()
  @IsBoolean()
  privateRoom?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  maxPlayers?: 1 | 2 | 3 | 4;

  @IsOptional()
  @IsIn(['grey_stone'])
  prisonId?: string;
}

export class CreateRoomDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => RoomSettingsDto)
  settings?: RoomSettingsDto;
}

export class JoinRoomDto {
  @IsString()
  @Matches(ROOM_CODE)
  roomCode!: string;
}

export class ReadyDto {
  @IsBoolean()
  ready!: boolean;
}

export class RoleDto {
  @IsIn(['HACKER', 'FIGHTER', 'MECHANIC', 'SCOUT'])
  role!: 'HACKER' | 'FIGHTER' | 'MECHANIC' | 'SCOUT';
}

export class UpdateSettingsDto {
  @ValidateNested()
  @Type(() => RoomSettingsDto)
  settings!: RoomSettingsDto;
}

export class InviteDto {
  @IsString()
  @Matches(/^[a-f0-9]{24}$/i)
  targetUserId!: string;
}

// ------------------------------------------------------------------ di chuyển

export class PlayerInputDto {
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  sequence!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-1)
  @Max(1)
  directionX!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-1)
  @Max(1)
  directionY!: number;

  @IsBoolean()
  sprint!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  clientTick?: number;
}

// ------------------------------------------------------------------ thao tác

export class InteractDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  targetId!: string;

  @IsOptional()
  @IsString()
  @Matches(SAFE_ID)
  interactionId?: string;
}

export class ItemQuantityDto {
  @IsIn(ITEM_IDS)
  itemId!: ItemId;

  @IsInt()
  @Min(1)
  @Max(20)
  quantity!: number;
}

export class ItemQuantityRequestDto extends RequestMetaDto {
  @IsIn(ITEM_IDS)
  itemId!: ItemId;

  @IsInt()
  @Min(1)
  @Max(20)
  quantity!: number;
}

export class UseItemDto extends RequestMetaDto {
  @IsIn(ITEM_IDS)
  itemId!: ItemId;

  @IsOptional()
  @IsString()
  @Matches(SAFE_ID)
  targetId?: string;
}

export class CraftDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  recipeId!: string;

  /** Chế tạo nhiều lần trong một yêu cầu (×1 / ×5 / tối đa) */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  quantity?: number;
}

export class TradeRequestDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  targetPlayerId!: string;

  @ValidateNested({ each: true })
  @ArrayMaxSize(6)
  @Type(() => ItemQuantityDto)
  offeredItems!: ItemQuantityDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @ArrayMaxSize(6)
  @Type(() => ItemQuantityDto)
  requestedItems?: ItemQuantityDto[];
}

export class TradeIdDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  tradeId!: string;
}

export class QuestIdDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  questId!: string;
}

export class QuestContributeDto extends QuestIdDto {
  @IsString()
  @Matches(SAFE_ID)
  objectiveId!: string;

  @IsInt()
  @Min(1)
  @Max(20)
  contribution!: number;
}

export class TargetPlayerDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  targetPlayerId!: string;
}

export class AssistDto extends RequestMetaDto {
  @IsIn(['INTEL'])
  assistType!: 'INTEL';

  @IsOptional()
  @IsString()
  @Matches(SAFE_ID)
  targetPlayerId?: string;
}

export class RescueStartDto extends TargetPlayerDto {
  @IsString()
  @Matches(SAFE_ID)
  rescuePointId!: string;
}

export class RescueCancelDto extends RequestMetaDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  rescueId?: string;
}

export class EscapePrepareDto extends RequestMetaDto {
  @IsIn(['TUNNEL', 'VENT', 'GATE', 'LAUNDRY', 'FENCE', 'WALL', 'TRUCK'])
  escapeMethod!:
    | 'TUNNEL'
    | 'VENT'
    | 'GATE'
    | 'LAUNDRY'
    | 'FENCE'
    | 'WALL'
    | 'TRUCK';
}

/** Ném 1 món theo hướng (dirX, dirY); (0, 0) = hướng đang nhìn */
export class ThrowItemDto extends RequestMetaDto {
  @IsIn(ITEM_IDS)
  itemId!: ItemId;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-1)
  @Max(1)
  dirX!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-1)
  @Max(1)
  dirY!: number;
}

export class EscapeReadyDto extends RequestMetaDto {
  @IsBoolean()
  ready!: boolean;
}

export class EscapePointDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  escapePointId!: string;
}

export class EscapeCancelDto extends RequestMetaDto {
  @IsOptional()
  @IsString()
  @MinLength(0)
  @MaxLength(120)
  reason?: string;
}

export class HideDto extends ItemQuantityRequestDto {
  @IsString()
  @Matches(SAFE_ID)
  spotId!: string;
}

export class SpotDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  spotId!: string;
}

export class TunnelDto extends RequestMetaDto {
  @IsInt()
  @Min(0)
  @Max(11)
  cellIndex!: number;

  @IsIn(['dig', 'support', 'cover', 'crawl'])
  op!: 'dig' | 'support' | 'cover' | 'crawl';
}

export class TileDto extends RequestMetaDto {
  @IsInt()
  @Min(0)
  @Max(255)
  x!: number;

  @IsInt()
  @Min(0)
  @Max(255)
  y!: number;
}

export class DecorPlaceDto extends TileDto {
  @IsIn(['wall_picture', 'floor_rug'])
  itemId!: 'wall_picture' | 'floor_rug';
}

export class ItemRequestDto extends RequestMetaDto {
  @IsIn(ITEM_IDS)
  itemId!: ItemId;
}

export class NpcDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  npcId!: string;
}

export class NpcBuyDto extends NpcDto {
  @IsIn(ITEM_IDS)
  itemId!: ItemId;
}

export class GuardDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  guardId!: string;
}

/** Chuyển đồ giữa túi và tủ: ô `index` phải còn đúng `itemId` (chống lệch khi trạng thái đổi) */
export class ContainerMoveDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  containerId!: string;

  @IsInt()
  @Min(0)
  @Max(63)
  index!: number;

  @IsIn(ITEM_IDS)
  itemId!: ItemId;

  @IsInt()
  @Min(1)
  @Max(20)
  quantity!: number;
}

export class BedDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  bedId!: string;

  @IsIn(['pillow', 'blanket', 'dummy'])
  what!: 'pillow' | 'blanket' | 'dummy';
}

/** Trang bị vũ khí; bỏ trống itemId = cất vũ khí (đánh tay không) */
export class EquipDto extends RequestMetaDto {
  @IsOptional()
  @IsIn(ITEM_IDS)
  itemId?: ItemId;
}

/** Bắt đầu lục soát người đang ngất (tù nhân / cai ngục) */
export class LootStartDto extends RequestMetaDto {
  @IsString()
  @Matches(SAFE_ID)
  targetId!: string;
}

/** Lấy một món từ người đang bị lục soát: ô túi (index) hoặc ô trang bị */
export class LootTakeDto extends LootStartDto {
  @IsIn(['bag', 'weapon', 'outfit'])
  slot!: 'bag' | 'weapon' | 'outfit';

  @IsInt()
  @Min(0)
  @Max(15)
  index!: number;
}

/** Mặc áo/quần đang nằm ở ô túi chính */
export class WearDto extends RequestMetaDto {
  @IsInt()
  @Min(0)
  @Max(15)
  index!: number;
}

export class TakeOffDto extends RequestMetaDto {
  @IsIn(['outfit'])
  slot!: 'outfit';
}

/** Trả lời câu hỏi của cai ngục khi đang cải trang */
export class ChallengeAnswerDto extends RequestMetaDto {
  @IsInt()
  @Min(0)
  @Max(5)
  choice!: number;
}

/** Chọn máy gym: press_<n> (đẩy tạ) / tread_<n> (chạy bộ) */
export class GymStartDto extends RequestMetaDto {
  @IsString()
  @Matches(/^(press|tread)_\d{1,3}$/)
  machineId!: string;
}

/** Một lần bấm nhịp: 0 = trái, 1 = phải */
export class GymPressDto extends RequestMetaDto {
  @IsIn([0, 1])
  side!: 0 | 1;
}

/** Trả lời tù nhân xin máy: true = nhường */
export class GymAnswerDto extends RequestMetaDto {
  @IsBoolean()
  yield!: boolean;
}

/** Sự kiện không cần payload — vẫn chặn trường lạ */
export class EmptyDto {}

export type DtoClass<T> = new () => T;

/**
 * Validate payload theo DTO. whitelist + forbidNonWhitelisted: trường lạ (vd. `completed: true`,
 * `userId`) làm payload bị từ chối thay vì bị lờ đi.
 */
export function validateDto<T extends object>(
  cls: DtoClass<T>,
  body: unknown,
): { ok: true; value: T } | { ok: false; errors: string[] } {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, errors: ['payload phải là object'] };
  if ((cls as unknown) === EmptyDto) {
    const keys = Object.keys(body);
    return keys.length
      ? { ok: false, errors: [`không nhận trường: ${keys.join(', ')}`] }
      : { ok: true, value: new cls() };
  }
  const inst = plainToInstance(cls, body);
  const errs = validateSync(inst, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errs.length)
    return {
      ok: false,
      errors: errs.flatMap((e) => [
        ...Object.values(e.constraints ?? {}),
        ...(e.children?.length ? [`${e.property} không hợp lệ`] : []),
      ]),
    };
  return { ok: true, value: inst };
}
