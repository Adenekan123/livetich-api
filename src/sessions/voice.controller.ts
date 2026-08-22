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

/** Voice notes are short; keep them well under the general upload cap. */
const MAX_VOICE_BYTES = 10 * 1024 * 1024; // 10 MB
const voiceKey = (id: string) => `voice/${id}`;

/**
 * Voice notes for the live-class chat. The audio blob is uploaded here and
 * stored as an object; the socket (see `chat:voice`) then only carries the
 * resulting same-origin URL, which the web's `/api/files` proxy serves back
 * with auth. Root controller so `files/voice/:id` sits alongside
 * `files/submission/:id` behind that proxy.
 */
@Controller()
export class VoiceController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Post('sessions/:id/voice')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_VOICE_BYTES } }),
  )
  async upload(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
    @UploadedFile() file?: UploadedBlob,
  ) {
    if (!file) throw new BadRequestException('No audio received');
    if (!file.mimetype.startsWith('audio/')) {
      throw new BadRequestException('Voice notes must be audio');
    }
    if (file.size > MAX_VOICE_BYTES) {
      throw new BadRequestException('Voice note is larger than 10 MB');
    }
    await this.assertParticipant(user, sessionId);

    const id = randomUUID();
    await this.storage.put(voiceKey(id), file.buffer, file.mimetype);
    return { audioUrl: `/api/files/voice/${id}` };
  }

  @Get('files/voice/:id')
  async serve(@Param('id') id: string) {
    const stream = await this.storage.getStream(voiceKey(id));
    if (!stream) throw new NotFoundException('Voice note not found');
    // MediaRecorder emits WebM/Opus in every browser we target; the tag sniffs
    // the actual codec, so this type is just a sane default.
    return new StreamableFile(stream, { type: 'audio/webm' });
  }

  /** Only participants of the session's course may attach voice notes. */
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
