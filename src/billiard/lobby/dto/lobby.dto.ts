/** DTO cho mọi sự kiện socket mới của sảnh Bida Carom (whitelist + chặn trường lạ) */
import { plainToInstance, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import {
  RANKING_CONFIG as R,
  RULE_SET_IDS,
  TOURNAMENT_TARGET,
} from '../ranking.config';
import { TURN_SECONDS_OPTIONS } from '../../billiard.types';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROOM_CODE = /^[A-Z0-9]{6}$/;

export class RoomListDto {
  @IsOptional() @IsString() @MaxLength(40) search?: string;
  @IsOptional() @IsIn(['free', 'three']) mode?: 'free' | 'three';
  @IsOptional() @IsIn(['lobby', 'playing']) status?: 'lobby' | 'playing';
  @IsOptional() @IsIn(['newest', 'players']) sort?: 'newest' | 'players';
}

export class CreateRoomDto {
  @IsOptional() @IsString() @MaxLength(40) name?: string;
  @IsOptional() @IsBoolean() isPrivate?: boolean;
  @IsOptional() @IsIn(['free', 'three']) mode?: 'free' | 'three';
  @IsOptional() @IsInt() target?: number;
  @IsOptional() @IsBoolean() guideline?: boolean;
  @IsOptional() @IsIn(TURN_SECONDS_OPTIONS) turnSeconds?: number;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(32) password?: string;
}

export class JoinRoomDto {
  @IsString() @Matches(ROOM_CODE) code!: string;
  @IsOptional() @IsString() @MaxLength(32) password?: string;
}

export class MatchmakingJoinDto {
  @IsIn(['QUICK', 'RANKED']) mode!: 'QUICK' | 'RANKED';
  /** Quick: luật cụ thể (đã gồm thể loại) */
  @IsOptional() @IsIn(RULE_SET_IDS) ruleSet?: string;
  /** Ranked: thể loại bida (free = Libre, three = 3 băng) — mỗi thể loại một thang hạng */
  @IsOptional() @IsIn(['free', 'three']) discipline?: 'free' | 'three';
}

export class DisciplineDto {
  @IsIn(['free', 'three']) discipline!: 'free' | 'three';
}

export class PendingDto {
  @IsString() @Matches(ID) pendingId!: string;
}

export class LeaderboardDto {
  @IsOptional() @IsIn(['free', 'three']) discipline?: 'free' | 'three';
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) page!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(50) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(40) search?: string;
  @IsOptional() @IsString() @Matches(ID) seasonId?: string;
}

export class ProfileDto {
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{24}$/i) userId?: string;
}

export class HistoryDto {
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{24}$/i) userId?: string;
  @IsOptional() @IsIn(['RANKED', 'CASUAL', 'TOURNAMENT', 'QUICK']) gameMode?:
    | 'RANKED'
    | 'CASUAL'
    | 'TOURNAMENT'
    | 'QUICK';
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) page!: number;
}

export class TournamentListDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) page!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(60) search?: string;
  @IsOptional() @IsIn(['upcoming', 'live', 'finished', 'all']) filter?:
    | 'upcoming'
    | 'live'
    | 'finished'
    | 'all';
}

export class TournamentIdDto {
  @IsString() @Matches(ID) tournamentId!: string;
}

export class TournamentJoinDto extends TournamentIdDto {
  @IsOptional() @IsString() @MaxLength(32) password?: string;
}

export class TournamentInviteDto extends TournamentIdDto {
  @IsString() @Matches(/^[a-f0-9]{24}$/i) userId!: string;
}

export class TournamentCreateDto {
  @IsString() @MinLength(3) @MaxLength(60) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  /** URL ảnh đã tải lên Cloudinary qua POST /billiard/tournaments/thumbnail (server kiểm tra lại nguồn) */
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(400)
  thumbnail?: string;
  @IsIn(R.tournament.sizes) maxParticipants!: number;
  /** Loại bida: free = Libre (phăng), three = 3 băng */
  @IsIn(['free', 'three']) mode!: 'free' | 'three';
  /** Số điểm để thắng mỗi trận */
  @IsInt()
  @Min(TOURNAMENT_TARGET.min)
  @Max(TOURNAMENT_TARGET.max)
  target!: number;
  @IsInt() startAt!: number;
  @IsInt() registrationDeadline!: number;
  @IsIn(['SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION']) format!:
    | 'SINGLE_ELIMINATION'
    | 'DOUBLE_ELIMINATION';
  @IsOptional() @IsIn(['random', 'rating']) seeding?: 'random' | 'rating';
  @IsOptional() @IsInt() @Min(5) @Max(120) matchDurationMinutes?: number;
  @IsIn(['PUBLIC', 'PRIVATE']) visibility!: 'PUBLIC' | 'PRIVATE';
  @IsOptional() @IsString() @MinLength(3) @MaxLength(32) password?: string;
  @IsOptional() @IsInt() @Min(0) entryFee?: number;
  @IsOptional() @IsInt() @Min(0) prizePool?: number;
  @IsOptional() @IsBoolean() joinAsPlayer?: boolean;
}

export type DtoClass<T> = new () => T;

/** Kiểm tra payload: object, đúng kiểu, không có trường lạ */
export function validateDto<T extends object>(
  cls: DtoClass<T>,
  body: unknown,
): { ok: true; value: T } | { ok: false; error: string } {
  const raw = body === undefined || body === null ? {} : body;
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: 'Dữ liệu gửi lên không hợp lệ' };
  const inst = plainToInstance(cls, raw);
  const errs = validateSync(inst, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errs.length)
    return {
      ok: false,
      error: `Dữ liệu không hợp lệ: ${errs.map((e) => e.property).join(', ')}`,
    };
  return { ok: true, value: inst };
}
