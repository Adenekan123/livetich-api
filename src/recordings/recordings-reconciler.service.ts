import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RecordingStatus, SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingEgressService } from './recording-egress.service';
import { RecordingsService } from './recordings.service';

/**
 * Recordings are finished by a webhook from LiveKit. That is a call *into* this
 * API, so it fails whenever we are not publicly reachable — in development,
 * behind a firewall, mid-deploy, or simply if LiveKit's delivery drops one.
 *
 * When it does fail there is no signal at all: the recording sits in
 * PROCESSING, looking like it is still uploading, forever. That is worse than
 * an error, because it is indistinguishable from patience.
 *
 * So the same answer is also pulled. Anything unfinished and old enough to have
 * settled is checked against LiveKit directly, and a missed webhook becomes a
 * delay of a minute rather than a permanent lie.
 */
@Injectable()
export class RecordingsReconciler {
  private readonly logger = new Logger(RecordingsReconciler.name);

  /**
   * Grace period before a live-looking recording is questioned. Long enough
   * that the webhook wins the race in the normal case — it is faster and
   * carries the same data — and short enough that nobody stares at a spinner.
   */
  private static readonly SETTLE_MS = 60_000;

  /**
   * When LiveKit no longer has a record of an egress, and it has been long
   * enough that it cannot still be starting, it is not coming back.
   */
  private static readonly ABANDON_MS = 6 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly egress: RecordingEgressService,
    private readonly recordings: RecordingsService,
  ) {}

  @Cron('* * * * *')
  async reconcile(): Promise<void> {
    if (!this.egress.isConfigured) return;

    await this.stopRecordingsForEndedClasses();
    await this.stopOverrunningRecordings();

    const stuck = await this.prisma.recording.findMany({
      where: {
        status: {
          in: [
            RecordingStatus.STARTING,
            RecordingStatus.RECORDING,
            RecordingStatus.PROCESSING,
          ],
        },
        createdAt: {
          lt: new Date(Date.now() - RecordingsReconciler.SETTLE_MS),
        },
      },
      select: { id: true, egressId: true, status: true, createdAt: true },
      // A ceiling so one bad batch cannot turn into a long run of API calls.
      take: 25,
    });
    if (stuck.length === 0) return;

    for (const recording of stuck) {
      try {
        if (!recording.egressId) {
          // Never got as far as an egress id: the start call itself failed and
          // left this behind. Nothing to ask LiveKit about.
          await this.fail(recording.id, 'Recording never started');
          continue;
        }

        const info = await this.egress.describe(recording.egressId);
        if (!info) {
          if (
            Date.now() - recording.createdAt.getTime() >
            RecordingsReconciler.ABANDON_MS
          ) {
            await this.fail(
              recording.id,
              'LiveKit has no record of this recording',
            );
          }
          continue;
        }
        if (!info.finished) continue; // genuinely still running

        await this.recordings.applyEgressResult({
          egressId: recording.egressId,
          status: info.complete ? 'complete' : 'failed',
          sizeBytes: info.sizeBytes,
          durationSec: info.durationSec,
          error: info.error,
        });
        this.logger.log(
          `Reconciled ${recording.id} from LiveKit: ${info.complete ? 'ready' : 'failed'}`,
        );
      } catch (e) {
        // One unreachable egress must not stop the rest of the sweep.
        this.logger.warn(
          `Could not reconcile ${recording.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * Stop anything still filming a class that is over.
   *
   * Pressing End Class does not stop the recording — they are separate
   * controls, and an instructor wrapping up a lesson has no particular reason
   * to remember the second one. Left alone the egress runs on: it bills by the
   * minute, it keeps a browser attached to a dead room, and it eventually ends
   * on LiveKit's own timeout with a long tail of nothing on the end of the
   * lesson.
   *
   * Doing this here rather than in `SessionsService.end` is deliberate. It
   * catches every way a class can stop — the instructor closing the tab, the
   * process restarting, a session ended by some later code path — instead of
   * only the one that goes through that method, and it keeps sessions from
   * having to depend on recordings (see the note in recordings.module.ts). The
   * cost is that it runs on the next tick of the minute rather than instantly,
   * which buys at most a minute of an empty room at the end of a file.
   */
  private async stopRecordingsForEndedClasses(): Promise<void> {
    const orphaned = await this.prisma.recording.findMany({
      where: {
        status: {
          in: [RecordingStatus.STARTING, RecordingStatus.RECORDING],
        },
        session: { status: SessionStatus.ENDED },
      },
      select: { id: true, egressId: true, sessionId: true },
      take: 25,
    });

    for (const recording of orphaned) {
      try {
        // No egress id means the start never got that far; there is nothing to
        // tell LiveKit, and the main reconcile pass below fails it properly.
        if (!recording.egressId) continue;
        await this.egress.stop(recording.egressId);
        // PROCESSING, not READY: LiveKit still has to finish writing and
        // uploading the file, and says so by webhook exactly as it would for a
        // recording stopped by hand.
        await this.prisma.recording.update({
          where: { id: recording.id },
          data: { status: RecordingStatus.PROCESSING },
        });
        this.logger.log(
          `Recording ${recording.id} stopped: class ${recording.sessionId} has ended`,
        );
      } catch (e) {
        // Leave the row as it is and let the next tick try again — the main
        // reconcile pass is what eventually decides a recording is lost.
        this.logger.warn(
          `Could not stop recording ${recording.id} for ended class: ` +
            `${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /**
   * Stop recordings that have run past their workspace's ceiling.
   *
   * The quota is checked when Record is pressed, but a file's size is not known
   * until it has finished uploading — so a workspace a megabyte under its limit
   * can still start a three-hour lesson and overshoot by however long it runs.
   * Checking here is what makes that overshoot finite and predictable: the most
   * anyone can exceed their quota by is one recording at the capped length.
   *
   * It is also the backstop for the genuinely forgotten one — a class that
   * ended in the room but whose recording nobody stopped, on a session that was
   * never formally ended either.
   */
  private async stopOverrunningRecordings(): Promise<void> {
    const running = await this.prisma.recording.findMany({
      where: {
        status: {
          in: [RecordingStatus.STARTING, RecordingStatus.RECORDING],
        },
        organization: { maxRecordingMinutes: { not: null } },
      },
      select: {
        id: true,
        egressId: true,
        createdAt: true,
        organization: { select: { maxRecordingMinutes: true } },
      },
      take: 25,
    });

    for (const recording of running) {
      const cap = recording.organization.maxRecordingMinutes;
      if (!cap || cap <= 0) continue;
      const runningMin = (Date.now() - recording.createdAt.getTime()) / 60_000;
      if (runningMin < cap) continue;
      try {
        if (!recording.egressId) continue; // the main pass below fails these
        await this.egress.stop(recording.egressId);
        // PROCESSING, not READY: LiveKit still has to finish writing and
        // uploading, and reports that by webhook exactly as for a manual stop.
        await this.prisma.recording.update({
          where: { id: recording.id },
          data: { status: RecordingStatus.PROCESSING },
        });
        this.logger.log(
          `Recording ${recording.id} stopped: ran ${Math.round(runningMin)}min, ` +
            `over this workspace's ${cap}min ceiling`,
        );
      } catch (e) {
        this.logger.warn(
          `Could not stop overrunning recording ${recording.id}: ` +
            `${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /**
   * Retention: delete what has outlived its workspace's window.
   *
   * Daily rather than per-minute, and in the small hours. Deletions are
   * irreversible and a day's granularity is ample for a window measured in
   * months, so there is nothing to gain from checking constantly and a real
   * cost to getting it wrong quickly.
   */
  @Cron('15 3 * * *')
  async sweepRetention(): Promise<void> {
    if (!this.egress.isConfigured) return;
    try {
      const deleted = await this.recordings.sweepExpiredRecordings();
      if (deleted > 0) {
        this.logger.log(`Retention sweep deleted ${deleted} recording(s)`);
      }
    } catch (e) {
      this.logger.error(
        `Retention sweep failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private async fail(id: string, error: string): Promise<void> {
    await this.prisma.recording.update({
      where: { id },
      data: { status: RecordingStatus.FAILED, error },
    });
    this.logger.warn(`Recording ${id} marked failed: ${error}`);
  }
}
