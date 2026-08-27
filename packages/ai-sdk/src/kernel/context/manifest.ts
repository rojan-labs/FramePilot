/**
 * @framepilot/ai-sdk/kernel/context/manifest — what went into one model request, and
 * what it cost (ADR 0080).
 *
 * ## Why this exists
 *
 * The composer used to render a single number labelled "Context", derived from one
 * `context_usage` event carrying `{usedTokens, contextWindow, estimated}`. That number
 * legitimately moves between requests — one call carries a large tool result, the next
 * replaces it with a summary; one stage loads a skill, another does not; the budgeter
 * trims a tier — but with nothing to attribute the movement to, a drop from 60K to 12K
 * reads as "my conversation was erased". It was not: the durable run memory, the project
 * memory and the committed decisions all survived. The prompt just got smaller.
 *
 * A manifest is the missing attribution. It records, per request, which sections were
 * included, which were omitted and why, what each cost, how much room the model has, and
 * how much of that room is reserved for the reply. The UI reads it instead of
 * reverse-engineering occupancy from scattered counters, and the dev inspector diffs two
 * of them to answer "why did this change" exactly.
 *
 * ## The four numbers that are not the same number
 *
 * 1. `modelContextLimit` — the selected model's window. Capacity, not usage.
 * 2. `reservedOutputTokens` — held back for the reply. Never available to the prompt.
 * 3. `estimatedInputTokensBeforeSend` / `providerReportedInputTokens` — what THIS request
 *    occupies. An estimate until the provider settles; never presented as exact before.
 * 4. `estimatedRemainingCapacity` — window − input − reservation. What is left.
 *
 * None of them is "how much the conversation remembers". Durable memory is a separate
 * concern with its own lifetime ({@link DurableMemoryStatus}), and the manifest carries a
 * summary of it precisely so the UI can say "memory intact" while the prompt shrinks.
 *
 * Pure and deterministic: no clock, no I/O. The caller stamps ids and timestamps.
 */
import { createLogger } from '@framepilot/shared-types';
import { type AssembledSection, estimateTokens } from '../../context-builder.js';
import type { CapabilitySource } from '../../providers/model-capabilities.js';
import type { AiCompletionRequest, AiMessage, ProviderName } from '../../providers/types.js';
import {
  type RunWorkingState,
  committedDecisions,
  isInterpreted,
  liveEvidence,
  remainingObjectives,
} from '../working-state.js';

const log = createLogger('ai-sdk:kernel:context');

/**
 * What a manifest section is. Deliberately coarser than the assembler's tiers: the UI
 * groups by *kind of memory*, not by the budgeter's drop order.
 */
export type ContextSectionType =
  | 'system'
  | 'conversation'
  | 'run_memory'
  | 'project_memory'
  | 'skill'
  | 'tool_result'
  | 'retrieved_evidence'
  | 'tool_schemas'
  | 'latest_user_message';

export interface ContextSection {
  /** Stable within one manifest; used to pair sections when diffing two requests. */
  readonly id: string;
  readonly type: ContextSectionType;
  /** Human-readable name, e.g. "footage map" or "transcript slice". */
  readonly label: string;
  readonly tokenEstimate: number;
  /** False when the section was built but dropped to fit the budget. */
  readonly included: boolean;
  /** Why an omitted section is missing — never left to the reader to infer. */
  readonly omittedReason?: string;
  /** Where the content came from: an evidence handle, a fact id, a skill name. */
  readonly sourceReference?: string;
  /** The project revision this content describes, when it is revision-dependent. */
  readonly revision?: number;
  /**
   * Which side of the request's cache breakpoint this section landed on.
   *
   * `cached_prefix` is re-sent byte-identically and can be served from the provider's
   * prompt cache; `per_turn` is re-billed at full price every call by construction.
   * Absent when the caller does not place a breakpoint (every non-agent route).
   *
   * Reported because the split was the one thing the manifest could not show. The agent
   * loop draws the line carefully — `context-builder.ts`'s `ContextSplit`, then
   * `cacheBoundary` on the message — and a reader of the manifest could see 105 requests
   * of 19k–42k tokens without being able to tell which part of any of them was paid for
   * twice. See {@link RequestTokenUsage.toolSchemaTokensRebilled} for the same principle
   * applied to the tool block.
   */
  readonly cacheSide?: 'cached_prefix' | 'per_turn';
}

/** How a token figure was arrived at. Never conflated in the UI. */
export type TokenCalculationSource = 'local_estimate' | 'provider_reported';

export interface RequestTokenUsage {
  readonly modelContextLimit: number;
  /** True when the limit is the provider's floor rather than a known model's real window. */
  readonly limitAssumed: boolean;
  readonly estimatedInputTokensBeforeSend: number;
  readonly providerReportedInputTokens?: number;
  readonly reservedOutputTokens: number;
  readonly providerReportedOutputTokens?: number;
  /** Prompt-cache hits, when the provider reports them. Part of input, not extra. */
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  /** limit − (reported ?? estimated) input − reservation, floored at zero. */
  readonly estimatedRemainingCapacity: number;
  /**
   * Tool-schema tokens re-billed at FULL price this request because the advertised tool
   * set changed since the previous one (context-management P5.3).
   *
   * The tool block is ~78% of a planning prompt and sits ABOVE the messages in the
   * provider's cache hierarchy, so changing it invalidates everything cached beneath.
   * The stage policy swaps the descriptor set twice in a nine-turn run — measured at
   * 30,751 tokens re-billed — and until now that cost was invisible: the cost meter sees
   * input tokens, not *why* they were not cached.
   *
   * This does not change what is advertised. It makes the price of the current policy a
   * number, so the decision to keep or change it can be made against evidence rather
   * than against an argument. `0` means the set was stable; absent means there was no
   * previous request to compare against.
   */
  readonly toolSchemaTokensRebilled?: number;
  readonly calculationSource: TokenCalculationSource;
}

/**
 * The state of memory that OUTLIVES this request — the answer to "did I lose anything?"
 * when the prompt shrinks. Absent for a call made outside a run (classification, a
 * one-shot chat) rather than faked.
 */
export interface DurableMemoryStatus {
  readonly runId: string;
  readonly stage: string;
  readonly projectRevision: number;
  readonly objectiveKnown: boolean;
  readonly committedDecisions: number;
  readonly facts: number;
  readonly evidenceHandles: number;
  readonly remainingObjectives: number;
  /** The one instruction the next turn is under, when the run has written one. */
  readonly nextAction?: string;
}

/**
 * Project a run's task memory (ADR 0075) into the manifest's memory summary.
 *
 * Counts and one-liners only — never the content. The point is to let the UI answer
 * "did I lose anything?" without shipping the run's whole ledger into every telemetry
 * event, and without tempting a reader to treat the manifest as the memory itself. The
 * project file and the reversible patch log remain the source of truth.
 */
export function memoryStatusFrom(working: RunWorkingState): DurableMemoryStatus {
  const nextAction = working.nextAction?.action;
  return {
    runId: working.runId,
    stage: working.stage,
    projectRevision: working.currentProjectRevision,
    objectiveKnown: isInterpreted(working),
    committedDecisions: committedDecisions(working).length,
    facts: working.facts.length,
    evidenceHandles: liveEvidence(working).length,
    remainingObjectives: remainingObjectives(working).length,
    ...(nextAction ? { nextAction } : {}),
  };
}

export interface CompactionRecord {
  readonly occurred: boolean;
  readonly removedTokenEstimate: number;
  /** Which tiers were dropped — the honest, specific answer to "what went missing". */
  readonly removedSections: readonly string[];
}

export interface ContextManifest {
  readonly requestId: string;
  readonly provider: ProviderName | 'unknown';
  readonly model: string;
  readonly sections: readonly ContextSection[];
  readonly usage: RequestTokenUsage;
  readonly compaction: CompactionRecord;
  readonly memory?: DurableMemoryStatus;
}

/**
 * Map an assembler tier onto the manifest's memory-kind taxonomy. The mapping is the
 * editorial claim of this module: a "memory" tier block is project memory, a transcript
 * or footage slice is retrieved evidence rather than conversation, and the skills
 * manifest is its own kind because the user asks about it by name.
 */
function sectionTypeFor(section: AssembledSection): ContextSectionType {
  switch (section.tier) {
    case 'system':
      return 'system';
    case 'history':
      return 'conversation';
    case 'memory':
      return 'project_memory';
    case 'skills':
      return 'skill';
    case 'timeline':
    case 'transcript':
      return 'retrieved_evidence';
    case 'selection':
    case 'pinned':
      return 'latest_user_message';
    case 'prompt':
      return section.label === 'user request' ? 'latest_user_message' : 'system';
    /* v8 ignore next 2 -- exhaustive over ContextTier; unreachable by construction */
    default:
      return 'system';
  }
}

/** The reason line shown against an omitted section. */
const TRIMMED_TO_FIT = 'trimmed to fit the model context budget';

export interface ManifestInput {
  readonly requestId: string;
  readonly provider?: ProviderName;
  readonly model?: string;
  readonly contextWindow: number;
  readonly windowSource: CapabilitySource;
  readonly reservedOutputTokens: number;
  /** Section costs from `assembleContext`, plus anything the caller adds (tool schemas). */
  readonly sections: readonly AssembledSection[];
  /** Tokens the tool schemas occupy — real prompt cost the assembler cannot see. */
  readonly toolSchemaTokens?: number;
  /** The previous request's tool-schema cost, when there was one (see the usage field). */
  readonly previousToolSchemaTokens?: number;
  /** The whole-request estimate, including anything not itemised in `sections`. */
  readonly estimatedInputTokens: number;
  readonly droppedTokenEstimate: number;
  readonly memory?: DurableMemoryStatus;
  /**
   * Index of the message carrying this request's cache breakpoint, when one was placed.
   *
   * Sections at or above it are the cached prefix; everything after is re-billed per turn.
   * Absent ⇒ no breakpoint, and no section claims a side.
   */
  readonly cacheBoundaryIndex?: number;
  /**
   * True when `sections` is an ASSEMBLED tier account rather than one section per message.
   *
   * Those tiers were folded into fewer messages than there are sections, so an index into
   * one is not an index into the other and no section may claim a cache side from it.
   */
  readonly assembledSections?: boolean;
}

/**
 * Build the manifest for a request that is about to be sent. Every figure is a local
 * estimate at this point — {@link withProviderUsage} replaces the input count once the
 * provider reports one.
 *
 * @param input - Assembly output plus the resolved model capacity.
 * @returns A complete manifest with `calculationSource: 'local_estimate'`.
 */
export function buildManifest(input: ManifestInput): ContextManifest {
  const boundaryIndex = input.cacheBoundaryIndex ?? -1;
  const sections: ContextSection[] = input.sections.map((section, index) => ({
    id: `s${index + 1}`,
    type: sectionTypeFor(section),
    label: section.label,
    tokenEstimate: section.tokenEstimate,
    included: section.included,
    ...(section.included ? {} : { omittedReason: TRIMMED_TO_FIT }),
    // Sections map to messages in order on the payload-derived path, so the boundary index
    // lands on the right one. An ASSEMBLED account does not map 1:1 (its tiers were folded
    // into fewer messages), so it claims no side rather than guessing at one.
    ...(input.assembledSections === true
      ? {}
      : (() => {
          const side = cacheSideFor(index, boundaryIndex);
          return side === undefined ? {} : { cacheSide: side };
        })()),
  }));
  if (input.toolSchemaTokens && input.toolSchemaTokens > 0) {
    sections.push({
      id: `s${sections.length + 1}`,
      type: 'tool_schemas',
      label: 'tool definitions',
      tokenEstimate: input.toolSchemaTokens,
      included: true,
      // Tools precede the messages in every provider's cache ordering, so a breakpoint
      // anywhere in the messages caches them. This is the section that most needs saying:
      // it was 60.2% of captured run `e36235cc`'s entire input.
      ...(boundaryIndex < 0 ? {} : { cacheSide: 'cached_prefix' as const }),
    });
  }

  const removedSections = input.sections.filter((s) => !s.included).map((s) => s.label);
  const manifest: ContextManifest = {
    requestId: input.requestId,
    provider: input.provider ?? 'unknown',
    model: input.model ?? 'unknown',
    sections,
    usage: {
      modelContextLimit: input.contextWindow,
      limitAssumed: input.windowSource === 'provider_default',
      estimatedInputTokensBeforeSend: input.estimatedInputTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      estimatedRemainingCapacity: remainingCapacity(
        input.contextWindow,
        input.estimatedInputTokens,
        input.reservedOutputTokens,
      ),
      ...(input.previousToolSchemaTokens === undefined
        ? {}
        : {
            toolSchemaTokensRebilled:
              input.previousToolSchemaTokens === (input.toolSchemaTokens ?? 0)
                ? 0
                : (input.toolSchemaTokens ?? 0),
          }),
      calculationSource: 'local_estimate',
    },
    compaction: {
      occurred: input.droppedTokenEstimate > 0,
      removedTokenEstimate: input.droppedTokenEstimate,
      removedSections,
    },
    ...(input.memory ? { memory: input.memory } : {}),
  };

  log.debug('context.manifest.built', {
    requestId: manifest.requestId,
    model: manifest.model,
    sections: sections.length,
    omitted: removedSections.length,
    estimatedInputTokens: input.estimatedInputTokens,
  });
  return manifest;
}

/**
 * Itemise a request payload that did NOT come from `assembleContext`.
 *
 * The agent loop assembles its messages itself (`agentMessages` — contract, plan, pinned
 * skills, briefing, action log), so there is no tier account to read. Rather than leave
 * those calls with no manifest — which is where the "unexplained number" problem lives —
 * derive sections from the payload the provider will actually receive: the system
 * contract, each prior turn, and the final message. Coarser than the assembler's account,
 * and honest about being so, but every figure is real.
 */
/**
 * Which side of the cache breakpoint a message lands on.
 *
 * A breakpoint caches everything BEFORE it inclusive, so the boundary message and every
 * message above it are the cached prefix and everything after it is re-billed per turn.
 * `boundaryIndex < 0` means the caller placed no breakpoint, and nothing is claimed.
 */
function cacheSideFor(index: number, boundaryIndex: number): ContextSection['cacheSide'] {
  if (boundaryIndex < 0) return undefined;
  return index <= boundaryIndex ? 'cached_prefix' : 'per_turn';
}

/** The last message the caller flagged as the cache breakpoint, or `-1` for none. */
export function cacheBoundaryIndex(messages: readonly AiMessage[]): number {
  return messages.reduce(
    (last, message, index) => (message.cacheBoundary === true ? index : last),
    -1,
  );
}

function sectionsFromMessages(messages: readonly AiMessage[]): AssembledSection[] {
  const lastIndex = messages.length - 1;
  return messages
    .map((message, index): AssembledSection => {
      const tokenEstimate = estimateTokens(message.content);
      if (message.role === 'system') {
        return { tier: 'system', label: 'system contract', tokenEstimate, included: true };
      }
      // Labelled the same as the assembler's final block on purpose: `diffManifests`
      // pairs by label, so a run that switches between an assembled and a
      // payload-derived manifest still lines its request block up with itself.
      if (index === lastIndex) {
        return { tier: 'prompt', label: 'user request', tokenEstimate, included: true };
      }
      return {
        tier: 'history',
        label: `${message.role} turn ${index}`,
        tokenEstimate,
        included: true,
      };
    })
    .filter((section) => section.tokenEstimate > 0);
}

/**
 * Reconcile a tier account against the payload it was folded into.
 *
 * Some callers append to the assembled messages before sending (a mode instruction, a
 * repair pass note), so the sections do not add up to the request. Rather than let the
 * breakdown quietly under-report — which would make the debugger's arithmetic wrong and
 * hand the user back the same "where did the tokens go" question — the difference is
 * shown as its own row. A negative difference (the caller sent LESS than it assembled)
 * adds nothing: there is no honest row to draw for content that was never sent.
 */
function withRemainder(
  sections: readonly AssembledSection[],
  messageTokens: number,
): AssembledSection[] {
  const accounted = sections.filter((s) => s.included).reduce((sum, s) => sum + s.tokenEstimate, 0);
  const remainder = messageTokens - accounted;
  if (remainder <= 0) return [...sections];
  return [
    ...sections,
    {
      tier: 'prompt',
      label: 'additional request content',
      tokenEstimate: remainder,
      included: true,
    },
  ];
}

/**
 * What a tool set costs as prompt.
 *
 * One owner, because two would drift: the manifest REPORTS this figure and the context
 * budgeter DECIDES against it (`ContextBudget.reservedPromptTokens`), and a budget that
 * disagrees with the manifest is exactly the condition ADR 0080 was written to end.
 */
export function toolSchemaCost(tools: AiCompletionRequest['tools']): number {
  return tools && tools.length > 0 ? estimateTokens(JSON.stringify(tools)) : 0;
}

export interface RequestManifestInput {
  readonly requestId: string;
  readonly provider?: ProviderName;
  readonly model?: string;
  readonly contextWindow: number;
  readonly windowSource: CapabilitySource;
  readonly reservedOutputTokens: number;
  /** The exact payload heading for the provider — the only thing that is truly billed. */
  readonly request: AiCompletionRequest;
  /**
   * The tier account from `assembleContext`, when the caller has one. Supplying it
   * replaces the coarse message-derived breakdown with the real per-block detail, and is
   * the ONLY way a dropped section can be reported — a trimmed tier leaves no trace in
   * the payload, so a payload-derived manifest can never know compaction happened.
   */
  readonly assembled?: {
    readonly sections: readonly AssembledSection[];
    readonly droppedTokenEstimate: number;
  };
  readonly memory?: DurableMemoryStatus;
  /**
   * The tool-schema cost of the PREVIOUS request, when the caller tracks one. Supplying
   * it turns "how many input tokens" into "how many of them were re-billed because the
   * advertised tool set moved" — see {@link RequestTokenUsage.toolSchemaTokensRebilled}.
   */
  readonly previousToolSchemaTokens?: number;
}

/**
 * Build the manifest for a request from the payload itself, so every model call is
 * accounted for — including the agent-loop calls that never touch `assembleContext`.
 *
 * The input estimate covers the whole payload, tool schemas included: a tool set is real
 * prompt cost, and leaving it out was one reason the old indicator under-reported.
 */
export function buildRequestManifest(input: RequestManifestInput): ContextManifest {
  const toolSchemaTokens = toolSchemaCost(input.request.tools);
  const messageTokens = input.request.messages.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0,
  );
  const boundaryIndex = cacheBoundaryIndex(input.request.messages);
  const sections = input.assembled
    ? withRemainder(input.assembled.sections, messageTokens)
    : sectionsFromMessages(input.request.messages);
  return buildManifest({
    requestId: input.requestId,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    contextWindow: input.contextWindow,
    windowSource: input.windowSource,
    reservedOutputTokens: input.reservedOutputTokens,
    sections,
    toolSchemaTokens,
    ...(input.previousToolSchemaTokens === undefined
      ? {}
      : { previousToolSchemaTokens: input.previousToolSchemaTokens }),
    // Estimated from the payload, never from the section sum: a section account can
    // omit or double-count, and the payload is what the provider actually charges for.
    estimatedInputTokens: messageTokens + toolSchemaTokens,
    droppedTokenEstimate: input.assembled?.droppedTokenEstimate ?? 0,
    ...(input.memory ? { memory: input.memory } : {}),
    ...(boundaryIndex < 0 ? {} : { cacheBoundaryIndex: boundaryIndex }),
    ...(input.assembled ? { assembledSections: true } : {}),
  });
}

/** Room left for more prompt: window minus what this request uses minus the reservation. */
function remainingCapacity(window: number, input: number, reserved: number): number {
  return Math.max(0, window - input - reserved);
}

/**
 * Fold a provider's settled usage into a manifest, replacing the local estimate with the
 * reported figure and re-deriving remaining capacity from it.
 *
 * The pre-send estimate is KEPT alongside, not overwritten: the gap between the two is
 * how the estimator's drift is measured, and hiding it would make the heuristic
 * unfalsifiable. A provider that reports no input usage leaves the manifest an estimate
 * — the UI keeps saying "estimated" rather than promoting a guess to a fact.
 *
 * @param manifest - The pre-send manifest.
 * @param usage - Whatever the provider actually reported; fields it omits stay absent.
 * @returns A new manifest; the input is never mutated.
 */
export function withProviderUsage(
  manifest: ContextManifest,
  usage: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    /**
     * What the PROVIDER layer calls the same number (`reliability/types.ts#Usage`).
     *
     * Both spellings are accepted because only one of them was ever sent. Every caller
     * passes a provider `Usage`, which carries `cacheReadInputTokens`; this function read
     * `cachedInputTokens`, which nothing produced. So `cachedInputTokens` was `undefined`
     * on every manifest ever built, and a run's cache-hit rate was structurally
     * unknowable — captured run `e36235cc` reports "cache not reported by this provider"
     * for exactly this reason, whatever the provider actually did.
     */
    readonly cacheReadInputTokens?: number;
    readonly reasoningTokens?: number;
  },
): ContextManifest {
  const reportedInput = usage.inputTokens;
  const cachedInput = usage.cachedInputTokens ?? usage.cacheReadInputTokens;
  const effectiveInput = reportedInput ?? manifest.usage.estimatedInputTokensBeforeSend;
  const next: ContextManifest = {
    ...manifest,
    usage: {
      ...manifest.usage,
      ...(reportedInput !== undefined ? { providerReportedInputTokens: reportedInput } : {}),
      ...(usage.outputTokens !== undefined
        ? { providerReportedOutputTokens: usage.outputTokens }
        : {}),
      ...(cachedInput !== undefined ? { cachedInputTokens: cachedInput } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      estimatedRemainingCapacity: remainingCapacity(
        manifest.usage.modelContextLimit,
        effectiveInput,
        manifest.usage.reservedOutputTokens,
      ),
      calculationSource: reportedInput === undefined ? 'local_estimate' : 'provider_reported',
    },
  };
  log.debug('context.provider_usage.received', {
    requestId: manifest.requestId,
    reportedInput,
    estimated: manifest.usage.estimatedInputTokensBeforeSend,
  });
  return next;
}

/** The input figure the UI should show: reported when available, else the estimate. */
export function effectiveInputTokens(manifest: ContextManifest): number {
  return (
    manifest.usage.providerReportedInputTokens ?? manifest.usage.estimatedInputTokensBeforeSend
  );
}

/** One section's difference between two manifests. */
export interface SectionDelta {
  readonly label: string;
  readonly type: ContextSectionType;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly change: 'added' | 'removed' | 'grew' | 'shrank' | 'unchanged';
}

export interface ManifestDiff {
  readonly beforeRequestId: string;
  readonly afterRequestId: string;
  readonly inputTokenDelta: number;
  readonly modelChanged: boolean;
  readonly sections: readonly SectionDelta[];
}

/**
 * Compare two consecutive manifests, so "the number moved" always has a cause attached.
 *
 * Sections are paired by `label` rather than by `id`: ids are positional and shift the
 * moment one section drops out, which would report every later section as replaced.
 * Unchanged sections are retained in the result — the caller decides whether to show
 * them, and dropping them here would make an all-quiet diff indistinguishable from a
 * failed comparison.
 */
export function diffManifests(before: ContextManifest, after: ContextManifest): ManifestDiff {
  const tokensOf = (m: ContextManifest): Map<string, ContextSection> =>
    new Map(m.sections.filter((s) => s.included).map((s) => [s.label, s]));
  const beforeById = tokensOf(before);
  const afterById = tokensOf(after);

  const labels = [...new Set([...beforeById.keys(), ...afterById.keys()])];
  const sections: SectionDelta[] = labels.map((label) => {
    const b = beforeById.get(label);
    const a = afterById.get(label);
    const beforeTokens = b?.tokenEstimate ?? 0;
    const afterTokens = a?.tokenEstimate ?? 0;
    const change: SectionDelta['change'] = !b
      ? 'added'
      : !a
        ? 'removed'
        : afterTokens > beforeTokens
          ? 'grew'
          : afterTokens < beforeTokens
            ? 'shrank'
            : 'unchanged';
    return { label, type: (a ?? b)!.type, beforeTokens, afterTokens, change };
  });

  return {
    beforeRequestId: before.requestId,
    afterRequestId: after.requestId,
    inputTokenDelta: effectiveInputTokens(after) - effectiveInputTokens(before),
    modelChanged: before.model !== after.model,
    sections,
  };
}
