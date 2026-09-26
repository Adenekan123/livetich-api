import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { ObjectStorage } from './object-storage';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Cloudflare R2 via the S3 API (region "auto", account-scoped endpoint). */
export class R2ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: R2Config) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getStream(key: string): Promise<Readable | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      // In Node the S3 body is a Readable stream.
      return (res.Body as Readable) ?? null;
    } catch (e) {
      if (e instanceof NoSuchKey) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async size(key: string): Promise<number | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return res.ContentLength ?? null;
    } catch (e) {
      if (e instanceof NotFound || e instanceof NoSuchKey) return null;
      throw e;
    }
  }

  /**
   * A presigned GET, so a recording streams from R2 straight to the browser
   * rather than through this API. `downloadAs` sets the filename the browser
   * saves it under, via a response-header override on the signature.
   */
  async signedUrl(
    key: string,
    opts: { expiresInSeconds?: number; downloadAs?: string } = {},
  ): Promise<string | null> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ...(opts.downloadAs
        ? {
            ResponseContentDisposition: `attachment; filename="${opts.downloadAs.replace(
              /"/g,
              '',
            )}"`,
          }
        : {}),
    });
    // The presigner resolves its own copy of the smithy middleware types, so
    // the compiler sees two structurally identical S3Client types with private
    // fields and refuses them. It is the same client at runtime; this asserts
    // that rather than pinning the whole AWS dependency tree to one revision.
    return getSignedUrl(
      this.client as unknown as Parameters<typeof getSignedUrl>[0],
      command as unknown as Parameters<typeof getSignedUrl>[1],
      { expiresIn: opts.expiresInSeconds ?? 3600 },
    );
  }

  async get(key: string): Promise<Buffer | null> {
    const stream = await this.getStream(key);
    if (!stream) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
}
