/** Controller-backed manual tracking of an existing bounded mask. */
import { z } from 'zod/v4';
import { compileTrackingCommand } from '@framepilot/editor-core';
import {
  resolveTrackingMaskObjective,
  TrackingMaskObjectiveSchema,
} from '../controllers/tracking-mask-controller.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { validateProfessionalOperationBatch } from './professional-batch.js';

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  return parameters;
}

function buildProfessionalTrackingMask(rawArgs: unknown, ctx: ToolContext) {
  const objective = TrackingMaskObjectiveSchema.parse(rawArgs);
  if (!ctx.interaction) {
    throw new Error('professional_tracking_mask requires a live editor interaction snapshot.');
  }
  const resolution = resolveTrackingMaskObjective({
    project: ctx.project,
    ...(ctx.projectRevision === undefined ? {} : { projectRevision: ctx.projectRevision }),
    interaction: ctx.interaction,
    objective,
  });
  if (resolution.status === 'rejected') {
    throw new Error(
      `professional_tracking_mask controller rejected ${resolution.code}: ${resolution.detail}`,
    );
  }
  const operations = resolution.commands.flatMap((command) => {
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
