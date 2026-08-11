import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { HifzController } from './hifz.controller';
import { HifzService } from './hifz.service';

@Module({
  imports: [CoursesModule],
  controllers: [HifzController],
  providers: [HifzService],
  exports: [HifzService],
})
export class HifzModule {}
