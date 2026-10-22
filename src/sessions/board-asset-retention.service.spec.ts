import * as Y from 'yjs';
import type { PrismaService } from '../prisma/prisma.service';
import type { ObjectStorage } from '../storage/object-storage';
import { BoardAssetRetentionService } from './board-asset-retention.service';

describe('BoardAssetRetentionService', () => {
  const sessionId = 'expired-session';
  let service: BoardAssetRetentionService;
  let storage: jest.Mocked<ObjectStorage>;
  let prisma: { liveSession: { findMany: jest.Mock } };
  let redis: {
    smembers: jest.Mock;
    scard: jest.Mock;
    srem: jest.Mock;
    sadd: jest.Mock;
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };

  beforeEach(() => {
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      getStream: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue(undefined),
      size: jest.fn().mockResolvedValue(null),
      signedUrl: jest.fn().mockResolvedValue(null),
    };
    prisma = {
      liveSession: {
        findMany: jest.fn().mockResolvedValue([{ id: sessionId }]),
      },
    };
    redis = {
      smembers: jest.fn().mockResolvedValue([]),
      scard: jest.fn().mockResolvedValue(0),
      srem: jest.fn().mockResolvedValue(1),
      sadd: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    service = new BoardAssetRetentionService(
      prisma as unknown as PrismaService,
      redis as never,
      storage,
    );
  });

  function boardSnapshot(url: string): Buffer {
    const doc = new Y.Doc();
    doc.getMap('excalidraw-files').set('file', { url });
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc));
    doc.destroy();
    return snapshot;
  }

  it('cleans referenced legacy assets as well as indexed uploads', async () => {
    const assetId = '0e0fd7d6-3380-4b61-9978-414fa22d9e90';
    storage.get.mockResolvedValueOnce(
      boardSnapshot(`/api/files/board-asset/${sessionId}/${assetId}`),
    );

    await service.removeExpiredAssets();

    expect(storage.delete.mock.calls.map(([key]) => key)).toContain(
      `board-asset/${assetId}`,
    );
    expect(storage.delete.mock.calls.map(([key]) => key)).toContain(
      `boards/${sessionId}.bin`,
    );
  });

  it('does not turn a malicious board URL into a storage path', async () => {
    storage.get.mockResolvedValueOnce(
      boardSnapshot('/api/files/board-asset/../../../../outside'),
    );

    await service.removeExpiredAssets();

    expect(
      storage.delete.mock.calls.some(([key]) =>
        String(key).includes('outside'),
      ),
    ).toBe(false);
    expect(storage.delete.mock.calls.map(([key]) => key)).toContain(
      `boards/${sessionId}.bin`,
    );
  });
});
