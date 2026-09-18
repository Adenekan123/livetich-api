import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { JwtPayload } from '../../auth/jwt-payload';
import { Roles } from '../../auth/roles.guard';
import {
  ConfigureProgramGitDto,
  ConnectGitHubDto,
} from './dto/github-connection.dto';
import { GitHubConnectionService } from './github-connection.service';

/** Admin routes act on the caller's own workspace, and need one to act on. */
function orgOf(user: JwtPayload): string {
  if (!user.organizationId) {
    throw new ForbiddenException('No organization on this account');
  }
  return user.organizationId;
}

/**
 * Connecting a workspace's GitHub organisation, and marking programs as
 * coding-enabled — the setup an administrator does once.
 *
 * The organisation is never taken from the request body. Every route derives
 * it from the caller's own token, so an admin can only ever connect, inspect
 * or disconnect their own workspace (§32, §44).
 */
@Controller('coding/github')
export class GitHubConnectionController {
  constructor(private readonly connections: GitHubConnectionService) {}

  /**
   * Whether this workspace is connected, and where to go if not.
   *
   * Readable by any signed-in member, because the student-facing message
   * "your school has not connected GitHub yet" is only useful if the app can
   * tell that is the reason.
   */
  @Get('connection')
  status(@CurrentUser() user: JwtPayload) {
    return this.connections.status(orgOf(user));
  }

  /** Finish installing: bind the installation GitHub redirected back with. */
  @Post('connection')
  @Roles(Role.ORG_ADMIN)
  connect(@CurrentUser() user: JwtPayload, @Body() dto: ConnectGitHubDto) {
    return this.connections.connect(user, orgOf(user), dto);
  }

  /** Stop using the connection. Repositories on GitHub are left untouched. */
  @Delete('connection')
  @Roles(Role.ORG_ADMIN)
  disconnect(@CurrentUser() user: JwtPayload) {
    return this.connections.disconnect(user, orgOf(user));
  }

  /** How this program provisions repositories, or null if it does not. */
  @Get('programs/:courseId/config')
  programConfig(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.connections.programConfig(user, courseId);
  }

  /**
   * Turn coding on for a program, optionally with a template repository.
   *
   * Not restricted to ORG_ADMIN: the assigned instructor owns their program's
   * setup, and the service re-checks that with the same assertCanManageCourse
   * every other course mutation uses.
   */
  @Put('programs/:courseId/config')
  configureProgram(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: ConfigureProgramGitDto,
  ) {
    return this.connections.configureProgram(user, orgOf(user), courseId, dto);
  }
}
