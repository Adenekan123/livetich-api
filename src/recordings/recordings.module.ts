import { Module } from '@nestjs/common';
import { RoomGatewayModule } from '../room-gateway/room-gateway.module';
import { SessionsModule } from '../sessions/sessions.module';
import { LivekitWebhookController } from './livekit-webhook.controller';
import { RecordingEgressService } from './recording-egress.service';
import { RecordingsController } from './recordings.controller';
import { RecordingsReconciler } from './recordings-reconciler.service';
import { RecorderTokenService } from './recorder-token.service';
import { RecordingsService } from './recordings.service';

@Module({
  // LivekitService mints the recorder's hidden join token. Sessions does not
  // import this module back, so there is no cycle.
  imports: [SessionsModule, RoomGatewayModule],
  controllers: [RecordingsController, LivekitWebhookController],
  providers: [
    RecordingsService,
    RecordingEgressService,
    RecordingsReconciler,
    RecorderTokenService,
  ],
  exports: [RecordingsService],
})
export class RecordingsModule {}
