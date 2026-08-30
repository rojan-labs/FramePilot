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

/**
 * The exemplar CACHEABLE host read.
 *
 * Was `get_frame`, then `search_media`, and neither survived audit: a frame is a picture of
 * the arrangement and a media search reads the bin, so both are things a run moves under
 * its own question. `search_music` is the real shape of a memoizable call — a query against
 * a provider catalogue that no edit in this project can change — and it is also the one
 * whose memo pays for itself, because the free tier meters searches per minute.
 */
const hostEffect = (
  idempotencyKey?: string,
  name = 'search_music',
  arguments_: Readonly<Record<string, unknown>> = { query: 'lo-fi beat' },
): HostToolEffect => ({
  kind: 'host_tool',
  call: { id: 'host-call', name, arguments: arguments_ },
  project,
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

describe('host-tool idempotency safety', () => {
  it('keys a cacheable host call by name and arguments alone', () => {
    expect(idempotencyKeyFor(hostEffect())).toBe('host_tool:search_music:{"query":"lo-fi beat"}');
  });

  it('gives a differently-worded query a different key', () => {
    expect(
      idempotencyKeyFor(hostEffect(undefined, 'search_music', { query: 'ambient pad' })),
    ).not.toBe(idempotencyKeyFor(hostEffect()));
  });

  it('honours an explicit caller-owned key only for a cacheable tool contract', () => {
    expect(idempotencyKeyFor(hostEffect('catalogue:lofi'))).toBe('catalogue:lofi');
  });

  for (const name of ['export_video', 'transcribe', 'index_media']) {
    it(`refuses an explicit cache key for ${name}`, () => {
      expect(idempotencyKeyFor(hostEffect(`unsafe:${name}`, name, {}))).toBeUndefined();
    });
  }

  /**
   * The staleness scenario this audit exists for, restated after the revision-keyed tier
   * was removed (`tool-contract.ts#ToolCacheScope`).
   *
   * The old assertion was "the same read re-runs once the revision moves", which encoded
   * the very assumption that produced three stale-answer bugs: that a run's edits are
   * visible in `Timeline.revision`. They are not — a colour grade, an effect, a mask and
   * every bin operation leave it untouched. So the guarantee is now unconditional: a host
   * read of anything a run can change is never memoized, whatever the revision says.
   */
  for (const [name, why] of [
    ['get_frame', 'a picture of the arrangement'],
    ['measure_color', 'a measurement of the graded picture'],
    ['search_media', 'a query over a bin the run itself imports into'],
  ] as const) {
    it(`never memoizes ${name} — ${why} — even within one revision`, async () => {
      let calls = 0;
      const executor: HostToolExecutor = {
        async run() {
          calls += 1;
          return { status: 'completed', summary: `reading ${calls}` };
        },
      };
      const runtime = createEffectRuntime({ provider, executor });
      const effect = hostEffect(undefined, name, { clipId: 'clip_1', timeSeconds: 2 });

      const first = await runtime.run(effect);
      const second = await runtime.run(effect);

      expect(calls).toBe(2);
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(false);
    });
  }

  it('serves an identical cacheable read from the memo, across a project edit', async () => {
    // The catalogue does not care what the timeline looks like: the same query asked twice
    // in one run is one provider request, before AND after a patch lands.
    let calls = 0;
    const executor: HostToolExecutor = {
      async run() {
        calls += 1;
        return { status: 'completed', summary: `catalogue page ${calls}` };
      },
    };
    const runtime = createEffectRuntime({ provider, executor });
    const afterEdit = {
      ...hostEffect(),
      project: { ...project, timeline: { tracks: [], revision: 2 } } as Project,
    };

    const first = await runtime.run(hostEffect());
    const second = await runtime.run(afterEdit);

    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('deduplicates only when the caller supplies the same explicit safe key', async () => {
    let calls = 0;
    const executor: HostToolExecutor = {
      async run() {
        calls += 1;
        return { status: 'completed', summary: `catalogue page ${calls}` };
      },
    };
    const runtime = createEffectRuntime({ provider, executor });

    const first = await runtime.run(hostEffect('catalogue:lofi'));
    const second = await runtime.run(hostEffect('catalogue:lofi'));

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
