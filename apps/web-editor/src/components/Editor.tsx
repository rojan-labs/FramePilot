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
import type { HistoryEntry } from '@framepilot/editor-core';
import type { InteractionKeyframeRef, SourceMonitorInteraction } from '@framepilot/ai-sdk';
import { WorkspaceShell, useDockHeight } from '@framepilot/ui';
import { useEditor } from '../editor/useEditor.js';
import { useEditorShortcuts } from '../editor/useShortcuts.js';
import type { Tool } from '../editor/shortcuts.js';
import { type RailSide, useRailLayout } from '../editor/useRailLayout.js';
import { useEditMode } from '../editor/useEditMode.js';
import { useTrackLayout } from '../editor/useTrackLayout.js';
import { assetIdsOf } from '../editor/project.js';
import { requestAiCaptionEmphasis } from '../editor/ai.js';
import { withOrientation } from '../editor/orientation.js';
import { selectionRange, webCodecsPreviewEligible } from '../editor/selectors.js';
import { useSettings } from '../editor/useSettings.js';
import { projectForAi } from '../editor/project-for-ai.js';
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
import { SoundsPanel } from './SoundsPanel.js';
import { addMusicTrackPatch } from '../editor/patch-builders.js';
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
  type LucideIcon,
  Settings,
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

type LeftTab = 'media' | 'effects' | 'transitions' | 'overlays' | 'captions' | 'sounds';
type RightTab = 'ai' | 'inspector';

const LEFT_TABS: readonly { id: LeftTab; label: string; icon: LucideIcon }[] = [
  { id: 'media', label: 'Assets', icon: Folder },
  { id: 'effects', label: 'Effects', icon: Sparkles },
  { id: 'transitions', label: 'Transitions', icon: ArrowLeftRight },
  { id: 'overlays', label: 'Text', icon: Type },
  { id: 'captions', label: 'Captions', icon: Captions },
  { id: 'sounds', label: 'Sounds', icon: Music },
];

/**
 * The tabs actually shown.
 *
 * Sounds needs the main process to reach a provider — the renderer's CSP forbids
 * it, deliberately — so in a plain browser the tab is **absent** rather than
 * present-and-broken. A tab that opens a panel explaining it cannot work is
 * worse than no tab: it costs a click to learn nothing.
 */
function visibleLeftTabs(): readonly { id: LeftTab; label: string; icon: LucideIcon }[] {
  return isDesktop() ? LEFT_TABS : LEFT_TABS.filter((tab) => tab.id !== 'sounds');
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
  const [leftTab, setLeftTab] = useState<LeftTab>('media');
  const [monitorTab, setMonitorTab] = useState<'program' | 'source'>('program');
  const [monitorHeaderControlsHost, setMonitorHeaderControlsHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [sourceAsset, setSourceAsset] = useState<Asset | undefined>(undefined);
  const openInSource = useCallback((asset: Asset) => {
    setSourceAsset(asset);
    setMonitorTab('source');
  }, []);
  const [rightTab, setRightTab] = useState<RightTab>('ai');
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
    () => webCodecsPreviewEligible(editor.state.timeline, programAssetById),
    [editor.state.timeline, programAssetById],
  );
  const ProgramPreview = useWebCodecsPreview ? WebCodecsPreviewPlayer : PreviewPlayer;

  const onAskAiForClip = useCallback(
    (clipId: string) => {
      editor.select(clipId);
      setPaletteOpen(true);
    },
    [editor.select],
  );

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
      />
    ),
    [nonPlayheadKey, project, editMode, onProjectChange, openInSource, ensureSavedForTranscription],
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
  const openTransitionLibrary = useCallback(() => setLeftTab('transitions'), []);
  const aiProject = useMemo(
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
  const aiSidebarEl = useMemo(
    () => (
      <AiSidebar
        key={aiProject.id}
        ref={aiSidebarRef}
        project={aiProject}
        {...(projectRevision === undefined ? {} : { projectRevision })}
        editor={editor}
        selectedEffectLayerIds={selectedEffectLayerIds}
        selectedKeyframes={selectedKeyframes}
        {...(sourceMonitorInteraction ? { sourceMonitor: sourceMonitorInteraction } : {})}
        {...(onProjectChange ? { onProjectChange } : {})}
        {...(onOpenSettings ? { onOpenSettings: () => onOpenSettings('ai') } : {})}
        onReveal={onReveal}
      />
    ),
    [
      nonPlayheadKey,
      aiProject,
      projectRevision,
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
        onOpenTransitionLibrary={openTransitionLibrary}
        tool={tool}
        selectedEffectLayerIds={selectedEffectLayerIds}
        onSelectEffectLayers={setSelectedEffectLayerIds}
        onKeyframeSelectionChange={setSelectedKeyframes}
      />
    ),
    [
      nonPlayheadKey,
      project.assets,
      project.fps,
      editMode,
      trackLayout,
      onAskAiForClip,
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
            <nav className="rail-activitybar" role="tablist" aria-label="library tabs">
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
                    <Icon size={ICON_SIZE.md} aria-hidden="true" />
                  </button>
                </Tooltip>
              ))}
              <span className="activity-spacer" />
              {onOpenSettings && (
                <Tooltip label="Preferences" placement="right">
                  <button
                    type="button"
                    className="activity-tab"
                    aria-label="Preferences"
                    onClick={() => onOpenSettings()}
                  >
                    <Settings size={ICON_SIZE.md} aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
              <Tooltip label="Collapse panel" placement="right">
                <button
                  type="button"
                  className="activity-tab rail-collapse"
                  aria-label="Collapse library panel"
                  onClick={() => toggleRail('left')}
                >
                  <ChevronLeft size={ICON_SIZE.md} aria-hidden="true" />
                </button>
              </Tooltip>
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
                {leftTab === 'overlays' && overlaysEl}
                {leftTab === 'captions' && (
                  <CaptionEditor
                    editor={editor}
                    transcript={project.transcript}
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
                  selectedEffectLayerIds={selectedEffectLayerIds}
                  onClearEffectLayers={() => setSelectedEffectLayerIds([])}
                />
              )}
            </div>
          </>
        ),
      }}
      center={
        <div className="stage-monitor">
          <div className="monitor-header">
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
