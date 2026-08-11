import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { CreateHifzTargetDto } from './dto/create-target.dto';
import { HifzService } from './hifz.service';
import { LogHifzEntryDto } from './dto/log-entry.dto';

/** Hifz tracking lives under a course. Instructor/admin manage; students read
 *  their own via /mine. */
@Controller('courses/:courseId/hifz')
export class HifzController {
  constructor(private readonly hifz: HifzService) {}

  /** Instructor/admin: every student's targets, log and progress. */
  @Get()
  overview(@CurrentUser() user: JwtPayload, @Param('courseId') courseId: string) {
    return this.hifz.overview(user, courseId);
  }

  /** Student: my own targets + recitation log. */
  @Get('mine')
  mine(@CurrentUser() user: JwtPayload, @Param('courseId') courseId: string) {
    return this.hifz.mine(user, courseId);
  }

  @Post('targets')
  createTarget(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: CreateHifzTargetDto,
  ) {
    return this.hifz.createTarget(user, courseId, dto);
  }

  @Delete('targets/:targetId')
  removeTarget(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('targetId') targetId: string,
  ) {
    return this.hifz.removeTarget(user, courseId, targetId);
  }

  @Post('entries')
  logEntry(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: LogHifzEntryDto,
  ) {
    return this.hifz.logEntry(user, courseId, dto);
  }

  @Delete('entries/:entryId')
  removeEntry(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.hifz.removeEntry(user, courseId, entryId);
  }
}
