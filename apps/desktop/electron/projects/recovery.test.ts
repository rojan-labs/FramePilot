import { describe, expect, it } from 'vitest';
import { parseProject } from '@framepilot/timeline-schema';
import { RecoveryStore, type RecoverySnapshot } from './recovery.js';

/** In-memory {@link RecoveryIO}. */
function fakeIO(initial: string | null = null) {
  let store = initial;
  return {
    read: () => Promise.resolve(store),
    write: (contents: string) => {
      store = contents;
      return Promise.resolve();
    },
    clear: () => {
      store = null;
      return Promise.resolve();
    },
    get current(): string | null {
      return store;
    },
  };
}

/**
 * A REAL project, parsed through the schema. The old fixture was `{ id: 'p1', name: 'Demo' }`
 * — enough for a check that only asked whether a `project` key existed, and exactly the kind
 * of payload a restore path could not open.
 */
const snapshot: RecoverySnapshot = {
  path: '/projects/demo.fp.json',
  project: parseProject({
    id: 'p1',
    name: 'Demo',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [],
    timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
    transcript: [],
    aiMemory: {},
    history: [],
  }),
  savedAt: 1234,
};

describe('RecoveryStore', () => {
  it('reports no pending snapshot when none was written', async () => {
    const store = new RecoveryStore(fakeIO(null));
    expect(await store.pending()).toBeNull();
  });

  it('round-trips a written snapshot', async () => {
    const io = fakeIO();
    const store = new RecoveryStore(io);

    await store.snapshot(snapshot);

    expect(await store.pending()).toEqual(snapshot);
  });

  it('clears the snapshot on a clean quit', async () => {
    const io = fakeIO();
    const store = new RecoveryStore(io);

    await store.snapshot(snapshot);
    await store.clear();

    expect(await store.pending()).toBeNull();
    expect(io.current).toBeNull();
  });

  it('treats a corrupt snapshot file as no pending recovery', async () => {
    const store = new RecoveryStore(fakeIO('{ broken'));
    expect(await store.pending()).toBeNull();
  });

  it('rejects a snapshot missing required fields', async () => {
    const store = new RecoveryStore(fakeIO(JSON.stringify({ path: '/x', savedAt: 1 })));
    expect(await store.pending()).toBeNull();
  });

  it('rejects a non-object snapshot payload', async () => {
    const store = new RecoveryStore(fakeIO('42'));
    expect(await store.pending()).toBeNull();
  });

  it('rejects a snapshot whose project is not a valid project document', async () => {
    // The old guard only asked whether a `project` key existed, so this passed — and a
    // restore path would have handed the editor something it cannot open.
    const store = new RecoveryStore(
      fakeIO(JSON.stringify({ path: '/x', savedAt: 1, project: { id: 'p1', name: 'Demo' } })),
    );
    expect(await store.pending()).toBeNull();
  });

  it('rejects a snapshot whose project is null', async () => {
    const store = new RecoveryStore(
      fakeIO(JSON.stringify({ path: '/x', savedAt: 1, project: null })),
    );
    expect(await store.pending()).toBeNull();
  });
});
