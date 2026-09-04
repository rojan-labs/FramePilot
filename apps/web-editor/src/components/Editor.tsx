/**
 * The editor workspace for one open project (plan/PLAN.md Phase 3.2/3.3/4.3).
 *
 * A professional NLE layout: a full-height right AI/inspector rail (AI assistant /
 * clip inspector) runs the ENTIRE editor height on the right, while the
 * left+center MAIN column holds a top region — left authoring rail (media bin /
 * effects / overlays / captions) · center program monitor — over a timeline dock
 * (toolbar + multi-track timeline) that spans the main column's width. So the AI
 * rail sits alongside the timeline rather than above it. Every panel is driven by
 * the same patch-engine-backed {@link useEditor} store, so manual edits and AI edits
 * share one validate→apply→record path.
 *
 * Remounted per project (keyed by id in {@link App}) so opening a new project
 * resets the store and history cleanly.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Asset, Project } from '@framepilot/timeline-schema';
import { DEFAULT_STOCK_STILL_SECONDS, type HistoryEntry } from '@framepilot/editor-core';
import type { InteractionKeyframeRef, SourceMonitorInteraction } from '@framepilot/ai-sdk';
import { WorkspaceShell, useDockHeight } from '@framepilot/ui';
import { useEditor } from '../editor/useEditor.js';
import { useEditorShortcuts } from '../editor/useShortcuts.js';
import type { Tool } from '../editor/shortcuts.js';
import { type RailSide, useRailLayout } from '../editor/useRailLayout.js';
import { oneOf, useViewPreference } from '../editor/useViewPreference.js';
import { useEditMode } from '../editor/useEditMode.js';
import { useTrackLayout } from '../editor/useTrackLayout.js';
import { assetIdsOf } from '../editor/project.js';
import { requestAiCaptionEmphasis } from '../editor/ai.js';
import { withOrientation } from '../editor/orientation.js';
import { selectionRange, webCodecsPreviewEligible } from '../editor/selectors.js';
import { useSettings } from '../editor/useSettings.js';
import { AgentFab } from './AgentFab.js';
import { projectForAi, restoreStrippedHistory } from '../editor/project-for-ai.js';
import { Toolbar } from './Toolbar.js';
import { TimelineView } from './TimelineView.js';
import { WebCodecsPreviewPlayer } from './WebCodecsPreviewPlayer.js';
import { PreviewPlayer } from './PreviewPlayer.js';
import { SourceMonitor } from './SourceMonitor.js';
import { Inspector } from './Inspector.js';
import { CaptionEditor } from './CaptionEditor.js';
import { AiSidebar, type AiSidebarHandle } from './ai/AiSidebar.js';
import type { RevealHandler } from './ai/EventNode.js';
import { MediaBin } from './MediaBin.js';
import { EffectsPanel } from './EffectsPanel.js';
import { OverlaysPanel } from './OverlaysPanel.js';
import { TransitionsPanel } from './TransitionsPanel.js';
import { MonitorHeaderPortal } from './MonitorHeaderPortal.js';
import { SoundsPanel } from './SoundsPanel.js';
import { StockPanel } from './StockPanel.js';
import {
  addMusicTrackPatch,
  addStockClipPatch,
  stockPlacementBlockedReason,
} from '../editor/patch-builders.js';
import { isDesktop } from '../editor/bridge.js';
import { Toasts } from './Toasts.js';
import { HistoryPanel } from './HistoryPanel.js';
import { FootageUnderstandingPanel } from './FootageUnderstandingPanel.js';
import { TranscriptionPanel } from './TranscriptionPanel.js';
import { Tooltip } from './Tooltip.js';
import { CommandPalette } from './CommandPalette.js';
import type { SettingsSection } from './SettingsDialog.js';
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  Folder,
  ICON_SIZE,
  ImagePlus,
  type LucideIcon,
  SlidersHorizontal,
  Sparkles,
  ArrowLeftRight,
  Music,
  Type,
  Wand2,
} from './icons.js';

export interface EditorProps {
  readonly project: Project;
  /** Host-owned optimistic-concurrency revision for AI run preconditions. */
  readonly projectRevision?: number;
  /** Changes when a host-validated project snapshot must replace editor store slices. */
  readonly projectSyncNonce?: number;
  /** Persist project changes (imported assets, learned AI memory) up to the app. */
  readonly onProjectChange?: (project: Project) => void;
  /** Replace the workspace after an authoritative desktop patch commit. */
  readonly onProjectCommit?: (project: Project, revision: number) => void;
  /** Persist the latest project and return its desktop path before transcription. */
  readonly ensureSavedForTranscription?: () => Promise<string | null>;
  /** Whether the keyboard-help overlay is open (owned by {@link App}). */
  readonly helpOpen?: boolean;
  /** Toggle the keyboard-help overlay (`?`). */
  readonly onToggleHelp?: () => void;
  /** Open the Settings dialog (`⌘,`), optionally deep-linked to a tab (H2). */
  readonly onOpenSettings?: (section?: SettingsSection) => void;
  /**
   * The Topbar's centre box (owned by {@link App}), where the Source/Program
   * switch and the monitor's view controls render.
   *
   * Absent — in a standalone Editor render or a test — and the band falls back
   * to its own row above the picture, so the monitor is never left without its
   * controls just because there is no application bar around it.
   */
  readonly monitorHeaderSlot?: HTMLElement | null;
  /** Whether the project history panel is open (owned by {@link App}). */
  readonly historyOpen?: boolean;
  /** Toggle the history panel (`⌘⇧H`). */
  readonly onToggleHistory?: () => void;
  /** Close the history panel (backdrop / Escape / after a control acts). */
  readonly onCloseHistory?: () => void;
  /** Whether the footage-understanding panel is open (owned by {@link App}). */
  readonly understandingOpen?: boolean;
  /** Close the footage-understanding panel (backdrop / Escape). */
  readonly onCloseUnderstanding?: () => void;
  /** Whether the transcription panel is open (owned by {@link App}). */
  readonly transcriptionOpen?: boolean;
  /** Close the transcription panel (backdrop / Escape). */
  readonly onCloseTranscription?: () => void;
}

const LEFT_TAB_IDS = [
  'media',
  'effects',
  'transitions',
  'overlays',
  'captions',
  'sounds',
  'stock',
] as const;
const RIGHT_TAB_IDS = ['ai', 'inspector'] as const;

type LeftTab = (typeof LEFT_TAB_IDS)[number];
type RightTab = (typeof RIGHT_TAB_IDS)[number];
type MonitorTab = 'program' | 'source';

/**
 * Which panel each rail is showing — remembered between sessions.
 *
 * These reset to Assets/AI/Program on every open until now, which an e2e reload proved
 * directly: set the left rail to Effects, reload, and it is back on Assets. The rails'
 * WIDTHS were persisted all along (`useRailLayout`), so the workspace came back the right
 * shape showing the wrong things.
 *
 * Coerced against the id lists above rather than a hand-written copy, so a renamed or
 * retired tab falls back to the default instead of selecting a panel that no longer exists.
 */

const LEFT_TABS: readonly { id: LeftTab; label: string; icon: LucideIcon }[] = [
  { id: 'media', label: 'Assets', icon: Folder },
  { id: 'effects', label: 'Effects', icon: Sparkles },
  { id: 'transitions', label: 'Transitions', icon: ArrowLeftRight },
  { id: 'overlays', label: 'Text', icon: Type },
  { id: 'captions', label: 'Captions', icon: Captions },
  { id: 'sounds', label: 'Sounds', icon: Music },
  { id: 'stock', label: 'Stock', icon: ImagePlus },
];

/** Tabs that need the main process to reach a third-party provider. */
const DESKTOP_ONLY_TABS: ReadonlySet<LeftTab> = new Set<LeftTab>(['sounds', 'stock']);

/**
 * The tabs actually shown.
 *
 * Sounds and Stock need the main process to reach a provider — the renderer's
 * CSP forbids it, deliberately — so in a plain browser those tabs are **absent**
 * rather than present-and-broken. A tab that opens a panel explaining it cannot
 * work is worse than no tab: it costs a click to learn nothing.
 */
function visibleLeftTabs(): readonly { id: LeftTab; label: string; icon: LucideIcon }[] {
  return isDesktop() ? LEFT_TABS : LEFT_TABS.filter((tab) => !DESKTOP_ONLY_TABS.has(tab.id));
}

const isLeftTab = oneOf<LeftTab>(LEFT_TAB_IDS);
const coerceRightTab = oneOf<RightTab>(RIGHT_TAB_IDS);

/**
 * Restore a left tab only if THIS build actually renders it.
 *
 * Sounds and Stock are absent in a browser build (see {@link visibleLeftTabs}), and the
 * same person's preference travels between the two: set the rail to Stock on desktop, open
 * the web build, and a bare id check would select a panel with no tab to match it — a rail
 * showing something the tab strip says is not there. Checked at call time because
 * `isDesktop()` is a runtime fact, and only ever on the stored value, so the default is
 * untouched.
 */
function coerceLeftTab(raw: unknown): LeftTab | undefined {
  const tab = isLeftTab(raw);
  if (tab === undefined) return undefined;
  return isDesktop() || !DESKTOP_ONLY_TABS.has(tab) ? tab : undefined;
}

const RIGHT_TABS: readonly { id: RightTab; label: string; icon: LucideIcon }[] = [
  { id: 'ai', label: 'AI', icon: Wand2 },
  { id: 'inspector', label: 'Inspector', icon: SlidersHorizontal },
];

interface RailTabsProps<T extends string> {
  readonly label: string;
  readonly tabs: readonly { id: T; label: string; icon: LucideIcon }[];
  readonly active: T;
  readonly onSelect: (id: T) => void;
}

function RailTabs<T extends string>({
  label,
  tabs,
  active,
  onSelect,
}: RailTabsProps<T>): JSX.Element {
  return (
    <div className="rail-tabs" role="tablist" aria-label={label}>
      {tabs.map(({ id, label: tabLabel, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          aria-controls={`rail-${id}`}
          onClick={() => onSelect(id)}
        >
          <Icon className="rail-tab-icon" size={ICON_SIZE.sm} aria-hidden="true" />
          {tabLabel}
        </button>
      ))}
    </div>
  );
}

export function Editor({
  project,
  projectRevision,
  projectSyncNonce = 0,
  onProjectChange,
  onProjectCommit,
  ensureSavedForTranscription,
  helpOpen,
  onToggleHelp,
  onOpenSettings,
  historyOpen = false,
  onToggleHistory,
  onCloseHistory,
  understandingOpen = false,
  onCloseUnderstanding,
  transcriptionOpen = false,
  onCloseTranscription,
  monitorHeaderSlot = null,
}: EditorProps): JSX.Element {
  const editor = useEditor(project.timeline, {
    assets: project.assets,
    folders: project.folders,
    assetIds: assetIdsOf(project),
    markers: project.markers,
    transcript: project.transcript,
    history: project.history as readonly HistoryEntry[],
  });
  const appliedProjectSyncNonce = useRef(projectSyncNonce);
  const skipProjectLift = useRef(false);
  useLayoutEffect(() => {
    if (appliedProjectSyncNonce.current === projectSyncNonce) return;
    appliedProjectSyncNonce.current = projectSyncNonce;
    skipProjectLift.current = true;
    editor.replaceAuthoritativeProject(project);
  }, [editor.replaceAuthoritativeProject, project, projectSyncNonce]);
  const [leftTab, setLeftTab] = useViewPreference<LeftTab>('leftTab', 'media', coerceLeftTab);
  // NOT persisted, deliberately. Program/Source is a mode the interaction drives — clicking
  // an asset switches to Source by itself — not a layout preference. Restoring "Source" on
  // open, with no asset loaded, reopens the editor onto an empty monitor: a worse first
  // frame than the edit you were working on.
  const [monitorTab, setMonitorTab] = useState<MonitorTab>('program');
  const [monitorHeaderControlsHost, setMonitorHeaderControlsHost] = useState<HTMLDivElement | null>(
    null,
  );
  /**
   * The monitor column, measured so the hoisted header band can be pinned to
   * exactly its left and right edges up in the application bar.
   *
   * Measured rather than derived from the persisted rail widths: those are one
   * input among several — a collapsed rail, the activity bar, a splitter drag
   * mid-gesture — and re-deriving the column's position from them would be a
   * second implementation of the layout that is wrong whenever the first
   * changes. The element already knows where it is.
   *
   * Both numbers are insets from the topbar's centre slot, not from the window,
   * so the band can never escape the space that slot reserves.
   */
  const stageMonitorRef = useRef<HTMLDivElement | null>(null);
  const [monitorBandInset, setMonitorBandInset] = useState<{
    readonly left: number;
    readonly right: number;
    /** Whether that edge really landed on the column's, and so earns a rule. */
    readonly rulesLeft: boolean;
    readonly rulesRight: boolean;
  } | null>(null);

  useEffect(() => {
    const stage = stageMonitorRef.current;
    if (stage === null || monitorHeaderSlot === null) {
      setMonitorBandInset(null);
      return;
    }
    const measure = (): void => {
      const column = stage.getBoundingClientRect();
      const slot = monitorHeaderSlot.getBoundingClientRect();
      // Minus one on each side so the band's own rules land ON the rail borders
      // rather than one pixel inside them: `.rail-left`'s `border-right` and
      // `.rail-right`'s `border-left` sit OUTSIDE the column's rect, and the
      // whole point is for the two hairlines to read as those same borders
      // carried up through the bar.
      //
      // Clamped at zero against the slot — the free span between the brand and
      // the window actions — so collapsing a rail widens the column past what
      // the bar can spare and the band stops at that edge instead of sliding
      // under Export.
      const left = column.left - 1 - slot.left;
      const right = slot.right - (column.right + 1);
      // A hairline is only drawn on the side that actually reached the column's
      // edge. Clamped, it would be a rule with nothing below it to continue —
      // which reads as a stray line, not as the rail border carried upward.
      setMonitorBandInset({
        left: Math.max(0, left),
        right: Math.max(0, right),
        rulesLeft: left >= 0,
        rulesRight: right >= 0,
      });
    };
    measure();
    // jsdom (unit tests) has no ResizeObserver — degrade to measuring on mount
    // plus window resize, like the toolbar/rail observers do.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(monitorHeaderSlot);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [monitorHeaderSlot]);
  const [sourceAsset, setSourceAsset] = useState<Asset | undefined>(undefined);
  const openInSource = useCallback((asset: Asset) => {
    setSourceAsset(asset);
    setMonitorTab('source');
  }, []);
  const [rightTab, setRightTab] = useViewPreference<RightTab>('rightTab', 'ai', coerceRightTab);
  const dockLayout = useDockHeight();

  // Mirror live editable slices upward without turning restart serialization into
  // interaction work. The common commit/redo case reuses history.entries by reference;
  // undo/time-travel slices only the currently applied prefix. `persistProject` owns
  // collapse + count/byte bounds when a real checkpoint is written.
  useEffect(() => {
    if (!onProjectChange) return;
    if (skipProjectLift.current) {
      skipProjectLift.current = false;
      return;
    }
    const { timeline, assets, folders, markers, transcript, history } = editor.state;
    if (
      timeline !== project.timeline ||
      assets !== project.assets ||
      folders !== project.folders ||
      markers !== project.markers ||
      transcript !== project.transcript
    ) {
      const appliedHistory =
        history.cursor === history.entries.length
          ? history.entries
          : history.entries.slice(0, history.cursor);
      onProjectChange({
        ...project,
        timeline,
        assets: assets as Project['assets'],
        folders: folders as Project['folders'],
        markers: markers as Project['markers'],
        transcript: transcript as Project['transcript'],
        history: appliedHistory as Project['history'],
      });
    }
  }, [
    editor.state.timeline,
    editor.state.assets,
    editor.state.folders,
    editor.state.markers,
    editor.state.transcript,
    editor.state.history,
  ]);
  const { editMode, rippleOnDelete, setEditMode, toggleRippleOnDelete } = useEditMode();
  const [tool, setTool] = useState<Tool>('select');
  const trackLayout = useTrackLayout();
  const [selectedEffectLayerIds, setSelectedEffectLayerIds] = useState<readonly string[]>([]);
  const [selectedKeyframes, setSelectedKeyframes] = useState<readonly InteractionKeyframeRef[]>([]);
  const [sourceMonitorInteraction, setSourceMonitorInteraction] =
    useState<SourceMonitorInteraction>();
  useEffect(() => {
    if (!sourceAsset) return;
    if (editor.state.assets.some((asset) => asset.id === sourceAsset.id)) return;
    setSourceAsset(undefined);
    setSourceMonitorInteraction(undefined);
    setMonitorTab('program');
  }, [editor.state.assets, sourceAsset]);

  const rails = useRailLayout();
  const [railAnimating, setRailAnimating] = useState(false);
  const railAnimTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toggleRail = useCallback(
    (side: RailSide) => {
      setRailAnimating(true);
      rails.toggleCollapsed(side);
      if (railAnimTimer.current !== undefined) clearTimeout(railAnimTimer.current);
      railAnimTimer.current = setTimeout(() => setRailAnimating(false), 300);
    },
    [rails],
  );
  useEffect(
    () => () => {
      if (railAnimTimer.current !== undefined) clearTimeout(railAnimTimer.current);
    },
    [],
  );

  const [paletteOpen, setPaletteOpen] = useState(false);
  const { settings, update } = useSettings();
  const toggleSnapping = useCallback(
    () => update({ snapping: !settings.snapping }),
    [update, settings.snapping],
  );
  useEditorShortcuts(editor, project.fps, {
    ...(onToggleHelp ? { onToggleHelp } : {}),
    ...(helpOpen !== undefined ? { helpOpen } : {}),
    ...(onOpenSettings ? { onOpenSettings } : {}),
    ...(onToggleHistory ? { onToggleHistory } : {}),
    onTogglePalette: () => setPaletteOpen((open) => !open),
    rippleOnDelete,
    onSetTool: setTool,
    onToggleSnapping: toggleSnapping,
    selectedEffectLayerIds,
    setSelectedEffectLayerIds,
  });

  const s = editor.state;
  const nonPlayheadKey = useMemo(
    () => ({}),
    [
      s.timeline,
      s.history,
      s.assets,
      s.folders,
      s.assetIds,
      s.issues,
      s.selection,
      s.selectedIds,
      s.pxPerSecond,
      s.markers,
      s.transcript,
      s.playing,
    ],
  );
  const onReveal = useCallback<RevealHandler>(
    (reference) => {
      if (reference.kind === 'clip') editor.select(reference.id);
    },
    [editor.select],
  );

  const aiSidebarRef = useRef<AiSidebarHandle>(null);
  const [pendingQuickEdit, setPendingQuickEdit] = useState<string | null>(null);
  const submitQuickEdit = useCallback(
    (text: string) => {
      setRightTab('ai');
      if (rails.right.collapsed) toggleRail('right');
      setPendingQuickEdit(text);
    },
    [rails.right.collapsed, toggleRail],
  );
  useEffect(() => {
    if (pendingQuickEdit === null || rightTab !== 'ai' || !aiSidebarRef.current) return;
    aiSidebarRef.current.runQuickEdit(pendingQuickEdit);
    setPendingQuickEdit(null);
  }, [pendingQuickEdit, rightTab]);

  const selectedIds = editor.state.selectedIds;
  const selectionRangeValue = useMemo(
    () => (selectedIds.length > 0 ? selectionRange(editor.state.timeline, selectedIds) : null),
    [editor.state.timeline, selectedIds],
  );
  const hasSelection = selectionRangeValue !== null;

  const round1 = (n: number): number => Math.round(n * 10) / 10;
  const selectionLabel = selectionRangeValue
    ? `${selectedIds.length === 1 ? '1 clip' : `${selectedIds.length} clips`}, ${round1(
        selectionRangeValue.start,
      )}–${round1(selectionRangeValue.end)}s`
    : undefined;

  const programAssetById = useMemo(
    () => new Map(project.assets.map((asset) => [asset.id, asset])),
    [project.assets],
  );
  const useWebCodecsPreview = useMemo(
    // The project's own frame: coverage is a relation between the stacked clips AND the
    // frame they are fitted into (ADR 0170), so the same stack is honest in one aspect
    // ratio and divergent in another.
    () => webCodecsPreviewEligible(editor.state.timeline, programAssetById, project.resolution),
    [editor.state.timeline, programAssetById, project.resolution],
  );
  const ProgramPreview = useWebCodecsPreview ? WebCodecsPreviewPlayer : PreviewPlayer;

  /**
   * "Open the Inspector when I click something" (Settings → Editing).
   *
   * Bound to a deliberate click on a clip, not to `state.selection` changing, so a
   * selection made by the AI mid-run — or by a marquee, or by an undo — never
   * yanks the rail out from under the user.
   *
   * When it does take the rail from a running agent, the run is not lost: it moves
   * to `AgentFab`, which is one click back to it.
   */
  const openInspectorOnSelect = settings.openInspectorOnSelect;
  const onItemActivate = useCallback(() => {
    if (openInspectorOnSelect) setRightTab('inspector');
  }, [openInspectorOnSelect, setRightTab]);

  const onAskAiForClip = useCallback(
    (clipId: string) => {
      editor.select(clipId);
      setPaletteOpen(true);
    },
    [editor.select],
  );

  /**
   * "Reveal in bin" (UX-08): switch the rail to the media bin and ask it to bring
   * the asset's card into view. The counter matters — revealing the same asset a
   * second time must move again, and by then the user has usually scrolled away.
   */
  const [revealRequest, setRevealRequest] = useState<
    { readonly assetId: string; readonly seq: number } | undefined
  >(undefined);
  const revealAssetInBin = useCallback((assetId: string) => {
    setLeftTab('media');
    setRevealRequest((previous) => ({ assetId, seq: (previous?.seq ?? 0) + 1 }));
  }, []);

  const mediaBinEl = useMemo(
    () => (
      <MediaBin
        editor={editor}
        project={project}
        {...(projectRevision === undefined ? {} : { projectRevision })}
        editMode={editMode}
        onOpenInSource={openInSource}
        {...(onProjectChange ? { onProjectChange } : {})}
        {...(onProjectCommit ? { onProjectCommit } : {})}
        {...(ensureSavedForTranscription ? { ensureSavedForTranscription } : {})}
        {...(revealRequest ? { revealRequest } : {})}
      />
    ),
    [
      nonPlayheadKey,
      project,
      editMode,
      onProjectChange,
      openInSource,
      ensureSavedForTranscription,
      revealRequest,
    ],
  );
  const effectsEl = useMemo(() => <EffectsPanel editor={editor} />, [nonPlayheadKey]);
  const overlaysEl = useMemo(() => <OverlaysPanel editor={editor} />, [nonPlayheadKey]);
  const transitionsEl = useMemo(() => <TransitionsPanel editor={editor} />, [nonPlayheadKey]);
  const soundsEl = useMemo(
    () => (
      <SoundsPanel
        project={project}
        onAddMusic={(asset) => {
          // One patch: bin + music layer + clip. One undo takes all three back.
          editor.applyPatch(addMusicTrackPatch(editor.state.timeline, asset));
        }}
      />
    ),
    [nonPlayheadKey, project],
  );
  const stockEl = useMemo(() => {
    // Recomputed with the playhead, because the answer changes as it moves —
    // the tile must be able to disable Add with a reason *before* the click.
    const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
    return (
      <StockPanel
        project={project}
        placementBlockedReasonFor={(durationSeconds) =>
          stockPlacementBlockedReason(
            editor.state.timeline,
            assetById,
            editor.state.playhead,
            durationSeconds,
          )
        }
        onAddStock={(asset) => {
          // Read from the store at CLICK time, not from the closure the tile was
          // rendered with: a download takes seconds, and the playhead and the
          // timeline both move during them.
          const live = editor.state;
          const liveAssetById = new Map(live.assets.map((a) => [a.id, a]));
          const patch = addStockClipPatch(live.timeline, liveAssetById, asset, live.playhead);
          if (patch === null) {
            // Said, not swallowed: the user watched this download. The tile
            // shows the sentence and keeps the asset out of the bin, so a retry
            // after moving the playhead is one click.
            return (
              stockPlacementBlockedReason(
                live.timeline,
                liveAssetById,
                live.playhead,
                asset.durationSeconds ?? DEFAULT_STOCK_STILL_SECONDS,
              ) ?? 'That spot is occupied — move the playhead and try again.'
            );
          }
          editor.applyPatch(patch);
          return null;
        }}
        {...(onOpenSettings ? { onOpenSettings: () => onOpenSettings('ai') } : {})}
      />
    );
  }, [project, editor.state.playhead, editor.state.timeline, onOpenSettings]);
  const openTransitionLibrary = useCallback(() => setLeftTab('transitions'), []);
  const aiFacingProject = useMemo(
    () => projectForAi(project, editor.state),
    [
      project,
      editor.state.timeline,
      editor.state.assets,
      editor.state.folders,
      editor.state.markers,
      editor.state.transcript,
      editor.state.history,
    ],
  );
  /**
   * Re-hydrate what {@link projectForAi} stripped before an AI-derived project is lifted
   * for persistence.
   *
   * The sidebar's memory writes, its "undo run", and its browser-mode apply path all
   * derive their new Project from {@link aiFacingProject}, whose history is empty by
   * design. Handed straight to `onProjectChange`, that empty history reached App's history
   * differ as a transition from the user's real `[…]` to `[]` — an apparent undo of the
   * whole session, whose inverses were then committed to disk while the on-screen timeline
   * never moved. Nothing about the `Project`-typed prop made that visible at the call site,
   * so the boundary that strips the history closes it here.
   */
  const handleAiProjectChange = useCallback(
    (next: Project): void => {
      onProjectChange?.(restoreStrippedHistory(next, project));
    },
    [onProjectChange, project],
  );
  const aiSidebarEl = useMemo(
    () => (
      <AiSidebar
        key={aiFacingProject.id}
        ref={aiSidebarRef}
        project={aiFacingProject}
        {...(projectRevision === undefined ? {} : { projectRevision })}
        editor={editor}
        selectedEffectLayerIds={selectedEffectLayerIds}
        selectedKeyframes={selectedKeyframes}
        {...(sourceMonitorInteraction ? { sourceMonitor: sourceMonitorInteraction } : {})}
        {...(onProjectChange ? { onProjectChange: handleAiProjectChange } : {})}
        {...(onOpenSettings ? { onOpenSettings: () => onOpenSettings('ai') } : {})}
        onReveal={onReveal}
      />
    ),
    [
      nonPlayheadKey,
      aiFacingProject,
      projectRevision,
      handleAiProjectChange,
      onProjectChange,
      onProjectCommit,
      onOpenSettings,
      onReveal,
      selectedEffectLayerIds,
      selectedKeyframes,
      sourceMonitorInteraction,
    ],
  );
  const toastsEl = useMemo(() => <Toasts editor={editor} />, [nonPlayheadKey]);
  const toolbarEl = useMemo(
    () => (
      <Toolbar
        editor={editor}
        editMode={editMode}
        onSetEditMode={setEditMode}
        rippleOnDelete={rippleOnDelete}
        onToggleRippleOnDelete={toggleRippleOnDelete}
        tool={tool}
        onSetTool={setTool}
        snapping={settings.snapping}
        onToggleSnapping={toggleSnapping}
      />
    ),
    [
      nonPlayheadKey,
      editMode,
      setEditMode,
      rippleOnDelete,
      toggleRippleOnDelete,
      tool,
      setTool,
      settings.snapping,
      toggleSnapping,
    ],
  );
  const timelineEl = useMemo(
    () => (
      <TimelineView
        editor={editor}
        assets={project.assets}
        fps={project.fps}
        editMode={editMode}
        trackLayout={trackLayout}
        onAskAiForClip={onAskAiForClip}
        onRevealAssetInBin={revealAssetInBin}
        onOpenTransitionLibrary={openTransitionLibrary}
        tool={tool}
        selectedEffectLayerIds={selectedEffectLayerIds}
        onSelectEffectLayers={setSelectedEffectLayerIds}
        onKeyframeSelectionChange={setSelectedKeyframes}
        onItemActivate={onItemActivate}
      />
    ),
    [
      nonPlayheadKey,
      project.assets,
      project.fps,
      editMode,
      trackLayout,
      onAskAiForClip,
      onItemActivate,
      revealAssetInBin,
      openTransitionLibrary,
      tool,
      selectedEffectLayerIds,
    ],
  );

  return (
    <WorkspaceShell
      railAnimating={railAnimating}
      left={{
        collapsed: rails.left.collapsed,
        width: rails.leftWidth,
        onResize: (w) => rails.setWidth('left', w),
        onToggleCollapsed: () => toggleRail('left'),
        ariaLabel: 'library panels',
        expandLabel: 'Expand library panel',
        expandIcon: <ChevronRight size={ICON_SIZE.sm} aria-hidden="true" />,
        children: (
          <>
            {/* Icons only. The name lives in the tooltip and in `aria-label`, not
                in a 9px caption under every glyph: this is a fixed shelf of seven
                destinations an editor learns in a session, and printing the word
                under each one cost 18px of width and 12px of height per tab
                forever to teach something once.

                Two boxes, not one list: the tabs scroll when a short window
                cannot fit them all, while Collapse stays pinned to the bottom
                edge. Putting them in one scroller would push the only way to
                collapse the rail off-screen exactly when the window is too short
                to spare the width. */}
            <nav className="rail-activitybar" aria-label="Library">
              <div className="activity-tabs" role="tablist" aria-label="library tabs">
                {visibleLeftTabs().map(({ id, label, icon: Icon }) => (
                  <Tooltip key={id} label={label} placement="right">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={leftTab === id}
                      aria-controls={`rail-${id}`}
                      aria-label={label}
                      className={`activity-tab${leftTab === id ? ' is-active' : ''}`}
                      onClick={() => setLeftTab(id)}
                    >
                      {/* `sm` is the scale's documented size for tabs and list
                          rows; `md` is the toolbar size, and using it here made
                          the rail shout louder than the panel it opens. */}
                      <Icon size={ICON_SIZE.sm} aria-hidden="true" />
                    </button>
                  </Tooltip>
                ))}
              </div>
              {/* Collapse only. Preferences used to sit here too, duplicating the
                  Topbar's Settings button — which is the one with the ⌘, badge on
                  it. Two doors to the same dialog, and the rail's was the one
                  nobody could discover a shortcut from. */}
              <div className="activity-rail-footer">
                <Tooltip label="Collapse panel" placement="right">
                  <button
                    type="button"
                    className="activity-tab rail-collapse"
                    aria-label="Collapse library panel"
                    onClick={() => toggleRail('left')}
                  >
                    <ChevronLeft size={ICON_SIZE.sm} aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
            </nav>
            <div className="rail-left-body">
              <div
                className={`rail-body${leftTab === 'captions' ? '' : ' rail-body--padded'}`}
                id={`rail-${leftTab}`}
                role="tabpanel"
              >
                {leftTab === 'media' && mediaBinEl}
                {leftTab === 'effects' && effectsEl}
                {leftTab === 'transitions' && transitionsEl}
                {leftTab === 'sounds' && soundsEl}
                {leftTab === 'stock' && stockEl}
                {leftTab === 'overlays' && overlaysEl}
                {leftTab === 'captions' && (
                  <CaptionEditor
                    editor={editor}
                    transcript={project.transcript}
                    fps={project.fps}
                    analyzeEmphasis={() => requestAiCaptionEmphasis(project, project.transcript)}
                  />
                )}
              </div>
            </div>
          </>
        ),
      }}
      right={{
        collapsed: rails.right.collapsed,
        width: rails.rightWidth,
        onResize: (w) => rails.setWidth('right', w),
        onToggleCollapsed: () => toggleRail('right'),
        ariaLabel: 'panels',
        expandLabel: 'Expand inspector panel',
        expandIcon: <ChevronLeft size={ICON_SIZE.sm} aria-hidden="true" />,
        children: (
          <>
            <div className="rail-head">
              <RailTabs
                label="rail tabs"
                tabs={RIGHT_TABS}
                active={rightTab}
                onSelect={setRightTab}
              />
              <button
                type="button"
                className="rail-collapse"
                aria-label="Collapse inspector panel"
                title="Collapse inspector panel"
                onClick={() => toggleRail('right')}
              >
                <ChevronRight size={ICON_SIZE.sm} aria-hidden="true" />
              </button>
            </div>
            <div
              className={`rail-body${rightTab === 'ai' ? '' : ' rail-body--padded'}`}
              id={`rail-${rightTab}`}
              role="tabpanel"
            >
              <div className="rail-ai-persistent" hidden={rightTab !== 'ai'}>
                {aiSidebarEl}
              </div>
              {rightTab === 'inspector' && (
                <Inspector
                  editor={editor}
                  fps={project.fps}
                  selectedEffectLayerIds={selectedEffectLayerIds}
                  onClearEffectLayers={() => setSelectedEffectLayerIds([])}
                />
              )}
            </div>
          </>
        ),
      }}
      center={
        <div className="stage-monitor" ref={stageMonitorRef}>
          {/* The band lives in the application bar when there is one — see
              `.topbar-monitor`. `data-hoisted` is what drops its own background
              and bottom rule and pins it to the measured column edges: up there
              it is part of the bar's surface, not a strip laid over the picture. */}
          <MonitorHeaderPortal host={monitorHeaderSlot}>
            <div
              className="monitor-header"
              {...(monitorHeaderSlot ? { 'data-hoisted': 'true' } : {})}
              {...(monitorBandInset
                ? {
                    style: { left: monitorBandInset.left, right: monitorBandInset.right },
                    'data-rule-left': monitorBandInset.rulesLeft ? 'true' : undefined,
                    'data-rule-right': monitorBandInset.rulesRight ? 'true' : undefined,
                  }
                : {})}
            >
              <div
                className="monitor-tabs segmented"
                role="tablist"
                aria-label="monitor"
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  const tabs = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
                  );
                  const from = tabs.indexOf(event.target as HTMLButtonElement);
                  const next = tabs[event.key === 'ArrowRight' ? from + 1 : from - 1];
                  if (!next) return;
                  event.preventDefault();
                  next.focus();
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={monitorTab === 'source'}
                  aria-controls="monitor-source"
                  tabIndex={monitorTab === 'source' ? 0 : -1}
                  className={`monitor-tab${monitorTab === 'source' ? ' is-active' : ''}`}
                  onClick={() => setMonitorTab('source')}
                >
                  Source
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={monitorTab === 'program'}
                  aria-controls="monitor-program"
                  tabIndex={monitorTab === 'program' ? 0 : -1}
                  className={`monitor-tab${monitorTab === 'program' ? ' is-active' : ''}`}
                  onClick={() => setMonitorTab('program')}
                >
                  Program
                </button>
              </div>
              <div
                ref={setMonitorHeaderControlsHost}
                className="monitor-header-actions"
                aria-label="monitor view controls"
              />
            </div>
          </MonitorHeaderPortal>
          <div
            className="monitor-tab-body"
            id={monitorTab === 'source' ? 'monitor-source' : 'monitor-program'}
            role="tabpanel"
          >
            {monitorTab === 'source' ? (
              <SourceMonitor
                asset={sourceAsset}
                fps={project.fps}
                headerControlsHost={monitorHeaderControlsHost}
                onInteractionChange={setSourceMonitorInteraction}
              />
            ) : (
              <ProgramPreview
                editor={editor}
                assets={project.assets}
                fps={project.fps}
                aspect={project.resolution.width / project.resolution.height}
                resolution={project.resolution}
                headerControlsHost={monitorHeaderControlsHost}
                soloedTrackIds={trackLayout.soloedIds}
                transcript={project.transcript}
                {...(onProjectChange
                  ? {
                      onChangeOrientation: (presetId: string) => {
                        const next = withOrientation(project, presetId);
                        if (next !== project) onProjectChange(next);
                      },
                    }
                  : {})}
              />
            )}
          </div>
        </div>
      }
      dock={{
        height: dockLayout.height,
        onResize: dockLayout.setHeight,
        children: (
          <>
            {toolbarEl}
            {timelineEl}
          </>
        ),
      }}
      overlay={
        <>
          {/* Mounted unconditionally: it renders null unless a run is live and its
              panel is off screen, and it subscribes to the agent store directly, so
              this costs one subscription and never re-renders the editor. */}
          <AgentFab aiPanelVisible={rightTab === 'ai'} onOpenAi={() => setRightTab('ai')} />
          {toastsEl}
          <HistoryPanel
            editor={editor}
            project={project}
            open={historyOpen}
            onClose={() => onCloseHistory?.()}
          />
          <FootageUnderstandingPanel
            editor={editor}
            project={project}
            open={understandingOpen}
            onClose={() => onCloseUnderstanding?.()}
          />
          <TranscriptionPanel
            editor={editor}
            open={transcriptionOpen}
            onClose={() => onCloseTranscription?.()}
            {...(ensureSavedForTranscription ? { ensureSavedForTranscription } : {})}
          />
          <CommandPalette
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            hasSelection={hasSelection}
            {...(selectionLabel ? { selectionLabel } : {})}
            onSubmitScopedEdit={submitQuickEdit}
            onOpenAiSidebar={() => {
              setRightTab('ai');
              if (rails.right.collapsed) toggleRail('right');
            }}
          />
        </>
      }
    />
  );
}
