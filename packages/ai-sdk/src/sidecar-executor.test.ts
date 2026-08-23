/**
 * Tests for the sidecar-backed {@link HostToolExecutor} (Phase T3): route/body
 * translation, honest failure on non-2xx / timeout / unsupported tools, and
 * Stop-signal cancellation. `fetch` is injected — fully offline.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import {
  analysisBody,
  canUseUnifiedRoute,
  createSidecarExecutor,
  describeFootageBody,
  engineErrorDetail,
  footageMapBody,
  frameBody,
  interpretIndexLoop,
  searchBody,
  summarizeAnalysis,
  withEmptyAnalysisReading,
  unifiedAnalysisBody,
  unwrapDescribeFootage,
  unwrapFootageMap,
  unwrapFrame,
  unwrapSearch,
  unwrapSessionContext,
  unwrapUnifiedAnalysis,
  unwrapVisualSearch,
  visualSearchBody,
} from './sidecar-executor.js';
import type { VisualIndexLoopResult } from './visual-index-client.js';
import { outcomeFromExecutorError } from './tool-executor.js';
import { createAnalysisBudget } from './kernel/cost/analysis-caps.js';
import type { ToolCall } from './providers/types.js';
import { makeProject } from './__fixtures__/project.js';

const project: Project = makeProject();
const ctx = { project };
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: 'c1',
  name,
  arguments: args,
});

/** A fetch stub that records the request and replies with the given response. */
function fetchStub(
  reply: { ok: boolean; status?: number; json?: unknown; text?: string },
  onRequest?: (url: string, init: RequestInit) => void,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    onRequest?.(String(url), init ?? {});
    return {
      ok: reply.ok,
      status: reply.status ?? (reply.ok ? 200 : 500),
      json: async () => reply.json,
      text: async () => reply.text ?? '',
    } as Response;
  }) as typeof fetch;
}

describe('analysisBody', () => {
  it('translates camelCase args to snake_case per tool and inlines the project', () => {
    expect(
      analysisBody('analyze_silence', project, {
        assetId: 'a1',
        noiseFloorDb: -35,
        minSilenceSeconds: 0.4,
      }),
    ).toEqual({ project, asset_id: 'a1', noise_floor_db: -35, min_silence_seconds: 0.4 });
    expect(analysisBody('detect_scenes', project, { threshold: 0.3 })).toEqual({
      project,
      threshold: 0.3,
    });
    expect(analysisBody('detect_beats', project, { sensitivity: 1.5 })).toEqual({
      project,
      sensitivity: 1.5,
    });
    // Absent optionals are dropped so the engine applies its own defaults.
    expect(analysisBody('analyze_silence', project, {})).toEqual({ project });
  });
});

describe('unifiedAnalysisBody', () => {
  it('builds the /analyze body with the mapped kind and the project id for brain persistence', () => {
    expect(unifiedAnalysisBody('detect_beats', project, { assetId: 'a1' })).toEqual({
      project,
      assetId: 'a1',
      kinds: ['beats'],
      projectId: project.id,
    });
  });
});

describe('summarizeAnalysis', () => {
  it('summarizes each analysis result shape, with a generic fallback', () => {
    expect(summarizeAnalysis('analyze_silence', { ranges: [1, 2] })).toBe('Found 2 silent ranges');
    expect(summarizeAnalysis('analyze_silence', { ranges: [1] })).toBe('Found 1 silent range');
    expect(summarizeAnalysis('detect_scenes', { cuts: [1] })).toBe('Found 1 scene cut');
    expect(summarizeAnalysis('detect_beats', { beats: [1, 2, 3], bpm: 120.4 })).toBe(
      'Found 3 beats · ~120 BPM',
    );
    expect(summarizeAnalysis('detect_beats', { beats: [] })).toBe('Found 0 beats');
    expect(summarizeAnalysis('detect_beats', null)).toBe('Analysis complete');
  });

  it('reads an empty scene-cut result as a continuous take, not as a finding', () => {
    // The captured run filed "Found 0 scene cuts" as an established footage fact and then
    // picked 30 seconds out of 575 with no content evidence at all.
    expect(summarizeAnalysis('detect_scenes', { cuts: [] })).toBe(
      'No hard cuts in this footage — it is one continuous take',
    );
    const annotated = withEmptyAnalysisReading('detect_scenes', {
      assetId: 'asset_1',
      cuts: [],
    });
    expect(annotated.interpretation).toContain('one continuous take');
    expect(annotated.interpretation).toContain('map_footage');
    // A real result is never annotated — the cuts ARE the answer.
    expect(
      withEmptyAnalysisReading('detect_scenes', { assetId: 'asset_1', cuts: [1.5] }),
    ).not.toHaveProperty('interpretation');
    expect(withEmptyAnalysisReading('detect_beats', { beats: [] })).not.toHaveProperty(
      'interpretation',
    );
  });

  it('reports why a beat result is empty instead of "Found 0 beats"', () => {
    // "Found 0 beats" reads as a detector that listened and heard nothing; the engine's
    // reason says the media never had audio to listen to, which is what the caller acts on.
    expect(
      summarizeAnalysis('detect_beats', {
        beats: [],
        bpm: null,
        reason: 'clip.mp4 has no audio track, so there are no beats to detect.',
      }),
    ).toBe('clip.mp4 has no audio track, so there are no beats to detect.');
    // A reason alongside real beats is not a degrade — the beats are the answer.
    expect(summarizeAnalysis('detect_beats', { beats: [1], bpm: null, reason: 'x' })).toBe(
      'Found 1 beat',
    );
  });

  it('reports why a silence result is empty instead of "Found 0 silent ranges"', () => {
    // Mirrors the detect_beats reason case: "Found 0 silent ranges" reads as a detector
    // that ran over real audio; the engine's reason says the media had no audio at all.
    expect(
      summarizeAnalysis('analyze_silence', {
        ranges: [],
        reason: 'clip.mp4 has no audio track, so there is no silence to detect.',
      }),
    ).toBe('clip.mp4 has no audio track, so there is no silence to detect.');
    // A reason alongside real ranges is not a degrade — the ranges are the answer.
    expect(summarizeAnalysis('analyze_silence', { ranges: [1], reason: 'x' })).toBe(
      'Found 1 silent range',
    );
  });

  it('pluralizes/singularizes each shape correctly', () => {
    expect(summarizeAnalysis('detect_scenes', { cuts: [1, 2] })).toBe('Found 2 scene cuts');
    // A single beat with no derivable tempo: singular, no BPM suffix.
    expect(summarizeAnalysis('detect_beats', { beats: [1], bpm: null })).toBe('Found 1 beat');
  });

  it('summarizes a transcribe result, singular and plural', () => {
    expect(summarizeAnalysis('transcribe', { words: [1, 2, 3] })).toBe('Transcribed 3 timed words');
    expect(summarizeAnalysis('transcribe', { words: [1] })).toBe('Transcribed 1 timed word');
  });
});

describe('engineErrorDetail', () => {
  it('unwraps the FastAPI detail sentence and passes anything else through verbatim', () => {
    expect(engineErrorDetail('{"detail":"clip.mp4 could not be decoded."}')).toBe(
      'clip.mp4 could not be decoded.',
    );
    // Not the engine's error shape → never swallowed, never emptied.
    expect(engineErrorDetail('<html>502 Bad Gateway</html>')).toBe('<html>502 Bad Gateway</html>');
    expect(engineErrorDetail('{"detail":{"loc":["body"]}}')).toBe('{"detail":{"loc":["body"]}}');
    expect(engineErrorDetail('{"detail":""}')).toBe('{"detail":""}');
    expect(engineErrorDetail('')).toBe('');
  });

  it('reduces a FastAPI validation error to loc+msg and never echoes the rejected input', () => {
    // The real regression: `input` is the whole rejected request body — the inlined project
    // with every asset's waveform `peaks`. It was flooding the model's context and the tool
    // card with kilobytes of numbers describing a one-line mistake.
    const peaks = Array.from({ length: 2000 }, (_, i) => i / 2000);
    const body = JSON.stringify({
      detail: [
        {
          type: 'missing',
          loc: ['body', 'assetId'],
          msg: 'Field required',
          input: { project: { assets: [{ id: 'a1', media: { peaks } }] } },
        },
      ],
    });
    const detail = engineErrorDetail(body);
    expect(detail).toBe('assetId: Field required');
    expect(detail).not.toContain('peaks');
  });

  it('still reads a validation entry that is missing loc or msg', () => {
    // Defensive: pydantic always sends both, but a proxy or a future version might not,
    // and a malformed error must still say something rather than crash the settle path.
    expect(engineErrorDetail(JSON.stringify({ detail: [{ msg: 'Field required' }] }))).toBe(
      'Field required',
    );
    expect(engineErrorDetail(JSON.stringify({ detail: [{ loc: ['body', 'k'] }] }))).toBe(
      'k: invalid',
    );
  });

  it('caps any error body, so no engine response can flood the run', () => {
    const detail = engineErrorDetail(JSON.stringify({ detail: 'x'.repeat(5000) }));
    expect(detail.length).toBeLessThan(500);
    expect(detail).toMatch(/truncated/);
    // A non-JSON wall of text is bounded on the same rule.
    expect(engineErrorDetail('y'.repeat(5000)).length).toBeLessThan(500);
  });
});

describe('canUseUnifiedRoute', () => {
  it('requires a mapped tool, an explicit assetId, and no custom tuning params', () => {
    expect(canUseUnifiedRoute('analyze_silence', { assetId: 'a1' })).toBe(true);
    expect(canUseUnifiedRoute('detect_scenes', { assetId: 'a1' })).toBe(true);
    expect(canUseUnifiedRoute('detect_beats', { assetId: 'a1' })).toBe(true);
    // Id-less calls keep the legacy routes' default-asset semantics
    // (detect-scenes picks the first VIDEO asset; /analyze the first a/v asset).
    expect(canUseUnifiedRoute('analyze_silence', {})).toBe(false);
    // Custom tuning params cannot ride the unified route (it runs engine defaults).
    expect(canUseUnifiedRoute('analyze_silence', { assetId: 'a1', noiseFloorDb: -35 })).toBe(false);
    expect(canUseUnifiedRoute('detect_scenes', { assetId: 'a1', threshold: 0.3 })).toBe(false);
    expect(canUseUnifiedRoute('detect_beats', { assetId: 'a1', sensitivity: 1.5 })).toBe(false);
    expect(canUseUnifiedRoute('render_preview', { assetId: 'a1' })).toBe(false);
  });
});

describe('unwrapUnifiedAnalysis', () => {
  it('re-wraps an ok entry into the legacy payload shape, noting brain cache hits', () => {
    const response = {
      assetId: 'a1',
      depth: 'standard',
      results: [{ kind: 'silence', status: 'ok', cached: true, result: { ranges: [{}] } }],
    };
    expect(unwrapUnifiedAnalysis('analyze_silence', response)).toEqual({
      status: 'completed',
      summary: 'Found 1 silent range (from project brain)',
      data: { assetId: 'a1', ranges: [{}] },
    });
  });

  it('settles a non-ok entry to an honest failure with the engine reason', () => {
    const response = {
      assetId: 'a1',
      results: [{ kind: 'scenes', status: 'skipped', reason: 'Asset has no video timeline.' }],
    };
    const outcome = unwrapUnifiedAnalysis('detect_scenes', response);
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toMatch(/Asset has no video timeline/);
  });

  it('settles an unavailable entry to a warning so one un-analysable asset cannot end the run', () => {
    const outcome = unwrapUnifiedAnalysis('detect_beats', {
      assetId: 'a1',
      results: [
        {
          kind: 'beats',
          status: 'unavailable',
          reason: 'clip.mp4 has no audio track, so there are no beats to detect.',
        },
      ],
    });
    // `warning` is not terminal in the graph executor; `failed` is.
    expect(outcome.status).toBe('warning');
    expect(outcome.summary).toMatch(/has no audio track/);
    // No payload: an empty analysis must never reach the semantic index as a real one.
    expect(outcome.data).toBeUndefined();
  });

  it('fails on a status-less or result-less entry without a reason string', () => {
    const outcome = unwrapUnifiedAnalysis('detect_beats', {
      assetId: 'a1',
      results: [{ kind: 'beats', status: 'failed', reason: 42 }],
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      summary: expect.stringMatching(/analyzer failed/) as string,
    });
  });

  it('never fabricates a success from a malformed response', () => {
    expect(unwrapUnifiedAnalysis('detect_beats', null).status).toBe('failed');
    expect(unwrapUnifiedAnalysis('detect_beats', { results: [] }).status).toBe('failed');
    expect(
      unwrapUnifiedAnalysis('detect_beats', { assetId: 'a1', results: [{ kind: 'scenes' }] })
        .status,
    ).toBe('failed');
  });
});

describe('searchBody', () => {
  it('inlines the live project + its id and forwards query/limit', () => {
    expect(searchBody(project, { query: 'budget', limit: 5 })).toEqual({
      projectId: project.id,
      project,
      query: 'budget',
      limit: 5,
    });
    // Absent limit is dropped so the engine applies its default.
    expect(searchBody(project, { query: 'x' })).toEqual({
      projectId: project.id,
      project,
      query: 'x',
    });
  });
});

describe('unwrapSearch', () => {
  it('completes with hits, enriching asset hits with clip placements', () => {
    const outcome = unwrapSearch('search_media', project, {
      available: true,
      hits: [
        { type: 'transcript', start: 5, end: 5.9, snippet: '[budget]', score: 1.2 },
        { type: 'asset', assetId: 'asset_1', snippet: 'media/a.mp4', score: 0 },
      ],
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toBe('Found 2 matches');
    const hits = (outcome.data as { hits: Record<string, unknown>[] }).hits;
    // Transcript hits pass through untouched (already timeline seconds).
    expect(hits[0]).toEqual({
      type: 'transcript',
      start: 5,
      end: 5.9,
      snippet: '[budget]',
      score: 1.2,
    });
    // The asset hit gains the timeline placements of every clip using it.
    expect(hits[1]?.placements).toEqual([
      { clipId: 'clip_a', start: 0, end: 6 },
      { clipId: 'clip_b', start: 6, end: 10 },
    ]);
  });

  it('surfaces the degraded-FTS reason in the summary and singularizes', () => {
    const outcome = unwrapSearch('search_media', project, {
      available: true,
      reason: 'FTS5 missing',
      hits: [{ type: 'marker', markerId: 'm1', start: 2, end: 2, snippet: 'hook', score: 0.4 }],
    });
    expect(outcome.summary).toBe('Found 1 match (FTS5 missing)');
  });

  it('reports the blended semantic+keyword ranking for find_similar (B3.3)', () => {
    const outcome = unwrapSearch('find_similar', project, {
      available: true,
      mode: 'blended',
      hits: [{ type: 'transcript', start: 1, end: 2, snippet: '[hook]', score: 0.8 }],
    });
    expect(outcome.summary).toBe('Found 1 match (semantic + keyword ranking)');
  });

  it('reports the keyword-only degrade reason for find_similar (B3.3)', () => {
    const outcome = unwrapSearch('find_similar', project, {
      available: true,
      mode: 'keyword',
      reason: 'no embeddings model configured',
      hits: [],
    });
    expect(outcome.summary).toBe('Found 0 matches (no embeddings model configured)');
  });

  it('settles unavailable and malformed responses to honest failures', () => {
    const unavailable = unwrapSearch('search_media', project, {
      available: false,
      reason: 'no sandbox root',
    });
    expect(unavailable.status).toBe('failed');
    expect(unavailable.summary).toContain('no sandbox root');
    const malformed = unwrapSearch('search_media', project, 'not an object');
    expect(malformed.status).toBe('failed');
    expect(malformed.summary).toContain('malformed');
    // `data` itself absent (null/undefined), not just a non-object value.
    expect(unwrapSearch('search_media', project, null).status).toBe('failed');
  });

  it('defaults absent hits to none and ignores a malformed hit entry', () => {
    const noHits = unwrapSearch('search_media', project, { available: true });
    expect(noHits.summary).toBe('Found 0 matches');
    const nullHit = unwrapSearch('search_media', project, { available: true, hits: [null] });
    expect((nullHit.data as { hits: unknown[] }).hits).toEqual([{}]);
  });
});

describe('visual grounding (MI6.1)', () => {
  const packet = (assetId: string, t0: number, t1: number, caption: string): unknown => ({
    assetId,
    t0,
    t1,
    sceneId: Math.round(t0),
    score: 1 / (t0 + 1),
    caption,
    transcriptOverlap: '',
    sources: ['visual'],
  });

  describe('visualSearchBody', () => {
    it('forwards the live project + query and the optional filters (MI5.1)', () => {
      expect(
        visualSearchBody(project, {
          query: 'the whiteboard',
          k: 5,
          assetIds: ['a1'],
          timeRange: [2, 8],
        }),
      ).toEqual({
        projectId: project.id,
        project,
        query: 'the whiteboard',
        k: 5,
        assetIds: ['a1'],
        timeRange: [2, 8],
      });
    });

    it('omits absent optionals and sends no keys when the host holds none', () => {
      const body = visualSearchBody(project, { query: 'x' });
      expect(body).toEqual({ projectId: project.id, project, query: 'x' });
      expect(body).not.toHaveProperty('nvidiaKeys');
      expect(body).not.toHaveProperty('twelveLabsKey');
    });

    it('forwards the host-held embedding keys so search reaches the indexed backend', () => {
      const body = visualSearchBody(
        project,
        { query: 'x' },
        { twelveLabsKey: 'tl-secret', nvidiaKeys: 'nv-secret' },
      );
      expect(body.twelveLabsKey).toBe('tl-secret');
      expect(body.nvidiaKeys).toBe('nv-secret');
    });

    it('drops empty-string keys rather than shadowing the engine env fallback', () => {
      const body = visualSearchBody(project, { query: 'x' }, { twelveLabsKey: '', nvidiaKeys: '' });
      expect(body).not.toHaveProperty('twelveLabsKey');
      expect(body).not.toHaveProperty('nvidiaKeys');
    });
  });

  describe('describeFootageBody', () => {
    it('builds a keyless deterministic enumeration request for one asset (§3.5)', () => {
      const body = describeFootageBody(project, { assetId: 'a1', timeRange: [0, 4] });
      expect(body).toEqual({
        projectId: project.id,
        project,
        assetId: 'a1',
        timeRange: [0, 4],
      });
      expect(body).not.toHaveProperty('query');
    });

    it('forwards twelveLabsKey so the engine recognises the TwelveLabs backend', () => {
      const body = describeFootageBody(project, { assetId: 'a1' }, { twelveLabsKey: 'tl-secret' });
      expect(body.twelveLabsKey).toBe('tl-secret');
    });
  });

  describe('footageMapBody', () => {
    it('builds a minimal body from just the project (assetId/refresh/key all optional)', () => {
      const body = footageMapBody(project, {});
      expect(body).toEqual({ projectId: project.id, project });
    });

    it('forwards assetId, a true refresh, and a twelveLabsKey when supplied', () => {
      const body = footageMapBody(
        project,
        { assetId: 'a1', refresh: true },
        { twelveLabsKey: 'tl-secret' },
      );
      expect(body).toEqual({
        projectId: project.id,
        project,
        assetId: 'a1',
        refresh: true,
        twelveLabsKey: 'tl-secret',
      });
    });

    it('ignores a falsy refresh', () => {
      const body = footageMapBody(project, { refresh: false });
      expect(body).not.toHaveProperty('refresh');
    });
  });

  describe('unwrapFootageMap', () => {
    it('hands chapters/highlights back verbatim on a mapped response', () => {
      const outcome = unwrapFootageMap({
        available: true,
        backend: 'twelvelabs',
        durationSec: 120,
        summary: 'A product demo.',
        chapters: [{ t0: 0, t1: 10, title: 'Intro', summary: '' }],
        highlights: [{ t0: 1, t1: 2, label: 'reveal', score: 0.9 }],
      });
      expect(outcome.status).toBe('completed');
      expect(outcome.summary).toContain('Mapped 1 chapter and 1 highlight');
      const data = outcome.data as { chapters: unknown[]; highlights: unknown[]; backend: string };
      expect(data.chapters).toHaveLength(1);
      expect(data.backend).toBe('twelvelabs');
    });

    it('pluralizes chapters/highlights correctly', () => {
      const outcome = unwrapFootageMap({
        available: true,
        chapters: [
          { t0: 0, t1: 10, title: 'A' },
          { t0: 10, t1: 20, title: 'B' },
        ],
        highlights: [],
      });
      expect(outcome.summary).toContain('Mapped 2 chapters and 0 highlights');
    });

    it('is an honest no-op (warning) when available with a reason and no chapters', () => {
      const outcome = unwrapFootageMap({
        available: true,
        reason: 'not_indexed',
        chapters: [],
      });
      expect(outcome.status).toBe('warning');
      expect(outcome.summary).toContain('not_indexed');
      expect((outcome.data as { reason: string }).reason).toBe('not_indexed');
    });

    it('warns with a route the model can actually take on an empty map', () => {
      const outcome = unwrapFootageMap({ available: true, chapters: [] });
      expect(outcome.status).toBe('warning');
      // Never `index_media`: it is implicit lifecycle work and is withheld from every
      // model-facing scope, so naming it points at a capability the model has not got.
      expect(outcome.summary).not.toContain('index_media');
      expect(outcome.summary).toContain('automatically in the background');
      expect(outcome.summary).toContain('get_frame');
    });

    it('treats missing chapters/highlights keys as empty, not a crash', () => {
      const outcome = unwrapFootageMap({ available: true });
      expect(outcome.status).toBe('warning');
    });

    it('fails honestly when the brain is unavailable', () => {
      const outcome = unwrapFootageMap({ available: false, reason: 'projects_root is not set' });
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toContain('projects_root is not set');
    });

    it('fails on a malformed payload with a generic reason', () => {
      const outcome = unwrapFootageMap(null);
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toContain('footage-map response was malformed');
    });
  });

  describe('unwrapVisualSearch', () => {
    it('hands packets back verbatim on an available response with hits', () => {
      const outcome = unwrapVisualSearch('search_visual', {
        available: true,
        backend: 'sqlite-vec',
        packets: [packet('a1', 1, 3, 'a whiteboard'), packet('a1', 5, 7, 'a laptop')],
      });
      expect(outcome.status).toBe('completed');
      expect(outcome.summary).toContain('2 visual evidence packets');
      const data = outcome.data as { packets: unknown[]; backend: string };
      expect(data.packets).toHaveLength(2);
      expect(data.backend).toBe('sqlite-vec');
    });

    it('is an honest no-op (warning) when available with a reason and no packets', () => {
      const outcome = unwrapVisualSearch('search_visual', {
        available: true,
        reason: 'all_keys_failing',
        packets: [],
      });
      expect(outcome.status).toBe('warning');
      expect(outcome.summary).toContain('all_keys_failing');
      expect((outcome.data as { reason: string }).reason).toBe('all_keys_failing');
    });

    it('warns with a route the model can actually take on an empty search', () => {
      const outcome = unwrapVisualSearch('search_visual', { available: true, packets: [] });
      expect(outcome.status).toBe('warning');
      expect(outcome.summary).not.toContain('index_media');
      expect(outcome.summary).toContain('may not be indexed yet');
      expect(outcome.summary).toContain('get_frame');
    });

    it('fails honestly when the brain is unavailable, never fabricating packets', () => {
      const outcome = unwrapVisualSearch('search_visual', {
        available: false,
        reason: 'projects_root is not set',
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toContain('projects_root is not set');
    });

    it('fails on a malformed payload', () => {
      expect(unwrapVisualSearch('search_visual', null).status).toBe('failed');
      expect(unwrapVisualSearch('search_visual', 'nope').status).toBe('failed');
    });

    it('treats a missing packets key on an available response as empty, not a crash', () => {
      const outcome = unwrapVisualSearch('search_visual', { available: true });
      expect(outcome.status).toBe('warning');
    });

    it('pluralizes "1 visual evidence packet" for a single hit', () => {
      const outcome = unwrapVisualSearch('search_visual', {
        available: true,
        packets: [packet('a1', 1, 3, 'a whiteboard')],
      });
      expect(outcome.summary).toContain('1 visual evidence packet');
      expect(outcome.summary).not.toContain('1 visual evidence packets');
    });
  });

  describe('unwrapDescribeFootage', () => {
    it('re-sorts packets into a start→end walk of the footage', () => {
      const outcome = unwrapDescribeFootage({
        available: true,
        backend: 'brute-force',
        packets: [packet('a1', 5, 7, 'later'), packet('a1', 1, 3, 'earlier')],
      });
      expect(outcome.status).toBe('completed');
      expect(outcome.summary).toContain('2 scenes');
      const t0s = (outcome.data as { packets: { t0: number }[] }).packets.map((p) => p.t0);
      expect(t0s).toEqual([1, 5]);
    });

    it('sorts a packet with a non-numeric t0 last', () => {
      const outcome = unwrapDescribeFootage({
        available: true,
        packets: [{ assetId: 'a1', caption: 'no time' }, packet('a1', 1, 3, 'earlier')],
      });
      const t0s = (outcome.data as { packets: { t0: unknown }[] }).packets.map((p) => p.t0);
      expect(t0s[0]).toBe(1);
    });

    it('pluralizes "1 scene" for a single packet', () => {
      const outcome = unwrapDescribeFootage({
        available: true,
        packets: [packet('a1', 1, 3, 'only one')],
      });
      expect(outcome.summary).toContain('Described 1 scene in order');
    });

    it('passes a failure / honest no-op through unchanged', () => {
      expect(unwrapDescribeFootage({ available: false, reason: 'no brain' }).status).toBe('failed');
      expect(unwrapDescribeFootage({ available: true, packets: [] }).status).toBe('warning');
    });
  });

  describe('interpretIndexLoop', () => {
    const result = (over: Partial<VisualIndexLoopResult>): VisualIndexLoopResult => ({
      status: 'done',
      ...over,
    });

    it('reports completion with the span/asset counts', () => {
      const outcome = interpretIndexLoop(
        result({ status: 'done', last: { available: true, indexed: 12, total: 3 } as never }),
        true,
      );
      expect(outcome.status).toBe('completed');
      expect(outcome.summary).toContain('search_visual now');
    });

    it('pluralizes "1 span" and "1 asset" for a single-item result', () => {
      const outcome = interpretIndexLoop(
        result({ status: 'done', last: { available: true, indexed: 1, total: 1 } as never }),
        true,
      );
      expect(outcome.summary).toContain('1 span across 1 asset.');
    });

    it('warns honestly when no embedding key is configured', () => {
      const outcome = interpretIndexLoop(result({ status: 'no-key' }), true);
      expect(outcome.status).toBe('warning');
      expect(outcome.summary).toContain('no embedding key');
    });

    it('fails when the engine is unavailable or unreachable', () => {
      expect(interpretIndexLoop(result({ status: 'unavailable' }), true).status).toBe('failed');
      expect(interpretIndexLoop(result({ status: 'unreachable' }), true).status).toBe('failed');
    });

    it('falls back to a generic reason when unavailable with none given', () => {
      const outcome = interpretIndexLoop(result({ status: 'unavailable' }), true);
      expect(outcome.summary).toContain('visual indexing is unavailable on this build');
    });

    it("surfaces the engine's own reason when unavailable with one given", () => {
      const outcome = interpretIndexLoop(
        result({ status: 'unavailable', last: { reason: 'no sandbox root configured' } as never }),
        true,
      );
      expect(outcome.summary).toContain('no sandbox root configured');
    });

    it('reports cancellation and resumable key-failure', () => {
      expect(interpretIndexLoop(result({ status: 'cancelled' }), true).status).toBe('cancelled');
      const failing = interpretIndexLoop(
        result({ status: 'keys-failing', last: { cursor: 1, total: 4 } as never }),
        true,
      );
      expect(failing.status).toBe('warning');
      expect(failing.summary).toContain('resumable');
    });

    it('treats a single-slice (wait:false) stop as in-progress, but a waited stop as unfinished', () => {
      const kicked = interpretIndexLoop(
        result({ status: 'exhausted-slices', last: { cursor: 1, total: 4 } as never }),
        false,
      );
      expect(kicked.status).toBe('completed');
      expect(kicked.summary).toContain('background');
      const stalled = interpretIndexLoop(result({ status: 'exhausted-slices' }), true);
      expect(stalled.status).toBe('warning');
    });
  });

  describe('planSidecarCall + executor routing', () => {
    it('measures a clip through revision-bound temporal scope evidence', async () => {
      let seen: { url: string; body: Record<string, unknown> } = { url: '', body: {} };
      const samples = [0, 1, 2].flatMap((frame) =>
        ['luma', 'red', 'green', 'blue', 'saturation'].map((channel) => ({
          frame,
          channel,
          min: 0.1,
          max: 0.9,
          mean: 0.4,
          p10: 0.2,
          p50: 0.4,
          p90: 0.8,
          nearBlackRatio: 0,
          nearWhiteRatio: 0,
        })),
      );
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub(
          {
            ok: true,
            json: {
              renderSettings: {
                identity: 'temporal-evidence:1920x1080@30:captions=true',
                presetId: 'temporal-evidence',
                width: 1920,
                height: 1080,
                fps: 30,
                burnCaptions: true,
              },
              results: [
                {
                  schemaVersion: 1,
                  requestId: 'measure_color__clip_a',
                  projectRevision: project.timeline.revision ?? 0,
                  kind: 'scope',
                  samples,
                  renderSettings: {
                    identity: 'temporal-evidence:1920x1080@30:captions=true',
                    presetId: 'temporal-evidence',
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    burnCaptions: true,
                  },
                },
              ],
            },
          },
          (url, init) => {
            seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
          },
        ),
      });
      const outcome = await executor.run(call('measure_color', { clipId: 'clip_a' }), ctx);
      expect(seen.url).toBe('http://x/review/temporal-evidence');
      expect(seen.body).toMatchObject({
        requests: [
          {
            kind: 'scope',
            channels: [
              'luma',
              'red',
              'green',
              'blue',
              'saturation',
              'skin_red',
              'skin_green',
              'skin_blue',
            ],
          },
        ],
      });
      expect(outcome).toMatchObject({
        status: 'completed',
        data: {
          clipId: 'clip_a',
          samples,
          renderSettingsIdentity: 'temporal-evidence:1920x1080@30:captions=true',
        },
      });
    });

    it('rejects color measurement for a missing clip before host I/O', async () => {
      let called = false;
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: {} }, () => {
          called = true;
        }),
      });
      await expect(
        executor.run(call('measure_color', { clipId: 'missing' }), ctx),
      ).resolves.toMatchObject({
        status: 'failed',
        summary: expect.stringContaining('missing or is not visual'),
      });
      expect(called).toBe(false);
    });

    it('routes get_frame to /render/frame with the working project and settles its image', async () => {
      let seen: { url: string; body: unknown } = { url: '', body: null };
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub(
          {
            ok: true,
            json: {
              media_type: 'image/jpeg',
              base64: 'AAECAw==',
              width: 288,
              height: 512,
              time_seconds: 2,
              duration_seconds: 60,
            },
          },
          (url, init) => {
            seen = { url, body: JSON.parse(String(init.body)) };
          },
        ),
      });
      const outcome = await executor.run(call('get_frame', { timeSeconds: 2 }), ctx);
      expect(seen.url).toBe('http://x/render/frame');
      expect(seen.body).toMatchObject({ time_seconds: 2 });
      expect(outcome.status).toBe('completed');
      expect(outcome.images).toEqual([
        { mediaType: 'image/jpeg', base64: 'AAECAw==', label: 'the timeline at 2.00s' },
      ]);
    });

    it('routes search_visual to /brain/visual/search and settles its packets', async () => {
      let seen: { url: string; body: unknown } = { url: '', body: null };
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub(
          {
            ok: true,
            json: {
              available: true,
              backend: 'sqlite-vec',
              packets: [packet('a1', 1, 3, 'a shot')],
            },
          },
          (url, init) => {
            seen = { url, body: JSON.parse(String(init.body)) };
          },
        ),
      });
      const outcome = await executor.run(call('search_visual', { query: 'a shot' }), ctx);
      expect(seen.url).toBe('http://x/brain/visual/search');
      expect(seen.body).toMatchObject({ projectId: project.id, query: 'a shot' });
      expect(outcome.status).toBe('completed');
    });

    it('forwards visualIndexCredentials into search_visual so a TwelveLabs-indexed project can answer', async () => {
      let seenBody: Record<string, unknown> = {};
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        visualIndexCredentials: () => ({ twelveLabsKey: 'tl-secret' }),
        fetchFn: fetchStub({ ok: true, json: { available: true, packets: [] } }, (_url, init) => {
          seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        }),
      });
      await executor.run(call('search_visual', { query: 'x' }), ctx);
      expect(seenBody.twelveLabsKey).toBe('tl-secret');
    });

    it('uses the hostTranscribe override for transcribe and never hits the sidecar', async () => {
      let sidecarHit = false;
      const words = [{ text: 'hello', start: 0, end: 0.4 }];
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: { words: [] } }, () => {
          sidecarHit = true;
        }),
        hostTranscribe: async (_project, assetId) => {
          expect(assetId).toBe('a1');
          return { status: 'completed', summary: 'Transcribed 1 timed word', data: { words } };
        },
      });
      const outcome = await executor.run(call('transcribe', { assetId: 'a1' }), ctx);
      expect(sidecarHit).toBe(false);
      expect(outcome.status).toBe('completed');
      expect((outcome.data as { words: unknown }).words).toEqual(words);
    });

    it('fails honestly when the music host override is absent', async () => {
      // The browser surface and every test build have no host override. The tool
      // must SAY it cannot run — a fabricated track list is the failure mode this
      // arm exists to prevent, and it is the one most likely to rot (ADR 0118).
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: {} }),
      });
      for (const name of ['search_music', 'add_music']) {
        const outcome = await executor.run(call(name, { query: 'calm', remoteId: 'ov-1' }), ctx);
        expect(outcome.status).toBe('failed');
        expect(outcome.summary).toContain('desktop app');
        expect(outcome.data).toBeUndefined();
      }
    });

    it('never reaches the sidecar for a music tool', async () => {
      // The provider connection lives in the trusted host. A sidecar round-trip
      // here would mean the key or the URL had leaked a process boundary.
      let sidecarHit = false;
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: {} }, () => {
          sidecarHit = true;
        }),
        hostMusicSearch: async () => ({ status: 'completed', summary: 'ok', data: { tracks: [] } }),
        hostAddMusic: async () => ({ status: 'completed', summary: 'ok', data: {} }),
      });
      await executor.run(call('search_music', { query: 'calm' }), ctx);
      await executor.run(call('add_music', { remoteId: 'ov-1' }), ctx);
      expect(sidecarHit).toBe(false);
    });

    it('forwards the query and limit to the music host', async () => {
      let seen: { query: string; limit: number | undefined } | null = null;
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: {} }),
        hostMusicSearch: async (query, limit) => {
          seen = { query, limit };
          return { status: 'completed', summary: 'ok', data: { tracks: [] } };
        },
      });
      await executor.run(call('search_music', { query: 'calm piano', limit: 5 }), ctx);
      expect(seen).toEqual({ query: 'calm piano', limit: 5 });
    });

    it("surfaces the host's own failure sentence rather than a generic one", async () => {
      // A user told only "something went wrong" cannot tell a rate limit from an
      // outage — and the model would retry the one case where retrying is wrong.
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: {} }),
        hostMusicSearch: async () => ({
          status: 'failed',
          summary: 'Too many searches in a row. Try again in a moment.',
        }),
      });
      const outcome = await executor.run(call('search_music', { query: 'calm' }), ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toContain('Too many searches');
    });

    it('reports a refused non-commercial track with the reason, not silently', async () => {
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: {} }),
        hostAddMusic: async () => ({
          status: 'failed',
          summary: "This track can't be used in monetized videos.",
        }),
      });
      const outcome = await executor.run(call('add_music', { remoteId: 'ov-1' }), ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toContain('monetized');
    });

    it('passes undefined assetId to hostTranscribe when the call omits it', async () => {
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: { words: [] } }),
        hostTranscribe: async (_project, assetId) => {
          expect(assetId).toBeUndefined();
          return { status: 'completed', summary: 'Transcribed 0 timed words', data: { words: [] } };
        },
      });
      const outcome = await executor.run(call('transcribe', {}), ctx);
      expect(outcome.status).toBe('completed');
    });

    it('falls through to the sidecar /transcribe route when hostTranscribe returns null', async () => {
      let seenUrl = '';
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub(
          { ok: true, json: { words: [{ text: 'hi', start: 0, end: 0.2 }] } },
          (url) => {
            seenUrl = url;
          },
        ),
        // null == local whisper-cli selected: the host declines, engine handles it.
        hostTranscribe: async () => null,
      });
      const outcome = await executor.run(call('transcribe', { assetId: 'a1' }), ctx);
      expect(seenUrl).toBe('http://x/transcribe');
      expect(outcome.status).toBe('completed');
    });

    it('reports the sidecar /transcribe route returning no timed words as failed honestly', async () => {
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: { words: [] } }),
        hostTranscribe: async () => null,
      });
      const outcome = await executor.run(call('transcribe', { assetId: 'a1' }), ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toMatch(/no timed words/);
    });

    it('never puts per-asset render data on the wire', async () => {
      // The engine re-derives proxies/thumbnails/waveforms from `asset.path` and never
      // reads `asset.media`, while `peaks` is one float per waveform bucket. Sending it
      // cost every call megabytes AND gave a rejected request something catastrophic to
      // quote back: FastAPI validation errors echo the entire body they refused.
      const withMedia = {
        ...project,
        assets: project.assets.map((a) => ({
          ...a,
          media: { proxyPath: 'p.mp4', peaks: [0.1, 0.2, 0.3], thumbnailPaths: ['t.png'] },
        })),
      };
      let sent = '';
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: { assetId: 'a1', cuts: [] } }, (_url, init) => {
          sent = String(init.body);
        }),
      });
      await executor.run(call('detect_scenes', {}), { project: withMedia });
      expect(sent).not.toContain('peaks');
      expect(sent).not.toContain('proxyPath');
      // The rest of the document still travels — this is a strip, not a summary.
      expect(sent).toContain(project.assets[0]!.id);
    });

    it('settles beats on silent footage as a warning carrying the engine reason', async () => {
      const reason = 'clip.mp4 has no audio track, so there are no beats to detect.';
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        // Legacy route (a custom sensitivity cannot ride the unified one).
        fetchFn: fetchStub({ ok: true, json: { assetId: 'a1', beats: [], bpm: null, reason } }),
      });
      const outcome = await executor.run(call('detect_beats', { sensitivity: 1.5 }), ctx);
      // The run continues: `failed` here ended whole planned edits on video-only footage.
      expect(outcome.status).toBe('warning');
      expect(outcome.summary).toMatch(/has no audio track/);
      expect(outcome.data).toBeUndefined();
    });

    it('surfaces the engine sentence from a 4xx, not the raw JSON envelope', async () => {
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({
          ok: false,
          status: 422,
          text: JSON.stringify({ detail: 'ffmpeg could not decode clip.mp4.' }),
        }),
      });
      const outcome = await executor.run(call('detect_scenes', {}), ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toBe('Analysis failed (422): ffmpeg could not decode clip.mp4.');
    });

    it('routes describe_footage to the deterministic one-asset enumeration endpoint', async () => {
      let seen: { url: string; body: Record<string, unknown> } = { url: '', body: {} };
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({ ok: true, json: { available: true, packets: [] } }, (url, init) => {
          seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
        }),
      });
      await executor.run(call('describe_footage', { assetId: 'a1' }), ctx);
      expect(seen.url).toBe('http://x/brain/visual/describe');
      expect(seen.body.assetId).toBe('a1');
      expect(seen.body).not.toHaveProperty('query');
    });

    it('routes map_footage to /brain/visual/footage-map and settles its digest', async () => {
      let seen: { url: string; body: Record<string, unknown> } = { url: '', body: {} };
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub(
          {
            ok: true,
            json: {
              available: true,
              chapters: [{ t0: 0, t1: 10, title: 'Intro' }],
              highlights: [],
            },
          },
          (url, init) => {
            seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
          },
        ),
      });
      const outcome = await executor.run(call('map_footage', { refresh: true }), ctx);
      expect(seen.url).toBe('http://x/brain/visual/footage-map');
      expect(seen.body.refresh).toBe(true);
      expect(outcome.status).toBe('completed');
      expect(outcome.summary).toContain('Mapped 1 chapter');
    });

    it('drives index_media through the paced index loop to completion', async () => {
      let seenUrl = '';
      let seenBody: Record<string, unknown> = {};
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        visualIndexCredentials: () => ({
          nvidiaKeys: 'secret-embedding-key',
          captionProvider: {
            kind: 'openai',
            model: 'vision-x',
            apiKey: 'secret-caption-key',
          },
        }),
        fetchFn: fetchStub(
          {
            ok: true,
            json: {
              available: true,
              jobId: 'visual-index-1',
              cursor: 1,
              total: 1,
              done: true,
              indexed: 4,
            },
          },
          (url, init) => {
            seenUrl = url;
            seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          },
        ),
      });
      const outcome = await executor.run(call('index_media', { assetId: 'a1' }), ctx);
      expect(seenUrl).toBe('http://x/brain/visual/index');
      expect(seenBody).toMatchObject({
        projectId: project.id,
        project,
        assetIds: ['a1'],
        nvidiaKeys: 'secret-embedding-key',
        captionProvider: { model: 'vision-x' },
      });
      expect(outcome.status).toBe('completed');
      expect(outcome.summary).toContain('search_visual now');
    });

    it('indexes every visual asset when index_media omits assetId', async () => {
      let seenBody: Record<string, unknown> = {};
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub(
          {
            ok: true,
            json: { available: true, jobId: 'j', cursor: 1, total: 1, done: true, indexed: 0 },
          },
          (_url, init) => {
            seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          },
        ),
      });
      await executor.run(call('index_media', {}), ctx);
      expect(seenBody).not.toHaveProperty('assetIds');
    });

    it('forwards a caller-supplied abort signal into the index loop', async () => {
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({
          ok: true,
          json: { available: true, jobId: 'j', cursor: 1, total: 1, done: true, indexed: 0 },
        }),
      });
      const controller = new AbortController();
      const outcome = await executor.run(
        call('index_media', { assetId: 'a1' }),
        ctx,
        controller.signal,
      );
      expect(outcome.status).toBe('completed');
    });

    it('kicks a single slice and lets the background loop finish when wait:false', async () => {
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub({
          ok: true,
          json: { available: true, jobId: 'j', cursor: 1, total: 4, done: false, indexed: 1 },
        }),
      });
      const outcome = await executor.run(call('index_media', { assetId: 'a1', wait: false }), ctx);
      expect(outcome.status).toBe('completed');
      expect(outcome.summary).toContain('background');
    });

    it('drives index_media with no visualIndexCredentials configured (browser build)', async () => {
      let seenBody: Record<string, unknown> = {};
      const executor = createSidecarExecutor({
        baseUrl: 'http://x',
        fetchFn: fetchStub(
          {
            ok: true,
            json: { available: true, jobId: 'j', cursor: 1, total: 1, done: true, indexed: 0 },
          },
          (_url, init) => {
            seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          },
        ),
      });
      await executor.run(call('index_media', { assetId: 'a1' }), ctx);
      expect(seenBody).not.toHaveProperty('nvidiaKeys');
      expect(seenBody).not.toHaveProperty('captionProvider');
    });
  });
});

describe('frameBody + unwrapFrame (get_frame)', () => {
  it('defaults time_seconds to 0 when the call omits it', () => {
    expect(frameBody(project, {})).toMatchObject({ project, time_seconds: 0 });
  });

  it('forwards timeSeconds/maxDimension/burnCaptions when given', () => {
    expect(
      frameBody(project, { timeSeconds: 4.5, maxDimension: 640, burnCaptions: true }),
    ).toMatchObject({ time_seconds: 4.5, max_dimension: 640, burn_captions: true });
  });

  it('treats a null/undefined response as an empty record rather than throwing', () => {
    const outcome = unwrapFrame({}, null);
    expect(outcome.status).toBe('failed');
  });

  it('fails honestly when the engine returns no base64 image or media type', () => {
    const outcome = unwrapFrame({}, {});
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('missing');
  });

  it('fails honestly, naming the media type, when it is not one we forward', () => {
    const outcome = unwrapFrame({}, { base64: 'AAA=', media_type: 'image/gif' });
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('image/gif');
  });

  it('settles a completed frame, defaulting width/height/duration when absent', () => {
    const outcome = unwrapFrame({}, { base64: 'AAA=', media_type: 'image/jpeg' });
    expect(outcome.status).toBe('completed');
    expect(outcome.data).toMatchObject({
      timeSeconds: 0,
      requestedTimeSeconds: 0,
      clamped: false,
      width: 0,
      height: 0,
      durationSeconds: undefined,
    });
    expect(outcome.images).toEqual([
      { mediaType: 'image/jpeg', base64: 'AAA=', label: 'the timeline at 0.00s' },
    ]);
  });

  it('reports a clamped frame honestly when the engine served a different time than asked', () => {
    const outcome = unwrapFrame(
      { timeSeconds: 99 },
      {
        base64: 'AAA=',
        media_type: 'image/png',
        time_seconds: 10,
        width: 100,
        height: 200,
        duration_seconds: 10,
      },
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.data).toMatchObject({
      timeSeconds: 10,
      requestedTimeSeconds: 99,
      clamped: true,
      width: 100,
      height: 200,
      durationSeconds: 10,
    });
    expect(outcome.summary).toContain('clamped from 99.00s');
  });
});

describe('session_context (B6.3)', () => {
  const full = {
    available: true,
    binSummary: '# Media bin summary\n## a1',
    sessionNote: '## note',
    corrections: '## no captions over faces',
    decisions: '## kept the cold open',
    soul: '# Working style',
    status: { available: true, exists: true },
  };

  it('routes to /brain/session-context with just the project id', async () => {
    let seen: { url: string; body: unknown } = { url: '', body: null };
    const executor = createSidecarExecutor({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: full }, (url, init) => {
        seen = { url, body: JSON.parse(String(init.body)) };
      }),
    });
    const outcome = await executor.run(call('session_context'), ctx);
    expect(seen.url).toBe('http://x/brain/session-context');
    expect(seen.body).toEqual({ projectId: project.id });
    expect(outcome.status).toBe('completed');
  });

  it("hands back every section verbatim so the model reads the user's own words", () => {
    const outcome = unwrapSessionContext(full);
    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toContain('corrections');
    const data = outcome.data as Record<string, unknown>;
    expect(data.corrections).toBe('## no captions over faces');
    expect(data.soul).toBe('# Working style');
  });

  it('reports an empty project honestly instead of as a failure', () => {
    const outcome = unwrapSessionContext({ available: true });
    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toContain('Nothing learned');
  });

  it('fails honestly when the brain is unavailable', () => {
    const outcome = unwrapSessionContext({ available: false, reason: 'projects_root is not set' });
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('projects_root is not set');
  });

  it('fails honestly on a malformed payload rather than fabricating context', () => {
    expect(unwrapSessionContext({}).status).toBe('failed');
    expect(unwrapSessionContext(null).status).toBe('failed');
  });

  it('ignores non-string sections rather than leaking them into the prompt', () => {
    const outcome = unwrapSessionContext({ available: true, corrections: { junk: 1 }, soul: 7 });
    const data = outcome.data as Record<string, unknown>;
    expect(data.corrections).toBe('');
    expect(data.soul).toBe('');
    expect(outcome.summary).toContain('Nothing learned');
  });
});

describe('createSidecarExecutor', () => {
  it('POSTs custom-parameter calls to the legacy route and returns completed + data', async () => {
    let seenUrl = '';
    let seenBody = '';
    const executor = createSidecarExecutor({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: fetchStub({ ok: true, json: { assetId: 'a1', ranges: [] } }, (url, init) => {
        seenUrl = url;
        seenBody = String(init.body);
      }),
    });
    const outcome = await executor.run(
      call('analyze_silence', { assetId: 'a1', noiseFloorDb: -35 }),
      ctx,
    );
    expect(seenUrl).toBe('http://127.0.0.1:8765/analyze-silence');
    expect(JSON.parse(seenBody)).toMatchObject({ asset_id: 'a1', noise_floor_db: -35 });
    expect(outcome).toMatchObject({ status: 'completed', summary: 'Found 0 silent ranges' });
  });

  it('routes a default-parameter call with an assetId through the unified /analyze (B1.4)', async () => {
    let seenUrl = '';
    let seenBody = '';
    const executor = createSidecarExecutor({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: fetchStub(
        {
          ok: true,
          json: {
            assetId: 'a1',
            depth: 'standard',
            results: [{ kind: 'silence', status: 'ok', cached: false, result: { ranges: [] } }],
          },
        },
        (url, init) => {
          seenUrl = url;
          seenBody = String(init.body);
        },
      ),
    });
    const outcome = await executor.run(call('analyze_silence', { assetId: 'a1' }), ctx);
    expect(seenUrl).toBe('http://127.0.0.1:8765/analyze');
    expect(JSON.parse(seenBody)).toMatchObject({
      assetId: 'a1',
      kinds: ['silence'],
      projectId: project.id,
    });
    // The outcome data is the LEGACY payload shape consumers depend on.
    expect(outcome).toMatchObject({
      status: 'completed',
      summary: 'Found 0 silent ranges',
      data: { assetId: 'a1', ranges: [] },
    });
  });

  it('routes search_media to POST /brain/search with the live project inline (B2.2)', async () => {
    let seenUrl = '';
    let seenBody = '';
    const executor = createSidecarExecutor({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: fetchStub(
        {
          ok: true,
          json: {
            available: true,
            hits: [{ type: 'transcript', start: 1, end: 2, snippet: '[hello]', score: 0.9 }],
          },
        },
        (url, init) => {
          seenUrl = url;
          seenBody = String(init.body);
        },
      ),
    });
    const outcome = await executor.run(call('search_media', { query: 'hello', limit: 3 }), ctx);
    expect(seenUrl).toBe('http://127.0.0.1:8765/brain/search');
    expect(JSON.parse(seenBody)).toMatchObject({
      projectId: project.id,
      query: 'hello',
      limit: 3,
    });
    expect(outcome).toMatchObject({ status: 'completed', summary: 'Found 1 match' });
  });

  it('routes find_similar to POST /brain/similar and reports blended ranking (B3.3)', async () => {
    let seenUrl = '';
    let seenBody = '';
    const executor = createSidecarExecutor({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: fetchStub(
        {
          ok: true,
          json: {
            available: true,
            mode: 'blended',
            hits: [{ type: 'transcript', start: 1, end: 2, snippet: '[hook]', score: 0.9 }],
          },
        },
        (url, init) => {
          seenUrl = url;
          seenBody = String(init.body);
        },
      ),
    });
    const outcome = await executor.run(call('find_similar', { query: 'the hook', limit: 5 }), ctx);
    expect(seenUrl).toBe('http://127.0.0.1:8765/brain/similar');
    expect(JSON.parse(seenBody)).toMatchObject({
      projectId: project.id,
      query: 'the hook',
      limit: 5,
    });
    expect(outcome).toMatchObject({
      status: 'completed',
      summary: 'Found 1 match (semantic + keyword ranking)',
    });
  });

  it('routes detect_beats and summarizes the BPM', async () => {
    const executor = createSidecarExecutor({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true, json: { beats: [0.5, 1.0], bpm: 120 } }),
    });
    const outcome = await executor.run(call('detect_beats'), ctx);
    expect(outcome.summary).toBe('Found 2 beats · ~120 BPM');
  });

  it('fails honestly on a non-2xx sidecar response', async () => {
    const executor = createSidecarExecutor({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: false, status: 422, text: 'no audio asset' }),
    });
    const outcome = await executor.run(call('analyze_silence'), ctx);
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toMatch(/Analysis failed \(422\): no audio asset/);
  });

  it('reports render/export actions as not runnable from this surface', async () => {
    const executor = createSidecarExecutor({
      baseUrl: 'http://x',
      fetchFn: fetchStub({ ok: true }),
    });
    const outcome = await executor.run(call('render_preview'), ctx);
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toMatch(/not runnable from the AI panel yet/);
  });

  it('returns cancelled when the run signal aborts mid-request', async () => {
    const controller = new AbortController();
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      controller.abort();
      // Reject like a real fetch would when its signal aborts.
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      if (init?.signal?.aborted) throw error;
      throw error;
    }) as typeof fetch;
    const executor = createSidecarExecutor({ baseUrl: 'http://x', fetchFn });
    const outcome = await executor.run(call('detect_scenes'), ctx, controller.signal);
    expect(outcome).toMatchObject({ status: 'cancelled' });
  });

  it('short-circuits to cancelled when the signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      if (init?.signal?.aborted) throw error;
      return { ok: true, json: async () => ({}) } as Response;
    }) as typeof fetch;
    const executor = createSidecarExecutor({ baseUrl: 'http://x', fetchFn });
    const outcome = await executor.run(call('detect_scenes'), ctx, controller.signal);
    expect(outcome).toMatchObject({ status: 'cancelled' });
  });

  it('reports a timeout as a failed call with the timeout budget', async () => {
    const fetchFn = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const executor = createSidecarExecutor({ baseUrl: 'http://x', fetchFn, timeoutMs: 10 });
    const outcome = await executor.run(call('analyze_silence'), ctx);
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toMatch(/timed out/);
  });

  it('gives understanding-backed tools a budget the work can actually fit in', async () => {
    // Regression: one 120s budget for every tool. A footage map asks an understanding
    // model for chapters, highlights and a summary of every asset — 409s for eleven —
    // so it was killed on every attempt, and the montage was built with no map at all.
    const budgets: number[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        /* record only; the promise below settles first */
      });
      return { ok: true, json: async () => ({ available: true, assets: [] }) } as Response;
    }) as unknown as typeof fetch;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const executor = createSidecarExecutor({ baseUrl: 'http://x', fetchFn });
    await executor.run(call('map_footage'), ctx);
    await executor.run(call('detect_beats'), ctx);
    for (const invocation of timers.mock.calls) {
      if (typeof invocation[1] === 'number' && invocation[1] >= 120_000) {
        budgets.push(invocation[1]);
      }
    }
    timers.mockRestore();
    // The long tool gets minutes; the fast local one keeps the strict default, because
    // a beat grid that takes two minutes really is a fault.
    expect(Math.max(...budgets)).toBeGreaterThan(120_000);
    expect(budgets).toContain(120_000);
  });

  it('surfaces a network error as a failed call with the cause', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const executor = createSidecarExecutor({ baseUrl: 'http://x', fetchFn });
    const outcome = await executor.run(call('analyze_silence'), ctx);
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.summary).toMatch(/ECONNREFUSED/);
  });

  it('stringifies a non-Error rejection into the failure summary', async () => {
    const fetchFn = (async () => {
      // Some transports reject with plain values — the summary must still be honest.
      throw 'socket hang up';
    }) as unknown as typeof fetch;
    const executor = createSidecarExecutor({ baseUrl: 'http://x', fetchFn });
    const outcome = await executor.run(call('analyze_silence'), ctx);
    expect(outcome.summary).toBe('"analyze_silence" failed: socket hang up');
  });

  it('falls back to the global fetch when none is injected', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fetchStub({ ok: true, json: { ranges: [] } });
    try {
      const executor = createSidecarExecutor({ baseUrl: 'http://x' });
      const outcome = await executor.run(call('analyze_silence'), ctx);
      expect(outcome.status).toBe('completed');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('createSidecarExecutor — analysis budget (B5.4)', () => {
  it('leaves uncapped calls unaffected by the budget', async () => {
    const budget = createAnalysisBudget();
    const executor = createSidecarExecutor({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn: fetchStub({ ok: true, json: { assetId: 'a1', ranges: [] } }),
    });
    const outcome = await executor.run(
      call('analyze_silence', { assetId: 'a1', noiseFloorDb: -35 }),
      {
        project,
        analysisBudget: budget,
      },
    );
    expect(outcome.status).toBe('completed');
  });
});

describe('outcomeFromExecutorError', () => {
  it('maps aborts to cancelled and non-Error rejections to a stringified failure', () => {
    expect(outcomeFromExecutorError(call('detect_scenes'), new Error('x'), true)).toMatchObject({
      status: 'cancelled',
    });
    expect(outcomeFromExecutorError(call('detect_scenes'), 'boom', false)).toEqual({
      status: 'failed',
      summary: '"detect_scenes" failed: boom',
      data: 'boom',
    });
  });
});
