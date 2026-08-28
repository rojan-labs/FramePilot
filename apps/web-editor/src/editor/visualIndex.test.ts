/**
 * Tests for the visual-index host glue (plan MI4.2): the auto-index gating
 * (key present/absent, toggle on/off, no assets) and the honest no-op when the
 * sidecar is unreachable. Fully offline — a fake {@link VisualIndexClient}.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AiConfig } from '@framepilot/shared-types';
import { VisualIndexClient } from '@framepilot/ai-sdk';
import {
  autoIndexImportedAssets,
  nvidiaEmbeddingsKeys,
  shouldAutoIndex,
  twelveLabsKey,
} from './visualIndex.js';

/** A minimal AiConfig — only the fields the gating reads matter here. */
function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    activeProvider: 'mock',
    providers: [],
    models: {},
    baseUrls: {},
    keys: {},
    ...overrides,
  } as unknown as AiConfig;
}

describe('nvidiaEmbeddingsKeys', () => {
  it('trims and treats blank as absent', () => {
    expect(nvidiaEmbeddingsKeys(config({ nvidiaEmbeddings: '  nvapi-x  ' }))).toBe('nvapi-x');
    expect(nvidiaEmbeddingsKeys(config({ nvidiaEmbeddings: '   ' }))).toBeUndefined();
    expect(nvidiaEmbeddingsKeys(config())).toBeUndefined();
  });
});

describe('twelveLabsKey', () => {
  it('trims and treats blank as absent', () => {
    expect(twelveLabsKey(config({ twelveLabs: '  tlk-x  ' }))).toBe('tlk-x');
    expect(twelveLabsKey(config({ twelveLabs: '   ' }))).toBeUndefined();
    expect(twelveLabsKey(config())).toBeUndefined();
  });
});

describe('shouldAutoIndex', () => {
  // Media understanding is automatic now: configuring a key IS the opt-in, and the
  // separate auto-index toggle is gone. A stored `embeddingsAutoIndex: false` from an
  // older build must therefore not keep warming switched off — otherwise a user who
  // once flipped that toggle would silently get no understanding with no visible cause.
  it('turns on for a key from either backend, and ignores the retired toggle', () => {
    expect(shouldAutoIndex(config({ nvidiaEmbeddings: 'nvapi-x' }))).toBe(true);
    expect(shouldAutoIndex(config({ twelveLabs: 'tlk-x' }))).toBe(true); // TwelveLabs key alone
    expect(
      shouldAutoIndex(config({ nvidiaEmbeddings: 'nvapi-x', embeddingsAutoIndex: false })),
    ).toBe(true);
    expect(shouldAutoIndex(config({ twelveLabs: 'tlk-x', embeddingsAutoIndex: false }))).toBe(true);
    expect(shouldAutoIndex(config({ embeddingsAutoIndex: true }))).toBe(false); // no key
    expect(shouldAutoIndex(config())).toBe(false);
  });
});

/** A client whose `index` returns a single done slice, recording the body. */
function doneClient(): { client: VisualIndexClient; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return {
      ok: true,
      status: 200,
      json: async () => ({ available: true, jobId: 'j1', cursor: 1, total: 1, done: true }),
    } as Response;
  }) as typeof fetch;
  return { client: new VisualIndexClient({ baseUrl: 'http://127.0.0.1:8765', fetchFn }), bodies };
}

describe('autoIndexImportedAssets', () => {
  it('no-ops (undefined) with no assets or no key — never calls the client', async () => {
    const index = vi.fn();
    const client = { index } as unknown as VisualIndexClient;

    expect(
      await autoIndexImportedAssets({
        projectId: 'p1',
        assetIds: [],
        config: config({ nvidiaEmbeddings: 'k' }),
        client,
      }),
    ).toBeUndefined();
    expect(
      await autoIndexImportedAssets({
        projectId: 'p1',
        assetIds: ['a1'],
        config: config(),
        client,
      }),
    ).toBeUndefined();
    expect(index).not.toHaveBeenCalled();
  });

  it('drives the index loop with the imported asset ids + configured key', async () => {
    const { client, bodies } = doneClient();
    const result = await autoIndexImportedAssets({
      projectId: 'p1',
      assetIds: ['a1', 'a2'],
      config: config({ nvidiaEmbeddings: 'nvapi-x' }),
      client,
    });
    expect(result?.status).toBe('done');
    expect(bodies[0]).toEqual({ projectId: 'p1', assetIds: ['a1', 'a2'], nvidiaKeys: 'nvapi-x' });
  });

  it('forwards the TwelveLabs key when it is the configured backend', async () => {
    const { client, bodies } = doneClient();
    const result = await autoIndexImportedAssets({
      projectId: 'p1',
      assetIds: ['a1'],
      config: config({ twelveLabs: 'tlk-x' }),
      client,
    });
    expect(result?.status).toBe('done');
    expect(bodies[0]).toEqual({ projectId: 'p1', assetIds: ['a1'], twelveLabsKey: 'tlk-x' });
  });

  it('forwards BOTH keys so stills can be prepared on-device while TwelveLabs runs', async () => {
    // TwelveLabs cannot index a still photo, so the engine routes stills to the
    // on-device embedder — which it can only do if this key reaches it. Dropping
    // it whenever a TwelveLabs key existed is what left a 61-photo project at
    // 0/61 prepared with no footage map.
    const { client, bodies } = doneClient();
    const result = await autoIndexImportedAssets({
      projectId: 'p1',
      assetIds: ['a1'],
      config: config({ twelveLabs: 'tlk-x', nvidiaEmbeddings: 'nvapi-x' }),
      client,
    });
    expect(result?.status).toBe('done');
    expect(bodies[0]).toEqual({
      projectId: 'p1',
      assetIds: ['a1'],
      twelveLabsKey: 'tlk-x',
      nvidiaKeys: 'nvapi-x',
    });
  });

  it('degrades honestly to unreachable when the sidecar is down', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const client = new VisualIndexClient({ baseUrl: 'http://127.0.0.1:8765', fetchFn });
    const result = await autoIndexImportedAssets({
      projectId: 'p1',
      assetIds: ['a1'],
      config: config({ nvidiaEmbeddings: 'nvapi-x' }),
      client,
    });
    expect(result?.status).toBe('unreachable');
  });
});
