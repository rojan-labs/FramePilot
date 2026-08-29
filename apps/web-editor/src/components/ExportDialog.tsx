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
import { useViewPreference } from '../editor/useViewPreference.js';
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

/** The choices the dialog offers — the same vocabulary the engine's `ExportSettings` validates. */
export const RESOLUTIONS = ['480p', '720p', '1080p', '1440p', '2160p'] as const;
export const FRAME_RATES = ['source', 24, 25, 30, 50, 60] as const;
export const QUALITIES = ['low', 'recommended', 'high'] as const;
export const VIDEO_CODECS = ['h264', 'hevc'] as const;
export const CONTAINERS = ['mp4', 'mov'] as const;

const RESOLUTION_SHORT_EDGE: Record<(typeof RESOLUTIONS)[number], number> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2160p': 2160,
};
/** Mirrors the engine ladder (`export_settings.py`); the engine's number is authoritative. */
const BITRATE_LADDER_KBPS: Record<number, Record<(typeof QUALITIES)[number], number>> = {
  480: { low: 1_200, recommended: 2_500, high: 4_000 },
  720: { low: 2_500, recommended: 5_000, high: 7_500 },
  1080: { low: 4_500, recommended: 8_000, high: 12_000 },
  1440: { low: 9_000, recommended: 16_000, high: 24_000 },
  2160: { low: 20_000, recommended: 35_000, high: 45_000 },
};
const AUDIO_BITRATE_KBPS: Record<(typeof QUALITIES)[number], number> = {
  low: 128,
  recommended: 192,
  high: 256,
};

export interface DialogExportSettings {
  readonly resolution: (typeof RESOLUTIONS)[number];
  readonly fps: (typeof FRAME_RATES)[number];
  readonly quality: (typeof QUALITIES)[number];
  readonly bitrateKbps: number | null;
  readonly videoCodec: (typeof VIDEO_CODECS)[number];
  readonly container: (typeof CONTAINERS)[number];
}

function coerceExportSettings(raw: unknown): DialogExportSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const pick = <T extends string | number>(value: unknown, allowed: readonly T[]): T | undefined =>
    (allowed as readonly unknown[]).includes(value) ? (value as T) : undefined;
  const resolution = pick(r['resolution'], RESOLUTIONS);
  if (!resolution) return undefined;
  return {
    resolution,
    fps: pick(r['fps'], FRAME_RATES) ?? 'source',
    quality: pick(r['quality'], QUALITIES) ?? 'recommended',
    bitrateKbps:
      typeof r['bitrateKbps'] === 'number' && r['bitrateKbps'] > 0 ? r['bitrateKbps'] : null,
    videoCodec: pick(r['videoCodec'], VIDEO_CODECS) ?? 'h264',
    container: pick(r['container'], CONTAINERS) ?? 'mp4',
  };
}

export const DEFAULT_EXPORT_SETTINGS: DialogExportSettings = {
  resolution: '1080p',
  fps: 'source',
  quality: 'recommended',
  bitrateKbps: null,
  videoCodec: 'h264',
  container: 'mp4',
};

/** The frame the export will produce for `settings` in a project of this shape, source-capped. */
export function exportFrameFor(
  settings: DialogExportSettings,
  frame: { readonly width: number; readonly height: number; readonly fps: number },
  maxSourceShortEdge: number | null,
): { width: number; height: number; fps: number; capped: boolean } {
  const wanted = RESOLUTION_SHORT_EDGE[settings.resolution];
  const capped = maxSourceShortEdge !== null && wanted > maxSourceShortEdge;
  const short = capped ? maxSourceShortEdge : wanted;
  const aspect = frame.width / frame.height;
  const portrait = frame.width < frame.height;
  const width = portrait ? short : Math.round(short * aspect);
  const height = portrait ? Math.round(short / aspect) : short;
  const even = (n: number): number => Math.max(2, n - (n % 2));
  return {
    width: even(width),
    height: even(height),
    fps: settings.fps === 'source' ? frame.fps : settings.fps,
    capped,
  };
}

export function videoBitrateKbps(
  settings: DialogExportSettings,
  shortEdge: number,
  fps: number,
): number {
  if (settings.bitrateKbps) return settings.bitrateKbps;
  const rungs = Object.keys(BITRATE_LADDER_KBPS)
    .map(Number)
    .sort((a, b) => a - b);
  const rung = rungs.find((r) => r >= shortEdge) ?? rungs[rungs.length - 1]!;
  const base = BITRATE_LADDER_KBPS[rung]![settings.quality];
  const factor = (settings.videoCodec === 'hevc' ? 0.65 : 1) * (fps > 30 ? 1.5 : 1);
  return Math.round(base * factor);
}

export function estimateExportBytes(
  settings: DialogExportSettings,
  frame: { readonly width: number; readonly height: number; readonly fps: number },
  maxSourceShortEdge: number | null,
  durationSeconds: number,
): number {
  const target = exportFrameFor(settings, frame, maxSourceShortEdge);
  const kbps =
    videoBitrateKbps(settings, Math.min(target.width, target.height), target.fps) +
    AUDIO_BITRATE_KBPS[settings.quality];
  return Math.round(((kbps * 1000) / 8) * Math.max(0, durationSeconds));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** Largest short edge among the project's picture assets — the export's resolution cap. */
export function maxSourceShortEdge(assets: readonly Asset[]): number | null {
  const edges = assets
    .filter((a) => a.kind !== 'audio')
    .map((a) => (a.media?.width && a.media?.height ? Math.min(a.media.width, a.media.height) : 0))
    .filter((n) => n > 0);
  return edges.length ? Math.max(...edges) : null;
}

/** One line under the choices: what file you actually get. */
export function settingsSummary(
  settings: DialogExportSettings,
  frame: { readonly width: number; readonly height: number; readonly fps: number },
  maxSourceShortEdge: number | null,
  durationSeconds: number,
): string {
  const target = exportFrameFor(settings, frame, maxSourceShortEdge);
  const codec = settings.videoCodec === 'hevc' ? 'HEVC (H.265)' : 'H.264';
  const size = formatBytes(
    estimateExportBytes(settings, frame, maxSourceShortEdge, durationSeconds),
  );
  const fps = Number.isInteger(target.fps) ? String(target.fps) : target.fps.toFixed(2);
  return `${target.width} × ${target.height} · ${fps} fps · ${settings.container.toUpperCase()} (${codec}) · about ${size}`;
}

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
  /** The project's frame; the export follows this aspect ratio. */
  readonly frame: { readonly width: number; readonly height: number; readonly fps: number };
  /** Programme length, for the size estimate. */
  readonly durationSeconds: number;
  /** Persists the last-used settings per project. */
  readonly projectId?: string;
}

type Phase =
  | { kind: 'idle' }
  /** The export was submitted; the sidecar has accepted the job but it hasn't started running yet. */
  | { kind: 'queued' }
  /** The sidecar is actively rendering. */
  | { kind: 'running'; stage?: string; progress?: number }
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
/** Plain words for the engine's render stages (P7.6). */
function stageLabel(stage: string | undefined): string {
  switch (stage) {
    case 'preparing_assets':
      return 'Preparing media…';
    case 'rendering_frames':
    case 'encoding':
      return 'Rendering…';
    case 'validating_output':
      return 'Checking the file…';
    default:
      return 'Rendering…';
  }
}

function suggestedFileName(outputPath: string): string {
  return outputPath.split(/[/\\]/).pop() || 'export.mp4';
}

/** One finished export, remembered per project (P7.6): where it went and what it was. */
export interface ExportHistoryEntry {
  readonly at: string;
  readonly path: string;
  readonly label: string;
}
const EXPORT_HISTORY_LIMIT = 10;

export function coerceExportHistory(raw: unknown): ExportHistoryEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries = raw.filter(
    (e): e is ExportHistoryEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as ExportHistoryEntry).at === 'string' &&
      typeof (e as ExportHistoryEntry).path === 'string' &&
      typeof (e as ExportHistoryEntry).label === 'string',
  );
  return entries.slice(0, EXPORT_HISTORY_LIMIT);
}

/**
 * Time left, from the progress the engine actually reported — never a fabricated bar
 * (this project's no-fake-progress invariant). Measured from the first sample after
 * the run settled in (the preparing stage is not representative), and only once enough
 * progress has accrued for the rate to mean something.
 */
export function estimateSecondsLeft(
  first: { readonly at: number; readonly progress: number },
  now: { readonly at: number; readonly progress: number },
): number | undefined {
  const advanced = now.progress - first.progress;
  const elapsed = now.at - first.at;
  if (advanced < 0.05 || elapsed <= 0 || now.progress >= 1) return undefined;
  return (elapsed / 1000) * ((1 - now.progress) / advanced);
}

function formatSecondsLeft(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  if (whole < 60) return `about ${String(whole)}s left`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0
    ? `about ${String(minutes)}m left`
    : `about ${String(minutes)}m ${String(rest)}s left`;
}

export function ExportDialog({
  ensureSaved,
  onReveal,
  assets,
  frame,
  durationSeconds,
  projectId,
}: ExportDialogProps): JSX.Element {
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

  const [settings, setSettings] = useViewPreference<DialogExportSettings>(
    `export.settings.${projectId ?? 'default'}`,
    DEFAULT_EXPORT_SETTINGS,
    coerceExportSettings,
  );
  const sourceCap = maxSourceShortEdge(assets);
  const patchSettings = (patch: Partial<DialogExportSettings>): void =>
    setSettings((current) => ({ ...current, ...patch }));
  const [burnCaptions, setBurnCaptions] = useState(false);
  const [loudness, setLoudness] = useState<string>('');
  const [denoise, setDenoise] = useState(false);
  const [limiter, setLimiter] = useState(false);
  const [eq, setEq] = useState<string>('');
  const [compression, setCompression] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [history, setHistory] = useViewPreference<ExportHistoryEntry[]>(
    `export.history.${projectId ?? 'default'}`,
    [],
    coerceExportHistory,
  );
  // ETA (P7.6): the first representative progress sample of this run, and the latest.
  const etaFirst = useRef<{ at: number; progress: number } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | undefined>(undefined);

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
        const path = savedPath ?? result.outputPath;
        setHistory((current) =>
          [
            {
              at: new Date().toISOString(),
              path,
              label: `${settings.resolution} · ${settings.container.toUpperCase()}`,
            },
            ...current.filter((entry) => entry.path !== path),
          ].slice(0, EXPORT_HISTORY_LIMIT),
        );
      })();
    },
    [promptSaveAs, setHistory, settings.container, settings.resolution],
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
      else if (message.status === 'running') {
        setPhase({
          kind: 'running',
          ...(message.stage !== undefined ? { stage: message.stage } : {}),
          ...(message.progress !== undefined ? { progress: message.progress } : {}),
        });
        if (message.progress !== undefined && message.stage !== 'preparing_assets') {
          const sample = { at: Date.now(), progress: message.progress };
          if (etaFirst.current === null) etaFirst.current = sample;
          setSecondsLeft(estimateSecondsLeft(etaFirst.current, sample));
        }
      }
      // A terminal status (completed/failed/cancelled) always arrives with
      // `result` set (handled above); 'cancelling' is a purely local phase set
      // immediately when the user clicks Cancel, not something the sidecar reports.
    },
    [finish],
  );

  useEffect(() => onExportProgress(handleMessage), [handleMessage]);

  const run = useCallback(async () => {
    etaFirst.current = null;
    setSecondsLeft(undefined);
    setPhase({ kind: 'queued' });
    const projectPath = await ensureSaved();
    if (!projectPath) {
      setPhase({ kind: 'error', message: 'Could not save the project before exporting.' });
      return;
    }
    const requestId = await exportVideoStart({
      projectPath,
      settings: {
        resolution: settings.resolution,
        fps: settings.fps,
        quality: settings.quality,
        ...(settings.bitrateKbps ? { bitrateKbps: settings.bitrateKbps } : {}),
        videoCodec: settings.videoCodec,
        container: settings.container,
      },
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
    settings,
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

  // How many audio processors are engaged. The Audio section is collapsed by
  // default — most exports never touch it — so its summary has to say what is
  // hidden underneath, or collapsing it would just hide state the user set.
  const audioCount =
    (loudness ? 1 : 0) +
    (eq ? 1 : 0) +
    (denoise ? 1 : 0) +
    (limiter ? 1 : 0) +
    (compression ? 1 : 0);

  /**
   * The one live status line, rendered in the footer beside the buttons.
   *
   * It used to sit at the bottom of the scrolling options list, which put the
   * answer to "is it still going?" below the fold on any project with credits.
   * Exactly one element carries `role="status"`/`role="alert"` at a time, so a
   * screen reader gets one announcement per transition, not a queue of them.
   */
  const status: JSX.Element | null =
    phase.kind === 'queued' ? (
      <p className="export-status" role="status">
        Queued — waiting for the render engine…
      </p>
    ) : phase.kind === 'running' ? (
      <p className="export-status" role="status">
        {phase.progress !== undefined
          ? `${stageLabel(phase.stage)} ${Math.round(phase.progress * 100)}%${
              secondsLeft !== undefined ? ` · ${formatSecondsLeft(secondsLeft)}` : ''
            }`
          : 'Rendering and validating the output…'}
      </p>
    ) : phase.kind === 'cancelling' ? (
      <p className="export-status" role="status">
        Cancelling…
      </p>
    ) : phase.kind === 'done' ? (
      phase.savedPath ? (
        <p className="export-status export-status--ok" role="status">
          Saved to <code>{phase.savedPath}</code>.
        </p>
      ) : (
        <p className="export-status export-status--ok" role="status">
          Exported. Choose &ldquo;Save As&hellip;&rdquo; to save the video.
        </p>
      )
    ) : phase.kind === 'error' ? (
      <p className="export-status export-status--error" role="alert">
        {phase.message}
      </p>
    ) : null;

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
              <X size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </header>

          {/* The ONLY scrolling region. The footer below is a sibling, not a
              child, so the Export button is reachable at any body length —
              a project with a long credits list used to push it off-screen. */}
          <div className="export-body">
            {!desktop && (
              <p className="export-note" role="note">
                Export renders through the FramePilot engine, which is only available in the desktop
                app. Open this project in FramePilot desktop to export a video.
              </p>
            )}

            <section className="export-section">
              <h3 className="export-section-head">Format</h3>
              <div className="export-field">
                <span>Resolution</span>
                <Select
                  label="Resolution"
                  value={settings.resolution}
                  disabled={exporting}
                  onChange={(value) =>
                    patchSettings({ resolution: value as DialogExportSettings['resolution'] })
                  }
                  options={RESOLUTIONS.map((r) => ({
                    value: r,
                    label:
                      sourceCap !== null && RESOLUTION_SHORT_EDGE[r] > sourceCap
                        ? `${r} (upscaled — sources are ${sourceCap}p)`
                        : r === '1440p'
                          ? '1440p (2K)'
                          : r === '2160p'
                            ? '2160p (4K)'
                            : r,
                  }))}
                />
              </div>
              <div className="export-field">
                <span>Frame rate</span>
                <Select
                  label="Frame rate"
                  value={String(settings.fps)}
                  disabled={exporting}
                  onChange={(value) =>
                    patchSettings({
                      fps: (value === 'source'
                        ? 'source'
                        : Number(value)) as DialogExportSettings['fps'],
                    })
                  }
                  options={FRAME_RATES.map((f) => ({
                    value: String(f),
                    label: f === 'source' ? `Project (${frame.fps} fps)` : `${f} fps`,
                  }))}
                />
              </div>
              <div className="export-field">
                <span>Quality</span>
                <Select
                  label="Quality"
                  value={settings.quality}
                  disabled={exporting}
                  onChange={(value) =>
                    patchSettings({
                      quality: value as DialogExportSettings['quality'],
                      bitrateKbps: null,
                    })
                  }
                  options={QUALITIES.map((q) => ({
                    value: q,
                    label: q === 'recommended' ? 'Recommended' : q === 'high' ? 'High' : 'Low',
                  }))}
                />
              </div>
              <div className="export-field">
                <span>Codec</span>
                <Select
                  label="Codec"
                  value={settings.videoCodec}
                  disabled={exporting}
                  onChange={(value) =>
                    patchSettings({ videoCodec: value as DialogExportSettings['videoCodec'] })
                  }
                  options={[
                    { value: 'h264', label: 'H.264 (plays everywhere)' },
                    { value: 'hevc', label: 'HEVC / H.265 (smaller files)' },
                  ]}
                />
              </div>
              <div className="export-field">
                <span>Format</span>
                <Select
                  label="Format"
                  value={settings.container}
                  disabled={exporting}
                  onChange={(value) =>
                    patchSettings({ container: value as DialogExportSettings['container'] })
                  }
                  options={[
                    { value: 'mp4', label: 'MP4' },
                    { value: 'mov', label: 'MOV' },
                  ]}
                />
              </div>
              <p className="export-field-hint" data-testid="export-summary">
                {settingsSummary(settings, frame, sourceCap, durationSeconds)}
              </p>
              {exportFrameFor(settings, frame, sourceCap).capped ? (
                <p className="export-field-hint export-field-hint--warn">
                  Your sources are {sourceCap}p, so the export is capped there instead of being
                  upscaled.
                </p>
              ) : null}

              <Checkbox checked={burnCaptions} disabled={exporting} onChange={setBurnCaptions}>
                Burn captions into the video
              </Checkbox>
            </section>

            {/* Collapsed by default: five audio controls that most exports leave
                alone were, open, the bulk of this popover's height. */}
            <details className="export-section export-disclosure">
              <summary>
                <span className="export-section-head">Audio</span>
                <span className="export-disclosure-meta">
                  {audioCount === 0
                    ? 'Unprocessed'
                    : `${audioCount} ${audioCount === 1 ? 'filter' : 'filters'} on`}
                </span>
              </summary>
              <div className="export-disclosure-body">
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

                <Checkbox
                  ariaLabel="Apply voice compression"
                  checked={compression}
                  disabled={exporting}
                  onChange={setCompression}
                >
                  Even out volume (voice compression)
                </Checkbox>
              </div>
            </details>

            <CreditsSection assets={assets} />
          </div>

          {history.length > 0 && (
            <section className="export-section export-history" aria-label="Recent exports">
              <h3 className="export-section-head">Recent exports</h3>
              <ul className="export-history-list">
                {history.map((entry) => {
                  const name = suggestedFileName(entry.path);
                  return (
                    <li key={`${entry.at}:${entry.path}`} className="export-history-row">
                      <span className="export-history-name" title={entry.path}>
                        {name}
                      </span>
                      <span className="export-history-meta">
                        {entry.label} · {new Date(entry.at).toLocaleString()}
                      </span>
                      <Button
                        variant="ghost"
                        type="button"
                        aria-label={`Reveal ${name} in folder`}
                        onClick={() => onReveal(entry.path)}
                      >
                        Reveal
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {/* Pinned. Carries the live status too, so progress is legible without
              scrolling back down through the options. */}
          <footer className="export-foot">
            {status}
            <div className="export-foot-actions">
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
            </div>
          </footer>
        </div>
      )}
    </div>
  );
}
