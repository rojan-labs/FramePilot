import { describe, expect, it, vi } from 'vitest';
import { IpcChannels } from './contract.js';
import {
  registerDeferredDesktopServices,
  type DeferredDesktopLoaders,
  type IpcRegistrar,
} from './deferred-services.js';

type Handler = (event: never, ...args: unknown[]) => unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const registrar: IpcRegistrar = {
    handle: (channel, listener) => handlers.set(channel, listener as Handler),
  };
  const snapshotHandler = vi.fn(async () => ({
    ok: false as const,
    error: 'snapshot-test',
  }));
  const mediaHandler = vi.fn(async () => ({
    ok: false as const,
    error: 'media-test',
  }));
  const loaders: DeferredDesktopLoaders = {
    projectSnapshot: vi.fn(async () => ({ handleProjectSnapshot: snapshotHandler })),
    mediaImportChunk: vi.fn(async () => ({ handleMediaImportChunk: mediaHandler })),
  };
  registerDeferredDesktopServices(registrar, loaders);
  return { handlers, loaders, snapshotHandler, mediaHandler };
}

describe('deferred desktop services', () => {
  it('registers both channels without loading either implementation', () => {
    const { handlers, loaders } = harness();
    expect(handlers.has(IpcChannels.projectSnapshot)).toBe(true);
    expect(handlers.has(IpcChannels.mediaImportChunk)).toBe(true);
    expect(loaders.projectSnapshot).not.toHaveBeenCalled();
    expect(loaders.mediaImportChunk).not.toHaveBeenCalled();
  });

  it('loads only the service whose channel is invoked', async () => {
    const { handlers, loaders, snapshotHandler, mediaHandler } = harness();
    const snapshot = handlers.get(IpcChannels.projectSnapshot)!;

    await snapshot({} as never, 'project_1');

    expect(loaders.projectSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshotHandler).toHaveBeenCalledWith('project_1');
    expect(loaders.mediaImportChunk).not.toHaveBeenCalled();
    expect(mediaHandler).not.toHaveBeenCalled();
  });
});
