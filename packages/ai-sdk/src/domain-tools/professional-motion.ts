/** Controller-backed professional motion editing tool. */
import { z } from 'zod/v4';
import { compileMotionCommand } from '@framepilot/editor-core';
import { MotionObjectiveSchema } from '../controllers/motion-controller.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { validateProfessionalOperationBatch } from './professional-batch.js';
import { MOTION_SPECIALIST, runSpecialist, sliceOf } from '../specialists/index.js';

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  return parameters;
}

function buildProfessionalMotion(rawArgs: unknown, ctx: ToolContext) {
  const objective = MotionObjectiveSchema.parse(rawArgs);
  if (!ctx.interaction) {
    throw new Error('professional_motion requires a live editor interaction snapshot.');
  }
  const resolution = runSpecialist(MOTION_SPECIALIST, {
    task: 'professional_motion',
    context: sliceOf(MOTION_SPECIALIST, ctx),
    constraints: {},
    inputs: objective,
  });
  const [failure] = resolution.errors;
  if (failure) {
    throw new Error(`professional_motion controller rejected ${failure.code}: ${failure.detail}`);
  }
  const operations = resolution.outputs.commands.flatMap((command) => {
    const result = compileMotionCommand({
      timeline: ctx.project.timeline,
      assets: ctx.project.assets,
      command,
    });
    if (result.status === 'rejected') {
      throw new Error(`professional_motion compiler rejected ${result.code}: ${result.detail}`);
    }
    return [...result.patch.operations];
  });
  return validateProfessionalOperationBatch(ctx, 'professional_motion', operations);
}

/** Model supplies an editorial motion objective, never raw keyframe choreography. */
export const PROFESSIONAL_MOTION_TOOL: ToolSpec = {
  name: 'professional_motion',
  description:
    'Animate the selected clip/property to a target value or continue its established trajectory using clip-frame timing and deterministic easing. The live selection/playhead resolves the target; property and canvas-cover constraints fail closed. Supply duration in frames, not raw keyframe arrays.',
  version: '1',
  capabilities: ['motion', 'professional-editing'],
  permissions: ['write'],
  cost: 'low',
  latency: 'fast',
  hostUiOnly: true,
  mutates: true,
  available: true,
  kind: 'mutate',
  parameters: jsonSchema(MotionObjectiveSchema),
  parse: (rawArgs) => MotionObjectiveSchema.parse(rawArgs),
  buildOps: (rawArgs, ctx) => buildProfessionalMotion(rawArgs, ctx),
};
