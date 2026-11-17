import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from 'src/users/entities/user.entity';
import { BilliardGateway } from './billiard.gateway';
import { BilliardRoomService } from './billiard-room.service';
import { BilliardLobbyGateway } from './lobby/billiard-lobby.gateway';
import { BilliardEventsService } from './lobby/events.service';
import { BilliardMatchFlowService } from './lobby/match-flow.service';
import {
  BILLIARD_MATCH,
  BILLIARD_PROFILE,
  BILLIARD_RANK_HISTORY,
  BILLIARD_SEASON,
  BILLIARD_TOURNAMENT,
  BILLIARD_TOURNAMENT_MATCH,
  BilliardMatchSchema,
  BilliardProfileSchema,
  BilliardRankHistorySchema,
  BilliardSeasonSchema,
  BilliardTournamentMatchSchema,
  BilliardTournamentSchema,
  MongoBilliardStore,
} from './lobby/mongo.store';
import { BilliardRankingService } from './lobby/ranking.service';
import { BILLIARD_STORE } from './lobby/tokens';
import { BilliardTournamentService } from './lobby/tournament.service';
import { BilliardTournamentUploadController } from './lobby/tournament-upload.controller';
import { CloudinaryService } from 'src/common/cloudinary/cloudinary.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: BILLIARD_PROFILE, schema: BilliardProfileSchema },
      { name: BILLIARD_MATCH, schema: BilliardMatchSchema },
      { name: BILLIARD_RANK_HISTORY, schema: BilliardRankHistorySchema },
      { name: BILLIARD_SEASON, schema: BilliardSeasonSchema },
      { name: BILLIARD_TOURNAMENT, schema: BilliardTournamentSchema },
      {
        name: BILLIARD_TOURNAMENT_MATCH,
        schema: BilliardTournamentMatchSchema,
      },
    ]),
  ],
  controllers: [BilliardTournamentUploadController],
  providers: [
    CloudinaryService,
    BilliardGateway,
    BilliardRoomService,
    BilliardLobbyGateway,
    BilliardEventsService,
    BilliardMatchFlowService,
    BilliardRankingService,
    BilliardTournamentService,
    { provide: BILLIARD_STORE, useClass: MongoBilliardStore },
  ],
})
export class BilliardModule {}
