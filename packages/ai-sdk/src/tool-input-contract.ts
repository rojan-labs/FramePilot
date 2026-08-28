import {
  AUDIO_PARAMETER_CONTRACTS,
  CLIP_KEYFRAME_PROPERTIES,
  COLOR_GRADE_PARAMETER_CONTRACTS,
  transitionEligibility,
} from '@framepilot/editor-core';
import { findEffect } from '@framepilot/timeline-schema/effect-catalog';
import { paramsForKind } from '@framepilot/timeline-schema/effect-params';
import type { ToolParameterSchema, ToolSpec } from './tool-registry.js';

const ORDERED_WINDOW_TOOLS = new Set(['get_transcript', 'get_mapped_transcript', 'get_clips']);
const ORDERED_START_END_TOOLS = new Set([
  'trim_clip',
  'delete_range',
  'ripple_delete',
  'add_clip',
  'add_text_layer',
  'add_caption_layer',
  'resize_effect',
]);

export class ToolInputContractError extends Error {
  public constructor(
    public readonly toolName: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolInputContractError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertOrdered(
  toolName: string,
  value: Record<string, unknown>,
  startField: string,
  endField: string,
): void {
  const start = value[startField];
  const end = value[endField];
  if (typeof start === 'number' && typeof end === 'number' && end <= start) {
    throw new ToolInputContractError(
      toolName,
      `${toolName} requires ${endField} > ${startField} when both are provided.`,
    );
  }
}

function assertMapTime(value: Record<string, unknown>): void {
  const hasSource = typeof value.sourceTime === 'number';
  const hasSequence = typeof value.sequenceTime === 'number';
  const hasAsset = typeof value.assetId === 'string' && value.assetId.trim() !== '';
  if (hasSource && hasSequence) {
    throw new ToolInputContractError(
      'map_time',
      'map_time accepts exactly one time domain: sourceTime or sequenceTime, never both.',
    );
  }
  if (hasAsset && !hasSource) {
    throw new ToolInputContractError('map_time', 'map_time assetId is only valid with sourceTime.');
  }
}

function assertKeyframes(value: Record<string, unknown>): void {
  if (!Array.isArray(value.keyframes)) return;
  const supported = new Set<string>(CLIP_KEYFRAME_PROPERTIES);
  for (const [index, raw] of value.keyframes.entries()) {
    const keyframe = record(raw);
    if (!keyframe) continue;
    const property = keyframe.property;
    if (typeof property !== 'string' || !supported.has(property)) {
      throw new ToolInputContractError(
        'add_keyframes',
        `keyframes[${String(index)}].property must be one of ${CLIP_KEYFRAME_PROPERTIES.join(', ')}.`,
      );
    }
    const amount = keyframe.value;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    if (property === 'scale' && amount <= 0) {
      throw new ToolInputContractError('add_keyframes', 'Scale keyframe values must be > 0.');
    }
    if (property === 'opacity' && (amount < 0 || amount > 1)) {
      throw new ToolInputContractError(
        'add_keyframes',
        'Opacity keyframe values must be within 0..1.',
      );
    }
  }
}

function assertColorGrade(value: Record<string, unknown>): void {
  const type = typeof value.type === 'string' ? value.type : 'color_grade';
  if (type !== 'color_grade' && type !== 'lut') {
    throw new ToolInputContractError(
      'apply_color_grade',
      `Unsupported color effect type "${type}". Use color_grade or lut. Position, scale ` +
        'and rotation are not grades — they come from keyframes (add_keyframes, punch_in).',
    );
  }
  const params = record(value.params) ?? {};
  if (type === 'lut') {
    const path = params.path;
    if (typeof path !== 'string' || path.trim() === '') {
      throw new ToolInputContractError('apply_color_grade', 'A LUT grade requires params.path.');
    }
    return;
  }
  for (const [name, raw] of Object.entries(params)) {
    const contract = COLOR_GRADE_PARAMETER_CONTRACTS[name];
    if (!contract) {
      throw new ToolInputContractError(
        'apply_color_grade',
        `Unknown color-grade parameter "${name}".`,
      );
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new ToolInputContractError('apply_color_grade', `${name} must be a finite number.`);
    }
    if (raw < contract.min || raw > contract.max) {
      throw new ToolInputContractError(
        'apply_color_grade',
        `${name} must be within ${String(contract.min)}..${String(contract.max)}.`,
      );
    }
  }
}

function assertAudio(value: Record<string, unknown>): void {
  const gain = value.gainDb;
  if (typeof gain !== 'number' || !Number.isFinite(gain)) return;
  const { min, max } = AUDIO_PARAMETER_CONTRACTS.gainDb;
  if (gain < min || gain > max) {
    throw new ToolInputContractError(
      'adjust_audio',
      `gainDb must be within ${String(min)}..${String(max)} dB.`,
    );
  }
}

function assertTrackerRegion(value: Record<string, unknown>): void {
  const region = record(value.region);
  if (!region) return;
  const x = region.x;
  const y = region.y;
  const width = region.width;
  const height = region.height;
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return;
  }
  const nx = x as number;
  const ny = y as number;
  const nw = width as number;
  const nh = height as number;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1 || nw <= 0 || nw > 1 || nh <= 0 || nh > 1) {
    throw new ToolInputContractError(
      'track_object',
      'region must use normalized 0..1 frame fractions with positive width/height.',
    );
  }
  if (nx + nw > 1 || ny + nh > 1) {
    throw new ToolInputContractError(
      'track_object',
      'region must stay inside the normalized frame.',
    );
  }
}

function assertEffectParams(value: Record<string, unknown>): void {
  const effectId = value.effectId;
  if (typeof effectId !== 'string') return;
  const entry = findEffect(effectId);
  if (!entry) return;
  const params = record(value.params);
  if (!params) return;
  const declared = new Map(
    paramsForKind(entry.kind).map((descriptor) => [descriptor.name, descriptor]),
  );
  for (const [name, raw] of Object.entries(params)) {
    const descriptor = declared.get(name);
    if (!descriptor) {
      throw new ToolInputContractError(
        'apply_effect',
        `Effect "${effectId}" has no parameter "${name}". Call discover_effects and use only returned parameter names.`,
      );
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new ToolInputContractError('apply_effect', `${name} must be a finite number.`);
    }
    if (raw < descriptor.min || raw > descriptor.max) {
      throw new ToolInputContractError(
        'apply_effect',
        `${name} must be within ${String(descriptor.min)}..${String(descriptor.max)} for effect "${effectId}" (got ${String(raw)}).`,
      );
    }
  }
}

/**
 * Per-ENTRY ordering for a batch placement.
 *
 * `assertOrdered` reads top-level fields only, so listing `add_clips` beside `add_clip`
 * would check nothing. The failure has to name the entry: `contractRejectionMessage`
 * deliberately strips the operation index from a contract rejection (on the singular tools
 * the index is always 0), so without this a sixty-entry batch is refused with no way to
 * tell which entry was wrong — and the tool description promises the opposite. Mirrors
 * `contract_overrides.py#_AddClipEntry._ordered`.
 */
function assertAddClipsEntries(value: Record<string, unknown>): void {
  const clips = value.clips;
  if (!Array.isArray(clips)) return;
  clips.forEach((raw, index) => {
    const clip = record(raw);
    if (!clip) return;
    const { start, end } = clip;
    if (typeof start === 'number' && typeof end === 'number' && end <= start) {
      throw new ToolInputContractError(
        'add_clips',
        `add_clips entry ${String(index)}: end must be greater than start ` +
          `(got start ${String(start)}, end ${String(end)}).`,
      );
    }
  });
}

export function assertToolInputSemantics(toolName: string, parsed: unknown): void {
  const value = record(parsed);
  if (!value) return;
  if (ORDERED_WINDOW_TOOLS.has(toolName)) assertOrdered(toolName, value, 'start', 'end');
  if (ORDERED_START_END_TOOLS.has(toolName)) assertOrdered(toolName, value, 'start', 'end');
  if (toolName === 'add_clips') assertAddClipsEntries(value);
  if (toolName === 'apply_effect' || toolName === 'punch_in') {
    assertOrdered(toolName, value, 'startTime', 'endTime');
  }
  if (toolName === 'map_time') assertMapTime(value);
  if (toolName === 'add_keyframes') assertKeyframes(value);
  if (toolName === 'apply_color_grade') assertColorGrade(value);
  if (toolName === 'adjust_audio') assertAudio(value);
  if (toolName === 'track_object') assertTrackerRegion(value);
  if (toolName === 'apply_effect') assertEffectParams(value);
}

function parseWithContract(tool: ToolSpec, rawArgs: unknown): unknown {
  const parsed = tool.parse(rawArgs);
  assertToolInputSemantics(tool.name, parsed);
  return parsed;
}

export function parseToolArguments(tool: ToolSpec, rawArgs: unknown): unknown {
  return parseWithContract(tool, rawArgs);
}

function mapTimeParameters(): ToolParameterSchema {
  const time = { type: 'number', minimum: 0 };
  // A flat object, not a top-level oneOf: Anthropic's Messages API rejects
  // oneOf/anyOf/allOf directly under `input_schema`. The real mutual-exclusivity
  // rule (sourceTime+assetId XOR sequenceTime XOR neither) is enforced at runtime
  // by `assertMapTime`, not by the advertised schema, so it is safe to describe
  // the constraint in prose here.
  return {
    type: 'object',
    description:
      'Map one time domain at a time. Provide sourceTime (+ optional assetId) to convert source time to sequence time, or sequenceTime to convert sequence time to source time, or no arguments to get the full mapping. Never provide both sourceTime and sequenceTime, and only provide assetId alongside sourceTime.',
    properties: {
      sourceTime: {
        ...time,
        description: 'Source-domain time in seconds. Mutually exclusive with sequenceTime.',
      },
      assetId: { type: 'string', description: 'Only valid together with sourceTime.' },
      sequenceTime: {
        ...time,
        description: 'Sequence-domain time in seconds. Mutually exclusive with sourceTime.',
      },
    },
    additionalProperties: false,
  };
}

function withDescription(
  parameters: ToolParameterSchema,
  description: string,
): ToolParameterSchema {
  return { ...parameters, description };
}

function objectProperties(parameters: ToolParameterSchema): Record<string, unknown> {
  const properties = parameters.properties;
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties)
    ? { ...(properties as Record<string, unknown>) }
    : {};
}

function keyframeParameters(parameters: ToolParameterSchema): ToolParameterSchema {
  const properties = objectProperties(parameters);
  const keyframes = record(properties.keyframes);
  const items = record(keyframes?.items);
  const itemProperties = objectProperties(items ?? {});
  itemProperties.property = { type: 'string', enum: [...CLIP_KEYFRAME_PROPERTIES] };
  return {
    ...parameters,
    properties: {
      ...properties,
      keyframes: { ...(keyframes ?? {}), items: { ...(items ?? {}), properties: itemProperties } },
    },
  };
}

function colorGradeParameters(parameters: ToolParameterSchema): ToolParameterSchema {
  const properties = objectProperties(parameters);
  properties.type = { type: 'string', enum: ['color_grade', 'lut'] };
  return { ...parameters, properties };
}

function audioParameters(parameters: ToolParameterSchema): ToolParameterSchema {
  const properties = objectProperties(parameters);
  properties.gainDb = {
    type: 'number',
    minimum: AUDIO_PARAMETER_CONTRACTS.gainDb.min,
    maximum: AUDIO_PARAMETER_CONTRACTS.gainDb.max,
  };
  return { ...parameters, properties };
}

function trackerParameters(parameters: ToolParameterSchema): ToolParameterSchema {
  const properties = objectProperties(parameters);
  const region = record(properties.region);
  const regionProperties = objectProperties(region ?? {});
  regionProperties.x = { type: 'number', minimum: 0, maximum: 1 };
  regionProperties.y = { type: 'number', minimum: 0, maximum: 1 };
  regionProperties.width = { type: 'number', exclusiveMinimum: 0, maximum: 1 };
  regionProperties.height = { type: 'number', exclusiveMinimum: 0, maximum: 1 };
  properties.region = { ...(region ?? {}), properties: regionProperties };
  return { ...parameters, properties };
}

export function contractedToolParameters(tool: ToolSpec): ToolParameterSchema {
  if (tool.name === 'map_time') return mapTimeParameters();
  if (tool.name === 'add_keyframes') return keyframeParameters(tool.parameters);
  if (tool.name === 'apply_color_grade') return colorGradeParameters(tool.parameters);
  if (tool.name === 'adjust_audio') return audioParameters(tool.parameters);
  if (tool.name === 'track_object') return trackerParameters(tool.parameters);
  if (ORDERED_WINDOW_TOOLS.has(tool.name) || ORDERED_START_END_TOOLS.has(tool.name)) {
    return withDescription(
      tool.parameters,
      `${tool.name}: when both start and end are provided, end must be strictly greater than start.`,
    );
  }
  if (tool.name === 'apply_effect' || tool.name === 'punch_in') {
    return withDescription(
      tool.parameters,
      `${tool.name}: when both startTime and endTime are provided, endTime must be strictly greater than startTime.`,
    );
  }
  return tool.parameters;
}

function assertNoTransitionClamp(
  parsed: unknown,
  ctx: Parameters<NonNullable<ToolSpec['buildOps']>>[1],
): void {
  const value = record(parsed);
  if (!value) return;
  const fromClipId = value.fromClipId;
  const toClipId = value.toClipId;
  const durationSeconds = value.durationSeconds;
  const kind = value.kind;
  if (
    typeof fromClipId !== 'string' ||
    typeof toClipId !== 'string' ||
    typeof durationSeconds !== 'number' ||
    typeof kind !== 'string'
  ) {
    return;
  }
  const eligibility = transitionEligibility(ctx.project.timeline, {
    fromClipId,
    toClipId,
    durationSeconds,
    kind,
  });
  if (!eligibility.ok) throw new ToolInputContractError('add_transition', eligibility.detail);
  if (eligibility.clampedFrom !== undefined) {
    throw new ToolInputContractError(
      'add_transition',
      `Requested ${String(eligibility.clampedFrom)}s, but this cut can carry at most ${String(eligibility.durationSeconds)}s. Retry with durationSeconds <= ${String(eligibility.durationSeconds)} so the applied value is explicit.`,
    );
  }
}

const wrapped = new WeakMap<object, ToolSpec>();

/**
 * Return a complete immutable tool contract. The original registry object is never
 * mutated, so behavior cannot depend on which module happened to import first.
 */
export function withToolInputContract(tool: ToolSpec): ToolSpec {
  const cached = wrapped.get(tool);
  if (cached) return cached;

  const parse = (rawArgs: unknown): unknown => parseWithContract(tool, rawArgs);
  const originalRead = tool.read;
  const originalBuildOps = tool.buildOps;
  const contracted: ToolSpec = Object.freeze({
    ...tool,
    parameters: contractedToolParameters(tool),
    parse,
    ...(originalRead
      ? {
          read: (rawArgs: unknown, ctx: Parameters<NonNullable<ToolSpec['read']>>[1]) =>
            originalRead(parse(rawArgs), ctx),
        }
      : {}),
    ...(originalBuildOps
      ? {
          buildOps: (rawArgs: unknown, ctx: Parameters<NonNullable<ToolSpec['buildOps']>>[1]) => {
            const parsed = parse(rawArgs);
            if (tool.name === 'add_transition') assertNoTransitionClamp(parsed, ctx);
            return originalBuildOps(parsed, ctx);
          },
        }
      : {}),
  });
  wrapped.set(tool, contracted);
  return contracted;
}
