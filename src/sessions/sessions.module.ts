import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { LivekitService } from './livekit.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [CoursesModule],
  controllers: [SessionsController],
  providers: [SessionsService, LivekitService],
  exports: [SessionsService, LivekitService],
})
export class SessionsModule {}
