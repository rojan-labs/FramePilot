/**
 * In-flight third-party downloads, held OUTSIDE the panels that start them.
 *
 * The Sounds and Stock panels live in tab slots that unmount the moment the user
 * switches tabs — and starting a download is exactly the reason someone switches
 * away: they queue a 40 MB clip and go back to the timeline while it lands. With
 * the progress map in component state, coming back showed an idle row: no bar,
 * no Cancel, and no duplicate guard, while the bytes were still arriving in
 * main. Worse, a failure that happened while the panel was unmounted was never
 * said at all, because the only place it was written had gone.
 *
 * So the registry owns that state and outlives the mount; the panel renders it.
 * The main-process operation is the real thing in flight, and this is the
 * renderer's durable record of it — which is why `operationId` is kept here
 * rather than in a component: it is the handle Cancel needs, and it must survive
 * the unmount for Cancel to still work on return.
 *
 * Progress is subscribed lazily and dropped again once nothing is downloading,
 * so an editor who never opens these tabs pays for no IPC listener.
 */
import { useSyncExternalStore } from 'react';
import { onMusicDownloadProgress, onStockDownloadProgress } from './bridge.js';

/** What a download is doing, for the one row or tile that started it. */
export type DownloadEntry =
  | { readonly kind: 'downloading'; readonly operationId: string; readonly percent: number | null }
  | { readonly kind: 'failed'; readonly message: string };

/** Every tracked download, keyed by provider item id. */
export type DownloadEntries = Readonly<Record<string, DownloadEntry>>;

/**
 * The progress fields this registry reads.
 *
 * Structural rather than an import of `MusicDownloadProgressWire`, because the
 * music and stock wires are the same shape and the registry has no reason to
 * care which provider it is mirroring.
 */
export interface DownloadProgressMessage {
  readonly remoteId: string;
  readonly phase: 'downloading' | 'deriving' | 'installed' | 'cancelled' | 'failed';
  readonly completedBytes: number;
  readonly totalBytes: number;
}

export interface DownloadRegistry {
  /** Current entries. Referentially stable until something changes. */
  getSnapshot(): DownloadEntries;
  /** React subscription, in `useSyncExternalStore` order. */
  subscribe(listener: () => void): () => void;
  /** Record a download that has just been asked for. */
  start(remoteId: string, operationId: string): void;
  /** Record a download that ended badly, with the sentence to show. */
  fail(remoteId: string, message: string): void;
  /** Forget this item — it landed, or the user cancelled, or it was retried. */
  clear(remoteId: string): void;
}

/**
 * @param subscribeToProgress - How to hear from main. Called lazily on the first
 * download and unsubscribed once none are outstanding, so the listener's life
 * matches the work rather than the app's.
 */
export function createDownloadRegistry(
  subscribeToProgress: (listener: (message: DownloadProgressMessage) => void) => () => void,
): DownloadRegistry {
  let entries: DownloadEntries = {};
  const listeners = new Set<() => void>();
  let detachProgress: (() => void) | null = null;

  const emit = (next: DownloadEntries): void => {
    entries = next;
    for (const listener of listeners) listener();
    syncProgressSubscription();
  };

  const anyDownloading = (): boolean =>
    Object.values(entries).some((entry) => entry.kind === 'downloading');

  function syncProgressSubscription(): void {
    if (anyDownloading() && detachProgress === null) {
      detachProgress = subscribeToProgress((message) => {
        if (message.phase !== 'downloading') return;
        const current = entries[message.remoteId];
        if (current?.kind !== 'downloading') return;
        const percent =
          message.totalBytes > 0
            ? Math.min(100, Math.round((message.completedBytes / message.totalBytes) * 100))
            : null;
        if (current.percent === percent) return;
        emit({ ...entries, [message.remoteId]: { ...current, percent } });
      });
      return;
    }
    if (!anyDownloading() && detachProgress !== null) {
      detachProgress();
      detachProgress = null;
    }
  }

  return {
    getSnapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(remoteId, operationId) {
      emit({ ...entries, [remoteId]: { kind: 'downloading', operationId, percent: null } });
    },
    fail(remoteId, message) {
      emit({ ...entries, [remoteId]: { kind: 'failed', message } });
    },
    clear(remoteId) {
      if (entries[remoteId] === undefined) return;
      const next = { ...entries };
      delete next[remoteId];
      emit(next);
    },
  };
}

/**
 * Module singletons, one per provider surface.
 *
 * Module scope is the point: it is what survives the panel unmounting, and both
 * panels are single-instance inside one editor window. Creating one is inert —
 * nothing subscribes until a download actually starts.
 */
export const musicDownloads = createDownloadRegistry((listener) =>
  onMusicDownloadProgress(listener),
);
export const stockDownloads = createDownloadRegistry((listener) =>
  onStockDownloadProgress(listener),
);

/** Subscribe a component to a registry. Re-renders only when entries change. */
export function useDownloads(registry: DownloadRegistry): DownloadEntries {
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

/** Forget every tracked download. Test seam — production never resets these. */
export function resetDownloadRegistriesForTests(): void {
  for (const registry of [musicDownloads, stockDownloads]) {
    for (const remoteId of Object.keys(registry.getSnapshot())) registry.clear(remoteId);
  }
}
