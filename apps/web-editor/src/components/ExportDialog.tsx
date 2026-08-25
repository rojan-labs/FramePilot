/**
 * Export dropdown (plan/PLAN.md Phase 8 — renderer→engine export; async progress
 * H1.3b). Presentation note: this owns its own trigger (the topbar Export
 * button) and renders as an anchored popover, not a centered modal — a project-
 * level action gets a quick dropdown, not a full-screen interruption.
 *
 * Lets the user pick an export preset + caption burn-in, then runs the export
 * through the desktop bridge → Python sidecar (the render engine never runs in
 * the renderer; AGENTS.md render-vs-preview rule). Rendering needs the saved
 * project on disk, so {@link App} saves first and passes the resulting path in.
 *
 * The sidecar's `/render` route is asynchronous (submit + poll, H1.3a/ADR 0050),
 * so this dialog starts the export via `exportVideoStart` and watches live
 * `queued` → `running` → terminal progress pushes instead of awaiting one
 * blocking promise. There is no numeric percentage anywhere in that contract
 * (the sidecar's `RenderTask`/`RenderJob` carry only a coarse status, not a
 * live 0–100 figure) — so the UI shows the real status transitions rather than
 * fabricating a progress bar (this project's no-fake-progress invariant).
 *
 * In a plain browser there is no engine, so the dialog explains that export is a
 * desktop-only capability instead of failing opaquely.
 *
 * The popover's own React state (phase/activeRequestId/inbox) lives in this
 * component, which stays mounted in the topbar regardless of whether the
 * popover is open — closing it (outside click / Escape) never loses an
 * in-progress export; reopening the dropdown shows it mid-flight.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset } from '@framepilot/timeline-schema';
import { Button } from '@framepilot/ui';
import {
  type ExportProgressMessage,
  type ExportResult,
  exportSaveAs,
  exportVideoCancel,
  exportVideoStart,
  isDesktop,
  onExportProgress,
} from '../editor/bridge.js';
import { Checkbox } from './Checkbox.js';
import { CreditsSection } from './CreditsSection.js';
import { Select } from './Select.js';
import { Tooltip } from './Tooltip.js';
import { Download, ICON_SIZE, X } from './icons.js';

/** Loudness normalization targets (mirrors the engine's audio presets). */
const LOUDNESS_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'social', label: 'Social (-14 LUFS)' },
  { value: 'podcast', label: 'Podcast (-16 LUFS)' },
  { value: 'broadcast', label: 'Broadcast (-23 LUFS)' },
] as const;

/** Master-bus EQ presets (mirrors the engine's `EQ_PRESETS`, plan H1.4). */
const EQ_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'flat', label: 'Flat (no change)' },
  { value: 'warm', label: 'Warm' },
  { value: 'bright', label: 'Bright' },
  { value: 'voice-clarity', label: 'Voice clarity' },
] as const;

/**
 * Export presets — mirrored from the engine's `render/presets.py` `EXPORT_PRESETS`
 * (a hand-synced copy, same as before H1.3b; see that module's docstring for why
 * each carries a recommended, not enforced, loudness default). Keep this list's
 * ids in sync with the engine's when either changes: an id here that the engine
 * doesn't recognise doesn't fail loudly, it just falls back to the engine's
 * default preset (Reels) — a drift risk worth re-checking by hand for now, since
 * introducing shared build tooling across the TS/Python boundary for five
 * string/dimension pairs isn't worth the complexity yet.
 */
export const EXPORT_PRESETS: readonly { id: string; label: string }[] = [
  { id: 'reels', label: 'Instagram Reels (9:16)' },
  { id: 'tiktok', label: 'TikTok (9:16)' },
  { id: 'shorts', label: 'YouTube Shorts (9:16)' },
  { id: 'youtube', label: 'YouTube (16:9)' },
  { id: 'square', label: 'Square (1:1)' },
];

export interface ExportDialogProps {
  /**
   * Ensure the project is saved to disk and return its path (autosave handles a
   * path-less project). `null` means saving failed or is unavailable.
   */
  readonly ensureSaved: () => Promise<string | null>;
  /** Reveal the exported file in the OS file manager. */
  readonly onReveal: (path: string) => void;
  /**
   * The project's media bin, for the Credits list. Export is where a licence
   * obligation stops being theoretical, so it is where the credits are shown
   * (schema v20, ADR 0138).
   */
  readonly assets: readonly Asset[];
}

type Phase =
  | { kind: 'idle' }
  /** The export was submitted; the sidecar has accepted the job but it hasn't started running yet. */
  | { kind: 'queued' }
  /** The sidecar is actively rendering. */
  | { kind: 'running' }
  /** The user asked to cancel; waiting for the sidecar to confirm. */
  | { kind: 'cancelling' }
  /**
   * `outputPath` is the sandboxed render (`exports/<id>.<ext>`); `savedPath` is
   * where the user chose to save it via the "Save As" dialog, or `null` if they
   * dismissed that dialog (the render is still safe in `outputPath`).
   */
  | { kind: 'done'; outputPath: string; savedPath: string | null }
  | { kind: 'error'; message: string };

/** The dialog's own file name suggestion — the last path segment of `outputPath`. */
function suggestedFileName(outputPath: string): string {
  return outputPath.split(/[/\\]/).pop() || 'export.mp4';
}

export function ExportDialog({ ensureSaved, onReveal, assets }: ExportDialogProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const onClose = useCallback(() => setOpen(false), []);

  // Dismiss on an outside press or Escape while open (mirrors Menu.tsx).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const [preset, setPreset] = useState<string>(EXPORT_PRESETS[0]!.id);
  const [burnCaptions, setBurnCaptions] = useState(false);
  const [loudness, setLoudness] = useState<string>('');
  const [denoise, setDenoise] = useState(false);
  const [limiter, setLimiter] = useState(false);
  const [eq, setEq] = useState<string>('');
  const [compression, setCompression] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // Export progress arrives as main→renderer pushes scoped by requestId (H1.3b).
  // Subscribe once, up front, and buffer/replay by id — mirroring the desktop AI
  // stream's subscribe-before-start pattern (editor/ai.ts's DesktopAiSession) so a
  // push that races ahead of `exportVideoStart`'s resolution is never dropped.
  const activeRequestId = useRef<string | null>(null);
  const inbox = useRef<ExportProgressMessage[]>([]);

  // Ask where to save the finished render; `null` means the user dismissed the
  // dialog (the render stays put in the sandboxed exports folder either way).
  const promptSaveAs = useCallback(async (outputPath: string): Promise<string | null> => {
    const result = await exportSaveAs({
      sourcePath: outputPath,
      suggestedName: suggestedFileName(outputPath),
    });
    return result.ok ? result.path : null;
  }, []);

  const finish = useCallback(
    (result: ExportResult) => {
      activeRequestId.current = null;
      if (!result.ok) {
        setPhase({ kind: 'error', message: result.error });
        return;
      }
      void (async () => {
        const savedPath = await promptSaveAs(result.outputPath);
        setPhase({ kind: 'done', outputPath: result.outputPath, savedPath });
      })();
    },
    [promptSaveAs],
  );

  const handleMessage = useCallback(
    (message: ExportProgressMessage) => {
      if (message.requestId !== activeRequestId.current) {
        // Not (yet) ours — buffer it in case it raced ahead of `run()` learning
        // its own requestId; `run()` replays anything matching once it knows.
        inbox.current.push(message);
        return;
      }
      if (message.result) {
        finish(message.result);
        return;
      }
      if (message.status === 'queued') setPhase({ kind: 'queued' });
      else if (message.status === 'running') setPhase({ kind: 'running' });
      // A terminal status (completed/failed/cancelled) always arrives with
      // `result` set (handled above); 'cancelling' is a purely local phase set
      // immediately when the user clicks Cancel, not something the sidecar reports.
    },
    [finish],
  );

  useEffect(() => onExportProgress(handleMessage), [handleMessage]);

  const run = useCallback(async () => {
    setPhase({ kind: 'queued' });
    const projectPath = await ensureSaved();
    if (!projectPath) {
      setPhase({ kind: 'error', message: 'Could not save the project before exporting.' });
      return;
    }
    const requestId = await exportVideoStart({
      projectPath,
      preset,
      burnCaptions,
      denoise,
      limiter,
      ...(loudness ? { loudness } : {}),
      ...(eq ? { eq } : {}),
      ...(compression ? { compression: 'voice' } : {}),
    });
    if (!requestId) {
      setPhase({
        kind: 'error',
        message: 'Export requires the FramePilot desktop app (the render engine runs there).',
      });
      return;
    }
    activeRequestId.current = requestId;
    // Replay any progress for this id that arrived before we learned it.
    const buffered = inbox.current.filter((message) => message.requestId === requestId);
    inbox.current = inbox.current.filter((message) => message.requestId !== requestId);
    for (const message of buffered) handleMessage(message);
  }, [
    ensureSaved,
    preset,
    burnCaptions,
    denoise,
    limiter,
    loudness,
    eq,
    compression,
    handleMessage,
  ]);

  const cancelExport = useCallback(() => {
    if (!activeRequestId.current) return;
    setPhase({ kind: 'cancelling' });
    exportVideoCancel(activeRequestId.current);
  }, []);

  const retrySaveAs = useCallback(async () => {
    if (phase.kind !== 'done') return;
    const savedPath = await promptSaveAs(phase.outputPath);
    if (savedPath) {
      setPhase({ kind: 'done', outputPath: phase.outputPath, savedPath });
    }
  }, [phase, promptSaveAs]);

  const exporting =
    phase.kind === 'queued' || phase.kind === 'running' || phase.kind === 'cancelling';
  const desktop = isDesktop();

  return (
    <div className="export-menu" ref={rootRef}>
      {/* Placed BELOW its trigger: this control lives in the topbar, where a
          top-placed bubble would be clipped by the window edge (H12-followup). */}
      <Tooltip label="Export video" placement="bottom">
        <Button
          variant="primary"
          className="export-btn"
          type="button"
          aria-label="Export video"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Download size={ICON_SIZE.sm} aria-hidden="true" />
          <span className="export-btn-label">Export</span>
        </Button>
      </Tooltip>
      {open && (
        <div className="export-popover" role="dialog" aria-label="Export video">
          <header className="settings-head">
            <h2>Export video</h2>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close"
              title="Close (Esc)"
              onClick={onClose}
            >
              <X size={ICON_SIZE.md} aria-hidden="true" />
            </button>
          </header>

          <div className="export-body">
            {!desktop && (
              <p className="export-note" role="note">
                Export renders through the FramePilot engine, which is only available in the desktop
                app. Open this project in FramePilot desktop to export a video.
              </p>
            )}

            <div className="export-field">
              <span>Preset</span>
              <Select
                label="Export preset"
                value={preset}
                disabled={exporting}
                onChange={setPreset}
                options={EXPORT_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
              />
            </div>

            <Checkbox checked={burnCaptions} disabled={exporting} onChange={setBurnCaptions}>
              Burn captions into the video
            </Checkbox>

            <div className="export-field">
              <span>Loudness</span>
              <Select
                label="Loudness preset"
                value={loudness}
                disabled={exporting}
                onChange={setLoudness}
                options={LOUDNESS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </div>

            <Checkbox
              ariaLabel="Reduce background noise"
              checked={denoise}
              disabled={exporting}
              onChange={setDenoise}
            >
              Reduce background noise
            </Checkbox>

            <Checkbox
              ariaLabel="Apply limiter"
              checked={limiter}
              disabled={exporting}
              onChange={setLimiter}
            >
              Apply brick-wall limiter
            </Checkbox>

            <div className="export-field">
              <span>EQ</span>
              <Select
                label="EQ preset"
                value={eq}
                disabled={exporting}
                onChange={setEq}
                options={EQ_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </div>

            <Checkbox
              ariaLabel="Apply voice compression"
              checked={compression}
              disabled={exporting}
              onChange={setCompression}
            >
              Even out volume (voice compression)
            </Checkbox>

            <CreditsSection assets={assets} />

            {phase.kind === 'queued' && (
              <p className="export-status" role="status">
                Queued — waiting for the render engine to pick this up…
              </p>
            )}
            {phase.kind === 'running' && (
              <p className="export-status" role="status">
                Rendering… this runs the deterministic engine and validates the output.
              </p>
            )}
            {phase.kind === 'cancelling' && (
              <p className="export-status" role="status">
                Cancelling…
              </p>
            )}
            {phase.kind === 'done' &&
              (phase.savedPath ? (
                <p className="export-status export-status--ok" role="status">
                  Saved to <code>{phase.savedPath}</code>.
                </p>
              ) : (
                <p className="export-status export-status--ok" role="status">
                  Exported. Choose &ldquo;Save As&hellip;&rdquo; to save the video.
                </p>
              ))}
            {phase.kind === 'error' && (
              <p className="export-status export-status--error" role="alert">
                {phase.message}
              </p>
            )}
          </div>

          <footer className="export-foot">
            {phase.kind === 'done' ? (
              <>
                {!phase.savedPath && (
                  <Button variant="ghost" type="button" onClick={() => void retrySaveAs()}>
                    Save As…
                  </Button>
                )}
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => onReveal(phase.savedPath ?? phase.outputPath)}
                >
                  Reveal in folder
                </Button>
                <Button variant="primary" type="button" onClick={onClose}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" type="button" onClick={onClose}>
                  Close
                </Button>
                {exporting && (
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={cancelExport}
                    disabled={phase.kind === 'cancelling'}
                  >
                    Cancel export
                  </Button>
                )}
                <Button
                  variant="primary"
                  type="button"
                  onClick={() => void run()}
                  disabled={exporting || !desktop}
                >
                  {phase.kind === 'queued' && 'Queued…'}
                  {phase.kind === 'running' && 'Exporting…'}
                  {phase.kind === 'cancelling' && 'Cancelling…'}
                  {phase.kind !== 'queued' &&
                    phase.kind !== 'running' &&
                    phase.kind !== 'cancelling' &&
                    'Export'}
                </Button>
              </>
            )}
          </footer>
        </div>
      )}
    </div>
  );
}
