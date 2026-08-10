import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { PluginsService } from './plugins.service';

function orgOf(user: JwtPayload): string {
  if (!user.organizationId) {
    throw new ForbiddenException('No organization on this account');
  }
  return user.organizationId;
}

@Controller('organizations/plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  /** Catalog + this org's enabled state. Any org member may read it (feature
   *  code needs to know what's on); only admins can toggle. */
  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.plugins.listForOrg(orgOf(user));
  }

  @Post(':key')
  @Roles(Role.ORG_ADMIN)
  enable(@CurrentUser() user: JwtPayload, @Param('key') key: string) {
    return this.plugins.enable(orgOf(user), key);
  }

  @Delete(':key')
  @Roles(Role.ORG_ADMIN)
  disable(@CurrentUser() user: JwtPayload, @Param('key') key: string) {
    return this.plugins.disable(orgOf(user), key);
  }
}
