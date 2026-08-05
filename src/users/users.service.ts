import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './entities/user.entity';

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
}
