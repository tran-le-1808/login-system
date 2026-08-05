import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dtos/create-user/create-user';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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
}
