import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from 'src/users/entities/user.entity';
import { CaroGateway } from './caro.gateway';
import { CaroRoomService } from './caro-room.service';
import {
  CaroBookSchema,
  CaroBookService,
  MongoCaroBookStore,
} from './caro-book.service';
import { CaroBookController } from './caro-book.controller';

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
      { name: 'CaroBook', schema: CaroBookSchema },
    ]),
  ],
  controllers: [CaroBookController],
  providers: [
    CaroGateway,
    CaroRoomService,
    MongoCaroBookStore,
    {
      provide: CaroBookService,
      useFactory: (store: MongoCaroBookStore) => new CaroBookService(store),
      inject: [MongoCaroBookStore],
    },
  ],
})
export class CaroModule {}
