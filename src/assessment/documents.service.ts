import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import { GeminiService } from './gemini.service';
import { DraftDto } from './dto/draft.dto';

const PDF = 'application/pdf';
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly gemini: GeminiService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async upload(
    user: JwtPayload,
    courseId: string,
    file: Express.Multer.File | undefined,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('File is too large (max 15 MB)');
    }

    const text = (await this.extract(file)).trim();
    if (text.length < 20) {
      throw new BadRequestException(
        'Could not read any text from this file — is it a scanned image?',
      );
    }

    const ext = file.mimetype === PDF ? 'pdf' : 'docx';
    const storageKey = `course-docs/${courseId}/${randomUUID()}.${ext}`;
    await this.storage.put(storageKey, file.buffer, file.mimetype);

    return this.prisma.courseDocument.create({
      data: {
        courseId,
        filename: file.originalname,
        storageKey,
        mimeType: file.mimetype,
        charCount: text.length,
        extractedText: text,
        createdById: user.sub,
      },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        charCount: true,
        createdAt: true,
      },
    });
  }

  async list(user: JwtPayload, courseId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    return this.prisma.courseDocument.findMany({
      where: { courseId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        charCount: true,
        createdAt: true,
      },
    });
  }

  async remove(user: JwtPayload, courseId: string, documentId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    const doc = await this.prisma.courseDocument.findFirst({
      where: { id: documentId, courseId },
      select: { id: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.prisma.courseDocument.delete({ where: { id: documentId } });
    return { deleted: true };
  }

  /** Draft questions + tasks for one section, grounded in an uploaded doc. */
  async draft(user: JwtPayload, courseId: string, dto: DraftDto) {
    await this.courses.assertCanManageCourse(user, courseId);
    if (!this.gemini.enabled) {
      throw new BadRequestException('AI drafting is not configured');
    }

    const [doc, section, course] = await Promise.all([
      this.prisma.courseDocument.findFirst({
        where: { id: dto.documentId, courseId },
        select: { extractedText: true },
      }),
      this.prisma.section.findFirst({
        where: { id: dto.sectionId, courseId },
        select: { title: true },
      }),
      this.prisma.course.findUnique({
        where: { id: courseId },
        select: { title: true },
      }),
    ]);
    if (!doc) throw new NotFoundException('Document not found');
    if (!section) throw new NotFoundException('Section not found in course');

    const questionCount = Math.min(Math.max(dto.count ?? 5, 1), 15);
    const result = await this.gemini.draftAssessment(
      {
        courseTitle: course?.title ?? 'this course',
        sectionTitle: section.title,
        sourceText: doc.extractedText,
        questionCount,
        taskCount: Math.min(questionCount, 3),
      },
      { orgId: user.organizationId, userId: user.sub, refId: courseId },
    );
    return { sectionId: dto.sectionId, ...result };
  }

  private async extract(file: Express.Multer.File): Promise<string> {
    if (file.mimetype === PDF) {
      const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
      try {
        const { text } = await parser.getText();
        return text;
      } finally {
        await parser.destroy();
      }
    }
    if (file.mimetype === DOCX) {
      const { value } = await mammoth.extractRawText({ buffer: file.buffer });
      return value;
    }
    throw new BadRequestException('Upload a PDF or Word (.docx) file');
  }
}
