import { Module } from '@nestjs/common';
import { LivekitWebhookController } from './livekit-webhook.controller';
import { RecordingEgressService } from './recording-egress.service';
import { RecordingsController } from './recordings.controller';
import { RecordingsService } from './recordings.service';

@Module({
  controllers: [RecordingsController, LivekitWebhookController],
  providers: [RecordingsService, RecordingEgressService],
  exports: [RecordingsService],
})
export class RecordingsModule {}
