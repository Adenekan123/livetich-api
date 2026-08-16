import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { AlocService } from './aloc.service';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';

@Module({
  imports: [CoursesModule],
  controllers: [ExamsController],
  providers: [ExamsService, AlocService],
})
export class ExamsModule {}
