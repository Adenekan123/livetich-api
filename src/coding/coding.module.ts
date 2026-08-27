import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { CodingController } from './coding.controller';
import { CodingService } from './coding.service';
import { CodingSubmissionsService } from './coding-submissions.service';
import { CodingAiReviewService } from './coding-ai-review.service';
import { CodingInstructorService } from './coding-instructor.service';

/**
 * Coding Instructor Plugin. Covers assignment authoring & delivery, the ZIP
 * submission pipeline, the Claude AI review, and the instructor dashboard /
 * feedback / decision flow. Object storage is a global provider.
 */
@Module({
  imports: [CoursesModule],
  controllers: [CodingController],
  providers: [
    CodingService,
    CodingSubmissionsService,
    CodingAiReviewService,
    CodingInstructorService,
  ],
  exports: [
    CodingService,
    CodingSubmissionsService,
    CodingAiReviewService,
    CodingInstructorService,
  ],
})
export class CodingModule {}
