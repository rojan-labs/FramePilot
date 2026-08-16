import type { Effect, Keyframe } from '@framepilot/timeline-schema';

/** The clip-level animation properties the Python renderer actually composites. */
export const CLIP_KEYFRAME_PROPERTIES = ['scale', 'x', 'y', 'rotation', 'opacity'] as const;
export type ClipKeyframeProperty = (typeof CLIP_KEYFRAME_PROPERTIES)[number];

const CLIP_KEYFRAME_PROPERTY_SET = new Set<string>(CLIP_KEYFRAME_PROPERTIES);

export interface ContractIssue {
  readonly field: string;
  readonly message: string;
}

const finiteIssue = (field: string, value: number): ContractIssue | undefined =>
  Number.isFinite(value) ? undefined : { field, message: `${field} must be finite.` };

/** Validate one clip transform keyframe against preview/export semantics. */
export function clipKeyframeContractIssue(keyframe: Keyframe): ContractIssue | undefined {
  if (!CLIP_KEYFRAME_PROPERTY_SET.has(keyframe.property)) {
    return {
      field: 'property',
      message:
        `Unsupported clip keyframe property "${keyframe.property}". ` +
        `Supported properties: ${CLIP_KEYFRAME_PROPERTIES.join(', ')}.`,
    };
  }
  const timeIssue = finiteIssue('time', keyframe.time);
  if (timeIssue) return timeIssue;
  if (keyframe.time < 0) return { field: 'time', message: 'Keyframe time must be non-negative.' };
  const valueIssue = finiteIssue('value', keyframe.value);
  if (valueIssue) return valueIssue;
  if (keyframe.property === 'scale' && keyframe.value <= 0) {
    return { field: 'value', message: 'Scale keyframes must be greater than 0.' };
  }
  if (keyframe.property === 'opacity' && (keyframe.value < 0 || keyframe.value > 1)) {
    return { field: 'value', message: 'Opacity keyframes must be within 0..1.' };
  }
  return undefined;
}

export interface NumericParameterContract {
  readonly min: number;
  readonly max: number;
}

/**
 * Parametric color-grade controls implemented by `render/color.py`.
 * Unknown keys are rejected because that renderer otherwise ignores them.
 */
export const COLOR_GRADE_PARAMETER_CONTRACTS: Readonly<Record<string, NumericParameterContract>> = {
  exposure: { min: -5, max: 5 },
  contrast: { min: -1, max: 1 },
  saturation: { min: -1, max: 3 },
  temperature: { min: -1, max: 1 },
  tint: { min: -1, max: 1 },
  shadows: { min: -1, max: 1 },
  highlights: { min: -1, max: 1 },
};

/** Practical, deterministic audio edit ranges used by the renderer. */
export const AUDIO_PARAMETER_CONTRACTS = {
  gainDb: { min: -120, max: 24 },
  duckAmountDb: { min: -60, max: 0 },
} as const satisfies Readonly<Record<string, NumericParameterContract>>;

export const AUDIO_FADE_CURVES = ['linear', 'equal-power', 'smooth'] as const;
const AUDIO_FADE_CURVE_SET = new Set<string>(AUDIO_FADE_CURVES);

/**
 * The filter shapes the renderer's EQ implements.
 *
 * A closed vocabulary for the same reason `EffectRenderKind` is one:
 * the numpy pass branches on the kind, so an unlisted shape would validate and
 * then render as no filter at all — an EQ move the editor believes it made and
 * the export silently drops.
 */
export const AUDIO_EQ_BAND_KINDS = [
  'low-shelf',
  'peaking',
  'high-shelf',
  'high-pass',
  'low-pass',
] as const;
export type AudioEqBandKind = (typeof AUDIO_EQ_BAND_KINDS)[number];
const AUDIO_EQ_BAND_KIND_SET = new Set<string>(AUDIO_EQ_BAND_KINDS);

/** The pass filters cut a range outright, so a boost/cut amount is meaningless on them. */
const AUDIO_EQ_GAIN_KINDS = new Set<string>(['low-shelf', 'peaking', 'high-shelf']);

/** One band of the per-clip EQ. */
export interface AudioEqBand {
  readonly kind: AudioEqBandKind;
  /** Centre frequency for a peaking band, corner frequency for a shelf or pass filter. */
  readonly frequencyHz: number;
  /** Boost/cut. Required for shelf and peaking bands, refused on pass filters. */
  readonly gainDb?: number;
  /** Bandwidth. Absent means the Butterworth-flat 0.707 every EQ defaults to. */
  readonly q?: number;
}

/**
 * The maximum number of bands one clip's EQ may carry.
 *
 * Not a renderer limit — a truthfulness one. Each band costs a pass over the
 * spectrum, and an EQ curve authored from twenty overlapping bands is not
 * something a reviewer or an inverse patch can reason about.
 */
export const AUDIO_EQ_MAX_BANDS = 8;

export const AUDIO_EQ_PARAMETER_CONTRACTS = {
  /** Below 20 Hz and above 20 kHz is outside hearing; above Nyquist it is undefined. */
  frequencyHz: { min: 20, max: 20000 },
  gainDb: { min: -24, max: 24 },
  q: { min: 0.1, max: 18 },
} as const satisfies Readonly<Record<string, NumericParameterContract>>;

export const AUDIO_EQ_DEFAULT_Q = 0.707;

/** Per-clip compressor settings. */
export interface AudioDynamicsSettings {
  readonly thresholdDb: number;
  readonly ratio: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly makeupGainDb?: number;
}

export const AUDIO_DYNAMICS_PARAMETER_CONTRACTS = {
  thresholdDb: { min: -60, max: 0 },
  /**
   * 1:1 is a bypass, so the floor is the identity rather than a refusal. The
   * ceiling is limiting territory; past 20:1 the ratio stops changing the result.
   */
  ratio: { min: 1, max: 20 },
  /**
   * The floor is the renderer's envelope resolution, not a taste judgement: the
   * detector measures peaks in 1 ms blocks, so a faster attack could not be
   * honoured and would be a setting the export quietly rounds away.
   */
  attackMs: { min: 1, max: 200 },
  releaseMs: { min: 5, max: 2000 },
  makeupGainDb: { min: 0, max: 24 },
} as const satisfies Readonly<Record<string, NumericParameterContract>>;

/**
 * The clip audio parameters an automation lane may drive.
 *
 * Only `gainDb` today, and the list exists so that adding a second one is a
 * deliberate two-sided change (contract + renderer) rather than a string that
 * validates and animates nothing.
 */
export const AUDIO_AUTOMATION_PROPERTIES = ['gainDb'] as const;
export type AudioAutomationProperty = (typeof AUDIO_AUTOMATION_PROPERTIES)[number];
const AUDIO_AUTOMATION_PROPERTY_SET = new Set<string>(AUDIO_AUTOMATION_PROPERTIES);

/**
 * The fewest points that make a lane an automation lane.
 *
 * One point is a constant, which `gainDb` already expresses — accepting it would
 * mean two ways to say the same thing, one of which then overrides the other.
 */
export const AUDIO_AUTOMATION_MIN_POINTS = 2;

/**
 * Smallest separation the current renderer can distinguish between automation points.
 *
 * The gain envelope is evaluated on a 1 ms grid. Keeping the authored contract on that same
 * resolution prevents two valid points from collapsing onto the millisecond-derived keyframe id
 * and avoids claiming sub-millisecond precision the renderer cannot reproduce.
 */
export const AUDIO_AUTOMATION_TIME_RESOLUTION_SECONDS = 0.001;

function boundedIssue(
  field: string,
  value: number,
  contract: NumericParameterContract,
  unit = '',
): ContractIssue | undefined {
  const finite = finiteIssue(field, value);
  if (finite) return finite;
  return value < contract.min || value > contract.max
    ? {
        field,
        message: `${field} must be within ${String(contract.min)}..${String(contract.max)}${unit}.`,
      }
    : undefined;
}

/** Validate one EQ band against what the renderer implements. */
export function audioEqBandContractIssue(
  band: AudioEqBand,
  index: number,
): ContractIssue | undefined {
  const at = (field: string): string => `eq.bands[${String(index)}].${field}`;
  if (!AUDIO_EQ_BAND_KIND_SET.has(band.kind)) {
    return {
      field: at('kind'),
      message: `kind must be one of ${AUDIO_EQ_BAND_KINDS.join(', ')}.`,
    };
  }
  const frequency = boundedIssue(
    at('frequencyHz'),
    band.frequencyHz,
    AUDIO_EQ_PARAMETER_CONTRACTS.frequencyHz,
    ' Hz',
  );
  if (frequency) return frequency;
  const needsGain = AUDIO_EQ_GAIN_KINDS.has(band.kind);
  if (needsGain) {
    if (band.gainDb === undefined) {
      return { field: at('gainDb'), message: `A ${band.kind} band requires gainDb.` };
    }
    const gain = boundedIssue(
      at('gainDb'),
      band.gainDb,
      AUDIO_EQ_PARAMETER_CONTRACTS.gainDb,
      ' dB',
    );
    if (gain) return gain;
  } else if (band.gainDb !== undefined) {
    return {
      field: at('gainDb'),
      message: `A ${band.kind} band cuts a range outright and takes no gainDb.`,
    };
  }
  return band.q === undefined
    ? undefined
    : boundedIssue(at('q'), band.q, AUDIO_EQ_PARAMETER_CONTRACTS.q);
}

/** Validate a whole EQ curve. */
export function audioEqContractIssue(bands: readonly AudioEqBand[]): ContractIssue | undefined {
  if (bands.length === 0) {
    return { field: 'eq.bands', message: 'An EQ requires at least one band.' };
  }
  if (bands.length > AUDIO_EQ_MAX_BANDS) {
    return {
      field: 'eq.bands',
      message: `An EQ may carry at most ${String(AUDIO_EQ_MAX_BANDS)} bands.`,
    };
  }
  for (const [index, band] of bands.entries()) {
    const issue = audioEqBandContractIssue(band, index);
    if (issue) return issue;
  }
  return undefined;
}

/** Validate compressor settings. */
export function audioDynamicsContractIssue(
  dynamics: AudioDynamicsSettings,
): ContractIssue | undefined {
  for (const [field, value, unit] of [
    ['thresholdDb', dynamics.thresholdDb, ' dB'],
    ['ratio', dynamics.ratio, ':1'],
    ['attackMs', dynamics.attackMs, ' ms'],
    ['releaseMs', dynamics.releaseMs, ' ms'],
  ] as const) {
    const issue = boundedIssue(
      `dynamics.${field}`,
      value,
      AUDIO_DYNAMICS_PARAMETER_CONTRACTS[field],
      unit,
    );
    if (issue) return issue;
  }
  return dynamics.makeupGainDb === undefined
    ? undefined
    : boundedIssue(
        'dynamics.makeupGainDb',
        dynamics.makeupGainDb,
        AUDIO_DYNAMICS_PARAMETER_CONTRACTS.makeupGainDb,
        ' dB',
      );
}

/** One authored point on a clip audio automation lane. */
export interface AudioAutomationPoint {
  readonly timeSeconds: number;
  readonly value: number;
  readonly easing?: string;
}

/**
 * Validate an automation lane.
 *
 * Times are clip-relative, strictly increasing, and inside the clip: a lane with
 * two points at the same instant has no defined value there, and a point past the
 * clip's end is a move the render can never reach. Points must also respect the
 * renderer's 1 ms time grid so valid authored points always map to distinct ids.
 */
export function audioAutomationContractIssue(
  property: string,
  points: readonly AudioAutomationPoint[],
  clipDurationSeconds: number,
): ContractIssue | undefined {
  if (!AUDIO_AUTOMATION_PROPERTY_SET.has(property)) {
    return {
      field: 'automation.property',
      message:
        `Unsupported automation property "${property}". ` +
        `Supported properties: ${AUDIO_AUTOMATION_PROPERTIES.join(', ')}.`,
    };
  }
  if (points.length < AUDIO_AUTOMATION_MIN_POINTS) {
    return {
      field: 'automation.points',
      message:
        `An automation lane needs at least ${String(AUDIO_AUTOMATION_MIN_POINTS)} points; ` +
        'a single point is a constant level, which gainDb already sets.',
    };
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (const [index, point] of points.entries()) {
    const at = (field: string): string => `automation.points[${String(index)}].${field}`;
    const time = finiteIssue(at('timeSeconds'), point.timeSeconds);
    if (time) return time;
    if (point.timeSeconds < 0 || point.timeSeconds > clipDurationSeconds) {
      return {
        field: at('timeSeconds'),
        message: `Automation times must be inside the clip (0..${String(clipDurationSeconds)}s).`,
      };
    }
    if (point.timeSeconds <= previous) {
      return {
        field: at('timeSeconds'),
        message: 'Automation times must strictly increase.',
      };
    }
    if (
      previous !== Number.NEGATIVE_INFINITY &&
      point.timeSeconds - previous < AUDIO_AUTOMATION_TIME_RESOLUTION_SECONDS
    ) {
      return {
        field: at('timeSeconds'),
        message:
          `Automation points must be at least ` +
          `${String(AUDIO_AUTOMATION_TIME_RESOLUTION_SECONDS * 1000)} ms apart.`,
      };
    }
    previous = point.timeSeconds;
    const value = boundedIssue(at('value'), point.value, AUDIO_PARAMETER_CONTRACTS.gainDb, ' dB');
    if (value) return value;
  }
  return undefined;
}

/** Validate the effect produced by `apply_color_grade`. */
export function colorGradeContractIssues(effect: Effect): ContractIssue[] {
  if (effect.type === 'lut') {
    const path = effect.params.path;
    return typeof path === 'string' && path.trim() !== ''
      ? []
      : [{ field: 'params.path', message: 'A LUT effect requires a non-empty string path.' }];
  }
  if (effect.type !== 'color_grade') {
    return [
      {
        field: 'type',
        message: `Unsupported color effect type "${effect.type}". Use color_grade or lut.`,
      },
    ];
  }

  const issues: ContractIssue[] = [];
  for (const [name, value] of Object.entries(effect.params)) {
    const contract = COLOR_GRADE_PARAMETER_CONTRACTS[name];
    if (!contract) {
      issues.push({
        field: `params.${name}`,
        message: `Unknown color-grade parameter "${name}".`,
      });
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ field: `params.${name}`, message: `${name} must be a finite number.` });
      continue;
    }
    if (value < contract.min || value > contract.max) {
      issues.push({
        field: `params.${name}`,
        message: `${name} must be within ${String(contract.min)}..${String(contract.max)}.`,
      });
    }
  }
  return issues;
}

export function audioGainContractIssue(gainDb: number): ContractIssue | undefined {
  const finite = finiteIssue('gainDb', gainDb);
  if (finite) return finite;
  const contract = AUDIO_PARAMETER_CONTRACTS.gainDb;
  return gainDb < contract.min || gainDb > contract.max
    ? {
        field: 'gainDb',
        message: `gainDb must be within ${String(contract.min)}..${String(contract.max)} dB.`,
      }
    : undefined;
}

export function duckAmountContractIssue(duckAmountDb: number): ContractIssue | undefined {
  const finite = finiteIssue('duckAmountDb', duckAmountDb);
  if (finite) return finite;
  const contract = AUDIO_PARAMETER_CONTRACTS.duckAmountDb;
  return duckAmountDb < contract.min || duckAmountDb > contract.max
    ? {
        field: 'duckAmountDb',
        message:
          `duckAmountDb must be a reduction within ` +
          `${String(contract.min)}..${String(contract.max)} dB.`,
      }
    : undefined;
}

export function audioFadeCurveSupported(curve: string): boolean {
  return AUDIO_FADE_CURVE_SET.has(curve);
}
