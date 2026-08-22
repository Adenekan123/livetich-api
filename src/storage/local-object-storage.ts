import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { ObjectStorage } from './object-storage';

/** Disk-backed storage; keys map to files under a base directory. */
export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly baseDir: string) {}

  private pathFor(key: string): string {
    return join(this.baseDir, key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      return null;
    }
  }

  getStream(key: string): Promise<Readable | null> {
    const path = this.pathFor(key);
    return new Promise((resolve) => {
      const stream = createReadStream(path);
      stream.once('open', () => resolve(stream));
      stream.once('error', () => resolve(null));
    });
  }
}
