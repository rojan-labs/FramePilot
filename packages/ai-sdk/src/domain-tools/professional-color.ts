/** Controller-backed professional primary color-correction tool. */
import { z } from 'zod/v4';
import { compileColorCommand } from '@framepilot/editor-core';
import { ColorObjectiveSchema, parseColorObjective } from '../controllers/color-controller.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { validateProfessionalOperationBatch } from './professional-batch.js';
import { COLOR_SPECIALIST, runSpecialist, sliceOf } from '../specialists/index.js';

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  return parameters;
}

function buildProfessionalColor(rawArgs: unknown, ctx: ToolContext) {
  const objective = parseColorObjective(rawArgs);
  if (!ctx.interaction) {
    throw new Error('professional_color requires a live editor interaction snapshot.');
  }
  const resolution = runSpecialist(COLOR_SPECIALIST, {
    task: 'professional_color',
    context: sliceOf(COLOR_SPECIALIST, ctx),
    constraints: {},
    inputs: objective,
  });
  const [failure] = resolution.errors;
  if (failure) {
    throw new Error(`professional_color controller rejected ${failure.code}: ${failure.detail}`);
  }
  const operations = resolution.outputs.commands.flatMap((command) => {
    const result = compileColorCommand({
      timeline: ctx.project.timeline,
      assets: ctx.project.assets,
      command,
    });
    if (result.status === 'rejected') {
      throw new Error(`professional_color compiler rejected ${result.code}: ${result.detail}`);
    }
    return [...result.patch.operations];
  });
  return validateProfessionalOperationBatch(ctx, 'professional_color', operations);
}

/** Model supplies bounded correction values; selection state supplies the shots. */
export const PROFESSIONAL_COLOR_TOOL: ToolSpec = {
  name: 'professional_color',
  description:
    'Apply explicit bounded primary corrections, or match this shot from two trusted measure_color evidence handles. Uses one canonical correction node per clip and preserves separate creative LUT/look layers. Matching derives conservative exposure, contrast, saturation, temperature, and tint from revision-bound unobstructed measurements; stale, incomplete, wrong-clip, or occluded evidence fails closed. Set groupShots to grade every shot from the same camera file at once — "match all of camera B" — instead of one clip. Set preserveSkin on a match to hold faces where they are: the white-balance part of the match is scaled back until skin warmth stays inside tolerance, and a shot with too little skin to read says so rather than pretending nothing moved.',
  version: '3',
  capabilities: ['color', 'professional-editing'],
  permissions: ['write'],
  cost: 'low',
  latency: 'fast',
  hostUiOnly: true,
  mutates: true,
  available: true,
  kind: 'mutate',
  parameters: jsonSchema(ColorObjectiveSchema),
  parse: (rawArgs) => parseColorObjective(rawArgs),
  buildOps: (rawArgs, ctx) => buildProfessionalColor(rawArgs, ctx),
};
