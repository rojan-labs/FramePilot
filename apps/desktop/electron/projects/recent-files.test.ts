import { describe, expect, it } from 'vitest';
import { MAX_RECENT_PROJECTS, RecentFilesStore } from './recent-files.js';
import type { RecentProject } from '../ipc/contract.js';

/** In-memory {@link RecentFilesIO} that records the last-written contents. */
function fakeIO(initial: string | null = null) {
  let store = initial;
  return {
    read: () => Promise.resolve(store),
    write: (contents: string) => {
      store = contents;
      return Promise.resolve();
    },
    get current(): string | null {
      return store;
    },
  };
}

const entry = (path: string, openedAt: number): RecentProject => ({
  path,
  name: path.split('/').pop() ?? path,
  openedAt,
});

describe('RecentFilesStore', () => {
  it('returns an empty list when the file does not exist', async () => {
    const store = new RecentFilesStore(fakeIO(null));
    expect(await store.list()).toEqual([]);
  });

  it('returns an empty list when the file is corrupt JSON', async () => {
    const store = new RecentFilesStore(fakeIO('{ not json'));
    expect(await store.list()).toEqual([]);
  });

  it('returns an empty list when the JSON is not an array', async () => {
    const store = new RecentFilesStore(fakeIO('{"path":"/a"}'));
    expect(await store.list()).toEqual([]);
  });

  it('drops entries that do not match the RecentProject shape', async () => {
    const io = fakeIO(
      JSON.stringify([
        entry('/a/project.fp.json', 1),
        { path: '/b', name: 'b' }, // missing openedAt
        { path: 5, name: 'bad', openedAt: 2 }, // wrong type
        null, // not an object
        'just a string', // primitive entry
      ]),
    );
    const store = new RecentFilesStore(io);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.path).toBe('/a/project.fp.json');
  });

  it('prepends new entries most-recent-first and persists them', async () => {
    const io = fakeIO();
    const store = new RecentFilesStore(io);

    await store.add(entry('/a.fp.json', 1));
    const list = await store.add(entry('/b.fp.json', 2));

    expect(list.map((e) => e.path)).toEqual(['/b.fp.json', '/a.fp.json']);
    expect(JSON.parse(io.current ?? '[]')).toHaveLength(2);
  });

  it('de-duplicates by path, moving a re-opened project to the front', async () => {
    const io = fakeIO();
    const store = new RecentFilesStore(io);

    await store.add(entry('/a.fp.json', 1));
    await store.add(entry('/b.fp.json', 2));
    const list = await store.add(entry('/a.fp.json', 3));

    expect(list.map((e) => e.path)).toEqual(['/a.fp.json', '/b.fp.json']);
    expect(list[0]?.openedAt).toBe(3);
  });

  it('caps the list at the configured maximum', async () => {
    const io = fakeIO();
    const store = new RecentFilesStore(io, 3);

    for (let i = 0; i < 5; i += 1) {
      await store.add(entry(`/p${i}.fp.json`, i));
    }
    const list = await store.list();

    expect(list).toHaveLength(3);
    expect(list.map((e) => e.path)).toEqual(['/p4.fp.json', '/p3.fp.json', '/p2.fp.json']);
  });

  it('removes an entry by path', async () => {
    const io = fakeIO(JSON.stringify([entry('/a.fp.json', 1), entry('/b.fp.json', 2)]));
    const store = new RecentFilesStore(io);

    const list = await store.remove('/a.fp.json');

    expect(list.map((e) => e.path)).toEqual(['/b.fp.json']);
  });

  it('defaults the cap to MAX_RECENT_PROJECTS', async () => {
    const io = fakeIO();
    const store = new RecentFilesStore(io);

    for (let i = 0; i < MAX_RECENT_PROJECTS + 4; i += 1) {
      await store.add(entry(`/p${i}.fp.json`, i));
    }

    expect(await store.list()).toHaveLength(MAX_RECENT_PROJECTS);
  });
});
