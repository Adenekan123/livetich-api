import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { PointsModule } from '../points/points.module';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [CoursesModule, PointsModule, MailModule],
  controllers: [AssignmentsController],
  providers: [AssignmentsService],
})
export class AssignmentsModule {}
