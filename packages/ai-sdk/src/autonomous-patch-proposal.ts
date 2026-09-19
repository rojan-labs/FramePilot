/**
 * Compact autonomous patch proposal surfaces.
 *
 * The model proposes validated internal tool calls, never raw project JSON and
 * never raw operation unions. Registered builders remain the default operation
 * authority. Explicit virtual builders below expose editor-core capabilities that
 * already exist as typed/reversible operations but do not yet have a legacy registry
 * tool. They validate here and still flow through assembleEdit's patch validation.
 */
import type { AnyOperation, ProjectOperation } from '@framepilot/editor-core';
import type { Project, SpeedPoint } from '@framepilot/timeline-schema';
import { assembleEdit, type EditResult } from './assemble.js';
import type { ToolContext } from './tool-context.js';
import { operationsForCall } from './tool-dispatch.js';
import { getTool } from './tool-registry.js';

export type AutonomousPatchScope = 'timeline' | 'project';

export interface AutonomousOperationCall {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface AutonomousPatchProposal {
  readonly scope: AutonomousPatchScope;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly operations: readonly AutonomousOperationCall[];
}

export interface CompiledAutonomousPatch extends EditResult {
  readonly scope: AutonomousPatchScope;
  readonly evidenceIds: readonly string[];
  readonly calls: readonly AutonomousOperationCall[];
}

const PROJECT_OPERATION_TYPES: ReadonlySet<ProjectOperation['type']> = new Set([
  'add_asset',
  'remove_asset',
  'move_asset',
  'create_folder',
  'rename_folder',
  'move_folder',
  'delete_folder',
  'set_transcript',
  'add_marker',
  'remove_marker',
  'restore_assets',
  'restore_folders',
]);

export const MIN_AUTONOMOUS_PLAYBACK_SPEED = 0.05;
const HARD_CUT_DURATION_SECONDS = 0.001;
const EASINGS = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'bezier']);

const TIMELINE_MUTATION_BUILDERS: ReadonlySet<string> = new Set([
  'trim_clip',
  'split_clip',
  'delete_range',
  'delete_clip',
  'delete_clips',
  'ripple_delete',
  'move_clip',
  'reorder_clips',
  'add_track',
  'remove_track',
  'move_track',
  'add_clip',
  'add_text_layer',
  'add_caption_layer',
  'add_keyframes',
  'punch_in',
  'apply_color_grade',
  'adjust_audio',
  'adjust_audio_full',
  'add_transition',
  'set_hard_cut',
  'track_object',
  'set_track_flags',
  'set_track_caption_style',
  'auto_emphasize_captions',
  'set_caption_style',
  'set_clip_speed',
  'set_clip_playback_mode',
  'set_clip_speed_ramp',
  'set_clip_crop',
  'set_clip_blend_mode',
  'apply_effect',
  'move_effect',
  'resize_effect',
  'adjust_effect',
  'set_effect_enabled',
  'remove_effect',
]);

const PROJECT_MUTATION_BUILDERS: ReadonlySet<string> = new Set([
  'add_asset',
  'manage_assets',
  'add_marker',
  'remove_marker',
]);

function allowedBuilders(scope: AutonomousPatchScope): ReadonlySet<string> {
  return scope === 'timeline' ? TIMELINE_MUTATION_BUILDERS : PROJECT_MUTATION_BUILDERS;
}

export function isProjectOperation(operation: AnyOperation): operation is ProjectOperation {
  return PROJECT_OPERATION_TYPES.has(operation.type as ProjectOperation['type']);
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictKeys(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`${tool} does not accept argument "${unknown}".`);
}

function nonEmptyString(tool: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${tool} requires a non-empty ${field}.`);
  }
  return value;
}

function finiteNumber(tool: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${tool} requires ${field} to be a finite number.`);
  }
  return value;
}

function optionalFiniteNumber(tool: string, field: string, value: unknown): number | undefined {
  return value === undefined ? undefined : finiteNumber(tool, field, value);
}

function assertSafeAutonomousArguments(call: AutonomousOperationCall): void {
  if (call.tool !== 'set_clip_speed') return;
  const speed = call.arguments.speed;
  if (speed === null) return;
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return;
  if (speed < MIN_AUTONOMOUS_PLAYBACK_SPEED) {
    throw new Error(
      `set_clip_speed speed must be >= ${String(MIN_AUTONOMOUS_PLAYBACK_SPEED)}x on the autonomous surface. ` +
        'Use set_clip_playback_mode for an intentional freeze or reverse.',
    );
  }
}

function resolveAutonomousBuilder(call: AutonomousOperationCall): AutonomousOperationCall {
  if (call.tool !== 'set_hard_cut') return call;
  strictKeys(call.tool, call.arguments, ['trackId', 'fromClipId', 'toClipId']);
  const trackId = nonEmptyString(call.tool, 'trackId', call.arguments.trackId);
  const fromClipId = nonEmptyString(call.tool, 'fromClipId', call.arguments.fromClipId);
  const toClipId = nonEmptyString(call.tool, 'toClipId', call.arguments.toClipId);
  return {
    tool: 'add_transition',
    arguments: {
      trackId,
      fromClipId,
      toClipId,
      kind: 'cut',
      durationSeconds: HARD_CUT_DURATION_SECONDS,
    },
  };
}

function speedPoint(call: AutonomousOperationCall, raw: unknown, index: number): SpeedPoint {
  if (!objectRecord(raw)) throw new Error(`${call.tool} ramp[${String(index)}] must be an object.`);
  strictKeys(call.tool, raw, ['sourceTime', 'rate', 'easing']);
  const sourceTime = finiteNumber(call.tool, `ramp[${String(index)}].sourceTime`, raw.sourceTime);
  const rate = finiteNumber(call.tool, `ramp[${String(index)}].rate`, raw.rate);
  if (sourceTime < 0) throw new Error(`${call.tool} ramp sourceTime must be >= 0.`);
  if (rate <= 0) throw new Error(`${call.tool} ramp rate must be > 0.`);
  const easing = raw.easing ?? 'linear';
  if (typeof easing !== 'string' || !EASINGS.has(easing)) {
    throw new Error(`${call.tool} ramp easing "${String(easing)}" is unsupported.`);
  }
  return {
    id: `ai_speed_${String(index)}_${String(Math.round(sourceTime * 1000))}`,
    sourceTime,
    rate,
    easing: easing as SpeedPoint['easing'],
  };
}

function virtualAutonomousOperations(call: AutonomousOperationCall): AnyOperation[] | undefined {
  const a = call.arguments;

  if (call.tool === 'set_clip_playback_mode') {
    strictKeys(call.tool, a, ['clipId', 'mode', 'speed']);
    const clipId = nonEmptyString(call.tool, 'clipId', a.clipId);
    const mode = a.mode;
    if (mode !== 'normal' && mode !== 'freeze' && mode !== 'reverse') {
      throw new Error(`${call.tool} mode must be normal, freeze, or reverse.`);
    }
    const requested = a.speed === undefined ? undefined : finiteNumber(call.tool, 'speed', a.speed);
    if (requested !== undefined && requested <= 0) {
      throw new Error(`${call.tool} optional speed magnitude must be > 0.`);
    }
    // The same DoS floor `assertSafeAutonomousArguments` enforces for a direct
    // `set_clip_speed` call also applies here: `normal`/`reverse` both emit a
    // `set_clip_speed` operation with this magnitude, so a near-zero request would
    // otherwise reach the same "5s clip becomes hours long" hole through a different
    // tool name. `freeze` is exempt — its speed is always exactly 0, never `requested`.
    if (mode !== 'freeze' && requested !== undefined && requested < MIN_AUTONOMOUS_PLAYBACK_SPEED) {
      throw new Error(
        `${call.tool} speed magnitude must be >= ${String(MIN_AUTONOMOUS_PLAYBACK_SPEED)}x on the autonomous surface.`,
      );
    }
    const speed =
      mode === 'freeze' ? 0 : mode === 'reverse' ? -(requested ?? 1) : (requested ?? null);
    return [{ type: 'set_clip_speed', clipId, speed }];
  }

  if (call.tool === 'set_clip_speed_ramp') {
    strictKeys(call.tool, a, ['clipId', 'ramp']);
    const clipId = nonEmptyString(call.tool, 'clipId', a.clipId);
    if (a.ramp === null) return [{ type: 'set_clip_speed_ramp', clipId, ramp: null }];
    if (!Array.isArray(a.ramp)) throw new Error(`${call.tool} ramp must be an array or null.`);
    const ramp = a.ramp.map((point, index) => speedPoint(call, point, index));
    for (let index = 1; index < ramp.length; index += 1) {
      if (ramp[index]!.sourceTime <= ramp[index - 1]!.sourceTime) {
        throw new Error(`${call.tool} ramp sourceTime values must be strictly increasing.`);
      }
    }
    return [{ type: 'set_clip_speed_ramp', clipId, ramp }];
  }

  if (call.tool === 'adjust_audio_full') {
    strictKeys(call.tool, a, [
      'clipId',
      'gainDb',
      'fadeInSeconds',
      'fadeOutSeconds',
      'fadeCurve',
      'muted',
      'normalize',
      'duckUnderTrackId',
      'duckAmountDb',
    ]);
    const clipId = nonEmptyString(call.tool, 'clipId', a.clipId);
    const gainDb = finiteNumber(call.tool, 'gainDb', a.gainDb);
    const fadeInSeconds = optionalFiniteNumber(call.tool, 'fadeInSeconds', a.fadeInSeconds);
    const fadeOutSeconds = optionalFiniteNumber(call.tool, 'fadeOutSeconds', a.fadeOutSeconds);
    if ((fadeInSeconds ?? 0) < 0 || (fadeOutSeconds ?? 0) < 0) {
      throw new Error(`${call.tool} fade durations must be >= 0.`);
    }
    const fadeCurve = a.fadeCurve;
    if (
      fadeCurve !== undefined &&
      fadeCurve !== 'linear' &&
      fadeCurve !== 'equal-power' &&
      fadeCurve !== 'smooth'
    ) {
      throw new Error(`${call.tool} fadeCurve must be linear, equal-power, or smooth.`);
    }
    if (a.muted !== undefined && typeof a.muted !== 'boolean')
      throw new Error(`${call.tool} muted must be boolean.`);
    if (a.normalize !== undefined && typeof a.normalize !== 'boolean') {
      throw new Error(`${call.tool} normalize must be boolean.`);
    }
    const duckUnderTrackId =
      a.duckUnderTrackId === undefined
        ? undefined
        : nonEmptyString(call.tool, 'duckUnderTrackId', a.duckUnderTrackId);
    const duckAmountDb = optionalFiniteNumber(call.tool, 'duckAmountDb', a.duckAmountDb);
    return [
      {
        type: 'adjust_audio',
        clipId,
        gainDb,
        ...(fadeInSeconds !== undefined ? { fadeInSeconds } : {}),
        ...(fadeOutSeconds !== undefined ? { fadeOutSeconds } : {}),
        ...(fadeCurve !== undefined ? { fadeCurve } : {}),
        ...(a.muted !== undefined ? { muted: a.muted } : {}),
        ...(a.normalize !== undefined ? { normalize: a.normalize } : {}),
        ...(duckUnderTrackId !== undefined ? { duckUnderTrackId } : {}),
        ...(duckAmountDb !== undefined ? { duckAmountDb } : {}),
      },
    ];
  }

  return undefined;
}

/** Parse the compact proposal at the untrusted model boundary. */
export function parseAutonomousPatchProposal(raw: unknown): AutonomousPatchProposal {
  if (!objectRecord(raw)) throw new TypeError('Patch proposal must be an object.');
  const scope = raw.scope;
  if (scope !== 'timeline' && scope !== 'project') {
    throw new TypeError('Patch proposal scope must be "timeline" or "project".');
  }
  if (typeof raw.reason !== 'string' || raw.reason.trim() === '') {
    throw new TypeError('Patch proposal reason must be a non-empty string.');
  }
  if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
    throw new TypeError('Patch proposal operations must be a non-empty array.');
  }
  const operations = raw.operations.map((candidate, index): AutonomousOperationCall => {
    if (!objectRecord(candidate)) {
      throw new TypeError(`Patch proposal operation ${String(index)} must be an object.`);
    }
    if (typeof candidate.tool !== 'string' || candidate.tool.trim() === '') {
      throw new TypeError(`Patch proposal operation ${String(index)} needs a tool name.`);
    }
    if (!objectRecord(candidate.arguments)) {
      throw new TypeError(`Patch proposal operation ${String(index)} arguments must be an object.`);
    }
    return { tool: candidate.tool, arguments: candidate.arguments };
  });
  const evidenceIds = raw.evidenceIds;
  if (
    evidenceIds !== undefined &&
    (!Array.isArray(evidenceIds) || evidenceIds.some((value) => typeof value !== 'string'))
  ) {
    throw new TypeError('Patch proposal evidenceIds must be an array of strings.');
  }
  return {
    scope,
    reason: raw.reason.trim(),
    evidenceIds: evidenceIds === undefined ? [] : [...new Set(evidenceIds as string[])],
    operations,
  };
}

/** Resolve builders, enforce least privilege and scope, then assemble one patch. */
export function compileAutonomousPatchProposal(
  project: Project,
  rawProposal: unknown,
  context: Omit<ToolContext, 'project'> = {},
): CompiledAutonomousPatch {
  const proposal = parseAutonomousPatchProposal(rawProposal);
  const toolContext: ToolContext = { project, ...context };
  const operations: AnyOperation[] = [];
  const permitted = allowedBuilders(proposal.scope);
  const otherScope: AutonomousPatchScope = proposal.scope === 'timeline' ? 'project' : 'timeline';

  for (const [index, call] of proposal.operations.entries()) {
    if (!permitted.has(call.tool)) {
      if (!allowedBuilders(otherScope).has(call.tool)) {
        // Not a reviewed autonomous-proposal builder in either scope: this is the actual
        // least-privilege denial. Diagnose the specific reason first (unknown / unavailable /
        // non-mutating) so the model sees an actionable error instead of one flat message that
        // masks genuinely distinct failures.
        const tool = getTool(call.tool);
        if (!tool) throw new Error(`Unknown internal operation builder "${call.tool}".`);
        if (!tool.available)
          throw new Error(`Internal operation builder "${call.tool}" is unavailable.`);
        if (!tool.mutates)
          throw new Error(`Internal operation builder "${call.tool}" does not create edits.`);
        throw new Error(
          `Internal operation builder "${call.tool}" is not authorized for an autonomous ${proposal.scope} proposal.`,
        );
      }
      // Reviewed and permitted for the other scope: fall through so the operation-type check
      // below reports exactly which scope its emitted operations actually belong to, instead
      // of a generic authorization message.
    }
    assertSafeAutonomousArguments(call);
    const virtual = virtualAutonomousOperations(call);
    let built: AnyOperation[];
    if (virtual !== undefined) {
      built = virtual;
    } else {
      const resolved = resolveAutonomousBuilder(call);
      const tool = getTool(resolved.tool);
      if (!tool) throw new Error(`Unknown internal operation builder "${resolved.tool}".`);
      if (!tool.available)
        throw new Error(`Internal operation builder "${resolved.tool}" is unavailable.`);
      if (!tool.mutates)
        throw new Error(`Internal operation builder "${resolved.tool}" does not create edits.`);
      built = operationsForCall(
        {
          id: `autonomous-${proposal.scope}-${String(index)}`,
          name: resolved.tool,
          arguments: { ...resolved.arguments },
        },
        toolContext,
      );
    }
    if (built.length === 0)
      throw new Error(`Internal operation builder "${call.tool}" produced no operations.`);
    for (const operation of built) {
      const projectOperation = isProjectOperation(operation);
      if (proposal.scope === 'timeline' && projectOperation) {
        throw new Error(
          `Tool "${call.tool}" produced project operation "${operation.type}" in a timeline proposal.`,
        );
      }
      if (proposal.scope === 'project' && !projectOperation) {
        throw new Error(
          `Tool "${call.tool}" produced timeline operation "${operation.type}" in a project proposal.`,
        );
      }
      operations.push(operation);
    }
  }

  const edit = assembleEdit(project, operations, proposal.reason);
  return {
    ...edit,
    scope: proposal.scope,
    evidenceIds: proposal.evidenceIds,
    calls: proposal.operations,
  };
}
