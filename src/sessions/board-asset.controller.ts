import {
  BadRequestException,
  Body,
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
import { AllowRecorder } from '../auth/jwt-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { PrismaService } from '../prisma/prisma.service';
import { googleExportUrl } from './google-export';
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
    await this.assertParticipant(user, sessionId);

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
  @AllowRecorder()
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
