import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { GradeSubmissionDto } from './dto/grade-submission.dto';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
  ) {}

  /** Instructor (assigned) or org admin creates coursework. */
  async create(user: JwtPayload, courseId: string, dto: CreateAssignmentDto) {
    await this.courses.assertCanManageCourse(user, courseId);
    if (dto.sectionId) {
      const section = await this.prisma.section.findFirst({
        where: { id: dto.sectionId, courseId },
        select: { id: true },
      });
      if (!section) throw new NotFoundException('Section not found in course');
    }
    if (dto.groupId) {
      const group = await this.prisma.studentGroup.findFirst({
        where: { id: dto.groupId, courseId },
        select: { id: true },
      });
      if (!group) throw new NotFoundException('Group not found in course');
    }
    return this.prisma.assignment.create({
      data: {
        courseId,
        sectionId: dto.sectionId,
        groupId: dto.groupId ?? null,
        title: dto.title,
        instructions: dto.instructions,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        maxPoints: dto.maxPoints,
        createdById: user.sub,
      },
    });
  }

  /**
   * Assignments for a course. Anyone with course access sees them; a student
   * also gets their own submission, an instructor/admin the submission count.
   */
  async listForCourse(user: JwtPayload, courseId: string) {
    // getCourseFor enforces org scope + instructor assignment.
    await this.courses.getCourseFor(user, courseId);

    // Students only see whole-class assignments plus those for a group they're in.
    let where: Prisma.AssignmentWhereInput = { courseId };
    if (user.role === Role.STUDENT) {
      where = {
        courseId,
        OR: [
          { groupId: null },
          { group: { members: { some: { studentId: user.sub } } } },
        ],
      };
    }

    const assignments = await this.prisma.assignment.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      include: {
        group: { select: { id: true, name: true } },
        _count: { select: { submissions: true } },
      },
    });

    if (user.role === Role.STUDENT) {
      const mine = await this.prisma.submission.findMany({
        where: {
          studentId: user.sub,
          assignmentId: { in: assignments.map((a) => a.id) },
        },
      });
      const byAssignment = new Map(mine.map((s) => [s.assignmentId, s]));
      return assignments.map((a) => {
        // Drop the manager-only submission count before returning to a student.
        const { _count, ...rest } = a;
        void _count;
        return { ...rest, mySubmission: byAssignment.get(a.id) ?? null };
      });
    }

    return assignments.map(({ _count, ...a }) => ({
      ...a,
      submissionCount: _count.submissions,
    }));
  }

  /** Student submits (or resubmits) — resubmission clears any prior grade. */
  async submit(
    user: JwtPayload,
    assignmentId: string,
    dto: SubmitAssignmentDto,
  ) {
    if (!dto.content?.trim() && !dto.fileUrl?.trim()) {
      throw new BadRequestException('Provide submission text or a file link');
    }
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, courseId: true, groupId: true },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    const enrolled = await this.prisma.enrollment.findUnique({
      where: {
        courseId_studentId: {
          courseId: assignment.courseId,
          studentId: user.sub,
        },
      },
      select: { id: true },
    });
    if (!enrolled) throw new ForbiddenException('Not enrolled in this program');

    // Group-targeted work is only submittable by that group's members.
    if (assignment.groupId) {
      const member = await this.prisma.studentGroupMember.findUnique({
        where: {
          groupId_studentId: {
            groupId: assignment.groupId,
            studentId: user.sub,
          },
        },
        select: { id: true },
      });
      if (!member) {
        throw new ForbiddenException('This assignment is not assigned to you');
      }
    }

    const data = {
      content: dto.content ?? null,
      fileUrl: dto.fileUrl ?? null,
      submittedAt: new Date(),
      grade: null,
      feedback: null,
      gradedById: null,
      gradedAt: null,
    };
    return this.prisma.submission.upsert({
      where: {
        assignmentId_studentId: { assignmentId, studentId: user.sub },
      },
      create: { assignmentId, studentId: user.sub, ...data },
      update: data,
    });
  }

  /** Instructor/admin: the roster of submissions for one assignment. */
  async listSubmissions(user: JwtPayload, assignmentId: string) {
    const assignment = await this.getManageable(user, assignmentId);
    // Denominator is the target audience: the whole class, or the group's size.
    const audience = assignment.groupId
      ? this.prisma.studentGroupMember.count({
          where: { groupId: assignment.groupId },
        })
      : this.prisma.enrollment.count({
          where: { courseId: assignment.courseId },
        });
    const [submissions, enrolled] = await Promise.all([
      this.prisma.submission.findMany({
        where: { assignmentId },
        include: { student: { select: { id: true, name: true, email: true } } },
        orderBy: { submittedAt: 'desc' },
      }),
      audience,
    ]);
    return { assignment, submissions, enrolledCount: enrolled };
  }

  async grade(user: JwtPayload, submissionId: string, dto: GradeSubmissionDto) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: { id: true, assignmentId: true },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    await this.getManageable(user, submission.assignmentId);
    return this.prisma.submission.update({
      where: { id: submissionId },
      data: {
        grade: dto.grade,
        feedback: dto.feedback,
        gradedById: user.sub,
        gradedAt: new Date(),
      },
    });
  }

  /** Loads an assignment and asserts the caller can manage its course. */
  private async getManageable(user: JwtPayload, assignmentId: string) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        course: { select: { title: true } },
        group: { select: { id: true, name: true } },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    await this.courses.assertCanManageCourse(user, assignment.courseId);
    return assignment;
  }
}
