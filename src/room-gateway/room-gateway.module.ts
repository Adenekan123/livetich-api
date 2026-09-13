import { Module } from '@nestjs/common';
import { PointsModule } from '../points/points.module';
import { SessionsModule } from '../sessions/sessions.module';
import { RoomGateway } from './room.gateway';
import { RoomStateService } from './room-state.service';

@Module({
  imports: [PointsModule, SessionsModule],
  providers: [RoomGateway, RoomStateService],
  // The recorder asks which surface the class is on before it renders, so it
  // never opens a recording on the wrong one.
  exports: [RoomStateService],
})
export class RoomGatewayModule {}
