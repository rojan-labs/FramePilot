/**
 * @framepilot/mcp-server/analysis-client — delegate ffmpeg analysis to the sidecar.
 *
 * WHY: the analysis tools (`analyze_silence`, `detect_scenes`, `detect_beats`)
 * run ffmpeg, and the media/ffmpeg engine is Python and MUST stay isolated from
 * any JS process (AGENTS.md "render-vs-preview" hard rule). The MCP host never
 * runs ffmpeg itself; it POSTs to the FastAPI sidecar (`FRAMEPILOT_PYTHON_API_URL`)
 * routes `/analyze-silence` / `/detect-scenes` / `/detect-beats`, which load the saved `project.fp.json`,
 * resolve the asset's media inside the projects sandbox, run the analysis, and
 * return structured data. `fetch` is injectable so this is unit-tested offline.
 */

/** Raised when the sidecar returns a non-2xx response. */
export class AnalysisError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}

/** The analysis tools this client can delegate (mirrors the registry names). */
export type AnalysisToolName =
  | 'transcribe'
  | 'analyze_silence'
  | 'detect_scenes'
  | 'detect_beats'
  | 'search_media'
  | 'find_similar'
  | 'search_visual'
  | 'describe_footage'
  | 'map_footage'
  | 'index_media'
  | 'get_frame'
  | 'session_context';

/**
 * The content-neutral query `describe_footage` sends: it enumerates one asset's spans in
 * time order rather than ranking a query (plan §3.5). Mirrors the canonical
 * `DESCRIBE_FOOTAGE_QUERY` in `@framepilot/ai-sdk`'s sidecar-executor — a small duplicated
 * constant instead of a cross-package import for one string. Over MCP the packets are
 * returned as the engine ranks them (the host orchestrator is what re-sorts by time).
 */
const DESCRIBE_FOOTAGE_QUERY = 'overview of what is on screen in this footage';

/** `k` for a describe read — the engine's max, to enumerate an asset's spans, not rank a few. */
const DESCRIBE_FOOTAGE_K = 50;

/** camelCase tool args as validated by the registry Zod schema. */
export type AnalysisArgs = Record<string, unknown>;

/**
 * Map an analysis tool name to its sidecar route.
 *
 * Exported so the parity test can assert this covers every analysis-kind tool in
 * the canonical registry: `buildMcpTools()` advertises registry tools
 * automatically, so a new analysis tool reaches `analyze()` with no edit here —
 * and would otherwise POST to a `undefined` route.
 */
export const ANALYSIS_ROUTES: Record<AnalysisToolName, string> = {
  transcribe: '/transcribe',
  analyze_silence: '/analyze-silence',
  detect_scenes: '/detect-scenes',
  detect_beats: '/detect-beats',
  // Brain-backed FTS (plan B2.2): posting project_path makes the sidecar
  // re-index from the saved document before matching, so hits are never stale.
  search_media: '/brain/search',
  // Semantic similarity (plan B3.3): same body as search_media; the sidecar
  // cosine-ranks embeddings blended with keywords, degrading to keyword-only
  // when no embeddings model is configured.
  find_similar: '/brain/similar',
  // Visual grounding (plan MI5/§3.4): search_visual and describe_footage fuse
  // visual-vector + caption + transcript recall into evidence packets; index_media
  // builds the visual index one slice per call. Embedding keys fall back to the
  // sidecar's FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS env (this surface has no key channel).
  search_visual: '/brain/visual/search',
  describe_footage: '/brain/visual/search',
  // Footage map (plan FI2.1/§4): a time-ordered chapter/highlight digest with no
  // query — TwelveLabs Pegasus, or the built-in span/caption derivation.
  map_footage: '/brain/visual/footage-map',
  index_media: '/brain/visual/index',
  // Single composited still (`get_frame`): the model's eyes on the edit, rendered
  // through the same compiler as the export. The MCP surface drives a SAVED project,
  // so the frame it returns is of the document on disk — which is exactly right here,
  // since an external agent's edits go through this server's own apply path first.
  get_frame: '/render/frame',
  // Session-start memory (plan B6.3): the sidecar derives the brain's project id
  // from the loaded document, so the saved path is the only input needed.
  session_context: '/brain/session-context',
};

/**
 * Translate the registry's camelCase args to the sidecar's snake_case body,
 * dropping absent optionals so the engine applies its own defaults. Only the
 * known analysis parameters are forwarded — arbitrary keys are ignored (the args
 * were already schema-validated upstream, so this is belt-and-suspenders).
 */
const toBody = (
  name: AnalysisToolName,
  projectPath: string,
  args: AnalysisArgs,
): Record<string, unknown> => {
  const body: Record<string, unknown> = { project_path: projectPath };
  // session_context takes no arguments at all — the project source alone is the
  // whole request (the sidecar derives the id from the document).
  if (name === 'session_context') return body;
  if (name === 'get_frame') {
    body.time_seconds = typeof args.timeSeconds === 'number' ? args.timeSeconds : 0;
    if (typeof args.maxDimension === 'number') body.max_dimension = args.maxDimension;
    if (typeof args.burnCaptions === 'boolean') body.burn_captions = args.burnCaptions;
    return body;
  }
  if (name === 'search_media' || name === 'find_similar') {
    // The sidecar derives the brain's project id from the loaded document.
    body.query = args.query;
    if (typeof args.limit === 'number') body.limit = args.limit;
    return body;
  }
  if (name === 'search_visual') {
    body.query = args.query;
    if (typeof args.k === 'number') body.k = args.k;
    if (Array.isArray(args.assetIds)) body.asset_ids = args.assetIds;
    if (Array.isArray(args.timeRange)) body.time_range = args.timeRange;
    return body;
  }
  if (name === 'describe_footage') {
    // No enumeration route exists (plan §3.5): a neutral query + large k scoped to the
    // one asset enumerates its spans; the engine ranks them, the caller reads them.
    body.query = DESCRIBE_FOOTAGE_QUERY;
    body.k = DESCRIBE_FOOTAGE_K;
    if (typeof args.assetId === 'string') body.asset_ids = [args.assetId];
    if (Array.isArray(args.timeRange)) body.time_range = args.timeRange;
    return body;
  }
  if (name === 'map_footage') {
    // A time-ordered footage digest with no query; the sidecar derives the project id
    // from the loaded document. Optional assetId narrows the map; refresh recomputes.
    if (typeof args.assetId === 'string') body.asset_id = args.assetId;
    if (args.refresh === true) body.refresh = true;
    return body;
  }
  if (name === 'index_media') {
    // One bounded slice per MCP call (the external agent re-calls to continue); `wait`
    // is a host-loop concept with no meaning for a single POST, so it is not forwarded.
    if (typeof args.assetId === 'string') body.asset_ids = [args.assetId];
    return body;
  }
  if (typeof args.assetId === 'string') body.asset_id = args.assetId;
  if (name === 'analyze_silence') {
    if (typeof args.noiseFloorDb === 'number') body.noise_floor_db = args.noiseFloorDb;
    if (typeof args.minSilenceSeconds === 'number')
      body.min_silence_seconds = args.minSilenceSeconds;
  } else if (name === 'detect_scenes') {
    if (typeof args.threshold === 'number') body.threshold = args.threshold;
  } else {
    if (typeof args.sensitivity === 'number') body.sensitivity = args.sensitivity;
  }
  return body;
};

export class AnalysisClient {
  private readonly fetchFn: typeof fetch;

  /**
   * @param baseUrl - Sidecar base URL (e.g. `http://127.0.0.1:8765`).
   * @param fetchFn - Injectable `fetch` (defaults to the global) for testing.
   */
  public constructor(
    private readonly baseUrl: string,
    fetchFn: typeof fetch = fetch,
  ) {
    this.fetchFn = fetchFn;
  }

  /** Run one analysis tool against a saved project; returns the sidecar's JSON. */
  public async analyze(
    name: AnalysisToolName,
    projectPath: string,
    args: AnalysisArgs,
  ): Promise<unknown> {
    const route = ANALYSIS_ROUTES[name];
    // A registry tool reaches this client without any edit here (buildMcpTools
    // auto-advertises it), so an unmapped name is a real possibility. Say so
    // instead of POSTing to `<baseUrl>undefined` and reporting the 404 as if the
    // sidecar had rejected the analysis.
    if (!route) {
      throw new AnalysisError(501, `No sidecar route is mapped for analysis tool '${name}'.`);
    }
    const response = await this.fetchFn(`${this.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toBody(name, projectPath, args)),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new AnalysisError(
        response.status,
        `Sidecar analysis request failed (${response.status}): ${detail}`,
      );
    }
    return response.json();
  }
}

/** Construct an {@link AnalysisClient} from the environment, if configured. */
export const analysisClientFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): AnalysisClient | null => {
  const baseUrl = env.FRAMEPILOT_PYTHON_API_URL;
  return baseUrl ? new AnalysisClient(baseUrl) : null;
};
