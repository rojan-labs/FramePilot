/**
 * Tests for the brain analysis client (plan B1.4): schema parsing, the
 * injectable-fetch reader's honest degradation on every failure path, and the
 * rows → {@link AnalysisResultsBag} mapper. Fully offline.
 */
import { describe, expect, it } from 'vitest';
import {
  analysisBagFromRows,
  analysisResultRowSchema,
  brainAnalysisResponseSchema,
  createAnalysisBagWarmer,
  createBrainAnalysisReader,
  createSessionContextDigester,
  createSessionContextReader,
  createVisualStatusDigester,
  createVisualStatusReader,
  sessionContextResponseSchema,
  summarizeSessionContext,
  summarizeVisualStatus,
  type AnalysisResultRow,
  type SessionContextResponse,
} from './brain-client.js';
import type { VisualStatusResponse } from './visual-index-client.js';

const row = (overrides: Partial<AnalysisResultRow> = {}): AnalysisResultRow => ({
  assetId: 'a1',
  kind: 'silence',
  depth: 'standard',
  paramsHash: 'h1',
  result: { ranges: [{ start: 0, end: 1, duration: 1 }] },
  source: 'machine',
  tool: 'framepilot-engine/silence@1',
  createdAt: '2026-07-14T00:00:00Z',
  ...overrides,
});

/** A fetch stub that records the request and replies with the given response. */
function fetchStub(
  reply: { ok: boolean; status?: number; json?: unknown },
  onRequest?: (url: string) => void,
): typeof fetch {
  return (async (url: string | URL | Request) => {
    onRequest?.(String(url));
    return {
      ok: reply.ok,
      status: reply.status ?? (reply.ok ? 200 : 500),
      json: async () => reply.json,
    } as Response;
  }) as typeof fetch;
}

describe('schemas', () => {
  it('parses a wire response and defaults absent results to an empty list', () => {
    expect(analysisResultRowSchema.parse(row())).toEqual(row());
    expect(brainAnalysisResponseSchema.parse({ available: false, reason: 'no root' })).toEqual({
      available: false,
      reason: 'no root',
      results: [],
    });
  });

  it('rejects a row missing its cache-key fields', () => {
    const { paramsHash: _dropped, ...incomplete } = row();
    expect(analysisResultRowSchema.safeParse(incomplete).success).toBe(false);
  });
});

describe('createBrainAnalysisReader', () => {
  it('GETs /brain/analysis with the project (and optional asset) id and returns rows', async () => {
    let seenUrl = '';
    const read = createBrainAnalysisReader({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: fetchStub({ ok: true, json: { available: true, results: [row()] } }, (url) => {
        seenUrl = url;
      }),
    });
    expect(await read('p1', 'a1')).toEqual([row()]);
    expect(seenUrl).toBe('http://127.0.0.1:8765/brain/analysis?projectId=p1&assetId=a1');
    await read('p1');
    expect(seenUrl).toBe('http://127.0.0.1:8765/brain/analysis?projectId=p1');
  });

  it('degrades to undefined on HTTP error, honest-unavailable, and malformed payloads', async () => {
    const cases: Array<{ ok: boolean; status?: number; json?: unknown }> = [
      { ok: false, status: 500 },
      { ok: true, json: { available: false, reason: 'projects root is not configured' } },
      { ok: true, json: { nonsense: true } },
    ];
    for (const reply of cases) {
      const read = createBrainAnalysisReader({ baseUrl: 'http://x', fetchFn: fetchStub(reply) });
      expect(await read('p1')).toBeUndefined();
    }
  });

  it('degrades to undefined on a network failure and on timeout, never throwing', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const read = createBrainAnalysisReader({ baseUrl: 'http://x', fetchFn: failing });
    expect(await read('p1')).toBeUndefined();

    const hanging = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const timedOut = createBrainAnalysisReader({
      baseUrl: 'http://x',
      fetchFn: hanging,
      timeoutMs: 5,
    });
    expect(await timedOut('p1')).toBeUndefined();
  });

  it('degrades to undefined without a reason when the brain omits one', async () => {
    const read = createBrainAnalysisReader({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: { available: false } }),
    });
    expect(await read('p1')).toBeUndefined();
  });

  it('stringifies a thrown non-Error value rather than assuming an Error shape', async () => {
    const read = createBrainAnalysisReader({
      baseUrl: 'http://x',
      fetchFn: (async () => {
        throw 'ECONNREFUSED';
      }) as unknown as typeof fetch,
    });
    expect(await read('p1')).toBeUndefined();
  });

  it('falls back to the global fetch when no fetchFn is injected', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fetchStub({ ok: true, json: { available: true, results: [row()] } });
    try {
      const read = createBrainAnalysisReader({ baseUrl: 'http://x' });
      expect(await read('p1')).toEqual([row()]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('analysisBagFromRows', () => {
  it('maps scenes/silence/beats rows to their bag fields as legacy single-asset payloads', () => {
    const rows = [
      row(),
      row({ kind: 'scenes', result: { cuts: [{ time: 1 }, { time: 2 }] } }),
      row({ kind: 'beats', result: { beats: [{ time: 0.5, strength: 1 }], bpm: 120 } }),
    ];
    expect(analysisBagFromRows(rows)).toEqual({
      silences: { assetId: 'a1', ranges: [{ start: 0, end: 1, duration: 1 }] },
      shots: { assetId: 'a1', cuts: [{ time: 1 }, { time: 2 }] },
      beats: { assetId: 'a1', beats: [{ time: 0.5, strength: 1 }], bpm: 120 },
    });
  });

  it('picks the newest row per kind when several assets carry the same analysis', () => {
    const rows = [
      row({ assetId: 'a1', createdAt: '2026-07-13T00:00:00Z' }),
      row({ assetId: 'a2', createdAt: '2026-07-14T00:00:00Z', result: { ranges: [] } }),
    ];
    expect(analysisBagFromRows(rows)).toEqual({ silences: { assetId: 'a2', ranges: [] } });
  });

  it('maps loudness/black rows to their bag fields (B2.4)', () => {
    const rows = [
      row({ kind: 'loudness', result: { integratedLufs: -17.2, truePeakDbfs: -1.3 } }),
      row({ kind: 'black', result: { ranges: [{ start: 0, end: 2, duration: 2 }] } }),
    ];
    expect(analysisBagFromRows(rows)).toEqual({
      loudness: { assetId: 'a1', integratedLufs: -17.2, truePeakDbfs: -1.3 },
      black: { assetId: 'a1', ranges: [{ start: 0, end: 2, duration: 2 }] },
    });
  });

  it('ignores kinds the bag cannot carry and returns undefined when nothing maps', () => {
    expect(analysisBagFromRows([row({ kind: 'freeze' }), row({ kind: 'probe' })])).toBeUndefined();
    expect(analysisBagFromRows([])).toBeUndefined();
  });
});

describe('createAnalysisBagWarmer', () => {
  it('composes reader + mapper into the orchestrator warm hook', async () => {
    const warm = createAnalysisBagWarmer({
      baseUrl: 'http://x',
      fetchFn: fetchStub({
        ok: true,
        json: { available: true, results: [row({ kind: 'scenes', result: { cuts: [] } })] },
      }),
    });
    expect(await warm('p1')).toEqual({ shots: { assetId: 'a1', cuts: [] } });
  });

  it('returns undefined when the brain has no rows or is unreachable', async () => {
    const empty = createAnalysisBagWarmer({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: { available: true, results: [] } }),
    });
    expect(await empty('p1')).toBeUndefined();
    const down = createAnalysisBagWarmer({
      baseUrl: 'http://x',
      fetchFn: (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
    });
    expect(await down('p1')).toBeUndefined();
  });
});

// --- session context (plan B6.3) ---------------------------------------------

const sessionContext = (
  overrides: Partial<SessionContextResponse> = {},
): SessionContextResponse => ({
  available: true,
  binSummary: '# Media bin summary\n## a1 (media/a.mp4)',
  sessionNote: '## 2026-07-15 — removed 12 silences',
  corrections: '## no captions over faces',
  decisions: '## kept the cold open',
  soul: '# Working style\nCuts on the beat.',
  ...overrides,
});

describe('sessionContextResponseSchema', () => {
  it('defaults every absent section to an empty string', () => {
    expect(sessionContextResponseSchema.parse({ available: true })).toEqual({
      available: true,
      binSummary: '',
      sessionNote: '',
      corrections: '',
      decisions: '',
      soul: '',
    });
  });

  it('ignores the engine-only status field rather than failing to parse', () => {
    const parsed = sessionContextResponseSchema.safeParse({
      available: true,
      status: { available: true, exists: true },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('createSessionContextReader', () => {
  it('POSTs the project id and returns the parsed context', async () => {
    let seen = '';
    const read = createSessionContextReader({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: sessionContext() }, (url) => {
        seen = url;
      }),
    });
    const result = await read('p1');
    expect(seen).toBe('http://x/brain/session-context');
    expect(result?.corrections).toBe('## no captions over faces');
  });

  it('degrades to undefined on an HTTP error', async () => {
    const read = createSessionContextReader({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: false, status: 500 }),
    });
    expect(await read('p1')).toBeUndefined();
  });

  it('degrades to undefined when the brain reports unavailable', async () => {
    const read = createSessionContextReader({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: { available: false, reason: 'no root' } }),
    });
    expect(await read('p1')).toBeUndefined();
  });

  it('degrades to undefined on a malformed payload', async () => {
    const read = createSessionContextReader({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: { available: 'yes' } }),
    });
    expect(await read('p1')).toBeUndefined();
  });

  it('degrades to undefined when the request throws (no sidecar)', async () => {
    const read = createSessionContextReader({
      baseUrl: 'http://x',
      fetchFn: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch,
    });
    expect(await read('p1')).toBeUndefined();
  });

  it('degrades to undefined without a reason when the brain omits one', async () => {
    const read = createSessionContextReader({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: { available: false } }),
    });
    expect(await read('p1')).toBeUndefined();
  });

  it('stringifies a thrown non-Error value rather than assuming an Error shape', async () => {
    const read = createSessionContextReader({
      baseUrl: 'http://x',
      fetchFn: (() => Promise.reject('ECONNREFUSED')) as unknown as typeof fetch,
    });
    expect(await read('p1')).toBeUndefined();
  });

  it('falls back to the global fetch when no fetchFn is injected', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fetchStub({ ok: true, json: sessionContext() });
    try {
      const read = createSessionContextReader({ baseUrl: 'http://x' });
      const result = await read('p1');
      expect(result?.corrections).toBe('## no captions over faces');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('summarizeSessionContext', () => {
  it('renders every section with a heading', () => {
    const digest = summarizeSessionContext(sessionContext());
    expect(digest).toContain('no captions over faces');
    expect(digest).toContain('kept the cold open');
    expect(digest).toContain('Cuts on the beat.');
    expect(digest).toContain('removed 12 silences');
    expect(digest).toContain('media/a.mp4');
  });

  it('leads with what the user rejected — the costliest thing to repeat', () => {
    const digest = summarizeSessionContext(sessionContext());
    expect(digest.indexOf('rejected')).toBeLessThan(digest.indexOf('accepted'));
    expect(digest.startsWith('### Edits this user rejected')).toBe(true);
  });

  it('is empty when nothing has been learned yet', () => {
    expect(
      summarizeSessionContext(
        sessionContext({
          binSummary: '',
          sessionNote: '',
          corrections: '',
          decisions: '',
          soul: '',
        }),
      ),
    ).toBe('');
  });

  it('skips only blank sections, keeping the rest', () => {
    const digest = summarizeSessionContext(sessionContext({ corrections: '   ', soul: '' }));
    expect(digest).not.toContain('rejected');
    expect(digest).toContain('kept the cold open');
  });

  it('drops whole sections at the bound rather than truncating mid-sentence', () => {
    const digest = summarizeSessionContext(sessionContext({ binSummary: 'x'.repeat(5000) }), 200);
    // The bin summary alone busts the bound, so it is omitted entirely — and the
    // higher-priority corrections still made it in.
    expect(digest).toContain('no captions over faces');
    expect(digest).not.toContain('xxxx');
    expect(digest.length).toBeLessThanOrEqual(200);
  });

  it('keeps the highest-priority section even when later ones do not fit', () => {
    const digest = summarizeSessionContext(sessionContext({ corrections: 'a'.repeat(150) }), 200);
    expect(digest).toContain('a'.repeat(150));
    expect(digest).not.toContain('kept the cold open');
  });
});

describe('createSessionContextDigester', () => {
  it('composes read + digest into the ContextInput.sessionContext string', async () => {
    const digest = createSessionContextDigester({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: sessionContext() }),
    });
    expect(await digest('p1')).toContain('no captions over faces');
  });

  it('is undefined when the brain cannot be read', async () => {
    const digest = createSessionContextDigester({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: false, status: 503 }),
    });
    expect(await digest('p1')).toBeUndefined();
  });

  it('is undefined — not an empty block — when nothing has been learned', async () => {
    const digest = createSessionContextDigester({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: { available: true } }),
    });
    expect(await digest('p1')).toBeUndefined();
  });
});

describe('visual status (MI6.2)', () => {
  const status = (over: Partial<VisualStatusResponse> = {}): VisualStatusResponse => ({
    available: true,
    reason: null,
    backend: 'sqlite-vec',
    counts: { assets: 3, spans: 40, vectors: 2841, captions: 12 },
    indexedAssets: 3,
    totalAssets: 4,
    keyConfigured: true,
    lastJob: null,
    ...over,
  });

  describe('summarizeVisualStatus', () => {
    /** The run's model can read an image, so naming `get_frame` is honest. */
    const SIGHTED = { canSeeFrames: true } as const;
    const SIGHTLESS = { canSeeFrames: false } as const;

    it('reports coverage, vector count, and backend when the footage is indexed', () => {
      const line = summarizeVisualStatus(status(), SIGHTED);
      expect(line).toContain('3/4 assets');
      expect(line).toContain('2841 vector');
      expect(line).toContain('sqlite-vec');
      expect(line).toContain('search_visual');
    });

    it('never names get_frame to a run whose model cannot read an image', () => {
      // `Orchestrator#agentTools` withholds every `vision` descriptor from a text-only
      // model and `agentModeInstruction` omits its get_frame paragraph for the same run.
      // This line used to name it anyway, so a sightless run was told to look at a frame
      // it had no tool to render — and spent reasoning working out which briefing was
      // true rather than doing the edit.
      for (const s of [
        status({ keyConfigured: false }),
        status({ indexedAssets: 0, counts: { assets: 0, vectors: 0 } }),
        status({ available: false, reason: null }),
      ]) {
        const line = summarizeVisualStatus(s, SIGHTLESS);
        expect(line).not.toContain('get_frame');
        expect(line).toContain('transcript');
      }
    });

    it('says content SEARCH is off with no embeddings key — never that it is blind', () => {
      const line = summarizeVisualStatus(status({ keyConfigured: false }), SIGHTED);
      expect(line).toContain('no embeddings key');
      // `get_frame` renders any moment as an image whatever the INDEX is doing, so
      // "you cannot see" was false, and a model told it is blind stops looking.
      expect(line).not.toContain('cannot see');
      expect(line).toContain('get_frame');
      expect(line).toContain('never guess what is on screen');
    });

    it('explains that indexing is automatic instead of naming a tool it cannot call', () => {
      const line = summarizeVisualStatus(
        status({ indexedAssets: 0, counts: { assets: 0, vectors: 0 } }),
        SIGHTED,
      );
      expect(line).toContain('0/4');
      // `index_media` is implicit lifecycle work, withheld from every model-facing scope
      // (`IMPLICIT_ONLY_TOOL_NAMES`): naming it sends the model after a tool it has not got.
      expect(line).not.toContain('index_media');
      expect(line).toContain('automatically in the background');
      expect(line).toContain('get_frame');
    });

    it('uses the singular "1 vector" when the count is exactly one', () => {
      const line = summarizeVisualStatus(status({ counts: { assets: 3, vectors: 1 } }), SIGHTED);
      expect(line).toContain('1 vector,');
      expect(line).not.toContain('1 vectors');
    });

    it('omits the backend clause when the response has no backend', () => {
      const line = summarizeVisualStatus(status({ backend: null }), SIGHTED);
      expect(line).not.toContain('backend');
    });

    it('treats a missing vector count as zero, not "assets indexed but unsearchable"', () => {
      const line = summarizeVisualStatus(
        status({ indexedAssets: 3, counts: { assets: 3, vectors: undefined as never } }),
        SIGHTED,
      );
      expect(line).toContain('0/4 assets indexed');
    });

    it('surfaces the honest reason when the brain is unavailable', () => {
      const line = summarizeVisualStatus(
        status({ available: false, reason: 'projects_root is not set' }),
        SIGHTED,
      );
      expect(line).toContain('unavailable');
      expect(line).toContain('projects_root is not set');
    });

    it('falls back to a generic reason when unavailable with none given', () => {
      const line = summarizeVisualStatus(status({ available: false, reason: null }), SIGHTED);
      expect(line).toContain('no project sandbox is configured');
    });
  });

  describe('createVisualStatusReader', () => {
    it('GETs /brain/visual/status with the project id', async () => {
      let seenUrl = '';
      const read = createVisualStatusReader({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: status() }, (url) => {
          seenUrl = url;
        }),
      });
      const result = await read('p1');
      expect(seenUrl).toBe('http://x/brain/visual/status?projectId=p1');
      expect(result?.indexedAssets).toBe(3);
    });

    it('degrades to undefined when the brain cannot be reached', async () => {
      const read = createVisualStatusReader({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: false, status: 503 }),
      });
      expect(await read('p1')).toBeUndefined();
    });

    it('returns an available:false response as-is (the summarizer wants its reason)', async () => {
      const read = createVisualStatusReader({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: { available: false, reason: 'no root' } }),
      });
      expect((await read('p1'))?.available).toBe(false);
    });

    it('degrades to undefined when the payload does not match the schema', async () => {
      const read = createVisualStatusReader({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: { nonsense: true } }),
      });
      expect(await read('p1')).toBeUndefined();
    });

    it('degrades to undefined when fetch throws', async () => {
      const read = createVisualStatusReader({
        baseUrl: 'http://x',
        fetchFn: (async () => {
          throw new Error('network down');
        }) as unknown as typeof fetch,
      });
      expect(await read('p1')).toBeUndefined();
    });

    it('stringifies a non-Error throw', async () => {
      const read = createVisualStatusReader({
        baseUrl: 'http://x',
        fetchFn: (async () => {
          throw 'plain string failure';
        }) as unknown as typeof fetch,
      });
      expect(await read('p1')).toBeUndefined();
    });

    it('falls back to the global fetch when none is injected', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchStub({ ok: true, json: status() });
      try {
        const read = createVisualStatusReader({ baseUrl: 'http://x' });
        expect((await read('p1'))?.indexedAssets).toBe(3);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('createVisualStatusDigester', () => {
    it('composes reader + summarizer into one line', async () => {
      const digest = createVisualStatusDigester({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: status() }),
      });
      expect(await digest('p1', true)).toContain('3/4 assets');
    });

    it('is undefined when the brain cannot be read (browser build, no sidecar)', async () => {
      const digest = createVisualStatusDigester({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: false, status: 503 }),
      });
      expect(await digest('p1', true)).toBeUndefined();
    });
  });
});
