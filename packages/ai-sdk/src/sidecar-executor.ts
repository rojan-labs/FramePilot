/**
 * @framepilot/ai-sdk/sidecar-executor — a {@link HostToolExecutor} backed by the
 * Python FastAPI engine sidecar (plan/AGENT-NATIVE-UX.md T3).
 *
 * WHY: the analysis tools (`analyze_silence`, `detect_scenes`, `detect_beats`)
 * run ffmpeg, and the media engine is Python-only (AGENTS.md render-vs-preview
 * hard rule). This executor POSTs the agent loop's WORKING project document
 * inline to the sidecar's analysis routes and returns the structured data; the
 * sidecar still sandbox-checks every media path before ffmpeg runs. One
 * implementation serves every JS surface (browser session, desktop main
 * process) so analysis behaves identically everywhere (one-policy invariant).
 *
 * `fetch` is injectable so this is unit-tested offline; every request carries a
 * hard timeout and honors the run's AbortSignal (Stop cancels the HTTP call).
 */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { toModelProject } from './model-view.js';
import { compactFootageChapters, footageMapSchema } from './footage-map.js';
import { indexFor } from './project-index.js';
import type { AiImage, ToolCall } from './providers/types.js';
import type { HostExecutionContext, HostToolExecutor, HostToolOutcome } from './tool-executor.js';
import { outcomeCharge, preflightCharge } from './kernel/cost/analysis-caps.js';
import { TemporalEvidenceBatchSchema, TEMPORAL_EVIDENCE_VERSION } from './temporal-review.js';
import {
  VisualIndexClient,
  runVisualIndexLoop,
  type VisualIndexLoopResult,
  type VisualIndexRequestInput,
} from './visual-index-client.js';

const log = createLogger('ai-sdk:sidecar-executor');

/** The analysis tools this executor can delegate (mirrors the registry names). */
const ANALYSIS_ROUTE: Record<string, string> = {
  transcribe: '/transcribe',
  analyze_silence: '/analyze-silence',
  remove_silences: '/analyze-silence',
  detect_scenes: '/detect-scenes',
  detect_beats: '/detect-beats',
};

/**
 * The unified analyzer kind each tool maps to on `POST /analyze` (plan B1.4).
 * The unified route persists + brain-caches its results (B1.3), so a call it
 * can serve is durable across runs; the legacy single routes above stay for
 * calls it cannot express (custom tuning params, engine-side default-asset
 * resolution) — those run fresh and uncached, exactly as before.
 */
const UNIFIED_KIND: Record<string, string> = {
  analyze_silence: 'silence',
  remove_silences: 'silence',
  detect_scenes: 'scenes',
  detect_beats: 'beats',
};
const UNIFIED_ROUTE = '/analyze';

/** Brain-backed searches (plan B2.2/B3.3) — reads, but the index lives sidecar-side.
 *  Both take `{ query, limit? }` and return the same hit shape; `find_similar`
 *  ranks by embedding cosine blended with keywords instead of keywords alone. */
const SEARCH_ROUTES: Record<string, string> = {
  search_media: '/brain/search',
  find_similar: '/brain/similar',
};

/** Session-start context assembly (plan B6.3) — the memory tiers, bounded. */
const SESSION_CONTEXT_ROUTE = '/brain/session-context';

/**
 * Visual grounding routes (plan MI5/§3.4). Search is relevance-ranked; describe is
 * a deterministic enumeration of one asset's existing indexed spans. `index_media`
 * is NOT here — it drives the paced `/brain/visual/index` job through
 * {@link runVisualIndexLoop} rather than a single POST (see {@link runIndexMedia}).
 */
const VISUAL_SEARCH_ROUTE = '/brain/visual/search';
const VISUAL_DESCRIBE_ROUTE = '/brain/visual/describe';
/**
 * Footage-map route (plan FI2.1/§4) — the "map this video with no query" surface
 * behind the `map_footage` tool. Returns a time-ordered chapter/highlight digest
 * (TwelveLabs Pegasus, or the built-in span/caption derivation).
 */
const VISUAL_FOOTAGE_MAP_ROUTE = '/brain/visual/footage-map';

/**
 * Single-frame render (`get_frame`) — the model's eyes on its own edit. The engine
 * composites through the SAME compiler the export uses and returns the picture inline as
 * base64, so what the model inspects is what will be delivered.
 */
/**
 * The two tools whose absence from this seam is by DESIGN rather than a gap: rendering and
 * export run in the editor, not the AI panel (AGENTS.md render-vs-preview). Every other
 * unrouted tool is a capability this surface simply does not have, and telling the model to
 * "use the Export dialog" about, say, `detect_subjects` is a wrong instruction on top of a
 * dead-end one.
 */
const RENDER_ACTIONS: ReadonlySet<string> = new Set(['render_preview', 'export_video']);

const RENDER_FRAME_ROUTE = '/render/frame';
const TEMPORAL_EVIDENCE_ROUTE = '/review/temporal-evidence';
const MAX_COLOR_MEASUREMENT_FRAMES = 300;

/**
 * Per-tool tuning parameters the unified route cannot carry (it always runs
 * the engine defaults — its cache key must reflect what actually ran; see
 * `analyzer_effective_params` in `service.py`).
 */
const TUNING_PARAM_KEYS: Record<string, readonly string[]> = {
  analyze_silence: ['noiseFloorDb', 'minSilenceSeconds'],
  remove_silences: ['noiseFloorDb', 'minSilenceSeconds'],
  detect_scenes: ['threshold'],
  detect_beats: ['sensitivity'],
};

/**
 * Whether this call can be served by the unified `/analyze` route: an explicit
 * `assetId` (the unified route's default-asset pick — "first audio OR video
 * asset" — differs from `detect-scenes`'s "first VIDEO asset", so an id-less
 * call keeps the legacy route's exact behavior) and no custom tuning params.
 */
export function canUseUnifiedRoute(name: string, args: Record<string, unknown>): boolean {
  if (!(name in UNIFIED_KIND)) return false;
  if (typeof args.assetId !== 'string') return false;
  // `TUNING_PARAM_KEYS` is keyed by the same tool names as `UNIFIED_KIND` (see its
  // JSDoc) — the `name in UNIFIED_KIND` guard above means this lookup always hits,
  // so no `?? []` fallback: an empty array here would silently hide a real gap
  // between the two maps instead of a type error at the call site below.
  return TUNING_PARAM_KEYS[name]!.every((key) => args[key] === undefined);
}

/** Default per-call timeout — analysis decodes real media, so allow minutes, not ms. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Per-tool ceilings for work whose duration is set by how much footage there is,
 * not by how fast the machine is.
 *
 * One budget for every tool made the fast local analyses (a beat grid is seconds)
 * share a limit with the understanding-model calls that legitimately run for
 * minutes: a footage map asks Pegasus for chapters, highlights and a summary of
 * EVERY asset, and eleven assets measured 409s against a 120s budget. The map was
 * killed each time it was asked for, the planner routed around the "failure", and
 * the montage was built with no footage map and no beat grid — uniform cuts in
 * library order, which is what the user saw.
 *
 * These are ceilings for a hung engine, not estimates. Anything not listed keeps
 * the default, because a local decode that takes two minutes IS a fault.
 */
const TOOL_TIMEOUT_MS: Record<string, number> = {
  // Chapters + highlights + summary per asset, sequentially, at ~35s per asset.
  map_footage: 900_000,
  // One query, but it may wait behind the indexing of the project it searches.
  search_visual: 300_000,
  // Whole-file speech recognition; an hour of audio is a legitimate wait.
  transcribe: 900_000,
};

/** The abort ceiling for one call: the tool's own budget, else the default. */
function timeoutForTool(toolName: string, configured: number | undefined): number {
  // An explicitly configured timeout is a deliberate override (tests, embedders)
  // and wins over the table, so behaviour stays predictable where it is set.
  return configured ?? TOOL_TIMEOUT_MS[toolName] ?? DEFAULT_TIMEOUT_MS;
}

export interface SidecarExecutorOptions {
  /** Sidecar base URL (e.g. `http://127.0.0.1:8765`). */
  readonly baseUrl: string;
  /** Injectable `fetch` (defaults to the global) for testing / Electron net. */
  readonly fetchFn?: typeof fetch;
  /** Per-call timeout in ms; a hung engine must not hang the agent run. */
  readonly timeoutMs?: number;
  /**
   * Injectable clock, defaulting to `Date.now`. The run's `ffmpegSeconds` budget is
   * charged from wall clock measured around each dispatch (see {@link chargeAnalysisBudget}),
   * and a cap that can only be tested by actually waiting is a cap that goes untested.
   */
  readonly now?: () => number;
  /**
   * Resolve the host-owned credentials used by `index_media` at call time. Keeping
   * this a callback means Settings changes take effect without rebuilding the
   * orchestrator, while secrets never enter model context or logs.
   */
  readonly visualIndexCredentials?: () => Pick<
    VisualIndexRequestInput,
    'nvidiaKeys' | 'twelveLabsKey' | 'captionProvider'
  >;
  /**
   * Host-side override for `transcribe`. WHY: the local `whisper-cli` engine runs
   * in the Python sidecar, but the hosted ASR providers (groq/nvidia) live in the
   * trusted host (they hold the off-device API key and read audio bytes from disk).
   * When the user has selected a hosted provider this returns the transcript
   * outcome directly; it returns `null` to fall through to the sidecar `/transcribe`
   * route for local `whisper-cli` (which keeps that path's brain caching intact).
   * Absent ⇒ every `transcribe` uses the sidecar route (browser surface / tests).
   */
  readonly hostTranscribe?: (
    project: Project,
    assetId: string | undefined,
    signal?: AbortSignal,
  ) => Promise<HostToolOutcome | null>;
  /**
   * Host-side `search_music`. The provider network lives in the trusted host — the
   * renderer's CSP forbids it and the sidecar has no business holding a provider
   * connection — so this is the only way the tool can run.
   *
   * Absent (browser surface, tests) ⇒ the tool fails HONESTLY rather than
   * silently no-opping or, worse, reporting a fabricated list of tracks.
   */
  readonly hostMusicSearch?: (
    query: string,
    limit: number | undefined,
    signal?: AbortSignal,
  ) => Promise<HostToolOutcome>;
  /**
   * Host-side `add_music`: download the track, materialize it, and hand back the
   * asset plus whatever placement the model asked for. The orchestrator turns
   * that into the SAME reversible operations the Sounds panel builds by hand —
   * the host does the side effect, never the edit (AGENTS.md invariant 5).
   */
  readonly hostAddMusic?: (
    project: Project,
    args: {
      readonly remoteId: string;
      readonly atSeconds?: number;
      readonly duckUnderTrackId?: string;
    },
    signal?: AbortSignal,
  ) => Promise<HostToolOutcome>;
  /**
   * Host-side `search_stock`. Same reasoning as {@link hostMusicSearch}: the
   * provider key and the network live in the trusted host.
   */
  readonly hostStockSearch?: (
    args: {
      readonly query: string;
      readonly kind: 'photo' | 'video';
      readonly limit?: number;
      readonly orientation?: 'landscape' | 'portrait' | 'square';
    },
    signal?: AbortSignal,
  ) => Promise<HostToolOutcome>;
  /**
   * Host-side `add_stock`: download the chosen rendition and hand back the asset
   * plus its placement. The orchestrator turns that into the SAME reversible
   * operations the Stock panel builds by hand — the host does the side effect,
   * never the edit (AGENTS.md invariant 5).
   */
  readonly hostAddStock?: (
    project: Project,
    args: {
      readonly remoteId: string;
      readonly kind: 'photo' | 'video';
      readonly atSeconds?: number;
    },
    signal?: AbortSignal,
  ) => Promise<HostToolOutcome>;
}

/**
 * Translate the registry's camelCase args to the sidecar's snake_case body.
 * Only known analysis parameters are forwarded — args were already
 * schema-validated upstream, so this is belt-and-suspenders.
 */
export function analysisBody(
  name: string,
  project: Project,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { project };
  if (typeof args.assetId === 'string') body.asset_id = args.assetId;
  if (name === 'transcribe') {
    return body;
  }
  if (name === 'analyze_silence' || name === 'remove_silences') {
    if (typeof args.noiseFloorDb === 'number') body.noise_floor_db = args.noiseFloorDb;
    if (typeof args.minSilenceSeconds === 'number')
      body.min_silence_seconds = args.minSilenceSeconds;
  } else if (name === 'detect_scenes') {
    if (typeof args.threshold === 'number') body.threshold = args.threshold;
  } else if (name === 'detect_beats') {
    if (typeof args.sensitivity === 'number') body.sensitivity = args.sensitivity;
  }
  return body;
}

/**
 * Attach the reading of an EMPTY deterministic analysis to its own payload.
 *
 * An empty result is not knowledge, and the model has no other way to tell the difference.
 * `detect_scenes` returning `cuts: []` on a 575-second single take is the case that matters:
 * without this note the run recorded a satisfied "footage" fact and then chose thirty seconds
 * of material with no content evidence at all. The note says what the emptiness means and
 * what to reach for instead — it never invents a cut.
 */
export function withEmptyAnalysisReading(
  name: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (name === 'detect_scenes' && Array.isArray(payload.cuts) && payload.cuts.length === 0) {
    return {
      ...payload,
      interpretation:
        'No hard cut was detected anywhere in this asset, so this is one continuous take rather ' +
        'than edited material. Scene detection therefore tells you nothing about WHERE the ' +
        'interesting moments are. Ground any selection in content evidence — map_footage / ' +
        'describe_footage / search_visual for what is on screen, or get_frame at candidate ' +
        'times — and do not present timings chosen without it as "the best moments".',
    };
  }
  return payload;
}

/** One human line summarizing an analysis result for the tool card. */
export function summarizeAnalysis(name: string, data: unknown): string {
  const record = (data ?? {}) as Record<string, unknown>;
  if (name === 'measure_color' && typeof record.clipId === 'string') {
    return `Measured color on ${record.clipId}${record.occlusionFree === true ? '' : ' (sample is occluded)'}`;
  }
  if (name === 'transcribe' && Array.isArray(record.words)) {
    const n = record.words.length;
    return `Transcribed ${n} timed word${n === 1 ? '' : 's'}`;
  }
  if (name === 'analyze_silence' && Array.isArray(record.ranges)) {
    // An engine `reason` means the media had nothing to detect (no audio track) — say
    // that, not "Found 0 silent ranges", which reads as a detector that ran and came
    // up empty.
    if (record.ranges.length === 0 && typeof record.reason === 'string') return record.reason;
    const n = record.ranges.length;
    // `ranges` is filtered inside ffmpeg, so an empty list means "none that long", not
    // "none at all" — and the engine now says which. Reporting "Found 0 silent ranges"
    // over a measured 56 is the confident negative that made a whole run give up on
    // dead-air removal.
    if (n === 0 && typeof record.measuredCount === 'number' && record.measuredCount > 0) {
      const longest =
        typeof record.longestSeconds === 'number' ? Number(record.longestSeconds.toFixed(3)) : 0;
      return `No gap that long — ${record.measuredCount} shorter silence(s) measured, longest ${String(longest)}s`;
    }
    return `Found ${n} silent range${n === 1 ? '' : 's'}`;
  }
  if (name === 'detect_scenes' && Array.isArray(record.cuts)) {
    const n = record.cuts.length;
    // "Found 0 scene cuts" reads as an answer. It is the absence of one: an unedited
    // single take has no hard cut anywhere in it, and a run that files that as an
    // established footage fact goes on to pick moments out of 575 seconds with nothing
    // to go on. Say which of the two happened.
    if (n === 0) return 'No hard cuts in this footage — it is one continuous take';
    return `Found ${n} scene cut${n === 1 ? '' : 's'}`;
  }
  if (name === 'detect_beats' && Array.isArray(record.beats)) {
    // An engine `reason` means the media had nothing to detect (silent footage) — say
    // that, not "Found 0 beats", which reads as a detector that ran and came up empty.
    if (record.beats.length === 0 && typeof record.reason === 'string') return record.reason;
    const n = record.beats.length;
    const bpm = typeof record.bpm === 'number' ? ` · ~${Math.round(record.bpm)} BPM` : '';
    return `Found ${n} beat${n === 1 ? '' : 's'}${bpm}`;
  }
  return 'Analysis complete';
}

/** The unified `/analyze` request body for one tool call (camelCase aliases). */
export function unifiedAnalysisBody(
  name: string,
  project: Project,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    project,
    assetId: args.assetId,
    kinds: [UNIFIED_KIND[name]],
    // Persist/cache under this project's brain (B1.3); an engine without a
    // configured root simply runs fresh — same response shape either way.
    projectId: project.id,
  };
}

/**
 * Settle a unified `/analyze` response into the LEGACY tool outcome shape —
 * consumers (`summarizeAnalysis`, the semantic-index bag, recipe leaves) all
 * read `{ assetId, ranges | cuts | beats+bpm }`, so the entry's `result` is
 * re-wrapped with the response's resolved asset id. A malformed response never
 * fabricates a success.
 *
 * A non-`ok` entry splits by WHY it is not ok. `unavailable` means the analyzer had
 * nothing to work with — silent footage asked for beats, audio ffmpeg could not
 * measure — which is a fact about the media, not a fault: it settles to `warning`, a
 * status the graph executor does not treat as terminal, so one un-analysable asset
 * reports its reason instead of ending the run. `failed`/`skipped` (the analyzer
 * itself broke) stay an honest `failed`. Neither carries `data`: an empty result is
 * never folded into the semantic index as if it were a real one.
 */
export function unwrapUnifiedAnalysis(name: string, data: unknown): HostToolOutcome {
  const record = (data ?? {}) as Record<string, unknown>;
  const assetId = typeof record.assetId === 'string' ? record.assetId : undefined;
  const entries = Array.isArray(record.results) ? record.results : [];
  const entry = entries.find(
    (e): e is Record<string, unknown> =>
      typeof e === 'object' &&
      e !== null &&
      (e as Record<string, unknown>).kind === UNIFIED_KIND[name],
  );
  if (assetId === undefined || entry === undefined) {
    return {
      status: 'failed',
      summary: `"${name}" failed: ${unreadableEngineAnswer(
        `the analysis response carried no ${UNIFIED_KIND[name]} entry`,
      )}`,
    };
  }
  if (entry.status !== 'ok' || typeof entry.result !== 'object' || entry.result === null) {
    const reason =
      typeof entry.reason === 'string' ? entry.reason : `analyzer ${String(entry.status)}`;
    if (entry.status === 'unavailable') {
      return { status: 'warning', summary: `"${name}": ${reason}` };
    }
    return { status: 'failed', summary: `"${name}" failed: ${reason}`, data: reason };
  }
  const payload = withEmptyAnalysisReading(name, {
    assetId,
    ...(entry.result as Record<string, unknown>),
  });
  const cached = entry.cached === true ? ' (from project brain)' : '';
  return {
    status: 'completed',
    summary: `${summarizeAnalysis(name, payload)}${cached}`,
    data: payload,
  };
}

/** The `POST /brain/search|similar` body for one search call (plan B2.2/B3.3).
 *  The live WORKING project rides along so the sidecar re-indexes before
 *  matching — hits can never be stale relative to what the model is editing. */
export function searchBody(
  project: Project,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    projectId: project.id,
    project,
    query: args.query,
  };
  if (typeof args.limit === 'number') body.limit = args.limit;
  return body;
}

/**
 * Settle a `POST /brain/search` response into a tool outcome (plan B2.2).
 * Transcript/marker hits are already timeline seconds (the canonical transcript
 * is timeline-time); asset hits are enriched with the clip placements of that
 * asset via {@link indexFor}'s `clipsOfAsset` seam, so the model can jump from
 * "this file matched" to actual timeline positions. `available: false` (no
 * sandbox root / unusable brain) settles to an honest failure with the engine's
 * reason — never a fabricated empty result.
 */
export function unwrapSearch(toolName: string, project: Project, data: unknown): HostToolOutcome {
  const record = (data ?? {}) as Record<string, unknown>;
  if (record.available !== true) {
    const reason =
      typeof record.reason === 'string'
        ? record.reason
        : unreadableEngineAnswer('the search index answered with no result list');
    return { status: 'failed', summary: `"${toolName}" failed: ${reason}`, data: reason };
  }
  const index = indexFor(project);
  const hits = (Array.isArray(record.hits) ? record.hits : []).map((hit) => {
    const h = (hit ?? {}) as Record<string, unknown>;
    if (h.type !== 'asset' || typeof h.assetId !== 'string') return h;
    const placements = index
      .clipsOfAsset(h.assetId)
      .map(({ clip }) => ({ clipId: clip.id, start: clip.start, end: clip.end }));
    return { ...h, placements };
  });
  const n = hits.length;
  // `find_similar` reports HOW it ranked (plan B3.3): blended semantic+keyword,
  // or the honest keyword-only degrade (whose reason rides along below).
  const mode = record.mode === 'blended' ? ' (semantic + keyword ranking)' : '';
  const degraded = typeof record.reason === 'string' ? ` (${record.reason})` : '';
  return {
    status: 'completed',
    summary: `Found ${n} match${n === 1 ? '' : 'es'}${mode}${degraded}`,
    data: { hits },
  };
}

/**
 * The host-owned credentials the visual *query* routes forward per request. These
 * are the same secrets `index_media` sends (see {@link SidecarExecutorOptions.visualIndexCredentials}):
 * the desktop app holds the keys in Settings, not the engine env, so a query route
 * that omits them silently falls back to the (empty) built-in `sqlite-vec` store even
 * when the footage was indexed through TwelveLabs. Keys never enter model context or logs.
 */
export type VisualQueryCredentials = Pick<VisualIndexRequestInput, 'nvidiaKeys' | 'twelveLabsKey'>;

/**
 * The `POST /brain/visual/search` body for a `search_visual` call (plan MI5.1).
 * The live WORKING project rides along so the sidecar can project span asset-time
 * onto timeline time and compute `transcriptOverlap`. The host-held embedding keys are
 * forwarded (matching `index_media`) so search reaches whichever backend indexed the
 * footage — the TwelveLabs backend when `twelveLabsKey` is set, else the built-in
 * NVIDIA vector store; each still falls back to its env key when the host holds none.
 */
export function visualSearchBody(
  project: Project,
  args: Record<string, unknown>,
  credentials?: VisualQueryCredentials,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    projectId: project.id,
    project,
    query: args.query,
  };
  if (typeof args.k === 'number') body.k = args.k;
  if (Array.isArray(args.assetIds)) body.assetIds = args.assetIds;
  if (Array.isArray(args.timeRange)) body.timeRange = args.timeRange;
  if (credentials?.nvidiaKeys) body.nvidiaKeys = credentials.nvidiaKeys;
  if (credentials?.twelveLabsKey) body.twelveLabsKey = credentials.twelveLabsKey;
  return body;
}

/**
 * The dedicated `POST /brain/visual/describe` body for a `describe_footage` call.
 * No query or embedding key is required to enumerate existing indexed rows, but the
 * host-held `twelveLabsKey` is forwarded so the engine can recognise the TwelveLabs
 * backend and answer honestly (its remote index has no local per-scene spans to walk)
 * instead of reporting the footage as un-indexed from the empty local store.
 */
export function describeFootageBody(
  project: Project,
  args: Record<string, unknown>,
  credentials?: VisualQueryCredentials,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    projectId: project.id,
    project,
    assetId: args.assetId,
  };
  if (Array.isArray(args.timeRange)) body.timeRange = args.timeRange;
  if (credentials?.twelveLabsKey) body.twelveLabsKey = credentials.twelveLabsKey;
  return body;
}

/** An evidence packet as it reaches the executor, before re-shaping. */
interface RawEvidencePacket {
  readonly t0?: unknown;
}

/** Read a packet's `t0` (asset seconds) for time-ordering; non-numeric sorts last. */
function packetT0(packet: unknown): number {
  const t0 = (packet as RawEvidencePacket).t0;
  return typeof t0 === 'number' ? t0 : Number.POSITIVE_INFINITY;
}

/**
 * Settle a `POST /brain/visual/search` response into a tool outcome (plan MI5.1/§3.4).
 *
 * The engine's honest contract is preserved verbatim: `available:false` (no sandbox
 * root / unusable brain) is a real FAILURE with the reason; `available:true` WITH a
 * reason and no packets is the no-key / key-exhaustion no-op — a `warning`, not a
 * fabricated ranking; `available:true` with no reason and no packets is a legitimate
 * empty result (nothing on screen matched, or the footage is not indexed yet). Packets
 * are handed back verbatim — the model reads captions/spans and cites them.
 */
/**
 * Turn the engine's bare machine reason into a sentence the model can act on.
 *
 * The engine answers `reason: "not_indexed"` and nothing else, so the model read
 * `"describe_footage": not_indexed` — a token with no instruction in it. Captured run
 * `e36235cc` called `describe_footage` eleven times across two turns, got that token every
 * time, learned nothing from it either time, and went on to assemble a montage judged on
 * visual variety without ever knowing what was in a single clip.
 *
 * The rule these sentences follow: say what happened, say whether waiting helps, and name
 * what to do INSTEAD. A no-op that does not close itself off invites the same call again.
 */
const VISUAL_REASON_GUIDANCE: Readonly<Record<string, string>> = {
  not_indexed:
    'this clip has not been indexed, so there is nothing to describe yet. Indexing runs in ' +
    'the background and may not finish during this run — do not call this again for the ' +
    'same clip. Use what the search result already told you about it (its title and the ' +
    'query that found it), or look at a moment directly with get_frame.',
  pegasus_unavailable:
    'the understanding backend is not available for this project, so no clip can be ' +
    'described in this run. Select on the search text and titles you already have, and say ' +
    'plainly that you could not inspect the footage.',
};

/**
 * Per-tool wording for the SAME reasons, where the INSTEAD differs by what was asked.
 *
 * `map_footage` asks a different question from `describe_footage`: chapters and highlights
 * over a whole asset, not what is on screen at one moment. "Nothing to describe yet" is
 * the wrong fact for it, and a single `get_frame` is the wrong scale of substitute — an
 * asset-length map is replaced by sampling ACROSS the asset, or not at all.
 *
 * Keyed by the same reason token so there is still one vocabulary; a tool with no entry
 * falls through to the shared sentence rather than losing its guidance.
 */
const TOOL_VISUAL_REASON_GUIDANCE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  map_footage: {
    not_indexed:
      'this clip has not been indexed, so it has no chapters or highlights yet. Indexing ' +
      'runs in the background and may not finish during this run — do not call this again ' +
      'for the same clip. Sample it with get_frame at a few times across its duration, or ' +
      'work from what you already know about it (its title, its duration, and the query ' +
      'that found it) and say plainly that no map is available yet.',
    pegasus_unavailable:
      'the understanding backend is not available for this project, so no clip can be ' +
      'mapped in this run. Do not call this again for any clip. Work from the titles and ' +
      'durations you already have, look at a moment with get_frame if you need to see one, ' +
      'and say plainly that you could not map the footage.',
  },
};

/**
 * Expand a machine reason into guidance; anything unrecognized is passed through.
 *
 * @param reason - The engine's reason token, verbatim.
 * @param toolName - The tool that got it, when its INSTEAD differs from the shared one.
 */
export function visualReasonGuidance(reason: string, toolName?: string): string {
  const key = reason.trim();
  const perTool = toolName === undefined ? undefined : TOOL_VISUAL_REASON_GUIDANCE[toolName]?.[key];
  return perTool ?? VISUAL_REASON_GUIDANCE[key] ?? reason;
}

/**
 * Every sentence the two guidance tables above can hand the model, with the reason token
 * and the tool it was written for.
 *
 * Exported so the failure-quality gate (`model-facing-failure.gate.test.ts`) can WALK the
 * tables instead of quoting them: a list copied into a test rots the day someone adds a
 * reason, which is exactly how `not_indexed` sat unexpanded on the `map_footage` path
 * while `describe_footage` next door had guidance for it (captured run `369e8c82`).
 */
export function visualReasonGuidanceEntries(): readonly {
  readonly reason: string;
  readonly toolName: string | null;
  readonly guidance: string;
}[] {
  const entries: { reason: string; toolName: string | null; guidance: string }[] = [];
  for (const [reason, guidance] of Object.entries(VISUAL_REASON_GUIDANCE)) {
    entries.push({ reason, toolName: null, guidance });
  }
  for (const [toolName, table] of Object.entries(TOOL_VISUAL_REASON_GUIDANCE)) {
    for (const [reason, guidance] of Object.entries(table))
      entries.push({ reason, toolName, guidance });
  }
  return entries;
}

/**
 * The failure sentence for an answer this package could not read.
 *
 * goal.md Workstream C: "Every failure returned to the model must say what was wrong and
 * what a valid next action looks like." `search response was malformed` said the first
 * half and stopped — the caller cannot tell a broken engine from a bad argument, so its
 * only move is to send the same call again. Six settle functions produced the same
 * shape, so the sentence is written once here rather than six times.
 *
 * Modelled on {@link describeTransportFailure}, which is the one failure on this seam
 * already proven to stop a retry loop: it says WHAT broke, that the arguments are not the
 * cause, and what to do with the rest of the run.
 *
 * @param what - The specific thing that could not be read, in the editor's words.
 */
function unreadableEngineAnswer(what: string): string {
  return (
    `${what}. This is not about your arguments — the media engine's answer could not be ` +
    'read. Retry this call once; if it comes back the same way, continue without this ' +
    'result and tell the editor the media engine returned something FramePilot could not read.'
  );
}

/**
 * The failure sentence for work that only the desktop app can do.
 *
 * The fact alone ("it runs in the FramePilot desktop app") is a dead end for a caller with
 * no way to install anything: run `369e8c82` shows what a model does with a fact it cannot
 * act on, which is to try again. The move has to be named, and it is always the same one —
 * stop asking for this capability, work with what the project already holds, and tell the
 * editor what could not be done.
 *
 * @param what - The capability, capitalised, as the sentence's subject.
 * @param instead - What to do with the rest of the run, naming a tool where one applies.
 */
function desktopOnlyCapability(what: string, instead: string): string {
  return (
    `${what} is not available on this surface — it runs in the FramePilot desktop app. ` +
    `Do not call it again in this run: ${instead}`
  );
}

/**
 * The orientation a project's own frame implies, or `undefined` when it has no resolution.
 *
 * D2. Every `search_stock` call in captured run `e36235cc` asked for `landscape`, against a
 * brief whose MASTER SPECIFICATION opened `**Format:** 9:16 vertical` — and the run's own
 * recorded acceptance criterion was "Every picture clip carries its own reframe". It knew,
 * and still sourced the wrong shape for all sixty candidates.
 *
 * Read from the PROJECT, never from the prose. `acceptance.ts`'s header is explicit that
 * inventing readers for what a brief says is how you fail runs that did the work; a
 * project with no resolution set keeps the provider's default rather than a guess.
 */
export function projectOrientation(
  project: Project,
): 'landscape' | 'portrait' | 'square' | undefined {
  const width = project.resolution?.width;
  const height = project.resolution?.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    return undefined;
  }
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

export function unwrapVisualSearch(toolName: string, data: unknown): HostToolOutcome {
  const record = (data ?? {}) as Record<string, unknown>;
  if (record.available !== true) {
    const reason =
      typeof record.reason === 'string'
        ? record.reason
        : unreadableEngineAnswer('the visual index answered with no result list');
    return { status: 'failed', summary: `"${toolName}" failed: ${reason}`, data: reason };
  }
  const packets = Array.isArray(record.packets) ? record.packets : [];
  const backend = typeof record.backend === 'string' ? record.backend : null;
  if (packets.length === 0) {
    // A reason on an available response is the honest no-op (no key / keys exhausted);
    // no reason is simply an empty search — index the footage or widen the query.
    const reason =
      typeof record.reason === 'string'
        ? visualReasonGuidance(record.reason, toolName)
        : 'no visual evidence — this footage may not be indexed yet (indexing runs ' +
          'automatically in the background). Look at a moment with get_frame, widen the ' +
          'query, or say plainly that content search found nothing.';
    return {
      status: 'warning',
      summary: `"${toolName}": ${reason}`,
      data: { packets: [], backend, reason },
    };
  }
  const n = packets.length;
  return {
    status: 'completed',
    summary: `Found ${n} visual evidence packet${n === 1 ? '' : 's'}`,
    data: { packets, backend },
  };
}

/**
 * Settle a `describe_footage` read (plan §3.5): the same evidence packets as
 * {@link unwrapVisualSearch}, but re-sorted by asset time into a start→end walk of the
 * footage. A non-`completed` base outcome (failure / honest no-op) is returned as-is.
 */
export function unwrapDescribeFootage(data: unknown): HostToolOutcome {
  const base = unwrapVisualSearch('describe_footage', data);
  if (base.status !== 'completed') return base;
  const record = base.data as { packets: unknown[]; backend: string | null };
  const packets = [...record.packets].sort((a, b) => packetT0(a) - packetT0(b));
  const n = packets.length;
  return {
    status: 'completed',
    summary: `Described ${n} scene${n === 1 ? '' : 's'} in order`,
    data: { packets, backend: record.backend },
  };
}

/**
 * The `POST /brain/visual/footage-map` body for a `map_footage` call (plan FI3.1).
 * Like describe, the live WORKING project rides along so asset spans project onto
 * timeline time, and the host-held `twelveLabsKey` is forwarded so the engine
 * reaches the Pegasus arm (else it derives the map from the built-in spans). An
 * optional `assetId` narrows the map to one asset; `refresh` forces a recompute.
 */
export function footageMapBody(
  project: Project,
  args: Record<string, unknown>,
  credentials?: VisualQueryCredentials,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    projectId: project.id,
    project,
  };
  if (typeof args.assetId === 'string') body.assetId = args.assetId;
  if (args.refresh === true) body.refresh = true;
  if (credentials?.twelveLabsKey) body.twelveLabsKey = credentials.twelveLabsKey;
  return body;
}

/**
 * Settle a `POST /brain/visual/footage-map` response into a tool outcome (plan FI3.1).
 *
 * The honest contract mirrors {@link unwrapVisualSearch}: `available:false` is a real
 * FAILURE; `available:true` with a `reason` and no chapters is the honest no-op
 * (`not_indexed` / `pegasus_unavailable` / no key) — a `warning`, not a fabricated map;
 * `available:true` with chapters is the map, handed back verbatim so the model reads
 * chapters/highlights and cites their spans.
 */
/** Request body for `POST /render/frame` — the working document plus what to grab. */
export function frameBody(
  project: Project,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // The agent's in-memory working copy, not a saved path: the frame is being asked for
    // to check an edit that has not been saved yet.
    project,
    time_seconds: typeof args.timeSeconds === 'number' ? args.timeSeconds : 0,
  };
  if (typeof args.maxDimension === 'number') body.max_dimension = args.maxDimension;
  if (typeof args.burnCaptions === 'boolean') body.burn_captions = args.burnCaptions;
  return body;
}

/** Media types the SDK will forward to a provider; anything else is not an image we send. */
const FORWARDABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/**
 * Turn a `/render/frame` response into an outcome carrying the picture.
 *
 * The image goes in `images` (a real image part on the next request), NOT in `data`:
 * `data` is rendered into the run's text action log, and a base64 blob there is
 * unreadable to the model and enormous. `data` gets the FACTS about the frame instead —
 * when it was taken, how big it is — which is exactly what the action log should say, and
 * what a text-only fallback still learns.
 */
export function unwrapFrame(args: Record<string, unknown>, data: unknown): HostToolOutcome {
  const record = (data ?? {}) as Record<string, unknown>;
  const base64 = typeof record.base64 === 'string' ? record.base64 : '';
  const mediaType = typeof record.media_type === 'string' ? record.media_type : '';
  const at = typeof record.time_seconds === 'number' ? record.time_seconds : 0;
  const requested = typeof args.timeSeconds === 'number' ? args.timeSeconds : at;
  if (base64 === '' || !FORWARDABLE_IMAGE_TYPES.has(mediaType)) {
    const reason = unreadableEngineAnswer(
      `the engine returned no usable image (media type ${mediaType || 'missing'})`,
    );
    return { status: 'failed', summary: `"get_frame" failed: ${reason}`, data: reason };
  }
  const width = typeof record.width === 'number' ? record.width : 0;
  const height = typeof record.height === 'number' ? record.height : 0;
  // Say when the frame is from, and say so plainly when that is not when it was asked
  // for — a clamped time is the difference between "the end looks wrong" and "you were
  // shown a different moment than you asked about".
  const clamped = Math.abs(at - requested) > 0.001;
  const label = `the timeline at ${at.toFixed(2)}s`;
  const summary = clamped
    ? `Looked at ${label} (clamped from ${requested.toFixed(2)}s, which is outside the timeline)`
    : `Looked at ${label}`;
  return {
    status: 'completed',
    summary,
    data: {
      timeSeconds: at,
      requestedTimeSeconds: requested,
      clamped,
      width,
      height,
      durationSeconds:
        typeof record.duration_seconds === 'number' ? record.duration_seconds : undefined,
      note: 'The frame itself is attached to this turn as an image.',
    },
    images: [{ mediaType: mediaType as AiImage['mediaType'], base64, label }],
  };
}

export function unwrapFootageMap(data: unknown): HostToolOutcome {
  const record = (data ?? {}) as Record<string, unknown>;
  if (record.available !== true) {
    const reason =
      typeof record.reason === 'string'
        ? record.reason
        : unreadableEngineAnswer('the footage map came back with no chapters and no reason');
    return { status: 'failed', summary: `"map_footage" failed: ${reason}`, data: reason };
  }
  // Through the CONTRACT, not past it. `footageMapSchema` is what every other reader of a
  // footage map goes through — the context digest, the understanding panel — and it is
  // where a chapter whose summary merely repeats its title is normalised to one sentence.
  // This settle forwarded the wire record verbatim instead, so the model was the one
  // reader getting the un-normalised map: on run `accd014d` that was 28,264 characters
  // where the contract says 15,855, and `recall_evidence` returns 16,000 per call. The
  // difference was a second model turn, and the run had two left.
  //
  // `safeParse`, not `parse`: a response shape the schema does not yet know must still
  // reach the model, exactly as it did before. Normalisation is an improvement on the
  // payload, never a gate on it.
  const parsed = footageMapSchema.safeParse(record);
  const chapters = parsed.success
    ? compactFootageChapters(parsed.data.chapters)
    : Array.isArray(record.chapters)
      ? record.chapters
      : [];
  const highlights = parsed.success
    ? parsed.data.highlights
    : Array.isArray(record.highlights)
      ? record.highlights
      : [];
  const backend = typeof record.backend === 'string' ? record.backend : null;
  const summary = typeof record.summary === 'string' ? record.summary : '';
  const durationSec = typeof record.durationSec === 'number' ? record.durationSec : 0;
  if (chapters.length === 0) {
    // Through the SAME expansion `describe_footage` goes through. The engine answers
    // `not_indexed` and nothing else, so this branch used to hand the model
    // `"map_footage": not_indexed` — a token with no instruction in it, next to
    // `durationSec: 0` and an empty summary. Captured run `369e8c82` read it six times
    // over six freshly-downloaded stock clips and then placed that stock blind.
    // Unrecognized reasons (`invalid_api_key`) still pass through verbatim: guidance is
    // written from evidence, never invented for a token we have not seen fail.
    const reason =
      typeof record.reason === 'string'
        ? visualReasonGuidance(record.reason, 'map_footage')
        : 'no footage map yet — this footage may not be indexed (indexing runs ' +
          'automatically in the background). Look at a few moments with get_frame, or say ' +
          'plainly that no map is available yet.';
    return {
      status: 'warning',
      summary: `"map_footage": ${reason}`,
      data: { chapters: [], highlights: [], backend, reason, durationSec, summary },
    };
  }
  return {
    status: 'completed',
    summary: `Mapped ${chapters.length} chapter${chapters.length === 1 ? '' : 's'} and ${highlights.length} highlight${highlights.length === 1 ? '' : 's'}`,
    data: { chapters, highlights, backend, durationSec, summary },
  };
}

/**
 * Drive the paced `/brain/visual/index` job for an `index_media` call (plan MI4.1) by
 * reusing {@link runVisualIndexLoop}. `wait` (default true) runs every slice to
 * completion; `wait:false` runs a single slice and reports the job as in-progress (the
 * background auto-index continues it). The host supplies current embedding/caption
 * credentials through a callback; they never enter model context or logs. The loop
 * honours the run's `signal` (Stop cancels + best-effort cancels the job).
 */
async function runIndexMedia(
  call: ToolCall,
  ctx: HostExecutionContext,
  cfg: {
    fetchFn: typeof fetch;
    baseUrl: string;
    timeoutMs: number;
    visualIndexCredentials?: SidecarExecutorOptions['visualIndexCredentials'];
  },
  signal: AbortSignal | undefined,
): Promise<HostToolOutcome> {
  const args = call.arguments;
  const wait = args.wait !== false;
  const client = new VisualIndexClient({
    baseUrl: cfg.baseUrl,
    fetchFn: cfg.fetchFn,
    timeoutMs: cfg.timeoutMs,
  });
  const request: VisualIndexRequestInput = {
    projectId: ctx.project.id,
    project: ctx.project as unknown as Record<string, unknown>,
    ...(typeof args.assetId === 'string' ? { assetIds: [args.assetId] } : {}),
    ...(cfg.visualIndexCredentials?.() ?? {}),
  };
  const result = await runVisualIndexLoop({
    client,
    request,
    ...(signal ? { signal } : {}),
    // wait:false is a single kick — start the job and let the background loop finish it.
    ...(wait ? {} : { maxSlices: 1 }),
  });
  return interpretIndexLoop(result, wait);
}

/** Settle a {@link VisualIndexLoopResult} into an honest tool outcome (plan MI4.1). */
export function interpretIndexLoop(result: VisualIndexLoopResult, wait: boolean): HostToolOutcome {
  const indexed = result.last?.indexed ?? 0;
  const total = result.last?.total ?? 0;
  const cursor = result.last?.cursor ?? 0;
  switch (result.status) {
    case 'done':
      return {
        status: 'completed',
        summary: `Indexed the footage — ${indexed} span${indexed === 1 ? '' : 's'} across ${total} asset${total === 1 ? '' : 's'}. You can search_visual now.`,
        data: result.last,
      };
    case 'no-key':
      return {
        status: 'warning',
        // The key has to be added by a person in Settings, so the caller's move is not to
        // fix it — it is to stop asking and work without an index. Naming only the human's
        // move is the `Place it from the bin` mistake of run `369e8c82`.
        summary:
          '"index_media": no embedding key is configured, so the footage cannot be indexed ' +
          'and search_visual, describe_footage and map_footage have nothing to answer from. ' +
          'Do not call it again in this run. Look at moments directly with get_frame, and ' +
          'tell the editor to add an NVIDIA embeddings key in Settings → AI → Embeddings if ' +
          'they want content search.',
        data: result.last,
      };
    case 'unavailable':
      return {
        status: 'failed',
        // The REASON may be the engine's own words and is kept verbatim; the instruction
        // after it is keyed to the loop status, which this package classified itself, so it
        // is written from evidence rather than guessed at a token we have not seen.
        summary:
          `"index_media" failed: ${result.last?.reason ?? 'visual indexing is unavailable on this build'}. ` +
          'Indexing cannot be made to work from here, so do not call it again in this run. ' +
          'Look at moments directly with get_frame, and tell the editor that content search ' +
          'is unavailable for this project.',
        data: result.last,
      };
    case 'unreachable':
      // Worded like `describeTransportFailure`, for the same reason: a dead socket is
      // transient, so the honest instruction is one retry and then carry on without it.
      return {
        status: 'failed',
        summary:
          '"index_media" failed: the media engine is unreachable. This is not about your ' +
          'arguments: retry this call once; if it fails again, continue without an index — ' +
          'look at moments with get_frame — and tell the editor the media engine is not ' +
          'responding.',
      };
    case 'cancelled':
      return { status: 'cancelled', summary: 'Stopped "index_media" — run cancelled' };
    case 'keys-failing':
      return {
        status: 'warning',
        summary:
          `"index_media": embedding keys are failing — indexed ${cursor}/${total} so far, and ` +
          'the rest is resumable later. Do not call it again in this run; the same keys will ' +
          'fail. Search what is already indexed with search_visual, look at the rest with ' +
          'get_frame, and tell the editor the index is incomplete.',
        data: result.last,
      };
    case 'exhausted-slices':
      // wait:false stops after one slice on purpose; wait:true hitting the bound is odd.
      return {
        status: wait ? 'warning' : 'completed',
        summary: wait
          ? `"index_media" did not finish (indexed ${cursor}/${total}); call index_media again to continue where it stopped.`
          : `Indexing started — ${cursor}/${total} assets done, continuing in the background.`,
        data: result.last,
      };
  }
}

/**
 * Settle a `POST /brain/session-context` response into a tool outcome (B6.3).
 *
 * The sections are handed back verbatim (the engine already bounds them: the
 * corrections/decisions tails and the soul digest are capped there) so the model
 * reads the user's actual words, not a summary of them. `available: false` — no
 * sandbox root, traversal-rejected id — settles to an honest failure. A project
 * with nothing learned yet is a legitimate success with empty sections: a first
 * session must not look like a broken one.
 */
export function unwrapSessionContext(data: unknown): HostToolOutcome {
  const record = (data ?? {}) as Record<string, unknown>;
  if (record.available !== true) {
    const reason =
      typeof record.reason === 'string'
        ? record.reason
        : unreadableEngineAnswer('the session context came back with no sections and no reason');
    return { status: 'failed', summary: `"session_context" failed: ${reason}`, data: reason };
  }
  const text = (key: string): string => (typeof record[key] === 'string' ? record[key] : '');
  const sections = {
    binSummary: text('binSummary'),
    sessionNote: text('sessionNote'),
    corrections: text('corrections'),
    decisions: text('decisions'),
    soul: text('soul'),
  };
  const present = Object.entries(sections)
    .filter(([, value]) => value.trim() !== '')
    .map(([key]) => key);
  const summary =
    present.length === 0
      ? 'Nothing learned about this project yet — starting fresh'
      : `Loaded project memory: ${present.join(', ')}`;
  return { status: 'completed', summary, data: { ...sections, status: record.status } };
}

/** A resolved sidecar call: the relative route, its request body, and how to
 *  settle the response into a {@link HostToolOutcome}. */
interface SidecarPlan {
  readonly route: string;
  readonly body: Record<string, unknown>;
  readonly interpret: (data: unknown) => HostToolOutcome;
}

/**
 * Resolve a tool call to its sidecar route + body + response interpreter, or
 * `null` when this executor has no route for it (render/export actions). Keeping
 * the branching here — one arm per capability family — keeps the executor's
 * `run` loop (signals, timeout, logging) free of routing ternaries.
 */
export function planSidecarCall(
  call: ToolCall,
  ctx: HostExecutionContext,
  credentials?: VisualQueryCredentials,
): SidecarPlan | null {
  const { name, arguments: args } = call;
  // Every route below inlines the working document. It goes over the wire WITHOUT the
  // per-asset render block: the engine re-derives proxies, thumbnails and waveforms from
  // `asset.path` and never reads `asset.media` (`timeline/models.py` keeps it optional and
  // unused), while `peaks` alone is one float per waveform bucket — megabytes for a real
  // bin, on every analysis call. Keeping it off the request also means a rejected request
  // cannot echo it back: FastAPI's validation errors quote the whole body they refused.
  const project = toModelProject(ctx.project);
  if (name === 'measure_color') {
    const clipId = typeof args.clipId === 'string' ? args.clipId : '';
    const target = project.timeline.tracks
      .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
      .find(({ clip }) => clip.id === clipId);
    if (!target) return null;
    const fps = project.fps;
    const clipStartFrame = Math.max(0, Math.ceil(target.clip.start * fps));
    const clipEndFrame = Math.max(clipStartFrame + 1, Math.ceil(target.clip.end * fps));
    const endFrame = Math.min(clipEndFrame, clipStartFrame + MAX_COLOR_MEASUREMENT_FRAMES);
    // Caption tracks are excluded because the measurement render turns caption
    // burn-in off (see `temporal_evidence.acquire_temporal_evidence`). Counting them
    // meant a caption track spanning the programme — the ordinary case — marked every
    // measurement occluded, and `match_reference` could then never succeed on a real
    // project. Any other visible layer over the shot still contaminates the reading.
    const occlusionFree = !project.timeline.tracks.some(
      (track) =>
        track.type !== 'audio' &&
        track.type !== 'caption' &&
        track.clips.some(
          (clip) =>
            clip.id !== clipId && clip.start < endFrame / fps && clip.end > clipStartFrame / fps,
        ),
    );
    const requestId = `measure_color__${clipId}`;
    return {
      route: TEMPORAL_EVIDENCE_ROUTE,
      body: {
        project,
        requests: [
          {
            schemaVersion: TEMPORAL_EVIDENCE_VERSION,
            requestId,
            projectRevision: project.timeline.revision ?? 0,
            kind: 'scope',
            startFrame: clipStartFrame,
            endFrame,
            // Skin is measured alongside the frame every time rather than on
            // request: a match that later has to hold skin cannot go back and
            // re-measure the shot at the revision it was graded from.
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
            legalMin: 0,
            legalMax: 1,
            reason: `Measure color distribution for clip ${clipId}`,
          },
        ],
      },
      interpret: (data) => {
        const parsed = TemporalEvidenceBatchSchema.safeParse(data);
        if (!parsed.success) {
          return {
            status: 'failed',
            summary: 'Color measurement returned an invalid evidence batch.',
          };
        }
        const result = parsed.data.results.find(
          (candidate) => candidate.requestId === requestId && candidate.kind === 'scope',
        );
        if (!result || result.kind !== 'scope') {
          return { status: 'failed', summary: 'Color measurement returned no scope samples.' };
        }
        const measurement = {
          schemaVersion: 1 as const,
          projectRevision: result.projectRevision,
          clipId,
          trackId: target.track.id,
          startFrame: clipStartFrame,
          endFrame,
          isolation: 'timeline_composite' as const,
          occlusionFree,
          samples: result.samples,
          renderSettingsIdentity: parsed.data.renderSettings.identity,
        };
        return {
          status: 'completed',
          summary: summarizeAnalysis(name, measurement),
          data: measurement,
        };
      },
    };
  }
  const searchRoute = SEARCH_ROUTES[name];
  if (searchRoute !== undefined) {
    return {
      route: searchRoute,
      body: searchBody(project, args),
      interpret: (data) => unwrapSearch(name, project, data),
    };
  }
  if (name === 'search_visual') {
    return {
      route: VISUAL_SEARCH_ROUTE,
      body: visualSearchBody(project, args, credentials),
      interpret: (data) => unwrapVisualSearch(name, data),
    };
  }
  if (name === 'describe_footage') {
    return {
      route: VISUAL_DESCRIBE_ROUTE,
      body: describeFootageBody(project, args, credentials),
      interpret: unwrapDescribeFootage,
    };
  }
  if (name === 'map_footage') {
    return {
      route: VISUAL_FOOTAGE_MAP_ROUTE,
      body: footageMapBody(project, args, credentials),
      interpret: unwrapFootageMap,
    };
  }
  if (name === 'get_frame') {
    return {
      route: RENDER_FRAME_ROUTE,
      body: frameBody(project, args),
      interpret: (data) => unwrapFrame(args, data),
    };
  }
  if (name === 'session_context') {
    return {
      route: SESSION_CONTEXT_ROUTE,
      body: { projectId: project.id },
      interpret: unwrapSessionContext,
    };
  }
  // Default-parameter calls with an explicit asset ride the unified route, so
  // their results persist in the project brain and repeat calls across runs are
  // cache hits (B1.3/B1.4); everything else keeps the legacy single route.
  if (canUseUnifiedRoute(name, args)) {
    return {
      route: UNIFIED_ROUTE,
      body: unifiedAnalysisBody(name, project, args),
      interpret: (data) => unwrapUnifiedAnalysis(name, data),
    };
  }
  const route = ANALYSIS_ROUTE[name];
  if (route === undefined) return null;
  return {
    route,
    body: analysisBody(name, project, args),
    interpret: (data) => {
      if (name === 'transcribe') {
        const words = (data as { words?: unknown }).words;
        if (!Array.isArray(words) || words.length === 0) {
          return {
            status: 'failed',
            summary:
              '"transcribe" returned no timed words, so the existing transcript was ' +
              'preserved. Speech-to-text found nothing to time — do not call it again for ' +
              'this asset. Check with list_assets that you named the one carrying speech, ' +
              'or say plainly that this footage has no usable speech to caption.',
            data,
          };
        }
      }
      // An analysis the media itself cannot support (beats on silent footage) comes back
      // 200 with an empty result and a `reason`. That is a fact to report and continue
      // from, not a failure — `warning` keeps the run alive, and dropping `data` keeps the
      // empty result out of the semantic index. Mirrors the unified route's `unavailable`.
      const reason = (data as { reason?: unknown }).reason;
      if (typeof reason === 'string' && reason.length > 0) {
        return { status: 'warning', summary: `"${name}": ${reason}` };
      }
      const payload = withEmptyAnalysisReading(name, (data ?? {}) as Record<string, unknown>);
      return { status: 'completed', summary: summarizeAnalysis(name, payload), data: payload };
    },
  };
}

/**
 * Enforce the run's per-call analysis budget around one dispatch (plan B5.4).
 *
 * This is where the cap `kernel/cost/analysis-caps.ts` describes actually happens, and the
 * order matters: CHECK before the call (an over-budget call fails honestly and never runs,
 * so the compute is not spent to discover it was unaffordable), RECORD after it settles
 * from what the engine really did. Both are no-ops when the caller threads no budget — a
 * one-off MCP call has no run to bound.
 *
 * The refusal is a `failed` outcome carrying the cap's own sentence, not a thrown error:
 * the model must be able to read why it was refused and choose different work, which is
 * the same standard every other honest unavailability on this seam is held to.
 *
 * @param dispatch - The real executor, invoked only when the budget allows the call.
 * @param now - Injected clock; the ffmpeg charge is measured wall clock, so a test must be
 *   able to make time pass deterministically.
 */
export async function chargeAnalysisBudget(
  dispatch: HostToolExecutor,
  call: ToolCall,
  ctx: HostExecutionContext,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<HostToolOutcome> {
  const budget = ctx.analysisBudget;
  if (!budget) return dispatch.run(call, ctx, signal);
  const preflight = preflightCharge(call);
  if (preflight) {
    const decision = budget.check(preflight);
    if (!decision.allowed) {
      log.warn('run → refused, analysis budget exhausted', {
        tool: call.name,
        resource: preflight.resource,
        reason: decision.reason,
      });
      return {
        status: 'failed',
        // The cap's own reason is kept verbatim (it carries the numbers); what follows is
        // the move, because a refusal that reads as a transient failure gets retried, and
        // every retry is refused identically for the rest of the run.
        summary:
          `"${call.name}" was not run — ${decision.reason}. Retrying it will be refused the ` +
          'same way for the rest of this run. Work from the analysis you already have, and ' +
          'tell the editor which measurement you had to skip.',
        data: decision.reason,
      };
    }
  }
  const startedAt = now();
  const outcome = await dispatch.run(call, ctx, signal);
  const charge = outcomeCharge(call.name, outcome.data, now() - startedAt);
  if (charge) budget.record(charge);
  return outcome;
}

/**
 * Create the sidecar-backed executor. Analysis tools run for real; render/export
 * actions are reported as not-yet-supported on this surface (honest `failed`,
 * so the model routes the user to the Export dialog instead of pretending).
 */
export function createSidecarExecutor(options: SidecarExecutorOptions): HostToolExecutor {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const dispatch: HostToolExecutor = {
    async run(
      call: ToolCall,
      ctx: HostExecutionContext,
      signal?: AbortSignal,
    ): Promise<HostToolOutcome> {
      const timeoutMs = timeoutForTool(call.name, options.timeoutMs);
      // index_media is not a single POST — it drives a paced multi-slice job. Handle it
      // before the single-request scaffolding below (it owns its own per-slice timeout
      // and signal handling via runVisualIndexLoop). Every branch returns an outcome.
      if (call.name === 'index_media') {
        log.action('run → driving visual index job', { tool: call.name });
        const outcome = await runIndexMedia(
          call,
          ctx,
          {
            fetchFn,
            baseUrl: options.baseUrl,
            timeoutMs,
            ...(options.visualIndexCredentials
              ? { visualIndexCredentials: options.visualIndexCredentials }
              : {}),
          },
          signal,
        );
        log.action('run ← visual index job settled', {
          tool: call.name,
          status: outcome.status,
          summary: outcome.summary,
        });
        return outcome;
      }
      // Honor a user-selected hosted ASR provider (groq/nvidia): the host transcribes
      // off-device with its own key and returns the words. A null result means the local
      // whisper-cli path is selected, so fall through to the sidecar /transcribe route.
      if (call.name === 'transcribe' && options.hostTranscribe) {
        const assetId =
          typeof call.arguments?.assetId === 'string' ? call.arguments.assetId : undefined;
        log.action('run → host ASR override for transcribe', { tool: call.name });
        const hosted = await options.hostTranscribe(ctx.project, assetId, signal);
        if (hosted !== null) {
          log.action('run ← host ASR override settled', {
            tool: call.name,
            status: hosted.status,
          });
          return hosted;
        }
      }
      // Music sourcing is host-only: the provider key, the network and the disk
      // write all live in main. Missing the override is a real unavailability,
      // not a reason to invent a result (ADR 0118).
      if (call.name === 'search_music') {
        if (!options.hostMusicSearch) {
          return {
            status: 'failed',
            summary: desktopOnlyCapability(
              'Music search',
              'score the edit with audio the project already holds (list_assets shows it), ' +
                'and tell the editor that searching for music needs the desktop app.',
            ),
          };
        }
        const query = typeof call.arguments?.query === 'string' ? call.arguments.query : '';
        const limit = typeof call.arguments?.limit === 'number' ? call.arguments.limit : undefined;
        log.action('run → host music search', { tool: call.name });
        return await options.hostMusicSearch(query, limit, signal);
      }
      if (call.name === 'add_music') {
        if (!options.hostAddMusic) {
          return {
            status: 'failed',
            summary: desktopOnlyCapability(
              'Adding music',
              'place audio the project already holds with add_clip (list_assets shows it), ' +
                'and tell the editor that downloading music needs the desktop app.',
            ),
          };
        }
        // Every declared parameter is forwarded. Dropping `atSeconds` or
        // `duckUnderTrackId` here would accept the model's instruction and then
        // silently ignore it — a bed at 0 s, full gain, reported as ducked.
        const remoteId =
          typeof call.arguments?.remoteId === 'string' ? call.arguments.remoteId : '';
        const rawAtSeconds =
          typeof call.arguments?.atSeconds === 'number' ? call.arguments.atSeconds : undefined;
        // A negative start is out of the tool's contract; both builders clamp to
        // 0 anyway, so clamp here rather than failing the whole download for it.
        const atSeconds = rawAtSeconds === undefined ? undefined : Math.max(0, rawAtSeconds);
        const rawDuckUnderTrackId =
          typeof call.arguments?.duckUnderTrackId === 'string'
            ? call.arguments.duckUnderTrackId
            : undefined;
        const duckUnderTrackId =
          rawDuckUnderTrackId !== undefined && rawDuckUnderTrackId.trim() !== ''
            ? rawDuckUnderTrackId.trim()
            : undefined;
        log.action('run → host music download', { tool: call.name });
        return await options.hostAddMusic(
          ctx.project,
          {
            remoteId,
            ...(atSeconds === undefined ? {} : { atSeconds }),
            ...(duckUnderTrackId === undefined ? {} : { duckUnderTrackId }),
          },
          signal,
        );
      }
      // Stock sourcing is host-only for the same reasons as music. Missing the
      // override is a real unavailability, not a reason to invent a result.
      if (call.name === 'search_stock') {
        if (!options.hostStockSearch) {
          return {
            status: 'failed',
            summary: desktopOnlyCapability(
              'Stock search',
              'build the edit from the footage the project already holds (list_assets shows ' +
                'it), and tell the editor that searching for stock needs the desktop app.',
            ),
          };
        }
        const query = typeof call.arguments?.query === 'string' ? call.arguments.query : '';
        const kind = call.arguments?.kind === 'photo' ? 'photo' : 'video';
        const limit = typeof call.arguments?.limit === 'number' ? call.arguments.limit : undefined;
        const rawOrientation = call.arguments?.orientation;
        // An explicit choice is honoured: reframing a landscape plate into a vertical cut
        // is a real technique and the model may mean it. What changes is the DEFAULT —
        // absent, it now follows the project's own shape instead of the provider's.
        const orientation =
          rawOrientation === 'landscape' ||
          rawOrientation === 'portrait' ||
          rawOrientation === 'square'
            ? rawOrientation
            : projectOrientation(ctx.project);
        log.action('run → host stock search', { tool: call.name, kind });
        return await options.hostStockSearch(
          {
            query,
            kind,
            ...(limit === undefined ? {} : { limit }),
            ...(orientation === undefined ? {} : { orientation }),
          },
          signal,
        );
      }
      if (call.name === 'add_stock') {
        if (!options.hostAddStock) {
          return {
            status: 'failed',
            summary: desktopOnlyCapability(
              'Adding stock media',
              'place footage the project already holds with add_clip (list_assets shows it), ' +
                'and tell the editor that downloading stock needs the desktop app.',
            ),
          };
        }
        const remoteId =
          typeof call.arguments?.remoteId === 'string' ? call.arguments.remoteId : '';
        const kind = call.arguments?.kind === 'photo' ? 'photo' : 'video';
        const rawAtSeconds =
          typeof call.arguments?.atSeconds === 'number' ? call.arguments.atSeconds : undefined;
        // A negative start is out of contract; the builder clamps to 0 anyway, so
        // clamp here rather than failing a download over it.
        const atSeconds = rawAtSeconds === undefined ? undefined : Math.max(0, rawAtSeconds);
        log.action('run → host stock download', { tool: call.name, kind });
        return await options.hostAddStock(
          ctx.project,
          { remoteId, kind, ...(atSeconds === undefined ? {} : { atSeconds }) },
          signal,
        );
      }
      if (call.name === 'measure_color') {
        const clipId = typeof call.arguments.clipId === 'string' ? call.arguments.clipId : '';
        const target = ctx.project.timeline.tracks
          .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
          .find(({ clip }) => clip.id === clipId);
        if (!target || target.track.type === 'audio' || target.track.type === 'caption') {
          return {
            status: 'failed',
            // The wrong-clip-id answer this codebase already gives everywhere else: say
            // which ids ARE valid rather than only that this one is not (commit 629b822).
            summary:
              `Cannot measure color: clip "${clipId}" is not on the timeline, or it is on an ` +
              'audio or caption track and has no picture to measure. Call get_clips to see ' +
              'the clips on the video tracks and their ids, then measure one of those.',
          };
        }
      }
      // Forward the host-held embedding keys (the same ones index_media uses) to the
      // visual query routes; without them a TwelveLabs-indexed project answers from the
      // empty local sqlite-vec store. planSidecarCall only reads twelveLabsKey/nvidiaKeys.
      const plan = planSidecarCall(call, ctx, options.visualIndexCredentials?.());
      if (plan === null) {
        log.warn('run → no sidecar route for tool', { tool: call.name });
        return {
          status: 'failed',
          // A verdict about this surface, not an event on it: `planSidecarCall` is a pure
          // function of the tool name, so a second call gets the same answer. Declared so
          // the orchestrator's proven-refusal guard can enforce the "do not call it
          // again" the sentence already asks for — run `137d8fd0` ignored it four times.
          refusalCause: 'surface_unavailable',
          // "use the Export dialog" is an instruction for someone with a mouse — the same
          // dead end as run `369e8c82`'s "Place it from the bin". The caller needs to know
          // that no retry helps and what to do with the rest of the run instead.
          summary: RENDER_ACTIONS.has(call.name)
            ? `"${call.name}" cannot be run from here — the editor renders and exports ` +
              'through its own Export dialog. Do not call it again: finish the edit, then ' +
              'tell the editor it is ready to export.'
            : `"${call.name}" has no implementation on this surface, so nothing here can ` +
              'run it. Do not call it again in this run: do what you can with the other ' +
              'tools, and tell the editor which step you had to skip.',
        };
      }
      log.action('run → dispatching sidecar call', { tool: call.name, route: plan.route });
      // Chain the run's Stop signal with a hard timeout: whichever fires first
      // aborts the HTTP call. (Manual chaining — AbortSignal.any is not yet
      // available on every supported runtime.)
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // postAnalysis settles every path to an outcome (it never throws), so the
      // cleanup below always runs — no try/finally needed.
      const outcome = await postAnalysis({
        fetchFn,
        url: `${options.baseUrl}${plan.route}`,
        baseUrl: options.baseUrl,
        call,
        body: plan.body,
        interpret: plan.interpret,
        requestSignal: controller.signal,
        runSignal: signal,
        timeoutMs,
      });
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      log.action('run ← sidecar call settled', {
        tool: call.name,
        status: outcome.status,
        summary: outcome.summary,
      });
      return outcome;
    },
  };
  // Every path above — the sidecar routes, the host overrides, the index job — goes
  // through the budget, because every one of them can be the call that runs a bin's worth
  // of media through the machine.
  return {
    run: (call, ctx, signal) => chargeAnalysisBudget(dispatch, call, ctx, signal, now),
  };
}

/**
 * Hard ceiling on an engine error we are willing to repeat. Nothing an error body can say
 * is worth more than this, and everything past it has historically been payload echo.
 */
const MAX_ENGINE_ERROR_CHARS = 400;

/** One FastAPI/pydantic validation error, minus the `input` field (see below). */
function validationErrorLine(entry: unknown): string {
  /* v8 ignore next -- pydantic emits objects; the `?? {}` is for a null slot we never see. */
  const e = (entry ?? {}) as { loc?: unknown; msg?: unknown };
  const where = Array.isArray(e.loc) ? e.loc.filter((p) => p !== 'body').join('.') : '';
  const message = typeof e.msg === 'string' ? e.msg : 'invalid';
  return where ? `${where}: ${message}` : message;
}

/**
 * Read the human sentence out of an engine error body, bounded.
 *
 * Two shapes matter. The engine's own reasons are `{"detail": "<sentence>"}` — passing the
 * raw body through put a wall of JSON where one plain sentence belonged. Worse, a request
 * that fails FastAPI's own validation returns `{"detail": [{loc, msg, input}]}` where
 * **`input` is the entire rejected request body** — for an analysis call that is the inlined
 * project document, every asset's waveform `peaks` included. That echo was landing in the
 * model's context, the evidence store and the tool card: kilobytes of numbers describing a
 * mistake that fits in eight words. We keep `loc` + `msg` and drop `input` entirely.
 *
 * Anything else is returned verbatim (never swallowed), and every path is truncated — an
 * error is a signal to act on, not a payload.
 */
export function engineErrorDetail(body: string): string {
  return trimEngineError(readEngineErrorDetail(body));
}

function readEngineErrorDetail(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON (an HTML error page, a proxy's text) — report it as it came.
    return body;
  }
  const detail = (parsed as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail.length > 0) return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    return detail.map(validationErrorLine).join('; ');
  }
  return body;
}

function trimEngineError(text: string): string {
  return text.length <= MAX_ENGINE_ERROR_CHARS
    ? text
    : `${text.slice(0, MAX_ENGINE_ERROR_CHARS)}… (truncated)`;
}

/**
 * Node error codes that mean "the request never reached the engine": the socket was
 * refused, the name did not resolve, the peer hung up, or undici gave up on the
 * connection. `TypeError: fetch failed` is the message undici puts on ALL of them, and
 * the real code hides one level down in `error.cause`.
 */
const TRANSPORT_ERROR_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'] as const;

/** The one-line, engine-free sentence the EDITOR sees on the tool card. */
const ENGINE_UNREACHABLE_SUMMARY =
  "The media engine is not responding — check that FramePilot's engine is running";

/** The `code` off an error's `cause`, when there is one (undici nests the real cause). */
function transportErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * Turn a transport-level failure into an instruction the MODEL can act on.
 *
 * In the captured run 35 tool failures reached the model as `"<tool>" failed: fetch
 * failed` — undici's message for a refused socket, with the cause one level down and the
 * base URL nowhere. The model cannot tell that from a bad argument, so it retried the
 * identical call and burned turns on an engine that was not running. The sentence below
 * says three things the raw message does not: WHERE we tried to reach, that the arguments
 * are not the problem, and what a valid next action is.
 *
 * Deliberately NOT a deterministic failure (see `conductor.ts#mergeFailureKeys`): a dead
 * socket is transient by nature, and banking it as a permanent refusal would keep the tool
 * blocked for the rest of the run after the engine came back.
 *
 * @param toolName - The failing tool, quoted into the sentence.
 * @param error - The rejection from `fetch`.
 * @param baseUrl - The engine origin the call was aimed at.
 * @returns The model-facing sentence, or `undefined` when this is not a transport failure.
 */
export function describeTransportFailure(
  toolName: string,
  error: unknown,
  baseUrl: string,
): string | undefined {
  const code = transportErrorCode(error);
  const message = error instanceof Error ? error.message : '';
  const isTransport =
    (code !== undefined &&
      (TRANSPORT_ERROR_CODES.some((known) => known === code) || code.startsWith('UND_ERR_'))) ||
    message.includes('fetch failed');
  if (!isTransport) return undefined;
  return (
    `"${toolName}" could not reach the media engine at ${baseUrl} (${code ?? 'connection failed'}). ` +
    'This is not about your arguments: retry this call once; if it fails again, continue ' +
    'without this analysis and tell the editor the media engine is not responding.'
  );
}

/** POST one analysis request and settle EVERY path (2xx/4xx/abort/timeout/network) to an outcome. */
async function postAnalysis(args: {
  fetchFn: typeof fetch;
  url: string;
  /** The engine origin, named in a transport failure so the model can see WHERE we tried. */
  baseUrl: string;
  call: ToolCall;
  body: Record<string, unknown>;
  /** Settle a 2xx payload to an outcome (legacy pass-through vs. unified unwrap). */
  interpret: (data: unknown) => HostToolOutcome;
  requestSignal: AbortSignal;
  runSignal: AbortSignal | undefined;
  timeoutMs: number;
}): Promise<HostToolOutcome> {
  const { call } = args;
  try {
    const response = await args.fetchFn(args.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args.body),
      signal: args.requestSignal,
    });
    if (!response.ok) {
      const detail = engineErrorDetail(await response.text());
      return {
        status: 'failed',
        summary: `Analysis failed (${response.status}): ${detail.slice(0, 200)}`,
        data: detail,
      };
    }
    return args.interpret(await response.json());
  } catch (error) {
    // The user's Stop is a cancellation; a timeout or network failure is a
    // real failure with the cause surfaced.
    if (args.runSignal?.aborted) {
      return { status: 'cancelled', summary: `Stopped "${call.name}" — run cancelled` };
    }
    if (args.requestSignal.aborted) {
      return {
        status: 'failed',
        summary: `"${call.name}" timed out after ${Math.round(args.timeoutMs / 1000)}s`,
      };
    }
    // A dead socket gets the card's plain sentence and the model's instruction — the
    // card is what the editor reads, `data` is what the model reads (see the
    // `emit.toolResult` comment in orchestrator.ts: card gets the summary, popup +
    // model get `data`).
    const transport = describeTransportFailure(call.name, error, args.baseUrl);
    if (transport !== undefined) {
      return { status: 'failed', summary: ENGINE_UNREACHABLE_SUMMARY, data: transport };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'failed', summary: `"${call.name}" failed: ${reason}`, data: reason };
  }
}
