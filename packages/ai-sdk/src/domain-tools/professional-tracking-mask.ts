/** Controller-backed manual tracking of an existing bounded mask. */
import { z } from 'zod/v4';
import { compileTrackingCommand } from '@framepilot/editor-core';
import { TrackingMaskObjectiveSchema } from '../controllers/tracking-mask-controller.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { validateProfessionalOperationBatch } from './professional-batch.js';
import { TRACKING_MASK_SPECIALIST, runSpecialist, sliceOf } from '../specialists/index.js';

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  return parameters;
}

function buildProfessionalTrackingMask(rawArgs: unknown, ctx: ToolContext) {
  const objective = TrackingMaskObjectiveSchema.parse(rawArgs);
  if (!ctx.interaction) {
    throw new Error('professional_tracking_mask requires a live editor interaction snapshot.');
  }
  const resolution = runSpecialist(TRACKING_MASK_SPECIALIST, {
    task: 'professional_tracking_mask',
    context: sliceOf(TRACKING_MASK_SPECIALIST, ctx),
    constraints: {},
    inputs: objective,
  });
  const [failure] = resolution.errors;
  if (failure) {
    throw new Error(
      `professional_tracking_mask controller rejected ${failure.code}: ${failure.detail}`,
    );
  }
  const operations = resolution.outputs.commands.flatMap((command) => {
    const result = compileTrackingCommand({
      timeline: ctx.project.timeline,
      assets: ctx.project.assets,
      command,
    });
    if (result.status === 'rejected') {
      throw new Error(
        `professional_tracking_mask compiler rejected ${result.code}: ${result.detail}`,
      );
    }
    return [...result.patch.operations];
  });
  return validateProfessionalOperationBatch(ctx, 'professional_tracking_mask', operations);
}

/** Uses user-authored mask geometry; never invents a region or pretends automatic CV exists. */
export const PROFESSIONAL_TRACKING_MASK_TOOL: ToolSpec = {
  name: 'professional_tracking_mask',
  description:
    'Track the existing bounded rectangle/ellipse mask on the selected shot using deterministic manual corrections. The mask supplies the region and motion; never guess coordinates. Automatic face/object/planar/segmentation tracking is unavailable until a real CV engine is installed.',
  version: '1',
  capabilities: ['tracking', 'masking', 'professional-editing'],
  permissions: ['write'],
  cost: 'low',
  latency: 'fast',
  hostUiOnly: true,
  mutates: true,
  available: true,
  kind: 'mutate',
  parameters: jsonSchema(TrackingMaskObjectiveSchema),
  parse: (rawArgs) => TrackingMaskObjectiveSchema.parse(rawArgs),
  buildOps: (rawArgs, ctx) => buildProfessionalTrackingMask(rawArgs, ctx),
};
