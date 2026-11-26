import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { User, UserSchema } from 'src/users/entities/user.entity';
import { PrisonGateway } from './prison.gateway';
import {
  PrisonEventSchema,
  PrisonPersistenceService,
  PrisonSessionSchema,
} from './prison-persistence.service';
import { PrisonRoomService } from './prison-room.service';
import { PrisonSimulationService } from './prison-simulation';

/** Số liệu vận hành (đăng nhập mới xem được) */
@Controller('prison')
@UseGuards(JwtAuthGuard)
export class PrisonController {
  constructor(private readonly gateway: PrisonGateway) {}

  @Get('metrics')
  metrics() {
    const mem = process.memoryUsage();
    return {
      ...this.gateway.metrics(),
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
    };
  }
}

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
      { name: 'PrisonSession', schema: PrisonSessionSchema },
      { name: 'PrisonEvent', schema: PrisonEventSchema },
    ]),
  ],
  controllers: [PrisonController],
  providers: [
    PrisonGateway,
    PrisonRoomService,
    PrisonSimulationService,
    PrisonPersistenceService,
  ],
})
export class PrisonModule {}
