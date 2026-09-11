import { Module } from '@nestjs/common';
import { LivekitWebhookController } from './livekit-webhook.controller';
import { RecordingEgressService } from './recording-egress.service';
import { RecordingsController } from './recordings.controller';
import { RecordingsReconciler } from './recordings-reconciler.service';
import { RecordingsService } from './recordings.service';

@Module({
  controllers: [RecordingsController, LivekitWebhookController],
  providers: [RecordingsService, RecordingEgressService, RecordingsReconciler],
  exports: [RecordingsService],
})
export class RecordingsModule {}
