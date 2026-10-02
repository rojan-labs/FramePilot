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
  /**
   * The provider refused the FILE itself (too large, too long, an unsupported format…).
   * Permanent for these bytes: the engine remembers it and never re-uploads, so the next
   * step is a different copy of the clip, not a retry.
   */
  | 'media_rejected'
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
  /**
   * Built-in on-device visual backend. Sent whether or not TwelveLabs is
   * selected: TwelveLabs owns video and audio understanding when configured, but
   * its index cannot take a still photo, so the engine routes stills here.
   */
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

/** A raw engine or loop reason, classified, with the one sentence a person reads for it. */
export interface ClassifiedUnderstandingReason {
  readonly reason: UnderstandingUnavailableReason;
  /** One complete sentence: the engine's own words, or plain words for a bare token. */
  readonly message: string;
}

/**
 * The engine's exact typed reason tokens (`service.py`, `brain/twelvelabs*.py`,
 * `brain/keyring.py`), plus the index loop's own terminal statuses, which stand in for
 * the reason when a slice carried none. A token is not a sentence, so each has plain words.
 */
const TOKEN_REASONS: ReadonlyMap<string, ClassifiedUnderstandingReason> = new Map([
  ['cancelled', { reason: 'cancelled', message: 'Reading the footage was cancelled.' }],
  ['indexing', { reason: 'indexing', message: 'The footage is still being read.' }],
  ['not_indexed', { reason: 'not_indexed', message: 'This footage has not been read yet.' }],
  [
    'invalid_api_key',
    { reason: 'invalid_api_key', message: 'The footage-understanding key was rejected.' },
  ],
  ['no_api_key', { reason: 'unconfigured', message: 'No footage-understanding key is set up.' }],
  [
    'all_keys_failing',
    {
      reason: 'provider_unavailable',
      message:
        'Every footage-understanding key is failing right now: rejected or rate-limited. Check the keys in Settings, or wait and try again.',
    },
  ],
  [
    'unreachable',
    { reason: 'provider_unavailable', message: 'The FramePilot engine could not be reached.' },
  ],
  [
    'unavailable',
    {
      reason: 'provider_unavailable',
      message: 'The FramePilot engine cannot read footage right now.',
    },
  ],
  [
    'nothing-to-index',
    { reason: 'provider_unavailable', message: 'There was no footage in this project to read.' },
  ],
  [
    'keys-failing',
    {
      reason: 'provider_unavailable',
      message: 'The footage-understanding keys stopped working partway through.',
    },
  ],
  [
    'exhausted-slices',
    {
      reason: 'timeout',
      message: 'Reading the footage took too long and stopped before it finished.',
    },
  ],
]);

/**
 * `(HTTP 429)`, optionally followed by the provider's machine code: `(HTTP 400)
 * (video_filesize_too_large)`. This is the shape of every TwelveLabs API error sentence.
 */
const HTTP_MARKER = /\(HTTP (\d{3})\)(?: \(([a-z0-9_]+)\))?/;

/**
 * Mirrors the engine's `_is_media_rejection`: 413/415 refuse the file whatever the code,
 * and a 400/422 whose code is about the media (`video_*`, `audio_*`, `file_*`) refuses
 * these bytes for good. Only a code naming a missing RESOURCE (`*_not_found`) is not one.
 */
const MEDIA_REJECTION_STATUSES = new Set([413, 415]);
const MEDIA_CODE_STATUSES = new Set([400, 422]);
const MEDIA_CODE_PREFIXES = ['video_', 'audio_', 'file_'] as const;
const NOT_MEDIA_CODE_SUFFIX = '_not_found';

const HTTP_STATUS_REASONS: ReadonlyMap<number, UnderstandingUnavailableReason> = new Map([
  [401, 'invalid_api_key'],
  [403, 'invalid_api_key'],
  [402, 'quota_exceeded'],
  [408, 'timeout'],
  [429, 'rate_limited'],
]);

/** The engine's sentence for a refused file: `TwelveLabs can't index ro.mp4: …`. */
const MEDIA_REJECTED_PREFIX = "TwelveLabs can't index ";
/** The engine's pre-flight sentence: `ro.mp4 is 1.2 GB; TwelveLabs accepts files up to …`. */
const MEDIA_PREFLIGHT_MARKER = /; TwelveLabs accepts (?:audio )?files up to /;
/** The engine's sentence for a transport failure (DNS, connect, network timeout). */
const TRANSPORT_FAILURE_PREFIX = 'TwelveLabs request failed:';
/** Python's OSError text for a file that is not on disk. */
const FILE_NOT_FOUND_MARKER = /\[Errno 2\]|No such file or directory/;

const NO_REASON_MESSAGE = 'Reading the footage stopped without saying why.';

/** End a sentence exactly once, so a caller can quote it without adding a full stop. */
function asSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function httpReason(status: number, code: string | undefined): UnderstandingUnavailableReason {
  if (MEDIA_REJECTION_STATUSES.has(status)) return 'media_rejected';
  if (
    MEDIA_CODE_STATUSES.has(status) &&
    code !== undefined &&
    MEDIA_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)) &&
    !code.endsWith(NOT_MEDIA_CODE_SUFFIX)
  ) {
    return 'media_rejected';
  }
  return HTTP_STATUS_REASONS.get(status) ?? 'provider_unavailable';
}

/**
 * The generic API-error sentence an engine from before media rejections had words wrote
 * (`TwelveLabs API error (HTTP 400) (video_filesize_too_large).`). It is still journaled
 * as an asset's last failure until that asset is read again.
 */
const LEGACY_API_ERROR_PREFIX = 'TwelveLabs API error (HTTP ';

function classifyProse(text: string): ClassifiedUnderstandingReason {
  const verbatim = asSentence(text);
  if (text.startsWith(MEDIA_REJECTED_PREFIX) || MEDIA_PREFLIGHT_MARKER.test(text)) {
    return { reason: 'media_rejected', message: verbatim };
  }
  if (text.startsWith(TRANSPORT_FAILURE_PREFIX)) return { reason: 'offline', message: verbatim };
  if (FILE_NOT_FOUND_MARKER.test(text)) return { reason: 'source_missing', message: verbatim };
  const http = HTTP_MARKER.exec(text);
  if (!http) return { reason: 'provider_unavailable', message: verbatim };
  const status = Number(http[1]);
  const code = http[2];
  const reason = httpReason(status, code);
  // An old refusal reads as an API error. Say it the way the engine says it now, so the
  // editor reads it as a problem with the FILE rather than with the service.
  if (reason === 'media_rejected' && text.startsWith(LEGACY_API_ERROR_PREFIX)) {
    return { reason, message: `TwelveLabs can't index this file (${code ?? `HTTP ${status}`}).` };
  }
  return { reason, message: verbatim };
}

/**
 * Classify a reason the engine (or the index loop) reported, on precise signals only:
 * the engine's exact typed tokens, the loop's statuses, its `(HTTP nnn) (code)` marker,
 * and the fixed openings of its own sentences. Free text is never searched for words —
 * that read "TwelveLabs can't index ro.mp4" as still-indexing and a file-size refusal
 * as a missing file. Anything unrecognised keeps the engine's sentence verbatim; only a
 * refusal in the old engine's API-error wording is restated in its current wording.
 *
 * @param raw - The engine's `reason`, or the loop status when the engine gave none.
 * @returns The typed reason and the sentence to show for it.
 */
export function classifyUnderstandingReason(
  raw: string | null | undefined,
): ClassifiedUnderstandingReason {
  const text = (raw ?? '').trim();
  if (text === '') return { reason: 'unknown', message: NO_REASON_MESSAGE };
  return TOKEN_REASONS.get(text) ?? classifyProse(text);
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
  // No key check. Tier 0 of the shot ledger — scene cuts, exposure, warmth, motion,
  // sharpness — is one local ffmpeg pass (ADR 0175), so preparation is worth attempting
  // on a clean install with nothing configured. The tiers a key would unlock report
  // themselves as absent coverage; they are not a gate on the job. This early return was
  // half the reason the agent never called a footage surface in ten recorded runs.
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
        : 'Preparing media on this device. Measurement runs with no key; described and labelled footage needs one.',
  });

  const indexing = await runVisualIndexLoop({
    client: input.client,
    request: {
      projectId: input.projectId,
      ...(input.project ? { project: input.project } : {}),
      ...(input.assetIds ? { assetIds: input.assetIds } : {}),
      ...(input.twelveLabsKey ? { twelveLabsKey: input.twelveLabsKey } : {}),
      // BOTH keys ride along. TwelveLabs still owns footage understanding when it
      // is configured, but its index cannot take a still photo, so the engine
      // routes stills to the on-device embedder — and can only do that if the key
      // reached it. Withholding it made a photo project unpreparable by design.
      ...(input.nvidiaKeys ? { nvidiaKeys: input.nvidiaKeys } : {}),
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

  // `||`, not `??`: an empty reason says nothing, so the loop status speaks instead.
  const { reason, message } = classifyUnderstandingReason(indexing.last?.reason || indexing.status);
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
