/** Controller-backed professional clip mixing and selection-authored sidechain ducking. */
import { z } from 'zod/v4';
import { compileAudioCommand } from '@framepilot/editor-core';
import {
  AudioObjectiveSchema,
  type ParsedAudioObjective,
} from '../controllers/audio-controller.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { validateProfessionalOperationBatch } from './professional-batch.js';
import { AUDIO_SPECIALIST, runSpecialist, sliceOf } from '../specialists/index.js';

/** One variant's JSON Schema, as `z.toJSONSchema` emits it inside `anyOf`. */
interface ObjectiveVariantSchema {
  readonly properties?: Record<string, { readonly const?: string }>;
}

/**
 * Union every variant's non-discriminator properties into one flat property bag.
 *
 * `target` is the only name more than one variant declares differently: every
 * non-duck variant advertises the full `this|these|playhead` enum, and the two duck
 * variants narrow it to a fixed `this` (ducking derives its targets from roles/
 * selection, never a referent — see `DuckSelectionObjectiveSchema`/
 * `DuckRolesObjectiveSchema`). `LevelObjectiveSchema` is first in
 * `AudioObjectiveSchema`'s variant list, so first-seen-wins keeps the wider
 * declaration; every other shared name (`reductionDb`) is declared identically by
 * every variant that has it, so first-seen is also just the only declaration.
 */
function mergedProperties(variants: readonly ObjectiveVariantSchema[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const variant of variants) {
    for (const [name, propertySchema] of Object.entries(variant.properties ?? {})) {
      if (name === 'intent' || name in merged) continue;
      merged[name] = propertySchema;
    }
  }
  return merged;
}

/** The `intent` discriminator's values, read off each variant's `const`. */
function intentEnum(variants: readonly ObjectiveVariantSchema[]): string[] {
  return variants
    .map((variant) => variant.properties?.intent?.const)
    .filter((value): value is string => typeof value === 'string');
}

/**
 * The objective is a union — one variant per intent — so each intent owns exactly one
 * family of settings, and the runtime enforcement (`AudioObjectiveSchema.parse`,
 * unchanged) is exactly that strict.
 *
 * The JSON Schema the model reads cannot carry that as a top-level `oneOf`: Anthropic's
 * Messages API rejects `oneOf`/`anyOf`/`allOf` directly under a tool's `input_schema`.
 * So this flattens the six variants into one object schema — every field from every
 * intent, all optional except the `intent` enum itself — and relies on the tool's rich
 * `description` (which fields belong to which intent) plus each field's own
 * `.describe()` text to carry the "pick one intent's fields" rule instead. A call that
 * mixes intents, or omits a field its intent requires, is still refused at parse time
 * with the same `foreignKeyError`/`requiredBy` messages as before — only the advertised
 * shape got less strict, never the actual validation.
 */
function jsonSchema(schema: z.ZodDiscriminatedUnion): Record<string, unknown> {
  const generated = z.toJSONSchema(schema) as { anyOf?: ObjectiveVariantSchema[] };
  const variants = generated.anyOf ?? [];
  return {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: intentEnum(variants),
        description:
          "Which mixing operation to perform. Only the fields that belong to this intent are read — see the tool description for the field list per intent — so provide exactly one intent's fields, never a mix.",
      },
      ...mergedProperties(variants),
    },
    required: ['intent'],
    additionalProperties: false,
  };
}

function buildProfessionalAudio(rawArgs: unknown, ctx: ToolContext) {
  // Typed via `ParsedAudioObjective`, not inferred: that's the compile-time guard
  // that the union stays assignable to `AudioObjective` actually firing — an
  // unused type alias never gets evaluated by the compiler against anything.
  const objective: ParsedAudioObjective = AudioObjectiveSchema.parse(rawArgs);
  if (!ctx.interaction) {
    throw new Error('professional_audio requires a live editor interaction snapshot.');
  }
  const resolution = runSpecialist(AUDIO_SPECIALIST, {
    task: 'professional_audio',
    context: sliceOf(AUDIO_SPECIALIST, ctx),
    constraints: {},
    inputs: objective,
  });
  const [failure] = resolution.errors;
  if (failure) {
    throw new Error(`professional_audio controller rejected ${failure.code}: ${failure.detail}`);
  }
  const operations = resolution.outputs.commands.flatMap((command) => {
    const result = compileAudioCommand({
      timeline: ctx.project.timeline,
      assets: ctx.project.assets,
      command,
    });
    if (result.status === 'rejected') {
      throw new Error(`professional_audio compiler rejected ${result.code}: ${result.detail}`);
    }
    return [...result.patch.operations];
  });
  return validateProfessionalOperationBatch(ctx, 'professional_audio', operations);
}

/** Resolves clip and sidechain targets from editor state; no model-authored ids are accepted. */
export const PROFESSIONAL_AUDIO_TOOL: ToolSpec = {
  name: 'professional_audio',
  description:
    'Mix the selected audio: level (gain, frame-based fades, mute, peak normalize), eq (shelves, peaks, and high/low-pass to clean up a recording), compress (even out a performance), automate_gain (ride the level over time), or duck one source under another. Use duck_roles with bedRole/sidechainRole for "duck the music under the dialogue" — it uses the roles authored on the tracks with set_track_flags; a video track takes a role too when its clips carry the sound (camera audio, wind), so "duck the wind under the music" is bedRole music, sidechainRole sfx on the VIDEO track. Use duck_selection when tracks carry no roles: select the bed clip last so it is primary, plus a clip on the sidechain track. An automation lane is the level over time and replaces the static gain, so author one or the other, not both. Roles and ids come from live editor state and authored labels, never from track or file names.',
  version: '1',
  capabilities: ['audio', 'professional-editing'],
  permissions: ['write'],
  cost: 'low',
  latency: 'fast',
  hostUiOnly: true,
  mutates: true,
  available: true,
  kind: 'mutate',
  parameters: jsonSchema(AudioObjectiveSchema),
  parse: (rawArgs) => AudioObjectiveSchema.parse(rawArgs),
  buildOps: (rawArgs, ctx) => buildProfessionalAudio(rawArgs, ctx),
};
