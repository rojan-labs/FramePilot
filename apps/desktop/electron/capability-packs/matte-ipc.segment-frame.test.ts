/** BR6.11: the hover channel — narrow, licensed, re-reads the project only when it changed. */
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { IpcChannels } from '../ipc/contract.js';
import { registerMatteIpc, type MatteIpcDependencies, type MatteIpcEvent } from './matte-ipc.js';

const project = {
  id: 'p',
  assets: [],
  timeline: { tracks: [], revision: 9 },
} as unknown as Project;
const event: MatteIpcEvent = { sender: { isDestroyed: () => false, send: () => undefined } };

function setup(overrides: Partial<MatteIpcDependencies> = {}) {
  const handlers = new Map<string, (event: MatteIpcEvent, ...args: unknown[]) => unknown>();
  const segment = vi.fn(async () => ({ ok: false as const, code: 'busy', error: 'x' }));
  const readProject = vi.fn(async () => project);
  let stamp = '1:1';
  registerMatteIpc({
    ipcMain: {
      handle: (channel, listener) => void handlers.set(channel, listener),
      on: (channel, listener) => void handlers.set(channel, listener),
    },
    requireLicense: () => undefined,
    capabilityStatus: async () => ({ state: 'ready' }) as never,
    matte: async () => {
      throw new Error('hover never builds a matte job');
    },
    activeProjectPath: async () => '/projects/edit.fp.json',
    readProject,
    segmentFrame: async () => ({ segment }),
    projectStamp: async () => stamp,
    ...overrides,
  });
  const call = (input: unknown) => handlers.get(IpcChannels.matteSegmentFrame)!(event, input);
  return { call, segment, readProject, setStamp: (next: string) => void (stamp = next) };
}

describe('matteSegmentFrame channel (BR6.11)', () => {
  it('hands the untrusted intent and the on-disk project to the service, reading it once per change', async () => {
    const { call, segment, readProject, setStamp } = setup();
    const intent = { requestId: 'h', assetId: 'a', sourceTime: 1, hoverPoint: { x: 0.5, y: 0.5 } };
    for (let index = 0; index < 3; index += 1) await call(intent);
    expect(segment).toHaveBeenCalledTimes(3);
    expect(segment).toHaveBeenCalledWith(intent, { project, projectRevision: 9 });
    expect(readProject).toHaveBeenCalledTimes(1);
    setStamp('2:2');
    await call(intent);
    expect(readProject).toHaveBeenCalledTimes(2);
  });

  it('answers unavailable without the service, no_project without a project, and requires a licence', async () => {
    expect(await setup({ segmentFrame: undefined }).call({})).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
    expect(await setup({ activeProjectPath: async () => null }).call({})).toMatchObject({
      ok: false,
      code: 'no_project',
    });
    const unlicensed = setup({
      requireLicense: () => {
        throw new Error('A valid FramePilot license is required.');
      },
    });
    await expect(unlicensed.call({})).rejects.toThrow(/license/u);
    expect(unlicensed.segment).not.toHaveBeenCalled();
  });
});
