import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CodingAssignmentStatus } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import { CodingLiveService } from './coding-live.service';
import {
  indexArchive,
  MAX_ARCHIVE_BYTES,
  readOneTextFile,
  readTextFiles,
  type ArchiveTextFile,
} from './coding-archive.util';

/** Multer memory-storage file (subset). */
interface UploadedBlob {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

const ZIP_MIMES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'multipart/x-zip',
  'application/octet-stream', // some browsers send this for .zip
]);

/** Budget of source text sent to a single AI review (keeps token cost bounded). */
export const AI_TEXT_BUDGET_BYTES = 220 * 1024;

/**
 * Coding Instructor Plugin — the submission pipeline: a student uploads a
 * project .zip, we store it immutably, index its files, and record a new
 * attempt. Files are read back on demand from the stored archive (the DB keeps
 * metadata only, per the storage design).
 */
@Injectable()
export class CodingSubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly live: CodingLiveService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** Student submits (or resubmits) a project archive as a new attempt. */
  async submit(user: JwtPayload, assignmentId: string, file?: UploadedBlob) {
    if (!file) throw new BadRequestException('No file received');
    const isZip =
      ZIP_MIMES.has(file.mimetype) || /\.zip$/i.test(file.originalname ?? '');
    if (!isZip) {
      throw new BadRequestException('Upload a .zip project archive');
    }
    if (file.size > MAX_ARCHIVE_BYTES) {
      throw new BadRequestException('Archive is larger than 25 MB');
    }

    const assignment = await this.prisma.codingAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        courseId: true,
        sessionId: true,
        title: true,
        status: true,
        maxAttempts: true,
        allowResubmit: true,
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    if (assignment.status === CodingAssignmentStatus.DRAFT) {
      throw new BadRequestException('This assignment is not open yet');
    }
    if (assignment.status === CodingAssignmentStatus.CLOSED) {
      throw new BadRequestException('This assignment is closed');
    }

    await this.assertEnrolled(user.sub, assignment.courseId);

    const priorCount = await this.prisma.codingSubmission.count({
      where: { assignmentId, studentId: user.sub },
    });
    if (priorCount >= 1 && !assignment.allowResubmit) {
      throw new ForbiddenException('Resubmission is not allowed for this task');
    }
    if (priorCount >= assignment.maxAttempts) {
      throw new ForbiddenException('No attempts remaining');
    }

    // Index the archive in memory (throws on invalid/oversized/empty zips).
    const index = indexArchive(file.buffer);
    const hash = createHash('sha256').update(file.buffer).digest('hex');
    const attemptNumber = priorCount + 1;

    const submission = await this.prisma.codingSubmission.create({
      data: {
        assignmentId,
        studentId: user.sub,
        attemptNumber,
        archiveHash: hash,
        files: {
          create: index.files.map((f) => ({
            path: f.path,
            size: f.size,
            language: f.language,
          })),
        },
      },
    });

    // Store the immutable archive, then point the row at its served URL.
    await this.storage.put(archiveKey(submission.id), file.buffer, 'application/zip');
    const withUrl = await this.prisma.codingSubmission.update({
      where: { id: submission.id },
      data: { archiveUrl: `/api/coding/files/archive/${submission.id}` },
      include: { files: { orderBy: { path: 'asc' } } },
    });

    // Move the student from "coding" to "submitted" on the live board, and
    // surface the new attempt on the instructor's in-room review card.
    await this.live.broadcastSubmissionUpdate(withUrl.id);

    return { submission: withUrl, sessionId: assignment.sessionId };
  }

  /** Full submission detail — owner or course manager. Students see only
   *  student-visible feedback; managers see everything. */
  async getSubmission(user: JwtPayload, submissionId: string) {
    const { isOwner } = await this.assertAccess(user, submissionId);
    return this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      include: {
        files: { orderBy: { path: 'asc' } },
        student: { select: { id: true, name: true, email: true } },
        assignment: {
          include: {
            requirements: { orderBy: { order: 'asc' } },
            rubric: { orderBy: { order: 'asc' } },
          },
        },
        reviews: {
          orderBy: { createdAt: 'desc' },
          include: { findings: true, results: true },
        },
        feedback: {
          where: isOwner ? { visibleToStudent: true } : undefined,
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  /** Stream the stored archive for download (owner or manager). */
  async streamArchive(user: JwtPayload, submissionId: string) {
    await this.assertAccess(user, submissionId);
    const stream = await this.storage.getStream(archiveKey(submissionId));
    if (!stream) throw new NotFoundException('Archive not found');
    return stream;
  }

  /** One file's text content from the stored archive (review viewer). */
  async getFileContent(user: JwtPayload, submissionId: string, path: string) {
    await this.assertAccess(user, submissionId);
    const buffer = await this.storage.get(archiveKey(submissionId));
    if (!buffer) throw new NotFoundException('Archive not found');
    const file = readOneTextFile(buffer, path);
    if (!file) throw new NotFoundException('File not found or not readable');
    return file;
  }

  /** All readable source text for one submission — used by the AI reviewer.
   *  Internal (no auth): callers are trusted server-side services. */
  async readSubmissionText(
    submissionId: string,
    maxTotalBytes = AI_TEXT_BUDGET_BYTES,
  ): Promise<ArchiveTextFile[]> {
    const buffer = await this.storage.get(archiveKey(submissionId));
    if (!buffer) return [];
    return readTextFiles(buffer, { maxTotalBytes });
  }

  // ---------- Helpers ----------

  /** Loads a submission and asserts the caller is its owner or a course
   *  manager. Returns the submission with its owning course id. */
  private async assertAccess(user: JwtPayload, submissionId: string) {
    const submission = await this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        studentId: true,
        assignment: { select: { courseId: true } },
      },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    const isOwner = submission.studentId === user.sub;
    if (!isOwner) {
      await this.courses.assertCanManageCourse(
        user,
        submission.assignment.courseId,
      );
    }
    return { submission, isOwner };
  }

  private async assertEnrolled(studentId: string, courseId: string) {
    const enrolled = await this.prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId, studentId } },
      select: { id: true },
    });
    if (!enrolled) throw new ForbiddenException('Not enrolled in this program');
  }
}

/** Object-storage key for a submission's immutable project archive. */
function archiveKey(submissionId: string): string {
  return `coding/submissions/${submissionId}.zip`;
}
