import * as Y from 'yjs';
import type { ObjectStorage } from '../storage/object-storage';
import { BoardDocService } from './board-doc.service';

describe('BoardDocService persistence', () => {
  const sessionId = 'board-save-retry';
  let storage: jest.Mocked<ObjectStorage>;
  let service: BoardDocService;

  beforeEach(() => {
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      getStream: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue(undefined),
      size: jest.fn().mockResolvedValue(null),
      signedUrl: jest.fn().mockResolvedValue(null),
    };
    service = new BoardDocService(storage);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  function updateWith(key: string, value: string): Uint8Array {
    const source = new Y.Doc();
    source.getMap<string>('test').set(key, value);
    return Y.encodeStateAsUpdate(source);
  }

  it('keeps a dirty document after a failed final write and persists it on retry', async () => {
    storage.put.mockRejectedValueOnce(new Error('temporary storage outage'));
    await service.retain(sessionId);
    service.applyUpdate(sessionId, updateWith('lesson', 'saved after retry'));

    // A failed flush must not destroy the in-memory Y.Doc.
    await expect(service.release(sessionId)).resolves.toBe(true);
    expect(service.encodeState(sessionId)).not.toBeNull();

    await (
      service as unknown as { flushDirty: () => Promise<void> }
    ).flushDirty();
    expect(storage.put.mock.calls).toHaveLength(2);
    expect(service.encodeState(sessionId)).toBeNull();

    const saved = new Y.Doc();
    Y.applyUpdate(saved, storage.put.mock.calls[1][1]);
    expect(saved.getMap<string>('test').get('lesson')).toBe(
      'saved after retry',
    );
    saved.destroy();
  });

  it('does not mark a snapshot clean when an edit arrives during the storage write', async () => {
    let finishFirstWrite!: () => void;
    storage.put
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstWrite = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    await service.retain(sessionId);
    service.applyUpdate(sessionId, updateWith('first', 'one'));
    const releasing = service.release(sessionId);
    await Promise.resolve();
    service.applyUpdate(sessionId, updateWith('second', 'two'));
    finishFirstWrite();
    await releasing;

    expect(storage.put.mock.calls).toHaveLength(2);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, storage.put.mock.calls[1][1]);
    expect(saved.getMap<string>('test').toJSON()).toEqual({
      first: 'one',
      second: 'two',
    });
    saved.destroy();
  });
});
