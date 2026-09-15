import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { AllowRecorder } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { PLUGIN_ISLAMIC_EDUCATION } from '../plugins/catalog';
import {
  RequirePlugin,
  RequirePluginGuard,
} from '../plugins/require-plugin.guard';
import { CreateTajweedAnnotationDto } from './dto/create-annotation.dto';
import {
  ListTajweedAnnotationsDto,
  TajweedSessionScopeDto,
} from './dto/list-annotations.dto';
import { UpdateTajweedAnnotationDto } from './dto/update-annotation.dto';
import { TajweedService } from './tajweed.service';

/**
 * Saved Tajweed annotations live under a course, like Hifz. Instructor/admin
 * write; students read the lesson and their own corrections. Gated on the
 * Islamic Education pack. Live annotations are socket-only (RoomGateway).
 */
@Controller('courses/:courseId/tajweed')
@UseGuards(RequirePluginGuard)
@RequirePlugin(PLUGIN_ISLAMIC_EDUCATION)
export class TajweedController {
  constructor(private readonly tajweed: TajweedService) {}

  /** A lesson's annotations (by section or live session), plus the corrections
   *  the caller may see. A recorder may read its own session's lesson, so a
   *  recorded Tajweed class shows what the teacher marked. */
  @Get('annotations')
  @AllowRecorder()
  list(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Query() q: ListTajweedAnnotationsDto,
  ) {
    return this.tajweed.list(user, courseId, q);
  }

  @Post('annotations')
  create(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: CreateTajweedAnnotationDto,
  ) {
    return this.tajweed.create(user, courseId, dto);
  }

  @Patch('annotations/:id')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTajweedAnnotationDto,
  ) {
    return this.tajweed.update(user, courseId, id, dto);
  }

  @Delete('annotations/:id')
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('id') id: string,
    @Query() q: TajweedSessionScopeDto,
  ) {
    return this.tajweed.remove(user, courseId, id, q.sessionId);
  }

  /** Who changed an annotation and when, including after deletion. Staff only. */
  @Get('annotations/:id/history')
  history(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('id') id: string,
  ) {
    return this.tajweed.history(user, courseId, id);
  }

  /** Per-student, per-rule counts of what the teacher recorded. Staff see the
   *  class; a student sees only themselves. */
  @Get('progress')
  progress(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.tajweed.progress(user, courseId);
  }

  /** One student's corrections with a per-rule tally. Staff for anyone in the
   *  course; a student for themselves only. */
  @Get('students/:studentId/corrections')
  studentCorrections(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('studentId') studentId: string,
  ) {
    return this.tajweed.studentCorrections(user, courseId, studentId);
  }
}
