import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { PointsService } from './points.service';

@Controller('points')
export class PointsController {
  constructor(private readonly points: PointsService) {}

  /** Public within the platform — competitive vibe by design. */
  @Get('leaderboard')
  leaderboard(@Query('courseId') courseId: string) {
    if (!courseId) throw new BadRequestException('courseId is required');
    return this.points.leaderboard(courseId);
  }

  @Get('me')
  @Roles(Role.STUDENT)
  me(@CurrentUser() user: JwtPayload, @Query('courseId') courseId: string) {
    if (!courseId) throw new BadRequestException('courseId is required');
    return this.points.myPoints(user.sub, courseId);
  }
}
