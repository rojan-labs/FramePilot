/**
 * Tests for the visual-index host glue: credential assembly, and the honest degrade a
 * build with no sidecar gets.
 *
 * Import-time warming is NOT tested here any more because it is not here any more. It
 * moved to the desktop main process's single batching enroller (ADR 0175 / VU1.5) —
 * `apps/desktop/electron/ai/asset-enrolment.test.ts` covers it, keyless included.
 */
import { describe, expect, it } from 'vitest';
import type { AiConfig } from '@framepilot/shared-types';
import { VisualIndexClient } from '@framepilot/ai-sdk';
import {
  ensureProjectMediaUnderstanding,
  fetchFootageMap,
  nvidiaEmbeddingsKeys,
  twelveLabsKey,
  understandingCredentials,
} from './visualIndex.js';
import type { Project } from '@framepilot/timeline-schema';

/** A minimal AiConfig — only the fields the credential helpers read matter here. */
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

/** The smallest project the understanding helpers will accept. */
function project(): Project {
  return { id: 'p1', assets: [], timeline: { tracks: [] } } as unknown as Project;
}

/** A client whose every request fails at the transport, as it does with no sidecar. */
function offlineClient(): VisualIndexClient {
  const fetchFn = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  return new VisualIndexClient({ baseUrl: 'http://127.0.0.1:8765', fetchFn });
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

describe('understandingCredentials', () => {
  it('sends the on-device key even when TwelveLabs is configured', () => {
    // TwelveLabs cannot index a still, so withholding this key left a photo project with
    // no backend at all. One helper, one policy — four call sites used to assemble it.
    expect(
      understandingCredentials(config({ twelveLabs: 'tlk-x', nvidiaEmbeddings: 'nv-x' })),
    ).toEqual({ twelveLabsKey: 'tlk-x', nvidiaKeys: 'nv-x' });
  });

  it('is empty with nothing configured — which is no longer a reason not to index', () => {
    // The gate this replaces returned false here and NOTHING was ever indexed on a
    // default install. Tier 0 needs no credential, so an empty object is a full request.
    expect(understandingCredentials(config())).toEqual({});
  });
});

describe('the browser build, which has no sidecar', () => {
  it('degrades ensureProjectMediaUnderstanding to unavailable instead of throwing', async () => {
    const result = await ensureProjectMediaUnderstanding({
      project: project(),
      config: config(),
      client: offlineClient(),
    });
    expect(result.status).toBe('unavailable');
    // Honest about WHY: nothing could be reached. Never 'unconfigured' — a missing key is
    // not why this failed, and it is no longer a reason to refuse to try.
    expect(result.status === 'unavailable' && result.reason).toBe('offline');
  });

  it('resolves the footage map to undefined rather than rejecting', async () => {
    await expect(
      fetchFootageMap({ project: project(), config: config(), client: offlineClient() }),
    ).resolves.toBeUndefined();
  });
});
