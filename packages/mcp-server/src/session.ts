/**
 * @framepilot/mcp-server/session — the stateful editing session behind the MCP host.
 *
 * An external AI agent drives editing through this object. It is the boundary
 * that keeps every mutation inside FramePilot's five invariants (AGENTS.md §1):
 *
 *   tool call → typed Operation[] → assembled Patch → validatePatch → apply →
 *   atomic save
 *
 * The session never lets the agent mutate the project JSON directly: a mutating
 * tool only produces typed operations, which are assembled into a reviewable,
 * reversible patch and validated *before* being applied. Reads/actions/mutations
 * all run against a {@link ToolContext} scoped to the open project. File access is
 * sandboxed to the projects root via {@link resolveWithin}.
 */
import {
  type AnyOperation,
  type EditHistory,
  type HistoryEntry,
  type Patch,
  type TimelineDiff,
  type ValidationResult,
  canRedo,
  canUndo,
  DEFAULT_DURABLE_HISTORY_LIMITS,
  commitProjectPatch,
  fromPersistedHistory,
  redoProject,
  toPersistedHistory,
  undoProject,
} from '@framepilot/editor-core';
import {
  BUNDLED_SKILLS,
  type ToolContext,
  assembleEdit,
  getTool,
  skillsByName,
} from '@framepilot/ai-sdk';
import { TranscriptWordSchema, type Project } from '@framepilot/timeline-schema';
import {
  readProjectFile,
  serializeProject,
  writeProjectFile,
} from '@framepilot/timeline-schema/file';
import {
  activePointerPath,
  isActivePointer,
  resolveProjectsRoot,
} from '@framepilot/shared-types/projects-root';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWithin } from './safety.js';
import { servableOverMcp } from './tools.js';

/** Why a tool call could not be honoured — the tool boundary gate (PRD §8.3). */
export type SessionErrorCode =
  | 'unknown_tool'
  | 'unavailable_tool'
  | 'invalid_args'
  | 'unsafe_path'
  | 'no_project'
  /** The tool needs a human at FramePilot's own UI, which this surface cannot provide. */
  | 'host_ui_only'
  /** The on-disk project file changed since it was loaded (lost-update guard). */
  | 'conflict';

/** A typed failure an agent can act on (mirrors ai-sdk `ToolInvocationError`). */
export class SessionError extends Error {
  public constructor(
    public readonly code: SessionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SessionError';
  }
}

/** Outcome of {@link EditorSession.runTool}, discriminated by the tool's kind. */
export type RunToolResult =
  | { readonly kind: 'read'; readonly data: unknown }
  /** A side-effecting request (render/export) the host performs — no patch. */
  | { readonly kind: 'action'; readonly name: string }
  /**
   * An ffmpeg-backed analysis (analyze_silence/detect_scenes/detect_beats) the host runs
   * against the media via the engine sidecar — no patch. `args` are the
   * schema-validated tool arguments to forward.
   */
  | { readonly kind: 'analysis'; readonly name: string; readonly args: Record<string, unknown> }
  | {
      readonly kind: 'mutate';
      /** False when the patch failed validation; the timeline is left untouched. */
      readonly applied: boolean;
      readonly patch: Patch;
      readonly validation: ValidationResult;
      /** Present only when applied (so the agent can show before/after). */
      readonly diff?: TimelineDiff;
    };

/** Snapshot of the open project returned to the agent after a change. */
export interface SessionState {
  readonly path: string;
  readonly project: Project;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly historyLength: number;
}

interface OpenProject {
  path: string;
  project: Project;
  history: EditHistory;
  /**
   * Exact bytes on disk at load / last save — the baseline for the lost-update
   * guard. Before overwriting `path`, {@link EditorSession.saveProject} re-reads the
   * file and compares it to this snapshot; a mismatch means the GUI or another
   * process wrote it, so we reject rather than silently clobber their edit.
   */
  baseline: string;
}

export class EditorSession {
  private open: OpenProject | null = null;

  /**
   * @param projectsRoot - The sandbox root every project path must resolve inside
   *   (typically `FRAMEPILOT_PROJECTS_ROOT`). Must exist on disk.
   */
  public constructor(private readonly projectsRoot: string) {}

  private require(): OpenProject {
    if (!this.open) {
      throw new SessionError('no_project', 'No project is open. Call open_project first.');
    }
    return this.open;
  }

  private snapshot(open: OpenProject): SessionState {
    return {
      path: open.path,
      project: open.project,
      canUndo: canUndo(open.history),
      canRedo: canRedo(open.history),
      historyLength: open.history.cursor,
    };
  }

  private context(open: OpenProject): ToolContext {
    // Bundled skills (ADR 0057) so `load_skill` serves the same playbooks over MCP
    // as it does in the desktop/web orchestrator.
    return { project: open.project, skills: skillsByName(BUNDLED_SKILLS) };
  }

  /** Open a `project.fp.json` (sandbox-checked) and make it the active project. */
  public async openProject(path: string): Promise<SessionState> {
    return this.loadInto(resolveWithin(this.projectsRoot, path));
  }

  /**
   * Load an already-resolved, absolute project path into the session. Both callers
   * sandbox-check the path through {@link resolveWithin} first: {@link openProject}
   * checks an agent-supplied path, {@link openActiveProject} checks the app-authored
   * active-pointer target. Neither can escape the projects root.
   */
  private async loadInto(resolved: string): Promise<SessionState> {
    // Snapshot the raw on-disk bytes as the lost-update baseline (see OpenProject).
    // A second read here (readProjectFile also reads) keeps the baseline byte-exact
    // and self-contained; project files are small so the extra read is negligible.
    const baseline = await readFile(resolved, 'utf-8');
    const project = await readProjectFile(resolved);
    // `history` is persisted as our own editor-core HistoryEntry objects (the
    // schema types it as unknown[]), so undo/redo survives a reload.
    const history = fromPersistedHistory(project.history as HistoryEntry[]);
    this.open = { path: resolved, project, history, baseline };
    return this.snapshot(this.open);
  }

  /**
   * Open the project the FramePilot desktop app currently has open, by reading the
   * active-project pointer the app maintains at `<projectsRoot>/.framepilot-active.json`.
   * This is what lets an external agent edit the user's open project without
   * guessing a path — and, crucially, edit the *right* project so the GUI reflects
   * the change live (the desktop file-watcher reloads the open file on external save).
   *
   * The pointer is **NOT** blindly trusted. It is a locally-writable file, so any
   * process that can write it could otherwise coerce the session into opening — and
   * then, via {@link saveProject}, OVERWRITING — an arbitrary absolute path. The
   * pointer's target is therefore resolved through {@link resolveWithin} against the
   * projects root, exactly like an agent-supplied path: it may name any project
   * inside the sandbox (relative or absolute) but cannot escape it. A project the
   * user opened from outside the root must be opened explicitly (and is sandbox-
   * rejected there too) — the sandbox is the single containment rule for every path.
   *
   * @throws {SessionError} `no_project` when no/corrupt pointer exists;
   *   `unsafe_path` when the pointer names a target outside the projects sandbox.
   */
  public async openActiveProject(): Promise<SessionState> {
    const pointer = await this.readActivePointer();
    if (!pointer) {
      throw new SessionError(
        'no_project',
        'No active project. Open a project in the FramePilot app, or call open_project with a path.',
      );
    }
    let target: string;
    try {
      target = resolveWithin(this.projectsRoot, pointer.path);
    } catch (cause) {
      // resolveWithin only throws PathTraversalError; surface it as a typed error so
      // a poisoned pointer cannot coerce the session outside the sandbox.
      throw new SessionError(
        'unsafe_path',
        `Active-project pointer escapes the projects sandbox: ${pointer.path}`,
        { cause },
      );
    }
    return this.loadInto(target);
  }

  /**
   * Ensure a project is open, falling back to the app's active project. Callers
   * that need an open project (save/undo/redo/history and every mutating/read tool)
   * use this so an agent can start editing without an explicit open_project call.
   */
  public async ensureOpenProject(): Promise<void> {
    if (this.open) return;
    await this.openActiveProject();
  }

  /** Read + validate the active-project pointer, or null when absent/corrupt. */
  private async readActivePointer() {
    try {
      const raw = await readFile(activePointerPath(this.projectsRoot), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return isActivePointer(parsed) ? parsed : null;
    } catch {
      // Missing file, unreadable, or malformed JSON — treat as "no active project".
      return null;
    }
  }

  /**
   * Save the active project atomically. Persists the current timeline and patch
   * history. Originals are never touched (invariant 1).
   *
   * @param path - Optional target inside the sandbox; defaults to the open path.
   */
  public async saveProject(path?: string): Promise<SessionState> {
    const open = this.require();
    // `open.path` is always set once a project is open, and resolveWithin returns
    // a non-empty path, so `target` is always a valid destination.
    const target = path ? resolveWithin(this.projectsRoot, path) : open.path;
    // Bound the persisted undo suffix exactly like the desktop and renderer save
    // paths do. Without the limits argument `toPersistedHistory` keeps EVERY applied
    // entry, which is how a project file reached 383 MB of history and made the
    // desktop app abort on open; the live in-session history stays complete.
    const toSave: Project = {
      ...open.project,
      history: toPersistedHistory(open.history, DEFAULT_DURABLE_HISTORY_LIMITS),
    };
    const nextBaseline = serializeProject(toSave);
    // Lost-update guard: only when overwriting the exact file we loaded (or last
    // saved). A "save as" to a different path is the agent's explicit choice and has
    // no baseline to protect. writeProjectFile serializes with this same serializer,
    // so after the write the on-disk bytes equal `nextBaseline` (ADR 0030).
    if (target === open.path) {
      await this.assertNoExternalChange(target, open.baseline);
    }
    await writeProjectFile(target, toSave);
    open.path = target;
    open.project = toSave;
    open.baseline = nextBaseline;
    return this.snapshot(open);
  }

  /**
   * Reject a save that would clobber an external edit. Re-reads the target and
   * compares it byte-for-byte to the baseline captured when we loaded/last saved it.
   * A file that no longer exists (deleted externally) has nothing to clobber, so the
   * save proceeds and recreates it.
   *
   * @throws {SessionError} `conflict` when the on-disk bytes differ from the baseline.
   */
  private async assertNoExternalChange(target: string, baseline: string): Promise<void> {
    let current: string;
    try {
      current = await readFile(target, 'utf-8');
    } catch {
      return;
    }
    if (current !== baseline) {
      throw new SessionError(
        'conflict',
        'Project file changed on disk since it was opened; reload before saving to avoid overwriting external edits.',
      );
    }
  }

  /**
   * Validate and run a registered tool against the open project.
   *
   * Mutating tools assemble a validated, reversible patch and apply it (recording
   * undo); a patch that fails validation is returned with `applied: false` and
   * leaves the timeline untouched. Read tools return data; action tools are
   * surfaced for the host to perform.
   *
   * @throws {SessionError} for unknown/unavailable tools, invalid args, or no open project.
   */
  public runTool(name: string, rawArgs: unknown): RunToolResult {
    const open = this.require();
    const tool = getTool(name);
    if (!tool) throw new SessionError('unknown_tool', `Unknown tool: ${name}`);
    if (!tool.available) {
      throw new SessionError(
        'unavailable_tool',
        `Tool "${name}" is registered but its engine is not available yet.`,
      );
    }
    // `hostUiOnly` tools depend on live editor interaction state — the selection, playhead, and
    // source-monitor snapshot a human is looking at. This surface has no such snapshot, so the
    // tool list omits them. Refuse them here too: hiding a tool from the advertised list is not
    // enforcement when any client can still name it directly.
    if (!servableOverMcp(tool)) {
      throw new SessionError(
        'host_ui_only',
        `Tool "${name}" requires live FramePilot editor interaction state and is not available over MCP.`,
      );
    }
    const ctx = this.context(open);

    if (tool.kind === 'read') {
      return { kind: 'read', data: this.guardArgs(name, () => tool.read!(rawArgs, ctx)) };
    }
    if (tool.kind === 'action') {
      this.guardArgs(name, () => tool.parse(rawArgs));
      return { kind: 'action', name };
    }
    if (tool.kind === 'analysis') {
      // ffmpeg runs in the Python engine, not here: validate the args and hand
      // them back for the host to delegate to the sidecar (like an action).
      const args = this.guardArgs(name, () => tool.parse(rawArgs)) as Record<string, unknown>;
      return { kind: 'analysis', name, args };
    }

    // Mutating tool: build typed operations, then assemble + validate the patch.
    const operations = this.guardArgs(name, () => tool.buildOps!(rawArgs, ctx));
    // Any media path an agent introduces (e.g. add_asset for AI-generated media)
    // is untrusted — it must resolve inside the projects sandbox before it is
    // ever persisted into the project file (security: path containment).
    this.assertAssetPathsSandboxed(operations);
    const { patch, validation, diff } = assembleEdit(
      open.project,
      operations,
      `Edit via MCP: ${name}`,
    );
    if (!validation.valid) {
      return { kind: 'mutate', applied: false, patch, validation };
    }
    const step = commitProjectPatch(open.project, open.history, patch);
    open.project = step.project;
    open.history = step.history;
    // `diff` is always present once validation passed (assembleEdit computes it).
    return { kind: 'mutate', applied: true, patch, validation, diff: diff! };
  }

  /**
   * Commit trusted host-produced ASR words through the same reversible patch
   * path as every registry mutation. The external agent never supplies these
   * words; the sidecar response is schema-validated here before apply.
   */
  public applyHostTranscript(words: unknown): Extract<RunToolResult, { kind: 'mutate' }> {
    const open = this.require();
    const parsed = TranscriptWordSchema.array().min(1).parse(words);
    const { patch, validation, diff } = assembleEdit(
      open.project,
      [{ type: 'set_transcript', words: parsed }],
      'Transcribe media via MCP',
    );
    // set_transcript has no timeline references to check, so a schema-valid word
    // array can never fail validation; kept defensive, not reachable.
    /* v8 ignore start */
    if (!validation.valid) {
      return { kind: 'mutate', applied: false, patch, validation };
    }
    /* v8 ignore stop */
    const step = commitProjectPatch(open.project, open.history, patch);
    open.project = step.project;
    open.history = step.history;
    return { kind: 'mutate', applied: true, patch, validation, diff: diff! };
  }

  /** Undo the most recent applied edit (timeline and/or asset/folder bin). */
  public undo(): SessionState {
    const open = this.require();
    const step = undoProject(open.project, open.history);
    open.project = step.project;
    open.history = step.history;
    return this.snapshot(open);
  }

  /** Redo the most recently undone edit. */
  public redo(): SessionState {
    const open = this.require();
    const step = redoProject(open.project, open.history);
    open.project = step.project;
    open.history = step.history;
    return this.snapshot(open);
  }

  /**
   * Reject any `add_asset` operation whose media path escapes the projects
   * sandbox. The path is the only untrusted, filesystem-bound field an agent can
   * inject through a mutating tool, so it is contained here before it reaches the
   * project file. Resolution mirrors the open/save path checks.
   *
   * @throws {SessionError} `unsafe_path` when a path resolves outside the sandbox.
   */
  private assertAssetPathsSandboxed(operations: readonly AnyOperation[]): void {
    for (const op of operations) {
      if (op.type !== 'add_asset') continue;
      try {
        resolveWithin(this.projectsRoot, op.asset.path);
      } catch (cause) {
        // resolveWithin only throws PathTraversalError, so any failure here is a
        // containment violation — surface it as a typed, agent-readable error.
        throw new SessionError(
          'unsafe_path',
          `add_asset path escapes the projects sandbox: ${op.asset.path}`,
          { cause },
        );
      }
    }
  }

  /** The applied patch history (oldest first), for review/get_patch_history. */
  public history(): readonly Patch[] {
    const open = this.require();
    return open.history.entries.slice(0, open.history.cursor).map((e) => e.patch);
  }

  /** Current session state, or `null` when no project is open. */
  public state(): SessionState | null {
    return this.open ? this.snapshot(this.open) : null;
  }

  /** Wrap arg-validation/build failures (e.g. ZodError) as a typed SessionError. */
  private guardArgs<T>(name: string, fn: () => T): T {
    try {
      return fn();
    } catch (cause) {
      throw new SessionError('invalid_args', `Invalid arguments for "${name}".`, { cause });
    }
  }
}

/**
 * Convenience constructor that resolves the sandbox root from the environment.
 *
 * Mirrors the desktop app: `FRAMEPILOT_PROJECTS_ROOT` wins, otherwise it defaults
 * to `~/Documents/FramePilot Projects` — the same folder the app saves projects
 * into — so an agent edits real projects out of the box without extra config.
 */
export const sessionFromEnv = (env: NodeJS.ProcessEnv = process.env): EditorSession => {
  const root = resolveProjectsRoot(env, path.join(os.homedir(), 'Documents'));
  return new EditorSession(root);
};
