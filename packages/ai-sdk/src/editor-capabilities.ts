/** Canonical, machine-readable inventory of editor commands and properties. */
import { z } from 'zod/v4';
import {
  AUDIO_DYNAMICS_PARAMETER_CONTRACTS,
  AUDIO_EQ_PARAMETER_CONTRACTS,
  AUDIO_PARAMETER_CONTRACTS,
  CLIP_KEYFRAME_PROPERTIES,
  COLOR_GRADE_PARAMETER_CONTRACTS,
  EDITOR_COMMAND_TYPES,
  type AnyOperation,
  type EditorCommand,
} from '@framepilot/editor-core';
import type { ToolSpec } from './tool-registry.js';

export const EDITOR_CAPABILITY_DOMAINS = [
  'timeline',
  'media',
  'motion',
  'color',
  'tracking_mask',
  'audio',
  'captions',
  'graphics',
  'project',
  'verification',
] as const;

export const EDITOR_TARGET_KINDS = [
  'project',
  'timeline',
  'track',
  'clip',
  'edit_point',
  'linked_edit_point',
  'source_range',
  'effect',
  'keyframe',
] as const;

const NumericBoundsSchema = z
  .object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    minExclusive: z.number().finite().optional(),
    maxExclusive: z.number().finite().optional(),
  })
  .strict()
  .superRefine((bounds, refinement) => {
    if (bounds.min !== undefined && bounds.minExclusive !== undefined) {
      refinement.addIssue({ code: 'custom', message: 'Use min or minExclusive, not both.' });
    }
    if (bounds.max !== undefined && bounds.maxExclusive !== undefined) {
      refinement.addIssue({ code: 'custom', message: 'Use max or maxExclusive, not both.' });
    }
  });

export const EditorCapabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    kind: z.enum(['command', 'property']),
    domain: z.enum(EDITOR_CAPABILITY_DOMAINS),
    appliesTo: z.array(z.enum(EDITOR_TARGET_KINDS)).min(1),
    value: z
      .object({
        kind: z.enum(['command', 'number', 'boolean', 'string', 'enum', 'color', 'vector']),
        unit: z.enum(['none', 'frames', 'seconds', 'ratio', 'pixels', 'degrees', 'decibels']),
        bounds: NumericBoundsSchema.optional(),
        default: z.union([z.number(), z.boolean(), z.string()]).optional(),
      })
      .strict(),
    keyframeable: z.boolean(),
    inspectable: z.boolean(),
    editable: z.boolean(),
    commandType: z.enum(EDITOR_COMMAND_TYPES).optional(),
    tool: z.string().min(1).optional(),
    compiler: z.string().min(1).optional(),
    verifier: z.string().min(1).optional(),
    inverter: z.string().min(1).optional(),
    operationTypes: z.array(z.string().min(1)).default([]),
    availability: z
      .object({
        state: z.enum(['available', 'planned', 'unavailable']),
        reason: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((capability, refinement) => {
    if (capability.kind === 'command' && capability.commandType === undefined) {
      refinement.addIssue({
        code: 'custom',
        path: ['commandType'],
        message: 'Command type required.',
      });
    }
    if (capability.availability.state === 'available' && capability.editable) {
      for (const field of ['tool', 'compiler', 'verifier', 'inverter'] as const) {
        if (capability[field] === undefined) {
          refinement.addIssue({
            code: 'custom',
            path: [field],
            message: `Available editable capability requires ${field}.`,
          });
        }
      }
      if (capability.operationTypes.length === 0) {
        refinement.addIssue({
          code: 'custom',
          path: ['operationTypes'],
          message: 'Available editable capability requires an operation type.',
        });
      }
    }
  });

export type EditorCapability = z.infer<typeof EditorCapabilitySchema>;
export type EditorCapabilityDomain = (typeof EDITOR_CAPABILITY_DOMAINS)[number];
export type EditorTargetKind = (typeof EDITOR_TARGET_KINDS)[number];

type OperationType = AnyOperation['type'];

const AVAILABLE_REASON = 'Implemented, schema-validated, reversible, and registered.';
const PATCH_INVERTER = 'editor-core:invertPatch';
const PATCH_VERIFIER = 'editor-core:validatePatch';

interface TimelineCapabilitySeed {
  readonly intent: string;
  readonly commandType: EditorCommand['type'];
  readonly appliesTo: readonly EditorTargetKind[];
  readonly unit: 'none' | 'frames';
  readonly operationTypes: readonly OperationType[];
}

const TIMELINE_SEEDS: readonly TimelineCapabilitySeed[] = [
  {
    intent: 'roll',
    commandType: 'roll_edit',
    appliesTo: ['edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip'],
  },
  {
    intent: 'slip',
    commandType: 'slip_edit',
    appliesTo: ['clip', 'source_range'],
    unit: 'frames',
    operationTypes: ['set_clip_source_range'],
  },
  {
    intent: 'slide',
    commandType: 'slide_edit',
    appliesTo: ['clip', 'edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip', 'move_clip'],
  },
  {
    intent: 'ripple_trim',
    commandType: 'ripple_trim_edit',
    appliesTo: ['clip', 'edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip', 'move_clip'],
  },
  {
    intent: 'lift',
    commandType: 'lift_edit',
    appliesTo: ['clip'],
    unit: 'none',
    operationTypes: ['delete_range'],
  },
  {
    intent: 'extract',
    commandType: 'extract_edit',
    appliesTo: ['clip'],
    unit: 'none',
    operationTypes: ['ripple_delete'],
  },
  {
    intent: 'insert',
    commandType: 'insert_edit',
    appliesTo: ['track', 'source_range'],
    unit: 'frames',
    operationTypes: ['add_clip', 'split_clip', 'move_clip'],
  },
  {
    intent: 'overwrite',
    commandType: 'overwrite_edit',
    appliesTo: ['track', 'source_range'],
    unit: 'frames',
    operationTypes: ['add_clip', 'delete_range'],
  },
  {
    intent: 'replace',
    commandType: 'replace_edit',
    appliesTo: ['clip', 'source_range'],
    unit: 'frames',
    operationTypes: ['set_clip_media'],
  },
  {
    intent: 'j_cut',
    commandType: 'j_cut_edit',
    appliesTo: ['linked_edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip'],
  },
  {
    intent: 'l_cut',
    commandType: 'l_cut_edit',
    appliesTo: ['linked_edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip'],
  },
  {
    intent: 'switch_angle',
    commandType: 'switch_angle_edit',
    appliesTo: ['clip'],
    unit: 'frames',
    operationTypes: ['split_clip', 'set_clip_media'],
  },
];

const timelineCapabilities = TIMELINE_SEEDS.map((seed) => ({
  id: `timeline.${seed.intent}`,
  kind: 'command' as const,
  domain: 'timeline' as const,
  appliesTo: [...seed.appliesTo],
  value: { kind: 'command' as const, unit: seed.unit },
  keyframeable: false,
  inspectable: true,
  editable: true,
  commandType: seed.commandType,
  tool: 'professional_edit',
  compiler: `editor-core:compileEditorCommand:${seed.commandType}`,
  verifier: PATCH_VERIFIER,
  inverter: PATCH_INVERTER,
  operationTypes: [...seed.operationTypes],
  availability: { state: 'available' as const, reason: AVAILABLE_REASON },
}));

const motionPropertyMetadata = {
  scale: { unit: 'ratio', bounds: { minExclusive: 0 }, default: 1 },
  x: { unit: 'pixels', default: 0 },
  y: { unit: 'pixels', default: 0 },
  rotation: { unit: 'degrees', default: 0 },
  opacity: { unit: 'ratio', bounds: { min: 0, max: 1 }, default: 1 },
} as const;

const motionCapabilities = CLIP_KEYFRAME_PROPERTIES.map((property) => ({
  id: `motion.clip.${property}`,
  kind: 'property' as const,
  domain: 'motion' as const,
  appliesTo: ['clip', 'keyframe'] as const,
  value: { kind: 'number' as const, ...motionPropertyMetadata[property] },
  keyframeable: true,
  inspectable: true,
  editable: true,
  tool: 'professional_motion',
  compiler: 'editor-core:compileMotionCommand:animate_clip_property',
  verifier: 'editor-core:clipKeyframeContractIssue',
  inverter: PATCH_INVERTER,
  operationTypes: ['add_keyframes'] satisfies OperationType[],
  availability: { state: 'available' as const, reason: AVAILABLE_REASON },
}));

const colorCapabilities = Object.entries(COLOR_GRADE_PARAMETER_CONTRACTS).map(
  ([property, bounds]) => ({
    id: `color.clip.${property}`,
    kind: 'property' as const,
    domain: 'color' as const,
    appliesTo: ['clip', 'effect'] as const,
    value: { kind: 'number' as const, unit: 'ratio' as const, bounds, default: 0 },
    keyframeable: false,
    inspectable: true,
    editable: true,
    tool: 'professional_color',
    compiler: 'editor-core:compileColorCommand:correct_shot',
    verifier: 'editor-core:colorGradeContractIssues',
    inverter: PATCH_INVERTER,
    operationTypes: ['apply_color_grade'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  }),
);

const trackingMaskCapabilities = [
  {
    id: 'tracking_mask.manual_mask_track',
    kind: 'property' as const,
    domain: 'tracking_mask' as const,
    appliesTo: ['clip', 'effect'] as const,
    value: { kind: 'enum' as const, unit: 'none' as const, default: 'manual' },
    keyframeable: true,
    inspectable: true,
    editable: true,
    tool: 'professional_tracking_mask',
    compiler: 'editor-core:compileTrackingCommand:track_existing_mask',
    verifier: 'ai-sdk:temporal-review:tracker-motion',
    inverter: PATCH_INVERTER,
    operationTypes: ['track_object'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  },
  {
    id: 'tracking_mask.automatic_subject_track',
    kind: 'property' as const,
    domain: 'tracking_mask' as const,
    appliesTo: ['clip', 'effect'] as const,
    value: { kind: 'enum' as const, unit: 'none' as const },
    keyframeable: true,
    inspectable: false,
    editable: false,
    operationTypes: [] satisfies OperationType[],
    availability: {
      state: 'unavailable' as const,
      reason:
        'Requires the on-demand Subject Intelligence Capability Pack; no tracker is silently bundled or downloaded.',
    },
  },
];

const audioCapabilities = [
  {
    id: 'audio.clip.gain',
    kind: 'property' as const,
    domain: 'audio' as const,
    appliesTo: ['clip', 'effect'] as const,
    value: {
      kind: 'number' as const,
      unit: 'decibels' as const,
      bounds: AUDIO_PARAMETER_CONTRACTS.gainDb,
      default: 0,
    },
    keyframeable: false,
    inspectable: true,
    editable: true,
    tool: 'professional_audio',
    compiler: 'editor-core:compileAudioCommand:mix_clip_audio',
    verifier: 'editor-core:audioGainContractIssue',
    inverter: PATCH_INVERTER,
    operationTypes: ['adjust_audio'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  },
  {
    id: 'audio.clip.fade_in',
    kind: 'property' as const,
    domain: 'audio' as const,
    appliesTo: ['clip', 'effect'] as const,
    value: { kind: 'number' as const, unit: 'frames' as const, bounds: { min: 0 }, default: 0 },
    keyframeable: false,
    inspectable: true,
    editable: true,
    tool: 'professional_audio',
    compiler: 'editor-core:compileAudioCommand:mix_clip_audio',
    verifier: 'editor-core:validatePatch',
    inverter: PATCH_INVERTER,
    operationTypes: ['adjust_audio'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  },
  {
    id: 'audio.clip.fade_out',
    kind: 'property' as const,
    domain: 'audio' as const,
    appliesTo: ['clip', 'effect'] as const,
    value: { kind: 'number' as const, unit: 'frames' as const, bounds: { min: 0 }, default: 0 },
    keyframeable: false,
    inspectable: true,
    editable: true,
    tool: 'professional_audio',
    compiler: 'editor-core:compileAudioCommand:mix_clip_audio',
    verifier: 'editor-core:validatePatch',
    inverter: PATCH_INVERTER,
    operationTypes: ['adjust_audio'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  },
  {
    id: 'audio.clip.normalize_peak',
    kind: 'property' as const,
    domain: 'audio' as const,
    appliesTo: ['clip', 'effect'] as const,
    value: { kind: 'boolean' as const, unit: 'none' as const, default: false },
    keyframeable: false,
    inspectable: true,
    editable: true,
    tool: 'professional_audio',
    compiler: 'editor-core:compileAudioCommand:mix_clip_audio',
    verifier: 'ai-sdk:temporal-review:mix-audio',
    inverter: PATCH_INVERTER,
    operationTypes: ['adjust_audio'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  },
  {
    id: 'audio.clip.sidechain_duck',
    kind: 'property' as const,
    domain: 'audio' as const,
    appliesTo: ['clip', 'track', 'effect'] as const,
    value: {
      kind: 'number' as const,
      unit: 'decibels' as const,
      bounds: AUDIO_PARAMETER_CONTRACTS.duckAmountDb,
      default: -12,
    },
    keyframeable: false,
    inspectable: true,
    editable: true,
    tool: 'professional_audio',
    compiler: 'editor-core:compileAudioCommand:mix_clip_audio',
    verifier: 'ai-sdk:temporal-review:mix-audio',
    inverter: PATCH_INVERTER,
    operationTypes: ['adjust_audio'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  },
  {
    id: 'audio.clip.eq',
    kind: 'property' as const,
    domain: 'audio' as const,
    appliesTo: ['clip', 'effect'] as const,
    // The value is the whole curve, not one number: bands only mean something
    // together, and a per-band row would advertise an identity no edit can address.
    value: {
      kind: 'number' as const,
      unit: 'decibels' as const,
      bounds: AUDIO_EQ_PARAMETER_CONTRACTS.gainDb,
      default: 0,
    },
    keyframeable: false,
    inspectable: true,
    editable: true,
    tool: 'professional_audio',
    compiler: 'editor-core:compileAudioCommand:mix_clip_audio',
    verifier: 'editor-core:audioEqContractIssue',
    inverter: PATCH_INVERTER,
    operationTypes: ['adjust_audio'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  },
  {
    id: 'audio.clip.compression',
    kind: 'property' as const,
    domain: 'audio' as const,
    appliesTo: ['clip', 'effect'] as const,
    value: {
      kind: 'number' as const,
      unit: 'ratio' as const,
      bounds: AUDIO_DYNAMICS_PARAMETER_CONTRACTS.ratio,
      default: 1,
    },
    keyframeable: false,
    inspectable: true,
    editable: true,
    tool: 'professional_audio',
    compiler: 'editor-core:compileAudioCommand:mix_clip_audio',
    verifier: 'editor-core:audioDynamicsContractIssue',
    inverter: PATCH_INVERTER,
    operationTypes: ['adjust_audio'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  },
  {
    id: 'audio.clip.gain_automation',
    kind: 'property' as const,
    domain: 'audio' as const,
    appliesTo: ['clip', 'effect', 'keyframe'] as const,
    value: {
      kind: 'number' as const,
      unit: 'decibels' as const,
      bounds: AUDIO_PARAMETER_CONTRACTS.gainDb,
      default: 0,
    },
    // The one audio property that is a curve rather than a setting — which is
    // exactly what distinguishes it from `audio.clip.gain`.
    keyframeable: true,
    inspectable: true,
    editable: true,
    tool: 'professional_audio',
    compiler: 'editor-core:compileAudioCommand:mix_clip_audio',
    verifier: 'editor-core:audioAutomationContractIssue',
    inverter: PATCH_INVERTER,
    operationTypes: ['adjust_audio'] satisfies OperationType[],
    availability: { state: 'available' as const, reason: AVAILABLE_REASON },
  },
];

const parsedRegistry = z
  .array(EditorCapabilitySchema)
  .parse([
    ...timelineCapabilities,
    ...motionCapabilities,
    ...colorCapabilities,
    ...trackingMaskCapabilities,
    ...audioCapabilities,
  ]);

/** The public editor manifest. It is derived only from implemented runtime contracts. */
export const EDITOR_CAPABILITIES: readonly EditorCapability[] = parsedRegistry;

export interface EditorCapabilityQuery {
  readonly domain?: EditorCapabilityDomain;
  readonly appliesTo?: EditorTargetKind;
  readonly availability?: EditorCapability['availability']['state'];
  readonly editable?: boolean;
}

/** Discover capabilities without parsing prose from model tool descriptions. */
export function listEditorCapabilities(query: EditorCapabilityQuery = {}): EditorCapability[] {
  return EDITOR_CAPABILITIES.filter(
    (capability) =>
      (query.domain === undefined || capability.domain === query.domain) &&
      (query.appliesTo === undefined || capability.appliesTo.includes(query.appliesTo)) &&
      (query.availability === undefined || capability.availability.state === query.availability) &&
      (query.editable === undefined || capability.editable === query.editable),
  );
}

export interface CapabilityDriftIssue {
  readonly capabilityId: string;
  readonly message: string;
}

/** Cross-check the manifest against the live tool and command registries. */
export function editorCapabilityDriftIssues(
  capabilities: readonly EditorCapability[],
  tools: readonly Pick<ToolSpec, 'name' | 'available' | 'mutates'>[],
  commandTypes: readonly EditorCommand['type'][] = EDITOR_COMMAND_TYPES,
): CapabilityDriftIssue[] {
  const issues: CapabilityDriftIssue[] = [];
  const seen = new Set<string>();
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  const advertisedCommands = new Set<EditorCommand['type']>();

  for (const capability of capabilities) {
    if (seen.has(capability.id)) {
      issues.push({ capabilityId: capability.id, message: 'Duplicate capability id.' });
    }
    seen.add(capability.id);
    if (capability.commandType !== undefined) advertisedCommands.add(capability.commandType);
    if (capability.availability.state !== 'available' || !capability.editable) continue;
    const tool = capability.tool === undefined ? undefined : toolByName.get(capability.tool);
    if (!tool) {
      issues.push({
        capabilityId: capability.id,
        message: `Missing tool ${capability.tool ?? '(none)'}.`,
      });
    } else if (!tool.available || !tool.mutates) {
      issues.push({
        capabilityId: capability.id,
        message: `Tool ${tool.name} is not an available mutator.`,
      });
    }
  }

  for (const commandType of commandTypes) {
    if (!advertisedCommands.has(commandType)) {
      issues.push({
        capabilityId: `command:${commandType}`,
        message: 'Compiler command is not advertised.',
      });
    }
  }
  return issues;
}
