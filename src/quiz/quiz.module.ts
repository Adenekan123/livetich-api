import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { PointsModule } from '../points/points.module';
import { QuizController } from './quiz.controller';
import { QuizService } from './quiz.service';

@Module({
  imports: [CoursesModule, PointsModule],
  controllers: [QuizController],
  providers: [QuizService],
  exports: [QuizService],
})
export class QuizModule {}
