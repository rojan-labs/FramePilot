/**
 * Watches the open `project.fp.json` for **external** edits and pushes the
 * fresh, validated project to the renderer so the UI reflects them live
 * (plan/PLAN.md Phase 8, ADR 0030). The motivating case: an external AI agent
 * editing the same file over the MCP server while the desktop app has it open —
 * before this, those edits only appeared after a manual re-open.
 *
 * Two problems make a naive `fs.watch` insufficient, and this class owns both:
 *
 *  1. **Self-write echo.** The app autosaves the same file. Its own writes fire
 *     the watcher, but re-loading them would be a pointless round-trip (and could
 *     fight the editor's in-memory state). We dedup on the *canonical
 *     serialization*: every emit/self-write updates a baseline string, and an fs
 *     event whose re-read serializes identically is dropped. {@link markSelfWrite}
 *     lets the app pre-declare a write it is about to make.
 *  2. **Burst + half-written files.** An atomic save is temp-write + rename, which
 *     fires several events; a read mid-write can transiently fail or be invalid.
 *     Events are debounced, and a read/parse failure is swallowed (we keep
 *     watching) rather than surfaced as a change.
 *
 * All IO is injected ({@link ProjectWatcherDeps}) so the dedup/debounce logic is
 * unit-testable without `electron`, `fs`, or a real clock. The Electron wiring
 * (directory `fs.watch`, `readProjectFile`, `webContents.send`) lives in
 * `main.ts`, which is intentionally not unit-tested.
 */
import type { Project } from '@framepilot/timeline-schema';

/** A validated external change to the watched project file. */
export interface ProjectChange {
  readonly path: string;
  readonly project: Project;
}

/** Injected IO + scheduling the watcher depends on. */
export interface ProjectWatcherDeps {
  /**
   * Begin watching `path` for filesystem events, invoking `onChange` on each.
   * Returns a function that stops watching. The implementation should watch
   * robustly across atomic renames (e.g. watch the containing directory and
   * filter by file name) so a temp-file→rename save is not missed.
   */
  watch(path: string, onChange: () => void): () => void;
  /** Read, migrate, and validate the project at `path` (throws on missing/invalid). */
  read(path: string): Promise<Project>;
  /** Canonical serialization used as the dedup key (same one the writer uses). */
  serialize(project: Project): string;
  /** Deliver a validated external change to the renderer. */
  emit(change: ProjectChange): void;
  /** Coalesce window (ms) for the event burst an atomic save produces. */
  debounceMs?: number;
  /** Report a non-fatal read/parse failure (transient half-written file). */
  onError?: (error: unknown) => void;
}

/** Default debounce — long enough to coalesce a temp-write+rename burst. */
const DEFAULT_DEBOUNCE_MS = 120;

export class ProjectFileWatcher {
  private watchedPath: string | null = null;
  private stopWatch: (() => void) | null = null;
  /** Canonical content already known to the renderer (baseline for dedup). */
  private lastCanonical: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Invalidates baseline work when the user opens another project quickly. */
  private watchGeneration = 0;
  /**
   * Baseline initialization runs after the native watch is installed, but it is
   * intentionally not part of `watch()`'s returned promise. Project open already
   * read and validated the same file. Awaiting a second read/parse/serialize before
   * returning to the renderer doubled the large-project schema work on the open
   * critical path. A real fs event waits for this promise before comparing, so no
   * change can overtake the baseline or be silently dropped.
   */
  private baselineReady: Promise<void> = Promise.resolve();

  public constructor(private readonly deps: ProjectWatcherDeps) {}

  private get debounceMs(): number {
    return this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Watch `path` (replacing any prior watch). The file's current content becomes
   * the baseline, so the project the app just opened is never re-emitted as a
   * change. A no-op when already watching `path`.
   *
   * The native watch is installed synchronously and the baseline is initialized
   * in the background. Callers can therefore show the already-validated project
   * immediately instead of waiting for a duplicate full-project parse.
   */
  public watch(path: string): Promise<void> {
    if (this.watchedPath === path) return Promise.resolve();
    this.stop();
    const generation = this.watchGeneration;
    this.watchedPath = path;
    this.stopWatch = this.deps.watch(path, () => this.onFsEvent());
    this.baselineReady = this.readCanonical(path).then((canonical) => {
      if (
        this.watchGeneration === generation &&
        this.watchedPath === path &&
        this.lastCanonical === null
      ) {
        this.lastCanonical = canonical;
      }
    });
    return Promise.resolve();
  }

  /**
   * Record content the app itself is about to write, so the resulting fs event
   * is recognised as a self-write and not echoed back to the renderer.
   */
  public markSelfWrite(path: string, project: Project): void {
    if (path !== this.watchedPath) return;
    this.lastCanonical = this.deps.serialize(project);
  }

  /** Stop watching and clear all state (idempotent). */
  public stop(): void {
    this.watchGeneration += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopWatch) {
      this.stopWatch();
      this.stopWatch = null;
    }
    this.watchedPath = null;
    this.lastCanonical = null;
    this.baselineReady = Promise.resolve();
  }

  private onFsEvent(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Re-read the watched file once the event burst settles; emit if it changed. */
  private async flush(): Promise<void> {
    this.timer = null;
    const path = this.watchedPath;
    const generation = this.watchGeneration;
    if (path === null) return;
    // Preserve ordering while keeping baseline work out of project-open latency.
    await this.baselineReady;
    if (this.watchGeneration !== generation || this.watchedPath !== path) return;
    let project: Project;
    let canonical: string;
    try {
      project = await this.deps.read(path);
      canonical = this.deps.serialize(project);
    } catch (error) {
      // A read mid-rename can fail or be invalid; keep watching, don't emit.
      this.deps.onError?.(error);
      return;
    }
    // Unchanged content, or our own write echoed back — nothing to report.
    if (canonical === this.lastCanonical) return;
    this.lastCanonical = canonical;
    this.deps.emit({ path, project });
  }

  private async readCanonical(path: string): Promise<string | null> {
    try {
      return this.deps.serialize(await this.deps.read(path));
    } catch {
      // No baseline (missing/invalid at watch-start) — the first valid read wins.
      return null;
    }
  }
}
