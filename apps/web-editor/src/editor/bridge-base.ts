/**
 * Renderer-side access to the Electron desktop bridge (`window.framepilot`),
 * plus project open/save helpers that validate against the Zod schema
 * (plan/PLAN.md Phase 3.2 — "Wire renderer project create/import to the desktop
 * bridge").
 *
 * The bridge is **optional**: the same renderer also runs in a plain browser
 * (Vite dev server, tests, the eventual web build) where `window.framepilot` is
 * absent. Every helper therefore degrades gracefully instead of throwing, and
 * accepts an injected bridge so the logic is testable without Electron.
 *
 * The bridge shape is the canonical IPC contract, defined once in
 * `@framepilot/shared-types` (`FramePilotBridge`) and consumed by BOTH the desktop
 * preload (which implements it) and this renderer (which calls it). The two apps
 * are independent deployables and never import each other, but they share this
 * package, so a drift between the implemented and consumed shape now fails to
 * compile — replacing the former hand-maintained copy (plan Phase 8, ADR 0023).
 */
import { type Project, safeParseProject } from '@framepilot/timeline-schema';
import type {
  FramePilotBridge,
  ProjectChangedEvent,
  ProjectSaveResult,
  ExportRequest,
  ExportResult,
  ExportProgressMessage,
  ExportSaveAsRequest,
  ExportSaveAsResult,
  MediaImportRequest,
  MediaImportResult,
  ImportAssetRequest,
  ImportAssetResult,
  TranscriptionRequest,
  TranscriptionResult,
  RevealResult,
  CapabilityPackProjectResolutionWire,
  MusicSearchResult,
  MusicPreviewResult,
  MusicDownloadRequest,
  MusicDownloadResult,
  MusicDownloadProgressWire,
  StockSearchRequest,
  StockSearchResult,
  StockBytesResult,
  StockDownloadRequest,
  StockDownloadResult,
  StockDownloadProgressWire,
  StockQuotaSnapshot,
} from '@framepilot/shared-types';

// Re-exported for renderer call-sites and tests that referenced these names.
export type {
  ExportRequest,
  ExportResult,
  ExportProgressMessage,
  ExportSaveAsRequest,
  ExportSaveAsResult,
  MediaImportRequest,
  MediaImportResult,
  ImportAssetRequest,
  ImportAssetResult,
  TranscriptionRequest,
  TranscriptionResult,
  RecentProject,
  RevealResult,
  SidecarStatus,
  MusicSearchResult,
  MusicPreviewResult,
  MusicDownloadRequest,
  MusicDownloadResult,
  MusicTrackWire,
  MusicErrorCodeWire,
  MusicDownloadProgressWire,
  StockItemWire,
  StockVariantWire,
  StockMediaKindWire,
  StockOrientationWire,
  StockErrorCodeWire,
  StockDownloadProgressWire,
  StockQuotaSnapshot,
  StockQuotaObservationWire,
} from '@framepilot/shared-types';

/**
 * The bridge contract as seen by the renderer. Identical to the desktop
 * `FramePilotBridge` (the renderer uses the whole surface); aliased so existing
 * renderer code and tests keep the `RendererBridge` name.
 */
export type RendererBridge = FramePilotBridge;

declare global {
  interface Window {
    framepilot?: RendererBridge;
  }
}

/** The desktop bridge if running inside Electron, else `null` (browser/test). */
export function getBridge(): RendererBridge | null {
  return typeof window !== 'undefined' && window.framepilot ? window.framepilot : null;
}

/** True when the desktop bridge is available (i.e. running in the Electron shell). */
export const isDesktop = (): boolean => getBridge() !== null;

/** A schema-validated open result the editor can load directly. */
export type OpenProjectResult =
  | {
      ok: true;
      path: string;
      project: Project;
      revision: number;
      capabilityPacks?: CapabilityPackProjectResolutionWire;
    }
  | { ok: false; error: string };

/**
 * Open and validate a project through the desktop bridge.
 *
 * Two failure modes are collapsed into `{ ok: false }`: the bridge being absent
 * (browser mode) and the file failing schema validation. A project that does not
 * match the schema is **never** coerced into the editor (AGENTS.md invariant 3).
 *
 * @param path - Absolute path to the `project.fp.json`.
 * @param bridge - Bridge to use; defaults to {@link getBridge}. Injected in tests.
 */
export async function openProject(
  path: string,
  bridge: RendererBridge | null = getBridge(),
): Promise<OpenProjectResult> {
  if (!bridge) {
    return { ok: false, error: 'Desktop bridge unavailable (running outside Electron).' };
  }
  const result = await bridge.openProject(path);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const parsed = safeParseProject(result.project);
  if (!parsed.success) {
    return { ok: false, error: `Project failed validation: ${parsed.error.message}` };
  }
  return {
    ok: true,
    path: result.path,
    project: parsed.data,
    revision: result.revision ?? 0,
    ...(result.capabilityPacks === undefined ? {} : { capabilityPacks: result.capabilityPacks }),
  };
}

/**
 * Show a native OS file picker and open the selected project.
 * Returns `{ ok: false, error: 'cancelled' }` when the user dismisses the dialog.
 */
export async function openProjectDialog(
  bridge: RendererBridge | null = getBridge(),
): Promise<OpenProjectResult> {
  if (!bridge) {
    return { ok: false, error: 'Desktop bridge unavailable (running outside Electron).' };
  }
  const result = await bridge.openProjectDialog();
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const parsed = safeParseProject(result.project);
  if (!parsed.success) {
    return { ok: false, error: `Project failed validation: ${parsed.error.message}` };
  }
  return {
    ok: true,
    path: result.path,
    project: parsed.data,
    revision: result.revision ?? 0,
    ...(result.capabilityPacks === undefined ? {} : { capabilityPacks: result.capabilityPacks }),
  };
}

/**
 * Save a project through the desktop bridge. Returns `{ ok: false }` (rather than
 * throwing) when the bridge is absent so the UI can surface "save unavailable".
 */
export async function saveProject(
  path: string,
  project: Project,
  bridge: RendererBridge | null = getBridge(),
  expectedRevision?: number,
): Promise<ProjectSaveResult> {
  if (!bridge) {
    return { ok: false, error: 'Desktop bridge unavailable (running outside Electron).' };
  }
  return bridge.saveProject(path, project, expectedRevision);
}

/**
 * Reveal a saved project file (or, when `path` is empty, the projects folder)
 * in the OS file manager. No-op-with-error in the browser.
 */
export async function revealProject(
  path: string,
  bridge: RendererBridge | null = getBridge(),
): Promise<RevealResult> {
  if (!bridge) {
    return { ok: false, error: 'Reveal is only available in the desktop app.' };
  }
  return bridge.revealProject(path);
}

/** The default projects folder, or `null` in the browser. */
export async function projectsDir(
  bridge: RendererBridge | null = getBridge(),
): Promise<string | null> {
  return bridge ? bridge.projectsDir() : null;
}

/**
 * Export (render) a saved project to a video file via the desktop bridge → the
 * Python sidecar. Rendering is impossible in a plain browser (no engine), so the
 * browser path returns a clear, actionable error instead of failing opaquely.
 */
export async function exportVideo(
  req: ExportRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<ExportResult> {
  if (!bridge) {
    return {
      ok: false,
      error: 'Export requires the FramePilot desktop app (the render engine runs there).',
    };
  }
  return bridge.exportVideo(req);
}

/**
 * Transcribe one saved media asset through the trusted desktop host. Audio bytes
 * and hosted-provider credentials stay outside the renderer.
 */
export async function transcribeAsset(
  req: TranscriptionRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<TranscriptionResult> {
  if (!bridge) {
    return {
      ok: false,
      error: 'Transcription requires the FramePilot desktop app.',
      unavailable: true,
    };
  }
  return bridge.transcribe(req);
}

/**
 * Start a full (non-preview) export asynchronously via the desktop bridge.
 * Resolves to a `requestId`; progress (queued → running → completed/failed/
 * cancelled) arrives via {@link onExportProgress}, scoped to that id — the
 * sidecar's `/render` route is itself async (H1.3a), so the UI must watch
 * progress rather than await one blocking promise (H1.3b).
 *
 * Returns `null` when the bridge is absent (browser mode) — export is
 * impossible there, so the caller should surface the same "desktop only"
 * message {@link exportVideo} would have returned.
 */
export async function exportVideoStart(
  req: ExportRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<string | null> {
  if (!bridge) return null;
  return bridge.exportVideoStart(req);
}

/** Cancel an in-flight export started via {@link exportVideoStart}. No-op without a bridge. */
export function exportVideoCancel(
  requestId: string,
  bridge: RendererBridge | null = getBridge(),
): void {
  bridge?.exportVideoCancel(requestId);
}

/**
 * Subscribe to export progress pushes (from {@link exportVideoStart} runs).
 * Returns an unsubscribe function; a no-op returning a no-op outside the
 * desktop shell (browser/tests), so callers need no environment check.
 */
export function onExportProgress(
  callback: (message: ExportProgressMessage) => void,
  bridge: RendererBridge | null = getBridge(),
): () => void {
  if (!bridge) return () => {};
  return bridge.onExportProgress(callback);
}

/**
 * Save an already-exported video (the sandboxed render output) to a
 * user-chosen location via the desktop bridge's native "Save As" dialog. In
 * the browser (no bridge) this returns a clear error — export itself already
 * requires the desktop app, so this path is unreachable there in practice.
 */
export async function exportSaveAs(
  req: ExportSaveAsRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<ExportSaveAsResult> {
  if (!bridge) {
    return { ok: false, error: 'Save As is only available in the desktop app.' };
  }
  return bridge.exportSaveAs(req);
}

/**
 * Copy an imported media file into the project's media folder via the desktop
 * bridge, returning the relative on-disk path to store in `asset.path`. In the
 * browser (no bridge) there is no disk to write to, so this returns a clear
 * error and the caller keeps the session-scoped object URL instead.
 */
export async function importMedia(
  req: MediaImportRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<MediaImportResult> {
  if (!bridge) {
    return { ok: false, error: 'Media import to disk requires the FramePilot desktop app.' };
  }
  return bridge.importMedia(req);
}

/**
 * Derive engine media (waveform peaks + thumbnails) for an on-disk media file via
 * the desktop bridge → the Python sidecar. Deriving media is impossible in a
 * plain browser (no engine), so the browser path returns a clear, actionable
 * error; the caller treats any failure as non-fatal and keeps the asset without
 * media (the timeline draws a skeleton).
 */
export async function importAsset(
  req: ImportAssetRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<ImportAssetResult> {
  if (!bridge) {
    return { ok: false, error: 'Thumbnail previews require the FramePilot desktop app.' };
  }
  return bridge.importAsset(req);
}

/** A validated external change to the open project file (e.g. an MCP agent edit). */
export interface ExternalProjectChange {
  readonly path: string;
  readonly project: Project;
  readonly revision?: number;
}

/**
 * Subscribe to live external edits of the open project file — most importantly
 * an MCP agent editing it through the standalone server while the app has it
 * open. The on-disk document is validated before the callback fires, so a
 * malformed external write is dropped rather than coerced into the editor
 * (AGENTS.md invariant 3).
 *
 * Returns an unsubscribe function. Outside the desktop shell (browser/tests)
 * there is no main process to watch the file, so this is a no-op that returns a
 * no-op — callers need no environment check.
 */
export function onProjectChanged(
  callback: (change: ExternalProjectChange) => void,
  bridge: RendererBridge | null = getBridge(),
): () => void {
  if (!bridge) return () => {};
  return bridge.onProjectChanged((event: ProjectChangedEvent) => {
    const parsed = safeParseProject(event.project);
    if (!parsed.success) return; // never load an invalid external write
    callback({ path: event.path, project: parsed.data, revision: event.revision ?? 0 });
  });
}

// ---------------------------------------------------------------------------
// Music sourcing (plan/3rd-party-sourcing)
// ---------------------------------------------------------------------------

/**
 * The "this is desktop-only" answer, shared by every music helper.
 *
 * Reaching a provider needs the main process — the renderer's CSP forbids it,
 * deliberately. In the browser the Sounds tab is absent rather than
 * present-and-broken, so this is a backstop, not the user-facing path.
 */
const MUSIC_DESKTOP_ONLY = {
  ok: false,
  error: 'provider_unavailable',
  detail: 'Music search is only available in the desktop app.',
} as const;

/** Search the configured music provider through the main process. */
export async function musicSearch(
  query: string,
  limit?: number,
  bridge: RendererBridge | null = getBridge(),
): Promise<MusicSearchResult> {
  if (!bridge?.musicSearch) return MUSIC_DESKTOP_ONLY;
  return bridge.musicSearch(query, limit);
}

/**
 * Fetch audition bytes for one track.
 *
 * Main holds the provider URL; this receives bytes, which the caller wraps in a
 * `blob:` URL. That is what keeps the provider host out of `connect-src`.
 */
export async function musicPreview(
  remoteId: string,
  bridge: RendererBridge | null = getBridge(),
): Promise<MusicPreviewResult> {
  if (!bridge?.musicPreview) return MUSIC_DESKTOP_ONLY;
  return bridge.musicPreview(remoteId);
}

/** Download one track into the project's media folder. */
export async function musicDownload(
  request: MusicDownloadRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<MusicDownloadResult> {
  if (!bridge?.musicDownload) {
    return {
      ok: false,
      error: 'download_failed',
      detail: 'Downloading music is only available in the desktop app.',
    };
  }
  return bridge.musicDownload(request);
}

/** Cancel an in-flight download. No-op without a bridge. */
export function musicDownloadCancel(
  operationId: string,
  bridge: RendererBridge | null = getBridge(),
): void {
  bridge?.musicDownloadCancel?.(operationId);
}

/**
 * Subscribe to download progress. A no-op returning a no-op outside the desktop
 * shell, so callers need no environment check.
 */
export function onMusicDownloadProgress(
  callback: (message: MusicDownloadProgressWire) => void,
  bridge: RendererBridge | null = getBridge(),
): () => void {
  if (!bridge?.onMusicDownloadProgress) return () => {};
  return bridge.onMusicDownloadProgress(callback);
}

// ---------------------------------------------------------------------------
// Stock photo & video sourcing (plan/3rd-party-sourcing/photo-video)
// ---------------------------------------------------------------------------

/**
 * The "this is desktop-only" answer, shared by every stock helper.
 *
 * Reaching a provider needs the main process — the renderer's CSP forbids it,
 * deliberately. In the browser the Stock tab is absent rather than
 * present-and-broken, so this is a backstop, not the user-facing path.
 */
const STOCK_DESKTOP_ONLY = {
  ok: false,
  error: 'provider_unavailable',
  detail: 'Stock search is only available in the desktop app.',
} as const;

/** Search the stock provider through the main process. */
export async function stockSearch(
  request: StockSearchRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<StockSearchResult> {
  if (!bridge?.stockSearch) return STOCK_DESKTOP_ONLY;
  return bridge.stockSearch(request);
}

/**
 * Fetch grid-tile bytes for one item.
 *
 * Main holds the provider URL; this receives bytes, which the caller wraps in a
 * `blob:` URL. That is what keeps the provider host out of `connect-src`.
 */
export async function stockThumbnail(
  remoteId: string,
  bridge: RendererBridge | null = getBridge(),
): Promise<StockBytesResult> {
  if (!bridge?.stockThumbnail) return STOCK_DESKTOP_ONLY;
  return bridge.stockThumbnail(remoteId);
}

/** Fetch the low-res rendition used for hover preview and scrubbing. */
export async function stockPreview(
  remoteId: string,
  bridge: RendererBridge | null = getBridge(),
): Promise<StockBytesResult> {
  if (!bridge?.stockPreview) return STOCK_DESKTOP_ONLY;
  return bridge.stockPreview(remoteId);
}

/** Download one rendition into the project's media folder. */
export async function stockDownload(
  request: StockDownloadRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<StockDownloadResult> {
  if (!bridge?.stockDownload) {
    return {
      ok: false,
      error: 'download_failed',
      detail: 'Downloading stock media is only available in the desktop app.',
    };
  }
  return bridge.stockDownload(request);
}

/** Cancel an in-flight download. No-op without a bridge. */
export function stockDownloadCancel(
  operationId: string,
  bridge: RendererBridge | null = getBridge(),
): void {
  bridge?.stockDownloadCancel?.(operationId);
}

/**
 * Subscribe to download progress. A no-op returning a no-op outside the desktop
 * shell, so callers need no environment check.
 */
export function onStockDownloadProgress(
  listener: (message: StockDownloadProgressWire) => void,
  bridge: RendererBridge | null = getBridge(),
): () => void {
  return bridge?.onStockDownloadProgress?.(listener) ?? (() => undefined);
}

/** Read the last observed provider quota. Never triggers a provider request. */
export async function stockQuota(
  bridge: RendererBridge | null = getBridge(),
): Promise<StockQuotaSnapshot> {
  if (!bridge?.stockQuota) return { kind: 'no_key' };
  return bridge.stockQuota();
}

/**
 * Subscribe to quota changes, pushed by main on every observation.
 *
 * Pushed rather than polled: the quota only moves when *we* make a request, so
 * an interval would be both wasteful and staler than the event it replaced.
 */
export function onStockQuotaChanged(
  listener: (snapshot: StockQuotaSnapshot) => void,
  bridge: RendererBridge | null = getBridge(),
): () => void {
  return bridge?.onStockQuotaChanged?.(listener) ?? (() => undefined);
}
