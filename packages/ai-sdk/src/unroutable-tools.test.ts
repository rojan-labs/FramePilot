/**
 * A tool the surface cannot fulfil is not advertised there (run 6 of 2026-09-05).
 *
 * `render_preview` and `export_video` are real on the MCP surface and unroutable on the
 * desktop and browser agent surfaces, where the sidecar executor refuses them with
 * `surface_unavailable`. They were advertised everywhere regardless: one captured desktop
 * run called `render_preview` eight times in 86 minutes, refused identically each time, and
 * paid both descriptors on every one of its 308 requests. The executor now declares what it
 * cannot route, and `agentTools` drops it — upstream of every guard.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import { MockProvider } from './providers/mock.js';
import { createSidecarExecutor } from './sidecar-executor.js';
import type { HostToolExecutor } from './tool-executor.js';

const RENDER = ['render_preview', 'export_video'] as const;

const executor = (unroutable?: ReadonlySet<string>): HostToolExecutor => ({
  run: async (call) => ({ status: 'completed', summary: `ran ${call.name}` }),
  ...(unroutable === undefined ? {} : { unroutableTools: () => unroutable }),
});

describe('the sidecar executor declares what it cannot route', () => {
  it('names exactly the two render actions', () => {
    const declared = createSidecarExecutor({ baseUrl: 'http://127.0.0.1:1' }).unroutableTools?.();
    expect(declared).toBeDefined();
    expect([...(declared ?? [])].sort()).toEqual([...RENDER].sort());
  });
});

describe('agentTools honours the declaration', () => {
  it('drops unroutable tools from the agent surface and keeps everything else', () => {
    const o = new Orchestrator(new MockProvider(), { executor: executor(new Set(RENDER)) });
    const names = o.agentTools('agent').map((t) => t.name);
    for (const name of RENDER) expect(names).not.toContain(name);
    expect(names).toContain('get_timeline');
    expect(names).toContain('add_clip');
  });

  it('advertises them on a surface that makes no declaration (the MCP shape)', () => {
    const names = new Orchestrator(new MockProvider(), { executor: executor() })
      .agentTools('agent')
      .map((t) => t.name);
    for (const name of RENDER) expect(names).toContain(name);
  });

  it('advertises them when there is no executor at all — the previous default', () => {
    const names = new Orchestrator(new MockProvider()).agentTools('agent').map((t) => t.name);
    for (const name of RENDER) expect(names).toContain(name);
  });
});
