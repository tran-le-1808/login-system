import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './entities/user.entity';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { EditUserDto } from './dtos/edit-user.dto';
import { comparePasswords, hashPassword } from 'src/helpers/bcrypt.helper';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
  ) {}

  async findAll() {
    return this.userModel.find().exec();
  }

  async findByEmail(email: string) {
    return this.userModel
      .findOne({
        email,
      })
      .exec();
  }

  async findByEmailWithPassword(email: string) {
    return this.userModel.findOne({ email }).select('+password').exec();
  }

  async create(data: Partial<User>) {
    return this.userModel.create(data);
  }

  async searchUsers(keyword = '', currentUserId?: string) {
    const query: Record<string, unknown> = {};

    if (keyword.trim()) {
      query.$or = [
        {
          name: {
            $regex: keyword,
            $options: 'i',
          },
        },

        {
          email: {
            $regex: keyword,
            $options: 'i',
          },
        },
      ];
    }

    if (currentUserId) {
      query._id = {
        $ne: currentUserId,
      };
    }

    return this.userModel
      .find(query)
      .select('_id name email avatar')
      .limit(20)
      .exec();
  }

  async editUser(userId: string, dto: EditUserDto) {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng');
    }

    if (dto.name !== undefined) user.name = dto.name;
    if (dto.avatar !== undefined) user.avatar = dto.avatar;

    await user.save();

    return {
      _id: user._id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.userModel.findById(userId).select('+password');
    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng');
    }

    const isMatch = await comparePasswords(dto.oldPassword, user.password);
    if (!isMatch) {
      throw new BadRequestException('Mật khẩu cũ không chính xác');
    }

    const hashedPassword = await hashPassword(dto.newPassword);
    user.password = hashedPassword;
    await user.save();

    return { message: 'Đổi mật khẩu thành công' };
  }
}
