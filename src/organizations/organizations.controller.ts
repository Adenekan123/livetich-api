import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { CreateInviteDto } from './dto/create-invite.dto';
import { SetMemberStatusDto } from './dto/set-member-status.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { UpdateOrgSettingsDto } from './dto/update-org-settings.dto';
import { OrganizationsService } from './organizations.service';

/** Every user carries an org; admin-only routes also need one to act on. */
function orgOf(user: JwtPayload): string {
  if (!user.organizationId) {
    throw new ForbiddenException('No organization on this account');
  }
  return user.organizationId;
}

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  /** The requester's own org (brand kit) — used to theme the app shell. */
  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return this.orgs.getMine(user.organizationId);
  }

  @Patch('me')
  @Roles(Role.ORG_ADMIN)
  updateBrand(@CurrentUser() user: JwtPayload, @Body() dto: UpdateBrandDto) {
    return this.orgs.updateBrand(orgOf(user), dto);
  }

  // ---------- Class preferences ----------

  /** Read the org's class preferences — any member (the room adapts its UI). */
  @Get('settings')
  settings(@CurrentUser() user: JwtPayload) {
    return this.orgs.getSettings(user.organizationId);
  }

  @Patch('settings')
  @Roles(Role.ORG_ADMIN)
  updateSettings(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateOrgSettingsDto,
  ) {
    return this.orgs.updateSettings(orgOf(user), dto);
  }

  // ---------- Members ----------

  @Get('instructors')
  @Roles(Role.ORG_ADMIN)
  instructors(@CurrentUser() user: JwtPayload) {
    return this.orgs.listMembers(orgOf(user), Role.INSTRUCTOR);
  }

  @Get('students')
  @Roles(Role.ORG_ADMIN)
  students(@CurrentUser() user: JwtPayload) {
    return this.orgs.listMembers(orgOf(user), Role.STUDENT);
  }

  /** Students + performance metrics; optional ?courseId= program filter. */
  @Get('students/stats')
  @Roles(Role.ORG_ADMIN)
  studentStats(
    @CurrentUser() user: JwtPayload,
    @Query('courseId') courseId?: string,
  ) {
    return this.orgs.studentStats(orgOf(user), courseId || undefined);
  }

  /** Enable/disable a member of the org (blocks login + ends their session). */
  @Patch('members/:id/status')
  @Roles(Role.ORG_ADMIN)
  setMemberStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SetMemberStatusDto,
  ) {
    return this.orgs.setMemberStatus(orgOf(user), id, dto.status);
  }

  // ---------- Invites ----------

  @Post('invites')
  @Roles(Role.ORG_ADMIN)
  createInvite(@CurrentUser() user: JwtPayload, @Body() dto: CreateInviteDto) {
    return this.orgs.createInvite(orgOf(user), user.sub, dto);
  }

  @Get('invites')
  @Roles(Role.ORG_ADMIN)
  listInvites(
    @CurrentUser() user: JwtPayload,
    @Query('courseId') courseId?: string,
  ) {
    return this.orgs.listInvites(orgOf(user), courseId);
  }

  @Delete('invites/:id')
  @Roles(Role.ORG_ADMIN)
  revokeInvite(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.orgs.revokeInvite(orgOf(user), id);
  }
}

/** Public resolver for the join page. */
@Controller('invites')
export class InvitesController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Public()
  @Get(':token')
  resolve(@Param('token') token: string) {
    return this.orgs.resolveInvite(token);
  }
}
