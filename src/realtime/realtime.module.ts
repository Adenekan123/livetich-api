import { Global, Module } from '@nestjs/common';
import { RoomBroadcaster } from './room-broadcaster';

/** Global so the RoomGateway (binds the server) and any HTTP service (emits)
 *  share one RoomBroadcaster without import wiring. */
@Global()
@Module({
  providers: [RoomBroadcaster],
  exports: [RoomBroadcaster],
})
export class RealtimeModule {}
