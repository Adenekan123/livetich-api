import { Module } from '@nestjs/common';
import { AssessmentModule } from '../assessment/assessment.module';
import { CoursesModule } from '../courses/courses.module';
import { LivekitService } from './livekit.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { VoiceController } from './voice.controller';

@Module({
  imports: [CoursesModule, AssessmentModule],
  controllers: [SessionsController, VoiceController],
  providers: [SessionsService, LivekitService],
  exports: [SessionsService, LivekitService],
})
export class SessionsModule {}
