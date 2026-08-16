/**
 * Main-process streaming AI run (Phase 11 M3, ADR 0033).
 *
 * `runAiStream` is the pure core: given an {@link Orchestrator}, a validated
 * request, an `onEvent` sink, and an `AbortSignal`, it drives the right
 * `Orchestrator.stream*` and forwards each {@link AiEvent}. {@link AiStreamHub}
 * owns the per-run lifecycle (unguessable ids, **sender-scoped** abort,
 * destroy-cleanup, a max-run timeout). Both are free of `electron` so they are
 * unit-testable with the offline mock provider; `main.ts` only adapts `WebContents`.
 *
 * SECURITY (M3 gate, hardened after review):
 * - The `AbortSignal` threads to the provider's `stream()` (→ the upstream `fetch`
 *   reader), so an abort cancels the network call. No event is forwarded after abort.
 * - Run ids are `randomUUID()` (unguessable) and abort is **scoped to the sender that
 *   started the run**, so one renderer/window cannot cancel another's stream.
 * - The renderer-supplied request is validated (mode + string fields; `project` is
 *   re-parsed against the Zod schema) before it reaches the orchestrator.
 * - Runs are bounded by a timeout and aborted when their `webContents` is destroyed,
 *   so a closed window never leaks a running fetch.
 * - Only `AiEvent`s cross the bridge; the API key stays in main.
 */
import { randomUUID } from 'node:crypto';
import {
  assertEditorInteractionReferences,
  type AgentOptions,
  type AgentRunControls,
  type EffectRuntimeObserver,
  type EditorRunControls,
  type EditorRunStageEvent,
  type AiEvent,
  type AiMessage,
  type AskUserAnswer,
  type AskUserGate,
  type ContextInput,
  type StreamOptions,
  type TargetPlatform,
  type TemporalEvidenceAcquirer,
  type VisionRunReviewControls,
  Orchestrator,
  PROVIDER_NAMES,
  createAskUserGate,
} from '@framepilot/ai-sdk';
import { parseProject } from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';
import type {
  AiProviderName,
  AiStreamAgentOptions,
  AiStreamEventMessage,
  AiStreamHistoryMessage,
  AiStreamInteractionContext,
  AiStreamMode,
  AiStreamRequest,
  AiStreamSelection,
  AiStreamUserMemory,
} from '../ipc/contract.js';
import { prepareAiEventForTransport } from './ai-event-transport.js';

export {
  MAX_TOOL_RESULT_TRANSPORT_CHARS,
  prepareAiEventForTransport,
} from './ai-event-transport.js';

const log = createLogger('desktop:ai-stream');

const STREAM_MODES: readonly AiStreamMode[] = [
  'auto',
  'chat',
  'plan',
  'edit',
  'agent',
  'planned-edit',
];
// Sourced from the ai-sdk's own PROVIDER_NAMES rather than hand-duplicated here — a
// renamed/added/removed provider now fails typecheck on this assignment instead of
// silently drifting between the two independently-maintained lists.
const PROVIDERS: readonly AiProviderName[] = PROVIDER_NAMES;
const HISTORY_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'tool']);
const TARGET_PLATFORMS: ReadonlySet<string> = new Set([
  'reels',
  'tiktok',
  'shorts',
  'linkedin',
  'x',
]);
/** Hard cap on history turns accepted over the bridge (the SDK bounds again to 8). */
const MAX_HISTORY = 50;
const MAX_INTERACTION_IDS = 100;
const MAX_INTERACTION_ID_LENGTH = 256;
/** A finite, non-negative number (rejects NaN/Infinity/negative from untrusted input). */
function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validate the optional conversation history from an untrusted renderer request.
 * Drops anything malformed rather than throwing, so one bad entry can't fail a run;
 * caps the count (the SDK bounds the window again). Returns `undefined` when absent.
 */
export function parseHistory(value: unknown): AiStreamHistoryMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid AI stream "history".');
  const out: AiStreamHistoryMessage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const role = record['role'];
    const content = record['content'];
    if (typeof role === 'string' && HISTORY_ROLES.has(role) && typeof content === 'string') {
      out.push({ role: role as AiStreamHistoryMessage['role'], content });
    }
    if (out.length >= MAX_HISTORY) break;
  }
  return out;
}

/** Validate the optional selection range (finite, non-negative, start ≤ end). */
export function parseSelection(value: unknown): AiStreamSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid AI stream "selection".');
  const record = value as Record<string, unknown>;
  const { start, end } = record;
  if (!isFiniteNonNegative(start) || !isFiniteNonNegative(end) || start > end) {
    throw new Error('Invalid AI stream "selection".');
  }
  return { start, end };
}

function parseInteractionIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_INTERACTION_IDS) {
    throw new Error(`Invalid AI stream interaction ${label}.`);
  }
  const ids = value.map((id) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_INTERACTION_ID_LENGTH) {
      throw new Error(`Invalid AI stream interaction ${label}.`);
    }
    return id;
  });
  return [...new Set(ids)];
}

/** Validate the live editor snapshot crossing the untrusted renderer boundary. */
export function parseInteraction(value: unknown): AiStreamInteractionContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid AI stream "interaction".');
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== 2) throw new Error('Unsupported AI interaction context version.');
  const projectRevision = record['projectRevision'];
  const timelineRevision = record['timelineRevision'];
  const sequenceId = record['sequenceId'];
  if (
    !Number.isSafeInteger(projectRevision) ||
    (projectRevision as number) < 0 ||
    !Number.isSafeInteger(timelineRevision) ||
    (timelineRevision as number) < 0 ||
    typeof sequenceId !== 'string' ||
    sequenceId.length === 0 ||
    sequenceId.length > MAX_INTERACTION_ID_LENGTH
  ) {
    throw new Error('Invalid AI stream "interaction" authority.');
  }
  const playhead = record['playhead'];
  if (!playhead || typeof playhead !== 'object') {
    throw new Error('Invalid AI stream interaction playhead.');
  }
  const playheadRecord = playhead as Record<string, unknown>;
  if (
    !isFiniteNonNegative(playheadRecord['seconds']) ||
    !Number.isSafeInteger(playheadRecord['frame']) ||
    (playheadRecord['frame'] as number) < 0
  ) {
    throw new Error('Invalid AI stream interaction playhead.');
  }
  const selection = record['selection'];
  if (!selection || typeof selection !== 'object') {
    throw new Error('Invalid AI stream interaction selection.');
  }
  const selectionRecord = selection as Record<string, unknown>;
  const clipIds = parseInteractionIds(selectionRecord['clipIds'], 'clipIds');
  const trackIds = parseInteractionIds(selectionRecord['trackIds'], 'trackIds');
  const effectLayerIds = parseInteractionIds(
    selectionRecord['effectLayerIds'] ?? [],
    'effectLayerIds',
  );
  const keyframeValue = selectionRecord['keyframes'] ?? [];
  if (!Array.isArray(keyframeValue) || keyframeValue.length > MAX_INTERACTION_IDS) {
    throw new Error('Invalid AI stream interaction keyframes.');
  }
  const keyframes = keyframeValue.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('Invalid AI stream interaction keyframes.');
    }
    const keyframe = value as Record<string, unknown>;
    if (
      typeof keyframe['clipId'] !== 'string' ||
      keyframe['clipId'].length === 0 ||
      keyframe['clipId'].length > MAX_INTERACTION_ID_LENGTH ||
      typeof keyframe['property'] !== 'string' ||
      keyframe['property'].length === 0 ||
      keyframe['property'].length > MAX_INTERACTION_ID_LENGTH ||
      !isFiniteNonNegative(keyframe['time'])
    ) {
      throw new Error('Invalid AI stream interaction keyframes.');
    }
    return {
      clipId: keyframe['clipId'],
      property: keyframe['property'],
      time: keyframe['time'],
    };
  });
  const primaryClipId = selectionRecord['primaryClipId'];
  if (
    primaryClipId !== undefined &&
    (typeof primaryClipId !== 'string' || !clipIds.includes(primaryClipId))
  ) {
    throw new Error('Invalid AI stream interaction primaryClipId.');
  }
  const timeRange = parseSelection(selectionRecord['timeRange']);
  const visibleTimelineRange = parseSelection(record['visibleTimelineRange']);
  const sourceMonitorValue = record['sourceMonitor'];
  let sourceMonitor: AiStreamInteractionContext['sourceMonitor'];
  if (sourceMonitorValue !== undefined) {
    if (!sourceMonitorValue || typeof sourceMonitorValue !== 'object') {
      throw new Error('Invalid AI stream interaction sourceMonitor.');
    }
    const monitor = sourceMonitorValue as Record<string, unknown>;
    const assetId = monitor['assetId'];
    const monitorRate = monitor['rate'];
    const monitorPlayhead = monitor['playhead'];
    if (
      typeof assetId !== 'string' ||
      assetId.length === 0 ||
      assetId.length > MAX_INTERACTION_ID_LENGTH ||
      !monitorRate ||
      typeof monitorRate !== 'object' ||
      !monitorPlayhead ||
      typeof monitorPlayhead !== 'object'
    ) {
      throw new Error('Invalid AI stream interaction sourceMonitor.');
    }
    const monitorRateRecord = monitorRate as Record<string, unknown>;
    if (
      !Number.isSafeInteger(monitorRateRecord['numerator']) ||
      (monitorRateRecord['numerator'] as number) <= 0 ||
      !Number.isSafeInteger(monitorRateRecord['denominator']) ||
      (monitorRateRecord['denominator'] as number) <= 0
    ) {
      throw new Error('Invalid AI stream interaction sourceMonitor.');
    }
    const monitorPlayheadRecord = monitorPlayhead as Record<string, unknown>;
    if (
      !isFiniteNonNegative(monitorPlayheadRecord['seconds']) ||
      !Number.isSafeInteger(monitorPlayheadRecord['frame']) ||
      (monitorPlayheadRecord['frame'] as number) < 0
    ) {
      throw new Error('Invalid AI stream interaction sourceMonitor.');
    }
    const markedRange = monitor['markedRange'];
    if (
      markedRange !== undefined &&
      (!markedRange ||
        typeof markedRange !== 'object' ||
        !Number.isSafeInteger((markedRange as Record<string, unknown>)['startFrame']) ||
        !Number.isSafeInteger((markedRange as Record<string, unknown>)['endFrame']) ||
        ((markedRange as Record<string, unknown>)['startFrame'] as number) < 0 ||
        ((markedRange as Record<string, unknown>)['endFrame'] as number) <=
          ((markedRange as Record<string, unknown>)['startFrame'] as number))
    ) {
      throw new Error('Invalid AI stream interaction sourceMonitor.');
    }
    sourceMonitor = {
      assetId,
      rate: {
        numerator: monitorRateRecord['numerator'] as number,
        denominator: monitorRateRecord['denominator'] as number,
      },
      playhead: {
        seconds: monitorPlayheadRecord['seconds'] as number,
        frame: monitorPlayheadRecord['frame'] as number,
      },
      ...(markedRange
        ? {
            markedRange: {
              startFrame: (markedRange as Record<string, unknown>)['startFrame'] as number,
              endFrame: (markedRange as Record<string, unknown>)['endFrame'] as number,
            },
          }
        : {}),
    };
  }
  return {
    schemaVersion: 2,
    projectRevision: projectRevision as number,
    timelineRevision: timelineRevision as number,
    sequenceId,
    playhead: {
      seconds: playheadRecord['seconds'] as number,
      frame: playheadRecord['frame'] as number,
    },
    selection: {
      ...(primaryClipId === undefined ? {} : { primaryClipId }),
      clipIds,
      trackIds,
      effectLayerIds,
      keyframes,
      ...(timeRange ? { timeRange } : {}),
    },
    ...(visibleTimelineRange ? { visibleTimelineRange } : {}),
    ...(sourceMonitor ? { sourceMonitor } : {}),
  };
}

/**
 * Validate the optional agent options. Numeric caps must be finite non-negative;
 * `targetPlatform` is allowlist-checked; unknown fields are ignored. Returns
 * `undefined` when absent so the loop keeps its defaults.
 */
export function parseAgentOptions(value: unknown): AiStreamAgentOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid AI stream "agentOptions".');
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    'maxSteps',
    'maxOpsPerTurn',
    'maxOpsPerRun',
    'durationTargetSeconds',
  ] as const) {
    const n = record[key];
    if (n !== undefined) {
      if (!isFiniteNonNegative(n)) throw new Error(`Invalid AI stream agentOptions.${key}.`);
      out[key] = n;
    }
  }
  for (const key of ['autoRepair', 'planFirst'] as const) {
    const b = record[key];
    if (b !== undefined) {
      if (typeof b !== 'boolean') throw new Error(`Invalid AI stream agentOptions.${key}.`);
      out[key] = b;
    }
  }
  const platform = record['targetPlatform'];
  if (platform !== undefined) {
    if (typeof platform !== 'string' || !TARGET_PLATFORMS.has(platform)) {
      throw new Error('Invalid AI stream agentOptions.targetPlatform.');
    }
    out['targetPlatform'] = platform;
  }
  return out as AiStreamAgentOptions;
}

/** Max length of a free-text preference (defends against an oversized untrusted string). */
const MAX_PREFERENCE_LEN = 200;
/** Max favourite export platforms accepted over the bridge. */
const MAX_EXPORT_PLATFORMS = 20;

/** A trimmed, length-bounded string, or undefined when absent/empty/non-string. */
function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, MAX_PREFERENCE_LEN);
}

/**
 * Validate the optional user-memory scope from an untrusted renderer request (K6.1).
 * Every free-text field is trimmed + length-capped; `favoriteExportPlatforms` keeps only
 * non-empty strings, bounded in count. Drops malformed input rather than throwing (one bad
 * field must not fail a run). Returns `undefined` when nothing usable is present.
 */
export function parseUserMemory(value: unknown): AiStreamUserMemory | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid AI stream "userMemory".');
  const record = value as Record<string, unknown>;
  const out: {
    targetAudience?: string;
    brandStyle?: string;
    captionStyle?: string;
    preferredPacing?: string;
    favoriteExportPlatforms?: string[];
  } = {};
  for (const key of ['targetAudience', 'brandStyle', 'captionStyle', 'preferredPacing'] as const) {
    const parsed = boundedString(record[key]);
    if (parsed !== undefined) out[key] = parsed;
  }
  const platforms = record['favoriteExportPlatforms'];
  if (Array.isArray(platforms)) {
    const cleaned = platforms
      .map((p) => boundedString(p))
      .filter((p): p is string => p !== undefined)
      .slice(0, MAX_EXPORT_PLATFORMS);
    if (cleaned.length > 0) out.favoriteExportPlatforms = cleaned;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** How long an answer the editor may send back (P12) — bounds the prompt it becomes. */
const MAX_ANSWER_CHARS = 2_000;

/** One editor answer to the model's question, addressed to the call that asked it. */
export interface AiStreamAnswer {
  readonly toolCallId: string;
  readonly answer: AskUserAnswer;
}

/**
 * Validate a renderer-supplied answer (defense in depth — input is untrusted, and this
 * one becomes an instruction the model acts on). Returns `undefined` rather than throwing
 * so a malformed message is dropped without killing a healthy run: the question simply
 * stays pending, exactly as if nobody had clicked yet.
 */
export function parseAiStreamAnswer(value: unknown): AiStreamAnswer | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const toolCallId = record['toolCallId'];
  if (typeof toolCallId !== 'string' || toolCallId === '') return undefined;
  const kind = record['kind'];
  if (kind === 'cancelled') return { toolCallId, answer: { kind: 'cancelled' } };
  if (kind !== 'answered') return undefined;
  const answer = record['answer'];
  // An empty answer is not an answer — treat it as malformed rather than telling the
  // model the editor said nothing at all.
  if (typeof answer !== 'string' || answer.trim() === '') return undefined;
  return {
    toolCallId,
    answer: { kind: 'answered', answer: answer.slice(0, MAX_ANSWER_CHARS) },
  };
}

/** Validate a renderer-supplied stream request (defense in depth — input is untrusted). */
export function parseAiStreamRequest(value: unknown): AiStreamRequest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid AI stream request.');
  }
  const record = value as Record<string, unknown>;
  const mode = record['mode'];
  if (typeof mode !== 'string' || !STREAM_MODES.includes(mode as AiStreamMode)) {
    throw new Error(`Invalid AI stream mode: ${String(mode)}`);
  }
  for (const key of ['userPrompt', 'conversationId', 'turnId'] as const) {
    if (typeof record[key] !== 'string') throw new Error(`Invalid AI stream "${key}".`);
  }
  const provider = record['provider'];
  if (provider !== undefined && !PROVIDERS.includes(provider as AiProviderName)) {
    throw new Error(`Invalid AI provider: ${String(provider)}`);
  }
  const history = parseHistory(record['history']);
  const selection = parseSelection(record['selection']);
  const interaction = parseInteraction(record['interaction']);
  const userMemory = parseUserMemory(record['userMemory']);
  const agentOptions = parseAgentOptions(record['agentOptions']);
  // The deterministic recipe route is gone: a request still carrying its payload is a
  // stale renderer (or a probe), and silently ignoring an instruction we will not follow
  // is how a caller ends up believing work was requested that never was.
  if (record['recipeRequest'] !== undefined) {
    throw new Error('AI stream "recipeRequest" is no longer supported.');
  }
  const durableRunId = record['durableRunId'];
  if (durableRunId !== undefined && (typeof durableRunId !== 'string' || durableRunId === '')) {
    throw new Error('Invalid AI stream "durableRunId".');
  }
  const projectId = record['projectId'];
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId === '')) {
    throw new Error('Invalid AI stream "projectId".');
  }
  const projectRevision = record['projectRevision'];
  if (
    projectRevision !== undefined &&
    (!Number.isSafeInteger(projectRevision) || (projectRevision as number) < 0)
  ) {
    throw new Error('Invalid AI stream "projectRevision".');
  }
  // `project` is re-validated against the Zod schema inside runAiStream.
  return {
    mode: mode as AiStreamMode,
    ...(record['project'] === undefined ? {} : { project: record['project'] }),
    ...(projectId === undefined ? {} : { projectId: projectId as string }),
    ...(projectRevision === undefined ? {} : { projectRevision: projectRevision as number }),
    userPrompt: record['userPrompt'] as string,
    conversationId: record['conversationId'] as string,
    turnId: record['turnId'] as string,
    ...(provider !== undefined ? { provider: provider as AiProviderName } : {}),
    ...(history !== undefined ? { history } : {}),
    ...(selection !== undefined ? { selection } : {}),
    ...(interaction !== undefined ? { interaction } : {}),
    ...(userMemory !== undefined ? { userMemory } : {}),
    ...(agentOptions !== undefined ? { agentOptions } : {}),
    ...(durableRunId !== undefined ? { durableRunId } : {}),
  };
}

/**
 * One optional context block for this run, or `undefined` when there is no reader, no
 * project id, or the read fails. Never throws: these are enrichment, and a run must not
 * die because the sidecar was busy.
 */
async function readOptionalContext(
  reader: ((projectId: string) => Promise<string | undefined>) | undefined,
  projectId: string | undefined,
  label: string,
): Promise<string | undefined> {
  if (!reader || projectId === undefined || projectId === '') return undefined;
  try {
    return await reader(projectId);
  } catch (error) {
    log.debug(`${label} unavailable for this run`, {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Dispatch to the orchestrator stream for `mode`. */
function streamFor(
  orchestrator: Orchestrator,
  mode: AiStreamMode,
  input: ContextInput,
  options: StreamOptions,
  agentOptions: AgentOptions,
  controls: EditorRunControls,
): AsyncGenerator<AiEvent> {
  switch (mode) {
    case 'auto':
      // Model-routed entry point (ADR 0055): classify then delegate in-process. The
      // main-process orchestrator has the sidecar executor, so an `auto` run that
      // classifies to an edit runs it here exactly as the browser does locally.
      return orchestrator.streamAuto(input, options, {
        agentOptions,
        ...(controls.agent === undefined ? {} : { controls: controls.agent }),
        ...(controls.onLifecycleEvent === undefined
          ? {}
          : { onLifecycleEvent: controls.onLifecycleEvent }),
        ...(controls.temporalEvidence === undefined
          ? {}
          : { temporalEvidence: controls.temporalEvidence }),
        ...(controls.visionReview === undefined
          ? {}
          : { visionReview: controls.visionReview }),
      });
    case 'chat':
      // E5.5: chat/question turns can `ask_user` — thread the run's controls (the IPC
      // ask gate) so the renderer's answer reaches the paused run, as in agent mode.
      return orchestrator.streamChat(input, options, {
        ...(controls.agent === undefined ? {} : { controls: controls.agent }),
      });
    case 'plan':
      return orchestrator.streamPlan(input, options);
    case 'edit':
      return orchestrator.streamEditorRun(input, options, { route: 'edit' }, controls);
    case 'agent':
      return orchestrator.streamEditorRun(
        input,
        options,
        { route: 'agent', agentOptions },
        controls,
      );
    case 'planned-edit':
      return orchestrator.streamEditorRun(input, options, { route: 'planned_edit' }, controls);
  }
}

/**
 * Run a streaming AI request, forwarding each event to `onEvent`. Re-validates the
 * project against the Zod schema (no un-validated project enters the orchestrator) and
 * threads the validated history/selection into context + agent options into the loop, so
 * the desktop app runs the same coherent, scoped, robust agent as the browser path.
 */
export async function runAiStream(
  orchestrator: Orchestrator,
  request: AiStreamRequest,
  onEvent: (event: AiEvent) => void | Promise<void>,
  signal: AbortSignal,
  /**
   * Live execution hooks for this run (P12). The kernel's command boundary is plain
   * marshallable data and a Promise cannot cross the IPC bridge — so the GATE lives here
   * in main, beside the orchestrator it serves. The model's question crosses to the
   * renderer as an ordinary `ask` event on the existing push channel, and the answer
   * comes back as an ordinary IPC call that resolves the gate. Nothing live is
   * marshalled; only the run keeps a live object, which it always could.
   */
  controls: EditorRunControls = {},
  /**
   * Reads this project's visual-index status line (see `HubOptions.visualStatusFor`).
   * Awaited once per run, before the first model call, and never allowed to fail the run.
   */
  visualStatusFor?: (projectId: string) => Promise<string | undefined>,
  /** Reads this project's cached footage-map digest (see `HubOptions.footageMapFor`). */
  footageMapFor?: (projectId: string) => Promise<string | undefined>,
): Promise<void> {
  const project = parseProject(request.project);
  if (request.interaction) assertEditorInteractionReferences(project, request.interaction);
  // What the model can SEE is project state it must know BEFORE it answers, not after a
  // tool comes back empty. Without this the run started blind about its own capability:
  // asked what was on screen, the model reasoned from the timeline summary — which cannot
  // see — and reported the evidence insufficient while search_visual sat unused.
  // Strictly best-effort: a slow or unreachable sidecar degrades to no status block
  // rather than delaying or failing an otherwise good run.
  // Both reads are best-effort context enrichment and are independent, so they overlap
  // rather than queueing one behind the other at the head of every run.
  const [visualStatus, footageMap] = await Promise.all([
    readOptionalContext(visualStatusFor, project.id, 'visual status'),
    readOptionalContext(footageMapFor, project.id, 'footage map'),
  ]);
  const input: ContextInput = {
    project,
    ...(visualStatus === undefined ? {} : { visualStatus }),
    ...(footageMap === undefined ? {} : { footageMap }),
    ...(request.projectRevision === undefined ? {} : { projectRevision: request.projectRevision }),
    userPrompt: request.userPrompt,
    // The structural history/selection/userMemory shapes are validated in
    // parseAiStreamRequest and match the SDK's types; the SDK bounds history again and
    // layers project memory over userMemory (project wins) in the context builder.
    ...(request.history ? { history: request.history as readonly AiMessage[] } : {}),
    ...(request.selection ? { selection: request.selection } : {}),
    ...(request.interaction ? { interaction: request.interaction } : {}),
    // Normalise to the SDK's UserMemory (favoriteExportPlatforms is required there — the
    // context builder spreads it — but optional on the wire type).
    ...(request.userMemory
      ? {
          userMemory: {
            ...request.userMemory,
            favoriteExportPlatforms: [...(request.userMemory.favoriteExportPlatforms ?? [])],
          },
        }
      : {}),
  };
  const options: StreamOptions = {
    conversationId: request.conversationId,
    turnId: request.turnId,
    runId: request.durableRunId ?? request.turnId,
    signal,
  };
  const agentOptions: AgentOptions = request.agentOptions
    ? {
        ...request.agentOptions,
        ...(request.agentOptions.targetPlatform !== undefined
          ? { targetPlatform: request.agentOptions.targetPlatform as TargetPlatform }
          : {}),
      }
    : {};
  log.action('runAiStream start', {
    mode: request.mode,
    provider: request.provider ?? '(active)',
    conversationId: request.conversationId,
    prompt: request.userPrompt?.slice(0, 200),
  });
  let eventCount = 0;
  for await (const event of streamFor(
    orchestrator,
    request.mode,
    input,
    options,
    agentOptions,
    controls,
  )) {
    eventCount += 1;
    // Terminal/interesting events are logged individually; the rest are counted.
    if (event.type === 'status' || event.type === 'error' || event.type === 'timeline_action') {
      log.debug(`event: ${event.type}`, event);
    }
    await onEvent(event);
  }
  log.action('runAiStream finished', { mode: request.mode, events: eventCount });
}

/** The minimal `WebContents` surface the hub needs (so it is testable without Electron). */
export interface StreamSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, message: AiStreamEventMessage): void;
  once(event: 'destroyed', listener: () => void): void;
  removeListener(event: 'destroyed', listener: () => void): void;
}

/**
 * Default hard cap on a single streaming run. **Disabled (`0`)** by product decision:
 * a big multi-tool agent run against a slow or remote backend (e.g. a self-hosted
 * Ollama over an ngrok tunnel) can legitimately run for over an hour, and a fixed cap
 * aborts that healthy work. A run is now bounded only by the model/transport and the
 * user's Stop button — never by a clock. A caller that wants a bound can still pass an
 * explicit `timeoutMs` to {@link AiStreamHub}. `0` (or any non-positive value) means no
 * cap: the backstop timer is simply not armed (see {@link AiStreamHub.start}).
 */
export const AI_STREAM_TIMEOUT_MS = 0;

/** Human-readable reason pushed when {@link AI_STREAM_TIMEOUT_MS} aborts a run. */
export function timeoutMessage(timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  return `AI run exceeded the ${minutes}-minute limit and was stopped. Partial edits (if any) are shown for review.`;
}

interface HubOptions {
  /** The push channel name (`framepilot:ai:stream-event`). */
  readonly eventChannel: string;
  /** Id generator (injectable for tests); defaults to `randomUUID`. */
  readonly newId?: () => string;
  /** Max run duration before the run is aborted. */
  readonly timeoutMs?: number;
  /** Engine-backed temporal review used by every editing route. */
  readonly temporalEvidence?: TemporalEvidenceAcquirer;
  /** Semantic reviewer runtime, normally supplied by the on-demand Subject Intelligence pack. */
  readonly visionReview?: VisionRunReviewControls;
  /**
   * Reads the one-line visual-index status for a project (`createVisualStatusDigester`),
   * injected into every run's context so the model knows whether it can search this
   * footage by content before it tries. Optional and fail-soft: without it the context
   * block is simply absent, exactly as before.
   */
  readonly visualStatusFor?: (projectId: string) => Promise<string | undefined>;
  /**
   * Reads the compact footage-map digest — the time-ordered chapters of what is IN the
   * footage — for a project. Must be a CACHE-ONLY read (`cachedOnly`): this runs before
   * every AI run, and a cache miss that reached for Pegasus would stall the run on a slow
   * generative round-trip and bill for it. Optional and fail-soft, like the status line.
   */
  readonly footageMapFor?: (projectId: string) => Promise<string | undefined>;
}

interface ActiveRun {
  readonly controller: AbortController;
  /** The id of the `WebContents` that started the run — abort is scoped to it. */
  readonly senderId: number;
  /**
   * Resolves the model's questions for this run (P12). One gate per run, held here
   * rather than passed over IPC: the renderer answers by `requestId` + `toolCallId`, so
   * only plain data crosses the bridge.
   */
  readonly askGate: AskUserGate;
  readonly durableRunId?: string;
  abortOrigin?: 'user_stop' | 'application_shutdown' | 'internal_abort';
}

export interface AiStreamSettlement {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly kind: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'timed_out';
  readonly source:
    | 'run_completed'
    | 'user_stop'
    | 'provider'
    | 'timeout'
    | 'application_shutdown'
    | 'internal_error';
  readonly reason?: string;
}

export interface AiStreamRunHooks {
  readonly controls?: AgentRunControls;
  readonly durableRunId?: string;
  readonly effectObserver?: EffectRuntimeObserver;
  /** Canonical editor-run stages, kept separate from renderer presentation events. */
  readonly onLifecycleEvent?: (event: EditorRunStageEvent) => void;
  /** Awaited before the corresponding renderer push. */
  readonly beforePublish?: (
    event: AiEvent,
  ) =>
    | number
    | void
    | { readonly event?: AiEvent; readonly durableSequence?: number }
    | Promise<number | void | { readonly event?: AiEvent; readonly durableSequence?: number }>;
  readonly onSettled?: (settlement: AiStreamSettlement) => void | Promise<void>;
}

/**
 * Manages the lifecycle of streaming AI runs: starts them, scopes events + intentional
 * aborts by `requestId` AND owning sender, and guarantees classified settlement.
 * Destroying a renderer detaches it from a durable run; it does not cancel host-owned
 * execution.
 */
export class AiStreamHub {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly newId: () => string;
  private readonly timeoutMs: number;

  public constructor(
    private readonly orchestratorFor: (
      provider?: AiProviderName,
      effectObserver?: EffectRuntimeObserver,
    ) => Orchestrator,
    private readonly options: HubOptions,
  ) {
    this.newId = options.newId ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? AI_STREAM_TIMEOUT_MS;
  }

  /** Start a run for `sender`; returns the unguessable `requestId`. */
  public start(sender: StreamSender, rawRequest: unknown, hooks: AiStreamRunHooks = {}): string {
    const requestId = this.newId();
    const controller = new AbortController();
    const askGate = createAskUserGate();
    this.runs.set(requestId, {
      controller,
      senderId: sender.id,
      askGate,
      ...(hooks.durableRunId === undefined ? {} : { durableRunId: hooks.durableRunId }),
    });

    let rendererAttached = true;
    const detachRenderer = (reason: 'destroyed' | 'send_failed', error?: unknown): void => {
      if (!rendererAttached) return;
      rendererAttached = false;
      const run = this.runs.get(requestId);
      // Durable execution is host-owned. A renderer reload/remount only loses its
      // projection; the persisted handle can subscribe again without duplicating work.
      if (hooks.durableRunId !== undefined) {
        log.action('renderer detached from durable AI run', {
          requestId,
          runId: hooks.durableRunId,
          senderId: sender.id,
          reason,
          ...(error === undefined
            ? {}
            : { error: error instanceof Error ? error.message : String(error) }),
        });
        return;
      }
      if (run) run.abortOrigin = 'internal_abort';
      controller.abort();
    };
    const push = (message: Omit<AiStreamEventMessage, 'requestId'>): void => {
      if (!rendererAttached) return;
      if (sender.isDestroyed()) {
        detachRenderer('destroyed');
        return;
      }
      try {
        sender.send(this.options.eventChannel, { requestId, ...message });
      } catch (error) {
        // Electron can dispose a frame between `isDestroyed()` and `send()`.
        detachRenderer('send_failed', error);
      }
    };
    const onDestroyed = (): void => detachRenderer('destroyed');
    sender.once('destroyed', onDestroyed);
    // Distinguish the cap firing from a user Stop: both abort the same controller,
    // but a timed-out run must end with an explanatory error, not a silent cancel.
    // A non-positive `timeoutMs` disables the cap entirely — no backstop timer is armed,
    // so a long run is bounded only by the model/transport and the user's Stop button.
    let timedOut = false;
    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, this.timeoutMs)
        : undefined;

    log.action('hub.start — AI run requested', { requestId, senderId: sender.id });
    void (async () => {
      let streamTerminalStatus: 'completed' | 'failed' | 'cancelled' | undefined;
      let settlement: AiStreamSettlement = {
        status: 'completed',
        kind: 'completed',
        source: 'run_completed',
      };
      try {
        const request = parseAiStreamRequest(rawRequest);
        const orchestrator = this.orchestratorFor(request.provider, hooks.effectObserver);
        await runAiStream(
          orchestrator,
          request,
          async (event) => {
            if (
              event.type === 'status' &&
              (event.status === 'completed' ||
                event.status === 'failed' ||
                event.status === 'cancelled')
            ) {
              streamTerminalStatus = event.status;
            }
            const prepared = await hooks.beforePublish?.(event);
            const hookEvent =
              typeof prepared === 'object' && prepared?.event !== undefined
                ? prepared.event
                : event;
            const publishedEvent = prepareAiEventForTransport(hookEvent);
            const durableSequence =
              typeof prepared === 'number'
                ? prepared
                : typeof prepared === 'object'
                  ? prepared?.durableSequence
                  : undefined;
            push({
              event: publishedEvent,
              ...(durableSequence === undefined ? {} : { durableSequence }),
            });
          },
          controller.signal,
          {
            agent: { askUser: askGate, ...hooks.controls },
            ...(hooks.onLifecycleEvent === undefined
              ? {}
              : { onLifecycleEvent: hooks.onLifecycleEvent }),
            ...(this.options.temporalEvidence === undefined
              ? {}
              : { temporalEvidence: this.options.temporalEvidence }),
            ...(this.options.visionReview === undefined
              ? {}
              : { visionReview: this.options.visionReview }),
          },
          this.options.visualStatusFor,
          this.options.footageMapFor,
        );
        if (timedOut) {
          settlement = {
            status: 'failed',
            kind: 'timed_out',
            source: 'timeout',
            reason: timeoutMessage(this.timeoutMs),
          };
          log.warn('hub run hit the max-run cap', { requestId, timeoutMs: this.timeoutMs });
          push({ error: timeoutMessage(this.timeoutMs) });
          return;
        }
        if (controller.signal.aborted) {
          const origin = this.runs.get(requestId)?.abortOrigin;
          settlement =
            origin === 'user_stop'
              ? {
                  status: 'cancelled',
                  kind: 'cancelled',
                  source: 'user_stop',
                  reason: 'Stopped by the editor.',
                }
              : {
                  status: 'failed',
                  kind: 'interrupted',
                  source:
                    origin === 'application_shutdown' ? 'application_shutdown' : 'internal_error',
                  reason:
                    origin === 'application_shutdown'
                      ? 'The application shut down before the run finished.'
                      : 'The run was interrupted before it finished.',
                };
        } else if (streamTerminalStatus === 'failed') {
          settlement = {
            status: 'failed',
            kind: 'failed',
            source: 'internal_error',
            reason: 'The run stopped because integrity or verification did not pass.',
          };
        } else if (streamTerminalStatus === 'cancelled') {
          settlement = {
            status: 'cancelled',
            kind: 'cancelled',
            source: 'user_stop',
            reason: 'The run was cancelled before completion.',
          };
        }
        log.action('hub.start — AI run done', { requestId });
        push({ done: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (timedOut) {
          settlement = {
            status: 'failed',
            kind: 'timed_out',
            source: 'timeout',
            reason: timeoutMessage(this.timeoutMs),
          };
        } else if (controller.signal.aborted) {
          const origin = this.runs.get(requestId)?.abortOrigin;
          settlement =
            origin === 'user_stop'
              ? { status: 'cancelled', kind: 'cancelled', source: 'user_stop', reason }
              : {
                  status: 'failed',
                  kind: 'interrupted',
                  source:
                    origin === 'application_shutdown' ? 'application_shutdown' : 'internal_error',
                  reason,
                };
        } else {
          settlement = {
            status: 'failed',
            kind: 'failed',
            source: 'provider',
            reason,
          };
        }
        log.error('hub.start — AI run errored', {
          requestId,
          error: reason,
        });
        push({ error: reason });
      } finally {
        if (timer) clearTimeout(timer);
        sender.removeListener('destroyed', onDestroyed);
        this.runs.delete(requestId);
        try {
          await hooks.onSettled?.(settlement);
        } catch (error) {
          log.error('hub.start — durable settlement failed', {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return requestId;
  }

  /** Abort a run — only if `sender` is the one that started it (cross-sender abort is ignored). */
  public abort(sender: StreamSender, requestId: unknown): void {
    const run = this.runs.get(String(requestId));
    if (run && run.senderId === sender.id) {
      if (run.durableRunId !== undefined) {
        log.warn('legacy request abort ignored for durable run', {
          requestId,
          runId: run.durableRunId,
        });
        return;
      }
      run.abortOrigin = 'user_stop';
      run.controller.abort();
    }
  }

  /** Cancel by durable identity after a renderer reload loses the legacy request id. */
  public abortDurable(runId: string): void {
    for (const run of this.runs.values()) {
      if (run.durableRunId === runId) {
        run.abortOrigin = 'user_stop';
        run.controller.abort();
      }
    }
  }

  /** Fail a durable run when host authority rejects its next mutation (never a user stop). */
  public failDurable(runId: string): void {
    for (const run of this.runs.values()) {
      if (run.durableRunId === runId) {
        run.abortOrigin = 'internal_abort';
        run.controller.abort();
      }
    }
  }

  /**
   * Answer the model's pending question for `requestId` (P12).
   *
   * Scoped to the owning sender exactly like {@link abort}: this crosses the renderer
   * trust boundary, and an answer is an instruction the model will act on — so another
   * window must not be able to answer this run's question. Unknown/foreign/stale ids are
   * ignored rather than throwing; the gate itself also drops an answer whose
   * `toolCallId` is not the pending one.
   */
  public answer(sender: StreamSender, rawRequestId: unknown, rawAnswer: unknown): void {
    const run = this.runs.get(String(rawRequestId));
    if (!run || run.senderId !== sender.id) {
      log.warn('hub.answer — no matching run for this sender', { requestId: rawRequestId });
      return;
    }
    const parsed = parseAiStreamAnswer(rawAnswer);
    if (!parsed) {
      log.warn('hub.answer — malformed answer ignored', { requestId: rawRequestId });
      return;
    }
    log.action('hub.answer — routing the editor’s answer', {
      requestId: rawRequestId,
      toolCallId: parsed.toolCallId,
      kind: parsed.answer.kind,
    });
    run.askGate.resolve(parsed.toolCallId, parsed.answer);
  }

  /** Abort every in-flight run (app shutdown). */
  public abortAll(): void {
    for (const run of this.runs.values()) {
      run.abortOrigin = 'application_shutdown';
      run.controller.abort();
    }
  }

  /** Number of in-flight runs (for diagnostics/tests). */
  public activeCount(): number {
    return this.runs.size;
  }
}
