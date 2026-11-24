import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import type { RequestWithUser } from 'src/auth/interfaces/request-with-user.interface';
import { CaroBookService, isRule } from './caro-book.service';

const LEARN_MIN_INTERVAL_MS = 8000;

/** Sách khai cuộc của bot cờ caro: tra cứu nước & gửi ván đã chơi với bot để bot học */
@Controller('caro')
@UseGuards(JwtAuthGuard)
export class CaroBookController {
  private lastLearn = new Map<string, number>();
  constructor(private readonly book: CaroBookService) {}

  @Post('book/query')
  async query(@Body() body: { rule?: unknown; moves?: unknown }) {
    if (!isRule(body?.rule)) throw new BadRequestException('Luật không hợp lệ');
    return { moves: await this.book.query(body.rule, body.moves) };
  }

  @Post('learn')
  async learn(
    @Req() req: RequestWithUser,
    @Body() body: { rule?: unknown; moves?: unknown },
  ) {
    if (!isRule(body?.rule)) throw new BadRequestException('Luật không hợp lệ');
    const uid = String(req.user._id);
    const now = Date.now();
    if (now - (this.lastLearn.get(uid) ?? 0) < LEARN_MIN_INTERVAL_MS)
      throw new HttpException(
        'Gửi ván quá nhanh',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.lastLearn.set(uid, now);
    const r = await this.book.learnGame(body.rule, body.moves);
    if (!r.ok) throw new BadRequestException(r.error);
    return r;
  }
}
