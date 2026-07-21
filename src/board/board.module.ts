import { Module } from '@nestjs/common';
import { BoardDocService } from './board-doc.service';
import { BoardGateway } from './board.gateway';

@Module({
  providers: [BoardGateway, BoardDocService],
})
export class BoardModule {}
