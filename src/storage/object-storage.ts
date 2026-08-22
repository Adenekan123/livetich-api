import type { Readable } from 'node:stream';

/** DI token for the active {@link ObjectStorage} implementation. */
export const OBJECT_STORAGE = 'OBJECT_STORAGE';

/**
 * Minimal object store used for certificate PDFs and board snapshots.
 * Backed by local disk in dev and Cloudflare R2 (S3 API) in production;
 * callers only deal in string keys like `certificates/<id>.pdf`.
 */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Whole-object read (small blobs, e.g. board snapshots). Null if absent. */
  get(key: string): Promise<Buffer | null>;
  /** Streamed read (large blobs, e.g. PDF downloads). Null if absent. */
  getStream(key: string): Promise<Readable | null>;
}
