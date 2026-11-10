import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dtos/create-user/create-user';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import type { RequestWithUser } from 'src/auth/interfaces/request-with-user.interface';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { EditUserDto } from './dtos/edit-user.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CloudinaryService } from 'src/common/cloudinary/cloudinary.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  @Post()
  async create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Get()
  async findAll() {
    return this.usersService.findAll();
  }

  @Get('search')
  async searchUsers(
    @Query('keyword')
    keyword?: string,
    @Query('currentUserId')
    currentUserId?: string,
  ) {
    return this.usersService.searchUsers(keyword, currentUserId);
  }

  @Put('edit')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(), // Lưu tạm file vào memory RAM
      limits: { fileSize: 5 * 1024 * 1024 }, // Tối đa 5MB
      fileFilter: (req, file, callback) => {
        if (!file.mimetype.match(/\/(jpg|jpeg|png|webp|svg)$/)) {
          return callback(
            new BadRequestException(
              'Chỉ chấp nhận file ảnh (jpg, jpeg, png, webp, svg)',
            ),
            false,
          );
        }
        callback(null, true);
      },
    }),
  )
  async editUser(
    @Req() req: RequestWithUser,
    @Body() dto: EditUserDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const userId = String(req.user._id);
    let avatarUrl = dto.avatar;

    // Nếu người dùng có upload file ảnh mới
    if (file) {
      const uploadResult = await this.cloudinaryService.uploadFile(file);
      avatarUrl = uploadResult.secure_url; // HTTPS URL trực tiếp từ Cloudinary
    }

    return this.usersService.editUser(userId, { ...dto, avatar: avatarUrl });
  }

  @Put('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Req() req: RequestWithUser,
    @Body() dto: ChangePasswordDto,
  ) {
    const userId = String(req.user._id);
    return this.usersService.changePassword(userId, dto);
  }
}
