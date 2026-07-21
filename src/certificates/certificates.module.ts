import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CertificateStorage } from './certificate-storage';
import { CERTIFICATES_QUEUE } from './certificates.constants';
import { CertificatesController } from './certificates.controller';
import { CertificatesProcessor } from './certificates.processor';
import { CertificatesService } from './certificates.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: CERTIFICATES_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
  ],
  controllers: [CertificatesController],
  providers: [CertificatesService, CertificatesProcessor, CertificateStorage],
})
export class CertificatesModule {}
