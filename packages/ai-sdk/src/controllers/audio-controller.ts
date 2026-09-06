/** Professional audio objectives resolved from live clip and track selection state. */
import { z } from 'zod/v4';
import {
  AUDIO_DYNAMICS_PARAMETER_CONTRACTS,
  AUDIO_EQ_BAND_KINDS,
  AUDIO_EQ_MAX_BANDS,
  AUDIO_EQ_PARAMETER_CONTRACTS,
  AUDIO_FADE_CURVES,
  AUDIO_PARAMETER_CONTRACTS,
  type AudioCommand,
  type MixClipAudioSettings,
} from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import { AudioRoleSchema, type Project } from '@framepilot/timeline-schema';
import type { EditorInteractionContext } from '../editor-context/interaction-context.js';
import { resolveEditorTarget, type TargetEvidence } from '../editor-context/target-resolver.js';
import { rationalFrameRate } from '../frame-time.js';

const log = createLogger('ai-sdk:controllers:audio');

const bounded = (contract: { readonly min: number; readonly max: number }) =>
  z.number().finite().min(contract.min).max(contract.max);

/**
 * One EQ band, in the editor's vocabulary rather than the filter designer's:
 * a shape, where it sits, how much, and how wide.
 */
export const AudioEqBandInputSchema = z
  .object({
    kind: z.enum(AUDIO_EQ_BAND_KINDS),
    frequencyHz: bounded(AUDIO_EQ_PARAMETER_CONTRACTS.frequencyHz),
    /** Required for shelves and peaks; a pass filter cuts outright and takes none. */
    gainDb: bounded(AUDIO_EQ_PARAMETER_CONTRACTS.gainDb).optional(),
    q: bounded(AUDIO_EQ_PARAMETER_CONTRACTS.q).optional(),
  })
  .strict();

// `requiredBy` is a function declaration (hoisted), so it's usable here despite
// being defined later in the file.
export const AudioDynamicsInputSchema = z
  .object(
    {
      thresholdDb: bounded(AUDIO_DYNAMICS_PARAMETER_CONTRACTS.thresholdDb),
      ratio: bounded(AUDIO_DYNAMICS_PARAMETER_CONTRACTS.ratio),
      attackMs: bounded(AUDIO_DYNAMICS_PARAMETER_CONTRACTS.attackMs),
      releaseMs: bounded(AUDIO_DYNAMICS_PARAMETER_CONTRACTS.releaseMs),
      makeupGainDb: bounded(AUDIO_DYNAMICS_PARAMETER_CONTRACTS.makeupGainDb).optional(),
    },
    // Attached here rather than at the `compress` call site, so `CompressObjectiveSchema`
    // can reference this schema directly instead of rebuilding an equivalent one from its
    // `.shape` — a rebuild that would silently drop any object-level `.refine()`/
    // `.superRefine()` added to this schema later, since `.shape` carries only the
    // per-field schemas. The one caller today is `compress`, hence the message.
    { error: requiredBy('compress', 'dynamics') },
  )
  .strict();

/**
 * One automation point, in **clip-relative frames** like every other authored
 * time in this layer — the model never supplies seconds it would have to derive
 * from a frame rate it cannot see.
 */
export const AudioAutomationPointInputSchema = z
  .object({
    frame: z.number().int().min(0),
    gainDb: bounded(AUDIO_PARAMETER_CONTRACTS.gainDb),
    easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']).optional(),
  })
  .strict();

/**
 * Which intent owns each setting, so a misfiled field is answered with the call to
 * make instead of a bare "unrecognized key". The model sees the split structurally
 * in the JSON Schema below; this map only has to explain a mistake once it happens.
 */
const AUDIO_FIELD_OWNERS: Readonly<Record<string, string>> = {
  gainDb: 'level',
  fadeInFrames: 'level',
  fadeOutFrames: 'level',
  fadeCurve: 'level',
  muted: 'level',
  normalize: 'level',
  eqBands: 'eq',
  dynamics: 'compress',
  automationPoints: 'automate_gain',
  reductionDb: 'duck_selection/duck_roles',
  bedRole: 'duck_roles',
  sidechainRole: 'duck_roles',
};

/** Zod hands its `error` hook the raw issue; only the stray-key case is rewritten. */
interface RawObjectiveIssue {
  readonly code?: string;
  readonly keys?: readonly string[];
}

function foreignKeyError(intent: string) {
  return (issue: unknown): string | undefined => {
    const raw = issue as RawObjectiveIssue;
    if (raw.code !== 'unrecognized_keys') return undefined;
    return (raw.keys ?? [])
      .map((key) => {
        const owner = AUDIO_FIELD_OWNERS[key];
        return owner === undefined
          ? `${key} is not an audio setting.`
          : `${key} belongs to the ${owner} intent, not ${intent}; make it a separate call.`;
      })
      .join(' ');
  };
}

/** Names the missing setting the way the tool description does, not as a type mismatch. */
function requiredBy(intent: string, field: string) {
  return (issue: unknown): string | undefined =>
    (issue as RawObjectiveIssue).code === 'invalid_type'
      ? `The ${intent} intent requires ${field}.`
      : undefined;
}

/**
 * The message a model gets when it puts an id where a referent belongs.
 *
 * WHY it is worth spelling out: `target` names what the *editor* has selected, never a
 * thing the model can name, and Zod's own words for that — `target: Invalid input:
 * expected "this"` — read as a typo rather than as a category error. Run `137d8fd0` sent
 * `target: "music_1"`, `"music_bed"`, `"layer_audio_5"` and gave up after ten refusals,
 * never once being told that an id is the wrong KIND of thing here or which tool does
 * take one.
 */
const TARGET_REFERENTS = ['this', 'these', 'playhead'] as const;

const targetHint = (input: unknown): string | undefined =>
  typeof input === 'string' &&
  !TARGET_REFERENTS.includes(input as (typeof TARGET_REFERENTS)[number])
    ? `target names what is selected in the editor — "this" (the selected clip), "these" ` +
      `(all selected clips) or "playhead" (the clip under the playhead). It is never a clip ` +
      `or track id, so "${input}" cannot be resolved. To act on a clip you can name, call ` +
      `adjust_audio with its clipId — get_timeline lists them.`
    : undefined;

/** Every intent may name what it acts on; ducking derives its tracks and takes no referent. */
const targetField = z
  .enum(TARGET_REFERENTS, { error: (issue) => targetHint(issue.input) })
  .default('this')
  .describe(
    'What the editor has selected: "this" (the selected clip), "these" (all selected clips), ' +
      'or "playhead" (the clip under the playhead). Never a clip or track id — use ' +
      'adjust_audio when you have an id.',
  );

/** Ducking derives its own targets, so its referent is fixed — same wrong-kind message. */
// Ducking derives its targets from roles or the selection, never from a referent, so a
// `target` here carries no information. It used to be pinned to the literal `this`, and
// a model that wrote `playhead` — the value every OTHER intent accepts — was refused for
// it: run `cc907070` lost a ducking turn to `expected "this" — received "playhead"`.
// Accepted and ignored; the objective's own intent says what happens.
const duckTargetField = z
  .enum(TARGET_REFERENTS, { error: (issue) => targetHint(issue.input) })
  .default('this');

const reductionField = z
  .number()
  .finite()
  .min(0)
  .max(60)
  .optional()
  .describe('How far the bed drops, in positive dB (default 12).');

/**
 * Set the fader: static gain, frame-based fades, mute, or peak normalize. At least
 * one of them, because "level this clip" with no setting is not an instruction.
 */
const LevelObjectiveSchema = z
  .strictObject(
    {
      intent: z.literal('level'),
      target: targetField,
      gainDb: z
        .number()
        .finite()
        .min(AUDIO_PARAMETER_CONTRACTS.gainDb.min)
        .max(AUDIO_PARAMETER_CONTRACTS.gainDb.max)
        .optional()
        .describe('Static level in dB.'),
      fadeInFrames: z.number().int().min(0).optional().describe('Fade-in length in frames.'),
      fadeOutFrames: z.number().int().min(0).optional().describe('Fade-out length in frames.'),
      fadeCurve: z.enum(AUDIO_FADE_CURVES).optional().describe('Shape of both fades.'),
      muted: z.boolean().optional(),
      normalize: z.boolean().optional().describe('Peak-normalize the clip.'),
    },
    { error: foreignKeyError('level') },
  )
  .refine(
    (value) =>
      value.gainDb !== undefined ||
      value.fadeInFrames !== undefined ||
      value.fadeOutFrames !== undefined ||
      value.fadeCurve !== undefined ||
      value.muted !== undefined ||
      value.normalize !== undefined,
    { message: 'Level requires an explicit gain, fade, mute, or normalize setting.' },
  );

/** Clean up a recording. Present bands replace the whole curve; an empty list is refused. */
const EqObjectiveSchema = z
  .strictObject(
    {
      intent: z.literal('eq'),
      target: targetField,
      eqBands: z
        .array(AudioEqBandInputSchema, { error: requiredBy('eq', 'eqBands') })
        .min(1)
        .max(AUDIO_EQ_MAX_BANDS)
        .describe('The whole EQ curve. Replaces any curve already on the clip.'),
    },
    { error: foreignKeyError('eq') },
  )
  .superRefine((value, context) => {
    for (const band of value.eqBands) {
      const needsGain = band.kind === 'peaking' || band.kind.endsWith('shelf');
      if (needsGain === (band.gainDb === undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['eqBands'],
          message: needsGain
            ? `A ${band.kind} band requires gainDb.`
            : `A ${band.kind} band cuts a range outright and takes no gainDb.`,
        });
      }
    }
  });

/** Even out a performance. */
const CompressObjectiveSchema = z.strictObject(
  {
    intent: z.literal('compress'),
    target: targetField,
    dynamics: AudioDynamicsInputSchema.describe('Compressor settings.'),
  },
  { error: foreignKeyError('compress') },
);

/**
 * Ride the level over time. The lane is the level, so it takes no static gain —
 * accepting both would make one of them a silent no-op.
 */
const AutomateGainObjectiveSchema = z
  .strictObject(
    {
      intent: z.literal('automate_gain'),
      target: targetField,
      automationPoints: z
        .array(AudioAutomationPointInputSchema, {
          error: requiredBy('automate_gain', 'automationPoints'),
        })
        .max(64)
        .describe('The whole gain lane, in clip-relative frames. An empty list clears it.'),
    },
    { error: foreignKeyError('automate_gain') },
  )
  .superRefine((value, context) => {
    const lane = value.automationPoints;
    if (lane.length === 0) return;
    if (lane.length < 2) {
      context.addIssue({
        code: 'custom',
        path: ['automationPoints'],
        message: 'An automation lane needs at least 2 points; one point is a static level.',
      });
    }
    for (let index = 1; index < lane.length; index += 1) {
      if (lane[index]!.frame <= lane[index - 1]!.frame) {
        context.addIssue({
          code: 'custom',
          path: ['automationPoints', index, 'frame'],
          message: 'Automation frames must strictly increase.',
        });
      }
    }
  });

/** Duck the primary selected bed under the one other selected track. */
const DuckSelectionObjectiveSchema = z.strictObject(
  {
    intent: z.literal('duck_selection'),
    /** Fixed: the bed and sidechain come from the selection, never from a referent. */
    target: duckTargetField,
    reductionDb: reductionField,
  },
  { error: foreignKeyError('duck_selection') },
);

/** Duck one authored role under another — "the music under the dialogue". */
const DuckRolesObjectiveSchema = z
  .strictObject(
    {
      intent: z.literal('duck_roles'),
      /** Fixed: the bed and sidechain come from the authored roles, never from a referent. */
      target: duckTargetField,
      bedRole: AudioRoleSchema.describe('The role that gets quieter (the bed).'),
      sidechainRole: AudioRoleSchema.describe('The role it makes way for (the trigger).'),
      reductionDb: reductionField,
    },
    { error: foreignKeyError('duck_roles') },
  )
  .refine((value) => value.bedRole !== value.sidechainRole, {
    path: ['sidechainRole'],
    // Ducking a role under itself is self-duck by construction.
    message: 'A role cannot duck under itself.',
  });

/**
 * One intent, one family of settings — expressed as a union so the schema the model
 * reads carries the rule.
 *
 * This was a single flat object whose fields were all optional, with the families
 * enforced only in a refinement: the JSON Schema advertised every setting as legal
 * for every intent, so a model that filled in what looked useful got a wall of
 * refusals it could not have predicted, and a repair pass would author the same
 * call again. The union makes an illegal combination unrepresentable up front.
 */
export const AudioObjectiveSchema = z.discriminatedUnion('intent', [
  LevelObjectiveSchema,
  EqObjectiveSchema,
  CompressObjectiveSchema,
  AutomateGainObjectiveSchema,
  DuckSelectionObjectiveSchema,
  DuckRolesObjectiveSchema,
]);

/**
 * The resolved objective as the controller reads it: one flat shape covering every
 * variant, so resolution can ask "was a gain authored" without narrowing first.
 * `ParsedAudioObjective` below asserts the union stays assignable to it.
 */
export interface AudioObjective {
  readonly intent: 'level' | 'duck_selection' | 'duck_roles' | 'eq' | 'compress' | 'automate_gain';
  readonly target: 'this' | 'these' | 'playhead';
  readonly bedRole?: z.infer<typeof AudioRoleSchema> | undefined;
  readonly sidechainRole?: z.infer<typeof AudioRoleSchema> | undefined;
  readonly gainDb?: number | undefined;
  readonly fadeInFrames?: number | undefined;
  readonly fadeOutFrames?: number | undefined;
  readonly fadeCurve?: (typeof AUDIO_FADE_CURVES)[number] | undefined;
  readonly muted?: boolean | undefined;
  readonly normalize?: boolean | undefined;
  readonly reductionDb?: number | undefined;
  readonly eqBands?: readonly z.infer<typeof AudioEqBandInputSchema>[] | undefined;
  readonly dynamics?: z.infer<typeof AudioDynamicsInputSchema> | undefined;
  readonly automationPoints?:
    | readonly z.infer<typeof AudioAutomationPointInputSchema>[]
    | undefined;
}

/**
 * Compile-time guard: every union variant must satisfy the flat controller shape.
 *
 * Resolves to the parsed type when the union is assignable to {@link AudioObjective},
 * or `never` when it is not — but a conditional type only ever gets evaluated where
 * something actually consumes it. `domain-tools/professional-audio.ts` types its
 * parsed objective as `ParsedAudioObjective` (not the schema's own inferred type) for
 * exactly this: an `AudioObjectiveSchema` variant that gains a field `AudioObjective`
 * doesn't have fails that assignment, not silently compiles as if nothing changed.
 */
export type ParsedAudioObjective =
  z.infer<typeof AudioObjectiveSchema> extends AudioObjective
    ? z.infer<typeof AudioObjectiveSchema>
    : never;

export type AudioControllerRejectionCode =
  | 'target_unresolved'
  | 'target_ambiguous'
  | 'no_audio'
  /** No track carries the requested bed role — labelling is the fix, not guessing. */
  | 'bed_role_unlabelled'
  | 'sidechain_role_unlabelled'
  | 'sidechain_unresolved'
  | 'sidechain_ambiguous';

export type AudioControllerResult =
  | {
      readonly status: 'resolved';
      readonly objective: AudioObjective;
      readonly commands: readonly AudioCommand[];
      readonly evidence: readonly TargetEvidence[];
      readonly facts: readonly {
        readonly name: string;
        readonly value: string | number | boolean;
      }[];
    }
  | {
      readonly status: 'rejected';
      readonly objective: AudioObjective;
      readonly code: AudioControllerRejectionCode;
      readonly detail: string;
      readonly facts: readonly {
        readonly name: string;
        readonly value: string | number | boolean;
      }[];
    };

export interface ResolveAudioObjectiveInput {
  readonly project: Project;
  readonly projectRevision?: number;
  readonly interaction: EditorInteractionContext;
  readonly objective: AudioObjective;
}

function rejected(
  objective: AudioObjective,
  code: AudioControllerRejectionCode,
  detail: string,
): Extract<AudioControllerResult, { status: 'rejected' }> {
  log.warn('Audio objective rejected', { intent: objective.intent, code });
  return { status: 'rejected', objective, code, detail, facts: [] };
}

function clipLookup(project: Project) {
  return new Map(
    project.timeline.tracks.flatMap((track) =>
      track.clips.map((clip) => [clip.id, { clip, track }] as const),
    ),
  );
}

function audioCapable(project: Project, clipId: string): boolean {
  const found = clipLookup(project).get(clipId);
  const asset = found
    ? project.assets.find((candidate) => candidate.id === found.clip.assetId)
    : undefined;
  return (
    found !== undefined &&
    asset !== undefined &&
    asset.kind !== 'image' &&
    found.track.type !== 'caption' &&
    found.track.type !== 'effect'
  );
}

/**
 * The settings one objective authors, given the frame rate its times are in.
 *
 * Frames convert to seconds here and nowhere else: the model authors frames, the
 * compiler stores seconds, and a second conversion site is a second rounding rule.
 */
function chainSettings(
  objective: AudioObjective,
  rate: { readonly numerator: number; readonly denominator: number },
): MixClipAudioSettings {
  // Absent optionals are dropped rather than passed as `undefined`: the contracts
  // compile with `exactOptionalPropertyTypes`, where the two are not the same, and
  // "no Q authored" must reach the renderer as absence, not as an undefined value.
  if (objective.intent === 'eq') {
    return {
      eq: {
        bands: (objective.eqBands ?? []).map((band) => ({
          kind: band.kind,
          frequencyHz: band.frequencyHz,
          ...(band.gainDb === undefined ? {} : { gainDb: band.gainDb }),
          ...(band.q === undefined ? {} : { q: band.q }),
        })),
      },
    };
  }
  if (objective.intent === 'compress') {
    const dynamics = objective.dynamics!;
    return {
      dynamics: {
        thresholdDb: dynamics.thresholdDb,
        ratio: dynamics.ratio,
        attackMs: dynamics.attackMs,
        releaseMs: dynamics.releaseMs,
        ...(dynamics.makeupGainDb === undefined ? {} : { makeupGainDb: dynamics.makeupGainDb }),
      },
    };
  }
  const frameSeconds = rate.denominator / rate.numerator;
  return {
    automation: {
      property: 'gainDb',
      points: (objective.automationPoints ?? []).map((point) => ({
        timeSeconds: point.frame * frameSeconds,
        value: point.gainDb,
        ...(point.easing === undefined ? {} : { easing: point.easing }),
      })),
    },
  };
}

function levelSettings(objective: AudioObjective): MixClipAudioSettings {
  return {
    ...(objective.gainDb !== undefined ? { gainDb: objective.gainDb } : {}),
    ...(objective.fadeInFrames !== undefined ? { fadeInFrames: objective.fadeInFrames } : {}),
    ...(objective.fadeOutFrames !== undefined ? { fadeOutFrames: objective.fadeOutFrames } : {}),
    ...(objective.fadeCurve !== undefined ? { fadeCurve: objective.fadeCurve } : {}),
    ...(objective.muted !== undefined ? { muted: objective.muted } : {}),
    ...(objective.normalize !== undefined ? { normalize: objective.normalize } : {}),
  };
}

function resolveLevel(input: ResolveAudioObjectiveInput): AudioControllerResult {
  const resolution = resolveEditorTarget(
    input.project,
    input.interaction,
    { kind: 'clips', referent: input.objective.target },
    { projectRevision: input.projectRevision ?? input.interaction.projectRevision },
  );
  if (resolution.status !== 'resolved') {
    const detail =
      resolution.status === 'ambiguous'
        ? `${resolution.reason}: ${resolution.candidateIds.join(', ')}`
        : `${resolution.reason}: ${resolution.detail}`;
    return rejected(
      input.objective,
      resolution.status === 'ambiguous' ? 'target_ambiguous' : 'target_unresolved',
      detail,
    );
  }
  if (resolution.target.kind !== 'clips') {
    return rejected(input.objective, 'target_unresolved', 'Audio target did not resolve to clips.');
  }
  const invalid = resolution.target.clipIds.filter(
    (clipId) => !audioCapable(input.project, clipId),
  );
  if (invalid.length > 0) {
    return rejected(
      input.objective,
      'no_audio',
      `Clips have no audio stream: ${invalid.join(', ')}.`,
    );
  }
  const rate = rationalFrameRate(input.project.fps);
  const settings =
    input.objective.intent === 'level'
      ? levelSettings(input.objective)
      : chainSettings(input.objective, rate);
  return {
    status: 'resolved',
    objective: input.objective,
    commands: resolution.target.clipIds.map((clipId) => ({
      type: 'mix_clip_audio',
      timelineRevision: input.project.timeline.revision ?? 0,
      clipId,
      rate,
      settings,
    })),
    evidence: [resolution.evidence],
    facts: [
      { name: 'clipCount', value: resolution.target.clipIds.length },
      { name: 'targetEvidence', value: resolution.evidence },
      ...(input.objective.eqBands
        ? [{ name: 'eqBands', value: input.objective.eqBands.length }]
        : []),
      ...(input.objective.dynamics
        ? [{ name: 'compressorRatio', value: input.objective.dynamics.ratio }]
        : []),
      ...(input.objective.automationPoints
        ? [{ name: 'automationPoints', value: input.objective.automationPoints.length }]
        : []),
    ],
  };
}

function resolveDuckSelection(input: ResolveAudioObjectiveInput): AudioControllerResult {
  const primaryId = input.interaction.selection.primaryClipId;
  if (!primaryId) {
    return rejected(
      input.objective,
      'sidechain_unresolved',
      'Select a primary bed clip and at least one clip on its sidechain track.',
    );
  }
  const clips = clipLookup(input.project);
  const primary = clips.get(primaryId);
  if (!primary || !audioCapable(input.project, primaryId)) {
    return rejected(input.objective, 'no_audio', 'The primary selected clip has no audio stream.');
  }
  const selected = input.interaction.selection.clipIds
    .map((clipId) => clips.get(clipId))
    .filter((found): found is NonNullable<typeof found> => found !== undefined);
  const sidechainTrackIds = [
    ...new Set(
      selected
        .filter((found) => found.track.id !== primary.track.id)
        .filter((found) => audioCapable(input.project, found.clip.id))
        .map((found) => found.track.id),
    ),
  ];
  if (sidechainTrackIds.length === 0) {
    return rejected(
      input.objective,
      'sidechain_unresolved',
      'Select a clip on exactly one other audio-capable track to supply the sidechain.',
    );
  }
  if (sidechainTrackIds.length > 1) {
    return rejected(
      input.objective,
      'sidechain_ambiguous',
      `More than one selected sidechain track is possible: ${sidechainTrackIds.join(', ')}.`,
    );
  }
  const bedClipIds = selected
    .filter((found) => found.track.id === primary.track.id)
    .map((found) => found.clip.id);
  const rate = rationalFrameRate(input.project.fps);
  const sidechainTrackId = sidechainTrackIds[0]!;
  const duckAmountDb = -(input.objective.reductionDb ?? 12);
  log.action('Audio duck selection resolved', {
    bedTrackId: primary.track.id,
    sidechainTrackId,
    clipCount: bedClipIds.length,
  });
  return {
    status: 'resolved',
    objective: input.objective,
    commands: bedClipIds.map((clipId) => ({
      type: 'mix_clip_audio',
      timelineRevision: input.project.timeline.revision ?? 0,
      clipId,
      rate,
      settings: { duckUnderTrackId: sidechainTrackId, duckAmountDb },
    })),
    evidence: ['selection', 'selected_track'],
    facts: [
      { name: 'bedTrackId', value: primary.track.id },
      { name: 'sidechainTrackId', value: sidechainTrackId },
      { name: 'reductionDb', value: -duckAmountDb },
      { name: 'bedClipCount', value: bedClipIds.length },
    ],
  };
}

/**
 * Duck every clip of one authored role under another — "duck the music under the dialogue".
 *
 * Roles come from {@link AudioRoleSchema} on the track, which an editor authored. An unlabelled
 * project cannot answer this, and the fix is a label rather than a guess: a lane named "music"
 * routinely holds a voice-over, and ducking the wrong bed is silent in the timeline (ADR 0111).
 */
function resolveDuckRoles(input: ResolveAudioObjectiveInput): AudioControllerResult {
  const { bedRole, sidechainRole } = input.objective;
  if (!bedRole || !sidechainRole) {
    return rejected(input.objective, 'sidechain_unresolved', 'duck_roles needs both roles.');
  }
  // A VIDEO track carries its clips' own sound and takes a role like an audio track does
  // (see `set_track_flags`): a GoPro's wind, a camera's recorded voice. Run `cc907070`
  // was asked to duck the wind under music and could not, because the wind lived on the
  // picture and only audio tracks were consulted.
  const audioTracks = input.project.timeline.tracks.filter(
    (track) => track.type === 'audio' || track.type === 'video',
  );
  const bedTracks = audioTracks.filter((track) => track.role === bedRole);
  const sidechainTracks = audioTracks.filter((track) => track.role === sidechainRole);
  // "Label the track you mean" named a move that did not exist. `Track.role` shipped
  // readable and unwritable: `add_layer` set it at creation and NOTHING else could, so on
  // any project whose audio tracks already existed this refusal was a dead end. Run
  // `137d8fd0` hit it twice and gave up on the editor's explicit ducking instruction.
  // `set_track_flags` can write it now, so the sentence names the call.
  const labelWith = (role: string): string =>
    `Label it first: set_track_flags with trackId and role: "${role}". Roles are never ` +
    `inferred from track names — a lane called "Music 2" routinely holds a voice-over. ` +
    'A video track counts when its clips carry the sound you mean.' +
    (audioTracks.length > 0
      ? ` Tracks that carry sound here: ${audioTracks.map((track) => track.id).join(', ')}.`
      : ' This project has no track carrying sound yet.');
  if (bedTracks.length === 0) {
    return rejected(
      input.objective,
      'bed_role_unlabelled',
      `No track is labelled ${bedRole}. ${labelWith(bedRole)}`,
    );
  }
  if (sidechainTracks.length === 0) {
    return rejected(
      input.objective,
      'sidechain_role_unlabelled',
      `No track is labelled ${sidechainRole}. ${labelWith(sidechainRole)}`,
    );
  }
  if (sidechainTracks.length > 1) {
    // The renderer ducks under exactly one trigger track; picking one silently would be a guess.
    return rejected(
      input.objective,
      'sidechain_ambiguous',
      `More than one track is labelled ${sidechainRole}: ${sidechainTracks
        .map((track) => track.id)
        .join(', ')}. Ducking can follow only one trigger track.`,
    );
  }
  const sidechainTrackId = sidechainTracks[0]!.id;
  const bedClipIds = bedTracks.flatMap((track) =>
    track.clips.filter((clip) => audioCapable(input.project, clip.id)).map((clip) => clip.id),
  );
  if (bedClipIds.length === 0) {
    return rejected(
      input.objective,
      'no_audio',
      `No clip on the ${bedRole} track carries an audio stream.`,
    );
  }
  const duckAmountDb = -(input.objective.reductionDb ?? 12);
  log.action('Audio duck roles resolved', {
    bedRole,
    sidechainRole,
    sidechainTrackId,
    clipCount: bedClipIds.length,
  });
  return {
    status: 'resolved',
    objective: input.objective,
    commands: bedClipIds.map((clipId) => ({
      type: 'mix_clip_audio',
      timelineRevision: input.project.timeline.revision ?? 0,
      clipId,
      rate: rationalFrameRate(input.project.fps),
      settings: { duckUnderTrackId: sidechainTrackId, duckAmountDb },
    })),
    evidence: ['track_role'],
    facts: [
      { name: 'bedRole', value: bedRole },
      { name: 'sidechainRole', value: sidechainRole },
      { name: 'bedTrackIds', value: bedTracks.map((track) => track.id).join(', ') },
      { name: 'sidechainTrackId', value: sidechainTrackId },
      { name: 'reductionDb', value: -duckAmountDb },
      { name: 'bedClipCount', value: bedClipIds.length },
    ],
  };
}

/** Resolve a level, selection-authored, or role-authored duck without model-supplied ids. */
export function resolveAudioObjective(input: ResolveAudioObjectiveInput): AudioControllerResult {
  if (input.objective.intent === 'duck_roles') return resolveDuckRoles(input);
  if (input.objective.intent === 'duck_selection') return resolveDuckSelection(input);
  // Level, EQ, compression, and automation all address the same thing — the clips
  // the editor has in hand — and differ only in what they write onto them.
  return resolveLevel(input);
}
