/**
 * Automatic media-understanding runtime.
 *
 * This module is deliberately model-invisible. Callers ask for semantic evidence;
 * the runtime checks coverage, prepares unchanged media at most once, and then
 * executes the semantic query. There is no user-facing or model-facing "index"
 * operation in this contract.
 */
import type {
  VisualIndexClient,
  VisualIndexLoopResult,
  VisualStatusResponse,
} from './visual-index-client.js';
import { runVisualIndexLoop } from './visual-index-client.js';
import type { MediaProbe, TimestampAnswer, VisualEvidence } from './media-evidence.js';

export type UnderstandingBackend = 'local' | 'twelvelabs' | 'builtin';
export type CacheDecision = 'hit' | 'miss' | 'joined' | 'refresh';

export type UnderstandingUnavailableReason =
  | 'unconfigured'
  | 'offline'
  | 'not_indexed'
  | 'indexing'
  | 'invalid_api_key'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'timeout'
  | 'cancelled'
  | 'provider_unavailable'
  | 'source_missing'
  | 'unknown';

export interface UnderstandingEvent {
  readonly type: 'coverage' | 'cache' | 'provider' | 'progress' | 'ready' | 'unavailable';
  readonly backend: UnderstandingBackend;
  readonly cache?: CacheDecision;
  readonly costRelevant?: boolean;
  readonly message: string;
  readonly progress?: number;
  readonly reason?: UnderstandingUnavailableReason;
}

export interface EnsureMediaUnderstandingInput {
  readonly client: VisualIndexClient;
  readonly projectId: string;
  readonly project?: Record<string, unknown>;
  readonly assetIds?: readonly string[];
  /** TwelveLabs wins when configured. It never silently falls through to another hosted backend. */
  readonly twelveLabsKey?: string;
  /** Existing built-in visual backend, used only when TwelveLabs is not selected. */
  readonly nvidiaKeys?: string;
  readonly signal?: AbortSignal;
  readonly refresh?: boolean;
  readonly onEvent?: (event: UnderstandingEvent) => void;
}

export interface UnderstandingReady {
  readonly status: 'ready';
  readonly backend: Exclude<UnderstandingBackend, 'local'>;
  readonly cache: CacheDecision;
  readonly coverage?: VisualStatusResponse;
  readonly indexing?: VisualIndexLoopResult;
}

export interface UnderstandingUnavailable {
  readonly status: 'unavailable';
  readonly backend: Exclude<UnderstandingBackend, 'local'>;
  readonly reason: UnderstandingUnavailableReason;
  readonly message: string;
  readonly coverage?: VisualStatusResponse;
}

export type EnsureMediaUnderstandingResult = UnderstandingReady | UnderstandingUnavailable;

const preparationFlights = new Map<string, Promise<EnsureMediaUnderstandingResult>>();

const emit = (input: EnsureMediaUnderstandingInput, event: UnderstandingEvent): void =>
  input.onEvent?.(event);

function normalizeReason(value: string | null | undefined): UnderstandingUnavailableReason {
  // The only caller falls back to `indexing.status`, a non-empty string, so `value` is
  // never null and never '' — the coalesce and the `unknown` arm below are defensive.
  /* v8 ignore next */
  const reason = (value ?? '').toLowerCase();
  if (reason.includes('cancel')) return 'cancelled';
  if (reason.includes('rate') || reason.includes('429')) return 'rate_limited';
  if (reason.includes('quota') || reason.includes('credit')) return 'quota_exceeded';
  if (reason.includes('auth') || reason.includes('api_key') || reason.includes('401')) {
    return 'invalid_api_key';
  }
  if (reason.includes('timeout')) return 'timeout';
  if (reason.includes('offline') || reason.includes('network') || reason.includes('unreachable')) {
    return 'offline';
  }
  if (reason.includes('not_indexed')) return 'not_indexed';
  if (reason.includes('index')) return 'indexing';
  if (reason.includes('source') || reason.includes('file')) return 'source_missing';
  if (reason.includes('config') || reason.includes('key') || reason.includes('no-key')) {
    return 'unconfigured';
  }
  /* v8 ignore next -- unreachable for the same reason: `reason` is never empty here */
  return reason ? 'provider_unavailable' : 'unknown';
}

function flightKey(input: EnsureMediaUnderstandingInput): string {
  const backend = input.twelveLabsKey ? 'twelvelabs' : 'builtin';
  const assets = [...(input.assetIds ?? [])].sort().join(',');
  return `${input.projectId}|${backend}|${assets}|${input.refresh === true ? 'refresh' : 'normal'}`;
}

function coverageReady(status: VisualStatusResponse | undefined): boolean {
  if (!status?.available) return false;
  return status.totalAssets > 0 && status.indexedAssets >= status.totalAssets;
}

async function prepare(
  input: EnsureMediaUnderstandingInput,
): Promise<EnsureMediaUnderstandingResult> {
  const backend: 'twelvelabs' | 'builtin' = input.twelveLabsKey ? 'twelvelabs' : 'builtin';
  if (!input.twelveLabsKey && !input.nvidiaKeys) {
    const result: UnderstandingUnavailable = {
      status: 'unavailable',
      backend,
      reason: 'unconfigured',
      message:
        'Media understanding is not configured. Local deterministic inspection remains available.',
    };
    emit(input, { type: 'unavailable', backend, reason: result.reason, message: result.message });
    return result;
  }
  if (input.signal?.aborted) {
    return {
      status: 'unavailable',
      backend,
      reason: 'cancelled',
      message: 'Media understanding was cancelled before preparation started.',
    };
  }

  const coverage = await input.client.status(input.projectId, input.signal);
  emit(input, {
    type: 'coverage',
    backend,
    message: coverage
      ? `${coverage.indexedAssets}/${coverage.totalAssets} media assets prepared.`
      : 'Media-understanding coverage could not be read.',
  });

  if (!input.refresh && coverageReady(coverage)) {
    emit(input, {
      type: 'cache',
      backend,
      cache: 'hit',
      message: 'Reusing prepared media understanding.',
    });
    // A hit requires `coverageReady(coverage)`, which is false for undefined, so
    // `coverage` is always present here; the conditional spread is defensive.
    /* v8 ignore next */
    return { status: 'ready', backend, cache: 'hit', ...(coverage ? { coverage } : {}) };
  }

  const cache: CacheDecision = input.refresh ? 'refresh' : 'miss';
  emit(input, {
    type: 'cache',
    backend,
    cache,
    costRelevant: backend === 'twelvelabs',
    message:
      backend === 'twelvelabs'
        ? 'Preparing media with TwelveLabs. This may use provider credits; completed results are reused.'
        : 'Preparing media with the built-in visual index.',
  });

  const indexing = await runVisualIndexLoop({
    client: input.client,
    request: {
      projectId: input.projectId,
      ...(input.project ? { project: input.project } : {}),
      ...(input.assetIds ? { assetIds: input.assetIds } : {}),
      ...(input.twelveLabsKey ? { twelveLabsKey: input.twelveLabsKey } : {}),
      ...(!input.twelveLabsKey && input.nvidiaKeys ? { nvidiaKeys: input.nvidiaKeys } : {}),
    },
    ...(input.signal ? { signal: input.signal } : {}),
    onSlice: (slice) => {
      const progress = slice.total > 0 ? Math.min(1, slice.cursor / slice.total) : 0;
      emit(input, {
        type: 'progress',
        backend,
        progress,
        costRelevant: backend === 'twelvelabs',
        message: slice.done
          ? 'Media understanding is ready.'
          : `Preparing media understanding (${slice.cursor}/${slice.total}).`,
      });
    },
  });

  if (indexing.status === 'done') {
    emit(input, { type: 'ready', backend, cache, message: 'Media understanding is ready.' });
    return {
      status: 'ready',
      backend,
      cache,
      ...(coverage ? { coverage } : {}),
      indexing,
    };
  }

  const rawReason = indexing.last?.reason ?? indexing.status;
  const reason = normalizeReason(rawReason);
  const message = `Media understanding is unavailable: ${rawReason}.`;
  emit(input, { type: 'unavailable', backend, reason, message });
  return { status: 'unavailable', backend, reason, message, ...(coverage ? { coverage } : {}) };
}

/**
 * Ensure semantic media evidence is available. Simultaneous identical requests
 * join one preparation flight, preventing duplicate upload/index calls.
 */
export async function ensureMediaUnderstanding(
  input: EnsureMediaUnderstandingInput,
): Promise<EnsureMediaUnderstandingResult> {
  const key = flightKey(input);
  const existing = preparationFlights.get(key);
  if (existing) {
    emit(input, {
      type: 'cache',
      backend: input.twelveLabsKey ? 'twelvelabs' : 'builtin',
      cache: 'joined',
      message: 'Joined an identical media-understanding request already in progress.',
    });
    return existing;
  }
  const flight = prepare(input).finally(() => preparationFlights.delete(key));
  preparationFlights.set(key, flight);
  return flight;
}

export interface TimestampQueryRuntimeInput {
  readonly question: string;
  /** Local deterministic probe. This is always attempted before semantic work. */
  readonly probe: () => Promise<MediaProbe>;
  /** Semantic provider query, called only after automatic preparation succeeds. */
  readonly search: () => Promise<readonly VisualEvidence[]>;
  readonly ensure?: EnsureMediaUnderstandingInput;
}

function deterministicProbeAnswer(question: string, probe: MediaProbe): string | undefined {
  const normalized = question.trim().toLowerCase();
  const deterministic =
    normalized.includes('resolution') ||
    normalized.includes('fps') ||
    normalized.includes('frame rate') ||
    normalized.includes('codec') ||
    normalized.includes('duration') ||
    normalized.includes('audio stream') ||
    normalized.includes('video stream') ||
    normalized.includes('frame count');
  if (!deterministic) return undefined;

  const resolution =
    probe.width !== undefined && probe.height !== undefined
      ? `${probe.width}×${probe.height}`
      : undefined;
  return [
    resolution,
    probe.fps !== undefined ? `${probe.fps} fps` : undefined,
    probe.videoCodec,
    probe.frameCount !== undefined ? `${probe.frameCount} frames` : undefined,
    `${probe.durationSeconds.toFixed(3)} seconds`,
    probe.hasAudio ? 'audio present' : 'no audio',
    probe.hasVideo ? 'video present' : 'no video',
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(', ');
}

/**
 * Query a timestamp with local-first evidence. Deterministic media facts never
 * trigger a hosted model; semantic questions prepare media implicitly and return
 * exact evidence or an explicit no-answer.
 */
export async function queryTimestamp(input: TimestampQueryRuntimeInput): Promise<TimestampAnswer> {
  const probe = await input.probe();
  const deterministic = deterministicProbeAnswer(input.question, probe);
  if (deterministic !== undefined) {
    return { available: true, answer: deterministic, evidence: [] };
  }
  if (!probe.hasVideo) {
    return {
      available: false,
      reason: 'no_video',
      recovery: 'Choose an asset with a video stream.',
      evidence: [],
    };
  }

  if (!input.ensure) {
    return {
      available: false,
      reason: 'provider_unconfigured',
      recovery: 'Configure TwelveLabs or use a deterministic media question.',
      evidence: [],
    };
  }
  const ready = await ensureMediaUnderstanding(input.ensure);
  if (ready.status !== 'ready') {
    return {
      available: false,
      reason:
        ready.reason === 'offline'
          ? 'offline_uncached'
          : ready.reason === 'unconfigured'
            ? 'provider_unconfigured'
            : 'provider_unavailable',
      recovery:
        ready.reason === 'offline'
          ? 'Reconnect once so this unchanged media can be prepared and cached.'
          : ready.message,
      evidence: [],
    };
  }

  const evidence = await input.search();
  if (evidence.length === 0) {
    return {
      available: false,
      reason: 'no_answer',
      recovery: 'Try a narrower visual question or inspect a nearby frame.',
      evidence: [],
    };
  }
  const answer = evidence
    .map((item) => item.description)
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join(' ');
  return {
    available: true,
    answer: answer || 'Grounded visual evidence is attached.',
    evidence,
  };
}
