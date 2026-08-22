import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Invite, Prisma, Role, UserStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthCacheService } from '../auth/auth-cache.service';
import { aggregateStudentStats } from '../performance/student-stats';
import { CreateInviteDto } from './dto/create-invite.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

export type InviteStatus = 'ACTIVE' | 'EXPIRED' | 'USED_UP' | 'REVOKED';

/** Public brand kit fields — safe to expose on the join page. */
const BRAND_SELECT = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  primaryColor: true,
  accentColor: true,
  tagline: true,
} as const;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authCache: AuthCacheService,
  ) {}

  getMine(orgId: string | null) {
    if (!orgId) return null;
    return this.prisma.organization.findUnique({
      where: { id: orgId },
      select: BRAND_SELECT,
    });
  }

  updateBrand(orgId: string, dto: UpdateBrandDto) {
    return this.prisma.organization.update({
      where: { id: orgId },
      data: dto,
      select: BRAND_SELECT,
    });
  }

  async createInvite(orgId: string, userId: string, dto: CreateInviteDto) {
    if (dto.role !== Role.STUDENT && dto.role !== Role.INSTRUCTOR) {
      throw new BadRequestException('Invite role must be STUDENT or INSTRUCTOR');
    }
    // A course-scoped link must point at a program this org actually owns.
    if (dto.courseId) {
      const course = await this.prisma.course.findFirst({
        where: { id: dto.courseId, organizationId: orgId },
        select: { id: true },
      });
      if (!course) throw new NotFoundException('Program not found');
    }
    return this.prisma.invite.create({
      data: {
        organizationId: orgId,
        createdById: userId,
        role: dto.role,
        courseId: dto.courseId,
        label: dto.label,
        maxUses: dto.maxUses,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        token: randomBytes(16).toString('hex'),
      },
    });
  }

  async listInvites(orgId: string, courseId?: string) {
    const invites = await this.prisma.invite.findMany({
      where: {
        organizationId: orgId,
        revokedAt: null,
        // `null` narrows to workspace-level links; a value scopes to one program.
        ...(courseId !== undefined && { courseId: courseId || null }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return invites.map((i) => ({ ...i, status: this.statusOf(i) }));
  }

  async revokeInvite(orgId: string, id: string) {
    const invite = await this.prisma.invite.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    return this.prisma.invite.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /** Public: resolve a join link into the org brand + role, or {valid:false}. */
  async resolveInvite(token: string) {
    const invite = await this.prisma.invite.findUnique({
      where: { token },
      include: {
        organization: { select: BRAND_SELECT },
        course: { select: { id: true, title: true } },
      },
    });
    if (!invite || this.statusOf(invite) !== 'ACTIVE') return { valid: false };
    return {
      valid: true,
      role: invite.role,
      organization: invite.organization,
      course: invite.course,
    };
  }

  listMembers(orgId: string, role: Role) {
    return this.prisma.user.findMany({
      where: { organizationId: orgId, role },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Admin enables/disables a member of their org. Admins and users outside the
   *  org can't be targeted. Disabling ends the member's active session. */
  async setMemberStatus(orgId: string, memberId: string, status: UserStatus) {
    const member = await this.prisma.user.findFirst({
      where: { id: memberId, organizationId: orgId },
      select: { id: true, role: true },
    });
    if (!member) throw new NotFoundException('Member not found in your organization');
    if (member.role === Role.ORG_ADMIN) {
      throw new BadRequestException('Admin accounts cannot be disabled here');
    }
    await this.prisma.user.update({
      where: { id: memberId },
      data: { status },
    });
    // Drop the cached auth state so the change takes effect on the next request.
    await this.authCache.invalidate(memberId);
    return { id: memberId, status };
  }

  /** Students with performance metrics, optionally scoped to one program. */
  async studentStats(orgId: string, courseId?: string) {
    const courseWhere: Prisma.CourseWhereInput = courseId
      ? { id: courseId, organizationId: orgId }
      : { organizationId: orgId };

    const students = await this.prisma.user.findMany({
      where: {
        organizationId: orgId,
        role: Role.STUDENT,
        ...(courseId && { enrollments: { some: { courseId } } }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        enrollments: { select: { courseId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const withEnrollments = students.map((s) => ({
      id: s.id,
      enrolledCourseIds: s.enrollments.map((e) => e.courseId),
    }));
    const stats = await aggregateStudentStats(
      this.prisma,
      withEnrollments,
      courseWhere,
    );

    return students.map((s, i) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      status: s.status,
      enrolledCourseIds: withEnrollments[i].enrolledCourseIds,
      ...stats.get(s.id)!,
    }));
  }

  private statusOf(i: Invite): InviteStatus {
    if (i.revokedAt) return 'REVOKED';
    if (i.expiresAt && i.expiresAt.getTime() < Date.now()) return 'EXPIRED';
    if (i.maxUses !== null && i.uses >= i.maxUses) return 'USED_UP';
    return 'ACTIVE';
  }
}
