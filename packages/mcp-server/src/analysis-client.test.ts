import { describe, expect, it, vi } from 'vitest';
import { TOOL_REGISTRY } from '@framepilot/ai-sdk';
import {
  ANALYSIS_ROUTES,
  AnalysisClient,
  AnalysisError,
  analysisClientFromEnv,
} from './analysis-client.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('registry → sidecar route parity (plan B7.1)', () => {
  it('maps a route for EVERY analysis-kind registry tool', () => {
    // buildMcpTools() advertises registry tools with no edit to this client, and
    // dispatch hands every analysis-kind result straight to analyze(). So the set
    // of analysis tools and the set of routes must be equal, or a tool the agent
    // can see has nowhere to go. This is the guard that makes that automatic.
    // `hostUiOnly` analysis tools (e.g. measure_color) need live editor interaction state, so
    // buildMcpTools never advertises them and the session refuses them by name. They cannot reach
    // this client, and requiring a sidecar route for them would be a route to nowhere.
    const analysisTools = TOOL_REGISTRY.filter(
      (t) => t.kind === 'analysis' && t.available && !t.hostUiOnly,
    )
      .map((t) => t.name)
      .sort();
    expect(analysisTools.length).toBeGreaterThan(0); // guard the test is meaningful
    for (const name of analysisTools) {
      expect(ANALYSIS_ROUTES[name as keyof typeof ANALYSIS_ROUTES]).toMatch(/^\//);
    }
  });

  it('reports an unmapped analysis tool instead of POSTing to an undefined route', async () => {
    const fetchFn = vi.fn();
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await expect(
      client.analyze('not_a_tool' as never, '/p/project.fp.json', {}),
    ).rejects.toThrowError(/No sidecar route is mapped/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('AnalysisClient', () => {
  it('posts analyze_silence to /analyze-silence, mapping camelCase args to snake_case', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ assetId: 'a', ranges: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    const result = await client.analyze('analyze_silence', '/p/project.fp.json', {
      assetId: 'a',
      noiseFloorDb: -40,
      minSilenceSeconds: 0.75,
    });

    expect(result).toEqual({ assetId: 'a', ranges: [] });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/analyze-silence');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      asset_id: 'a',
      noise_floor_db: -40,
      min_silence_seconds: 0.75,
    });
  });

  it('posts detect_scenes to /detect-scenes with only the threshold param', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ assetId: 'v', cuts: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('detect_scenes', '/p/project.fp.json', { threshold: 0.6 });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/detect-scenes');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      threshold: 0.6,
    });
  });

  it('posts detect_beats to /detect-beats with only the sensitivity param', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ assetId: 'm', beats: [], bpm: null }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('detect_beats', '/p/project.fp.json', { assetId: 'm', sensitivity: 2 });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/detect-beats');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      asset_id: 'm',
      sensitivity: 2,
    });
  });

  it('posts get_frame to /render/frame with timeSeconds/maxDimension/burnCaptions', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ dataUrl: 'data:image/jpeg;base64,x' }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    const result = await client.analyze('get_frame', '/p/project.fp.json', {
      timeSeconds: 4.5,
      maxDimension: 640,
      burnCaptions: true,
    });

    expect(result).toEqual({ dataUrl: 'data:image/jpeg;base64,x' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/render/frame');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      time_seconds: 4.5,
      max_dimension: 640,
      burn_captions: true,
    });
  });

  it('posts get_frame with a default timeSeconds of 0 and omits absent optionals', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ dataUrl: 'data:image/jpeg;base64,x' }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('get_frame', '/p/project.fp.json', {});

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/render/frame');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      time_seconds: 0,
    });
  });

  it('posts search_media to /brain/search with query/limit and the project path (B2.2)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ available: true, hits: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    const result = await client.analyze('search_media', '/p/project.fp.json', {
      query: 'budget review',
      limit: 10,
    });

    expect(result).toEqual({ available: true, hits: [] });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/brain/search');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      query: 'budget review',
      limit: 10,
    });
  });

  it('posts session_context to /brain/session-context with only the project path (B6.3)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ available: true, corrections: '## no captions over faces' }),
    );
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    const result = await client.analyze('session_context', '/p/project.fp.json', {});

    expect(result).toEqual({ available: true, corrections: '## no captions over faces' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/brain/session-context');
    // No args of its own: the sidecar derives the brain id from the document.
    expect(JSON.parse(init!.body as string)).toEqual({ project_path: '/p/project.fp.json' });
  });

  it('posts find_similar to /brain/similar with query/limit and the project path (B3.3)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ available: true, mode: 'blended', hits: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    const result = await client.analyze('find_similar', '/p/project.fp.json', {
      query: 'moments like the hook',
      limit: 5,
    });

    expect(result).toEqual({ available: true, mode: 'blended', hits: [] });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/brain/similar');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      query: 'moments like the hook',
      limit: 5,
    });
  });

  it('posts search_visual to /brain/visual/search with query/k/filters (MI5.1)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ available: true, packets: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    const result = await client.analyze('search_visual', '/p/project.fp.json', {
      query: 'the whiteboard',
      k: 5,
      assetIds: ['a1'],
      timeRange: [2, 8],
    });

    expect(result).toEqual({ available: true, packets: [] });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/brain/visual/search');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      query: 'the whiteboard',
      k: 5,
      asset_ids: ['a1'],
      time_range: [2, 8],
    });
  });

  it('posts describe_footage to /brain/visual/search scoped to one asset (§3.5)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ available: true, packets: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('describe_footage', '/p/project.fp.json', { assetId: 'a1' });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/brain/visual/search');
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.project_path).toBe('/p/project.fp.json');
    expect(body.asset_ids).toEqual(['a1']);
    expect(typeof body.query).toBe('string');
    expect(body.k).toBe(50);
  });

  it('forwards timeRange on describe_footage as time_range', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ available: true, packets: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('describe_footage', '/p/project.fp.json', {
      assetId: 'a1',
      timeRange: [2, 8],
    });

    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.time_range).toEqual([2, 8]);
  });

  it('posts index_media to /brain/visual/index for one bounded slice (MI4.1)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ available: true, done: false }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('index_media', '/p/project.fp.json', { assetId: 'a1', wait: true });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/brain/visual/index');
    // `wait` is a host-loop concept — never forwarded to a single-slice POST.
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      asset_ids: ['a1'],
    });
  });

  it('posts map_footage to /brain/visual/footage-map with optional assetId/refresh (FI2.1)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ available: true, chapters: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('map_footage', '/p/project.fp.json', { assetId: 'a1', refresh: true });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/brain/visual/footage-map');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      asset_id: 'a1',
      refresh: true,
    });
  });

  it('omits assetId/refresh from map_footage when absent, and ignores a falsy refresh', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ available: true, chapters: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('map_footage', '/p/project.fp.json', { refresh: false });

    expect(JSON.parse(fetchFn.mock.calls[0]![1]!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
    });
  });

  it('omits the absent search limit so the engine applies its default', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ available: true, hits: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('search_media', '/p.fp.json', { query: 'x' });
    expect(JSON.parse(fetchFn.mock.calls[0]![1]!.body as string)).toEqual({
      project_path: '/p.fp.json',
      query: 'x',
    });
  });

  it('omits absent optionals so the engine applies its own defaults', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ assetId: 'v', cuts: [] }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.analyze('analyze_silence', '/p.fp.json', {});
    expect(JSON.parse(fetchFn.mock.calls[0]![1]!.body as string)).toEqual({
      project_path: '/p.fp.json',
    });
  });

  it('throws an AnalysisError on a non-2xx response', async () => {
    const fetchFn = vi.fn(async () => new Response('no audio', { status: 422 }));
    const client = new AnalysisClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await expect(client.analyze('analyze_silence', '/p', {})).rejects.toMatchObject({
      name: 'AnalysisError',
      status: 422,
    });
    await expect(client.analyze('analyze_silence', '/p', {})).rejects.toBeInstanceOf(AnalysisError);
  });
});

describe('analysisClientFromEnv', () => {
  it('builds a client when the sidecar URL is set, else null', () => {
    expect(analysisClientFromEnv({ FRAMEPILOT_PYTHON_API_URL: 'http://x' })).toBeInstanceOf(
      AnalysisClient,
    );
    expect(analysisClientFromEnv({})).toBeNull();
  });
});
