/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment --
   The in-memory Redis stands in for an async client, so its commands are async
   without awaiting anything; reflect-metadata's getMetadata is typed `any`. */
import type Redis from 'ioredis';
import type { TajweedTemporaryAnnotation } from '../shared';
import { RoomStateService } from './room-state.service';

/** The handful of hash commands live annotations use, kept in memory. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  return {
    hashes,
    redis: {
      hexists: jest.fn(async (k: string, f: string) =>
        hash(k).has(f) ? 1 : 0,
      ),
      hlen: jest.fn(async (k: string) => hash(k).size),
      hset: jest.fn(
        async (k: string, f: string, v: string) => void hash(k).set(f, v),
      ),
      hdel: jest.fn(async (k: string, ...fs: string[]) =>
        fs.forEach((f) => hash(k).delete(f)),
      ),
      hgetall: jest.fn(async (k: string) => Object.fromEntries(hash(k))),
      del: jest.fn(async (k: string) => void hashes.delete(k)),
      expire: jest.fn(async () => 1),
    },
  };
}

const live = (
  id: string,
  over: Partial<TajweedTemporaryAnnotation> = {},
): TajweedTemporaryAnnotation => ({
  id,
  surahNumber: 113,
  ayahNumber: 3,
  selection: 'WORD',
  wordStart: 0,
  wordEnd: 0,
  letterStart: null,
  letterEnd: null,
  rule: 'ikhfa',
  customLabel: null,
  style: 'HIGHLIGHT',
  color: null,
  note: null,
  expiresAt: null,
  ...over,
});

describe('RoomStateService — live Tajweed annotations', () => {
  it('shows, replaces and clears live annotations for a session only', async () => {
    const { redis } = fakeRedis();
    const state = new RoomStateService(redis as unknown as Redis);

    await state.setTajweedTemporary('s1', live('live-0001'));
    await state.setTajweedTemporary('s1', live('live-0001', { rule: 'madd' }));
    await state.setTajweedTemporary('s1', live('live-0002'));
    await state.setTajweedTemporary('s2', live('live-0003'));

    const s1 = await state.listTajweedTemporary('s1');
    expect(s1.map((a) => [a.id, a.rule]).sort()).toEqual([
      ['live-0001', 'madd'],
      ['live-0002', 'ikhfa'],
    ]);

    await state.clearTajweedTemporary('s1', 'live-0001');
    expect((await state.listTajweedTemporary('s1')).map((a) => a.id)).toEqual([
      'live-0002',
    ]);

    await state.clearTajweedTemporary('s1');
    expect(await state.listTajweedTemporary('s1')).toEqual([]);
    expect(await state.listTajweedTemporary('s2')).toHaveLength(1);
  });

  it('drops an annotation once it has expired, and never sends it to a late joiner', async () => {
    const { redis } = fakeRedis();
    const state = new RoomStateService(redis as unknown as Redis);

    await state.setTajweedTemporary(
      's1',
      live('gone-0001', {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    await state.setTajweedTemporary(
      's1',
      live('kept-0001', {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    expect((await state.listTajweedTemporary('s1')).map((a) => a.id)).toEqual([
      'kept-0001',
    ]);
    expect(redis.hdel).toHaveBeenCalledWith(expect.any(String), 'gone-0001');
  });

  it('refuses a new live annotation past the per-session ceiling, but still allows replacing one', async () => {
    const { redis } = fakeRedis();
    const state = new RoomStateService(redis as unknown as Redis);
    for (let i = 0; i < 50; i++) {
      expect(
        await state.setTajweedTemporary(
          's1',
          live(`live-${String(i).padStart(4, '0')}`),
        ),
      ).toBe(true);
    }
    expect(await state.setTajweedTemporary('s1', live('live-over'))).toBe(
      false,
    );
    expect(
      await state.setTajweedTemporary(
        's1',
        live('live-0000', { rule: 'madd' }),
      ),
    ).toBe(true);
  });

  it('never writes a live annotation anywhere but the session state', () => {
    // RoomStateService holds Redis and nothing else: there is no database client
    // for a live annotation to reach, which is the guarantee this test pins.
    const params =
      Reflect.getMetadata('design:paramtypes', RoomStateService) ?? [];
    expect(params).toHaveLength(1);
  });
});
