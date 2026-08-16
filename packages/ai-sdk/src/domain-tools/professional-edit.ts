/** Controller-backed professional timeline editing tool. */
import { z } from 'zod/v4';
import { compileEditorCommand } from '@framepilot/editor-core';
import type { ToolSpec } from '../tool-registry.js';
import type { ToolContext } from '../tool-context.js';
import { rationalFrameRate } from '../frame-time.js';
import {
  TIMELINE_EDIT_INTENTS,
  TimelineEditObjectiveSchema,
  resolveTimelineObjective,
} from '../controllers/timeline-controller.js';
import { validateProfessionalOperationBatch } from './professional-batch.js';

export const PROFESSIONAL_EDIT_INTENTS = TIMELINE_EDIT_INTENTS;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  return parameters;
}

function buildProfessionalEdit(rawArgs: unknown, ctx: ToolContext) {
  const objective = TimelineEditObjectiveSchema.parse(rawArgs);
  if (!ctx.interaction) {
    throw new Error('professional_edit requires a live editor interaction snapshot.');
  }
  const resolution = resolveTimelineObjective({
    project: ctx.project,
    ...(ctx.projectRevision === undefined ? {} : { projectRevision: ctx.projectRevision }),
    interaction: ctx.interaction,
    objective,
  });
  if (resolution.status === 'rejected') {
    throw new Error(
      `professional_edit controller rejected ${resolution.code}: ${resolution.detail}`,
    );
  }
  const operations = resolution.commands.flatMap((command) => {
    const result = compileEditorCommand({
      timeline: ctx.project.timeline,
      assets: ctx.project.assets,
      sequenceRate: rationalFrameRate(ctx.project.fps),
      angleGroups: ctx.project.angleGroups,
      command,
    });
    if (result.status === 'rejected') {
      throw new Error(`professional_edit compiler rejected ${result.code}: ${result.detail}`);
    }
    return [...result.patch.operations];
  });
  return validateProfessionalOperationBatch(ctx, 'professional_edit', operations);
}

/** Domain-owned AI surface: model supplies editing intent, never primitive choreography. */
export const PROFESSIONAL_EDIT_TOOL: ToolSpec = {
  name: 'professional_edit',
  description:
    'Perform a professional roll, slip, ripple trim, slide, lift, extract, insert, overwrite, replace, J-cut, L-cut, or camera switch against the live selection, playhead, and source monitor. Use switch_angle with cameraAngleId to cut to another camera in the same synced group: it cuts at the playhead, lands on the same instant through the authored sync offsets, and leaves the sound alone. Linked picture/sound edits preserve sync by default; allow_desync must be explicit. Referents, source marks, and linked edit points are resolved from authoritative editor state; ambiguous or stale targets are rejected, as are cameras with no authored sync. Supply intent and frame counts only—FramePilot compiles the primitive operations.',
  version: '2',
  capabilities: ['timeline', 'professional-editing'],
  permissions: ['write'],
  cost: 'low',
  latency: 'fast',
  hostUiOnly: true,
  mutates: true,
  available: true,
  kind: 'mutate',
  parameters: jsonSchema(TimelineEditObjectiveSchema),
  parse: (rawArgs) => TimelineEditObjectiveSchema.parse(rawArgs),
  buildOps: (rawArgs, ctx) => buildProfessionalEdit(rawArgs, ctx),
};
