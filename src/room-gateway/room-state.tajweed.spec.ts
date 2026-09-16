/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment --
   The in-memory Redis stands in for an async client, so its commands are async
   without awaiting anything; reflect-metadata's getMetadata is typed `any`. */
import type Redis from 'ioredis';
import type { TajweedTemporaryAnnotation } from '../shared';
import { RoomStateService } from './room-state.service';

/** The handful of commands live annotations and pointing use, kept in memory. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const hash = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  return {
    hashes,
    strings,
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
      set: jest.fn(async (k: string, v: string) => void strings.set(k, v)),
      get: jest.fn(async (k: string) => strings.get(k) ?? null),
      del: jest.fn(async (k: string) => {
        hashes.delete(k);
        strings.delete(k);
      }),
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
  parts: [{ surahNumber: 113, ayahNumber: 3, wordIndex: 0, letterIndex: null }],
  rule: 'nun.ikhfa_haqiqi',
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
    await state.setTajweedTemporary(
      's1',
      live('live-0001', { rule: 'madd.tabii' }),
    );
    await state.setTajweedTemporary('s1', live('live-0002'));
    await state.setTajweedTemporary('s2', live('live-0003'));

    const s1 = await state.listTajweedTemporary('s1');
    expect(s1.map((a) => [a.id, a.rule]).sort()).toEqual([
      ['live-0001', 'madd.tabii'],
      ['live-0002', 'nun.ikhfa_haqiqi'],
    ]);

    await state.clearTajweedTemporary('s1', 'live-0001');
    expect((await state.listTajweedTemporary('s1')).map((a) => a.id)).toEqual([
      'live-0002',
    ]);

    await state.clearTajweedTemporary('s1');
    expect(await state.listTajweedTemporary('s1')).toEqual([]);
    expect(await state.listTajweedTemporary('s2')).toHaveLength(1);
  });

  it('keeps the parts of a live mark, across two ayahs', async () => {
    const { redis } = fakeRedis();
    const state = new RoomStateService(redis as unknown as Redis);
    const parts = [
      { surahNumber: 113, ayahNumber: 3, wordIndex: 4, letterIndex: 1 },
      { surahNumber: 113, ayahNumber: 4, wordIndex: 0, letterIndex: 0 },
    ];

    await state.setTajweedTemporary('s1', live('live-0001', { parts }));
    expect((await state.listTajweedTemporary('s1'))[0].parts).toEqual(parts);
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
        live('live-0000', { rule: 'madd.tabii' }),
      ),
    ).toBe(true);
  });

  it('remembers what the instructor is pointing at, per session, until it is cleared', async () => {
    const { redis } = fakeRedis();
    const state = new RoomStateService(redis as unknown as Redis);
    const parts = [
      { surahNumber: 113, ayahNumber: 3, wordIndex: 4, letterIndex: 1 },
      { surahNumber: 113, ayahNumber: 4, wordIndex: 0, letterIndex: 0 },
    ];

    await state.setTajweedPointing('s1', parts);
    expect(await state.getTajweedPointing('s1')).toEqual(parts);
    // Another room is not pointing anywhere.
    expect(await state.getTajweedPointing('s2')).toEqual([]);

    // An empty list is how pointing goes away.
    await state.setTajweedPointing('s1', []);
    expect(await state.getTajweedPointing('s1')).toEqual([]);
  });

  it('treats unreadable pointing state as nothing pointed at', async () => {
    const { redis, strings } = fakeRedis();
    const state = new RoomStateService(redis as unknown as Redis);
    await state.setTajweedPointing('s1', [
      { surahNumber: 113, ayahNumber: 1, wordIndex: 0, letterIndex: null },
    ]);
    strings.set([...strings.keys()][0], 'not json');
    expect(await state.getTajweedPointing('s1')).toEqual([]);
  });

  it('never writes a live annotation anywhere but the session state', () => {
    // RoomStateService holds Redis and nothing else: there is no database client
    // for a live annotation to reach, which is the guarantee this test pins.
    const params =
      Reflect.getMetadata('design:paramtypes', RoomStateService) ?? [];
    expect(params).toHaveLength(1);
  });
});
