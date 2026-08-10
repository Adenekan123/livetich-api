import { Injectable, NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { SetMembersDto } from './dto/set-members.dto';

/**
 * Named subsets of a course's students, used to target assignments/tasks at a
 * slice of the class instead of everyone. A student may be in many groups.
 * All mutations require course-manage rights (assigned instructor or org admin).
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
  ) {}

  private static readonly memberInclude = {
    members: {
      include: {
        student: { select: { id: true, name: true, email: true } },
      },
      orderBy: { student: { name: 'asc' } },
    },
    _count: { select: { members: true, assignments: true } },
  } as const;

  /** Every group in a course, each with its members and usage counts. */
  async listForCourse(user: JwtPayload, courseId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    return this.prisma.studentGroup.findMany({
      where: { courseId },
      include: GroupsService.memberInclude,
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(user: JwtPayload, courseId: string, dto: CreateGroupDto) {
    await this.courses.assertCanManageCourse(user, courseId);
    return this.prisma.studentGroup.create({
      data: { courseId, name: dto.name.trim() },
      include: GroupsService.memberInclude,
    });
  }

  async rename(
    user: JwtPayload,
    courseId: string,
    groupId: string,
    dto: CreateGroupDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertGroupInCourse(groupId, courseId);
    return this.prisma.studentGroup.update({
      where: { id: groupId },
      data: { name: dto.name.trim() },
      include: GroupsService.memberInclude,
    });
  }

  /** Deletes a group; any assignments targeting it revert to whole-class. */
  async remove(user: JwtPayload, courseId: string, groupId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertGroupInCourse(groupId, courseId);
    await this.prisma.$transaction([
      this.prisma.assignment.updateMany({
        where: { groupId },
        data: { groupId: null },
      }),
      // members cascade on the group delete (onDelete: Cascade).
      this.prisma.studentGroup.delete({ where: { id: groupId } }),
    ]);
    return { deleted: true };
  }

  /**
   * Replaces a group's membership wholesale. Silently drops ids that aren't
   * enrolled in the course, so a stale roster in the UI can't corrupt the group.
   */
  async setMembers(
    user: JwtPayload,
    courseId: string,
    groupId: string,
    dto: SetMembersDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertGroupInCourse(groupId, courseId);

    const enrolled = await this.prisma.enrollment.findMany({
      where: { courseId, studentId: { in: dto.studentIds } },
      select: { studentId: true },
    });
    const valid = enrolled.map((e) => e.studentId);

    await this.prisma.$transaction([
      this.prisma.studentGroupMember.deleteMany({ where: { groupId } }),
      ...(valid.length
        ? [
            this.prisma.studentGroupMember.createMany({
              data: valid.map((studentId) => ({ groupId, studentId })),
            }),
          ]
        : []),
    ]);

    return this.prisma.studentGroup.findUniqueOrThrow({
      where: { id: groupId },
      include: GroupsService.memberInclude,
    });
  }

  private async assertGroupInCourse(groupId: string, courseId: string) {
    const group = await this.prisma.studentGroup.findFirst({
      where: { id: groupId, courseId },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found in this course');
  }
}
