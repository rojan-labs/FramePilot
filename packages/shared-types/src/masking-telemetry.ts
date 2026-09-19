/**
 * The masking program's observability events (RD2.2, plan 12 §B P19): the catalogue the
 * maintainer's dashboards read, and the one allow-list every catalogued emission goes through.
 *
 * Each event is a scoped-logger event the program already emits. Its payload is described here
 * field by field, as a KIND (a count, a duration, a ratio, a closed enum…), never as free text.
 * `maskingEventPayload` copies only the catalogued fields, and only values of the kind declared,
 * so an id, a path, a prompt or a frame that reaches an emit site by accident is dropped before
 * the logger sees it. `masking-telemetry.test.ts` scans this catalogue for names that would carry
 * identifying or media content, and scans the emit sites to prove each goes through the
 * allow-list. The runbook `docs/runbooks/masking-observability.md` lists the dashboard panel each
 * event feeds.
 */

/** What a field may hold. Every kind is a scalar or a map of scalars with fixed-vocabulary keys. */
export type MaskingFieldKind =
  /** A non-negative integer (frames, detections, masks). */
  | 'count'
  /** Milliseconds, finite and non-negative. */
  | 'ms'
  /** A fraction in [0, 1]. */
  | 'ratio'
  /** Pixels or bytes: a finite number. */
  | 'measure'
  | 'boolean'
  /** One value of a closed vocabulary: `[a-z0-9_. -]` (no `/`), at most 48 characters. */
  | 'enum'
  /** A semantic version (`1.2.3`, optionally `-pre`). */
  | 'version'
  /** An ISO-8601 UTC timestamp. */
  | 'timestamp'
  /** Milliseconds per named phase; the phase names are a closed vocabulary. */
  | 'msByPhase';

export interface MaskingEventSpec {
  /** The logger scope that emits it (`createLogger(scope)`). */
  readonly scope: string;
  /** The logger level: `action` events are the high-signal ones. */
  readonly level: 'action' | 'warn' | 'error' | 'debug';
  /** What the dashboard learns from it. */
  readonly summary: string;
  readonly fields: Readonly<Record<string, MaskingFieldKind>>;
}

export const MASKING_TELEMETRY_EVENTS = {
  matteJobStart: {
    scope: 'desktop:capability-packs:matte',
    level: 'action',
    summary: 'A background-removal job started (how many prompt points, whether a re-run).',
    fields: { prompts: 'count', rerun: 'boolean' },
  },
  matteJobEnd: {
    scope: 'desktop:capability-packs:matte',
    level: 'action',
    summary:
      'A background-removal job ended: outcome and failure code, execution provider, cache ' +
      'hit, flagged ratio, pack version, phase timings.',
    fields: {
      at: 'timestamp',
      status: 'enum',
      code: 'enum',
      verificationCode: 'enum',
      cacheHit: 'boolean',
      executionProvider: 'enum',
      packVersion: 'version',
      verifiedFrames: 'count',
      flaggedFrames: 'count',
      flaggedRatio: 'ratio',
      phasesMs: 'msByPhase',
      totalMs: 'ms',
    },
  },
  matteMonitorTier: {
    scope: 'desktop:capability-packs:matte',
    level: 'action',
    summary: "The matte's monitor tier was made (PX5.9): size, alpha plane, time.",
    fields: {
      status: 'enum',
      width: 'measure',
      height: 'measure',
      alpha: 'boolean',
      elapsedMs: 'ms',
    },
  },
  matteMonitorTierFailed: {
    scope: 'desktop:capability-packs:matte',
    level: 'warn',
    summary: 'Making the monitor tier failed; the monitor decodes the 4K masters instead.',
    fields: { code: 'enum', elapsedMs: 'ms' },
  },
  matteDiskPreflightRefused: {
    scope: 'desktop:capability-packs:matte',
    level: 'action',
    summary: 'A job was refused before it started because the disk would fill.',
    fields: { requiredBytes: 'measure', freeBytes: 'measure' },
  },
  workerWatchdogBreach: {
    scope: 'desktop:capability-packs:worker-watchdog',
    level: 'action',
    summary: 'A pack worker was stopped by the watchdog (memory, stalled, disk).',
    fields: { breach: 'enum' },
  },
  warmWorkerKilled: {
    scope: 'capability-packs:warm-worker',
    level: 'warn',
    summary: "A pack's warm worker (hover, tracking) was killed, and why.",
    fields: { reason: 'enum' },
  },
  workerComplete: {
    scope: 'capability-packs:worker-client',
    level: 'action',
    summary: 'A pack worker request finished (which capability, how many samples).',
    fields: { capability: 'enum', samples: 'count' },
  },
  jobCompleted: {
    scope: 'desktop:capability-packs:job-scheduler',
    level: 'action',
    summary: 'A queued pack job finished, and how long it took end to end.',
    fields: { kind: 'enum', elapsedMs: 'ms' },
  },
  jobEnded: {
    scope: 'desktop:capability-packs:job-scheduler',
    level: 'action',
    summary: 'A queued pack job failed or was cancelled.',
    fields: { kind: 'enum', state: 'enum' },
  },
  trackingComplete: {
    scope: 'desktop:capability-packs:tracking',
    level: 'action',
    summary: 'A tracking or subject-analysis request finished: capability, pack, sizes, time.',
    fields: {
      capability: 'enum',
      pack: 'version',
      samples: 'count',
      detections: 'count',
      masks: 'count',
      elapsedMs: 'ms',
    },
  },
  trackCommitted: {
    scope: 'desktop:capability-packs:track-job',
    level: 'action',
    summary: "A mask's track was committed: method, frames, flagged ranges, worst residual.",
    fields: {
      method: 'enum',
      frames: 'count',
      flaggedRanges: 'count',
      worstResidualPx: 'measure',
    },
  },
  segmentFrame: {
    scope: 'desktop:capability-packs:segment-frame',
    level: 'debug',
    summary: 'An AI Object hover was answered by the warm pack worker, and how fast.',
    fields: { ok: 'boolean', elapsedMs: 'ms' },
  },
  segmentFrameFailed: {
    scope: 'desktop:capability-packs:segment-frame',
    level: 'warn',
    summary: 'An AI Object hover failed in the pack worker.',
    fields: { code: 'enum' },
  },
  exportJobEnd: {
    scope: 'web-editor:export',
    level: 'action',
    summary:
      'An export ended: outcome, wall time, frames, and how much masking the timeline carried ' +
      '(the export-time ratio compares ms per frame with and without mattes).',
    fields: {
      status: 'enum',
      elapsedMs: 'ms',
      frames: 'count',
      resolution: 'enum',
      maskedClips: 'count',
      mattes: 'count',
      keys: 'count',
      shapes: 'count',
      trackMattes: 'count',
      frameSpaceMasks: 'count',
    },
  },
} as const satisfies Readonly<Record<string, MaskingEventSpec>>;

export type MaskingEventName = keyof typeof MASKING_TELEMETRY_EVENTS;

type KindValue<K> = K extends 'boolean'
  ? boolean
  : K extends 'enum' | 'version' | 'timestamp'
    ? string
    : K extends 'msByPhase'
      ? Readonly<Record<string, number>>
      : number;

/** The payload of a catalogued event: every field optional, each of its declared kind. */
export type MaskingEventPayload<N extends MaskingEventName> = {
  readonly [F in keyof (typeof MASKING_TELEMETRY_EVENTS)[N]['fields']]?: KindValue<
    (typeof MASKING_TELEMETRY_EVENTS)[N]['fields'][F]
  >;
};

const ENUM_VALUE = /^[a-z0-9_. -]{1,48}$/i;
const VERSION_VALUE = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]{1,32})?$/i;
const TIMESTAMP_VALUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PHASE_NAME = /^[a-z][a-z0-9_.]{0,47}$/i;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** `value` as `kind`, or `undefined` when it is not one (it is then dropped, not coerced). */
function fieldValue(kind: MaskingFieldKind, value: unknown): unknown {
  switch (kind) {
    case 'count':
      return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
    case 'ms':
      return isFiniteNumber(value) && value >= 0 ? value : undefined;
    case 'ratio':
      return isFiniteNumber(value) && value >= 0 && value <= 1 ? value : undefined;
    case 'measure':
      return isFiniteNumber(value) ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'enum':
      return typeof value === 'string' && ENUM_VALUE.test(value) ? value : undefined;
    case 'version':
      return typeof value === 'string' && VERSION_VALUE.test(value) ? value : undefined;
    case 'timestamp':
      return typeof value === 'string' && TIMESTAMP_VALUE.test(value) ? value : undefined;
    case 'msByPhase': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      const phases: Record<string, number> = {};
      for (const [phase, ms] of Object.entries(value)) {
        if (PHASE_NAME.test(phase) && isFiniteNumber(ms) && ms >= 0) phases[phase] = ms;
      }
      return phases;
    }
  }
}

/**
 * The allow-listed payload of a catalogued masking event: only its catalogued fields, each only
 * if its value is of the declared kind. Everything else is dropped, so an id, a path, a prompt or
 * a picture never reaches the logger through a catalogued event.
 *
 * @param name - The catalogued event.
 * @param payload - What the emit site has; may hold more than the catalogue allows.
 * @returns The payload to log.
 */
export function maskingEventPayload<N extends MaskingEventName>(
  name: N,
  payload: MaskingEventPayload<N> | Readonly<Record<string, unknown>>,
): MaskingEventPayload<N> {
  const fields: Readonly<Record<string, MaskingFieldKind>> = MASKING_TELEMETRY_EVENTS[name].fields;
  const picked: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(fields)) {
    const value = fieldValue(kind, (payload as Readonly<Record<string, unknown>>)[field]);
    if (value !== undefined) picked[field] = value;
  }
  return picked as MaskingEventPayload<N>;
}
