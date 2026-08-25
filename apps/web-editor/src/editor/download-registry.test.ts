/**
 * The registry exists so a download outlives the panel that started it. These
 * tests hold it to the two properties that makes it worth having: the state is
 * still correct when nobody is watching, and the IPC listener's life matches the
 * work rather than the app's.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDownloadRegistry, type DownloadProgressMessage } from './download-registry.js';

/** A fake progress feed that records how many times it was subscribed to. */
function fakeFeed(): {
  subscribe: (listener: (message: DownloadProgressMessage) => void) => () => void;
  emit: (message: DownloadProgressMessage) => void;
  subscribeCount: () => number;
  listenerCount: () => number;
} {
  let listeners: Array<(message: DownloadProgressMessage) => void> = [];
  let subscribes = 0;
  return {
    subscribe: (listener) => {
      subscribes += 1;
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((candidate) => candidate !== listener);
      };
    },
    emit: (message) => {
      for (const listener of [...listeners]) listener(message);
    },
    subscribeCount: () => subscribes,
    listenerCount: () => listeners.length,
  };
}

function progress(overrides: Partial<DownloadProgressMessage> = {}): DownloadProgressMessage {
  return {
    remoteId: 'a',
    phase: 'downloading',
    completedBytes: 25,
    totalBytes: 100,
    ...overrides,
  };
}

describe('createDownloadRegistry', () => {
  it('does not touch the IPC feed until something is actually downloading', () => {
    const feed = fakeFeed();
    const registry = createDownloadRegistry(feed.subscribe);
    expect(feed.subscribeCount()).toBe(0);

    registry.start('a', 'op-1');
    expect(feed.subscribeCount()).toBe(1);
  });

  it('drops the listener once nothing is outstanding', () => {
    const feed = fakeFeed();
    const registry = createDownloadRegistry(feed.subscribe);
    registry.start('a', 'op-1');
    registry.start('b', 'op-2');
    registry.clear('a');
    expect(feed.listenerCount()).toBe(1);

    registry.clear('b');
    expect(feed.listenerCount()).toBe(0);
  });

  it('keeps the operation id, so Cancel still works after a remount', () => {
    const registry = createDownloadRegistry(fakeFeed().subscribe);
    registry.start('a', 'op-1');
    expect(registry.getSnapshot()['a']).toEqual({
      kind: 'downloading',
      operationId: 'op-1',
      percent: null,
    });
  });

  it('records progress against the item it belongs to and leaves the rest alone', () => {
    const feed = fakeFeed();
    const registry = createDownloadRegistry(feed.subscribe);
    registry.start('a', 'op-1');
    registry.start('b', 'op-2');

    feed.emit(progress({ remoteId: 'a', completedBytes: 60, totalBytes: 200 }));

    expect(registry.getSnapshot()['a']).toMatchObject({ percent: 30 });
    expect(registry.getSnapshot()['b']).toMatchObject({ percent: null });
  });

  it('reports an unknown total as indeterminate rather than as zero percent', () => {
    // A bar pinned at 0% reads as "stuck". `null` renders as indeterminate.
    const feed = fakeFeed();
    const registry = createDownloadRegistry(feed.subscribe);
    registry.start('a', 'op-1');

    feed.emit(progress({ completedBytes: 4096, totalBytes: 0 }));

    expect(registry.getSnapshot()['a']).toMatchObject({ percent: null });
  });

  it('ignores progress for an item it is not tracking, and non-download phases', () => {
    const feed = fakeFeed();
    const registry = createDownloadRegistry(feed.subscribe);
    registry.start('a', 'op-1');
    const listener = vi.fn();
    registry.subscribe(listener);

    feed.emit(progress({ remoteId: 'gone' }));
    feed.emit(progress({ phase: 'deriving', completedBytes: 100, totalBytes: 100 }));

    expect(listener).not.toHaveBeenCalled();
    expect(registry.getSnapshot()['a']).toMatchObject({ percent: null });
  });

  it('does not re-notify when a progress message repeats the same percent', () => {
    // Byte-level progress arrives far more often than the percent changes, and
    // every notification is a re-render of the whole grid.
    const feed = fakeFeed();
    const registry = createDownloadRegistry(feed.subscribe);
    registry.start('a', 'op-1');
    const listener = vi.fn();
    registry.subscribe(listener);

    feed.emit(progress({ completedBytes: 50, totalBytes: 100 }));
    feed.emit(progress({ completedBytes: 50, totalBytes: 100 }));
    feed.emit(progress({ completedBytes: 504, totalBytes: 1000 }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('replaces a download with the sentence explaining why it failed', () => {
    const feed = fakeFeed();
    const registry = createDownloadRegistry(feed.subscribe);
    registry.start('a', 'op-1');

    registry.fail('a', 'Not enough disk space to save this file.');

    expect(registry.getSnapshot()['a']).toEqual({
      kind: 'failed',
      message: 'Not enough disk space to save this file.',
    });
    // A failure is not outstanding work, so the feed is let go.
    expect(feed.listenerCount()).toBe(0);
  });

  it('keeps the snapshot referentially stable when nothing changed', () => {
    // `useSyncExternalStore` re-renders on identity, so a fresh object per read
    // would be an infinite loop.
    const registry = createDownloadRegistry(fakeFeed().subscribe);
    const before = registry.getSnapshot();
    registry.clear('never-started');
    expect(registry.getSnapshot()).toBe(before);
  });

  it('stops notifying a listener that has unsubscribed', () => {
    const registry = createDownloadRegistry(fakeFeed().subscribe);
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    registry.start('a', 'op-1');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    registry.clear('a');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
