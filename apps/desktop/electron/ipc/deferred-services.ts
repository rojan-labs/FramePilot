import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { MediaImportChunkResult } from '@framepilot/shared-types';
import type { ProjectOpenResult } from './contract.js';
import { IpcChannels } from './contract.js';

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export interface IpcRegistrar {
  handle(channel: string, listener: InvokeHandler): void;
}

export interface DeferredDesktopLoaders {
  readonly projectSnapshot: () => Promise<{
    handleProjectSnapshot(projectId: unknown): Promise<ProjectOpenResult>;
  }>;
  readonly mediaImportChunk: () => Promise<{
    handleMediaImportChunk(value: unknown): Promise<MediaImportChunkResult>;
  }>;
}

const defaultLoaders: DeferredDesktopLoaders = {
  projectSnapshot: () => import('./project-snapshot-ipc.js'),
  mediaImportChunk: () => import('./media-import-chunk-ipc.js'),
};

/**
 * Register channel names immediately while deferring implementation graphs until use.
 * Recovery/media import therefore cannot race a missing channel, and their fs/schema
 * modules do not participate in ordinary Electron startup.
 */
export function registerDeferredDesktopServices(
  registrar: IpcRegistrar = ipcMain,
  loaders: DeferredDesktopLoaders = defaultLoaders,
): void {
  registrar.handle(IpcChannels.projectSnapshot, async (_event, projectId) => {
    const service = await loaders.projectSnapshot();
    return service.handleProjectSnapshot(projectId);
  });
  registrar.handle(IpcChannels.mediaImportChunk, async (_event, request) => {
    const service = await loaders.mediaImportChunk();
    return service.handleMediaImportChunk(request);
  });
}
