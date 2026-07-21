import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { renderCertificatePdf } from './certificate-pdf';
import { CertificateStorage } from './certificate-storage';
import {
  CERTIFICATES_QUEUE,
  GenerateCertificateJob,
} from './certificates.constants';

@Processor(CERTIFICATES_QUEUE)
export class CertificatesProcessor extends WorkerHost {
  private readonly logger = new Logger(CertificatesProcessor.name);
  private readonly verifyBase: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CertificateStorage,
    config: ConfigService,
  ) {
    super();
    this.verifyBase =
      config.get<string>('CERT_VERIFY_BASE') ??
      'http://localhost:3000/certificates/verify';
  }

  async process(job: Job<GenerateCertificateJob>): Promise<void> {
    const cert = await this.prisma.certificate.findUnique({
      where: { id: job.data.certificateId },
      include: {
        student: { select: { name: true } },
        course: {
          select: { title: true, instructor: { select: { name: true } } },
        },
      },
    });
    if (!cert) {
      this.logger.warn(`Certificate ${job.data.certificateId} vanished — skipping`);
      return;
    }

    const pdf = await renderCertificatePdf({
      studentName: cert.student.name,
      courseTitle: cert.course.title,
      instructorName: cert.course.instructor.name,
      issuedAt: cert.issuedAt,
      verificationCode: cert.verificationCode,
      verifyUrl: `${this.verifyBase}/${cert.verificationCode}`,
    });
    await this.storage.write(cert.id, pdf);

    await this.prisma.certificate.update({
      where: { id: cert.id },
      data: { pdfUrl: `/certificates/${cert.id}/download` },
    });
    this.logger.log(`Certificate ${cert.id} PDF generated`);
  }
}
