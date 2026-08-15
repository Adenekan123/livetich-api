import { Module } from '@nestjs/common';
import { CodeDocService } from './code-doc.service';
import { CodeGateway } from './code.gateway';

@Module({
  providers: [CodeGateway, CodeDocService],
})
export class CodeModule {}
