import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { TajweedController } from './tajweed.controller';
import { TajweedService } from './tajweed.service';

@Module({
  imports: [CoursesModule],
  controllers: [TajweedController],
  providers: [TajweedService],
  exports: [TajweedService],
})
export class TajweedModule {}
