import { describe, expect, it } from 'vitest';
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

const snapshot: RecoverySnapshot = {
  path: '/projects/demo.fp.json',
  project: { id: 'p1', name: 'Demo' },
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
});
