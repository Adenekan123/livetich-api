import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { PointsModule } from '../points/points.module';
import { AssessmentController } from './assessment.controller';
import { AssessmentService } from './assessment.service';
import { DocumentsService } from './documents.service';
import { GeminiService } from './gemini.service';

@Module({
  imports: [CoursesModule, PointsModule],
  controllers: [AssessmentController],
  providers: [AssessmentService, DocumentsService, GeminiService],
  exports: [AssessmentService],
})
export class AssessmentModule {}
