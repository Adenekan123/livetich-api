import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { LocalObjectStorage } from './local-object-storage';
import { OBJECT_STORAGE, ObjectStorage } from './object-storage';
import { R2ObjectStorage } from './r2-object-storage';

/**
 * Provides the app-wide {@link ObjectStorage}. Uses Cloudflare R2 when all
 * R2_* credentials are set, otherwise falls back to local disk so dev works
 * with no cloud account.
 */
@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ObjectStorage => {
        const logger = new Logger('ObjectStorage');
        const accountId = config.get<string>('R2_ACCOUNT_ID');
        const accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
        const secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');
        const bucket = config.get<string>('R2_BUCKET');

        if (accountId && accessKeyId && secretAccessKey && bucket) {
          logger.log(`Using Cloudflare R2 bucket "${bucket}"`);
          return new R2ObjectStorage({
            accountId,
            accessKeyId,
            secretAccessKey,
            bucket,
          });
        }

        const dir =
          config.get<string>('STORAGE_DIR') ?? join(process.cwd(), 'storage');
        logger.log(`R2 not configured — using local disk at ${dir}`);
        return new LocalObjectStorage(dir);
      },
    },
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
