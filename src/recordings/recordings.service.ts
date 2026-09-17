import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RecordingStatus, Role, SessionStatus } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LivekitService } from '../sessions/livekit.service';
import { RoomStateService } from '../room-gateway/room-state.service';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import {
  PLUGIN_CODE_INSTRUCTION,
  PLUGIN_ISLAMIC_EDUCATION,
  PLUGIN_MATHS_SCIENCES,
  PLUGIN_TEST_PREP,
} from '../plugins/catalog';
import { RecorderTokenService } from './recorder-token.service';
import { RecordingEgressService } from './recording-egress.service';

/** Signed playback links are short-lived; the gallery re-asks when it needs one. */
const PLAYBACK_URL_TTL_SECONDS = 60 * 60;
/** A share link resolves to a playback URL that outlives a single page view. */
const SHARE_PLAYBACK_TTL_SECONDS = 60 * 60 * 6;
/** Warn in the gallery past this share of the quota. */
export const QUOTA_WARNING_RATIO = 0.85;
/**
 * How long to wait for WEB_URL to answer before deciding LiveKit cannot film
 * it.
 *
 * Generous on purpose. A host that is genuinely gone — a tunnel whose name died
 * with it — fails DNS in well under a second, so this ceiling is only ever paid
 * by a host that is alive but slow, which is exactly the case worth waiting
 * out: a dev server behind a tunnel can spend ten seconds compiling the route
 * on the first request, and refusing that would be a worse bug than the silent
 * fallback this replaces.
 */
const RECORDER_PROBE_TIMEOUT_MS = 15_000;

@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly egress: RecordingEgressService,
    private readonly livekit: LivekitService,
    private readonly config: ConfigService,
    private readonly recorderTokens: RecorderTokenService,
    private readonly roomState: RoomStateService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * What the recording browser needs once it has loaded the page: a LiveKit
   * token for the room's audio and video.
   *
   * Hidden, so nobody in the class sees a participant appear — the instructor
   * alone knows the class is being recorded, and a visible "Recorder" in the
   * roster would say otherwise to everyone.
   */
  async recorderContext(user: JwtPayload, sessionId: string) {
    if (!user.recorder || user.recorder.sessionId !== sessionId) {
      throw new ForbiddenException('Not a recorder for this session');
    }
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        livekitRoom: true,
        courseId: true,
        course: { select: { title: true, organizationId: true } },
      },
    });
    if (!session) throw new NotFoundException('Session not found');

    // Which add-on packs are on, answered here rather than looked up by the
    // recorder itself. A recorder token is refused by /organizations/plugins —
    // deliberately, it is scoped to one recording — and the web client swallows
    // that failure as "no packs", which silently unmounts the surfaces those
    // packs own. The mushaf then simply was not in the recording, with nothing
    // anywhere saying why. The context already exists to hand this browser the
    // things it cannot go and find; this is one of them.
    const orgId = session.course.organizationId;
    const packs = orgId
      ? await this.prisma.orgPlugin.findMany({
          where: { organizationId: orgId },
          select: { pluginKey: true },
        })
      : [];
    const enabled = new Set(packs.map((p) => p.pluginKey));

    const token = await this.livekit.mintJoinToken({
      room: session.livekitRoom,
      userId: `recorder-${user.recorder.recordingId}`,
      name: 'Recording',
      role: user.role,
      hidden: true,
    });
    return {
      livekitToken: token,
      // Handed over with the token, the way the classroom's own join does it —
      // the recorder browser has no environment of its own to read.
      url: this.config.get<string>('LIVEKIT_URL') ?? null,
      room: session.livekitRoom,
      courseTitle: session.course.title,
      courseId: session.courseId,
      // The recorder renders the classroom itself, which needs to know who it
      // is rendering for. This is the person who pressed Record — the same
      // identity the token already carries, handed over rather than decoded in
      // the browser.
      me: { userId: user.sub, name: user.name, role: user.role },
      // Deliberately never the host's classroom, however the recording was
      // started. Rendering the host UI makes the page fetch what a host fetches
      // — /quizzes among them — and those endpoints refuse a recorder token, as
      // they should: it is scoped to one recording, not to an admin's reach.
      // The first 401 redirected the page to /login, and the recording filmed
      // that. The observer's classroom asks for nothing it cannot have, and its
      // "Shadowing · hidden" badge is hidden by the recorder's own stylesheet.
      teaching: false,
      // Which surface the class is on, right now. The classroom's own default
      // is the room, and it only learns better when the socket replays the
      // real value — so a recorder that starts rendering before that replay
      // opens on the wrong surface and the recording's first seconds show it.
      // Handing it over with the rest of the context removes the window.
      view: await this.roomState.getView(sessionId),
      packs: {
        islamicEducation: enabled.has(PLUGIN_ISLAMIC_EDUCATION),
        codeInstruction: enabled.has(PLUGIN_CODE_INSTRUCTION),
        mathsSciences: enabled.has(PLUGIN_MATHS_SCIENCES),
        testPrep: enabled.has(PLUGIN_TEST_PREP),
      },
    };
  }

  /**
   * Where LiveKit's browser can reach the recorder page, or null if it cannot.
   *
   * Egress runs on LiveKit's infrastructure, so the web app has to be
   * reachable from the internet. A localhost WEB_URL is the normal state of a
   * developer's machine, and silently filming a connection-refused page would
   * be worse than falling back to the camera — so it is treated as "no page"
   * and said out loud once.
   */
  private async publicUrl(
    key: 'WEB_URL' | 'API_PUBLIC_URL',
  ): Promise<string | null> {
    const raw = this.config.get<string>(key)?.replace(/\/+$/, '');
    if (!raw) return null;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw)) {
      this.logger.warn(
        `${key} is ${raw}, which LiveKit cannot reach — it can only record the ` +
          `camera. Expose it (a tunnel is enough) to record the whole class.`,
      );
      return null;
    }
    // A hostname that worked once is not one that works now. A quick tunnel's
    // name dies with the tunnel while the URL stays in .env, and egress then
    // films an error page — exactly as blank as filming nothing. So ask the
    // host rather than believing the string.
    //
    // An HTTP answer is not on its own good news. A tunnel whose process is
    // gone still resolves and still answers: Cloudflare returns 530 ("origin
    // unreachable") for a good while before the name itself goes away, and a
    // proxy with nothing behind it answers 502/504. Those are the shapes this
    // check exists to catch, so anything 5xx counts as down. Below that — a
    // 200, a redirect, even a 401 — something is serving, which is all that is
    // in question here.
    try {
      const res = await fetch(raw, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(RECORDER_PROBE_TIMEOUT_MS),
      });
      if (res.status >= 500) {
        this.logger.warn(
          `${key} is ${raw}, which answered ${res.status} — nothing is serving ` +
            `behind it (a tunnel that has stopped answers this way).`,
        );
        return null;
      }
      return raw;
    } catch (e) {
      this.logger.warn(
        `${key} is ${raw}, which did not answer within ` +
          `${RECORDER_PROBE_TIMEOUT_MS}ms (${e instanceof Error ? e.message : e}) — ` +
          `LiveKit cannot film a page it cannot load.`,
      );
      return null;
    }
  }

  /**
   * Whether an operator has accepted camera-only recordings for this
   * deployment. Off by default: the surprise is the problem, not the mode.
   */
  private cameraOnlyAllowed(): boolean {
    return (
      (this.config.get<string>('RECORDING_ALLOW_CAMERA_ONLY') ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  /** Only staff record or manage recordings; students never see the gallery. */
  private assertStaff(user: JwtPayload): string {
    if (user.role !== Role.INSTRUCTOR && user.role !== Role.ORG_ADMIN) {
      throw new ForbiddenException('Only staff can manage recordings');
    }
    if (!user.organizationId) {
      throw new ForbiddenException('No active workspace');
    }
    return user.organizationId;
  }

  /**
   * Bytes held and the ceiling, if there is one. Usage is summed from the rows
   * rather than measured in the bucket: a recording still uploading has no size
   * yet, and a bucket listing would bill a request per gallery view.
   */
  async usage(organizationId: string): Promise<{
    usedBytes: number;
    quotaBytes: number | null;
    nearLimit: boolean;
    full: boolean;
  }> {
    const [agg, org] = await Promise.all([
      this.prisma.recording.aggregate({
        where: { organizationId, sizeBytes: { not: null } },
        _sum: { sizeBytes: true },
      }),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { storageQuotaBytes: true },
      }),
    ]);
    const usedBytes = Number(agg._sum.sizeBytes ?? 0n);
    const quotaBytes =
      org?.storageQuotaBytes == null ? null : Number(org.storageQuotaBytes);
    return {
      usedBytes,
      quotaBytes,
      nearLimit:
        quotaBytes !== null && usedBytes >= quotaBytes * QUOTA_WARNING_RATIO,
      full: quotaBytes !== null && usedBytes >= quotaBytes,
    };
  }

  /** Begin recording a live class. */
  async start(user: JwtPayload, sessionId: string) {
    const organizationId = this.assertStaff(user);

    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        livekitRoom: true,
        courseId: true,
        course: { select: { organizationId: true } },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.course.organizationId !== organizationId) {
      throw new ForbiddenException('That class belongs to another workspace');
    }
    if (session.status !== SessionStatus.LIVE) {
      throw new BadRequestException('The class is not live');
    }

    // One recording at a time per class — two egresses would bill twice and
    // write over each other's story in the gallery.
    const running = await this.prisma.recording.findFirst({
      where: {
        sessionId,
        status: { in: [RecordingStatus.STARTING, RecordingStatus.RECORDING] },
      },
      select: { id: true },
    });
    if (running)
      throw new BadRequestException('This class is already recording');

    // Both halves matter. The page is useless without the API: it opens, every
    // fetch and socket fails, and it renders a full-screen error — which films
    // as a black rectangle just as convincingly as no page at all. So the API's
    // own public URL is checked with the same suspicion as the web app's.
    const [webBase, apiBase] = await Promise.all([
      this.publicUrl('WEB_URL'),
      this.publicUrl('API_PUBLIC_URL'),
    ]);
    const recorderBase = webBase && apiBase ? webBase : null;
    // Falling back to the room is how a lesson gets recorded as a black
    // rectangle: a room composite films published tracks, so the board, the
    // mushaf and the shared media are all absent by construction, and with
    // every camera off there is nothing left to draw. That is worse than no
    // recording, because it looks like one until someone watches it. Refuse,
    // and name the thing to fix — unless an operator has explicitly said the
    // camera alone is worth having here.
    if (!recorderBase && !this.cameraOnlyAllowed()) {
      const missing = [
        webBase ? null : 'WEB_URL',
        apiBase ? null : 'API_PUBLIC_URL',
      ]
        .filter(Boolean)
        .join(' and ');
      throw new BadRequestException(
        `Recording the class needs ${missing} to be reachable from the internet. ` +
          'Point it at a public URL (a tunnel is enough) and try again — otherwise ' +
          'the recording would hold no board, no mushaf and no shared media.',
      );
    }
    // Only when we are filming the room itself. Recording the page has
    // something to show either way — a hifz lesson on the mushaf with every
    // camera off is a perfectly good recording — whereas a room composite
    // pointed at a room with nothing published waits a minute and then dies
    // with an error the instructor cannot act on.
    if (
      !recorderBase &&
      !(await this.egress.hasPublisher(session.livekitRoom))
    ) {
      throw new BadRequestException(
        'Turn on your camera or microphone before recording — there is nothing to record yet.',
      );
    }

    // The workspace's recording settings: what it may store, how it encodes,
    // and how long one recording may run.
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { recordingQuality: true, maxRecordingMinutes: true },
    });

    const { full } = await this.usage(organizationId);
    if (full) {
      throw new BadRequestException(
        'This workspace has used all of its recording storage. Delete a recording to free space.',
      );
    }

    const recording = await this.prisma.recording.create({
      data: {
        sessionId,
        courseId: session.courseId,
        organizationId,
        startedById: user.sub,
        status: RecordingStatus.STARTING,
      },
    });

    try {
      // The token can only be minted now: it names the recording it films, so
      // that a leaked URL is worth exactly one lesson.
      const recorderUrl = recorderBase
        ? `${recorderBase}/record/${sessionId}?t=${encodeURIComponent(
            await this.recorderTokens.mint({
              sessionId,
              recordingId: recording.id,
              startedById: user.sub,
            }),
          )}&api=${encodeURIComponent(apiBase!)}`
        : undefined;
      const { egressId, storageKey } = await this.egress.start({
        room: session.livekitRoom,
        organizationId,
        recordingId: recording.id,
        recorderUrl,
        quality: org?.recordingQuality,
      });
      return this.prisma.recording.update({
        where: { id: recording.id },
        data: { egressId, storageKey, status: RecordingStatus.RECORDING },
      });
    } catch (e) {
      // Leave the failure visible rather than deleting the row — an instructor
      // who pressed record deserves to know it did not take.
      await this.prisma.recording.update({
        where: { id: recording.id },
        data: {
          status: RecordingStatus.FAILED,
          error: e instanceof Error ? e.message : 'Could not start recording',
        },
      });
      throw e;
    }
  }

  /** Stop recording. The file is written afterwards; the webhook closes it out. */
  async stop(user: JwtPayload, sessionId: string) {
    const organizationId = this.assertStaff(user);
    const recording = await this.prisma.recording.findFirst({
      where: {
        sessionId,
        organizationId,
        status: { in: [RecordingStatus.STARTING, RecordingStatus.RECORDING] },
      },
    });
    if (!recording) throw new NotFoundException('Nothing is recording');
    if (recording.egressId) await this.egress.stop(recording.egressId);
    return this.prisma.recording.update({
      where: { id: recording.id },
      data: { status: RecordingStatus.PROCESSING },
    });
  }

  /** What the classroom shows on the Record button. */
  async statusFor(user: JwtPayload, sessionId: string) {
    const organizationId = this.assertStaff(user);
    const [recording, session] = await Promise.all([
      this.prisma.recording.findFirst({
        where: { sessionId, organizationId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, createdAt: true, error: true },
      }),
      this.prisma.liveSession.findUnique({
        where: { id: sessionId },
        select: { livekitRoom: true },
      }),
    ]);
    // A recording with no voice in it is a wasted lesson, and nothing about
    // the picture reveals it while you are teaching. Reported so the classroom
    // can say so before the instructor commits, not after.
    const micLive =
      this.egress.isConfigured && session
        ? await this.egress
            .hasLiveMic(session.livekitRoom, user.sub)
            .catch(() => true)
        : true;
    return {
      available: this.egress.isConfigured,
      micLive,
      recording:
        recording &&
        (recording.status === RecordingStatus.STARTING ||
          recording.status === RecordingStatus.RECORDING)
          ? recording
          : null,
      last: recording,
    };
  }

  /** The workspace gallery. */
  async list(user: JwtPayload) {
    const organizationId = this.assertStaff(user);
    const [rows, usage] = await Promise.all([
      this.prisma.recording.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          sizeBytes: true,
          durationSec: true,
          error: true,
          createdAt: true,
          readyAt: true,
          shareToken: true,
          shareExpiresAt: true,
          course: { select: { id: true, title: true } },
          startedBy: { select: { id: true, name: true } },
          session: { select: { id: true, scheduledAt: true } },
        },
      }),
      this.usage(organizationId),
    ]);
    return {
      usage,
      recordings: rows.map((r) => ({
        ...r,
        // BigInt does not survive JSON; bytes fit a double well past any file.
        sizeBytes: r.sizeBytes == null ? null : Number(r.sizeBytes),
      })),
    };
  }

  /** A short-lived URL that plays straight from R2. */
  async playbackUrl(user: JwtPayload, id: string) {
    const organizationId = this.assertStaff(user);
    const recording = await this.prisma.recording.findFirst({
      where: { id, organizationId },
      select: {
        storageKey: true,
        status: true,
        course: { select: { title: true } },
      },
    });
    if (!recording?.storageKey || recording.status !== RecordingStatus.READY) {
      throw new NotFoundException('That recording is not ready');
    }
    return this.signedFor(recording.storageKey, PLAYBACK_URL_TTL_SECONDS, null);
  }

  /** The same, as a download with a sensible filename. */
  async downloadUrl(user: JwtPayload, id: string) {
    const organizationId = this.assertStaff(user);
    const recording = await this.prisma.recording.findFirst({
      where: { id, organizationId },
      select: {
        storageKey: true,
        status: true,
        createdAt: true,
        course: { select: { title: true } },
      },
    });
    if (!recording?.storageKey || recording.status !== RecordingStatus.READY) {
      throw new NotFoundException('That recording is not ready');
    }
    const date = recording.createdAt.toISOString().slice(0, 10);
    const name = `${recording.course.title} ${date}.mp4`.replace(
      /[/\\?%*:|"<>]/g,
      '-',
    );
    return this.signedFor(recording.storageKey, PLAYBACK_URL_TTL_SECONDS, name);
  }

  private async signedFor(key: string, ttl: number, downloadAs: string | null) {
    const url = await this.storage.signedUrl(key, {
      expiresInSeconds: ttl,
      ...(downloadAs ? { downloadAs } : {}),
    });
    // Local disk cannot sign; the caller streams it through the API instead.
    return { url, expiresInSeconds: ttl };
  }

  /**
   * Release a recording behind an unguessable link. Off by default: a recorded
   * class holds students' faces and voices, so publishing it is a decision.
   */
  async share(user: JwtPayload, id: string, expiresInDays: number | null) {
    const organizationId = this.assertStaff(user);
    const recording = await this.prisma.recording.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true },
    });
    if (!recording) throw new NotFoundException('Recording not found');
    if (recording.status !== RecordingStatus.READY) {
      throw new BadRequestException('That recording is not ready to share');
    }
    return this.prisma.recording.update({
      where: { id },
      data: {
        shareToken: randomBytes(24).toString('base64url'),
        shareExpiresAt:
          expiresInDays == null
            ? null
            : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
      },
      select: { id: true, shareToken: true, shareExpiresAt: true },
    });
  }

  /** Withdraw a share link. The recording itself is untouched. */
  async unshare(user: JwtPayload, id: string) {
    const organizationId = this.assertStaff(user);
    const { count } = await this.prisma.recording.updateMany({
      where: { id, organizationId },
      data: { shareToken: null, shareExpiresAt: null },
    });
    if (count === 0) throw new NotFoundException('Recording not found');
    return { shared: false };
  }

  /** Resolve a share link for someone with no account. */
  async bySharedToken(token: string) {
    const recording = await this.prisma.recording.findUnique({
      where: { shareToken: token },
      select: {
        id: true,
        status: true,
        storageKey: true,
        durationSec: true,
        createdAt: true,
        shareExpiresAt: true,
        course: { select: { title: true } },
        organization: { select: { name: true } },
      },
    });
    if (
      !recording ||
      recording.status !== RecordingStatus.READY ||
      !recording.storageKey
    ) {
      throw new NotFoundException('That link is not valid');
    }
    if (recording.shareExpiresAt && recording.shareExpiresAt < new Date()) {
      throw new NotFoundException('That link has expired');
    }
    const url = await this.storage.signedUrl(recording.storageKey, {
      expiresInSeconds: SHARE_PLAYBACK_TTL_SECONDS,
    });
    return {
      title: recording.course.title,
      workspace: recording.organization.name,
      recordedAt: recording.createdAt,
      durationSec: recording.durationSec,
      url,
    };
  }

  /** Delete the row and the object. Frees the workspace's quota. */
  async remove(user: JwtPayload, id: string) {
    const organizationId = this.assertStaff(user);
    const recording = await this.prisma.recording.findFirst({
      where: { id, organizationId },
      select: { id: true, storageKey: true, egressId: true, status: true },
    });
    if (!recording) throw new NotFoundException('Recording not found');
    if (
      recording.status === RecordingStatus.RECORDING ||
      recording.status === RecordingStatus.STARTING
    ) {
      throw new BadRequestException('Stop the recording before deleting it');
    }
    if (recording.storageKey) {
      // Storage first: a row without its object is a phantom in the gallery,
      // whereas an object without its row is invisible and sweepable.
      await this.storage.delete(recording.storageKey).catch((e) => {
        this.logger.error(
          `Could not delete ${recording.storageKey}: ${String(e)}`,
        );
      });
    }
    if (recording.egressId) {
      // Recordings made before manifests were turned off have a small JSON
      // file beside the video. Deleting the row is the last chance to find it:
      // it is named after the egress, which nothing else records.
      const manifest = this.egress.legacyManifestKey(
        organizationId,
        recording.egressId,
      );
      await this.storage.delete(manifest).catch(() => {
        // Almost always simply absent, which is the expected case now.
      });
    }
    await this.prisma.recording.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Delete a recording's bytes, whoever is asking.
   *
   * Extracted from `remove` so the retention sweep deletes exactly what a
   * person deleting by hand would — including the legacy manifest, which is
   * named after the egress and is unfindable once the row is gone.
   */
  private async purgeStoredObjects(recording: {
    organizationId: string;
    storageKey: string | null;
    egressId: string | null;
  }): Promise<void> {
    if (recording.storageKey) {
      await this.storage.delete(recording.storageKey).catch((e) => {
        this.logger.error(
          `Could not delete ${recording.storageKey}: ${String(e)}`,
        );
      });
    }
    if (recording.egressId) {
      const manifest = this.egress.legacyManifestKey(
        recording.organizationId,
        recording.egressId,
      );
      await this.storage.delete(manifest).catch(() => {
        // Almost always simply absent, which is the expected case now.
      });
    }
  }

  /**
   * Remove recordings that have outlived their workspace's retention window.
   *
   * A quota alone only postpones the problem: storage is a stock, not a flow,
   * so without an expiry every workspace grows until it hits its ceiling and
   * the only way forward is asking a paying customer to delete their lessons.
   * An expiry makes the steady-state size predictable.
   *
   * Deliberately conservative:
   *  - a workspace with no retention set (null) is left entirely alone,
   *  - a recording still being made is never touched, however old its row,
   *  - the bytes go before the row, since an object with no row is invisible
   *    and sweepable whereas a row with no object is a broken gallery entry,
   *  - and the batch is capped, so one very old workspace cannot turn a single
   *    tick into thousands of storage calls.
   */
  async sweepExpiredRecordings(limit = 100): Promise<number> {
    const orgs = await this.prisma.organization.findMany({
      where: { recordingRetentionDays: { not: null } },
      select: { id: true, recordingRetentionDays: true },
    });

    let deleted = 0;
    for (const org of orgs) {
      const days = org.recordingRetentionDays;
      if (!days || days <= 0) continue;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const expired = await this.prisma.recording.findMany({
        where: {
          organizationId: org.id,
          createdAt: { lt: cutoff },
          status: {
            notIn: [RecordingStatus.STARTING, RecordingStatus.RECORDING],
          },
        },
        select: {
          id: true,
          organizationId: true,
          storageKey: true,
          egressId: true,
          createdAt: true,
        },
        take: Math.max(1, limit - deleted),
      });
      for (const recording of expired) {
        try {
          await this.purgeStoredObjects(recording);
          await this.prisma.recording.delete({ where: { id: recording.id } });
          deleted++;
          this.logger.log(
            `Recording ${recording.id} deleted: older than ${days}d ` +
              `(made ${recording.createdAt.toISOString()})`,
          );
        } catch (e) {
          // Leave it for the next sweep rather than abandoning the batch.
          this.logger.warn(
            `Could not sweep recording ${recording.id}: ` +
              `${e instanceof Error ? e.message : e}`,
          );
        }
      }
      if (deleted >= limit) break;
    }
    return deleted;
  }

  /**
   * LiveKit reporting an egress finished. Called from the webhook, which is
   * authenticated by signature rather than by a user.
   */
  async applyEgressResult(result: {
    egressId: string;
    status: 'complete' | 'failed';
    sizeBytes?: number;
    durationSec?: number;
    error?: string;
  }) {
    const recording = await this.prisma.recording.findUnique({
      where: { egressId: result.egressId },
      select: { id: true, storageKey: true },
    });
    if (!recording) {
      this.logger.warn(`Egress ${result.egressId} has no recording; ignoring`);
      return;
    }
    if (result.status === 'failed') {
      await this.prisma.recording.update({
        where: { id: recording.id },
        data: {
          status: RecordingStatus.FAILED,
          error: result.error ?? 'LiveKit reported the recording failed',
        },
      });
      return;
    }
    // Trust LiveKit's size when it gives one, and fall back to asking the
    // bucket — the quota depends on this number being right.
    const sizeBytes =
      result.sizeBytes ??
      (recording.storageKey
        ? await this.storage.size(recording.storageKey)
        : null);
    await this.prisma.recording.update({
      where: { id: recording.id },
      data: {
        status: RecordingStatus.READY,
        readyAt: new Date(),
        sizeBytes: sizeBytes == null ? null : BigInt(Math.round(sizeBytes)),
        durationSec: result.durationSec ?? null,
        error: null,
      },
    });
    this.logger.log(
      `Recording ${recording.id} ready (${sizeBytes ?? '?'} bytes)`,
    );
  }
}
