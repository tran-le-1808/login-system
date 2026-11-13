import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import type { RequestWithUser } from 'src/auth/interfaces/request-with-user.interface';
import { PoolStatsService } from './pool-stats.service';

/** ELO, lịch sử trận & replay của người chơi */
@Controller('pool')
@UseGuards(JwtAuthGuard)
export class PoolController {
  constructor(private readonly stats: PoolStatsService) {}

  @Get('me')
  async me(@Req() req: RequestWithUser) {
    const userId = String(req.user._id);
    const [rating, history] = await Promise.all([
      this.stats.getRating(userId),
      this.stats.history(userId),
    ]);
    return { rating, history };
  }

  @Get('matches/:id')
  async match(@Req() req: RequestWithUser, @Param('id') id: string) {
    if (!isValidObjectId(id))
      throw new NotFoundException('Không tìm thấy trận');
    const m = await this.stats.replay(id, String(req.user._id));
    if (!m) throw new NotFoundException('Không tìm thấy trận');
    return m;
  }
}
