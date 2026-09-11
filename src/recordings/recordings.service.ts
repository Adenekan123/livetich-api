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
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import { RecordingEgressService } from './recording-egress.service';

/** Signed playback links are short-lived; the gallery re-asks when it needs one. */
const PLAYBACK_URL_TTL_SECONDS = 60 * 60;
/** A share link resolves to a playback URL that outlives a single page view. */
const SHARE_PLAYBACK_TTL_SECONDS = 60 * 60 * 6;
/** Warn in the gallery past this share of the quota. */
export const QUOTA_WARNING_RATIO = 0.85;

@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly egress: RecordingEgressService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

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
      const { egressId, storageKey } = await this.egress.start({
        room: session.livekitRoom,
        organizationId,
        recordingId: recording.id,
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
    const recording = await this.prisma.recording.findFirst({
      where: { sessionId, organizationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true, error: true },
    });
    return {
      available: this.egress.isConfigured,
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
    await this.prisma.recording.delete({ where: { id } });
    return { deleted: true };
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
