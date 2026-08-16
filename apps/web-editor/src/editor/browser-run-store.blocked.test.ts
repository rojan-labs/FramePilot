import { describe, expect, it, vi } from 'vitest';
import { IndexedDbRunStoreIO } from './browser-run-store.js';

describe('IndexedDbRunStoreIO blocked open lifecycle', () => {
  it('closes a database that succeeds after the blocked open already rejected', async () => {
    const close = vi.fn();
    const database = { close } as unknown as IDBDatabase;
    const request = {
      result: database,
      error: null,
      transaction: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    } as unknown as IDBOpenDBRequest;
    const open = vi.fn(() => request);
    const factory = { open } as unknown as IDBFactory;
    const store = new IndexedDbRunStoreIO(factory);

    const pending = store.listRunIds();
    request.onblocked?.({} as unknown as IDBVersionChangeEvent);
    await expect(pending).rejects.toThrow('blocked');

    // IndexedDB may later deliver success on the same open request when the other tab closes.
    // Since the caller already received a rejection, that connection has no owner and must close.
    request.onsuccess?.({} as Event);
    expect(close).toHaveBeenCalledOnce();

    // A later caller must create a new open request rather than inherit the rejected promise.
    void store.listRunIds().catch(() => undefined);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
