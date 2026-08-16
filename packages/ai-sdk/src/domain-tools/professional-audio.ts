/** Controller-backed professional clip mixing and selection-authored sidechain ducking. */
import { z } from 'zod/v4';
import { compileAudioCommand } from '@framepilot/editor-core';
import {
  AudioObjectiveSchema,
  resolveAudioObjective,
  type ParsedAudioObjective,
} from '../controllers/audio-controller.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { validateProfessionalOperationBatch } from './professional-batch.js';

/**
 * The objective is a union — one variant per intent — so the schema the model reads
 * carries the rule that each intent owns exactly one family of settings.
 *
 * Zod emits that as a bare `anyOf`; it is republished here as a `oneOf` under an
 * object type, matching `map_time`'s contracted shape. Every registered tool
 * advertises `type: 'object'` (tool-registry shape test), and the variants are
 * mutually exclusive by discriminator, so exactly one can ever match.
 */
function jsonSchema(schema: z.ZodDiscriminatedUnion): Record<string, unknown> {
  const { $schema: _dialect, anyOf, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return { type: 'object', ...rest, oneOf: anyOf };
}

function buildProfessionalAudio(rawArgs: unknown, ctx: ToolContext) {
  // Typed via `ParsedAudioObjective`, not inferred: that's the compile-time guard
  // that the union stays assignable to `AudioObjective` actually firing — an
  // unused type alias never gets evaluated by the compiler against anything.
  const objective: ParsedAudioObjective = AudioObjectiveSchema.parse(rawArgs);
  if (!ctx.interaction) {
    throw new Error('professional_audio requires a live editor interaction snapshot.');
  }
  const resolution = resolveAudioObjective({
    project: ctx.project,
    ...(ctx.projectRevision === undefined ? {} : { projectRevision: ctx.projectRevision }),
    interaction: ctx.interaction,
    objective,
  });
  if (resolution.status === 'rejected') {
    throw new Error(
      `professional_audio controller rejected ${resolution.code}: ${resolution.detail}`,
    );
  }
  const operations = resolution.commands.flatMap((command) => {
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
    'Mix the selected audio: level (gain, frame-based fades, mute, peak normalize), eq (shelves, peaks, and high/low-pass to clean up a recording), compress (even out a performance), automate_gain (ride the level over time), or duck one source under another. Use duck_roles with bedRole/sidechainRole for "duck the music under the dialogue" — it uses the roles the editor authored on the tracks. Use duck_selection when tracks carry no roles: select the bed clip last so it is primary, plus a clip on the sidechain track. An automation lane is the level over time and replaces the static gain, so author one or the other, not both. Roles and ids come from live editor state and authored labels, never from track or file names.',
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
