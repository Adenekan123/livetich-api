import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { CreateGroupDto } from './dto/create-group.dto';
import { SetMembersDto } from './dto/set-members.dto';
import { GroupsService } from './groups.service';

/** Student groups live under a course; only its managers (instructor/admin) touch them. */
@Controller('courses/:courseId/groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload, @Param('courseId') courseId: string) {
    return this.groups.listForCourse(user, courseId);
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: CreateGroupDto,
  ) {
    return this.groups.create(user, courseId, dto);
  }

  @Patch(':groupId')
  rename(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('groupId') groupId: string,
    @Body() dto: CreateGroupDto,
  ) {
    return this.groups.rename(user, courseId, groupId, dto);
  }

  @Delete(':groupId')
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('groupId') groupId: string,
  ) {
    return this.groups.remove(user, courseId, groupId);
  }

  /** Replace the group's full membership. */
  @Patch(':groupId/members')
  setMembers(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('groupId') groupId: string,
    @Body() dto: SetMembersDto,
  ) {
    return this.groups.setMembers(user, courseId, groupId, dto);
  }
}
