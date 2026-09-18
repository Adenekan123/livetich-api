import { Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { JwtPayload } from '../../auth/jwt-payload';
import { CodingWorkspaceService } from './coding-workspace.service';
import type {
  WorkspaceSummary,
  WorkspaceView,
} from './coding-workspace.service';

/**
 * The student's coding workspace, as the editor sees it.
 *
 * Two verbs only. `GET` answers "what is the state of my workspace" and changes
 * nothing, so the extension can poll it on open; `POST .../start` is the button
 * (§11), and is safe to press twice — the service claims the work before it
 * calls GitHub, so a second press is told it is already running rather than
 * creating a second repository.
 *
 * Neither route takes a student id, a repository id, or an organisation. The
 * only thing the caller supplies is which enrolment, and the service re-derives
 * student -> enrolment -> program -> workspace from the token every time (§44).
 */
@Controller('coding/workspaces')
export class CodingWorkspaceController {
  constructor(private readonly workspaces: CodingWorkspaceService) {}

  /**
   * The caller's coding programs. Listed at the collection root rather than
   * under a name like `/mine`, which would be shadowed by the `:enrollmentId`
   * route below and silently resolve as a workspace called "mine".
   */
  @Get()
  listMine(@CurrentUser() user: JwtPayload): Promise<WorkspaceSummary[]> {
    return this.workspaces.listMine(user);
  }

  /** State of one workspace. Never provisions anything. */
  @Get(':enrollmentId')
  get(
    @CurrentUser() user: JwtPayload,
    @Param('enrollmentId') enrollmentId: string,
  ): Promise<WorkspaceView> {
    return this.workspaces.get(user, enrollmentId);
  }

  /** "Start Coding Workspace" — creates the repository on first press. */
  @Post(':enrollmentId/start')
  start(
    @CurrentUser() user: JwtPayload,
    @Param('enrollmentId') enrollmentId: string,
  ): Promise<WorkspaceView> {
    return this.workspaces.start(user, enrollmentId);
  }
}
