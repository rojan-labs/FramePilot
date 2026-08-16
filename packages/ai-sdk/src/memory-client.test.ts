/**
 * Tests for the narrative memory recorder (plan B6.1). The load-bearing property
 * is that recording can NEVER fail a user action: every failure path resolves
 * `false` rather than rejecting. Fully offline (fetch injected).
 */
import { describe, expect, it } from 'vitest';
import type { Patch } from '@framepilot/editor-core';
import {
  acceptanceEntry,
  createMemoryRecorder,
  rejectionEntry,
  type MemoryEntryInput,
} from './memory-client.js';

const patch = (overrides: Partial<Patch> = {}): Patch =>
  ({
    patchId: 'p_1',
    reason: 'Tightened pacing',
    operations: [],
    ...overrides,
  }) as Patch;

function fetchStub(
  reply: { ok: boolean; status?: number },
  onRequest?: (url: string, init: RequestInit) => void,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    onRequest?.(String(url), init ?? {});
    return { ok: reply.ok, status: reply.status ?? (reply.ok ? 200 : 500) } as Response;
  }) as typeof fetch;
}

describe('createMemoryRecorder', () => {
  const entry: MemoryEntryInput = {
    projectId: 'p1',
    tier: 'corrections',
    title: 'Rejected: Tightened pacing',
    body: 'why',
    patchId: 'p_1',
  };

  it('POSTs the entry to /brain/memory', async () => {
    let seen: { url: string; body: unknown } = { url: '', body: null };
    const record = createMemoryRecorder({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true }, (url, init) => {
        seen = { url, body: JSON.parse(String(init.body)) };
      }),
    });
    expect(await record(entry)).toBe(true);
    expect(seen.url).toBe('http://x/brain/memory');
    expect(seen.body).toEqual({
      projectId: 'p1',
      tier: 'corrections',
      title: 'Rejected: Tightened pacing',
      body: 'why',
      patchId: 'p_1',
    });
  });

  it('omits absent optionals so the engine applies its own defaults', async () => {
    let body: Record<string, unknown> = {};
    const record = createMemoryRecorder({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true }, (_url, init) => {
        body = JSON.parse(String(init.body));
      }),
    });
    await record({ projectId: 'p1', tier: 'decisions', title: 't' });
    expect(body).toEqual({ projectId: 'p1', tier: 'decisions', title: 't' });
  });

  it('forwards soulDoc for an explicit cross-project remember (B6.2)', async () => {
    let body: Record<string, unknown> = {};
    const record = createMemoryRecorder({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true }, (_url, init) => {
        body = JSON.parse(String(init.body));
      }),
    });
    await record({ ...entry, soulDoc: 'working_style' });
    expect(body.soulDoc).toBe('working_style');
  });

  it('resolves false on an HTTP error rather than failing the user action', async () => {
    const record = createMemoryRecorder({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: false, status: 503 }),
    });
    await expect(record(entry)).resolves.toBe(false);
  });

  it('resolves false when there is no sidecar, never rejecting', async () => {
    const record = createMemoryRecorder({
      baseUrl: 'http://x',
      fetchFn: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch,
    });
    await expect(record(entry)).resolves.toBe(false);
  });

  it('resolves false on timeout rather than hanging the caller', async () => {
    const hanging = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const record = createMemoryRecorder({ baseUrl: 'http://x', fetchFn: hanging, timeoutMs: 5 });
    await expect(record(entry)).resolves.toBe(false);
  });

  it('stringifies a thrown non-Error value rather than assuming an Error shape', async () => {
    const record = createMemoryRecorder({
      baseUrl: 'http://x',
      fetchFn: (() => Promise.reject('ECONNREFUSED')) as unknown as typeof fetch,
    });
    await expect(record(entry)).resolves.toBe(false);
  });

  it('falls back to the global fetch when no fetchFn is injected', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fetchStub({ ok: true });
    try {
      const record = createMemoryRecorder({ baseUrl: 'http://x' });
      await expect(record(entry)).resolves.toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('entry builders', () => {
  it('builds a corrections entry that names the rejected edit and its patch', () => {
    expect(rejectionEntry('p1', patch())).toEqual({
      projectId: 'p1',
      tier: 'corrections',
      title: 'Rejected: Tightened pacing',
      body: 'The user rejected this proposed edit in review.',
      patchId: 'p_1',
    });
  });

  it('builds a decisions entry for an accepted edit', () => {
    const built = acceptanceEntry('p1', patch({ patchId: 'p_2', reason: 'Added captions' }));
    expect(built.tier).toBe('decisions');
    expect(built.title).toBe('Accepted: Added captions');
    expect(built.patchId).toBe('p_2');
  });

  it('never invents a reason the user did not give', () => {
    // The user pressed Reject; they did not explain themselves. A fabricated
    // motive here would poison every later run that reads the tier.
    const built = rejectionEntry('p1', patch());
    expect(built.body).not.toContain('because');
    expect(built.title).toBe(`Rejected: ${patch().reason}`);
  });
});
