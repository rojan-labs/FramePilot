/**
 * The streaming AI sidebar shell (Phase 11 M4, ADR 0033).
 *
 * Replaces the single-shot `AiPanel` body: a fixed header (mode segmented control,
 * New Chat, run status), a **virtualized** conversation/activity area, and a docked
 * composer. The view is a pure function of the active conversation's event log
 * (`reduceEvents`) — streaming just appends events; each row re-renders in place by
 * id. Auto-scrolls while streaming and offers "Jump to Latest" once the user scrolls
 * up. Drives the {@link AiSession} transport (M3) and the conversation store (M2).
 *
 * Only honest affordances ship here: mode + New Chat + send/stop are functional;
 * History/Search/Settings land with M7/M8 (no dead buttons — build-order rule).
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  captureEditorInteractionContext,
  createPlanApprovalGate,
  createSteeringQueue,
  createTurnEmitter,
  projectNames,
  readMemory,
  recordAccepted,
  recordRejected,
  summarizeUsage,
  writeMemory,
  type AiEvent,
  type InteractionKeyframeRef,
  type Reference,
  type MemoryPreferenceKey,
  type PlanApprovalGate,
  type SteeringQueue,
  type SourceMonitorInteraction,
  type ViewNode,
  decideReferenceRole,
} from '@framepilot/ai-sdk';
import type { AnyOperation } from '@framepilot/editor-core';
import { safeParseProject, type Project } from '@framepilot/timeline-schema';
import { toReviewCard } from '../../editor/ai.js';
import { clearAgentActivity, publishAgentActivity } from '../../editor/agent-activity.js';
import { toolMeta } from './toolMeta.js';
import type { Patch } from '@framepilot/editor-core';
import {
  type AiSession,
  type AiSessionInput,
  type AiSessionMode,
  createAiSession,
  historyFromEvents,
  recordReviewDecision,
} from '../../editor/ai.js';
import { useAiConfig } from '../../editor/useAiConfig.js';
import { useSettings } from '../../editor/useSettings.js';
import { recordUsageRun } from '../../editor/usageHistory.js';
import { loadUserMemory } from '../../editor/userMemoryStorage.js';
import type { UseEditor } from '../../editor/useEditor.js';
import { selectionRange } from '../../editor/selectors.js';
import {
  type ConversationBridge,
  type ConversationPersistence,
  resolveConversationPersistence,
  scopeConversationPersistence,
} from '../../ai/conversationPersistence.js';
import { useConversations } from '../../ai/useConversations.js';
import { useConversationView } from '../../ai/useConversationView.js';
import { createFrameBatcher, createIntervalScheduler } from '../../ai/frameBatcher.js';
import { emptyRunNotice, foldTurnEvent, initialTurnSignals } from '../../ai/runOutcome.js';
import { latestStreamingAssistantText } from '../../ai/liveAnnouncement.js';
import type { MessageAttachment, ReferenceProfile, ReferenceRole } from '@framepilot/ai-sdk';
import { ReferenceProfileSchema } from '@framepilot/ai-sdk';
import { MAX_REFERENCES_PER_TURN, createLogger } from '@framepilot/shared-types';
import { analyzeReference, getBridge, isDesktop } from '../../editor/bridge.js';
import { materializeImportedMedia, probeMediaFile } from '../../editor/import.js';
import {
  ArrowDown,
  Copy,
  Download,
  History,
  ICON_SIZE,
  Key,
  type LucideIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Sparkles,
} from '../icons.js';
import { Menu, MenuItem } from '../Menu.js';
import { Tooltip } from '../Tooltip.js';
import { Switch } from '@framepilot/ui';
import type { AiStreamAnswerMessage } from '@framepilot/shared-types';
import { EventNode, type RevealHandler } from './EventNode.js';
import { copyText, downloadText, HistoryDrawer } from './HistoryDrawer.js';
import { toMarkdown } from '../../ai/conversationExport.js';
import { TaskRunView } from './TaskRunView.js';
import { PlanApprovalCard } from './PlanApprovalCard.js';
import { PlanAccordion } from './PlanAccordion.js';
import type { StepOutcome } from './EventNode.js';
import { SteeringInput } from './SteeringInput.js';
import { explainRunFailure } from '../../ai/runFailure.js';
import { starterPrompts } from '../../ai/starterPrompts.js';
import {
  formatDurationDelta,
  formatRunChangeGroups,
  summarizeRunChanges,
} from '../../ai/runSummary.js';
import { PlayheadContextChip } from './PlayheadContextChip.js';
import { Composer } from './Composer.js';
import {
  MEMORY_CHIP_PREFIX,
  type RememberedDecision,
  type ComposerSelection,
  type PinnedEntity,
  buildContextItems,
  pinnableEntities,
} from '../../ai/composerActions.js';
import { recordProviderSuccess } from '../../editor/providerHealth.js';
import { LruCache } from '../../editor/lruCache.js';
import {
  activeReferences,
  isDefaultUiState,
  referencesToDismissForCap,
  toMessageAttachments,
  type Attachment,
  type Conversation,
  type ConversationUiState,
} from '../../ai/conversation.js';
import { contextPhase, latestContextWindow } from './ContextWindowIndicator.js';
import { type ContextDebugInfo, recentManifests } from './ContextDebugger.js';

/** The three modes the sidebar exposes (assignable to both AiSessionMode + ConversationMode). */
type SidebarMode = 'agent' | 'chat' | 'edit';

const MODES: readonly SidebarMode[] = ['agent', 'chat', 'edit'];

/** Per-mode label, icon, and one-line hint shown in the mode dropdown. */
const MODE_META: Record<SidebarMode, { label: string; Icon: LucideIcon; hint: string }> = {
  agent: { label: 'Agent', Icon: Sparkles, hint: 'Plans and edits over multiple steps' },
  chat: { label: 'Chat', Icon: MessageSquare, hint: 'Ask about your video and transcript' },
  edit: { label: 'Edit', Icon: Pencil, hint: 'One quick, reviewable edit' },
};

/** Hint for the agent "Plan first" toggle (shown as its tooltip in the header). */
const PLAN_FIRST_HINT = 'Draft a step-by-step plan before editing';

/** Persisted UI preference for the agent "Plan first" toggle (same rationale as
    apply mode: a UI choice, not project state, so no schema/migration). */
const PLAN_FIRST_STORAGE_KEY = 'framepilot.ai.planFirst';

/** Read the saved "Plan first" choice; defaults to `true` (an up-front plan makes a
    long, multi-step run more legible). Only an explicit stored 'false' turns it off,
    so a missing/garbled value or unavailable storage falls back to the default. */
function loadPlanFirst(): boolean {
  try {
    return globalThis.localStorage?.getItem(PLAN_FIRST_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

const newId = (): string => globalThis.crypto.randomUUID();
/** True for the `AbortError` a Stop/close raises through the browser stream — a clean
    cancellation, not a run failure. */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
/** Treat the list as "at bottom" within this many px (avoids jitter). */
const BOTTOM_THRESHOLD_PX = 48;
/**
 * Virtualize only once a conversation is large. Short conversations render plainly
 * (cheaper, and DOM-measurement-free); the virtualized path carries the 20k-event
 * perf budget (M9). 60fps holds either way because rows are keyed and merge by id.
 */
const VIRTUALIZE_THRESHOLD = 60;
/** Text is visually smooth at 20 Hz; 60 Markdown/layout commits starve the editor. */
const AI_STREAM_RENDER_SCHEDULER = createIntervalScheduler(50);

/**
 * Per-conversation scroll continuity ACROSS a remount, held OUTSIDE React.
 *
 * WHY: every mutating AI tool call publishes an authoritative project, and the app
 * deliberately remounts the whole editor (`key={project.id}:{reloadNonce}` in `App.tsx`)
 * so the timeline store re-seeds. That remount re-creates this component, so the
 * follow-the-stream flag lived and died with it. The persisted `uiState.scrollOffset`
 * could not stand in for it: a reader pinned to the bottom has a LARGE offset, and
 * restoring that number after the log grew lands mid-thread and — worse — reads as
 * "not at the bottom", so auto-follow stayed off. That is the reported bug: a mutate
 * tool call yanks the view back to an older message, "Jump to latest" fixes it until
 * the next mutation, forever.
 *
 * Same-document remounts are immediate, so carrying the exact live value across one is
 * a restore, never a guess. {@link ConversationUiState} keeps owning the COLD-start
 * (reload) case; this map only wins while the tab is alive.
 *
 * Bounded (P6.2): the key is a conversation id, so an unbounded Map would keep one
 * entry per conversation ever opened for the life of the tab, across every project.
 * Only the conversation being remounted can use its entry, so a small LRU loses
 * nothing the cache was ever able to serve.
 */
const MAX_CACHED_SCROLL_STATES = 32;
const scrollStateCache = new LruCache<string, { offset: number; stick: boolean }>(
  MAX_CACHED_SCROLL_STATES,
);

/**
 * Drop the cross-remount scroll cache — called on project switch (P6.2), and by tests,
 * which would otherwise leak a previous mount's scroll position into the next.
 */
export function resetAiSidebarScrollCache(): void {
  scrollStateCache.clear();
}

/** How many conversations' scroll states are cached right now (tests, resource probes). */
export function aiSidebarScrollCacheSize(): number {
  return scrollStateCache.size;
}

/** Order-insensitive equality for the two small id lists in {@link ConversationUiState}. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(b);
  return a.every((id) => seen.has(id));
}

export interface AiSidebarProps {
  readonly project: Project;
  /** Host-owned optimistic-concurrency revision for durable desktop runs. */
  readonly projectRevision?: number;
  /** Reveal a referenced clip/track/asset in the editor. */
  readonly onReveal?: RevealHandler;
  /** The editor store — required to Accept a diff (commits via the validated path). */
  readonly editor?: UseEditor;
  readonly selectedEffectLayerIds?: readonly string[];
  readonly selectedKeyframes?: readonly InteractionKeyframeRef[];
  readonly sourceMonitor?: SourceMonitorInteraction;
  /** Persist a project mutation (records accept/reject learning into aiMemory). */
  readonly onProjectChange?: (project: Project) => void;
  /** Replace the workspace from an authoritative desktop patch commit. */
  readonly onProjectCommit?: (project: Project, revision: number) => void;
  /** Injectable session for tests; defaults to the runtime session. */
  readonly session?: AiSession;
  /** Injectable persistence for tests; defaults to the resolved backend. */
  readonly persistence?: ConversationPersistence;
  /** Open Settings → AI (from the active-model badge). Wired by the editor shell. */
  readonly onOpenSettings?: () => void;
}

/**
 * Imperative escape hatch for callers that need to send a prompt into the
 * sidebar's one real request-building path (`runTurn`) without going through
 * the composer text field — e.g. the Cmd+K command palette (P12.2) and the
 * point-react-refine "Ask AI about this clip" trigger (P13.3). Both route
 * through this same handle, so there is no parallel request-building path.
 */
export interface AiSidebarHandle {
  /** Fire-and-forget: runs `text` through the same `runTurn` the composer uses. */
  runQuickEdit: (text: string) => void;
}

/**
 * Capture the document the user can see at the instant an AI turn starts.
 *
 * `project` is the persisted/app-level document, while `useEditor` owns the live
 * patch-engine state. Import and autosave are asynchronous, so the two can briefly
 * disagree. Read tools must follow the visible editor state or `list_assets` can
 * truthfully inspect the wrong (older) document and report an empty bin.
 */
export function projectSnapshotForAiRun(project: Project, editor?: UseEditor): Project {
  const state = editor?.state;
  if (!state) return project;
  return {
    ...project,
    timeline: state.timeline ?? project.timeline,
    assets: (state.assets ?? project.assets) as Project['assets'],
    folders: (state.folders ?? project.folders) as Project['folders'],
    markers: (state.markers ?? project.markers) as Project['markers'],
    transcript: (state.transcript ?? project.transcript) as Project['transcript'],
  };
}

const log = createLogger('web-editor:ai-sidebar');

/**
 * The short phrase the floating agent control shows for one streamed event.
 *
 * Only events that mark a change of activity produce a phrase; everything else
 * returns the previous one by returning `null`, which the control renders as a
 * plain "Working". Deliberately reuses `toolMeta`'s labels — the same words the
 * sidebar shows for that tool — so the button and the panel never describe the
 * same step differently.
 */
export function activityLabelFor(event: AiEvent): string | null {
  // Structural, not a `kind === 'tool'` narrow: the union has several shapes and
  // only some carry `toolName`, so this reads the two fields it needs without
  // asserting which member it was handed.
  const candidate = event as { readonly kind?: unknown; readonly toolName?: unknown };
  if (candidate.kind === 'tool' && typeof candidate.toolName === 'string') {
    return toolMeta(candidate.toolName).label;
  }
  return null;
}

/**
 * Parse a profile the host returned into the SDK's canonical `ReferenceProfile`.
 *
 * The IPC type (`AiStreamReferenceProfile`) widens `video`/`image` to
 * `Record<string, unknown>`, so it cannot be assigned to the type the run needs. The
 * sidebar used to bridge that with `as unknown as ReferenceProfile` — a cast that
 * silences the compiler in both directions and would have gone on compiling if either
 * shape drifted. This is a real boundary: the analysis crosses a process, so its answer
 * is external input and gets validated like any other.
 *
 * A profile that fails to parse is dropped rather than sent. A malformed profile reaching
 * the model is worse than no profile: the run would cite constraints it cannot trust,
 * whereas an absent one simply means the reference contributes nothing this turn.
 */
function toReferenceProfile(profile: unknown): ReferenceProfile | undefined {
  const parsed = ReferenceProfileSchema.safeParse(profile);
  if (parsed.success) return parsed.data;
  log.warn('reference profile from host failed validation — dropping it', {
    issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
  });
  return undefined;
}

export const AiSidebar = forwardRef<AiSidebarHandle, AiSidebarProps>(function AiSidebar(
  {
    project,
    projectRevision,
    onReveal,
    editor,
    selectedEffectLayerIds = [],
    selectedKeyframes = [],
    sourceMonitor,
    onProjectChange,
    onProjectCommit,
    session: injectedSession,
    persistence: injectedPersistence,
    onOpenSettings,
  }: AiSidebarProps,
  ref,
): JSX.Element {
  const persistence = useMemo(
    () =>
      scopeConversationPersistence(
        injectedPersistence ??
          resolveConversationPersistence(getBridge() as ConversationBridge | null),
        project.id,
      ),
    [injectedPersistence, project.id],
  );
  const conversations = useConversations(persistence, project.id);
  const { hydrate } = conversations;
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Which provider/model AI runs use is now owned by Settings → AI (one source of
  // truth), not a picker in this header. The desktop key stays in the main process;
  // the browser session reads its key from the saved config. Rebuild the session when
  // the active provider (or a saved key/model, reflected in `config`) changes.
  const { config } = useAiConfig();
  const activeProviderName = config.activeProvider;
  const activeProvider =
    config.providers.find((p) => p.name === activeProviderName) ?? config.providers[0];
  const session = useMemo(
    () =>
      injectedSession ??
      createAiSession(activeProviderName === 'mock' ? undefined : activeProviderName),
    [injectedSession, activeProviderName, config],
  );
  const [mode, setMode] = useState<SidebarMode>('agent');
  // Agent-mode option: draft an up-front plan the run then follows (R3 C4). Default on
  // — for a long, multi-step edit (e.g. a podcast) an explicit plan makes the run more
  // legible and gives the self-repair pass a target. Ignored by chat/edit. Persisted as
  // a UI preference so the choice survives reloads.
  const [planFirst, setPlanFirstState] = useState<boolean>(loadPlanFirst);
  const setPlanFirst = useCallback((next: boolean) => {
    setPlanFirstState(next);
    try {
      globalThis.localStorage?.setItem(PLAN_FIRST_STORAGE_KEY, String(next));
    } catch {
      /* storage unavailable (private mode / SSR) — keep the in-memory choice */
    }
  }, []);
  // Edit-mode option: opt in to 2 alternative takes on the same request (H1.5/P13.1 —
  // "variations / A-B compare"). Off by default — each extra take is a REAL, separately
  // billed model call (cost-honesty invariant, lens §2.5.6), so this is never silently
  // turned on for the user. Browser-only for now (see `AiSessionInput.variations`); the
  // toggle itself is hidden with an Electron bridge present rather than offered and
  // silently ignored. Reset on every submit isn't needed — a genuine "always show me
  // alternatives" preference is a reasonable thing to leave on across turns.
  const [wantVariations, setWantVariations] = useState(false);
  const [draft, setDraft] = useState('');
  const [running, setRunningState] = useState(false);
  // A ref mirror of `running`, so an effect can GUARD on "is a run live?" without taking
  // `running` as a dependency. The durable-run recovery effect below sets it, and a
  // dependency on state it sets would tear its own recovery down one render later.
  const runningRef = useRef(false);
  const setRunning = useCallback((next: boolean) => {
    runningRef.current = next;
    setRunningState(next);
    // Mirror it into the out-of-React activity store, so the floating control can
    // offer a way back to this run from anywhere without the editor subscribing to
    // anything. One chokepoint, so the two can never disagree about whether a run
    // is live — see `editor/agent-activity.ts` for why it is not a prop.
    if (next) publishAgentActivity({ running: true, label: null });
    else clearAgentActivity();
  }, []);
  // Clear the agent indicator if this panel goes away mid-run — closing or
  // switching projects unmounts it, and the store is module scope, so without this
  // a run that never reaches its own `setRunning(false)` would leave a permanent,
  // undismissable "FramePilot is working" button over the NEXT project.
  useEffect(() => clearAgentActivity, []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [removedContext, setRemovedContext] = useState<readonly string[]>([]);
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  // Read inside async callbacks (re-analyze) so they never close over a stale list.
  const attachmentsRef = useRef<readonly Attachment[]>(attachments);
  attachmentsRef.current = attachments;
  /**
   * References the editor has taken out of force (P3.5's removal, relocated).
   *
   * Removal used to be "delete the composer tile", which only worked because the tiles
   * never cleared. Now that a sent attachment belongs to its message, the record of it
   * must stay put and the POLICY has to move somewhere of its own — a message is history
   * and history does not change. Dismissing is therefore conversation state, and the
   * bubble's tile is where it is expressed, because that is where the reference is
   * visible.
   */
  const [dismissedReferenceIds, setDismissedReferenceIds] = useState<readonly string[]>([]);
  const dismissedReferenceIdsRef = useRef<readonly string[]>(dismissedReferenceIds);
  dismissedReferenceIdsRef.current = dismissedReferenceIds;
  /**
   * Reference attachments (plan/system-mission P3.1–P3.4): copy the file into the project
   * through the same chunked import the media bin uses, let the host analyze it once, and
   * hold the profile on the chip so the next turn sends it as `references`. The role is
   * decided from the words in the draft and the file; the chip shows it.
   */
  const attachReferenceFiles = useCallback(
    async (files: readonly File[]) => {
      const projectId = projectRef.current.id;
      for (const file of files) {
        const kind: Attachment['kind'] = file.type.startsWith('image/')
          ? 'image'
          : file.type.startsWith('video/')
            ? 'video'
            : 'document';
        const id = `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        if (kind !== 'image' && kind !== 'video') {
          setAttachments((list) => [
            ...list,
            {
              id,
              kind,
              name: file.name,
              status: 'unsupported',
              error: 'Only video and image references are analyzed.',
            },
          ]);
          continue;
        }
        // Refused HERE, where the editor still has the file in hand and the composer to
        // remove something from. The host rejects a turn carrying more than this, and that
        // refusal lands at the transport boundary — after submit has emptied the composer —
        // so a run that discovers the limit has nothing left to fix and a Retry that fails
        // identically. Counting what is already in force, not just what is in the composer,
        // because references accumulate across turns.
        const inForce =
          activeReferences(activeEventsRef.current, dismissedReferenceIdsRef.current).length +
          attachmentsRef.current.filter((a) => a.profile !== undefined).length;
        if (inForce >= MAX_REFERENCES_PER_TURN) {
          setAttachments((list) => [
            ...list,
            {
              id,
              kind,
              name: file.name,
              status: 'unsupported',
              error: `Already using ${String(MAX_REFERENCES_PER_TURN)} references. Stop using one first.`,
            },
          ]);
          continue;
        }
        const decision = decideReferenceRole({ kind, fileName: file.name, promptText: draft });
        setAttachments((list) => [
          ...list,
          { id, kind, name: file.name, role: decision.role, status: 'analyzing' },
        ]);
        const update = (patch: Partial<Attachment>): void =>
          setAttachments((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
        if (!isDesktop()) {
          update({
            status: 'unsupported',
            error: 'Reference analysis requires the FramePilot desktop app.',
          });
          continue;
        }
        try {
          const probed = await probeMediaFile(file);
          // `'attachments'` — NOT the media bin. The copy lands in the folder the host's
          // reachability sweep owns, which is what lets it ever be reclaimed: an
          // attachment written beside the user's footage is indistinguishable from it and
          // has to be kept forever.
          const media = await materializeImportedMedia(probed, file, projectId, 'attachments');
          const result = await analyzeReference({
            projectId,
            inputPath: media.path,
            id,
            fileName: file.name,
            kind,
            role: decision.role,
          });
          if (!result.ok) {
            // A licensing refusal is not a failed measurement. `failed` opens the tile's
            // detail with a Re-analyze button beside it, and that retry is guaranteed to
            // be refused identically until the app is activated; `unsupported` states the
            // reason and offers no action that cannot work.
            update({
              status: result.reason === 'unlicensed' ? 'unsupported' : 'failed',
              error: result.error,
              path: media.path,
            });
            continue;
          }
          const profile = toReferenceProfile(result.profile);
          if (profile === undefined) {
            update({
              status: 'failed',
              path: media.path,
              error: 'The analysis came back in a shape this build does not understand.',
            });
            continue;
          }
          update({ status: 'ready', path: media.path, profile });
        } catch (error) {
          update({
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    [draft],
  );

  /**
   * Measure an attached reference again (P3.6) — the analysis failed, or the editor
   * changed its role and wants the constraints re-derived for it.
   *
   * The original `File` is long gone; the imported copy under the projects root is what
   * the host analyzed and what it re-analyzes, with `refresh` so the content-hash cache
   * is bypassed rather than handing back the same stale answer.
   */
  const reanalyzeReference = useCallback(async (id: string, roleOverride?: ReferenceRole) => {
    const current = attachmentsRef.current.find((entry) => entry.id === id);
    if (!current?.path || (current.kind !== 'image' && current.kind !== 'video')) return;
    const role = roleOverride ?? current.role ?? 'style';
    const update = (patch: Partial<Attachment>): void =>
      setAttachments((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    // A retry starts clean: the previous failure's reason must not survive under a
    // spinner, or the tile shows an error for an analysis that is running right now.
    setAttachments((list) =>
      list.map((a) =>
        a.id === id
          ? {
              id: a.id,
              kind: a.kind,
              name: a.name,
              ...(a.path !== undefined ? { path: a.path } : {}),
              role,
              status: 'analyzing' as const,
            }
          : a,
      ),
    );
    try {
      const result = await analyzeReference({
        projectId: projectRef.current.id,
        inputPath: current.path,
        id,
        fileName: current.name,
        kind: current.kind,
        role,
        refresh: true,
      });
      if (!result.ok) {
        // Same distinction as the first analysis: an unlicensed build must not be
        // re-offered a retry (see `attachReferenceFiles`).
        update({
          status: result.reason === 'unlicensed' ? 'unsupported' : 'failed',
          error: result.error,
        });
        return;
      }
      const profile = toReferenceProfile(result.profile);
      if (profile === undefined) {
        update({
          status: 'failed',
          error: 'The analysis came back in a shape this build does not understand.',
        });
        return;
      }
      update({ status: 'ready', profile });
    } catch (error) {
      update({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }, []);
  // Event handlers and an imperative Cmd+K send can run between React commits. Keep
  // refs updated during render and dereference them only when the turn is submitted,
  // so the request never captures a previous render's empty asset array.
  const projectRef = useRef(project);
  const editorRef = useRef(editor);
  projectRef.current = project;
  editorRef.current = editor;
  // "@" pin-context picker (H1.5, P8.7 narrow slice): clips/assets the user pinned as
  // extra context this turn, beyond the auto-derived selection chip. `atEntities` is the
  // full pinnable list the picker searches; `pinnedEntities` is what the user actually
  // picked (order-preserving, de-duped by kind+id so re-picking the same entity is a
  // no-op rather than a duplicate chip).
  const [pinnedEntities, setPinnedEntities] = useState<readonly PinnedEntity[]>([]);
  const atEntities = useMemo(() => pinnableEntities(project), [project]);
  const onPinEntity = useCallback((entity: PinnedEntity) => {
    setPinnedEntities((current) =>
      current.some((e) => e.kind === entity.kind && e.id === entity.id)
        ? current
        : [...current, entity],
    );
  }, []);
  // Close the selection↔context loop (P8.4/P12.7): resolve the editor's live clip
  // selection to a timeline range via the shared `selectionRange` helper (the single
  // source of truth for "selection → range", also used by the AI request builder
  // below) so the composer's chip and the request sent to the orchestrator always
  // agree on what "the selection" means. `undefined` (no chip, no selection sent)
  // when nothing is selected or every selected id is stale.
  const selectedIds = editor?.state?.selectedIds ?? [];
  const timeline = editor?.state?.timeline;
  const selectionRangeValue = useMemo(
    () => (timeline && selectedIds.length > 0 ? selectionRange(timeline, selectedIds) : null),
    [timeline, selectedIds],
  );
  const composerSelection: ComposerSelection | undefined = selectionRangeValue
    ? { range: selectionRangeValue, clipCount: selectedIds.length }
    : undefined;
  // What the AI remembers about this project (P8.2 "knows"): each preference is a chip
  // the editor can see and remove — and removing it forgets it, not just hides it.
  const remembered = useMemo<readonly RememberedDecision[]>(() => {
    const memory = readMemory(project);
    const labels: Record<MemoryPreferenceKey, string> = {
      targetAudience: 'audience',
      brandStyle: 'brand style',
      captionStyle: 'caption style',
      preferredPacing: 'pacing',
    };
    return (Object.keys(labels) as MemoryPreferenceKey[])
      .filter((key) => typeof memory[key] === 'string' && memory[key] !== '')
      .map((key) => ({ key, label: labels[key], value: memory[key] as string }));
  }, [project]);
  const forgetDecision = useCallback(
    (key: string) => {
      const memory = readMemory(project);
      if (!(key in memory)) return;
      const { [key as MemoryPreferenceKey]: _forgotten, ...rest } = memory;
      onProjectChange?.(writeMemory(project, rest as typeof memory));
    },
    [project, onProjectChange],
  );
  // UX-02: the empty state's suggestions are derived from this project, not four
  // hard-coded strings — the walkthrough caught it offering "Add captions from the
  // transcript" on a project with no transcript.
  const examplePrompts = useMemo(() => starterPrompts(project), [project]);
  const contextItems = useMemo(
    () =>
      buildContextItems(project, composerSelection, pinnedEntities, remembered).filter(
        (item) => !removedContext.includes(item.id),
      ),
    [project, composerSelection, pinnedEntities, remembered, removedContext],
  );

  const active = conversations.active;
  // Incremental fold (H1): only events appended since the last render are reduced,
  // so per-token render cost stays O(new events) instead of O(whole log).
  const view = useConversationView(active);
  // Which diffs this renderer has already committed, so the browser apply lane cannot
  // apply one twice (React 18 StrictMode double-invokes effects in dev).
  const [appliedNodes, setAppliedNodes] = useState<Record<string, 'applied' | 'failed'>>({});
  // A step and its edit are the same event described twice, so they render as one row.
  //
  // `planStepId` is stamped only when the run actually drafted a checklist (see the
  // orchestrator's runTurn), so an unplanned run — which renders no checklist — keeps its
  // standalone receipt cards and nothing disappears. A step whose edit failed to apply also
  // keeps its card: that is a problem to read, not a change count to fold away.
  const planStepIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of view.nodes) {
      if (node.kind === 'plan') for (const step of node.steps) ids.add(step.id);
    }
    return ids;
  }, [view.nodes]);
  const mergedDiffNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of view.nodes) {
      if (
        node.kind === 'diff' &&
        node.planStepId !== undefined &&
        planStepIds.has(node.planStepId) &&
        node.edit.validation.valid &&
        appliedNodes[node.id] !== 'failed' &&
        node.commit?.state !== 'stale'
      ) {
        ids.add(node.id);
      }
    }
    return ids;
  }, [view.nodes, planStepIds, appliedNodes]);
  const stepOutcomes = useMemo(() => {
    const outcomes = new Map<string, StepOutcome>();
    for (const node of view.nodes) {
      if (node.kind !== 'diff' || !mergedDiffNodeIds.has(node.id)) continue;
      const stepId = node.planStepId;
      if (stepId === undefined) continue;
      const region = toReviewCard(node.edit).changedRegions[0];
      const jumpSeconds = region?.afterRange?.start ?? region?.beforeRange?.start;
      outcomes.set(stepId, {
        operationCount: node.edit.patch.operations.length,
        ...(jumpSeconds === undefined ? {} : { jumpSeconds }),
      });
    }
    return outcomes;
  }, [view.nodes, mergedDiffNodeIds]);

  const { latestPlan, activityNodes } = useMemo(() => {
    let latest: Extract<ViewNode, { kind: 'plan' }> | undefined;
    const activity: ViewNode[] = [];
    for (const node of view.nodes) {
      if (node.kind === 'plan') latest = node;
      // A diff folded into its plan step is already on screen as that step's own outcome;
      // rendering it again here is the two-parallel-narratives problem the merge removes.
      else if (!mergedDiffNodeIds.has(node.id)) activity.push(node);
    }
    return { latestPlan: latest, activityNodes: activity };
  }, [view.nodes, mergedDiffNodeIds]);
  const virtualize = activityNodes.length > VIRTUALIZE_THRESHOLD;
  // D3a: the screen-reader live region lives OUTSIDE the (virtualized or plain)
  // list and announces only the latest streamed assistant text — not every row
  // mount/unmount. The virtualizer recycles DOM nodes as the user scrolls; an
  // `aria-live` region on that same container used to announce that scroll churn
  // as if it were new content. See `liveAnnouncement.ts` for the (unit-tested)
  // derivation.
  const latestAssistantText = latestStreamingAssistantText(view.nodes);
  const contextWindow = useMemo(() => latestContextWindow(active?.events), [active?.events]);
  // Derived from the same log the meter reads, so the phase can never outlive the
  // request that produced it.
  const phase = useMemo(() => contextPhase(active?.events, running), [active?.events, running]);
  // Dev only: the inspector needs the PREVIOUS request as well as the latest, because
  // "why did usage change" cannot be answered from one snapshot.
  const contextDebug = useMemo((): ContextDebugInfo | undefined => {
    if (!import.meta.env.DEV || !active) return undefined;
    const { previous, latest } = recentManifests(active.events);
    if (!latest) return undefined;
    return {
      conversationId: active.id,
      latest,
      ...(view.runState ? { working: view.runState.working } : {}),
      ...(previous ? { previous } : {}),
    };
  }, [active, view.runState]);

  // Accordion state for tool + diff cards, owned here so it survives virtualization
  // unmounts and lasts for the whole run (H2). Collapsed by default; keyed by node id.
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const onToggleExpanded = useCallback((nodeId: string, expandedNext: boolean) => {
    setExpandedNodes((current) => ({ ...current, [nodeId]: expandedNext }));
  }, []);

  // Commit through the CHECKED path: an AI patch was assembled against the project
  // as it was when the run started, and the timeline may have changed since. The
  // store validates against the current timeline and refuses a stale patch; we must
  // never report "Applied" (or record positive learning) for an edit that did not
  // land — that is a silent failure.
  const applyPatch = useCallback(
    async (patch: Patch): Promise<boolean> => {
      const bridge = getBridge();
      if (bridge?.commitProjectPatch && onProjectCommit) {
        const runId = session.patchRunId?.();
        const committed = await bridge.commitProjectPatch({
          projectId: project.id,
          expectedRevision: projectRevision ?? 0,
          patch,
          ...(runId === undefined ? {} : { runId }),
        });
        if (!committed.ok) return false;
        const parsed = safeParseProject(committed.project);
        if (!parsed.success) return false;
        onProjectCommit(recordAccepted(parsed.data, patch), committed.revision);
        recordReviewDecision(parsed.data, patch, 'accepted');
        session.decidePatch?.(patch.patchId, 'accepted', committed.revision);
        return true;
      }
      if (!editor) return false;
      const issues = editor.applyPatchChecked(patch);
      if (issues.length > 0) return false;
      if (onProjectChange) onProjectChange(recordAccepted(project, patch));
      // Narrative tier (B6.1) — only for an edit that actually landed, for the
      // same reason we only record the typed signal here: memory must reflect
      // what happened, not what was attempted.
      recordReviewDecision(project, patch, 'accepted');
      session.decidePatch?.(patch.patchId, 'accepted');
      return true;
    },
    [editor, onProjectChange, onProjectCommit, project, projectRevision, session],
  );
  const diffEnabled = Boolean(editor);
  // Every valid edit this renderer has not yet committed.
  //
  // A diff already carrying `commit` was written by the desktop host as it streamed, so
  // this lane must leave it alone; what remains is the browser/dev session, which has no
  // host and where this effect IS the apply path.
  const uncommittedDiffs = view.nodes.filter(
    (n): n is Extract<typeof n, { kind: 'diff' }> =>
      n.kind === 'diff' &&
      n.edit.validation.valid &&
      n.commit === undefined &&
      appliedNodes[n.id] === undefined,
  );
  // Commit each valid edit the moment it arrives. There is no review mode to fall back
  // to: an edit that validates is applied, and Undo is how it is taken back.
  const applyingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Desktop auto-commit is an explicit durable run policy executed in Electron.
    if (getBridge()?.commitProjectPatch) return;
    if (!diffEnabled || uncommittedDiffs.length === 0) return;
    for (const node of uncommittedDiffs) {
      if (applyingRef.current.has(node.id)) continue;
      applyingRef.current.add(node.id);
      void applyPatch(node.edit.patch).then((applied) => {
        setAppliedNodes((current) => ({ ...current, [node.id]: applied ? 'applied' : 'failed' }));
      });
    }
  }, [diffEnabled, uncommittedDiffs, applyPatch]);

  // Remember the last turn so a failed/cancelled run can be retried.
  /**
   * The last turn Retry replays — and WHICH conversation it belongs to.
   *
   * A single ref with no owner was replayable into the wrong chat: switching conversation
   * left it untouched, so a Retry offered on conversation B replayed A's prompt, and now
   * A's attachments, appending them to B's log as though the editor had sent them there.
   * Carrying the conversation id makes the ref answer "is this mine?" instead of the
   * caller having to remember to clear it, which is the discipline that failed.
   */
  const lastTurn = useRef<{
    conversationId: string;
    text: string;
    attachments: readonly MessageAttachment[];
  } | null>(null);
  // The session driving the CURRENT run. `session` is rebuilt when the provider
  // config changes; if that happens mid-run, Stop must abort the session that
  // actually owns the in-flight stream — not the freshly built one (H9 race).
  const runningSession = useRef<AiSession | null>(null);
  // Set the instant the user (or a conversation switch / window close) asks to stop,
  // read in `runTurn`'s finalizer so an aborted run is closed out as a clean
  // `cancelled` status — the desktop transport returns on `done` WITHOUT a terminal
  // status event, so without this the conversation would stay stuck shimmering.
  const stopRequestedRef = useRef(false);
  const recoveryStartedRef = useRef<Set<string>>(new Set());
  // P11.3/P11.4: the live, non-serialisable controls for the CURRENT agent run
  // (browser only — see `run-controls.ts`). Fresh per run; `null` when no agent run
  // is in flight, so a stray Approve/Cancel/steer click after a run ends is a no-op.
  const planApprovalGateRef = useRef<PlanApprovalGate | null>(null);
  const steeringQueueRef = useRef<SteeringQueue | null>(null);

  const recoveryConversationId = session.recoveryConversationId?.(project.id) ?? null;
  const recoveryConversation =
    recoveryConversationId === null ? undefined : conversations.state.byId[recoveryConversationId];
  const recoverySeedRef = useRef<Map<string, readonly AiEvent[]>>(new Map());
  if (
    recoveryConversationId !== null &&
    recoveryConversation !== undefined &&
    !recoverySeedRef.current.has(recoveryConversationId)
  ) {
    recoverySeedRef.current.set(recoveryConversationId, recoveryConversation.events);
  }
  const recoverySeed =
    recoveryConversationId === null
      ? undefined
      : recoverySeedRef.current.get(recoveryConversationId);
  const appendConversationEvent = conversations.append;
  const appendConversationEvents = conversations.appendMany;
  const openConversation = conversations.open;
  // Re-attach this renderer's projection to a durable host run that outlived the last
  // mount. This effect deliberately does NOT depend on `running` (it reads `runningRef`
  // instead): it SETS `running`, so depending on it made React tear the recovery down on
  // the very next render — the subscription was dropped milliseconds after it opened, the
  // "already recovered" guard below then refused to retry, and the host run streamed on
  // in the background with no attached UI and a Stop button that reached nothing.
  useEffect(() => {
    if (
      runningRef.current ||
      recoveryConversationId === null ||
      recoverySeed === undefined ||
      recoveryStartedRef.current.has(recoveryConversationId)
    ) {
      return;
    }
    const recoveredEvents = session.recover?.(project.id, recoverySeed);
    if (recoveredEvents === null || recoveredEvents === undefined) return;
    recoveryStartedRef.current.add(recoveryConversationId);
    // A live durable run is the authoritative conversation selection while it is
    // being recovered, including after a renderer reload.
    openConversation(recoveryConversationId);
    runningSession.current = session;
    setRunning(true);
    let disposed = false;
    const batcher = createFrameBatcher<AiEvent>((events) => {
      if (!disposed) appendConversationEvents(recoveryConversationId, events);
    }, AI_STREAM_RENDER_SCHEDULER);
    void (async () => {
      try {
        for await (const event of recoveredEvents) {
          if (disposed) return;
          batcher.push(event);
        }
      } catch (error) {
        if (disposed) return;
        batcher.flush();
        const emitter = createTurnEmitter({
          conversationId: recoveryConversationId,
          turnId: newId(),
        });
        appendConversationEvent(
          recoveryConversationId,
          emitter.error(error instanceof Error ? error.message : String(error), {
            retryable: true,
          }),
        );
        appendConversationEvent(recoveryConversationId, emitter.status('failed'));
      } finally {
        batcher.flush();
        if (!disposed) {
          runningSession.current = null;
          setRunning(false);
        }
      }
    })();
    return () => {
      disposed = true;
      // Detach the projection promptly (the generator is parked on the event inbox; this
      // wakes it so it unsubscribes) and RELEASE the once-only guard — a teardown that
      // isn't an unmount (a rebuilt session, a new seed) must be able to re-attach to the
      // still-live host run instead of abandoning it.
      recoveryStartedRef.current.delete(recoveryConversationId);
      runningSession.current = null;
      setRunning(false);
      session.detach?.();
    };
  }, [
    appendConversationEvent,
    appendConversationEvents,
    project.id,
    recoveryConversationId,
    recoverySeed,
    openConversation,
    session,
    setRunning,
  ]);
  // Running total of every run's real cost THIS SESSION (P7.2) — honestly scoped to
  // "since this sidebar was opened", not a fabricated monthly/plan figure (there is no
  // real billing/quota concept in this app). Feeds `summarizeUsage`'s dev/pro raw readout.
  const sessionCost = useRef<{ tokens: number; usd: number; modelCalls: number }>({
    tokens: 0,
    usd: 0,
    modelCalls: 0,
  });
  const { settings } = useSettings();
  // The run budget (goal.md Workstream D) is a SETTING, not a per-run choice: set once in
  // Settings → AI and applied to every agent run, including a resumed one. It used to be a
  // pair of fields docked under the composer plus a notification the run emitted before its
  // first model call; the maintainer replaced both with a permanent control the user can
  // consult at any time, so the transcript no longer opens by restating three numbers. The
  // run still says why it stopped when it actually reaches a limit.
  const maxUsd = settings.maxRunUsd;
  const maxMinutes = settings.maxRunMinutes;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // A ref mirror of `atBottom` so the ResizeObserver below reads the LIVE value
  // without re-subscribing every time it flips (a stale closure would keep
  // auto-scrolling after the user pinned their scroll position).
  const stickRef = useRef(true);
  // D2: the stream's scroll position, persisted into `ConversationUiState` below.
  const [scrollOffset, setScrollOffset] = useState(0);

  const virtualizer = useVirtualizer({
    count: activityNodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    overscan: 8,
  });

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  // Auto-scroll while streaming unless the user has scrolled up (product ask #1).
  // This fires on node ADD/status change; the ResizeObserver below covers the case
  // node count is unchanged but a message is GROWING (tokens streaming into one
  // assistant bubble) — the common case the length-based effect alone would miss.
  // Reads `stickRef.current` (not the `atBottom` STATE) at call time, same as the
  // ResizeObserver effect below: a `useLayoutEffect` (D2's conversation-switch
  // restore) can update `atBottom` via a synchronous re-render that produces a
  // SEPARATE, earlier-scheduled passive-effect pass with the pre-update `atBottom`
  // still closed over — `stickRef` has no such staleness, since it is a plain
  // mutable ref every closure reads live.
  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [activityNodes.length, view.status, atBottom, scrollToBottom]);

  // Follow growing content while pinned to the bottom. Observes the stream's inner
  // content so a streaming message that keeps the node count constant still tracks.
  // Re-attaches when the inner element swaps (virtualized ↔ plain ↔ empty).
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) scrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom, virtualize, activityNodes.length === 0]);

  // Read through a ref so `onScroll` stays identity-stable (a changing scroll handler
  // on the virtualizer's scroll element is a re-subscribe on every tick).
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = active?.id ?? null;
  /**
   * The conversation's event log, for handlers that run between commits.
   *
   * `attachReferenceFiles` counts the references already in force before accepting
   * another, and it is an async event handler — reading `active` from its closure would
   * count whatever the log held when the handler was created.
   */
  const activeEventsRef = useRef<readonly AiEvent[]>([]);
  activeEventsRef.current = active?.events ?? [];

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const stick = distance <= BOTTOM_THRESHOLD_PX;
    stickRef.current = stick;
    setAtBottom(stick);
    setScrollOffset(element.scrollTop);
    // Mirror into the cross-remount cache — see `scrollStateCache`. Written from the
    // scroll handler (not an effect) so it also captures programmatic scrolls, which
    // fire `scroll` too: "Jump to latest" therefore survives the next mutate commit.
    const id = activeIdRef.current;
    if (id) scrollStateCache.set(id, { offset: element.scrollTop, stick });
  }, []);

  // D2: restore composer draft / expanded tool cards / scroll position from the
  // conversation's persisted `uiState` whenever the ACTIVE CONVERSATION switches —
  // a brand-new chat, one reopened from history, or (after a reload) the first
  // conversation the reviewer opens once hydrate has restored it. Keyed on the id
  // ALONE (not on `active` itself) so a streamed token — which replaces `active`'s
  // identity every append but never changes which conversation is open — can never
  // reset what the reviewer is mid-typing/mid-scrolling. A `useLayoutEffect` (not
  // `useEffect`) so the scroll restore below lands before the browser paints, and
  // before the auto-scroll-to-bottom effect above can fight it.
  //
  // One conversation gets seeded TWICE, on purpose. A conversation opened from history
  // after a cold start arrives as a stub — its log and its `uiState` are still being read
  // from disk — so the first seed sees the default state and restores nothing. The load
  // that follows replaces `uiState` wholesale, and that single transition must re-seed or
  // a real reload loses the draft, the expanded cards, the scroll position and (P3.1) the
  // reference tiles, all of which were saved correctly and simply never read back. The
  // re-seed is refused the moment the reviewer has anything of their own in the composer,
  // so a load that lands late can never overwrite live typing.
  const seededConversationId = useRef<string | null>(null);
  const seededDefaultUiState = useRef(false);
  /**
   * The last `uiState` this component itself dispatched (see the persist effect below).
   *
   * Without it the sidebar cannot tell a load arriving FROM DISK from its own write
   * coming back through the store, and the difference decides everything: the reviewer's
   * first keystroke into a stub makes that conversation's `uiState` non-default, which
   * looked exactly like the late load and consumed the one-shot re-seed — so the real
   * load, when it landed a moment later, was refused and its attachments were then
   * overwritten. Identity is the honest test, because `withUiState` stores the very
   * object that was dispatched.
   */
  const persistedUiState = useRef<ConversationUiState | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useLayoutEffect(() => {
    const id = active?.id ?? null;
    const uiState = active?.uiState;
    const switched = seededConversationId.current !== id;
    const arrivedFromDisk =
      !switched &&
      seededDefaultUiState.current &&
      uiState !== undefined &&
      uiState !== persistedUiState.current &&
      !isDefaultUiState(uiState);
    if (!switched && !arrivedFromDisk) return;
    seededConversationId.current = id;
    seededDefaultUiState.current = uiState === undefined || isDefaultUiState(uiState);

    // D7: the late load landed in a composer the reviewer has already used. Refusing the
    // seed outright is what this used to do, and it protected the SCREEN while quietly
    // destroying the DISK: the persist effect below runs on the very next commit and
    // writes the live (empty) attachment list straight over the saved one, so references
    // that were correctly persisted were gone by the next reload.
    //
    // Draft and attachments are not the same kind of state, and the fix is to stop
    // treating them as one. A draft is a single buffer — it cannot be merged, so live
    // typing wins and the saved text is dropped, exactly as before. Attachments are a
    // SET, so the union is both lossless and honest: every chip the reviewer just added
    // stays, and every chip they had previously attached and never removed comes back —
    // which is what P3.1 promised in the first place. Nothing is taken off the screen,
    // so this is not the clobber the guard exists to prevent.
    const composerTouched = draftRef.current !== '' || attachmentsRef.current.length > 0;
    if (!switched && composerTouched) {
      const saved = (uiState?.attachments ?? []).filter((a) => a.status !== 'analyzing');
      setAttachments((live) => {
        const known = new Set(live.map((entry) => entry.id));
        const restored = saved.filter((entry) => !known.has(entry.id));
        // Identity-stable when there is nothing to add: a fresh array would make the
        // persist effect below dispatch a no-op write on every late load.
        return restored.length === 0 ? live : [...restored, ...live];
      });
      setDismissedReferenceIds((live) => {
        const known = new Set(live);
        const restored = (uiState?.dismissedReferenceIds ?? []).filter(
          (entry) => !known.has(entry),
        );
        return restored.length === 0 ? live : [...live, ...restored];
      });
      return;
    }

    setDraft(uiState?.composerDraft ?? '');
    // Reference chips survive a reload with their analyzed profiles (P3.1); an attachment
    // still `analyzing` when the state was saved can only be re-attached, so it is dropped.
    setAttachments((uiState?.attachments ?? []).filter((a) => a.status !== 'analyzing'));
    setDismissedReferenceIds(uiState?.dismissedReferenceIds ?? []);
    setExpandedNodes(
      uiState && uiState.expandedToolIds.length > 0
        ? Object.fromEntries(uiState.expandedToolIds.map((nodeId) => [nodeId, true]))
        : {},
    );
    // Always reset (not just when nonzero) — otherwise a STALE offset left over
    // from the PREVIOUS conversation would get written back into this one's
    // `uiState` by the persist effect below the moment it re-runs.
    //
    // The live cross-remount cache wins over the persisted offset when it has an entry
    // (see `scrollStateCache`): after a mutate-driven editor remount it still knows
    // whether the reader was FOLLOWING the stream, which a pixel offset cannot express
    // once the log has grown past it. On a cold start there is no entry and the
    // persisted offset decides, where 0 means "fresh / never scrolled" ⇒ at the bottom.
    const cached = id ? scrollStateCache.get(id) : undefined;
    const restoredOffset = cached?.offset ?? uiState?.scrollOffset ?? 0;
    const stick = cached ? cached.stick : restoredOffset === 0;
    setScrollOffset(restoredOffset);
    const element = scrollRef.current;
    // Following ⇒ restore the BOTTOM, not the remembered pixel offset: more rows have
    // arrived since, and the old number is no longer where the latest message is.
    if (element) element.scrollTop = stick ? element.scrollHeight : restoredOffset;
    // A restored mid-conversation position is not "at the bottom" — don't let the
    // auto-scroll effect above immediately yank it back down.
    stickRef.current = stick;
    setAtBottom(stick);
    // The id decides a SWITCH; `uiState` is here only so the one late load above can
    // re-seed — every other change to it returns at the guard.
  }, [active?.id, active?.uiState]);

  // The stream ELEMENT can be replaced without the conversation changing: opening and
  // closing the History drawer swaps `.ai-stream` out and back, and a host auto-commit
  // remounts the whole editor mid-run. A brand-new node starts at scrollTop 0, so the
  // restore above — keyed on the conversation id, which did not change — would not run
  // and the reviewer's position was silently lost. Re-apply the known offset whenever a
  // new element attaches; `scrollOffset` is already the live value the persist effect
  // writes, so this never fights the user's own scrolling.
  // Reads the offset through a ref so the callback ref itself is STABLE: a callback that
  // changed identity per scroll would make React detach (null) and re-attach the node on
  // every tick, tearing the virtualizer's scroll element out from under it.
  const scrollOffsetRef = useRef(scrollOffset);
  scrollOffsetRef.current = scrollOffset;
  const streamNode = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    if (!element) return;
    // While following the stream the bottom — not the last remembered offset — is the
    // position to re-apply; the offset is one frame stale the moment a row is added.
    if (stickRef.current) element.scrollTop = element.scrollHeight;
    else if (scrollOffsetRef.current > 0) element.scrollTop = scrollOffsetRef.current;
  }, []);

  // D2: the other half — write composer draft / expanded tool ids / scroll offset
  // back into the conversation's `uiState` through the SAME debounced `setUiState`
  // → autosave path `useConversations` already implements (previously wired up but
  // never called — see plan/ORCHESTRATOR-GAP-CLOSURE.md D2). Skips a no-op dispatch
  // when nothing actually changed, so a streamed token doesn't churn the
  // conversation store on every render.
  useEffect(() => {
    if (!active) return;
    const expandedToolIds = Object.keys(expandedNodes).filter((id) => expandedNodes[id]);
    // Persist 0 — "at the bottom" — while following, rather than the pixel offset that
    // happened to be the bottom at the time. A reload then resumes at the latest
    // message (what a follower wants) instead of at a number the log has outgrown, and
    // a streaming run stops churning `uiState` on every scroll tick.
    const persistedOffset = atBottom ? 0 : scrollOffset;
    const unchanged =
      draft === active.uiState.composerDraft &&
      persistedOffset === active.uiState.scrollOffset &&
      sameIdSet(expandedToolIds, active.uiState.expandedToolIds) &&
      attachments === active.uiState.attachments &&
      sameIdSet(dismissedReferenceIds, active.uiState.dismissedReferenceIds ?? []);
    if (unchanged) return;
    const nextUiState: ConversationUiState = {
      ...active.uiState,
      composerDraft: draft,
      expandedToolIds,
      scrollOffset: persistedOffset,
      attachments,
      dismissedReferenceIds,
    };
    // Recorded BEFORE the dispatch: the seed effect above uses this identity to tell its
    // own write apart from a load arriving from disk.
    persistedUiState.current = nextUiState;
    conversations.setUiState(active.id, nextUiState);
    // `conversations.setUiState` alone (a `useMemo`-stabilized reference, not the
    // whole `conversations` object, which is a fresh object every render) — so
    // this effect is only ever SCHEDULED when something it actually reads
    // changed, not on every unrelated re-render of the sidebar.
  }, [
    active,
    atBottom,
    draft,
    expandedNodes,
    scrollOffset,
    attachments,
    dismissedReferenceIds,
    conversations.setUiState,
  ]);

  // UI lifecycle is not cancellation authority. A sidebar remount, tab switch, project
  // refresh, or renderer navigation detaches this projection while the durable host run
  // continues; the next mount recovers from its persisted cursor. Only the explicit Stop
  // action below calls `abort()` and emits a cancellation command.
  useEffect(() => {
    const detachRun = (): void => runningSession.current?.detach?.();
    window.addEventListener('beforeunload', detachRun);
    window.addEventListener('pagehide', detachRun);
    return () => {
      window.removeEventListener('beforeunload', detachRun);
      window.removeEventListener('pagehide', detachRun);
      detachRun();
    };
  }, []);

  const runTurn = useCallback(
    async (text: string, turnAttachments: readonly MessageAttachment[] = []) => {
      // The REF, not the state value. `running` is whatever the closure captured at its
      // last render, so two Enter presses inside one React commit both read `false`, both
      // append a user message, and both overwrite `runningSession.current` — which leaves
      // the first run streaming with no Stop that can reach it. The ref is written
      // synchronously by `setRunning`, so claiming it here makes the second call a no-op.
      //
      // Released in `finally` unless the run actually started. Nothing between here and
      // `setRunning(true)` RETURNS early — but `conversations.create`/`append` can THROW,
      // and a claim leaked that way is unrecoverable: `runningRef` stays true while
      // `running` state stays false, so the composer looks idle and silently refuses every
      // later Enter for the life of the component.
      if (!text || runningRef.current) return;
      runningRef.current = true;
      // Everything from creating the conversation to handing the lane to the run, in one
      // step that either completes or releases the claim. `conversations.create` and
      // `append` can throw; a claim leaked that way is not recoverable by any later action.
      let handedOver = false;
      const openTurn = (): {
        conversation: Conversation;
        turnId: string;
        history: ReturnType<typeof historyFromEvents>;
        emitter: ReturnType<typeof createTurnEmitter>;
        pendingMessage: ReturnType<ReturnType<typeof createTurnEmitter>['userMessage']>;
      } => {
        const conversation =
          active ??
          conversations.create({
            id: newId(),
            projectId: project.id,
            model: activeProvider?.model ?? 'mock',
            mode,
          });
        const turnId = newId();
        lastTurn.current = { conversationId: conversation.id, text, attachments: turnAttachments };
        // Capture prior turns BEFORE appending the new user message so "make it
        // shorter" resolves its referent against the conversation so far (R2 B1).
        const history = historyFromEvents(conversation.events);
        const emitter = createTurnEmitter({ conversationId: conversation.id, turnId });
        // Built once and reused: this is both the event the log appends and the message
        // whose attachments join the conversation's live reference set below.
        // `conversation` was captured before the append, so its `events` do not contain it.
        const pendingMessage = emitter.userMessage(text, turnAttachments);
        conversations.append(conversation.id, pendingMessage);
        stickRef.current = true;
        setAtBottom(true);
        setRunning(true);
        handedOver = true;
        return { conversation, turnId, history, emitter, pendingMessage };
      };

      let opened: ReturnType<typeof openTurn>;
      try {
        opened = openTurn();
      } finally {
        if (!handedOver) runningRef.current = false;
      }
      const { conversation, turnId, history, emitter, pendingMessage } = opened;
      stopRequestedRef.current = false;
      runningSession.current = session;
      // Intelligent, model-routed dispatch (ADR 0055). Agent mode — the smart default —
      // hands routing to the orchestrator's `auto` path: ONE small classification call
      // reads the WHOLE request and picks chitchat / question / edit. That replaces the
      // old keyword table (`routeCommand`), which greedily hijacked "add an intro with
      // keyframes" into a fixed template (→ "no changes, no AI needed") and sent a bare
      // "hi" to full planning. Chat and Edit are explicit user overrides — they bypass
      // classification because the user deliberately picked that mode.
      const effectiveMode: AiSessionMode = mode === 'agent' ? 'auto' : mode;
      // Honest end-of-run reporting: an `auto` run does not know its editing-ness until the
      // classifier picks a route, so it starts non-editing and is upgraded when an
      // editing/planning status streams (see foldTurnEvent) — a chitchat/question reply
      // never emits one, so it never shows a misleading "nothing changed" notice. Every
      // other mode's editing-ness is known now.
      const editingKnownNow = effectiveMode !== 'chat' && effectiveMode !== 'auto';
      let signals = initialTurnSignals(editingKnownNow);
      // Frame-coalesced appends (H1): tokens land at most one frame after they
      // arrive, and React commits once per frame regardless of chunk rate.
      const batcher = createFrameBatcher<AiEvent>(
        (events) => conversations.appendMany(conversation.id, events),
        AI_STREAM_RENDER_SCHEDULER,
      );
      // P8.4/P12.7: feed the resolved selection range into the model context
      // exactly like any other context chip — removing the "Selected" chip
      // (`removedContext` includes 'selection') means the user explicitly
      // opted this turn out of it, so it must NOT be silently sent anyway.
      const sendSelection =
        composerSelection && !removedContext.includes('selection')
          ? composerSelection.range
          : undefined;
      // P8.7: send only the pins the user has NOT explicitly removed this turn — same
      // honesty rule as `sendSelection` above (an explicitly-removed chip must never be
      // silently sent anyway).
      const sendPinned = pinnedEntities.filter(
        (entity) => !removedContext.includes(`pin:${entity.kind}:${entity.id}`),
      );
      // P11.3/P11.4: fresh, live controls for THIS run's sequential agent loop —
      // browser-only (see `AiSessionInput.controls`'s doc). Wired even when the
      // approval gate won't fire (small plan / planFirst off) since it's cheap and
      // the steering input is offered whenever mode is 'agent', independent of
      // planFirst.
      const planApprovalGate = createPlanApprovalGate();
      const steeringQueue = createSteeringQueue();
      planApprovalGateRef.current = planApprovalGate;
      steeringQueueRef.current = steeringQueue;
      // The COMPLETE LIVE SET for this conversation, which is what the SDK's contract
      // asks for: "a reference the editor never removed still arrives on every turn, so a
      // subject missing from this set means the tile is gone and its decision must stop
      // binding" (kernel/conductor.ts, P3.5).
      //
      // Not the composer's array, which never cleared and so was really "everything ever
      // attached, still sitting in the box". And not this message's own attachments
      // either: that would send [] on the next turn and retire every reference the editor
      // attached, which reads to the run as a deliberate removal. Derived from the
      // messages that carry them, minus what has been dismissed — so attaching puts a
      // reference in force, and only dismissing takes it out.
      // A conversation can still arrive over the limit — state saved before the attach-time
      // refusal existed, or a message whose attachments were all analyzed at once. Turn that
      // into a REAL dismissal rather than a silent trim: the run and the bubble must agree
      // about what is binding, and a reference that vanishes from the set with no record
      // reads to the SDK as a removal the editor never asked for.
      const conversationLog = [...conversation.events, pendingMessage];
      const overCap = referencesToDismissForCap(conversationLog, dismissedReferenceIdsRef.current);
      const dismissedNow =
        overCap.length === 0
          ? dismissedReferenceIdsRef.current
          : [...dismissedReferenceIdsRef.current, ...overCap];
      if (overCap.length > 0) {
        setDismissedReferenceIds(dismissedNow);
        log.warn('dropped the oldest references to fit the per-turn limit', {
          dropped: overCap.length,
          limit: MAX_REFERENCES_PER_TURN,
        });
      }
      const readyReferences = activeReferences(conversationLog, dismissedNow);
      const runInputFor = (runMode: AiSessionMode): AiSessionInput => {
        const currentEditor = editorRef.current;
        const projectSnapshot = projectSnapshotForAiRun(projectRef.current, currentEditor);
        const interaction = captureEditorInteractionContext({
          project: projectSnapshot,
          projectRevision: projectRevision ?? 0,
          playheadSeconds: currentEditor?.getPlayhead?.() ?? currentEditor?.state?.playhead ?? 0,
          selectedClipIds: sendSelection ? (currentEditor?.state?.selectedIds ?? []) : [],
          selectedEffectLayerIds,
          selectedKeyframes,
          ...(sourceMonitor ? { sourceMonitor } : {}),
          ...(sendSelection && currentEditor?.state?.selection
            ? { primaryClipId: currentEditor.state.selection }
            : {}),
          ...(sendSelection ? { timeRange: sendSelection } : {}),
        });
        return {
          project: projectSnapshot,
          ...(projectRevision === undefined ? {} : { projectRevision }),
          // Edits apply as they land; there is no review mode to defer them to.
          patchPolicy: 'auto_commit',
          userPrompt: text,
          conversationId: conversation.id,
          turnId,
          ...(history.length > 0 ? { history } : {}),
          userMemory: loadUserMemory(),
          ...(readyReferences.length > 0 ? { references: readyReferences } : {}),
          ...(activeProviderName !== 'mock' ? { provider: activeProviderName } : {}),
          ...(sendSelection ? { selection: sendSelection } : {}),
          interaction,
          ...(sendPinned.length > 0 ? { pinned: sendPinned } : {}),
          // Agent-mode robustness: drive the up-front plan the SDK/agent loop supports,
          // and gate a high-blast-radius drafted plan for approval (P11.3) — the gate
          // only ever fires when a plan was actually drafted, so this is a no-op
          // unless `planFirst` is also on. Mid-run steering (P11.4) is independent of
          // `planFirst` — wired for every agent run. `auto` gets the same options: when it
          // classifies to an edit it delegates to the very same agent loop (ADR 0055).
          ...(runMode === 'agent' || runMode === 'auto'
            ? {
                agentOptions: { planFirst, requirePlanApproval: planFirst, maxUsd, maxMinutes },
                controls: { planApproval: planApprovalGate, steering: steeringQueue },
              }
            : {}),
          // Variations (P13.1): edit-mode only, opt-in — see `wantVariations` above. Gating
          // on `runMode === 'edit'` (the ROUTED mode, not just the user's selected mode)
          // keeps the flag off every other route, even if the user was in Edit mode and
          // had the toggle on.
          ...(runMode === 'edit' && wantVariations ? { variations: true } : {}),
        };
      };
      // Set once this turn has written its own terminal status (a Stop cancellation or a
      // run-level failure), so the `finally` finalizer below never appends a SECOND one.
      let finalized = false;
      try {
        for await (const event of session.run(effectiveMode, runInputFor(effectiveMode))) {
          signals = foldTurnEvent(signals, event);
          // Name the current step for the floating control, so it reports what the
          // agent is DOING and not merely that something is. `publishAgentActivity`
          // is idempotent, so this can run on every event without a guard, and the
          // store notifies nobody when the phrase has not changed.
          publishAgentActivity({ running: true, label: activityLabelFor(event) });
          batcher.push(event);
        }
        // The run finished cleanly. If it was meant to edit but produced nothing,
        // append the honest reason (fresh turn id so the notice can't collide with the
        // streamed events' ids). A chat/edit-producing/failed run yields no notice.
        const notice = emptyRunNotice(signals);
        if (notice) {
          batcher.flush();
          const noticeEmitter = createTurnEmitter({
            conversationId: conversation.id,
            turnId: newId(),
          });
          conversations.append(conversation.id, noticeEmitter.notification(notice));
        }
        // Make the speed/cost win visible in creator language (P2.2/P7.2): every run whose
        // real cost we actually know (today: the single-proposal run path, the one that
        // emits a `usage` event) gets a chip — "Instant · no AI needed" for a run that
        // never called a model, or an honest "AI edits used this session" otherwise. Raw
        // token/$ numbers NEVER appear here unless the user opted into the dev/pro toggle
        // (Settings → AI → Routing) — this is a hard guardrail, not a style choice.
        // A FAILED run gets no chip at all. The chip's phrasing is chosen from the run's
        // cost, and a failed run's cost is exactly the number we cannot trust: a provider
        // that dropped the request reports no usage, so a $0 total reads as a measured
        // zero under a run that in fact called the model and got nothing back. The
        // error/warning above is the honest account.
        // UX-11: the provider actually answered. Settings' readiness panel reads this
        // instead of claiming a provider is ready because a key happens to be stored.
        if (!signals.failed && !signals.cancelled) recordProviderSuccess(activeProviderName);
        if (signals.cost && !signals.failed) {
          sessionCost.current = {
            tokens: sessionCost.current.tokens + signals.cost.tokens,
            usd: sessionCost.current.usd + signals.cost.usd,
            modelCalls: sessionCost.current.modelCalls + (signals.cost.modelCalls ?? 0),
          };
          // Fold the run into local history for Settings → Usage & Spend. This is the only
          // place that knows all four facts at once — what it cost, which provider served
          // it, which model, and which project it belonged to — which is why the record is
          // written here and not somewhere more central. Failed runs are already excluded
          // by the branch above: a provider that dropped the request reports no usage, so
          // recording it would file a measured zero against a run that really called out.
          recordUsageRun(
            {
              at: new Date(),
              provider: activeProviderName,
              model: activeProvider?.model ?? 'unknown',
              projectId: project.id,
              projectName: project.name,
              tokens: signals.cost.tokens,
              usd: signals.cost.usd,
              modelCalls: signals.cost.modelCalls ?? 0,
            },
            settings.trackUsageHistory,
          );
          const summary = summarizeUsage(signals.cost, sessionCost.current);
          // When the run really called the model but no provider reported usage, the raw
          // numbers are a floor, not a measurement — saying "0 tokens · $0.0000" would
          // present a missing reading as a measured zero. Name the gap instead.
          const rawSuffix = !settings.showAiUsageDetails
            ? ''
            : summary.usageUnknown
              ? ` · ${String(summary.raw.modelCalls ?? 0)} model calls · usage not reported by provider`
              : ` · ${String(summary.raw.tokens)} tokens · $${summary.raw.usd.toFixed(4)}`;
          batcher.flush();
          const chipEmitter = createTurnEmitter({
            conversationId: conversation.id,
            turnId: newId(),
          });
          conversations.append(
            conversation.id,
            chipEmitter.notification(`${summary.label}${rawSuffix}`),
          );
        }
      } catch (error) {
        batcher.flush();
        // Stop (user click, conversation switch, window close) aborts the stream,
        // which the browser transport surfaces as a thrown `AbortError`. That is a
        // clean cancellation, NOT a failure — close the turn with a `cancelled`
        // status (no scary retryable error banner) so the conversation resolves.
        if (stopRequestedRef.current || isAbortError(error)) {
          if (!signals.cancelled && !signals.failed) {
            conversations.append(conversation.id, emitter.status('cancelled'));
          }
        } else {
          // A genuine run-level failure (e.g. the desktop hub's max-run timeout, a
          // transport error before any event) surfaces as a throw from the session
          // iterable, not an in-stream error event. Render it — otherwise the run just
          // stops with no explanation (an unhandled rejection).
          // Plain sentence up front, provider/FFmpeg text behind "Show details"
          // (P8.2 "failed") — the raw message is evidence, not the message.
          const failure = explainRunFailure(error instanceof Error ? error.message : String(error));
          conversations.append(
            conversation.id,
            emitter.error(failure.text, {
              retryable: true,
              ...(failure.detail === undefined ? {} : { detail: failure.detail }),
            }),
          );
          conversations.append(conversation.id, emitter.status('failed'));
        }
        finalized = true;
      } finally {
        batcher.flush();
        // Stop on the desktop transport returns cleanly via `done` (no throw, no
        // terminal status event), so the loop above never entered `catch`. Finalize
        // the turn here too — unless `catch` already did — or the conversation would
        // shimmer "in progress" forever.
        if (!finalized && stopRequestedRef.current && !signals.cancelled && !signals.failed) {
          conversations.append(conversation.id, emitter.status('cancelled'));
        }
        runningSession.current = null;
        stopRequestedRef.current = false;
        planApprovalGateRef.current = null;
        steeringQueueRef.current = null;
        setRunning(false);
      }
    },
    [
      running,
      active,
      conversations,
      mode,
      session,
      project,
      projectRevision,
      activeProviderName,
      activeProvider,
      planFirst,
      maxUsd,
      maxMinutes,
      wantVariations,
      composerSelection,
      pinnedEntities,
      removedContext,
      selectedEffectLayerIds,
      selectedKeyframes,
      sourceMonitor,
    ],
  );

  // The imperative escape hatch (see AiSidebarHandle) — fire-and-forget into the
  // exact same runTurn/session path the composer's submit() uses.
  useImperativeHandle(ref, () => ({ runQuickEdit: (text: string) => void runTurn(text) }), [
    runTurn,
  ]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    // Freeze the composer's attachments onto this message BEFORE clearing, then clear
    // both. The message owns them from here: it renders them, it persists them, and it
    // is what a Retry replays. The composer is emptied every time — a submit that left
    // some chips behind is the half-state that made a sent attachment silently ride
    // along on every later turn.
    const outgoing = toMessageAttachments(attachmentsRef.current);
    setDraft('');
    setAttachments([]);
    try {
      await runTurn(text, outgoing);
    } catch (error) {
      // The composer is cleared BEFORE the run so the chips cannot ride along on a later
      // turn — but a send that never started must not swallow the request with them. A
      // throw here happens before the run reaches a terminal status, so the Retry
      // affordance (gated on `failed`/`cancelled`) never appears: without this the text
      // and every imported reference are simply gone, and the references would have to be
      // re-imported and re-measured. Put back, so the editor can read the error and send
      // again. `analyzing` is not restored — those were measured before submit.
      setDraft(text);
      setAttachments(outgoing.map((a) => ({ ...a, status: 'ready' as const })));
      log.error('the turn could not be started; the composer was restored', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [draft, runTurn]);

  /** The last turn, but only if it belongs to the conversation on screen. */
  const replayableTurn = useCallback(() => {
    const turn = lastTurn.current;
    return turn !== null && turn.conversationId === active?.id ? turn : null;
  }, [active?.id]);

  const retry = useCallback(() => {
    const turn = replayableTurn();
    if (turn) void runTurn(turn.text, turn.attachments);
  }, [replayableTurn, runTurn]);

  // R3 C2: Resume continues an interrupted agent run from its persisted checkpoint —
  // replaying the ops already applied and picking up at the next step — instead of
  // restarting from scratch like Retry. Runs in agent mode against the same conversation.
  const resumeRun = useCallback(async () => {
    const conversation = active;
    const cp = view.checkpoint;
    if (!conversation || !cp || running) return;
    const turnId = newId();
    const emitter = createTurnEmitter({ conversationId: conversation.id, turnId });
    stickRef.current = true;
    setAtBottom(true);
    setRunning(true);
    runningSession.current = session;
    const batcher = createFrameBatcher<AiEvent>(
      (events) => conversations.appendMany(conversation.id, events),
      AI_STREAM_RENDER_SCHEDULER,
    );
    try {
      for await (const event of session.run('agent', {
        project,
        ...(projectRevision === undefined ? {} : { projectRevision }),
        userPrompt: cp.goal,
        conversationId: conversation.id,
        turnId,
        userMemory: loadUserMemory(),
        ...(activeProviderName !== 'mock' ? { provider: activeProviderName } : {}),
        agentOptions: {
          planFirst,
          // A resumed run is a fresh run to the SDK, so it needs the budget too.
          maxUsd,
          maxMinutes,
          resume: {
            ops: cp.ops as readonly AnyOperation[],
            log: cp.log,
            stepsCompleted: cp.stepsCompleted,
            working: cp.working,
          },
        },
      })) {
        batcher.push(event);
      }
    } catch (error) {
      // Same run-level failure surfacing as runTurn (hub timeout / transport throw).
      batcher.flush();
      const failure = explainRunFailure(error instanceof Error ? error.message : String(error));
      conversations.append(
        conversation.id,
        emitter.error(failure.text, {
          retryable: true,
          ...(failure.detail === undefined ? {} : { detail: failure.detail }),
        }),
      );
      conversations.append(conversation.id, emitter.status('failed'));
    } finally {
      batcher.flush();
      runningSession.current = null;
      setRunning(false);
    }
  }, [
    active,
    view.checkpoint,
    running,
    session,
    project,
    projectRevision,
    activeProviderName,
    planFirst,
    maxUsd,
    maxMinutes,
    conversations,
  ]);

  const stop = useCallback(() => {
    // Mark the intent BEFORE aborting so `runTurn`'s finalizer closes the turn out as
    // a clean `cancelled` (the desktop transport returns via `done` with no terminal
    // status event of its own).
    stopRequestedRef.current = true;
    (runningSession.current ?? session).abort();
  }, [session]);

  // Single-session guarantee: this app never keeps a background run. Switching the
  // active conversation while a run is live STOPS it first — otherwise the run would
  // keep streaming into a conversation the user is no longer looking at, leaving it
  // stuck "in progress" and showing a "Stop" on the new chat that isn't its run. The
  // stopped run's own conversation is finalized as `cancelled` by `runTurn`.
  const switchConversation = useCallback(
    (id: string | null) => {
      if (running) stop();
      conversations.open(id);
      setHistoryOpen(false);
    },
    [running, stop, conversations],
  );

  // P11.3: the plan-approval gate is showing exactly when the reducer paused the run
  // (`view.status === 'awaiting_approval'`) — its step list is the most recent `plan`
  // node (the reducer emits it right before pausing, see `conductor.ts#onDraftPlanResult`).
  const awaitingPlan = useMemo(() => {
    if (view.status !== 'awaiting_approval') return undefined;
    for (let i = view.nodes.length - 1; i >= 0; i -= 1) {
      const node = view.nodes[i];
      if (node?.kind === 'plan') return node;
    }
    return undefined;
  }, [view.status, view.nodes]);

  const approvePlan = useCallback(() => {
    const activeSession = runningSession.current ?? session;
    if (activeSession.approvePlan) activeSession.approvePlan();
    else planApprovalGateRef.current?.resolve('approved');
  }, [session]);
  const cancelPlan = useCallback(() => {
    const activeSession = runningSession.current ?? session;
    if (activeSession.rejectPlan) activeSession.rejectPlan();
    else planApprovalGateRef.current?.resolve('cancelled');
  }, [session]);
  // "Edit" (P11.3/P12.4 — deliberately scoped, not a full plan editor): cancel the
  // gated run (nothing has touched the timeline yet) and hand the original request
  // back to the composer so the creator can refine it before re-running.
  const editPlanRequest = useCallback(() => {
    const activeSession = runningSession.current ?? session;
    if (activeSession.rejectPlan) activeSession.rejectPlan();
    else planApprovalGateRef.current?.resolve('cancelled');
    const turn = replayableTurn();
    if (turn) {
      setDraft(turn.text);
      // The request goes back to the composer to be refined, so what was attached to it
      // goes back too — otherwise re-sending silently drops the references the rejected
      // plan was built from. They return already analyzed; nothing is re-measured.
      setAttachments(turn.attachments.map((a) => ({ ...a, status: 'ready' as const })));
    }
  }, [replayableTurn, session]);

  // P11.4: raw "Steering applied: …" notification texts this run has confirmed, so
  // the steering input can clear its own "queued" note once the run actually folds
  // a message in (never fabricated — only what the run itself reported).
  const appliedSteeringMessages = useMemo(
    () =>
      view.nodes
        .filter((n): n is Extract<ViewNode, { kind: 'notice' }> => n.kind === 'notice')
        .map((n) => n.text)
        .filter((text) => text.startsWith('Steering applied:')),
    [view.nodes],
  );
  const sendSteering = useCallback(
    (message: string) => {
      const activeSession = runningSession.current ?? session;
      if (activeSession.steer) activeSession.steer(message);
      else steeringQueueRef.current?.push(message);
    },
    [session],
  );

  const canResume = !running && view.checkpoint !== undefined;
  const canRetry =
    !running &&
    !canResume &&
    replayableTurn() !== null &&
    (view.status === 'failed' || view.status === 'cancelled');

  const items = virtualizer.getVirtualItems();
  const ModeIcon = MODE_META[mode].Icon;
  const modelNotReady = activeProvider?.ready === false;

  // Move the editor playhead so "Jump to timeline" / preview seek lands ON the
  // change (product ask #3) — a no-op in the read-only/no-editor case.
  const onSeek = useCallback(
    (seconds: number) => {
      editor?.seek(seconds);
    },
    [editor],
  );

  /**
   * Send the editor's reply to the model's pending question (P12).
   *
   * Straight to the session, which owns the route: in the browser it resolves an
   * in-process gate; on desktop it sends plain data over IPC to the gate in main. The
   * sidebar does not need to know which — and must not, or the two surfaces drift.
   */
  const onAnswer = useCallback(
    (answer: AiStreamAnswerMessage): void => {
      session.answer(answer);
    },
    [session],
  );

  /**
   * Nothing on screen can still be live.
   *
   * A card only leaves `running` when its own settling event arrives, and a run that ends
   * without one — the editor dismissed the model's question (dismissing IS a stop), the
   * transport aborted mid-call, the app was closed mid-run — used to leave that card
   * spinning with its elapsed counter climbing forever, still offering a reply to a gate
   * that had died with the run. `EventNode` settles those rows as stopped.
   *
   * A durable host run this renderer is about to re-attach to (a reload mid-run) is NOT
   * over: it is one paint away from streaming again, and freezing its cards for that one
   * frame would flash "Stopped" across a run that never stopped.
   */
  const runEnded =
    !running &&
    (view.status === 'completed' ||
      view.status === 'failed' ||
      view.status === 'cancelled' ||
      view.status === 'idle' ||
      recoveryConversationId !== (active?.id ?? null));

  // The run's own edits, newest run only: what "Undo run" would take back.
  //
  // Undo is the entire safety net now that edits apply as they land, so this is the one
  // place it is made visible rather than left as a keyboard shortcut the user has to know.
  const lastRunPatchIds = useMemo(() => {
    const diffs = view.nodes.filter(
      (n): n is Extract<typeof n, { kind: 'diff' }> => n.kind === 'diff' && n.edit.validation.valid,
    );
    const lastTurnId = diffs.at(-1)?.turnId;
    return lastTurnId === undefined
      ? []
      : diffs.filter((n) => n.turnId === lastTurnId).map((n) => n.edit.patch.patchId);
  }, [view.nodes]);
  // What the last run changed, said in editing terms (P8.2 "changed"): the operations
  // grouped by semantic action and the programme-length delta. "Made N edits" is a
  // count of patches; this is an account of the cut.
  const lastRunSummary = useMemo(() => {
    const diffs = view.nodes.filter(
      (n): n is Extract<typeof n, { kind: 'diff' }> => n.kind === 'diff' && n.edit.validation.valid,
    );
    const lastTurnId = diffs.at(-1)?.turnId;
    if (lastTurnId === undefined) return null;
    const edits = diffs
      .filter((n) => n.turnId === lastTurnId)
      .map((n) => {
        const card = toReviewCard(n.edit);
        return {
          operations: n.edit.patch.operations as readonly AnyOperation[],
          before: card.before,
          after: card.after,
        };
      });
    return summarizeRunChanges(edits, projectNames(project));
  }, [view.nodes, project]);
  // Where the last run's edits landed (P8.2 "changed"): the first clip an operation
  // names, else the first track — enough for "Show on timeline" to put the editor's eyes
  // on the affected range instead of leaving them to hunt for what changed.
  const lastRunReference = useMemo<Reference | null>(() => {
    const diffs = view.nodes.filter(
      (n): n is Extract<typeof n, { kind: 'diff' }> => n.kind === 'diff' && n.edit.validation.valid,
    );
    const lastTurnId = diffs.at(-1)?.turnId;
    if (lastTurnId === undefined) return null;
    let track: Reference | null = null;
    for (const node of diffs.filter((n) => n.turnId === lastTurnId)) {
      for (const op of node.edit.patch.operations as unknown as readonly Record<
        string,
        unknown
      >[]) {
        const clipId = op['clipId'];
        if (typeof clipId === 'string') return { kind: 'clip', id: clipId, label: clipId };
        const trackId = op['trackId'];
        if (track === null && typeof trackId === 'string') {
          track = { kind: 'track', id: trackId, label: trackId };
        }
      }
    }
    return track;
  }, [view.nodes]);
  // How many entries at the TOP of the undo stack this run owns, counted contiguously
  // from the newest backwards.
  //
  // Read from `editor.history` rather than `project.history`: the browser store keeps the
  // undo stack in its own state and projects a project whose `history` is always `[]`
  // (store.ts's `toProject`), so trusting the project here would report zero on exactly
  // the path this button exists for. The project's own history is the desktop/host lane,
  // where the authoritative project does carry it — hence both, editor first.
  //
  // Zero means the button stands down: either someone has edited since (undoing would take
  // back THEIR work, not the run's) or the run was already undone. A button that silently
  // changes what it reverts is worse than no button.
  const undoableRunEdits = useMemo(() => {
    if (lastRunPatchIds.length === 0) return 0;
    const owned = new Set<string>(lastRunPatchIds);
    const storeEntries = editor?.history?.entries.slice(0, editor.history.cursor) ?? [];
    const entries = (
      storeEntries.length > 0 ? storeEntries : Array.isArray(project.history) ? project.history : []
    ) as readonly { patch?: { patchId?: string } }[];
    let count = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const patchId = entries[index]?.patch?.patchId;
      if (patchId === undefined || !owned.has(patchId)) break;
      count += 1;
    }
    return count;
  }, [lastRunPatchIds, project.history, editor?.history]);
  const undoRun = useCallback(() => {
    if (!editor || undoableRunEdits === 0) return;
    // Counted up front: `project` cannot update between iterations, so re-reading the
    // stack inside the loop would see the same pre-undo history every time and stop after
    // one step, silently leaving the rest of the run applied.
    for (let step = 0; step < undoableRunEdits; step += 1) editor.undo();

    // Undo IS the negative learning signal now that there is no Reject button. It is also
    // a better one: rejecting a card judged an edit the user had only read about, whereas
    // undoing judges the edit they actually watched on the timeline. Recorded only for the
    // patches that really came back off, so memory reflects what happened.
    const undone = lastRunPatchIds.slice(-undoableRunEdits);
    const undonePatches = view.nodes
      .filter(
        (n): n is Extract<typeof n, { kind: 'diff' }> =>
          n.kind === 'diff' && undone.includes(n.edit.patch.patchId),
      )
      .map((n) => n.edit.patch);
    if (onProjectChange && undonePatches.length > 0) {
      // One project update for the whole run, so autosave sees a single consistent
      // snapshot instead of a churn of references.
      onProjectChange(undonePatches.reduce((proj, patch) => recordRejected(proj, patch), project));
    }
    for (const patch of undonePatches) {
      recordReviewDecision(project, patch, 'rejected');
      session.decidePatch?.(patch.patchId, 'rejected');
    }
  }, [editor, undoableRunEdits, lastRunPatchIds, view.nodes, onProjectChange, project, session]);

  /**
   * Take a reference out of force for the rest of the conversation (P3.5's removal).
   *
   * The message keeps showing it — the record of what was attached does not change — but
   * `activeReferences` stops including it, so the next turn sends a set without it and the
   * SDK retires the decision it was binding, which is exactly the semantics deleting the
   * composer tile used to carry.
   */
  const dismissReference = useCallback((attachmentId: string) => {
    setDismissedReferenceIds((ids) => (ids.includes(attachmentId) ? ids : [...ids, attachmentId]));
  }, []);

  const renderNode = (node: ViewNode): JSX.Element => {
    // An edit that could not be written is the only diff state left worth calling out —
    // everything else applied, which the timeline itself already shows.
    const failedToApply =
      node.kind === 'diff' &&
      (appliedNodes[node.id] === 'failed' || node.commit?.state === 'stale');
    // An edit that did not apply opens expanded, as does an invalid one, so the reason is
    // visible without hunting for it.
    const defaultExpanded = node.kind === 'diff' && (!node.edit.validation.valid || failedToApply);
    return (
      <EventNode
        node={node}
        project={project}
        expanded={expandedNodes[node.id] ?? defaultExpanded}
        onToggleExpanded={onToggleExpanded}
        fps={project.fps}
        onSeek={onSeek}
        {...(onReveal ? { onReveal } : {})}
        onAnswer={onAnswer}
        runEnded={runEnded}
        {...(failedToApply ? { applyFailed: true } : {})}
        // D1: a retryable error notice's inline Retry re-runs the last turn
        // through the SAME `retry` callback the action bar uses below — never a
        // second retry implementation.
        {...(node.kind === 'notice' ? { onRetryNotice: retry, retryDisabled: running } : {})}
        {...(node.kind === 'user'
          ? { dismissedReferenceIds, onDismissReference: dismissReference }
          : {})}
      />
    );
  };

  return (
    <div className="ai-sidebar" data-testid="ai-sidebar" role="region" aria-label="AI assistant">
      <header className="ai-sidebar-header">
        <div className="ai-sidebar-header-left">
          <Menu
            label="AI mode"
            className="ai-mode-menu"
            trigger={
              <span className="ai-mode-current">
                <ModeIcon size={ICON_SIZE.sm} aria-hidden="true" />
                {MODE_META[mode].label}
              </span>
            }
          >
            {(close) =>
              MODES.map((m) => {
                const { label, Icon, hint } = MODE_META[m];
                return (
                  <MenuItem
                    key={m}
                    icon={<Icon size={ICON_SIZE.sm} />}
                    onSelect={() => {
                      setMode(m);
                      close();
                    }}
                  >
                    <span className="ai-mode-option" data-active={mode === m}>
                      <span className="ai-mode-option-label">{label}</span>
                      <span className="ai-mode-option-hint">{hint}</span>
                    </span>
                  </MenuItem>
                );
              })
            }
          </Menu>
          {/* Agent "Plan first" toggle. Lives in the header (an agent-run preference)
              rather than above the composer. A name and hint hidden entirely behind
              hover/focus is not discoverable on a control this consequential, so the
              name stays on screen and only the longer explanation is tooltip-only.
              Uses the shared `Switch` primitive (packages/ui) — the same control
              Settings uses — rather than a bespoke AI-only toggle, so the app has one
              switch design instead of two that drift apart. Agent mode only. */}
          {mode === 'agent' && (
            <Tooltip label={PLAN_FIRST_HINT}>
              <span className="ai-header-toggle">
                <span className="ai-header-toggle-label" aria-hidden="true">
                  Plan first
                </span>
                <Switch
                  checked={planFirst}
                  label={`Plan first: ${PLAN_FIRST_HINT}`}
                  onCheckedChange={setPlanFirst}
                  data-testid="ai-plan-first"
                />
              </span>
            </Tooltip>
          )}
        </div>
        <div className="ai-sidebar-header-right">
          <Menu
            label="More options"
            className={`ai-overflow-menu${modelNotReady ? ' ai-overflow-menu--warn' : ''}`}
            trigger={<MoreHorizontal size={ICON_SIZE.sm} aria-hidden="true" />}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<Plus size={ICON_SIZE.sm} />}
                  onSelect={() => {
                    switchConversation(null);
                    close();
                  }}
                >
                  New chat
                </MenuItem>
                <MenuItem
                  icon={<History size={ICON_SIZE.sm} />}
                  onSelect={() => {
                    setHistoryOpen((v) => !v);
                    close();
                  }}
                >
                  {historyOpen ? 'Hide history' : 'History'}
                </MenuItem>
                {/* Transcript export for the CONVERSATION ON SCREEN. The history
                    drawer exports any row; this is the one people ask for during a
                    run they are watching go wrong. Both write the same complete
                    Markdown (`toMarkdown`) — every message, thought, tool call with
                    its arguments and raw result, proposed edit, status and cost. */}
                <MenuItem
                  icon={<Copy size={ICON_SIZE.sm} />}
                  disabled={!active}
                  onSelect={() => {
                    if (active) void copyText(toMarkdown(active));
                    close();
                  }}
                >
                  Copy transcript
                </MenuItem>
                <MenuItem
                  icon={<Download size={ICON_SIZE.sm} />}
                  disabled={!active}
                  onSelect={() => {
                    if (active) {
                      downloadText(`${active.id}.md`, toMarkdown(active), 'text/markdown');
                    }
                    close();
                  }}
                >
                  Export transcript
                </MenuItem>
                <MenuItem
                  icon={<Settings size={ICON_SIZE.sm} />}
                  disabled={!onOpenSettings}
                  onSelect={() => {
                    onOpenSettings?.();
                    close();
                  }}
                >
                  {modelNotReady
                    ? `${activeProvider?.label ?? 'Model'} · add API key`
                    : (activeProvider?.label ?? 'Offline mock')}
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </header>

      {historyOpen ? (
        <HistoryDrawer
          conversations={conversations}
          onSelect={switchConversation}
          onClose={() => setHistoryOpen(false)}
        />
      ) : (
        <>
          {/* Parallel "what's running" view (P8.2) — renders nothing until a run
              emits `task_started`. The DAG scheduler emits one per planned step, and
              the temporal review announces itself here too, so the run's longest
              phase is a visible running card instead of dead air. */}
          <TaskRunView tasks={view.tasks ?? []} />
          {/* P11.3/P12.4: the plan-approval gate — a high-blast-radius drafted plan
              pauses HERE, before any turn runs, until the creator decides. */}
          {awaitingPlan && (
            <PlanApprovalCard
              steps={awaitingPlan.steps.map((s) => s.label)}
              onApprove={approvePlan}
              onEdit={editPlanRequest}
              onCancel={cancelPlan}
            />
          )}
          {/* P11.4/P12.5: mid-run steering — offered whenever an agent run is live,
              independent of the approval gate above. */}
          {running && mode === 'agent' && !getBridge() && (
            <SteeringInput onSend={sendSteering} appliedMessages={appliedSteeringMessages} />
          )}
          {/* Both, not either. The old `tasks.length === 0` guard treated the task
              list and the plan as two renderings of the same DAG, so whichever
              arrived hid the other. They are complementary now: the plan is the
              model's own steps with live per-step status, while tasks are the
              out-of-band phases around it (understanding the request, drafting the
              plan, checking the result). Hiding a five-step plan the moment one
              phase task appeared lost the more informative of the two. */}
          {latestPlan && !awaitingPlan && (
            <div className="ai-plan-dock">
              <PlanAccordion
                node={latestPlan}
                expanded={expandedNodes[latestPlan.id] ?? false}
                onExpandedChange={(open) => onToggleExpanded(latestPlan.id, open)}
                outcomes={stepOutcomes}
                onSeek={onSeek}
              />
            </div>
          )}
          {/* D3a: the ONE live region for this stream — outside the virtualized/plain
              list so scroll-driven row churn is never announced, and scoped to just
              the latest streamed assistant text (not tool/diff/notice noise). */}
          <div className="sr-only" role="status" aria-live="polite">
            {latestAssistantText}
          </div>
          <div className="ai-stream" ref={streamNode} onScroll={onScroll}>
            {activityNodes.length === 0 ? (
              <div className="ai-empty">
                <span className="ai-empty-badge" aria-hidden="true">
                  <Sparkles size={ICON_SIZE.md} />
                </span>
                <p className="ai-empty-title">Edit your video with AI</p>
                <p className="ai-empty-sub">
                  Describe a change and FramePilot proposes a reviewable, reversible edit.
                </p>
                <div className="ai-empty-prompts">
                  {examplePrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="ai-empty-prompt"
                      onClick={() => setDraft(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : virtualize ? (
              <div
                ref={contentRef}
                className="ai-stream-inner"
                role="list"
                aria-label="Conversation"
                style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
              >
                {items.map((item) => {
                  const node = activityNodes[item.index];
                  if (!node) return null;
                  return (
                    <div
                      key={node.id}
                      data-index={item.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      {renderNode(node)}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                ref={contentRef}
                className="ai-stream-inner"
                role="list"
                aria-label="Conversation"
              >
                {activityNodes.map((node) => (
                  <div key={node.id}>{renderNode(node)}</div>
                ))}
              </div>
            )}
            {!running && lastRunPatchIds.length > 0 && (
              <div className="ai-run-footer" role="status">
                <span className="ai-run-footer-count">
                  {lastRunPatchIds.length === 1
                    ? 'Made 1 edit'
                    : `Made ${String(lastRunPatchIds.length)} edits`}
                </span>
                {lastRunSummary && lastRunSummary.groups.length > 0 && (
                  <span className="ai-run-footer-changes">
                    {formatRunChangeGroups(lastRunSummary.groups)}
                  </span>
                )}
                {lastRunSummary?.durationDeltaSeconds !== undefined &&
                  formatDurationDelta(lastRunSummary.durationDeltaSeconds) !== null && (
                    <span className="ai-run-footer-duration tabular">
                      {`${formatDurationDelta(lastRunSummary.durationDeltaSeconds) ?? ''} · now ${(lastRunSummary.durationAfterSeconds ?? 0).toFixed(1)}s`}
                    </span>
                  )}
                {onReveal && lastRunReference && (
                  <button
                    type="button"
                    className="ai-btn ai-btn--quiet"
                    onClick={() => onReveal(lastRunReference)}
                  >
                    Show on timeline
                  </button>
                )}
                {undoableRunEdits > 0 ? (
                  <button type="button" className="ai-btn ai-btn--quiet" onClick={undoRun}>
                    Undo run
                  </button>
                ) : (
                  // Deliberately not a disabled button: there is nothing to retry here, and
                  // a greyed-out control invites clicking. State the reason instead.
                  <span className="ai-run-footer-note">Undo is past this run now.</span>
                )}
              </div>
            )}
            {!atBottom && (
              <button
                type="button"
                className="ai-jump"
                onClick={() => {
                  stickRef.current = true;
                  setAtBottom(true);
                  scrollToBottom();
                }}
              >
                <ArrowDown size={ICON_SIZE.sm} aria-hidden="true" /> Jump to latest
              </button>
            )}
          </div>

          {(canRetry || canResume) && (
            <div className="ai-actionbar">
              {canResume && (
                <button type="button" className="ai-btn" onClick={() => void resumeRun()}>
                  Resume
                </button>
              )}
              {canRetry && (
                <button type="button" className="ai-btn" onClick={retry}>
                  Retry
                </button>
              )}
            </div>
          )}

          {modelNotReady && (
            <div className="ai-apikey" role="status">
              <span className="ai-apikey-text">
                <Key size={ICON_SIZE.sm} aria-hidden="true" />
                <span>
                  Connect <strong>{activeProvider?.label ?? 'a model'}</strong> to start editing
                  with AI.
                </span>
              </span>
              <button
                type="button"
                className="ai-apikey-btn"
                disabled={!onOpenSettings}
                onClick={() => onOpenSettings?.()}
              >
                Set API key
              </button>
            </div>
          )}

          {mode === 'edit' && !getBridge() && (
            <div className="ai-agent-options">
              <div className="ai-agent-option">
                <Switch
                  checked={wantVariations}
                  label="Show 2 alternatives"
                  onCheckedChange={setWantVariations}
                  data-testid="ai-want-variations"
                />
                <span>Show 2 alternatives</span>
                <span className="ai-agent-option-hint">
                  Runs a second AI take to compare — doubles the real cost of this edit
                </span>
              </div>
            </div>
          )}

          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={() => void submit()}
            onStop={stop}
            running={running}
            runStatus={view.status}
            contextWindow={contextWindow}
            contextPhase={phase}
            {...(contextDebug ? { contextDebug } : {})}
            contextItems={contextItems}
            {...(editor ? { playheadChip: <PlayheadContextChip editor={editor} /> } : {})}
            onReanalyzeAttachment={(id) => void reanalyzeReference(id)}
            onChangeAttachmentRole={(id, role) => void reanalyzeReference(id, role)}
            onRemoveContext={(id) =>
              id.startsWith(MEMORY_CHIP_PREFIX)
                ? forgetDecision(id.slice(MEMORY_CHIP_PREFIX.length))
                : setRemovedContext((r) => [...r, id])
            }
            atEntities={atEntities}
            onPinEntity={onPinEntity}
            attachments={attachments}
            onAttachFiles={(files) => void attachReferenceFiles(files)}
            onRemoveAttachment={(id) => setAttachments((list) => list.filter((a) => a.id !== id))}
          />
        </>
      )}
    </div>
  );
});
