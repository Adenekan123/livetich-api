import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import type { JwtPayload } from '../auth/jwt-payload';
import { PrismaService } from '../prisma/prisma.service';
import {
  CERTIFICATES_QUEUE,
  GenerateCertificateJob,
} from './certificates.constants';
import { IssueCertificateDto } from './dto/issue-certificate.dto';

@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(CERTIFICATES_QUEUE)
    private readonly queue: Queue<GenerateCertificateJob>,
  ) {}

  /** Org admin issues a certificate; the PDF is rendered async by the worker. */
  async issue(user: JwtPayload, dto: IssueCertificateDto) {
    await this.assertOrgCourse(user, dto.courseId);

    const enrollment = await this.prisma.enrollment.findUnique({
      where: {
        courseId_studentId: { courseId: dto.courseId, studentId: dto.studentId },
      },
    });
    if (!enrollment) {
      throw new NotFoundException('Student is not enrolled in this course');
    }

    let certificate;
    try {
      certificate = await this.prisma.certificate.create({
        data: {
          courseId: dto.courseId,
          studentId: dto.studentId,
          issuedById: user.sub,
          verificationCode: randomBytes(9).toString('base64url'),
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'A certificate was already issued to this student for this course',
        );
      }
      throw e;
    }

    await this.queue.add('generate', { certificateId: certificate.id });
    return certificate;
  }

  listMine(studentId: string) {
    return this.prisma.certificate.findMany({
      where: { studentId },
      include: { course: { select: { id: true, title: true } } },
      orderBy: { issuedAt: 'desc' },
    });
  }

  async listForCourse(user: JwtPayload, courseId: string) {
    await this.assertOrgCourse(user, courseId);
    return this.prisma.certificate.findMany({
      where: { courseId },
      include: { student: { select: { id: true, name: true, email: true } } },
      orderBy: { issuedAt: 'desc' },
    });
  }

  /** Public QR target — anyone with the code can confirm authenticity. */
  async verify(code: string) {
    const cert = await this.prisma.certificate.findUnique({
      where: { verificationCode: code },
      include: {
        student: { select: { name: true } },
        course: {
          select: {
            title: true,
            instructor: { select: { name: true } },
          },
        },
      },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    return {
      valid: true,
      verificationCode: cert.verificationCode,
      student: cert.student.name,
      course: cert.course.title,
      instructor: cert.course.instructor?.name ?? 'Course instructor',
      issuedAt: cert.issuedAt,
    };
  }

  /** The certificate's owner or the course instructor may download the PDF. */
  async getForDownload(userId: string, certificateId: string) {
    const cert = await this.prisma.certificate.findUnique({
      where: { id: certificateId },
      include: { course: { select: { instructorId: true, title: true } } },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    if (cert.studentId !== userId && cert.course.instructorId !== userId) {
      throw new ForbiddenException('Not your certificate');
    }
    if (!cert.pdfUrl) {
      throw new NotFoundException('PDF not generated yet — try again shortly');
    }
    return cert;
  }

  /** Ensures the course exists and belongs to the caller's organization. */
  private async assertOrgCourse(user: JwtPayload, courseId: string) {
    if (!user.organizationId) {
      throw new ForbiddenException('No organization on this account');
    }
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { organizationId: true },
    });
    if (!course || course.organizationId !== user.organizationId) {
      throw new NotFoundException('Course not found');
    }
  }
}
