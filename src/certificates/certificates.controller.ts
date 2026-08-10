import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import { certificateKey } from './certificates.constants';
import { CertificatesService } from './certificates.service';
import { IssueCertificateDto } from './dto/issue-certificate.dto';

@Controller('certificates')
export class CertificatesController {
  constructor(
    private readonly certificates: CertificatesService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Post()
  @Roles(Role.ORG_ADMIN)
  issue(@CurrentUser() user: JwtPayload, @Body() dto: IssueCertificateDto) {
    return this.certificates.issue(user, dto);
  }

  @Get('mine')
  @Roles(Role.STUDENT)
  mine(@CurrentUser() user: JwtPayload) {
    return this.certificates.listMine(user.sub);
  }

  @Get('course/:courseId')
  @Roles(Role.ORG_ADMIN)
  forCourse(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.certificates.listForCourse(user, courseId);
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
    const stream = await this.storage.getStream(certificateKey(cert.id));
    if (!stream) {
      throw new NotFoundException('PDF not generated yet — try again shortly');
    }
    return new StreamableFile(stream, {
      type: 'application/pdf',
      disposition: `attachment; filename="certificate-${cert.verificationCode}.pdf"`,
    });
  }
}
