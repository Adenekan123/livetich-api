import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { JwtPayload } from '../../auth/jwt-payload';
import { PLUGIN_CODE_INSTRUCTION } from '../../plugins/catalog';
import {
  RequirePlugin,
  RequirePluginGuard,
} from '../../plugins/require-plugin.guard';
import { ConnectGitHubIdentityDto } from './dto/github-identity.dto';
import { GitHubIdentityService } from './github-identity.service';
import type { GitHubIdentity } from './github-identity.service';

/**
 * "Connect GitHub", once, from the editor (§9).
 *
 * Always the caller's own account: there is no user id in any of these routes,
 * so one student can neither read nor change another's connection. Not limited
 * to students either — an instructor reviewing work in their editor connects
 * the same way.
 */
@Controller('coding/github/identity')
@UseGuards(RequirePluginGuard)
@RequirePlugin(PLUGIN_CODE_INSTRUCTION)
export class GitHubIdentityController {
  constructor(private readonly identity: GitHubIdentityService) {}

  /** Whether the caller has connected GitHub, and as whom. */
  @Get()
  current(@CurrentUser() user: JwtPayload): Promise<GitHubIdentity> {
    return this.identity.current(user);
  }

  /**
   * Hand over a GitHub token so the server can confirm whose it is.
   *
   * The token is verified and discarded in the same request — what persists is
   * only the login GitHub reported.
   */
  @Post()
  connect(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConnectGitHubIdentityDto,
  ): Promise<GitHubIdentity> {
    return this.identity.connect(user, dto);
  }

  /** Unlink. Access to repositories already granted is left untouched. */
  @Delete()
  disconnect(@CurrentUser() user: JwtPayload): Promise<GitHubIdentity> {
    return this.identity.disconnect(user);
  }
}
