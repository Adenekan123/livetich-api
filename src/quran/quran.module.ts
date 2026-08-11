import { Module } from '@nestjs/common';
import { QuranController } from './quran.controller';

@Module({
  controllers: [QuranController],
})
export class QuranModule {}
