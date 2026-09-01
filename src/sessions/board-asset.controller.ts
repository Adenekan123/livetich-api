import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';

interface UploadedBlob {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** Rasterised PDF pages / pasted images. Generous vs. voice, capped so one
 *  slide can't blow up the store or a socket message. */
const MAX_ASSET_BYTES = 20 * 1024 * 1024; // 20 MB
const assetKey = (id: string) => `board-asset/${id}`;
// The store can't hand back a content-type on read, so persist it beside the
// blob and replay it on serve (falls back to PNG — the web rasterises to PNG).
const typeKey = (id: string) => `board-asset/${id}.ct`;
const DEFAULT_TYPE = 'image/png';

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
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Board assets must be images');
    }
    if (file.size > MAX_ASSET_BYTES) {
      throw new BadRequestException('Board image is larger than 20 MB');
    }
    await this.assertParticipant(user, sessionId);

    const id = randomUUID();
    await this.storage.put(assetKey(id), file.buffer, file.mimetype);
    await this.storage.put(
      typeKey(id),
      Buffer.from(file.mimetype, 'utf8'),
      'text/plain',
    );
    return { url: `/api/files/board-asset/${id}` };
  }

  @Get('files/board-asset/:id')
  async serve(@Param('id') id: string) {
    const stream = await this.storage.getStream(assetKey(id));
    if (!stream) throw new NotFoundException('Board asset not found');
    const ct = await this.storage.get(typeKey(id));
    const type = ct ? ct.toString('utf8') : DEFAULT_TYPE;
    return new StreamableFile(stream, { type });
  }

  /** Only participants of the session's course may upload board assets. */
  private async assertParticipant(user: JwtPayload, sessionId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        course: {
          select: { id: true, instructorId: true, organizationId: true },
        },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    const { course } = session;
    if (user.role === Role.INSTRUCTOR && course.instructorId === user.sub) {
      return;
    }
    if (
      user.role === Role.ORG_ADMIN &&
      course.organizationId === user.organizationId
    ) {
      return;
    }
    if (user.role === Role.STUDENT) {
      const enrolled = await this.prisma.enrollment.findUnique({
        where: {
          courseId_studentId: { courseId: course.id, studentId: user.sub },
        },
        select: { id: true },
      });
      if (enrolled) return;
    }
    throw new ForbiddenException('Not a participant of this session');
  }
}
