import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { RemindersService } from './reminders.service';

/** Pre-class email reminders (cron). ScheduleModule is initialised in AppModule. */
@Module({
  imports: [MailModule],
  providers: [RemindersService],
})
export class RemindersModule {}
