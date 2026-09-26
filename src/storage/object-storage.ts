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

  /** Remove an object. Succeeds whether or not it was there. */
  delete(key: string): Promise<void>;

  /** Size in bytes, without reading the object. Null if absent. */
  size(key: string): Promise<number | null>;

  /**
   * A time-limited URL that plays or downloads the object directly from the
   * store, so a class recording never passes through this API.
   *
   * Null when the backend cannot issue one — local disk in development has no
   * signing, and callers fall back to streaming it themselves.
   */
  signedUrl(
    key: string,
    opts?: { expiresInSeconds?: number; downloadAs?: string },
  ): Promise<string | null>;
}
