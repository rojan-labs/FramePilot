import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { AiProvider } from '../providers/types.js';
import type { HostToolExecutor } from '../tool-executor.js';
import type { HostToolEffect } from './effects.js';
import { createEffectRuntime, idempotencyKeyFor } from './effect-runtime.js';

const project = {
  timeline: { tracks: [], revision: 1 },
  assets: [],
  folders: [],
  markers: [],
  transcript: [],
} as Project;

const provider = { name: 'unused-host-test-provider' } as AiProvider;

const hostEffect = (
  idempotencyKey?: string,
  name = 'get_frame',
  arguments_: Readonly<Record<string, unknown>> = { timeSeconds: 1 },
): HostToolEffect => ({
  kind: 'host_tool',
  call: { id: 'host-call', name, arguments: arguments_ },
  project,
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

describe('host-tool idempotency safety', () => {
  it('scopes a project-dependent host call by the timeline revision', () => {
    expect(idempotencyKeyFor(hostEffect())).toContain(':rev:1');
  });

  it('has no derived cache key when there is no revision to name', () => {
    // Without a revision there is no safe identity for a project-dependent read, so
    // the call must run fresh rather than risk serving a pre-edit answer.
    const unversioned = {
      ...hostEffect(),
      project: { ...project, timeline: { tracks: [] } } as Project,
    };
    expect(idempotencyKeyFor(unversioned)).toBeUndefined();
  });

  it('honours an explicit caller-owned key only for a cacheable tool contract', () => {
    expect(idempotencyKeyFor(hostEffect('project:1:frame:1'))).toBe('project:1:frame:1');
  });

  for (const name of ['export_video', 'transcribe', 'index_media']) {
    it(`refuses an explicit cache key for ${name}`, () => {
      expect(idempotencyKeyFor(hostEffect(`unsafe:${name}`, name, {}))).toBeUndefined();
    });
  }

  it('re-reads a project-dependent host call after the project changes', async () => {
    // The audit's core staleness scenario: read a frame, edit, read the same frame.
    // The second read must hit the host again rather than replay the pre-edit image.
    let calls = 0;
    const executor: HostToolExecutor = {
      async run() {
        calls += 1;
        return { status: 'completed', summary: `frame ${calls}` };
      },
    };
    const runtime = createEffectRuntime({ provider, executor });
    const afterEdit = {
      ...hostEffect(),
      project: { ...project, timeline: { tracks: [], revision: 2 } } as Project,
    };

    const first = await runtime.run(hostEffect());
    const second = await runtime.run(afterEdit);

    expect(calls).toBe(2);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
  });

  it('serves an identical read within one revision from the memo', async () => {
    let calls = 0;
    const executor: HostToolExecutor = {
      async run() {
        calls += 1;
        return { status: 'completed', summary: `frame ${calls}` };
      },
    };
    const runtime = createEffectRuntime({ provider, executor });

    const first = await runtime.run(hostEffect());
    const second = await runtime.run(hostEffect());

    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('deduplicates only when the caller supplies the same explicit safe key', async () => {
    let calls = 0;
    const executor: HostToolExecutor = {
      async run() {
        calls += 1;
        return { status: 'completed', summary: `frame ${calls}` };
      },
    };
    const runtime = createEffectRuntime({ provider, executor });

    const first = await runtime.run(hostEffect('project:1:frame:1'));
    const second = await runtime.run(hostEffect('project:1:frame:1'));

    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('runs a non-cacheable host mutation twice even when a caller reuses an explicit key', async () => {
    let calls = 0;
    const executor: HostToolExecutor = {
      async run() {
        calls += 1;
        return { status: 'completed', summary: `transcription ${calls}`, data: { words: [] } };
      },
    };
    const runtime = createEffectRuntime({ provider, executor });
    const effect = hostEffect('same-explicit-key', 'transcribe', { assetId: 'asset-a' });

    const first = await runtime.run(effect);
    const second = await runtime.run(effect);

    expect(calls).toBe(2);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
  });
});
