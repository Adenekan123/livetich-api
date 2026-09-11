import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { EgressStatus, WebhookReceiver } from 'livekit-server-sdk';
import { Public } from '../auth/jwt-auth.guard';
import { RecordingsService } from './recordings.service';

/**
 * LiveKit's callbacks.
 *
 * A recording finishes asynchronously: stopping the egress only asks LiveKit to
 * wrap up, and the file lands in R2 some seconds later. This is how we learn it
 * is there, how big it is, and whether it failed — without it a recording would
 * sit in PROCESSING forever and never count against the workspace's quota.
 *
 * Unauthenticated in the usual sense: the caller is LiveKit, not a user. The
 * signature over the raw body is the credential, which is why `rawBody` is
 * enabled in bootstrap — re-serialising the parsed object would not verify.
 */
@Controller('webhooks')
export class LivekitWebhookController {
  private readonly logger = new Logger(LivekitWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly recordings: RecordingsService,
  ) {}

  @Public()
  // Generous, but bounded: LiveKit retries, and a loop here would be expensive.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(200)
  @Post('livekit')
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('authorization') authorization?: string,
  ) {
    const key = this.config.get<string>('LIVEKIT_API_KEY');
    const secret = this.config.get<string>('LIVEKIT_API_SECRET');
    if (!key || !secret) {
      throw new ServiceUnavailableException('LiveKit is not configured');
    }
    if (!req.rawBody) {
      throw new BadRequestException('Missing body');
    }

    const receiver = new WebhookReceiver(key, secret);
    let event;
    try {
      event = await receiver.receive(
        req.rawBody.toString('utf8'),
        authorization,
      );
    } catch (e) {
      // An unverified call is not told why it was rejected.
      this.logger.warn(`Rejected a LiveKit webhook: ${String(e)}`);
      throw new BadRequestException('Invalid signature');
    }

    if (event.event !== 'egress_ended' && event.event !== 'egress_updated') {
      return { ok: true };
    }
    const info = event.egressInfo;
    if (!info?.egressId) return { ok: true };

    // Anything not finished will be reported again; ABORTED and
    // LIMIT_REACHED are failures from our side of the fence.
    const finished =
      info.status === EgressStatus.EGRESS_COMPLETE ||
      info.status === EgressStatus.EGRESS_FAILED ||
      info.status === EgressStatus.EGRESS_ABORTED ||
      info.status === EgressStatus.EGRESS_LIMIT_REACHED;
    if (!finished) {
      return { ok: true };
    }

    const file = info.fileResults?.[0];
    await this.recordings.applyEgressResult({
      egressId: info.egressId,
      status:
        info.status === EgressStatus.EGRESS_COMPLETE ? 'complete' : 'failed',
      sizeBytes: file?.size == null ? undefined : Number(file.size),
      // LiveKit reports nanoseconds.
      durationSec:
        file?.duration == null
          ? undefined
          : Math.round(Number(file.duration) / 1e9),
      error: info.error || undefined,
    });
    return { ok: true };
  }
}
