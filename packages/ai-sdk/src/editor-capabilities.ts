/** Canonical, machine-readable inventory of editor commands and properties. */
import { z } from 'zod/v4';
import {
  COMMAND_REJECTION_CODES,
  AUDIO_DYNAMICS_PARAMETER_CONTRACTS,
  AUDIO_EQ_PARAMETER_CONTRACTS,
  AUDIO_PARAMETER_CONTRACTS,
  CLIP_KEYFRAME_PROPERTIES,
  COLOR_GRADE_PARAMETER_CONTRACTS,
  EDITOR_COMMAND_TYPES,
  type AnyOperation,
  type EditorCommand,
} from '@framepilot/editor-core';
import { TOOL_CONTRACT_DECLARATIONS } from './tool-contract.js';
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
    /**
     * Which timebase this capability's time arguments are expressed in.
     *
     * `editor-core` already encodes this in the type system as `FrameDelta<'source'>` vs
     * `FrameDelta<'sequence'>` (and `FramePoint<…>`), which is exactly the right place for it
     * to be checked. But a phantom type parameter vanishes at runtime, so the discovery
     * surface the model actually reads never carried it, and the two-timebases confusion that
     * ADR 0076 calls the most expensive thing to get wrong stayed invisible here.
     *
     * Both domains appear together for `insert`/`overwrite`, which position in sequence time
     * and trim in source time. Empty for a capability that takes no time value at all
     * (`lift`, `extract`, which name clips).
     */
    timeDomains: z.array(z.enum(['sequence', 'source'])).default([]),
    /**
     * Every reason this capability's command can refuse, as structured codes rather than
     * prose — what a UI needs to grey a control out and say why, and what §7.1 means by
     * "preconditions".
     *
     * Republished from `editor-core`'s `COMMAND_REJECTION_CODES`, which is the authority and
     * is drift-tested against the compiler that raises them. A deliberate superset: the codes
     * shared helpers raise are listed for every command, because proving which helper each
     * command reaches needs a call-graph pass. Empty for `property` capabilities, which have
     * no command to refuse.
     */
    preconditions: z.array(z.string().min(1)).default([]),
    /**
     * One sentence naming what this capability does to the timeline, in an editor's words.
     *
     * §7.1 requires the contract to carry its own description. Until now the only prose lived
     * on the AI tool, so a UI or MCP client could not render a capability without parsing
     * text written for a model. Each sentence states the MECHANISM (what moves, what stays
     * fixed), because that is the part a person needs to pick the right command: the whole
     * difference between slip and slide is which of the two stays put.
     */
    description: z.string().min(1),
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
  /**
   * Read off the command's own interface in `professional-commands.ts`, never guessed:
   * `roll_edit.delta` is `FrameDelta<'sequence'>`, `slip_edit.delta` is `FrameDelta<'source'>`,
   * `insert_edit` carries a sequence `at` AND a source `sourceRange`, and `lift_edit` carries
   * only clip ids. `editor-capabilities.test.ts` pins every row against those signatures, so a
   * command that changes timebase cannot leave this table stale.
   */
  readonly timeDomains: readonly ('sequence' | 'source')[];
  /** Written from the compiler's actual behaviour, not from the command's name. */
  readonly description: string;
}

const TIMELINE_SEEDS: readonly TimelineCapabilitySeed[] = [
  {
    intent: 'roll',
    commandType: 'roll_edit',
    appliesTo: ['edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip'],
    timeDomains: ['sequence'],
    description:
      'Move the cut between two touching clips without changing the sequence duration: one clip gets longer by exactly what the other loses.',
  },
  {
    intent: 'slip',
    commandType: 'slip_edit',
    appliesTo: ['clip', 'source_range'],
    unit: 'frames',
    operationTypes: ['set_clip_source_range'],
    timeDomains: ['source'],
    description:
      'Change which part of the source a clip shows, without moving the clip. Its position and duration on the timeline stay exactly as they are.',
  },
  {
    intent: 'slide',
    commandType: 'slide_edit',
    appliesTo: ['clip', 'edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip', 'move_clip'],
    timeDomains: ['sequence'],
    description:
      "Move a clip along the timeline while its neighbours absorb the change, so the sequence duration and the clip's own content stay the same.",
  },
  {
    intent: 'ripple_trim',
    commandType: 'ripple_trim_edit',
    appliesTo: ['clip', 'edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip', 'move_clip'],
    timeDomains: ['sequence'],
    description:
      'Trim one edge of a clip and pull everything after it along, so no gap is left and the sequence gets shorter or longer by the trim.',
  },
  {
    intent: 'lift',
    commandType: 'lift_edit',
    appliesTo: ['clip'],
    unit: 'none',
    operationTypes: ['delete_range'],
    timeDomains: [],
    description:
      'Remove clips and leave the gap behind, so everything after them stays where it is.',
  },
  {
    intent: 'extract',
    commandType: 'extract_edit',
    appliesTo: ['clip'],
    unit: 'none',
    operationTypes: ['ripple_delete'],
    timeDomains: [],
    description: 'Remove clips and close the gap, pulling everything after them earlier.',
  },
  {
    intent: 'insert',
    commandType: 'insert_edit',
    appliesTo: ['track', 'source_range'],
    unit: 'frames',
    operationTypes: ['add_clip', 'split_clip', 'move_clip'],
    timeDomains: ['sequence', 'source'],
    description:
      'Drop media in at a point on the timeline and push whatever was there later, so nothing is overwritten.',
  },
  {
    intent: 'overwrite',
    commandType: 'overwrite_edit',
    appliesTo: ['track', 'source_range'],
    unit: 'frames',
    operationTypes: ['add_clip', 'delete_range'],
    timeDomains: ['sequence', 'source'],
    description:
      'Drop media in at a point on the timeline and replace whatever it lands on, leaving the sequence duration unchanged.',
  },
  {
    intent: 'replace',
    commandType: 'replace_edit',
    appliesTo: ['clip', 'source_range'],
    unit: 'frames',
    operationTypes: ['set_clip_media'],
    timeDomains: ['source'],
    description:
      "Swap a clip's media for a different asset, keeping the clip's position and duration on the timeline.",
  },
  {
    intent: 'j_cut',
    commandType: 'j_cut_edit',
    appliesTo: ['linked_edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip'],
    timeDomains: ['sequence'],
    description:
      "Let the incoming clip's audio start before its picture, so the sound leads the cut.",
  },
  {
    intent: 'l_cut',
    commandType: 'l_cut_edit',
    appliesTo: ['linked_edit_point'],
    unit: 'frames',
    operationTypes: ['trim_clip'],
    timeDomains: ['sequence'],
    description:
      "Let the outgoing clip's audio continue past its picture, so the sound trails the cut.",
  },
  {
    intent: 'switch_angle',
    commandType: 'switch_angle_edit',
    appliesTo: ['clip'],
    unit: 'frames',
    operationTypes: ['split_clip', 'set_clip_media'],
    timeDomains: ['sequence'],
    description:
      'Cut to another camera in the same synced group, so the new angle resumes at the same instant rather than the same source timestamp.',
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
  timeDomains: [...seed.timeDomains],
  preconditions: [...(COMMAND_REJECTION_CODES[seed.commandType] ?? [])],
  description: seed.description,
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
  description: `Animate or set a clip's ${property} over time; written as keyframes, so it can hold a value or ramp between them.`,
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
    description: `Grade a clip's ${property}; applied to the clip as a whole, not per frame.`,
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
    description:
      'Follow a subject the editor points at, writing its position per frame so a mask or effect can travel with it.',
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
    editable: true,
    operationTypes: ['track_object'] satisfies OperationType[],
    tool: 'track_subject_automatically',
    compiler: 'editor-core:compileTrackingCommand:apply_tracked_mask',
    verifier: 'ai-sdk:temporal-review:tracker-motion',
    inverter: PATCH_INVERTER,
    description:
      'Find and follow a subject without the editor pointing at it: geometric tracking or silhouette segmentation through an installed Capability Pack, prompted for approval on first use.',
    availability: {
      state: 'available' as const,
      reason:
        'Runs through the on-demand Subject Intelligence / Tracking Lite Capability Packs; the user approves the exact signed install before anything downloads. No tracker is silently bundled.',
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
    description: "Raise or lower a clip's level in decibels, applied to the whole clip.",
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
    description: "Ramp a clip's level up from silence over the given time at its start.",
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
    description: "Ramp a clip's level down to silence over the given time at its end.",
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
    description:
      "Scale a clip's level so its loudest point sits at the target, without changing its dynamics.",
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
    description:
      "Dip a clip's level whenever another track is loud, so music gets out of the way of speech.",
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
    description: "Shape a clip's tone by band, cutting or boosting selected frequencies.",
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
    description: "Even out a clip's loud and quiet parts by pulling peaks down toward the rest.",
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
    description: "Move a clip's level over time rather than setting one value for the whole clip.",
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

/**
 * A tool "mutates" when it can land a validated timeline change — directly via
 * `buildOps` OR host-backed like `track_subject_automatically`, whose
 * measurement the orchestrator compiles into ops afterwards. The registry's
 * legacy `mutates` flag alone cannot see the second kind.
 */
function isExecutableMutation(tool: Pick<ToolSpec, 'name' | 'available' | 'mutates'>): boolean {
  if (tool.mutates) return true;
  const declared = TOOL_CONTRACT_DECLARATIONS[tool.name];
  return declared !== undefined && declared.effectClass === 'mutation';
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
    } else if (!tool.available || !isExecutableMutation(tool)) {
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
