import { describe, expect, it } from 'vitest';
import { ActiveProjectStore } from './active-project.js';
import type { ActiveProjectPointer } from '@framepilot/shared-types/projects-root';

/** In-memory {@link ActiveProjectIO}. */
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
    get state(): string | null {
      return store;
    },
  };
}

const pointer: ActiveProjectPointer = {
  path: '/projects/demo.fp.json',
  projectId: 'project_demo',
  updatedAt: 1234,
};

describe('ActiveProjectStore', () => {
  it('reports no pointer when none was written', async () => {
    const store = new ActiveProjectStore(fakeIO(null));
    expect(await store.current()).toBeNull();
  });

  it('round-trips a recorded pointer', async () => {
    const io = fakeIO();
    const store = new ActiveProjectStore(io);

    await store.record(pointer);
    expect(await store.current()).toEqual(pointer);
  });

  it('returns null for a corrupt pointer file', async () => {
    const store = new ActiveProjectStore(fakeIO('{ not json'));
    expect(await store.current()).toBeNull();
  });

  it('returns null when the file holds a structurally invalid pointer', async () => {
    const store = new ActiveProjectStore(fakeIO(JSON.stringify({ path: '/p' })));
    expect(await store.current()).toBeNull();
  });

  it('clears the pointer', async () => {
    const io = fakeIO();
    const store = new ActiveProjectStore(io);
    await store.record(pointer);
    await store.clear();
    expect(io.state).toBeNull();
    expect(await store.current()).toBeNull();
  });
});
