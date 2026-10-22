import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AllowRecorder } from '../auth/jwt-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role, SessionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { PrismaService } from '../prisma/prisma.service';
import { googleExportUrl } from './google-export';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import { REDIS } from '../redis/redis.module';
import { BoardGateway } from '../board/board.gateway';

interface UploadedBlob {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** Rasterised PDF pages / pasted images. Generous vs. voice, capped so one
 *  slide can't blow up the store or a socket message. */
const MAX_ASSET_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_SESSION_ASSETS = 120;
const MAX_SESSION_ASSET_BYTES = 150 * 1024 * 1024;
const assetKey = (id: string) => `board-asset/${id}`;
const typeKey = (id: string) => `board-asset/${id}.ct`;
const sessionKey = (id: string) => `board-asset/${id}.session`;
const DEFAULT_TYPE = 'image/png';

function verifiedImageType(file: UploadedBlob): string | null {
  const bytes = file.buffer;
  const type = file.mimetype.toLowerCase();
  if (
    type === 'image/png' &&
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (
    type === 'image/jpeg' &&
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'image/jpeg';
  if (
    type === 'image/gif' &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  )
    return 'image/gif';
  if (
    type === 'image/webp' &&
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/**
 * Board image assets for the shared chalkboard. When the instructor imports a
 * PDF/image, the web rasterises each page to a PNG and uploads it here; the
 * board then syncs only the resulting same-origin URL (`/api/files/board-asset/
 * :id`) inside the tldraw record — NOT the image bytes. Without this the default
 * tldraw asset store hands out `blob:` URLs that are private to the uploader's
 * browser, so shared PDFs/images were invisible to every student. A root
 * controller so `files/board-asset/:id` sits alongside the other `/api/files`
 * proxied blobs.
 */
@Controller()
export class BoardAssetController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly board: BoardGateway,
  ) {}

  @Post('sessions/:id/board-asset')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ASSET_BYTES } }),
  )
  async upload(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
    @UploadedFile() file?: UploadedBlob,
  ) {
    if (!file) throw new BadRequestException('No image received');
    if (file.size > MAX_ASSET_BYTES) {
      throw new BadRequestException('Board image is larger than 20 MB');
    }
    const contentType = verifiedImageType(file);
    if (!contentType) {
      throw new BadRequestException('Use a PNG, JPEG, GIF, or WebP image');
    }
    const session = await this.assertParticipant(user, sessionId);
    if (session.status === SessionStatus.ENDED) {
      throw new ForbiddenException('Cannot add images to an ended class');
    }
    if (user.role === Role.STUDENT && !this.board.isWritable(sessionId)) {
      throw new ForbiddenException(
        'The instructor has not opened the board for student edits',
      );
    }

    // Reserve limits atomically across API instances. This caps one class at
    // 120 assets / 150 MB even if an enrolled client automates uploads.
    const reserved = await this.redis.eval(
      `local count = redis.call('INCR', KEYS[1])
       local bytes = redis.call('INCRBY', KEYS[2], ARGV[1])
       if count > tonumber(ARGV[2]) or bytes > tonumber(ARGV[3]) then
         redis.call('DECR', KEYS[1])
         redis.call('DECRBY', KEYS[2], ARGV[1])
         return 0
       end
       return 1`,
      2,
      `board:asset-count:${sessionId}`,
      `board:asset-bytes:${sessionId}`,
      String(file.size),
      String(MAX_SESSION_ASSETS),
      String(MAX_SESSION_ASSET_BYTES),
    );
    if (Number(reserved) !== 1) {
      throw new HttpException(
        'This class has reached its board image limit',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const id = randomUUID();
    try {
      // Index first so retention cleanup can find a partially written asset if
      // the API process stops between object-store writes.
      await this.redis.sadd(`board:assets:${sessionId}`, id);
      await this.storage.put(assetKey(id), file.buffer, contentType);
      await this.storage.put(
        typeKey(id),
        Buffer.from(contentType, 'utf8'),
        'text/plain',
      );
      await this.storage.put(
        sessionKey(id),
        Buffer.from(sessionId, 'utf8'),
        'text/plain',
      );
      return { url: `/api/files/board-asset/${sessionId}/${id}` };
    } catch (error) {
      await Promise.allSettled([
        this.storage.delete(assetKey(id)),
        this.storage.delete(typeKey(id)),
        this.storage.delete(sessionKey(id)),
        this.redis.srem(`board:assets:${sessionId}`, id),
        this.redis.decr(`board:asset-count:${sessionId}`),
        this.redis.decrby(`board:asset-bytes:${sessionId}`, file.size),
      ]);
      throw error;
    }
  }

  /**
   * Fetch a Google file as PDF, so its pages can go on the board.
   *
   * An embedded Google file is a sealed iframe: it cannot be scrolled in step
   * for the class, drawn on, or edited. Rasterising its pages onto the board
   * trades live updates for the two things a lesson needs — everyone on the
   * same page, and room to write over it.
   *
   * Server-side because Google sends no CORS headers, so the browser cannot
   * make this request at all. The bytes are handed straight back rather than
   * stored: the page images the client produces are what get uploaded, and
   * keeping the source PDF as well would be a second copy of every import.
   */
  @Post('sessions/:id/board-google-import')
  async googleImport(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
    @Body() body: { url?: string },
  ) {
    const link = (body?.url ?? '').trim();
    if (!link) throw new BadRequestException('No link received');
    const exportUrl = googleExportUrl(link);
    if (!exportUrl) {
      throw new BadRequestException(
        'That link cannot be imported. Use a Google Doc, Sheet, Slides or Drive file.',
      );
    }
    const session = await this.assertParticipant(user, sessionId);
    if (session.status === SessionStatus.ENDED) {
      throw new ForbiddenException('Cannot import files into an ended class');
    }

    let res: Response;
    try {
      res = await fetch(exportUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new BadRequestException('Google did not answer. Try again.');
    }
    if (!res.ok) {
      throw new BadRequestException(
        `Google refused that file (${res.status}). Check it is shared with "anyone with the link".`,
      );
    }

    // A file that is not shared does not fail — Google answers 200 with a
    // sign-in page. The content type is the only thing that tells them apart.
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/pdf')) {
      throw new BadRequestException(
        'That file is not shared. Set it to "anyone with the link" in Google, then try again.',
      );
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_ASSET_BYTES) {
      throw new BadRequestException(
        'That file is larger than 20 MB. Import it in parts.',
      );
    }
    return new StreamableFile(buf, { type: 'application/pdf' });
  }

  /**
   * Serving one asset by its opaque id. Open to a recorder token as well as a
   * session: an image or PDF on the board is part of the lesson, and without
   * this a recording shows empty frames where the slides were.
   */
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @AllowRecorder()
  @Get('files/board-asset/:sessionId/:id')
  async serve(
    @CurrentUser() user: JwtPayload,
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ) {
    if (user.recorder) {
      if (user.recorder.sessionId !== sessionId) {
        throw new ForbiddenException('Recorder cannot access another session');
      }
    } else {
      await this.assertParticipant(user, sessionId);
    }

    const assetSize = await this.storage.size(assetKey(id));
    if (assetSize === null)
      throw new NotFoundException('Board asset not found');
    const owner = await this.storage.get(sessionKey(id));
    if (owner && owner.toString('utf8') !== sessionId) {
      throw new NotFoundException('Board asset not found');
    }
    // First read of an asset from an older board snapshot binds its opaque id
    // to the session that supplied the URL. Future reads are session checked.
    if (!owner) {
      await this.redis.sadd(`board:assets:${sessionId}`, id);
      await this.storage.put(
        sessionKey(id),
        Buffer.from(sessionId, 'utf8'),
        'text/plain',
      );
    }
    const ct = await this.storage.get(typeKey(id));
    const type = ct ? ct.toString('utf8') : DEFAULT_TYPE;
    if (
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)
    ) {
      throw new BadRequestException('Unsupported board image type');
    }
    const stream = await this.storage.getStream(assetKey(id));
    if (!stream) throw new NotFoundException('Board asset not found');
    return new StreamableFile(stream, { type });
  }

  /** Only participants of the session's course may upload board assets. */
  private async assertParticipant(user: JwtPayload, sessionId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        status: true,
        course: {
          select: { id: true, instructorId: true, organizationId: true },
        },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    const { course } = session;
    if (user.role === Role.INSTRUCTOR && course.instructorId === user.sub) {
      return session;
    }
    if (
      user.role === Role.ORG_ADMIN &&
      course.organizationId === user.organizationId
    ) {
      return session;
    }
    if (user.role === Role.STUDENT) {
      const enrolled = await this.prisma.enrollment.findUnique({
        where: {
          courseId_studentId: { courseId: course.id, studentId: user.sub },
        },
        select: { id: true },
      });
      if (enrolled) return session;
    }
    throw new ForbiddenException('Not a participant of this session');
  }
}
