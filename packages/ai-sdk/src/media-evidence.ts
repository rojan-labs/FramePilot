/**
 * Deterministic media facts and visual evidence contracts.
 *
 * These shapes sit above existing engine responses. They do not add an IPC route
 * or change the project schema. Their job is to normalize time domain, frame
 * identity, provenance, cache state, and honest no-answer behavior before an
 * orchestrator or sidebar consumes a media result.
 */
import { frameToSeconds, secondsToFrame } from './frame-time.js';

export type MediaTimeDomain = 'source' | 'sequence';
export type EvidenceBackend = 'local' | 'twelvelabs';
export type EvidenceCacheState = 'fresh' | 'memory-hit' | 'persistent-hit' | 'joined';

export interface MediaProbe {
  readonly assetId: string;
  readonly durationSeconds: number;
  readonly fps?: number;
  readonly frameCount?: number;
  readonly width?: number;
  readonly height?: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly container?: string;
}

export interface TimePoint {
  readonly domain: MediaTimeDomain;
  readonly seconds: number;
  readonly frame?: number;
}

export interface VisualEvidence {
  readonly evidenceId: string;
  readonly assetId: string;
  readonly clipId?: string;
  readonly source: TimePoint;
  readonly sequence?: TimePoint;
  readonly backend: EvidenceBackend;
  readonly cacheState: EvidenceCacheState;
  readonly thumbnailUrl?: string;
  readonly description?: string;
  readonly confidence?: number;
}

export type TimestampAnswer =
  | {
      readonly available: true;
      readonly answer: string;
      readonly evidence: readonly VisualEvidence[];
    }
  | {
      readonly available: false;
      readonly reason:
        | 'no_video'
        | 'outside_asset'
        | 'outside_clip'
        | 'offline_uncached'
        | 'provider_unconfigured'
        | 'provider_unavailable'
        | 'no_answer';
      readonly recovery?: string;
      readonly evidence: readonly VisualEvidence[];
    };

export interface ClipTimeMapping {
  readonly clipId: string;
  readonly assetId: string;
  readonly sequenceStart: number;
  readonly sequenceEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  /** Constant speed only. A speed ramp must use the editor-core curve mapper. */
  readonly speed?: number;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number.`);
  }
}

/** Fill deterministic probe fields without inventing unavailable stream data. */
export function normalizeMediaProbe(probe: MediaProbe): MediaProbe {
  assertFiniteNonNegative(probe.durationSeconds, 'durationSeconds');
  if (probe.fps !== undefined && (!Number.isFinite(probe.fps) || probe.fps <= 0)) {
    throw new RangeError('fps must be a positive finite number when present.');
  }
  if (probe.width !== undefined && (!Number.isInteger(probe.width) || probe.width <= 0)) {
    throw new RangeError('width must be a positive integer when present.');
  }
  if (probe.height !== undefined && (!Number.isInteger(probe.height) || probe.height <= 0)) {
    throw new RangeError('height must be a positive integer when present.');
  }

  const frameCount =
    probe.hasVideo && probe.fps !== undefined
      ? (probe.frameCount ?? secondsToFrame(probe.durationSeconds, probe.fps, 'nearest'))
      : undefined;
  return {
    ...probe,
    ...(frameCount === undefined ? {} : { frameCount }),
  };
}

/** Convert one source point into sequence time for a constant-speed clip. */
export function sourceToSequenceTime(
  mapping: ClipTimeMapping,
  sourceSeconds: number,
  sequenceFps: number,
): TimePoint | undefined {
  assertFiniteNonNegative(sourceSeconds, 'sourceSeconds');
  if (sourceSeconds < mapping.sourceStart || sourceSeconds >= mapping.sourceEnd) return undefined;
  const speed = mapping.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new RangeError('clip speed must be a positive finite number.');
  }
  const raw = mapping.sequenceStart + (sourceSeconds - mapping.sourceStart) / speed;
  if (raw < mapping.sequenceStart || raw >= mapping.sequenceEnd) return undefined;
  const frame = secondsToFrame(raw, sequenceFps, 'nearest');
  return { domain: 'sequence', frame, seconds: frameToSeconds(frame, sequenceFps) };
}

/** Convert one sequence point into source time for a constant-speed clip. */
export function sequenceToSourceTime(
  mapping: ClipTimeMapping,
  sequenceSeconds: number,
): TimePoint | undefined {
  assertFiniteNonNegative(sequenceSeconds, 'sequenceSeconds');
  if (sequenceSeconds < mapping.sequenceStart || sequenceSeconds >= mapping.sequenceEnd) {
    return undefined;
  }
  const speed = mapping.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new RangeError('clip speed must be a positive finite number.');
  }
  const seconds = mapping.sourceStart + (sequenceSeconds - mapping.sequenceStart) * speed;
  if (seconds < mapping.sourceStart || seconds >= mapping.sourceEnd) return undefined;
  return { domain: 'source', seconds };
}

/** Stable evidence id from immutable provenance fields, without media bytes or secrets. */
export function evidenceIdFor(input: {
  readonly assetId: string;
  readonly sourceSeconds: number;
  readonly backend: EvidenceBackend;
  readonly query?: string;
}): string {
  const text = JSON.stringify({
    assetId: input.assetId,
    backend: input.backend,
    query: input.query?.trim().toLowerCase() ?? '',
    sourceMilliseconds: Math.round(input.sourceSeconds * 1000),
  });
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `evidence_${(hash >>> 0).toString(16)}`;
}

/** Build a first-class visual evidence attachment from one sampled source point. */
export function visualEvidence(input: {
  readonly assetId: string;
  readonly sourceSeconds: number;
  readonly backend: EvidenceBackend;
  readonly cacheState: EvidenceCacheState;
  readonly sequenceFps?: number;
  readonly mapping?: ClipTimeMapping;
  readonly query?: string;
  readonly thumbnailUrl?: string;
  readonly description?: string;
  readonly confidence?: number;
}): VisualEvidence {
  assertFiniteNonNegative(input.sourceSeconds, 'sourceSeconds');
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
  ) {
    throw new RangeError('confidence must be within [0, 1] when present.');
  }
  const sequence =
    input.mapping && input.sequenceFps
      ? sourceToSequenceTime(input.mapping, input.sourceSeconds, input.sequenceFps)
      : undefined;
  return {
    evidenceId: evidenceIdFor(input),
    assetId: input.assetId,
    ...(input.mapping ? { clipId: input.mapping.clipId } : {}),
    source: { domain: 'source', seconds: input.sourceSeconds },
    ...(sequence ? { sequence } : {}),
    backend: input.backend,
    cacheState: input.cacheState,
    ...(input.thumbnailUrl ? { thumbnailUrl: input.thumbnailUrl } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
  };
}

/** Honest no-answer shape shared by deterministic and semantic timestamp queries. */
export function unavailableTimestampAnswer(
  reason: Extract<TimestampAnswer, { readonly available: false }>['reason'],
  recovery?: string,
  evidence: readonly VisualEvidence[] = [],
): TimestampAnswer {
  return {
    available: false,
    reason,
    ...(recovery ? { recovery } : {}),
    evidence,
  };
}
