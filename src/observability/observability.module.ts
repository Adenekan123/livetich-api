import { Global, Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { AuditService } from './audit.service';
import { AiUsageService } from './ai-usage.service';

/**
 * Cross-cutting observability: the audit trail writer and AI-usage meter.
 * Global so any feature module can inject them without an import, and it depends
 * only on the (global) PrismaService — so it introduces no module cycles.
 */
@Global()
@Module({
  imports: [MailModule],
  providers: [AuditService, AiUsageService],
  exports: [AuditService, AiUsageService],
})
export class ObservabilityModule {}
