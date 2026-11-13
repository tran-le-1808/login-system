import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from 'src/users/entities/user.entity';
import { PoolGateway } from './pool.gateway';
import { PoolRoomService } from './pool-room.service';
import {
  PoolMatchSchema,
  PoolRatingSchema,
  PoolStatsService,
} from './pool-stats.service';
import { PoolController } from './pool.controller';

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
      { name: 'PoolRating', schema: PoolRatingSchema },
      { name: 'PoolMatch', schema: PoolMatchSchema },
    ]),
  ],
  controllers: [PoolController],
  providers: [PoolGateway, PoolRoomService, PoolStatsService],
})
export class PoolModule {}
