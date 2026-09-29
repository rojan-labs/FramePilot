/**
 * `measure_loudness`: the timeline's mix (or one role's stem) through the engine's EBU R128
 * meter, and what the reading means against a target the editor stated.
 *
 * WHY this exists: a brief that asks for "−14 LUFS, true peak ≤ −1 dBTP" was answered "I can't
 * measure loudness here, so these are not confirmed" (desktop run `88c8b27d`), while the engine
 * had a loudness meter behind `/review/temporal-evidence` that no caller ever asked. This module
 * builds that one request and reads its answer; `sidecar-executor.ts` only routes it.
 *
 * The reading names the lever that closes a gap (`adjust_audio`, `professional_audio`), because a
 * number with no move attached is the half of the answer the model then has to guess.
 */
import { z } from 'zod/v4';
import type { Project } from '@framepilot/timeline-schema';
import { numeric, seconds } from './domain-tools/tool-args.js';
import { TemporalEvidenceBatchSchema, TEMPORAL_EVIDENCE_VERSION } from './temporal-review.js';
import type { HostToolOutcome } from './tool-executor.js';

/** The engine's widest loudness window (`MAX_LOUDNESS_WINDOW_FRAMES`: thirty minutes at 60 fps). */
export const MAX_LOUDNESS_WINDOW_FRAMES = 30 * 60 * 60;

/** How close to a stated target counts as on it — the engine's and the reviewer's default. */
export const LOUDNESS_TOLERANCE_LU = 1;

/** EBU R128's absolute gate: a programme at or under it is silence to the meter. */
const SILENCE_GATE_LUFS = -70;

const ROLES = ['mix', 'dialogue', 'music', 'sfx'] as const;
type LoudnessRole = (typeof ROLES)[number];

export const MeasureLoudnessArgsSchema = z
  .object({
    role: z
      .enum(ROLES)
      .optional()
      .describe('mix (default): the whole programme. A role: only the tracks labelled with it.'),
    startSeconds: seconds.optional().describe('Timeline seconds; default the start.'),
    endSeconds: seconds.optional().describe('Timeline seconds; default the end.'),
    targetLufs: numeric(z.number().min(SILENCE_GATE_LUFS).max(0))
      .optional()
      .describe('The integrated loudness the request asks for, e.g. -14.'),
    maxTruePeakDbtp: numeric(z.number().max(0))
      .optional()
      .describe('The true-peak ceiling the request asks for, e.g. -1.'),
  })
  .strict();
export type MeasureLoudnessArgs = z.infer<typeof MeasureLoudnessArgsSchema>;

/** The window one call measures, in the engine's frames and the editor's seconds. */
interface LoudnessWindow {
  readonly role: LoudnessRole;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly fps: number;
  readonly projectRevision: number;
}

/** The engine's timeline duration (`render/compiler.py#timeline_duration`): the last clip end. */
function timelineEndSeconds(project: Project): number {
  return project.timeline.tracks
    .flatMap((track) => track.clips)
    .reduce((end, clip) => Math.max(end, clip.end), 0);
}

/**
 * Resolve the call to a frame window, or say why there is nothing to measure.
 *
 * Frames are rounded outwards, and the end is held to the engine's own last frame
 * (`ceil(duration × fps)`), which is the bound its request validation enforces.
 */
export function loudnessWindow(
  project: Project,
  args: MeasureLoudnessArgs,
): LoudnessWindow | { readonly refusal: string } {
  const fps = project.fps;
  const endSeconds = timelineEndSeconds(project);
  const lastFrame = Math.ceil(endSeconds * fps);
  if (lastFrame <= 0) {
    return { refusal: 'Cannot measure loudness: the timeline is empty. Place clips first.' };
  }
  const startFrame = Math.max(0, Math.floor((args.startSeconds ?? 0) * fps));
  const endFrame = Math.min(lastFrame, Math.ceil((args.endSeconds ?? endSeconds) * fps));
  if (endFrame <= startFrame) {
    const asked =
      args.endSeconds === undefined
        ? `from ${String(args.startSeconds ?? 0)}s`
        : `over ${String(args.startSeconds ?? 0)}–${String(args.endSeconds)}s`;
    return {
      refusal:
        `Cannot measure loudness ${asked}: that range is empty or past the end of the ` +
        `timeline, which ends at ${String(round1(endSeconds))}s. Leave startSeconds and ` +
        'endSeconds out to measure the whole timeline.',
    };
  }
  if (endFrame - startFrame > MAX_LOUDNESS_WINDOW_FRAMES) {
    const limitSeconds = round1(MAX_LOUDNESS_WINDOW_FRAMES / fps);
    return {
      refusal:
        `Cannot measure ${round1((endFrame - startFrame) / fps)}s in one call: the meter reads ` +
        `at most ${String(limitSeconds)}s. Measure a part with startSeconds/endSeconds, and say ` +
        'that the integrated figure is for that part — parts do not add up to the whole.',
    };
  }
  return {
    role: args.role ?? 'mix',
    startFrame,
    endFrame,
    fps,
    projectRevision: project.timeline.revision ?? 0,
  };
}

/**
 * Why this call cannot be measured, or `undefined` when it can. Checked before anything is
 * sent, so an empty timeline or a range past its end is answered with the remedy, not an
 * engine error.
 */
export function loudnessRefusal(project: Project, rawArgs: unknown): string | undefined {
  const parsed = MeasureLoudnessArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return (
      'Cannot measure loudness: ' +
      parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')
    );
  }
  const window = loudnessWindow(project, parsed.data);
  return 'refusal' in window ? window.refusal : undefined;
}

/** The engine request for one window. */
export function loudnessRequest(
  window: LoudnessWindow,
  requestId: string,
): Record<string, unknown> {
  return {
    schemaVersion: TEMPORAL_EVIDENCE_VERSION,
    requestId,
    projectRevision: window.projectRevision,
    kind: 'loudness',
    startFrame: window.startFrame,
    endFrame: window.endFrame,
    channels: window.role,
    reason: `Measure the ${window.role} loudness`,
  };
}

/** What the engine measured, in the units the reading speaks. */
export interface LoudnessReading {
  readonly role: LoudnessRole;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly projectRevision: number;
  readonly integratedLufs: number;
  readonly loudnessRangeLu: number | null;
  /** ebur128's 4×-oversampled true peak of the mix as an export writes it (clipped at 0 dBFS). */
  readonly truePeakDbtp: number | null;
  /** The highest sample of the mix BEFORE the full-scale clip. */
  readonly samplePeakDbfs: number | null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A signed dB figure the way an editor writes one: `+2.8`, `-1.5`. */
function signed(value: number): string {
  const rounded = round1(value);
  return `${rounded > 0 ? '+' : ''}${String(rounded)}`;
}

function subject(role: LoudnessRole): string {
  return role === 'mix' ? 'the mix' : `the ${role} stem (tracks labelled ${role}, alone)`;
}

/** The measured figures as one line. */
function figuresLine(reading: LoudnessReading): string {
  const span = `${String(round1(reading.startSeconds))}–${String(round1(reading.endSeconds))}s`;
  if (reading.integratedLufs <= SILENCE_GATE_LUFS) {
    return (
      `Measured ${subject(reading.role)} over ${span} at revision ` +
      `${String(reading.projectRevision)}: silent — nothing above the ${String(SILENCE_GATE_LUFS)} ` +
      'LUFS gate, so there is no loudness to report or to raise.'
    );
  }
  const range =
    reading.loudnessRangeLu === null
      ? 'no loudness range (under ~3 s of sound)'
      : `loudness range ${String(round1(reading.loudnessRangeLu))} LU`;
  const truePeak =
    reading.truePeakDbtp === null
      ? 'true peak not reported'
      : `true peak ${String(round1(reading.truePeakDbtp))} dBTP`;
  const samplePeak =
    reading.samplePeakDbfs === null
      ? ''
      : `, sample peak ${String(round1(reading.samplePeakDbfs))} dBFS`;
  return (
    `Measured ${subject(reading.role)} over ${span} at revision ${String(reading.projectRevision)}: ` +
    `integrated ${String(round1(reading.integratedLufs))} LUFS, ${range}, ${truePeak}${samplePeak}. ` +
    'The true peak is 4× oversampled, of the mix as an export writes it (clipped at full scale).'
  );
}

/** The loudness verdict and its lever, when the editor stated a target. */
function targetLines(reading: LoudnessReading, args: MeasureLoudnessArgs): string[] {
  const target = args.targetLufs;
  if (target === undefined) return [];
  const gap = target - reading.integratedLufs;
  if (Math.abs(gap) <= LOUDNESS_TOLERANCE_LU) {
    return [
      `On target: ${signed(-gap)} LU from ${String(target)} LUFS (within ` +
        `${String(LOUDNESS_TOLERANCE_LU)} LU).`,
    ];
  }
  const direction = gap > 0 ? 'under' : 'over';
  const move = gap > 0 ? 'raise' : 'lower';
  const lines = [
    `${String(round1(Math.abs(gap)))} LU ${direction} the ${String(target)} LUFS target. A flat ` +
      `gain moves integrated loudness by the same number of dB, so ${move} every sounding ` +
      `track by ${String(round1(Math.abs(gap)))} dB: adjust_audio gainDb is absolute, so set ` +
      `each track (one trackId call per track) to its current gain ${signed(gap)} dB — the ` +
      'same move on every track keeps the balance. professional_audio level normalize sets a ' +
      "clip's PEAK, not the programme's loudness, so it does not land a LUFS target.",
  ];
  if (reading.role !== 'mix') {
    lines.push('This is one stem: a delivery target is met by the mix, so measure role mix too.');
  }
  const predictedPeak = reading.truePeakDbtp === null ? null : reading.truePeakDbtp + gap;
  const ceiling = args.maxTruePeakDbtp ?? 0;
  if (gap > 0 && predictedPeak !== null && predictedPeak > ceiling) {
    lines.push(
      `Raised that far, the true peak would reach about ${String(round1(predictedPeak))} dBTP, ` +
        `over the ${String(ceiling)} dBTP ${args.maxTruePeakDbtp === undefined ? 'full-scale limit' : 'ceiling'}: ` +
        'first bring the peaks down relative to the average with professional_audio compress ' +
        'on the loudest clips, then raise the gain.',
    );
  }
  return lines;
}

/** The peak verdicts: a stated ceiling, and a mix that goes over full scale. */
function peakLines(reading: LoudnessReading, args: MeasureLoudnessArgs): string[] {
  const lines: string[] = [];
  const ceiling = args.maxTruePeakDbtp;
  if (ceiling !== undefined && reading.truePeakDbtp !== null) {
    const over = reading.truePeakDbtp - ceiling;
    lines.push(
      over > 0
        ? `True peak ${String(round1(reading.truePeakDbtp))} dBTP is ${String(round1(over))} dB ` +
            `over the ${String(ceiling)} dBTP ceiling: compress the loudest clips ` +
            '(professional_audio compress), or lower them with adjust_audio — lowering the ' +
            'whole mix lowers its loudness by as much.'
        : `True peak is within the ${String(ceiling)} dBTP ceiling (${String(round1(-over))} dB under).`,
    );
  }
  if (reading.samplePeakDbfs !== null && reading.samplePeakDbfs > 0) {
    lines.push(
      `The mix goes ${String(round1(reading.samplePeakDbfs))} dB over full scale before the ` +
        'export clips it: lower the loudest clips with adjust_audio, or compress them.',
    );
  }
  return lines;
}

/**
 * Read one loudness result into the payload the model reads.
 *
 * Every figure comes off the engine; nothing is estimated. The one derived number — the true
 * peak a gain change would leave — is labelled "about", because it assumes a flat gain.
 */
export function describeLoudness(reading: LoudnessReading, args: MeasureLoudnessArgs): string {
  const silent = reading.integratedLufs <= SILENCE_GATE_LUFS;
  const lines = [figuresLine(reading)];
  if (!silent) lines.push(...targetLines(reading, args), ...peakLines(reading, args));
  if (args.targetLufs !== undefined && !silent) {
    lines.push(
      'This measures the timeline. The Export dialog’s Audio → Loudness preset (Social −14 LUFS) ' +
        'normalises the delivered file instead, with a −1.5 dBTP ceiling; say so if that is how ' +
        'the target will be met.',
    );
  }
  lines.push('Measure again after any change.');
  return lines.join('\n');
}

/** Settle the engine's answer into the tool outcome. */
export function interpretLoudness(
  data: unknown,
  requestId: string,
  window: LoudnessWindow,
  args: MeasureLoudnessArgs,
): HostToolOutcome {
  const parsed = TemporalEvidenceBatchSchema.safeParse(data);
  if (!parsed.success) {
    return {
      status: 'failed',
      summary:
        'Loudness measurement returned an invalid evidence batch, so nothing was measured. Say ' +
        'plainly that the mix level is unmeasured, and do not call measure_loudness again in ' +
        'this run.',
    };
  }
  const result = parsed.data.results.find(
    (candidate) => candidate.requestId === requestId && candidate.kind === 'loudness',
  );
  if (!result || result.kind !== 'loudness') {
    return {
      status: 'failed',
      summary:
        'Loudness measurement returned no loudness result, so nothing was measured. Say plainly ' +
        'that the mix level is unmeasured, and do not call measure_loudness again in this run.',
    };
  }
  const reading: LoudnessReading = {
    role: window.role,
    startSeconds: window.startFrame / window.fps,
    endSeconds: window.endFrame / window.fps,
    projectRevision: result.projectRevision,
    integratedLufs: result.sample.integratedLufs,
    loudnessRangeLu: result.sample.loudnessRangeLu ?? null,
    truePeakDbtp: result.sample.truePeakDbfs ?? null,
    samplePeakDbfs: result.sample.samplePeakDbfs ?? null,
  };
  const truePeak =
    reading.truePeakDbtp === null ? '' : `, true peak ${String(round1(reading.truePeakDbtp))} dBTP`;
  return {
    status: 'completed',
    summary: `Measured ${reading.role} loudness: ${String(round1(reading.integratedLufs))} LUFS${truePeak}`,
    data: {
      ...reading,
      ...(args.targetLufs === undefined
        ? {}
        : { targetLufs: args.targetLufs, gapLu: round1(args.targetLufs - reading.integratedLufs) }),
      ...(args.maxTruePeakDbtp === undefined ? {} : { maxTruePeakDbtp: args.maxTruePeakDbtp }),
      reading: describeLoudness(reading, args),
    },
  };
}
