import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { createReadStream } from 'node:fs';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { CertificateStorage } from './certificate-storage';
import { CertificatesService } from './certificates.service';
import { IssueCertificateDto } from './dto/issue-certificate.dto';

@Controller('certificates')
export class CertificatesController {
  constructor(
    private readonly certificates: CertificatesService,
    private readonly storage: CertificateStorage,
  ) {}

  @Post()
  @Roles(Role.INSTRUCTOR)
  issue(@CurrentUser() user: JwtPayload, @Body() dto: IssueCertificateDto) {
    return this.certificates.issue(user.sub, dto);
  }

  @Get('mine')
  @Roles(Role.STUDENT)
  mine(@CurrentUser() user: JwtPayload) {
    return this.certificates.listMine(user.sub);
  }

  @Get('course/:courseId')
  @Roles(Role.INSTRUCTOR)
  forCourse(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.certificates.listForCourse(user.sub, courseId);
  }

  /** QR-code target — no auth so anyone can scan and verify. */
  @Public()
  @Get('verify/:code')
  verify(@Param('code') code: string) {
    return this.certificates.verify(code);
  }

  @Get(':id/download')
  async download(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const cert = await this.certificates.getForDownload(user.sub, id);
    return new StreamableFile(createReadStream(this.storage.pathFor(cert.id)), {
      type: 'application/pdf',
      disposition: `attachment; filename="certificate-${cert.verificationCode}.pdf"`,
    });
  }
}
