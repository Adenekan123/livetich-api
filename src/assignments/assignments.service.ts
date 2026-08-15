import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { GradeSubmissionDto } from './dto/grade-submission.dto';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';
import { RoomBroadcaster } from '../realtime/room-broadcaster';

/** What students may attach: recitation audio, plus images and PDFs. */
const ALLOWED_UPLOAD_PREFIXES = ['audio/', 'image/'];
const ALLOWED_UPLOAD_EXACT = ['application/pdf'];
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly broadcaster: RoomBroadcaster,
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
    if (dto.sessionId) {
      const session = await this.prisma.liveSession.findFirst({
        where: { id: dto.sessionId, courseId },
        select: { id: true },
      });
      if (!session) throw new NotFoundException('Session not found in course');
    }
    return this.prisma.assignment.create({
      data: {
        courseId,
        sectionId: dto.sectionId,
        sessionId: dto.sessionId ?? null,
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
        session: { select: { id: true, scheduledAt: true, status: true } },
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

  /**
   * Manager dashboard feed: every assignment with its target audience split
   * into who has submitted (with their submission + grade) and who is missing.
   * Powers the Assignment Lab's progress bars, inline grading and roster gaps.
   */
  async courseTracking(user: JwtPayload, courseId: string) {
    await this.courses.assertCanManageCourse(user, courseId);

    const studentSelect = { id: true, name: true, email: true } as const;
    const [assignments, enrollments] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { courseId },
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
        include: {
          group: {
            select: {
              id: true,
              name: true,
              members: { select: { student: { select: studentSelect } } },
            },
          },
          session: { select: { id: true, scheduledAt: true, status: true } },
          submissions: {
            include: { student: { select: studentSelect } },
            orderBy: { submittedAt: 'desc' },
          },
        },
      }),
      this.prisma.enrollment.findMany({
        where: { courseId },
        select: { student: { select: studentSelect } },
        orderBy: { student: { name: 'asc' } },
      }),
    ]);

    const classRoster = enrollments.map((e) => e.student);

    return assignments.map(({ submissions, group, ...meta }) => {
      const audience = group ? group.members.map((m) => m.student) : classRoster;
      const audienceIds = new Set(audience.map((s) => s.id));

      // Only submissions from students still in the target audience count.
      const submitted = submissions
        .filter((s) => audienceIds.has(s.studentId))
        .map((s) => ({
          submissionId: s.id,
          student: s.student,
          content: s.content,
          language: s.language,
          fileUrl: s.fileUrl,
          fileMimeType: s.fileMimeType,
          submittedAt: s.submittedAt,
          grade: s.grade,
          feedback: s.feedback,
        }));
      const submittedIds = new Set(submitted.map((s) => s.student.id));
      const missing = audience.filter((s) => !submittedIds.has(s.id));

      return {
        ...meta,
        group: group ? { id: group.id, name: group.name } : null,
        audienceCount: audience.length,
        submittedCount: submitted.length,
        gradedCount: submitted.filter((s) => s.grade != null).length,
        submitted,
        missing,
      };
    });
  }

  /**
   * The signed-in student's assignments across their enrolled courses —
   * whole-class ones plus any targeting a group they belong to — with a flag
   * for whether they've already submitted. Powers the VSCode extension picker.
   */
  async mine(user: JwtPayload) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId: user.sub },
      select: { courseId: true },
    });
    const courseIds = enrollments.map((e) => e.courseId);
    if (courseIds.length === 0) return [];

    const assignments = await this.prisma.assignment.findMany({
      where: {
        courseId: { in: courseIds },
        OR: [
          { groupId: null },
          { group: { members: { some: { studentId: user.sub } } } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        course: { select: { title: true } },
        session: { select: { id: true, status: true } },
        submissions: { where: { studentId: user.sub }, select: { id: true } },
      },
    });

    return assignments.map((a) => ({
      id: a.id,
      title: a.title,
      courseTitle: a.course.title,
      sessionId: a.sessionId,
      sessionLive: a.session?.status === 'LIVE',
      dueAt: a.dueAt,
      submitted: a.submissions.length > 0,
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
    await this.assertCanSubmit(user, assignmentId);

    const data = {
      content: dto.content ?? null,
      language: dto.language ?? null,
      fileUrl: dto.fileUrl ?? null,
      fileMimeType: null,
      submittedAt: new Date(),
      grade: null,
      feedback: null,
      gradedById: null,
      gradedAt: null,
    };
    const submission = await this.prisma.submission.upsert({
      where: {
        assignmentId_studentId: { assignmentId, studentId: user.sub },
      },
      create: { assignmentId, studentId: user.sub, ...data },
      update: data,
    });

    // Real-time: if this coursework is tied to a live session, push the new
    // submission to that session's instructor panel (staff-only room).
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { sessionId: true, title: true },
    });
    if (assignment?.sessionId) {
      this.broadcaster.emitToSessionStaff(assignment.sessionId, 'submission:new', {
        sessionId: assignment.sessionId,
        submissionId: submission.id,
        assignmentId,
        assignmentTitle: assignment.title,
        studentId: user.sub,
        studentName: user.name,
        language: submission.language ?? null,
        submittedAt: submission.submittedAt.toISOString(),
      });
    }
    return submission;
  }

  /**
   * Student uploads a blob (recitation audio, image or PDF) as their
   * submission. Stored in object storage under a per-submission key; the
   * served URL is proxied by the web app so playback stays authenticated.
   */
  async uploadSubmission(
    user: JwtPayload,
    assignmentId: string,
    file?: { buffer: Buffer; mimetype: string; size: number },
  ) {
    if (!file) throw new BadRequestException('No file received');
    const mime = file.mimetype;
    const allowed =
      ALLOWED_UPLOAD_PREFIXES.some((p) => mime.startsWith(p)) ||
      ALLOWED_UPLOAD_EXACT.includes(mime);
    if (!allowed) {
      throw new BadRequestException(`Unsupported file type: ${mime}`);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('File is larger than 30 MB');
    }
    await this.assertCanSubmit(user, assignmentId);

    // Upsert first to obtain a stable id, then store the blob under it.
    const base = {
      content: null,
      submittedAt: new Date(),
      grade: null,
      feedback: null,
      gradedById: null,
      gradedAt: null,
      fileMimeType: mime,
    };
    const submission = await this.prisma.submission.upsert({
      where: {
        assignmentId_studentId: { assignmentId, studentId: user.sub },
      },
      create: { assignmentId, studentId: user.sub, fileUrl: '', ...base },
      update: { fileUrl: '', ...base },
    });

    await this.storage.put(submissionKey(submission.id), file.buffer, mime);

    return this.prisma.submission.update({
      where: { id: submission.id },
      data: { fileUrl: `/api/files/submission/${submission.id}` },
    });
  }

  /** Streams a submission's uploaded blob to its owner or a course manager. */
  async streamSubmissionFile(user: JwtPayload, submissionId: string) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        studentId: true,
        fileMimeType: true,
        assignment: { select: { courseId: true } },
      },
    });
    if (!submission || !submission.fileMimeType) {
      throw new NotFoundException('No uploaded file for this submission');
    }
    if (submission.studentId !== user.sub) {
      // Not the owner — must be able to manage the course.
      await this.courses.assertCanManageCourse(
        user,
        submission.assignment.courseId,
      );
    }
    const stream = await this.storage.getStream(submissionKey(submission.id));
    if (!stream) throw new NotFoundException('File not found');
    return { stream, mime: submission.fileMimeType };
  }

  /** Shared submission gate: enrolled, and (for group work) a group member. */
  private async assertCanSubmit(user: JwtPayload, assignmentId: string) {
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
    return assignment;
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

/** Object-storage key for a submission's uploaded blob (extension-agnostic;
 *  the MIME type is stored on the row and set as the content type on serve). */
function submissionKey(submissionId: string): string {
  return `submissions/${submissionId}`;
}
