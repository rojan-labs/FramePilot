import type { ReferenceProfile } from '@framepilot/ai-sdk';
/**
 * AI panel glue (plan/PLAN.md Phase 4.2/4.3).
 *
 * In the Electron desktop, AI calls are proxied to the main process via IPC so
 * that fetch runs outside the sandboxed renderer. In a plain browser (dev server,
 * tests, future web build) the provider is called directly via the ai-sdk.
 *
 * {@link createOrchestrator} returns an {@link OrchestratorLike} — a structural
 * interface that both the real {@link Orchestrator} and the IPC facade satisfy,
 * so the AiPanel component and its tests are unaffected.
 */
import {
  DEFAULT_ENGINE_BASE_URL,
  MockProvider,
  Orchestrator,
  RunStore,
  acceptanceEntry,
  analyzeCaptionEmphasis,
  buildCaptionEmphasisPrompt,
  createMemoryRecorder,
  createSessionContextDigester,
  createVisualStatusDigester,
  summarizeFootageMap,
  createProvider,
  createProviderFromConfig,
  createSidecarExecutor,
  createTemporalEvidenceAcquirer,
  rejectionEntry,
  fallbackCaptionEmphasis,
  parseCaptionEmphasisResponse,
  withResilience,
  type AgentOptions,
  type AgentRun,
  type AgentRunControls,
  type CaptionEmphasisAnalysis,
  createAskUserGate,
  type AiEvent,
  type AiMessage,
  type AiProvider,
  type AiResponse,
  type EditResult,
  type EditorInteractionContext,
  type EditorRunControls,
  type PinnedEntity,
  type ProviderConfig,
  type ProviderName,
  RUN_PROTOCOL_SCHEMA_VERSION,
  type StreamOptions,
  type UserMemory,
} from '@framepilot/ai-sdk';
import { createLogger } from '@framepilot/shared-types';
import type {
  AiProviderName,
  AiStreamEventMessage,
  AiStreamAnswerMessage,
  AiStreamUserMemory,
  DurableRunEvent,
  DurableRunEventMessage,
  DurableRunSnapshot,
  Seconds,
  AiStreamReferenceProfile,
} from '@framepilot/shared-types';
import { type ChangedRegion, type Patch, structuredDiffTimeline } from '@framepilot/editor-core';

const log = createLogger('web-editor:ai');
import type { Project, Timeline, TranscriptWord } from '@framepilot/timeline-schema';
import { getBridge } from './bridge.js';
import { type BrowserAiConfig, loadBrowserAiConfig } from './aiConfigStorage.js';
import { readProjectUnderstanding, type UnderstandingReads } from './projectUnderstanding.js';
import { createVisualIndexClient } from './visualIndex.js';
import { createBrowserRunStoreIO } from './browser-run-store.js';
import {
  BrowserRunRecorder,
  clearBrowserRunHandle,
  loadBrowserRunHandle,
} from './browser-run-recorder.js';

/** Read `VITE_FRAMEPILOT_PYTHON_API_URL`, trimmed; `undefined` when unset/blank. */
function configuredEngineBaseUrl(): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.['VITE_FRAMEPILOT_PYTHON_API_URL']?.trim() || undefined;
}

/**
 * The engine sidecar base URL the browser should probe/talk to (plan P5.1): the
 * explicit `VITE_FRAMEPILOT_PYTHON_API_URL` override when set, else the same
 * default host/port the desktop shell spawns its sidecar on ({@link
 * DEFAULT_ENGINE_BASE_URL}). Used for read-only reachability checks (the status
 * chip, Settings' ASR probe) — NOT for {@link browserOrchestratorOptions}, which
 * intentionally stays unwired without an explicit override so a guess never
 * fabricates an executor that isn't really there.
 */
export function resolveEngineBaseUrl(): string {
  return configuredEngineBaseUrl() ?? DEFAULT_ENGINE_BASE_URL;
}

// Dev-mode-only, fire-once warning so a developer isn't silently confused about why
// analyze_silence/detect_scenes/detect_beats report "no analysis engine is connected"
// (plan P5.1). Never fires in a production build (no console noise for end users).
let warnedMissingEngineUrl = false;

/**
 * Orchestrator options for the browser runtime (plan AGENT-NATIVE-UX T3).
 *
 * Analysis tools (analyze_silence, detect_scenes, detect_beats) need the Python
 * sidecar. In the browser that is only reachable when a dev/deployment explicitly
 * points at it via `VITE_FRAMEPILOT_PYTHON_API_URL` (a URL, not a secret — the
 * no-keys-in-bundle rule in vite.config.ts is untouched). When unset, no executor
 * is wired and analysis tools report an honest "analysis engine unavailable"
 * failure instead of fabricating success — see `apps/web-editor/.env.example`.
 */
function browserOrchestratorOptions(): ConstructorParameters<typeof Orchestrator>[1] {
  const baseUrl = configuredEngineBaseUrl();
  if (!baseUrl) {
    if (import.meta.env.DEV && !warnedMissingEngineUrl) {
      warnedMissingEngineUrl = true;
      log.warn(
        'VITE_FRAMEPILOT_PYTHON_API_URL is unset — analyze_silence/detect_scenes/detect_beats ' +
          'will report "no analysis engine is connected" until it points at the Python sidecar ' +
          '(see apps/web-editor/.env.example).',
      );
    }
    return {};
  }
  return { executor: createSidecarExecutor({ baseUrl }) };
}

/**
 * Record a review decision in the project's NARRATIVE memory tiers (plan B6.1),
 * alongside the typed `recordAccepted`/`recordRejected` write.
 *
 * Fire-and-forget by contract: the typed store in `project.fp.json` is
 * authoritative and already has the signal, so this is pure upside. It no-ops
 * without a configured sidecar (the plain browser build has no brain — the same
 * honest gap as proxies), and it never blocks or fails the Accept/Reject the
 * user just clicked.
 */
export function recordReviewDecision(
  project: Project,
  patch: Patch,
  decision: 'accepted' | 'rejected',
): void {
  const baseUrl = configuredEngineBaseUrl();
  if (!baseUrl) return;
  const entry =
    decision === 'accepted'
      ? acceptanceEntry(project.id, patch)
      : rejectionEntry(project.id, patch);
  // Deliberately not awaited: a memory append must never delay the UI. The
  // recorder swallows its own errors, so there is no rejection to handle.
  void createMemoryRecorder({ baseUrl })(entry);
}

/**
 * Lightweight reachability probe for the analysis-engine sidecar (plan P5.2/P5.3):
 * a bounded-time `GET {baseUrl}/health`, mirroring the desktop shell's own
 * `probeHealth` (`apps/desktop/electron/main.ts`). Never throws — a timeout,
 * network failure, or non-2xx response all resolve to `false` so callers (the
 * status chip) can render an honest unreachable state instead of hanging or
 * crashing the render.
 */
export async function probeEngineReachable(
  baseUrl: string,
  opts?: { readonly timeoutMs?: number },
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 2000);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The minimal orchestrator surface the AiPanel needs. */
export interface OrchestratorLike {
  chat(input: { project: Project; userPrompt: string }): Promise<AiResponse>;
  plan(input: { project: Project; userPrompt: string }): Promise<AiResponse>;
  edit(input: { project: Project; userPrompt: string }): Promise<EditResult>;
  /** Multi-step autonomous edit (Phase 7); returns a reviewable, non-applied run. */
  agent(input: { project: Project; userPrompt: string }): Promise<AgentRun>;
}

/**
 * Orchestrator facade backed by Electron IPC.
 * Fetch runs in the main process (Node.js) — no sandbox, no fetch restrictions.
 */
class IpcOrchestrator implements OrchestratorLike {
  public async chat(input: { project: Project; userPrompt: string }): Promise<AiResponse> {
    const bridge = getBridge();
    if (!bridge) throw new Error('Desktop bridge unavailable.');
    const result = await bridge.aiChat({ project: input.project, userPrompt: input.userPrompt });
    if (!result.ok) throw new Error(result.error);
    return { text: result.text };
  }

  public async plan(input: { project: Project; userPrompt: string }): Promise<AiResponse> {
    const bridge = getBridge();
    if (!bridge) throw new Error('Desktop bridge unavailable.');
    const result = await bridge.aiPlan({ project: input.project, userPrompt: input.userPrompt });
    if (!result.ok) throw new Error(result.error);
    return { text: result.text };
  }

  public async edit(input: { project: Project; userPrompt: string }): Promise<EditResult> {
    const bridge = getBridge();
    if (!bridge) throw new Error('Desktop bridge unavailable.');
    const result = await bridge.aiEdit({ project: input.project, userPrompt: input.userPrompt });
    if (!result.ok) throw new Error(result.error);
    return result as unknown as EditResult;
  }

  /**
   * Agent mode runs the multi-step loop locally in the renderer. The loop is pure
   * compute over the orchestrator + provider; with the offline mock (the default)
   * it needs no network, so it works inside the sandboxed renderer. Driving agent
   * mode through a real provider over IPC is a Phase 8 follow-up that mirrors the
   * chat/plan/edit channels.
   */
  public async agent(input: { project: Project; userPrompt: string }): Promise<AgentRun> {
    return new Orchestrator(withResilience(createProvider()), browserOrchestratorOptions()).agent(
      input,
    );
  }
}

/**
 * Build an orchestrator for a provider.
 * - Inside Electron: returns an IPC-backed facade (fetch runs in main process).
 * - Outside Electron (browser / tests): returns a direct Orchestrator using the
 *   offline mock provider unless an explicit `provider` name is passed.
 */
export const createOrchestrator = (provider?: ProviderName): OrchestratorLike => {
  if (getBridge()) {
    return new IpcOrchestrator();
  }
  return new Orchestrator(withResilience(createProvider(provider)), browserOrchestratorOptions());
};

/** A human-readable review card for a proposed edit (PRD §7.2 review UX). */
export interface ReviewCard {
  /** WHY — the model's rationale. */
  readonly reason: string;
  /** WHAT — per-change summary lines from the timeline diff. */
  readonly changes: readonly string[];
  /** Whether the patch validated against the current timeline. */
  readonly valid: boolean;
  /** Validation problems to show when the patch is not applicable. */
  readonly problems: readonly string[];
  /** Number of operations the patch contains. */
  readonly operationCount: number;
  /**
   * The timeline before the patch applied. `undefined` when the patch didn't
   * validate (no diff was computed) — mirrors `EditResult.diff` being absent.
   * Pair with the *current* project's `assets`/`fps`/`settings` to build a full
   * before/after {@link Project} for preview: no in-scope operation mutates
   * those fields, only `timeline` (clip ops) or `assets`/`folders` (bin ops).
   */
  readonly before?: Timeline;
  /** The timeline after the patch applied (see {@link before}). */
  readonly after?: Timeline;
  /**
   * Machine-readable added/removed/modified clip regions between `before` and
   * `after` (`structuredDiffTimeline`), for the before/after player's scrubber
   * marks — the structured counterpart to `changes`' formatted strings.
   */
  readonly changedRegions: readonly ChangedRegion[];
}

// ---------------------------------------------------------------------------
// Streaming session facade (Phase 11 M3, ADR 0033) — the ONE interface the
// streaming sidebar (M4+) depends on. Browser streams the SDK directly; desktop
// streams over the requestId-scoped IPC push channel. Identical event stream both ways.
// ---------------------------------------------------------------------------

/**
 * `'plan'` is the PRD §7.3 "produce a read-only step-by-step plan, no mutation" mode
 * (`Orchestrator.streamPlan`).
 *
 * There used to be a sixth mode, `'planned-edit'`, driving a second mutating execution
 * universe (IntentParser → Planner → task graph → scheduler). Phase 1 of the 9.5
 * convergence retired it (ADR 0126) after measuring both routes on the same goals: the
 * agent runtime covered every capability, cost no more model calls, and validated tool
 * arguments the planner path passed straight through to the host. Analysis-dependent edits
 * are now ordinary `'auto'`/`'agent'` work.
 */
export type AiSessionMode = 'auto' | 'chat' | 'plan' | 'edit' | 'agent';

/** Input for one streaming run: the project, prompt, and the conversation/turn ids. */
export interface AiSessionInput {
  readonly project: Project;
  /** Host-owned optimistic-concurrency revision for durable desktop runs. */
  readonly projectRevision?: number;
  /** Explicit desktop control-plane policy for proposed patches. */
  readonly patchPolicy?: 'review' | 'auto_commit';
  readonly userPrompt: string;
  readonly conversationId: string;
  readonly turnId: string;
  /**
   * The provider to run with (desktop only). Omitted in the browser (mock). On
   * desktop it selects the main-process provider for this run; the key stays in main.
   */
  readonly provider?: AiProviderName;
  /**
   * Prior conversation turns for multi-turn coherence (R2 B1). Threaded into the
   * model context by the browser session; the desktop path threads history in the
   * main process once the IPC contract carries it (follow-up).
   */
  readonly history?: readonly AiMessage[];
  /**
   * The current timeline selection, so context is scoped to the clips the request is
   * about on a large project (R2 B3). Threaded into the model context (browser path).
   */
  readonly selection?: { readonly start: Seconds; readonly end: Seconds };
  /** Live editor state captured at submission for deterministic referent resolution. */
  readonly interaction?: EditorInteractionContext;
  /**
   * The user's cross-project editorial defaults (K5.1b). Threaded into the model context
   * by the browser session so a project inherits them (project memory still wins per
   * field). Desktop threads it in the main process once the IPC contract carries it
   * (follow-up), mirroring how `history`/`selection` are handled today.
   */
  readonly userMemory?: UserMemory;
  /** Analyzed reference attachments for this turn (plan/system-mission P3.4). */
  readonly references?: readonly ReferenceProfile[];
  /**
   * Agent-run tuning (agent mode only): up-front plan, blast-radius caps, bounded
   * auto-repair, duration target. Forwarded to `streamAgent` so the app runs the same
   * robust agent as the non-streaming `agent()` (browser path; desktop is a follow-up).
   */
  readonly agentOptions?: AgentOptions;
  /**
   * Live, non-serialisable execution-side hooks for browser/dev runs. Desktop never
   * marshals them: it sends protocol-v1 commands and Electron main adapts durable
   * wait gates/steering into execution-side hooks.
   */
  readonly controls?: AgentRunControls;
  /**
   * Opt-in "give me alternatives" (H1.5 / AGENT-NATIVE-COMPLETION-PLAN.md P13.1 —
   * "variations / A-B compare"). `edit`-mode ONLY: proposes `EDIT_VARIATION_COUNT`
   * independent candidate takes on the same request instead of one, each a REAL,
   * separately-billed model call — never the default, and never applied to an agent run
   * (an agent run is an already-converged single proposal; "variations" of it would just
   * be the identical result twice). Browser only for now — {@link DesktopAiSession} does
   * not thread this over IPC yet (see its `run` method); the composer only offers the
   * toggle when no Electron bridge is present.
   */
  readonly variations?: boolean;
  /**
   * Clips/assets the user pinned as extra context via the composer's "@" picker
   * (P8.7 narrow slice — the H1.5c-deferred pin-context picker), independent of the
   * auto-derived `selection`. Threaded into the model context by the browser session
   * (`context-builder.ts`'s "Pinned context" block). Browser-only for now, same
   * precedent as `selection`/`variations` above — `DesktopAiSession`
   * does not forward it over IPC yet (an explicit, documented gap; the natural home
   * is the P6 cross-surface parity pass, not silently dropped here). Deferred:
   * `@range`/`@marker`/`@track` entity kinds (P8.7 full scope stays open).
   */
  readonly pinned?: readonly PinnedEntity[];
}

/**
 * Project a conversation's event log into the bounded {@link AiMessage} history the
 * model sees (R2 B1). Only terminal user/assistant messages become turns — deltas,
 * tool events, and status are UI-only. Pure + order-preserving.
 */
export function historyFromEvents(events: readonly AiEvent[]): AiMessage[] {
  const messages: AiMessage[] = [];
  for (const event of events) {
    if (event.type === 'user_message' && event.text.trim().length > 0) {
      messages.push({ role: 'user', content: event.text });
    } else if (event.type === 'assistant_message' && event.text.trim().length > 0) {
      messages.push({ role: 'assistant', content: event.text });
    }
  }
  return messages;
}

/** The streaming transport the sidebar consumes: emit events, interrupt with abort. */
export interface AiSession {
  /** Run one turn, yielding {@link AiEvent}s in order until completion/abort. */
  run(mode: AiSessionMode, input: AiSessionInput): AsyncIterable<AiEvent>;
  /** Abort the in-flight run (cancels the upstream fetch in desktop). */
  abort(): void;
  /**
   * Detach this renderer projection without stopping host-owned durable work.
   * Used only for harmless UI lifecycle changes (unmount/remount/navigation).
   */
  detach?(): void;
  /**
   * Answer the model's pending question (P12) — the reply to an `ask` event, addressed
   * by the `toolCallId` it carried. Both surfaces implement it, so `ask_user` behaves
   * identically in the browser and on desktop (the #1 target): the browser resolves an
   * in-process gate, desktop sends plain data back over IPC to the gate held in main.
   * A `toolCallId` that is no longer pending is ignored, so a stale click can never
   * answer a question the model did not ask.
   */
  answer(answer: AiStreamAnswerMessage): void;
  /** Desktop durable plan decision; browser keeps using its in-process gate. */
  approvePlan?(): void;
  rejectPlan?(): void;
  /** Desktop durable next-boundary steering; browser keeps using its in-process queue. */
  steer?(message: string): void;
  /** Persist the human's terminal review decision for a proposed patch. */
  decidePatch?(patchId: string, decision: 'accepted' | 'rejected', projectRevision?: number): void;
  /** Durable run currently responsible for patch lifecycle and undo grouping. */
  patchRunId?(): string | undefined;
  /** Replay a desktop run that survived renderer reload; unavailable in browser/dev. */
  recover?(projectId: string, existingEvents: readonly AiEvent[]): AsyncIterable<AiEvent> | null;
  recoveryConversationId?(projectId: string): string | null;
}

/** Browser/dev session: streams the M1 orchestrator directly (no IPC). */
export class BrowserAiSession implements AiSession {
  private controller: AbortController | null = null;
  private readonly runStore = new RunStore(createBrowserRunStoreIO());
  private lastBrowserRun: { readonly runId: string; readonly projectId: string } | null = null;
  private lastRecorder: BrowserRunRecorder | null = null;
  private decisionLane: Promise<void> = Promise.resolve();

  /**
   * The run's question gate (P12), owned here rather than by the caller so both sessions
   * expose the same `answer()` surface and the sidebar never has to know which one it is
   * talking to.
   */
  private askGate = createAskUserGate();

  public constructor(private readonly orchestrator: Orchestrator) {}

  public answer(answer: AiStreamAnswerMessage): void {
    this.askGate.resolve(
      answer.toolCallId,
      answer.kind === 'answered'
        ? { kind: 'answered', answer: answer.answer }
        : { kind: 'cancelled' },
    );
  }

  /**
   * The three understanding blocks a run should open with, or `{}` when this build has no
   * sidecar to ask (the plain browser build's honest gap, the same one it has for proxies).
   *
   * Each read is independent and none may fail the run, so they overlap and every rejection
   * degrades to an absent block. The footage map is CACHE-ONLY on purpose: this runs before
   * every run, and a cache miss that reached for a generative understanding model would stall
   * the run on a slow round-trip and bill for it. A cold project simply gets no map block
   * until the understanding panel or a `map_footage` call warms it.
   */
  /**
   * Build the three understanding reads for this run, or `undefined` when this build has no
   * sidecar to ask (the plain browser build's honest gap, the same one it has for proxies).
   *
   * The footage map is CACHE-ONLY on purpose: this runs before every run, and a cache miss
   * that reached for a generative understanding model would stall the run on a slow round-trip
   * and bill for it. A cold project simply gets no map block until the understanding panel or
   * a `map_footage` call warms it.
   */
  private understandingReads(input: AiSessionInput): UnderstandingReads | undefined {
    const baseUrl = configuredEngineBaseUrl();
    if (!baseUrl) return undefined;
    const projectId = input.project.id;
    const twelveLabsKey = loadBrowserAiConfig().twelveLabs?.trim();
    return {
      visualStatus: () =>
        createVisualStatusDigester({ baseUrl })(projectId, this.orchestrator.canSeeFrames()),
      footageMap: async () =>
        summarizeFootageMap(
          await createVisualIndexClient(baseUrl).footageMap({
            projectId,
            // The live edit rides along so chapter times come back in TIMELINE
            // seconds. Without it the engine has nothing to project through and
            // answers in each asset's own source seconds — which `map_footage`
            // documents as timeline time. Projection is arithmetic over clips
            // already in memory, so this stays cache-only and costs nothing.
            project: input.project,
            cachedOnly: true,
            ...(twelveLabsKey ? { twelveLabsKey } : {}),
          }),
        ),
      sessionContext: () => createSessionContextDigester({ baseUrl })(projectId),
    };
  }

  /**
   * The run's live controls: the caller's own hooks plus this session's question gate.
   * A caller-supplied `askUser` wins, so a test (or a future host) can still drive the
   * gate itself.
   */
  private controlsFor(input: AiSessionInput): AgentRunControls {
    // A fresh gate per run: a question from a previous, abandoned run must never be
    // resolvable by a click in this one.
    this.askGate = createAskUserGate();
    const baseUrl = configuredEngineBaseUrl();
    return {
      askUser: this.askGate,
      // What the editor tells the run has to outlive it, or the next run asks again — or
      // proceeds on a guess instead, which is how a captured session lost the framing the
      // editor had just chosen. No sidecar ⇒ no brain to write to, the same honest gap as
      // proxies in the plain browser build.
      ...(baseUrl
        ? {
            rememberDecision: (note: { readonly title: string; readonly body: string }) => {
              void createMemoryRecorder({ baseUrl })({
                projectId: input.project.id,
                tier: 'decisions',
                title: note.title,
                body: note.body,
              });
            },
          }
        : {}),
      ...(input.controls ?? {}),
    };
  }

  /**
   * Every mutating browser route enters the same lifecycle and temporal-review boundary as the
   * desktop. An absent sidecar is represented by a failing acquirer instead of by omitting the
   * gate: the run releases an explicitly unverified proposal for human review and cannot silently
   * claim successful verification.
   */
  private editorRunControls(
    input: AiSessionInput,
    recorder: BrowserRunRecorder,
  ): EditorRunControls &
    Required<Pick<EditorRunControls, 'agent' | 'onLifecycleEvent' | 'temporalEvidence'>> {
    const baseUrl = configuredEngineBaseUrl();
    const temporalEvidence = baseUrl
      ? createTemporalEvidenceAcquirer({ baseUrl })
      : async () => {
          throw new Error(
            'Temporal review is unavailable because VITE_FRAMEPILOT_PYTHON_API_URL is not configured.',
          );
        };
    return {
      agent: this.controlsFor(input),
      temporalEvidence,
      onLifecycleEvent: (event) => {
        this.lastBrowserRun = { runId: event.runId, projectId: input.project.id };
        this.lastRecorder = recorder;
        recorder.record(event);
        log.debug('BrowserAiSession.lifecycle', {
          runId: event.runId,
          route: event.route,
          stage: event.stage,
          state: event.state,
          sequence: event.sequence,
        });
      },
    };
  }

  public async *run(mode: AiSessionMode, input: AiSessionInput): AsyncIterable<AiEvent> {
    log.action('BrowserAiSession.run', {
      mode,
      prompt: input.userPrompt?.slice(0, 200),
      hasSelection: Boolean(input.selection),
      pinnedCount: input.pinned?.length ?? 0,
      historyLen: input.history?.length ?? 0,
    });
    this.controller = new AbortController();
    // What this project already KNOWS, read once per run: whether its footage is indexed, the
    // cached footage map, and the session digest (bin summary, last session note, the
    // corrections/decisions tiers — where an answer the editor gave a previous run lives).
    //
    // The desktop hub has read these for a while; the browser session read none of them, so
    // the two surfaces disagreed about what the agent knows. In a captured browser run the
    // editor said "choose from footage map" and the agent had no map in context, never called
    // for one, and narrated chapter titles it had invented instead. Best-effort and fail-soft
    // exactly as on desktop: a slow or absent sidecar degrades to no block rather than
    // delaying or failing an otherwise good run.
    const reads = this.understandingReads(input);
    const understanding = reads ? await readProjectUnderstanding(reads) : {};
    const context = {
      project: input.project,
      ...(input.projectRevision === undefined ? {} : { projectRevision: input.projectRevision }),
      userPrompt: input.userPrompt,
      ...(input.history && input.history.length > 0 ? { history: input.history } : {}),
      ...(input.selection ? { selection: input.selection } : {}),
      ...(input.interaction ? { interaction: input.interaction } : {}),
      ...(input.userMemory ? { userMemory: input.userMemory } : {}),
      ...(input.pinned && input.pinned.length > 0 ? { pinned: input.pinned } : {}),
      ...(input.references && input.references.length > 0 ? { references: input.references } : {}),
      ...understanding,
    };
    const options: StreamOptions = {
      conversationId: input.conversationId,
      turnId: input.turnId,
      signal: this.controller.signal,
    };
    const recorder = new BrowserRunRecorder(
      this.runStore,
      input.project.id,
      input.projectRevision ?? 0,
      input.conversationId,
    );
    const persist = async function* (stream: AsyncIterable<AiEvent>): AsyncGenerator<AiEvent> {
      try {
        for await (const event of stream) {
          recorder.observeAiEvent(event);
          yield event;
        }
      } finally {
        await recorder.flush();
        if (recorder.isTerminal()) clearBrowserRunHandle(input.project.id);
      }
    };
    switch (mode) {
      case 'auto': {
        // The model-routed entry point (ADR 0055): one classification call picks
        // chitchat/question/edit, then delegates to the matching sub-stream.
        const autoControls = this.editorRunControls(input, recorder);
        yield* persist(
          this.orchestrator.streamAuto(context, options, {
            agentOptions: input.agentOptions ?? {},
            controls: autoControls.agent,
            onLifecycleEvent: autoControls.onLifecycleEvent,
            temporalEvidence: autoControls.temporalEvidence,
          }),
        );
        return;
      }
      case 'chat':
        // E5.5: chat/question turns can now `ask_user` too — wire the same gate so
        // the sidebar's answer reaches the paused run.
        yield* this.orchestrator.streamChat(context, options, {
          controls: this.controlsFor(input),
        });
        return;
      case 'plan':
        yield* this.orchestrator.streamPlan(context, options);
        return;
      case 'edit':
        // `variations` (P13.1) is opt-in and edit-mode only — see `AiSessionInput.variations`.
        yield* persist(
          this.orchestrator.streamEditorRun(
            context,
            options,
            { route: 'edit', ...(input.variations ? { variations: true } : {}) },
            this.editorRunControls(input, recorder),
          ),
        );
        return;
      case 'agent':
        yield* persist(
          this.orchestrator.streamEditorRun(
            context,
            options,
            { route: 'agent', agentOptions: input.agentOptions ?? {} },
            this.editorRunControls(input, recorder),
          ),
        );
        return;
    }
  }

  public abort(): void {
    this.controller?.abort();
  }

  public recoveryConversationId(projectId: string): string | null {
    return loadBrowserRunHandle(projectId)?.conversationId ?? null;
  }

  public patchRunId(): string | undefined {
    return this.lastBrowserRun?.runId;
  }

  public decidePatch(
    patchId: string,
    decision: 'accepted' | 'rejected',
    projectRevision?: number,
  ): void {
    const target = this.lastBrowserRun;
    const recorder = this.lastRecorder;
    if (target === null || recorder === null) return;
    this.decisionLane = this.decisionLane
      .then(async () => {
        await recorder.flush();
        const stored = await this.runStore.load(target.runId);
        const snapshot = stored.snapshot;
        if (snapshot === null || snapshot.projectId !== target.projectId) return;
        const current = snapshot.patchDecisions.find((item) => item.patchId === patchId);
        const nextState = decision === 'accepted' ? 'committed' : 'rejected';
        if (current?.state === nextState) return;
        if (current?.state !== 'pending') {
          throw new Error(`Patch "${patchId}" is not pending review.`);
        }
        const occurredAt = Date.now();
        const event = {
          schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
          eventId: `${target.runId}:patch:${patchId}:${nextState}`,
          runId: target.runId,
          projectId: target.projectId,
          sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
          ...(projectRevision === undefined ? {} : { projectRevision }),
          occurredAt,
          kind: decision === 'accepted' ? 'run.patch_accepted' : 'run.patch_rejected',
          payload: { patchId, decision },
        } as const;
        await this.runStore.append(event);
        await this.runStore.saveSnapshot({
          ...snapshot,
          currentProjectRevision: projectRevision ?? snapshot.currentProjectRevision,
          lastSequence: event.sequence,
          updatedAt: occurredAt,
          ...(decision === 'accepted'
            ? {
                outcome: {
                  kind: 'completed_with_changes' as const,
                  changed: true,
                  warnings: snapshot.outcome?.warnings ?? [],
                },
              }
            : {}),
          patchDecisions: snapshot.patchDecisions.map((item) =>
            item.patchId === patchId
              ? {
                  ...item,
                  state: nextState,
                  decidedAt: occurredAt,
                  ...(projectRevision === undefined ? {} : { projectRevision }),
                }
              : item,
          ),
        });
      })
      .catch((error: unknown) => {
        log.warn('browser durable patch decision failed', {
          patchId,
          decision,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  public recover(
    projectId: string,
    existingEvents: readonly AiEvent[],
  ): AsyncIterable<AiEvent> | null {
    const handle = loadBrowserRunHandle(projectId);
    return handle === null ? null : this.recoverBrowserRun(handle, existingEvents);
  }

  private async *recoverBrowserRun(
    handle: ReturnType<typeof loadBrowserRunHandle> & {},
    existingEvents: readonly AiEvent[],
  ): AsyncIterable<AiEvent> {
    const stored = await this.runStore.load(handle.runId);
    let snapshot = stored.snapshot;
    if (snapshot === null) {
      clearBrowserRunHandle(handle.projectId);
      return;
    }
    if (!isTerminalDurableStatus(snapshot.status)) {
      const occurredAt = Date.now();
      const reason = 'Browser process closed before the editor run reached a terminal state.';
      const terminal = {
        schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
        eventId: `${handle.runId}:browser:interrupted`,
        runId: handle.runId,
        projectId: handle.projectId,
        sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
        occurredAt,
        kind: 'run.terminal',
        payload: {
          status: 'failed',
          outcome: {
            kind: 'interrupted',
            changed: false,
            warnings: [],
            source: 'process_restart',
            reason,
          },
        },
      } as const;
      await this.runStore.append(terminal);
      snapshot = {
        ...snapshot,
        status: 'failed',
        outcome: {
          kind: 'interrupted',
          changed: false,
          warnings: [],
          source: 'process_restart',
          reason,
        },
        lastSequence: terminal.sequence,
        updatedAt: occurredAt,
      };
      await this.runStore.saveSnapshot(snapshot);
    }
    const known = new Set(existingEvents.map((event) => JSON.stringify(event)));
    for (const event of terminalEventsFromSnapshot(snapshot, handle.conversationId)) {
      if (!known.has(JSON.stringify(event))) yield event;
    }
    clearBrowserRunHandle(handle.projectId);
  }
}

/**
 * Desktop session: drives the main-process stream over IPC. Subscribes BEFORE
 * `aiStreamStart` resolves and buffers messages, then filters by `requestId` — so an
 * event that races ahead of the id is never dropped. A push→pull queue turns the
 * pushed messages back into an `AsyncIterable`.
 */
interface DurableRunHandle {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly cursor: number;
}

function streamEventFromDurable(event: DurableRunEvent): AiEvent | null {
  if (
    event.kind !== 'run.stream_event' ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return null;
  }
  const value = (event.payload as Record<string, unknown>)['event'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record['id'] !== 'string' ||
    typeof record['conversationId'] !== 'string' ||
    typeof record['turnId'] !== 'string' ||
    typeof record['ts'] !== 'number' ||
    typeof record['type'] !== 'string'
  ) {
    return null;
  }
  return value as AiEvent;
}

function isTerminalDurableStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Synthesize the terminal `status` {@link AiEvent} for a recovered durable run whose
 * `run.terminal` we just replayed. The durable terminal event is protocol metadata, not
 * a conversation event, so on its own it never reaches the conversation view — the
 * recovered chat would keep shimmering at whatever status streamed last (e.g.
 * `executing`) even though the run is over. Emitting the matching status here resolves
 * it. Returns `null` for a non-terminal or malformed terminal event (defensive — the
 * caller only calls this for `run.terminal`).
 */
function terminalStatusFromDurable(event: DurableRunEvent, conversationId: string): AiEvent | null {
  if (
    event.kind !== 'run.terminal' ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return null;
  }
  const status = (event.payload as Record<string, unknown>)['status'];
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return null;
  return {
    id: `durable-terminal:${event.eventId}`,
    conversationId,
    turnId: `durable-terminal:${event.eventId}`,
    ts: event.occurredAt,
    type: 'status',
    status,
  };
}

/** Surface the durable terminal reason instead of reducing every ending to a status word. */
function terminalReasonFromDurable(event: DurableRunEvent, conversationId: string): AiEvent | null {
  if (
    event.kind !== 'run.terminal' ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  const outcome = payload['outcome'];
  if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) return null;
  const reason = (outcome as Record<string, unknown>)['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) return null;
  const status = payload['status'];
  const base = {
    id: `durable-terminal-reason:${event.eventId}`,
    conversationId,
    turnId: `durable-terminal:${event.eventId}`,
    ts: event.occurredAt,
  };
  return status === 'failed'
    ? { ...base, type: 'error', message: reason, retryable: true }
    : { ...base, type: 'notification', text: reason };
}

function terminalEventsFromSnapshot(
  snapshot: DurableRunSnapshot,
  conversationId: string,
): readonly AiEvent[] {
  if (!isTerminalDurableStatus(snapshot.status)) return [];
  const outcome =
    typeof snapshot.outcome === 'object' &&
    snapshot.outcome !== null &&
    !Array.isArray(snapshot.outcome)
      ? (snapshot.outcome as Record<string, unknown>)
      : null;
  const reason = outcome?.['reason'];
  const base = {
    conversationId,
    turnId: `durable-snapshot:${snapshot.runId}`,
    ts: snapshot.updatedAt,
  };
  const events: AiEvent[] = [];
  if (typeof reason === 'string' && reason.trim().length > 0) {
    events.push(
      snapshot.status === 'failed'
        ? {
            ...base,
            id: `durable-snapshot-reason:${snapshot.runId}:${String(snapshot.lastSequence)}`,
            type: 'error',
            message: reason,
            retryable: true,
          }
        : {
            ...base,
            id: `durable-snapshot-reason:${snapshot.runId}:${String(snapshot.lastSequence)}`,
            type: 'notification',
            text: reason,
          },
    );
  }
  events.push({
    ...base,
    id: `durable-snapshot-status:${snapshot.runId}:${String(snapshot.lastSequence)}`,
    type: 'status',
    status: snapshot.status,
  });
  return events;
}

class DesktopAiSession implements AiSession {
  private activeRequestId: string | null = null;
  private activeDurableRun: { readonly runId: string; readonly projectId: string } | null = null;
  private lastDurableRun: { readonly runId: string; readonly projectId: string } | null = null;

  private controller: AbortController | null = null;
  private transportDetached = false;
  private wakeTransport: (() => void) | null = null;
  private cancellationSentForRun: string | null = null;

  private static readonly RUN_HANDLE_PREFIX = 'framepilot:durable-run:';

  private loadRunHandle(projectId: string): DurableRunHandle | null {
    try {
      const raw = globalThis.localStorage?.getItem(
        `${DesktopAiSession.RUN_HANDLE_PREFIX}${projectId}`,
      );
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null) return null;
      const record = value as Record<string, unknown>;
      if (
        record['schemaVersion'] !== 1 ||
        typeof record['runId'] !== 'string' ||
        record['projectId'] !== projectId ||
        typeof record['conversationId'] !== 'string' ||
        typeof record['cursor'] !== 'number'
      ) {
        return null;
      }
      return record as unknown as DurableRunHandle;
    } catch {
      return null;
    }
  }

  /**
   * Minimum gap between recovery-handle writes while a run streams.
   *
   * `localStorage.setItem` is a SYNCHRONOUS, serializing write on the renderer's main
   * thread, and the handle was rewritten on every durable event — hundreds per run,
   * each stalling the frame that was trying to paint the token. Coalescing is safe
   * because a handle's `cursor` only has to be a lower bound: recovery re-subscribes
   * from it and `replayDurableRun` drops anything it has already seen. Terminal
   * transitions still flush immediately via {@link flushRunHandle}.
   */
  private static readonly RUN_HANDLE_WRITE_INTERVAL_MS = 1_000;

  private pendingRunHandle: DurableRunHandle | null = null;
  private lastRunHandleWriteAt = 0;

  private writeRunHandle(handle: DurableRunHandle): void {
    try {
      globalThis.localStorage?.setItem(
        `${DesktopAiSession.RUN_HANDLE_PREFIX}${handle.projectId}`,
        JSON.stringify(handle),
      );
    } catch {
      // Recovery metadata is best-effort; the durable run itself remains in main.
    }
  }

  private saveRunHandle(handle: DurableRunHandle): void {
    const now = Date.now();
    if (now - this.lastRunHandleWriteAt < DesktopAiSession.RUN_HANDLE_WRITE_INTERVAL_MS) {
      this.pendingRunHandle = handle;
      return;
    }
    this.lastRunHandleWriteAt = now;
    this.pendingRunHandle = null;
    this.writeRunHandle(handle);
  }

  /** Persist the newest coalesced handle now (run settled, or the transport detached). */
  private flushRunHandle(): void {
    const pending = this.pendingRunHandle;
    if (pending === null) return;
    this.pendingRunHandle = null;
    this.lastRunHandleWriteAt = Date.now();
    this.writeRunHandle(pending);
  }

  private clearRunHandle(projectId: string): void {
    this.pendingRunHandle = null;
    try {
      globalThis.localStorage?.removeItem(`${DesktopAiSession.RUN_HANDLE_PREFIX}${projectId}`);
    } catch {
      // Storage may be unavailable; a terminal snapshot will still stop recovery.
    }
  }

  public async *run(mode: AiSessionMode, input: AiSessionInput): AsyncIterable<AiEvent> {
    const bridge = getBridge();
    if (!bridge) throw new Error('Desktop bridge unavailable.');
    this.transportDetached = false;

    const inbox: AiStreamEventMessage[] = [];
    let notify: (() => void) | null = null;
    const unsubscribe = bridge.onAiStreamEvent((message) => {
      inbox.push(message);
      const resume = notify;
      notify = null;
      resume?.();
    });

    try {
      const durable = bridge.runStart
        ? await bridge.runStart({
            projectId: input.project.id,
            projectRevision: input.projectRevision ?? 0,
            userPrompt: input.userPrompt,
            mode,
            ...(input.selection ? { selection: input.selection } : {}),
            ...(input.agentOptions ? { agentOptions: input.agentOptions } : {}),
            ...(input.patchPolicy ? { patchPolicy: input.patchPolicy } : {}),
          })
        : null;
      if (durable !== null) {
        this.activeDurableRun = {
          runId: durable.snapshot.runId,
          projectId: durable.snapshot.projectId,
        };
        this.lastDurableRun = this.activeDurableRun;
        this.cancellationSentForRun = null;
        this.saveRunHandle({
          schemaVersion: 1,
          runId: durable.snapshot.runId,
          projectId: durable.snapshot.projectId,
          conversationId: input.conversationId,
          cursor: durable.event.sequence,
        });
      }
      const requestId = await bridge.aiStreamStart({
        mode,
        projectId: input.project.id,
        projectRevision: input.projectRevision ?? 0,
        // The editor's working project can be newer than the host's debounced
        // persistence snapshot (notably immediately after import). Main validates and
        // refreshes its authority from this document after checking the revision.
        project: input.project,
        userPrompt: input.userPrompt,
        conversationId: input.conversationId,
        turnId: input.turnId,
        ...(durable === null ? {} : { durableRunId: durable.snapshot.runId }),
        ...(input.provider ? { provider: input.provider } : {}),
        // Cross-surface sync: the desktop main process now threads these into context /
        // the agent loop, so the Electron app matches the browser path.
        ...(input.history && input.history.length > 0 ? { history: input.history } : {}),
        ...(input.selection ? { selection: input.selection } : {}),
        ...(input.interaction ? { interaction: input.interaction } : {}),
        // The SDK UserMemory is a structurally compatible producer of the wire type
        // (its optional fields just also admit `undefined`); the cast bridges
        // exactOptionalPropertyTypes without copying the object field by field.
        ...(input.userMemory ? { userMemory: input.userMemory as AiStreamUserMemory } : {}),
        ...(input.references && input.references.length > 0
          ? { references: input.references as unknown as readonly AiStreamReferenceProfile[] }
          : {}),
        ...(input.agentOptions ? { agentOptions: input.agentOptions } : {}),
        // `variations` (P13.1) is deliberately NOT threaded over the desktop IPC contract
        // yet — browser-only for this slice (see `AiSessionInput.variations`); the composer
        // only shows the toggle without an Electron bridge, so this is never silently
        // dropped from under a user who asked for it.
        //
        // `pinned` (P8.7) is likewise NOT threaded over IPC yet — same browser-only
        // precedent (see `AiSessionInput.pinned`'s doc). The composer's "@" picker still
        // renders the pinned chips on desktop (so the user sees what they pinned), but
        // desktop runs currently drop them from the model context rather than silently
        // pretending to send them — a documented gap for the P6 cross-surface parity pass.
      });
      this.activeRequestId = requestId;
      for (;;) {
        if (this.transportDetached) return;
        // Drain by REMOVING each message. A read cursor left every message of the run
        // resident for its whole duration — a second full copy of the event stream in
        // the renderer, including the expandable tool payloads — on top of the
        // conversation log that is the actual store. Consumed messages have no reader.
        for (;;) {
          const message = inbox.shift();
          if (message === undefined) break;
          if (message.requestId !== requestId) continue;
          if (message.error) {
            this.clearRunHandle(input.project.id);
            throw new Error(message.error);
          }
          if (message.done) {
            this.clearRunHandle(input.project.id);
            return;
          }
          if (message.event) {
            yield message.event as AiEvent;
            if (message.durableSequence !== undefined && this.activeDurableRun) {
              this.saveRunHandle({
                schemaVersion: 1,
                ...this.activeDurableRun,
                conversationId: input.conversationId,
                cursor: message.durableSequence,
              });
            }
          }
        }
        if (this.transportDetached) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
          this.wakeTransport = resolve;
        });
        this.wakeTransport = null;
      }
    } finally {
      unsubscribe();
      this.flushRunHandle();
      this.wakeTransport = null;
      this.activeRequestId = null;
      // Detaching only drops THIS renderer's projection — the host run keeps executing.
      // Forgetting it here is what made Stop a silent no-op on a detached-but-live run
      // (the editor had nothing left to cancel), stranding it in the background with no
      // way for the user to end it. Only a run that actually settled is forgotten.
      if (!this.transportDetached) this.activeDurableRun = null;
    }
  }

  public abort(): void {
    // Cancels either the local recipe run or the in-flight IPC stream.
    this.controller?.abort();
    if (this.activeDurableRun) {
      // The durable command is persisted before main aborts the provider. Sending the
      // legacy request-id abort too creates a race where settlement can win first and
      // record an unexplained cancellation.
      this.sendCancellationOnce({
        source: 'user_stop',
        reason: 'Stopped by the editor.',
      });
    } else if (this.activeRequestId) {
      getBridge()?.aiStreamAbort(this.activeRequestId);
    }
  }

  public detach(): void {
    this.transportDetached = true;
    this.wakeTransport?.();
    this.wakeTransport = null;
  }

  public answer(answer: AiStreamAnswerMessage): void {
    // The gate lives in main beside the run it blocks; only plain data crosses here.
    // No active run ⇒ nothing to answer (the question died with it).
    if (this.activeDurableRun) {
      if (answer.kind === 'answered') {
        this.sendDurableCommand('answer', {
          toolCallId: answer.toolCallId,
          answer: answer.answer,
        });
      } else {
        this.sendCancellationOnce({
          source: 'question_dismissed',
          reason: 'Question dismissed by the editor.',
        });
      }
    } else if (this.activeRequestId) {
      getBridge()?.aiStreamAnswer(this.activeRequestId, answer);
    }
  }

  public approvePlan(): void {
    this.sendPendingPlanDecision('approve_plan');
  }

  public rejectPlan(): void {
    this.sendPendingPlanDecision('reject_plan');
  }

  public steer(message: string): void {
    this.sendDurableCommand('steer', { message });
  }

  public recover(
    projectId: string,
    existingEvents: readonly AiEvent[],
  ): AsyncIterable<AiEvent> | null {
    const handle = this.loadRunHandle(projectId);
    if (handle === null) return null;
    this.activeDurableRun = { runId: handle.runId, projectId: handle.projectId };
    this.lastDurableRun = this.activeDurableRun;
    return this.replayDurableRun(handle, existingEvents);
  }

  public recoveryConversationId(projectId: string): string | null {
    return this.loadRunHandle(projectId)?.conversationId ?? null;
  }

  private async *replayDurableRun(
    initialHandle: DurableRunHandle,
    existingEvents: readonly AiEvent[],
  ): AsyncIterable<AiEvent> {
    const bridge = getBridge();
    if (!bridge?.runSubscribe || !bridge.onRunEvent || !bridge.runUnsubscribe) {
      throw new Error('Durable run recovery is unavailable.');
    }
    let handle = initialHandle;
    this.transportDetached = false;
    const knownEvents = new Set(existingEvents.map((event) => JSON.stringify(event)));
    const inbox: DurableRunEventMessage[] = [];
    let notify: (() => void) | null = null;
    const removeListener = bridge.onRunEvent((message) => {
      inbox.push(message);
      const resume = notify;
      notify = null;
      resume?.();
    });
    let subscriptionId: string | null = null;
    try {
      for (;;) {
        if (this.transportDetached) return;
        const subscription = await bridge.runSubscribe({
          runId: handle.runId,
          projectId: handle.projectId,
          afterSequence: handle.cursor,
        });
        subscriptionId = subscription.subscriptionId;
        for (const event of subscription.events) {
          const replay = streamEventFromDurable(event);
          if (replay !== null && !knownEvents.has(JSON.stringify(replay))) {
            yield replay;
            knownEvents.add(JSON.stringify(replay));
          }
          handle = { ...handle, cursor: event.sequence };
          this.saveRunHandle(handle);
          bridge.runAck?.({ subscriptionId, sequence: event.sequence });
          // A run that reached a terminal state WHILE the sidebar was closed replays its
          // `run.terminal` here, in the initial buffered batch — not as a live message.
          // Without this the generator would fall through to the inbox wait below and
          // block forever on a run that is already over, leaving the composer stuck on
          // "Stop" (never returning ⇒ AiSidebar never clears `running`). Mirror the live
          // loop: finish the recovery the moment the terminal event is seen — first
          // emitting the matching status so the recovered conversation resolves instead
          // of shimmering at its last streamed status.
          if (event.kind === 'run.terminal') {
            const reason = terminalReasonFromDurable(event, handle.conversationId);
            if (reason !== null && !knownEvents.has(JSON.stringify(reason))) yield reason;
            const terminal = terminalStatusFromDurable(event, handle.conversationId);
            if (terminal !== null && !knownEvents.has(JSON.stringify(terminal))) yield terminal;
            this.clearRunHandle(handle.projectId);
            return;
          }
        }
        if (subscription.hasMore) {
          bridge.runUnsubscribe(subscriptionId);
          subscriptionId = null;
          continue;
        }
        const subscribedSnapshot = subscription.snapshot;
        if (subscribedSnapshot !== null && isTerminalDurableStatus(subscribedSnapshot.status)) {
          for (const terminalEvent of terminalEventsFromSnapshot(
            subscribedSnapshot,
            handle.conversationId,
          )) {
            if (!knownEvents.has(JSON.stringify(terminalEvent))) yield terminalEvent;
          }
          this.clearRunHandle(handle.projectId);
          return;
        }

        for (;;) {
          if (this.transportDetached) return;
          const message = inbox.shift();
          if (message === undefined) {
            await new Promise<void>((resolve) => {
              notify = resolve;
              this.wakeTransport = resolve;
            });
            this.wakeTransport = null;
            continue;
          }
          if (message.subscriptionId !== subscriptionId) continue;
          if (message.resyncRequired !== undefined) {
            handle = { ...handle, cursor: message.resyncRequired.afterSequence };
            this.saveRunHandle(handle);
            bridge.runUnsubscribe(subscriptionId);
            subscriptionId = null;
            break;
          }
          if (message.event === undefined) continue;
          const replay = streamEventFromDurable(message.event);
          if (replay !== null && !knownEvents.has(JSON.stringify(replay))) {
            yield replay;
            knownEvents.add(JSON.stringify(replay));
          }
          handle = { ...handle, cursor: message.event.sequence };
          this.saveRunHandle(handle);
          bridge.runAck?.({ subscriptionId, sequence: message.event.sequence });
          if (message.event.kind === 'run.terminal') {
            const reason = terminalReasonFromDurable(message.event, handle.conversationId);
            if (reason !== null && !knownEvents.has(JSON.stringify(reason))) yield reason;
            const terminal = terminalStatusFromDurable(message.event, handle.conversationId);
            if (terminal !== null && !knownEvents.has(JSON.stringify(terminal))) yield terminal;
            this.clearRunHandle(handle.projectId);
            return;
          }
        }
      }
    } finally {
      if (subscriptionId !== null) bridge.runUnsubscribe(subscriptionId);
      removeListener();
      this.flushRunHandle();
      this.wakeTransport = null;
      // Same rule as the live lane: a detached recovery leaves the host run running,
      // so keep it commandable (Stop must still reach it). See `run`'s finalizer.
      if (!this.transportDetached) this.activeDurableRun = null;
    }
  }

  private sendPendingPlanDecision(kind: 'approve_plan' | 'reject_plan'): void {
    const active = this.activeDurableRun;
    const bridge = getBridge();
    if (!active || !bridge?.runSnapshot) return;
    void bridge
      .runSnapshot(active)
      .then((snapshot) => {
        if (
          typeof snapshot?.pendingGate !== 'object' ||
          snapshot.pendingGate === null ||
          Array.isArray(snapshot.pendingGate)
        ) {
          return;
        }
        const planId = (snapshot.pendingGate as Record<string, unknown>)['gateId'];
        if (typeof planId !== 'string') return;
        this.sendDurableCommand(kind, { planId });
      })
      .catch((error: unknown) => {
        log.warn('durable plan decision failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  public decidePatch(
    patchId: string,
    decision: 'accepted' | 'rejected',
    projectRevision?: number,
  ): void {
    const target = this.lastDurableRun;
    const bridge = getBridge();
    if (!target || !bridge?.runCommand) return;
    const kind = decision === 'accepted' ? 'accept_patch' : 'reject_patch';
    void bridge
      .runCommand({
        ...target,
        kind,
        payload: {
          patchId,
          ...(projectRevision === undefined ? {} : { projectRevision }),
        },
      })
      .catch((error: unknown) => {
        log.warn('durable patch decision failed', {
          patchId,
          decision,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  public patchRunId(): string | undefined {
    return this.lastDurableRun?.runId;
  }

  private sendDurableCommand(
    kind: 'answer' | 'steer' | 'cancel' | 'approve_plan' | 'reject_plan',
    payload: unknown,
  ): void {
    const active = this.activeDurableRun;
    const bridge = getBridge();
    if (!active || !bridge?.runCommand) return;
    void bridge.runCommand({ ...active, kind, payload }).catch((error: unknown) => {
      log.warn('durable run command failed', {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private sendCancellationOnce(payload: {
    readonly source: 'user_stop' | 'question_dismissed';
    readonly reason: string;
  }): void {
    const runId = this.activeDurableRun?.runId;
    if (runId === undefined || this.cancellationSentForRun === runId) return;
    this.cancellationSentForRun = runId;
    this.sendDurableCommand('cancel', payload);
  }
}

/**
 * Build a browser provider from the saved AI config (Settings → AI). Unlike the
 * desktop path — where the key stays in the main process — the direct-SDK browser
 * path needs the key in the renderer, so it comes from the localStorage-backed
 * config. Falls back to the offline {@link MockProvider} when no real key is saved.
 */
function buildBrowserProvider(name: ProviderName, cfg: BrowserAiConfig): AiProvider {
  // Ollama is local and needs no key; everything else without one falls back to the
  // offline mock rather than constructing a client that would 401 on first use.
  const key = cfg.keys[name];
  if (name === 'mock' || (name !== 'ollama' && !key)) {
    log.warn('buildBrowserProvider → falling back to MockProvider (no key for selected provider)', {
      requested: name,
    });
    return new MockProvider();
  }
  const config: ProviderConfig = {
    name,
    ...(key ? { apiKey: key } : {}),
    ...(cfg.models[name] ? { model: cfg.models[name] } : {}),
    ...(cfg.baseUrls[name] ? { baseUrl: cfg.baseUrls[name] } : {}),
  };
  log.action('buildBrowserProvider → provider', {
    provider: name,
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: Boolean(config.apiKey),
  });
  // One seam for every provider (ADR 0105). This was a seven-branch chain constructing
  // native adapter classes; the branches differed only in which key/model/baseUrl field
  // they read, which is exactly what indexing by `name` does.
  return createProviderFromConfig(config);
}

/**
 * Build the streaming session for the current runtime.
 * - Inside Electron: the IPC-backed {@link DesktopAiSession} (fetch runs in main;
 *   the key stays there — the provider is chosen per run via `input.provider`).
 * - Outside Electron (browser/tests): a {@link BrowserAiSession} over the provider
 *   built from the saved config (active provider + key), or the offline mock.
 */
export const createAiSession = (provider?: ProviderName): AiSession => {
  if (getBridge()) return new DesktopAiSession();
  const cfg = loadBrowserAiConfig();
  const name = provider ?? cfg.activeProvider;
  return new BrowserAiSession(
    new Orchestrator(withResilience(buildBrowserProvider(name, cfg)), browserOrchestratorOptions()),
  );
};

/**
 * Run caption emphasis through the provider selected in Settings.
 *
 * Desktop calls the trusted main-process orchestration path so API keys never
 * enter the renderer. Browser/dev calls the configured provider directly. Both
 * paths schema-validate model output and return the same deterministic fallback
 * when the provider is absent, offline, or malformed.
 */
export async function requestAiCaptionEmphasis(
  project: Project,
  transcript: readonly TranscriptWord[],
): Promise<CaptionEmphasisAnalysis> {
  if (getBridge()) {
    try {
      const response = await new IpcOrchestrator().chat({
        project,
        userPrompt: buildCaptionEmphasisPrompt(transcript),
      });
      return (
        parseCaptionEmphasisResponse(response.text, transcript) ??
        fallbackCaptionEmphasis(transcript)
      );
    } catch (error) {
      log.warn('Desktop caption emphasis failed; using local fallback.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return fallbackCaptionEmphasis(transcript);
    }
  }
  const config = loadBrowserAiConfig();
  return analyzeCaptionEmphasis(
    withResilience(buildBrowserProvider(config.activeProvider, config)),
    transcript,
  );
}

/**
 * Cards already built, keyed on the edit they describe.
 *
 * An `EditResult` is immutable once its event has landed, so its card is a pure
 * function of an object identity — which makes this a cache with no invalidation
 * rule to get wrong, and lets entries die with their conversation.
 *
 * It exists because the card is NOT cheap: `structuredDiffTimeline` compares
 * clips by `JSON.stringify`, so building one serialises every clip of both the
 * before and after timeline. The sidebar rebuilt every visible diff card from
 * scratch on each streamed frame batch (its memo keys on `view.nodes`, whose
 * identity changes ~60x/s during a run), so a long run with dense keyframes
 * turned steady-state streaming into GB/s of large-string allocation — the kind
 * of pressure that makes RSS climb even though nothing is retained.
 */
const reviewCards = new WeakMap<EditResult, ReviewCard>();

/** Project an {@link EditResult} into the review card the UI renders. */
export function toReviewCard(result: EditResult): ReviewCard {
  const cached = reviewCards.get(result);
  if (cached) return cached;
  const card = buildReviewCard(result);
  reviewCards.set(result, card);
  return card;
}

function buildReviewCard(result: EditResult): ReviewCard {
  const diff = result.diff;
  // Guard `before`/`after` individually (not just `diff`): some fixtures/older
  // callers construct a partial diff (e.g. `{ summary: [] }`) without the two
  // timelines, so a truthy `diff` doesn't guarantee they're present.
  const hasTimelines = Boolean(diff?.before && diff?.after);
  return {
    reason: result.text,
    changes: diff?.summary ?? [],
    valid: result.validation.valid,
    problems: result.validation.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message),
    operationCount: result.patch.operations.length,
    ...(hasTimelines ? { before: diff!.before, after: diff!.after } : {}),
    changedRegions: hasTimelines ? structuredDiffTimeline(diff!.before, diff!.after) : [],
  };
}
