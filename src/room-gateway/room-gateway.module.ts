import { Module } from '@nestjs/common';
import { PointsModule } from '../points/points.module';
import { SessionsModule } from '../sessions/sessions.module';
import { RoomGateway } from './room.gateway';
import { RoomStateService } from './room-state.service';

@Module({
  imports: [PointsModule, SessionsModule],
  providers: [RoomGateway, RoomStateService],
})
export class RoomGatewayModule {}
