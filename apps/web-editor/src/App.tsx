/**
 * @framepilot/web-editor App — the editor shell (plan/PLAN.md Phase 3.2/3.3/4/3.4/8).
 *
 * Project IO is unified through {@link persistProject}. In the desktop shell, routine
 * validated manual edits are committed to the authoritative host as their existing
 * reversible Patch rather than structured-cloning the full Project on every autosave.
 * Full snapshots remain the path for first save, explicit Save/export checkpoints,
 * browser persistence, recovery and non-patch metadata changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Patch } from '@framepilot/editor-core';
import { createLogger, type CapabilityPackProjectResolutionWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { clearBitmapCache } from './editor/bitmapCache.js';
import { clearWaveformBitmapCache } from './components/ClipWaveform.js';
import { ensureBaseTracks, newProject, uniqueProjectId } from './editor/project.js';
import {
  getBridge,
  onProjectChanged,
  openProject,
  openProjectDialog as openViaDialog,
  revealProject,
} from './editor/bridge.js';
import { loadAppBootState } from './editor/app-boot.js';
import {
  manualAuthorityAfterCommit,
  type PendingManualAuthority,
} from './editor/manual-authority.js';
import { manualPatchesForHistoryTransition } from './editor/manual-patch-sync.js';
import {
  AUTOSAVE_DEBOUNCE_MS,
  BROWSER_PATH_PREFIX,
  type SaveOutcome,
  loadBrowserProject,
  persistProject,
  writeBrowserProjectMeta,
} from './editor/persistence.js';
import { SettingsProvider } from './editor/useSettings.js';
import { AiConfigProvider } from './editor/useAiConfig.js';
import { Editor } from './components/Editor.js';
import { HomeScreen } from './components/HomeScreen.js';
import { Topbar, type SaveState } from './components/Topbar.js';
import { ShortcutHelp } from './components/ShortcutHelp.js';
import { SettingsDialog, type SettingsSection } from './components/SettingsDialog.js';
import { NewProjectDialog } from './components/NewProjectDialog.js';
import { CapabilityPackDependencyDialog } from './components/CapabilityPackDependencyDialog.js';

const log = createLogger('web-editor:app');

const isFilePath = (path: string): boolean => path !== '' && !path.startsWith(BROWSER_PATH_PREFIX);

export function App(): JSX.Element {
  const [boot] = useState(loadAppBootState);
  const [project, setProject] = useState<Project | null>(boot.project);
  const [path, setPath] = useState<string>(boot.path);
  const [projectRevision, setProjectRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [, setNewCount] = useState(1);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('display');
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [understandingOpen, setUnderstandingOpen] = useState(false);
  const [transcriptionOpen, setTranscriptionOpen] = useState(false);
  const [projectSyncNonce, setProjectSyncNonce] = useState(0);
  const [capabilityPacks, setCapabilityPacks] =
    useState<CapabilityPackProjectResolutionWire | null>(null);
  const [capabilityGateDismissed, setCapabilityGateDismissed] = useState(false);
  /**
   * The Topbar's centre box, handed to the Editor so the monitor's Source/Program
   * switch and view controls can render into it.
   *
   * State, not a ref: the Editor must RE-RENDER when the box appears, or its
   * portal has nowhere to go on the first paint. This is the whole coupling
   * between the two siblings — the monitor's state stays in `Editor`.
   */
  const [topbarMonitorSlot, setTopbarMonitorSlot] = useState<HTMLDivElement | null>(null);

  const firstRun = useRef(true);
  const suppressAutosave = useRef(false);
  const suppressFullAutosaveOnce = useRef(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectRevisionRef = useRef(projectRevision);
  projectRevisionRef.current = projectRevision;
  const manualCommitLane = useRef<Promise<void>>(Promise.resolve());
  const manualPending = useRef(0);
  const manualRebasedAuthority = useRef<PendingManualAuthority | null>(null);

  const persist = useCallback(async (): Promise<SaveOutcome> => {
    if (!project) return { ok: false, error: 'No project open.' };
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    setSaveState('saving');
    const outcome = await persistProject(path, project, { expectedRevision: projectRevision });
    if (outcome.ok) {
      if (outcome.path !== path) setPath(outcome.path);
      if (outcome.revision !== undefined) {
        projectRevisionRef.current = outcome.revision;
        setProjectRevision(outcome.revision);
      }
      setSaveState('saved');
      setSaveError(null);
    } else {
      setSaveState('error');
      setSaveError(outcome.error);
      log.warn('persist failed', outcome.error);
    }
    return outcome;
  }, [path, project, projectRevision]);

  const persistRef = useRef(persist);
  persistRef.current = persist;

  const queueManualPatchPersistence = useCallback(
    (projectId: string, patches: readonly Patch[]): boolean => {
      const bridge = getBridge();
      const commitProjectPatch = bridge?.commitProjectPatch;
      if (!commitProjectPatch || patches.length === 0) return false;

      manualPending.current += patches.length;
      setSaveState('saving');
      setSaveError(null);

      manualCommitLane.current = manualCommitLane.current
        .catch(() => undefined)
        .then(async () => {
          for (const patch of patches) {
            const expectedRevision = projectRevisionRef.current;
            const result = await commitProjectPatch({
              projectId,
              expectedRevision,
              patch,
            });
            if (!result.ok) {
              manualPending.current = 0;
              manualRebasedAuthority.current = null;
              setSaveState('error');
              setSaveError(result.error);
              log.warn('manual patch persistence failed', {
                projectId,
                patchId: patch.patchId,
                expectedRevision,
                error: result.error,
              });
              return;
            }

            projectRevisionRef.current = result.revision;
            setProjectRevision(result.revision);
            try {
              manualRebasedAuthority.current = manualAuthorityAfterCommit(
                projectId,
                manualRebasedAuthority.current,
                result,
              );
            } catch (error) {
              manualPending.current = 0;
              manualRebasedAuthority.current = null;
              const message = error instanceof Error ? error.message : String(error);
              setSaveState('error');
              setSaveError(message);
              log.warn('manual patch authority synchronization failed', {
                projectId,
                patchId: patch.patchId,
                revision: result.revision,
                error: message,
              });
              return;
            }
            manualPending.current = Math.max(0, manualPending.current - 1);
          }

          if (manualPending.current === 0) {
            const authoritative = manualRebasedAuthority.current;
            manualRebasedAuthority.current = null;
            if (authoritative) {
              suppressAutosave.current = true;
              setProject(ensureBaseTracks(authoritative.project));
              projectRevisionRef.current = authoritative.revision;
              setProjectRevision(authoritative.revision);
              setProjectSyncNonce((nonce) => nonce + 1);
              log.action('manual patch rebase synchronized', {
                projectId,
                revision: authoritative.revision,
              });
            }
            setSaveState('saved');
            setSaveError(null);
          }
        });
      return true;
    },
    [],
  );

  const handleEditorProjectChange = useCallback(
    (next: Project): void => {
      const previous = project;
      setProject(next);
      if (!previous || !isFilePath(path) || projectRevisionRef.current <= 0) return;

      const patches = manualPatchesForHistoryTransition(previous.history, next.history);
      if (patches.length === 0) return;
      if (queueManualPatchPersistence(next.id, patches)) {
        suppressFullAutosaveOnce.current = true;
      }
    },
    [path, project, queueManualPatchPersistence],
  );

  useEffect(() => {
    if (project === null) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (suppressAutosave.current) {
      suppressAutosave.current = false;
      // Never mask a save that is still running — a brand-new project is being
      // written to disk at exactly this point in its lifecycle.
      setSaveState((state) => (state === 'saving' ? state : 'saved'));
      return;
    }
    if (suppressFullAutosaveOnce.current) {
      suppressFullAutosaveOnce.current = false;
      return;
    }
    setSaveState('dirty');
    const timer = setTimeout(() => {
      void persistRef.current();
    }, AUTOSAVE_DEBOUNCE_MS);
    autosaveTimer.current = timer;
    return () => clearTimeout(timer);
  }, [project]);

  // P6.2: the decoded-frame and waveform bitmap caches are keyed by asset URL, so a
  // previous project's entries would sit in them until evicted by LRU pressure. Drop
  // them the moment a different project is open — the memory goes back immediately
  // and nothing from the old project can be served for the new one.
  const cachedProjectId = useRef<string | null>(null);
  useEffect(() => {
    const id = project?.id ?? null;
    if (cachedProjectId.current !== null && cachedProjectId.current !== id) {
      clearBitmapCache();
      clearWaveformBitmapCache();
    }
    cachedProjectId.current = id;
  }, [project?.id]);

  useEffect(() => {
    const unsubscribe = onProjectChanged(({ path: changedPath, project: next, revision }) => {
      suppressAutosave.current = true;
      setProject(ensureBaseTracks(next));
      setPath(changedPath);
      projectRevisionRef.current = revision ?? 0;
      setProjectRevision(revision ?? 0);
      setProjectSyncNonce((nonce) => nonce + 1);
      log.action('project updated externally', { path: changedPath, revision: revision ?? 0 });
    });
    return unsubscribe;
  }, []);

  /**
   * First save of a brand-new project.
   *
   * It cannot go through {@link persist}: that reads the project and path from
   * state this render has not committed yet, so the freshly created project is
   * passed down explicitly instead.
   */
  const persistCreated = useCallback(async (created: Project): Promise<void> => {
    setSaveState('saving');
    setSaveError(null);
    const outcome = await persistProject('', created, { expectedRevision: 0 });
    if (!outcome.ok) {
      setSaveState('error');
      setSaveError(outcome.error);
      log.warn('persisting the new project failed', outcome.error);
      return;
    }
    setPath(outcome.path);
    if (outcome.revision !== undefined) {
      projectRevisionRef.current = outcome.revision;
      setProjectRevision(outcome.revision);
    }
    setSaveState('saved');
    setSaveError(null);
    log.action('new project persisted', { projectId: created.id, path: outcome.path });
  }, []);

  /**
   * Create a project and persist it right away.
   *
   * WHY save immediately: autosave only runs on a *change*, so a project that
   * was named but not yet edited existed nowhere on disk (desktop) or in
   * localStorage (browser) — and therefore in no recent-projects list. It only
   * appeared after the first import or timeline edit, which read as the name
   * never having been saved.
   */
  const createNew = useCallback(
    (name: string) => {
      const created = newProject(name, { id: uniqueProjectId(name) });
      // The immediate save below stands in for the debounced autosave.
      suppressAutosave.current = true;
      setProject(created);
      setNewCount((n) => n + 1);
      setPath('');
      projectRevisionRef.current = 0;
      setProjectRevision(0);
      setCapabilityPacks(null);
      setCapabilityGateDismissed(false);
      log.action('project created', { name, projectId: created.id });
      void persistCreated(created);
    },
    [persistCreated],
  );

  const commitAuthoritativeProject = useCallback((next: Project, revision: number) => {
    setProject(ensureBaseTracks(next));
    projectRevisionRef.current = revision;
    setProjectRevision(revision);
    setProjectSyncNonce((nonce) => nonce + 1);
    log.action('authoritative project patch committed', { projectId: next.id, revision });
  }, []);

  const rename = useCallback(
    (name: string) => {
      if (!project) return;
      setProject({ ...project, name });
    },
    [project],
  );

  const open = useCallback(async () => {
    const result = await openViaDialog();
    if (result.ok) {
      suppressAutosave.current = true;
      setProject(ensureBaseTracks(result.project));
      setPath(result.path);
      projectRevisionRef.current = result.revision;
      setProjectRevision(result.revision);
      setCapabilityPacks(result.capabilityPacks ?? null);
      setCapabilityGateDismissed(false);
      log.action('project opened', { path: result.path });
    } else if (result.error !== 'cancelled') {
      log.warn('open failed', result.error);
    }
  }, []);

  const openRecent = useCallback(async (recentPath: string) => {
    if (recentPath.startsWith(BROWSER_PATH_PREFIX)) {
      const id = recentPath.slice(BROWSER_PATH_PREFIX.length);
      const loaded = loadBrowserProject(id);
      if (loaded) {
        suppressAutosave.current = true;
        setProject(ensureBaseTracks(loaded));
        setPath(recentPath);
        projectRevisionRef.current = 0;
        setProjectRevision(0);
        setCapabilityPacks(null);
        setCapabilityGateDismissed(false);
        writeBrowserProjectMeta(id, loaded.name);
        log.action('project opened', { path: recentPath });
      } else {
        log.warn('could not load recent project', recentPath);
      }
      return;
    }
    const result = await openProject(recentPath);
    if (result.ok) {
      suppressAutosave.current = true;
      setProject(ensureBaseTracks(result.project));
      setPath(result.path);
      projectRevisionRef.current = result.revision;
      setProjectRevision(result.revision);
      setCapabilityPacks(result.capabilityPacks ?? null);
      setCapabilityGateDismissed(false);
      log.action('project opened', { path: result.path });
    } else {
      log.warn('open failed', result.error);
    }
  }, []);

  const reveal = useCallback(async () => {
    const result = await revealProject(isFilePath(path) ? path : '');
    if (!result.ok) log.warn('reveal failed', result.error);
  }, [path]);

  const ensureSavedForExport = useCallback(async (): Promise<string | null> => {
    if (capabilityPacks?.renderBlocked === true) {
      log.warn('export blocked: required Capability Pack is unavailable');
      return null;
    }
    const outcome = await persist();
    if (!outcome.ok || !isFilePath(outcome.path)) return null;
    return outcome.path;
  }, [capabilityPacks?.renderBlocked, persist]);

  const revealPath = useCallback((target: string) => {
    void revealProject(target).then((result) => {
      if (!result.ok) log.warn('reveal failed', result.error);
    });
  }, []);

  const toggleHelp = useCallback(() => setHelpOpen((o) => !o), []);

  const goHome = useCallback(async () => {
    if (project && saveState !== 'saved') {
      const outcome = await persist();
      if (!outcome.ok) {
        log.warn('not leaving the editor: save failed', outcome.error);
        return;
      }
    }
    setProject(null);
    setPath('');
    projectRevisionRef.current = 0;
    setProjectRevision(0);
    setCapabilityPacks(null);
    setCapabilityGateDismissed(false);
  }, [project, saveState, persist]);

  return (
    <SettingsProvider>
      <AiConfigProvider>
        <div className="framepilot-shell">
          {project === null ? (
            <HomeScreen
              onNew={() => setNewProjectOpen(true)}
              onOpen={() => void open()}
              onOpenRecent={(p) => void openRecent(p)}
            />
          ) : (
            <>
              <Topbar
                projectName={project.name}
                path={path}
                saveState={saveState}
                saveErrorDetail={saveError ?? undefined}
                onHome={() => void goHome()}
                onNew={() => setNewProjectOpen(true)}
                onOpen={() => void open()}
                onSave={() => void persist()}
                onReveal={() => void reveal()}
                onRename={rename}
                ensureSavedForExport={ensureSavedForExport}
                onRevealExport={revealPath}
                assets={project.assets}
                exportFrame={{
                  width: project.resolution.width,
                  height: project.resolution.height,
                  fps: project.fps,
                }}
                exportDurationSeconds={project.timeline.tracks.reduce(
                  (max, track) => track.clips.reduce((m, clip) => Math.max(m, clip.end), max),
                  0,
                )}
                projectId={project.id}
                onOpenHistory={() => setHistoryOpen((v) => !v)}
                historyOpen={historyOpen}
                onOpenUnderstanding={() => {
                  setTranscriptionOpen(false);
                  setUnderstandingOpen((v) => !v);
                }}
                understandingOpen={understandingOpen}
                onOpenTranscription={() => {
                  setUnderstandingOpen(false);
                  setTranscriptionOpen((v) => !v);
                }}
                transcriptionOpen={transcriptionOpen}
                onOpenShortcuts={() => setHelpOpen(true)}
                onOpenSettings={() => {
                  setSettingsSection('display');
                  setSettingsOpen(true);
                }}
                onMonitorSlotRef={setTopbarMonitorSlot}
              />

              <Editor
                monitorHeaderSlot={topbarMonitorSlot}
                key={project.id}
                project={project}
                projectRevision={projectRevision}
                projectSyncNonce={projectSyncNonce}
                onProjectCommit={commitAuthoritativeProject}
                onProjectChange={handleEditorProjectChange}
                ensureSavedForTranscription={ensureSavedForExport}
                helpOpen={helpOpen}
                onToggleHelp={toggleHelp}
                historyOpen={historyOpen}
                onToggleHistory={() => setHistoryOpen((v) => !v)}
                onCloseHistory={() => setHistoryOpen(false)}
                understandingOpen={understandingOpen}
                onCloseUnderstanding={() => setUnderstandingOpen(false)}
                transcriptionOpen={transcriptionOpen}
                onCloseTranscription={() => setTranscriptionOpen(false)}
                onOpenSettings={(section) => {
                  setSettingsSection(section ?? 'display');
                  setSettingsOpen(true);
                }}
              />
            </>
          )}

          <NewProjectDialog
            open={newProjectOpen}
            onConfirm={createNew}
            onClose={() => setNewProjectOpen(false)}
          />
          <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
          <SettingsDialog
            open={settingsOpen}
            initialSection={settingsSection}
            onClose={() => setSettingsOpen(false)}
            {...(project ? { projectId: project.id } : {})}
          />
          {project !== null && !capabilityGateDismissed ? (
            <CapabilityPackDependencyDialog
              projectId={project.id}
              resolution={capabilityPacks}
              onResolutionChange={setCapabilityPacks}
              onOpenDegraded={() => setCapabilityGateDismissed(true)}
            />
          ) : null}
        </div>
      </AiConfigProvider>
    </SettingsProvider>
  );
}
