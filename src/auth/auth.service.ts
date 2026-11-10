import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';

import { UsersService } from '../users/users.service';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { comparePasswords, hashPassword } from 'src/helpers/bcrypt.helper';
import { ConfigService } from '@nestjs/config';
import { User, UserDocument } from 'src/users/entities/user.entity';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async register(data: RegisterDto) {
    const existingUser = await this.usersService.findByEmail(data.email);

    if (existingUser) {
      throw new BadRequestException('Email already exists');
    }

    const hashedPassword = await hashPassword(data.password);

    const user = await this.usersService.create({
      ...data,
      password: hashedPassword,
    });

    const token = this.jwtService.sign({
      sub: user._id,
      email: user.email,
    });

    return {
      user,
      token,
    };
  }

  async login(data: LoginDto) {
    const user = await this.usersService.findByEmailWithPassword(data.email);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const { password, ...userResponse } = user.toObject();

    const isMatch = await comparePasswords(data.password, password);

    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = {
      sub: userResponse?._id,
      email: userResponse?.email,
    };

    const token = this.jwtService.sign(payload);

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: '30d',
    });

    return {
      user: userResponse,
      token,
      refreshToken,
    };
  }

  async getProfile(id: string): Promise<UserDocument | null> {
    const res = await this.userModel.findById(id).exec();
    return res;
  }
}
