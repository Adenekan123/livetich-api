import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AudioCodec,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  RoomServiceClient,
  S3Upload,
  TrackType,
  TwirpError,
  VideoCodec,
} from 'livekit-server-sdk';

/**
 * Starting and stopping a class recording.
 *
 * LiveKit composites the room server-side and writes the file straight to R2,
 * so the video never passes through this API — no gigabytes through Node, no
 * request timeouts, and nothing to clean up if the process restarts mid-class.
 * We only ever hold the egress id and, once LiveKit tells us, the object key.
 */
/**
 * How hard to compress a recording.
 *
 * A class is unusually cheap to encode: the camera is a talking head and the
 * rest of the frame is a whiteboard or slides that barely move. H.264 spends
 * almost nothing on static regions, so the bitrate can come down a long way
 * before anything is visible.
 *
 * What we do *not* trade away is resolution. Dropping to 720p is the obvious
 * saving and the wrong one — it is the whiteboard's handwriting and the code
 * on a slide that go first, and those are the point of the recording.
 * Framerate is the safe lever instead: 24 is plenty for a lecture.
 *
 * LiveKit's own default is 1080p30 at 3000kbps, which is what every recording
 * made before this used.
 */
/**
 * Framerate stays at 15 or above in every preset. Below that LiveKit's
 * pipeline dies with "GStreamer error: clock problem" — 12fps and 8fps were
 * both tried and both failed outright, which is worse than any file size.
 * Resolution and bitrate are the dials that are actually safe to turn.
 */
const QUALITY = {
  /** LiveKit's default. Use when storage is not the constraint. */
  high: {
    width: 1920,
    height: 1080,
    framerate: 30,
    videoBitrate: 3000,
    audioBitrate: 128,
    keyFrameInterval: 2,
  },
  /**
   * The default. Full resolution, because the handwriting and the ayah are
   * the recording, and every other dial turned down instead: half the frames
   * (a lesson is not sport), a bitrate ceiling the content rarely reaches
   * anyway, and speech-rate audio.
   */
  balanced: {
    width: 1920,
    height: 1080,
    framerate: 15,
    videoBitrate: 1200,
    audioBitrate: 64,
    keyFrameInterval: 4,
  },
  /**
   * Half the pixels. Slide text and a thick marker survive this; small
   * handwriting and dense mushaf vowel marks start to soften, so it is for
   * archives that get kept rather than re-watched closely.
   */
  compact: {
    width: 1280,
    height: 720,
    framerate: 15,
    videoBitrate: 600,
    audioBitrate: 48,
    keyFrameInterval: 4,
  },
  /**
   * Barely video: enough to follow a board being written on, and speech that
   * is still clear. For keeping a year of lessons rather than watching them.
   */
  minimal: {
    width: 1280,
    height: 720,
    framerate: 15,
    videoBitrate: 300,
    audioBitrate: 40,
    keyFrameInterval: 4,
  },
} as const;

type QualityName = keyof typeof QUALITY;

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
  /**
   * Where LiveKit put the manifest for a recording made before manifests were
   * turned off. It is named after the egress, not the recording, so it cannot
   * be derived from the storage key alone.
   */
  legacyManifestKey(organizationId: string, egressId: string): string {
    return `recordings/${organizationId}/${egressId}.json`;
  }

  storageKey(organizationId: string, recordingId: string): string {
    return `recordings/${organizationId}/${recordingId}.mp4`;
  }

  /**
   * Chosen with RECORDING_QUALITY; anything unrecognised falls back to
   * balanced rather than failing a recording over a typo in the environment.
   */
  private encodingOptions(): EncodingOptions {
    const name = (
      this.config.get<string>('RECORDING_QUALITY') ?? 'balanced'
    ).toLowerCase();
    const preset = QUALITY[name as QualityName] ?? QUALITY.balanced;
    if (!(name in QUALITY)) {
      this.logger.warn(
        `RECORDING_QUALITY="${name}" is not one of ${Object.keys(QUALITY).join(', ')}; using balanced`,
      );
    }
    return new EncodingOptions({
      width: preset.width,
      height: preset.height,
      framerate: preset.framerate,
      // High profile over Main: same picture, a few percent fewer bits, and
      // every browser and phone from the last decade decodes it.
      videoCodec: VideoCodec.H264_HIGH,
      videoBitrate: preset.videoBitrate,
      audioCodec: AudioCodec.AAC,
      audioBitrate: preset.audioBitrate,
      // Seeking granularity traded for size. A near-static board costs almost
      // nothing between keyframes, so the longer the gap the better it packs.
      keyFrameInterval: preset.keyFrameInterval,
    });
  }

  private roomClient(): RoomServiceClient {
    return new RoomServiceClient(
      this.config
        .get<string>('LIVEKIT_URL')!
        .replace(/^wss:/, 'https:')
        .replace(/^ws:/, 'http:'),
      this.config.get<string>('LIVEKIT_API_KEY'),
      this.config.get<string>('LIVEKIT_API_SECRET'),
    );
  }

  /**
   * Whether anyone in the room has published a track.
   *
   * A room composite recorder joins the room and only signals that it has
   * started once it has something to render. Against a room where nothing is
   * published it waits, and after about a minute LiveKit gives up with
   * "Start signal not received" — a real recording that silently never was.
   *
   * Checking first turns that into an immediate, explicable refusal. A muted
   * track still counts: it exists, so the compositor has something to draw.
   */
  async hasPublisher(room: string): Promise<boolean> {
    try {
      const participants = await this.roomClient().listParticipants(room);
      return participants.some((p) => (p.tracks?.length ?? 0) > 0);
    } catch (e) {
      // No such room yet is the same answer as an empty one.
      if (e instanceof TwirpError && e.code === 'not_found') return false;
      throw e;
    }
  }

  /**
   * Start recording a room. Returns LiveKit's egress id, which is how we stop
   * it later and how its webhooks are matched back to our row.
   */
  /**
   * Whether this person currently has live audio in the room.
   *
   * A published-but-muted track does not count: the question being asked is
   * "will this recording have a voice in it", and a muted microphone answers
   * no just as firmly as an absent one.
   */
  async hasLiveMic(room: string, identity: string): Promise<boolean> {
    try {
      const participants = await this.roomClient().listParticipants(room);
      const me = participants.find((p) => p.identity === identity);
      return (me?.tracks ?? []).some(
        (t) => t.type === TrackType.AUDIO && !t.muted,
      );
    } catch (e) {
      // No room at all means no live microphone — that is an answer, and the
      // warning it produces is the correct one. Anything else is us failing to
      // find out, which is rethrown so the caller can stay quiet rather than
      // cry wolf about a microphone that may well be on.
      if (e instanceof TwirpError && e.code === 'not_found') return false;
      throw e;
    }
  }

  async start(opts: {
    room: string;
    organizationId: string;
    recordingId: string;
    /**
     * The recorder page for this session. When present the whole lesson is
     * filmed — board, mushaf, shared media and the camera together — instead
     * of only the room's tracks.
     */
    recorderUrl?: string;
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
      // LiveKit otherwise writes a small JSON manifest beside the video, named
      // after the egress rather than the recording. Nothing reads it, it is
      // not counted against the workspace's quota, and deleting a recording
      // left it behind — so it only ever accumulated. We keep the same facts
      // on the row itself.
      disableManifest: true,
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

    // Recording the page captures the lesson; recording the room captures only
    // the people in it. The second is the fallback for a deployment whose web
    // app LiveKit cannot reach — see WEB_URL — because a recording of the
    // camera alone still beats no recording at all.
    const info = opts.recorderUrl
      ? await this.client().startWebEgress(opts.recorderUrl, output, {
          encodingOptions: this.encodingOptions(),
          // The page says when it has the board and the room, so egress never
          // films the loading state. This is the same START_RECORDING signal
          // whose absence shows up as "Start signal not received".
          awaitStartSignal: true,
        })
      : await this.client().startRoomCompositeEgress(opts.room, output, {
          // The grid layout follows whoever is speaking, which for a class is
          // the instructor almost all of the time.
          layout: 'speaker',
          encodingOptions: this.encodingOptions(),
        });
    this.logger.log(
      `Recording ${opts.recordingId} started (egress ${info.egressId}, ` +
        `${opts.recorderUrl ? 'whole class' : 'camera only'}) -> ${storageKey}`,
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
      // LiveKit leaves the file's duration unset on Cloud, but always stamps
      // the egress itself, so fall back to how long it actually ran.
      durationSec:
        file?.duration != null
          ? Math.round(Number(file.duration) / 1e9)
          : info.startedAt && info.endedAt
            ? Math.round(Number(info.endedAt - info.startedAt) / 1e9)
            : undefined,
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
