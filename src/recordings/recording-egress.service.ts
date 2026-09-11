import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
  TwirpError,
} from 'livekit-server-sdk';

/**
 * Starting and stopping a class recording.
 *
 * LiveKit composites the room server-side and writes the file straight to R2,
 * so the video never passes through this API — no gigabytes through Node, no
 * request timeouts, and nothing to clean up if the process restarts mid-class.
 * We only ever hold the egress id and, once LiveKit tells us, the object key.
 */
@Injectable()
export class RecordingEgressService {
  private readonly logger = new Logger(RecordingEgressService.name);

  constructor(private readonly config: ConfigService) {}

  /** Recording is unavailable unless LiveKit *and* a real bucket are configured. */
  get isConfigured(): boolean {
    return !!(
      this.config.get<string>('LIVEKIT_URL') &&
      this.config.get<string>('LIVEKIT_API_KEY') &&
      this.config.get<string>('LIVEKIT_API_SECRET') &&
      this.config.get<string>('R2_ACCOUNT_ID') &&
      this.config.get<string>('R2_ACCESS_KEY_ID') &&
      this.config.get<string>('R2_SECRET_ACCESS_KEY') &&
      this.config.get<string>('R2_BUCKET')
    );
  }

  private client(): EgressClient {
    const url = this.config.get<string>('LIVEKIT_URL');
    const key = this.config.get<string>('LIVEKIT_API_KEY');
    const secret = this.config.get<string>('LIVEKIT_API_SECRET');
    if (!url || !key || !secret) {
      throw new ServiceUnavailableException('LiveKit is not configured');
    }
    return new EgressClient(url, key, secret);
  }

  /**
   * Where a recording lands. Organization-first so a workspace's objects sit
   * under one prefix — which is what makes "delete the workspace" or "measure
   * its usage" a prefix operation rather than a table scan.
   */
  storageKey(organizationId: string, recordingId: string): string {
    return `recordings/${organizationId}/${recordingId}.mp4`;
  }

  /**
   * Start recording a room. Returns LiveKit's egress id, which is how we stop
   * it later and how its webhooks are matched back to our row.
   */
  async start(opts: {
    room: string;
    organizationId: string;
    recordingId: string;
  }): Promise<{ egressId: string; storageKey: string }> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'Recording needs LiveKit and R2 to both be configured',
      );
    }
    const accountId = this.config.get<string>('R2_ACCOUNT_ID')!;
    const storageKey = this.storageKey(opts.organizationId, opts.recordingId);

    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: storageKey,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: this.config.get<string>('R2_ACCESS_KEY_ID')!,
          secret: this.config.get<string>('R2_SECRET_ACCESS_KEY')!,
          bucket: this.config.get<string>('R2_BUCKET')!,
          // R2 speaks the S3 API at an account-scoped endpoint, and has no
          // regions — "auto" is what it expects.
          region: 'auto',
          endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
          forcePathStyle: true,
        }),
      },
    });

    const info = await this.client().startRoomCompositeEgress(
      opts.room,
      output,
      {
        // The grid layout follows whoever is speaking, which for a class is the
        // instructor almost all of the time.
        layout: 'speaker',
      },
    );
    this.logger.log(
      `Recording ${opts.recordingId} started (egress ${info.egressId}) -> ${storageKey}`,
    );
    return { egressId: info.egressId, storageKey };
  }

  /**
   * Ask LiveKit what actually became of an egress.
   *
   * The webhook is the fast path, but it is a call *into* this API, which fails
   * whenever we are not publicly reachable — in development, behind a firewall,
   * or during a deploy. This is the same answer, pulled rather than pushed, and
   * it is what lets a stuck recording resolve itself.
   *
   * Null when LiveKit no longer knows about it; it keeps egress history only so
   * long.
   */
  async describe(egressId: string): Promise<{
    finished: boolean;
    complete: boolean;
    sizeBytes?: number;
    durationSec?: number;
    error?: string;
  } | null> {
    let info;
    try {
      [info] = await this.client().listEgress({ egressId });
    } catch (e) {
      // LiveKit answers an unknown egress by throwing, not by returning an
      // empty list. That is still an answer — "there is no such recording" —
      // and it has to be distinguishable from the network being down, or a
      // recording that LiveKit has genuinely forgotten would be retried
      // forever instead of ever being abandoned. Every other error rethrows
      // and stays transient.
      if (e instanceof TwirpError && e.code === 'not_found') return null;
      throw e;
    }
    if (!info) return null;

    const finished =
      info.status === EgressStatus.EGRESS_COMPLETE ||
      info.status === EgressStatus.EGRESS_FAILED ||
      info.status === EgressStatus.EGRESS_ABORTED ||
      info.status === EgressStatus.EGRESS_LIMIT_REACHED;
    const file = info.fileResults?.[0];
    return {
      finished,
      complete: info.status === EgressStatus.EGRESS_COMPLETE,
      sizeBytes: file?.size == null ? undefined : Number(file.size),
      // LiveKit reports nanoseconds.
      durationSec:
        file?.duration == null
          ? undefined
          : Math.round(Number(file.duration) / 1e9),
      error:
        info.error ||
        (info.status === EgressStatus.EGRESS_ABORTED
          ? 'LiveKit aborted the recording'
          : undefined),
    };
  }

  /**
   * Stop a recording. LiveKit finishes writing the file afterwards and reports
   * completion by webhook, so this returning is not the same as the file being
   * ready.
   */
  async stop(egressId: string): Promise<void> {
    await this.client().stopEgress(egressId);
    this.logger.log(`Recording egress ${egressId} stop requested`);
  }
}
