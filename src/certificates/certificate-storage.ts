import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Local-disk storage for generated certificate PDFs. Swap the internals for
 * Cloudflare R2 (S3 API) once credentials exist — callers only see
 * write()/pathFor().
 */
@Injectable()
export class CertificateStorage {
  private readonly dir: string;

  constructor(config: ConfigService) {
    this.dir =
      config.get<string>('CERT_STORAGE_DIR') ??
      join(process.cwd(), 'storage', 'certificates');
  }

  pathFor(certificateId: string): string {
    return join(this.dir, `${certificateId}.pdf`);
  }

  async write(certificateId: string, pdf: Buffer): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const path = this.pathFor(certificateId);
    await writeFile(path, pdf);
    return path;
  }
}
