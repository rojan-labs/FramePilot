/**
 * @framepilot/timeline-schema/project-file — Node-only atomic reader/writer for
 * `project.fp.json` (PLAN §1.1: "file format reader/writer (atomic writes)").
 *
 * Imports `node:fs`, so it is exposed only via the package's `./file` subpath and
 * never from the browser-safe barrel (`index.ts`).
 *
 * Writes are atomic AND durable: the JSON is written to a **process-unique** sibling temp
 * file, fsynced, and then `rename`d over the target. `rename` is atomic on the same
 * filesystem, so a crash mid-write can never leave a half-written, unparseable project
 * file. See {@link writeProjectFile} for why each of those three words is load-bearing.
 *
 * Writes are also guarded against a **cross-process lost update**. Two OS processes end
 * at this writer against the same file: the Electron main process (autosave, save-as, and
 * AI patch commits) and the MCP server, which an external agent drives while the desktop
 * app has the same project open. Atomicity does not help there — it stops interleaved
 * BYTES, not a lost update. `rename` publishes a whole DOCUMENT, so both processes can
 * read the same project, each apply a different edit, and whichever renames last silently
 * erases the other's work. {@link writeProjectFile} therefore publishes only over content
 * this process has proven it has seen; see {@link ProjectFileConflictError}.
 *
 * WHY compare-and-swap on content rather than a revision number: there is no shared
 * revision on disk. The desktop's `ProjectCommandService` revision is process-local, and
 * the MCP process has never heard of it, so the only fact both processes can agree on is
 * the bytes of the file itself.
 *
 * WHY no lockfile: the unit that has to be atomic is the whole read-modify-write, and both
 * writers hold a project open for minutes to hours. A lock could only cover the publish
 * critical section — exactly what the CAS already covers — while adding a failure mode
 * that is genuinely worse than the race it removes: a stale lock (crashed app, reused pid,
 * or a projects root on a network/synced volume where pid liveness means nothing) blocks
 * the user from saving their work at all. "Cannot save" beats "microsecond window" only if
 * you never have to live with it.
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve as resolvePath } from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from './index.js';
import { deserializeProject, serializeProject } from './serialization.js';

const log = createLogger('timeline-schema:project-file');

/**
 * Discriminator carried on {@link ProjectFileConflictError}.
 *
 * WHY a code rather than `instanceof`: the consumers are in other packages (the desktop
 * main process, the MCP server) and resolve this module through its built `dist`. A dual
 * class identity — two copies of the module in one process graph, or a value that crossed
 * a structured-clone boundary — makes `instanceof` quietly false, and a lost-update guard
 * that quietly stops guarding is worse than none. {@link isProjectFileConflictError} is
 * the supported check.
 */
export const PROJECT_FILE_CONFLICT_CODE = 'project_file_conflict';

/** A refused publish: the target is not the content this process last proved it saw. */
export class ProjectFileConflictError extends Error {
  public readonly code = PROJECT_FILE_CONFLICT_CODE;

  public constructor(
    /** The project file that was NOT written. */
    public readonly path: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProjectFileConflictError';
  }
}

/** Cross-package-safe test for {@link ProjectFileConflictError}. */
export function isProjectFileConflictError(value: unknown): value is ProjectFileConflictError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { code?: unknown }).code === PROJECT_FILE_CONFLICT_CODE
  );
}

/**
 * Per-process registry of the content this process has PROVEN it has seen, keyed by
 * resolved path: the bytes the last successful {@link readProjectFile} parsed, or the
 * bytes it last published itself. Values are sha256 digests — the same fingerprint
 * vocabulary the desktop revision service already uses — so a 64 MB project costs 64
 * hex characters here, not a second copy of the document.
 *
 * Deliberately unbounded: an entry is added per distinct project file this process
 * touches, which is bounded by how many projects a user opens in one session. Evicting
 * would silently downgrade an open project to "unknown path" — i.e. back to blind
 * overwriting — which is the one behaviour this registry exists to prevent.
 */
const observedContent = new Map<string, string>();

/** In-flight publish per resolved path, so two writers in THIS process cannot interleave. */
const publishLanes = new Map<string, Promise<void>>();

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

/**
 * Above this, a project file is parsed only after its `history` is dropped.
 *
 * WHY: `history` is the one unbounded field in the format — a single patch can
 * carry hundreds of full-track snapshots (one per lossy op), so a caption-heavy
 * project has been seen at 383 MB of history against 0.6 MB of actual content.
 * `JSON.parse` expands that to several GB of objects and aborts the **Electron
 * main process** with `FATAL ERROR: JavaScript heap out of memory` — the whole
 * app dies, at startup, with no recoverable error.
 *
 * Undo history is the only expendable part of a project: dropping it loses the
 * ability to undo past edits but keeps every asset, clip, caption and marker.
 * So over this budget we open the project WITHOUT its history rather than take
 * the app down. Matches the 64 MiB quarantine the AI run-log WAL already uses.
 */
export const MAX_PARSED_PROJECT_BYTES = 64 * 1024 * 1024;

/**
 * Replace the top-level `"history": [...]` value with `[]`, without parsing it.
 *
 * Scans rather than regex-matches because the array contains arbitrary user text
 * (caption words, clip names) that can hold `[`, `]`, `"` and escapes. Tracks
 * string/escape state and bracket depth so only the *real* end of the array ends
 * it, and only considers the `history` key at depth 1 so a nested key of the same
 * name inside an operation payload can never be mistaken for it.
 *
 * @param text - The raw project-file JSON.
 * @returns The text with history emptied, or `null` if no top-level history array
 *   was found (the caller then refuses rather than guessing).
 */
export function stripTopLevelHistory(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let keyStart = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        // A depth-1 string that is followed by `:` is a top-level key.
        if (depth === 1 && text.slice(keyStart + 1, i) === 'history') {
          const colon = text.indexOf(':', i + 1);
          const open = colon === -1 ? -1 : text.indexOf('[', colon + 1);
          // Only treat it as the history array if `[` is the value itself —
          // i.e. nothing but whitespace sits between the colon and the bracket.
          if (open !== -1 && text.slice(colon + 1, open).trim() === '') {
            const end = findArrayEnd(text, open);
            if (end !== -1) return `${text.slice(0, open)}[]${text.slice(end + 1)}`;
          }
          return null;
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      keyStart = i;
    } else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
  }
  return null;
}

/** Index of the `]` closing the array that opens at `open`, or -1. */
function findArrayEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Re-exported on the Node `./file` subpath so the desktop main process can use
// the *same* canonical serializer the writer uses — the project-watcher dedups
// self-writes by comparing this exact serialization (ADR 0030).
export { serializeProject } from './serialization.js';

/**
 * Read, migrate, and validate a project file from disk.
 *
 * A successful read also becomes this process's publish baseline (see
 * {@link writeProjectFile}), which is what makes the guard self-healing: the desktop's
 * project watcher re-reads the file on every debounced fs event, so an external write
 * refreshes the baseline within the watcher's coalescing window and the next save is
 * allowed again rather than refused forever.
 *
 * @param path - Absolute path to a `project.fp.json` file.
 * @returns The validated, current-schema project.
 */
export async function readProjectFile(path: string): Promise<Project> {
  const text = await readFile(path, 'utf8');
  // Record ONLY after a successful parse. A read that lands mid-rename returns a
  // half-written file, and half a document is not evidence of what is on disk — trusting
  // it as a baseline would authorise overwriting whatever completed the rename.
  const record = (): void => {
    observedContent.set(resolvePath(path), digest(text));
  };
  if (text.length <= MAX_PARSED_PROJECT_BYTES) {
    const project = deserializeProject(text);
    record();
    return project;
  }

  // Over budget: parsing the history would abort the process (see the constant).
  // Open the project without it — content is preserved, only undo is lost.
  const withoutHistory = stripTopLevelHistory(text);
  if (withoutHistory === null) {
    throw new Error(
      `Project file is ${String(Math.round(text.length / 1_048_576))} MB, over the ` +
        `${String(MAX_PARSED_PROJECT_BYTES / 1_048_576)} MB parse budget, and its history ` +
        `could not be isolated to drop. Refusing to parse it: doing so would exhaust memory ` +
        `and terminate the app. Path: ${path}`,
    );
  }
  log.warn('project history dropped — file over parse budget', {
    path,
    bytes: text.length,
    budget: MAX_PARSED_PROJECT_BYTES,
  });
  const project = deserializeProject(withoutHistory);
  // The baseline is the bytes ON DISK (`text`), not the history-stripped document we
  // hand back: the next write has to compare against what the file actually holds.
  record();
  return project;
}

/**
 * Monotonic counter making each in-flight write's temp file unique within this process.
 *
 * WHY not the pid alone: two overlapping writes to the same project would share one temp
 * file, so the first `rename` consumes it and the second fails with ENOENT — and before
 * that, their two `'w'` handles interleave into the same bytes, so the surviving rename
 * can publish a MIXTURE of both projects. The pid covers the cross-process case (the MCP
 * server edits the same file from a separate OS process — see `project-watcher.ts`); the
 * counter covers concurrency inside one process. `main.ts#tempPathFor` already applies
 * exactly this to the user-data stores; the project file — the one thing holding the
 * user's work — was left on a fixed `.tmp` name.
 */
let atomicWriteSeq = 0;

/**
 * Atomically write a project to disk as `project.fp.json`.
 *
 * Durable as well as atomic: the temp file is **fsynced before the rename**. `rename` orders
 * metadata, not data, so without the sync a crash right after it can publish a correctly
 * named but zero-length project. The Python writer has always done this and cites PRD §18.3
 * (`engine/python/framepilot_engine/timeline/models.py`); the TS writer did not. The
 * containing directory is fsynced after the rename too — the rename is a directory metadata
 * change, so without that a power cut can lose the publish even though the data is safe.
 * The Python writer still has THAT gap (it does not fsync the directory); it is left alone
 * here rather than changed blind from a TS-side patch.
 *
 * Guarded against a cross-process lost update: the write publishes only over content this
 * process has proven it has seen — the bytes the last successful {@link readProjectFile}
 * parsed, or the bytes it last published itself.
 *
 *  - **Unknown path** → allowed. Save-as, a first save, and test fixtures have no baseline
 *    to protect, and refusing them would break saving rather than protect it.
 *  - **File absent** (a genuine `ENOENT`) → allowed. There is nothing to lose.
 *  - **Unreadable target** (`EACCES`, `EISDIR`, …) → refused. "I could not look" is not
 *    "there is nothing there"; overwriting an unknown target is exactly the mistake.
 *  - **Content differs** → refused with {@link ProjectFileConflictError}.
 *
 * The check runs as LATE as possible — after the temp file is serialized and fsynced,
 * immediately before the rename — so the unguarded window is one read plus one rename
 * rather than the tens of milliseconds a multi-megabyte serialize takes.
 *
 * A failed write, refusal, or rename removes its own temp file rather than leaving a
 * fragment beside the project.
 *
 * @param path - Absolute destination path.
 * @param project - A validated project.
 * @throws {ProjectFileConflictError} When the target no longer holds the content this
 *   process last saw, so publishing would erase another process's edit.
 */
export async function writeProjectFile(path: string, project: Project): Promise<void> {
  // Serialise publishes to one path within this process, so the compare-and-swap, the
  // rename and the baseline update are indivisible with respect to another writer here.
  // Without that, an overlapping writer can read the file AFTER a sibling's rename but
  // BEFORE that sibling records what it published, judge it against the older baseline,
  // and refuse a save that was never in conflict — a false "cannot save", which is the
  // worst outcome this module can produce.
  //
  // The lane does NOT make two in-process writers safe from each other: the registry
  // cannot tell them apart, so the second one's compare-and-swap passes against its
  // sibling's freshly published content. Ordering read-modify-write inside one process
  // stays the caller's job (the desktop's revision lane in `project-command-service-base`,
  // the single open document in the MCP session). This guard is about the OTHER process.
  //
  // `.catch()` on the predecessor is load-bearing: a write that FAILED must not leave a
  // rejected promise that poisons every later write to the file.
  const key = resolvePath(path);
  const prior = publishLanes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const lane = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.catch(() => undefined).then(() => lane);
  publishLanes.set(key, queued);
  await prior.catch(() => undefined);
  try {
    await publishProjectFile(key, path, project);
  } finally {
    release();
    if (publishLanes.get(key) === queued) publishLanes.delete(key);
  }
}

/** The serialize → fsync → compare-and-swap → rename publish, already inside the lane. */
async function publishProjectFile(key: string, path: string, project: Project): Promise<void> {
  const text = serializeProject(project);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  atomicWriteSeq += 1;
  const tempPath = `${path}.${String(process.pid)}.${String(atomicWriteSeq)}.tmp`;
  try {
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertPublishableOver(key, path);
    await rename(tempPath, path);
  } catch (error) {
    // Never leave a partial temp file behind (mirrors the Python writer). This covers the
    // refusal path too: a rejected save must not litter the project folder.
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  // Published: these bytes are now what this process knows is on disk.
  observedContent.set(key, digest(text));
  await syncDirectory(directory);
}

/**
 * Refuse to publish over content this process never saw.
 *
 * @throws {ProjectFileConflictError} When the target holds something else, or cannot be
 *   read to prove it does not.
 */
async function assertPublishableOver(key: string, path: string): Promise<void> {
  const expected = observedContent.get(key);
  // Fail open on an unknown path: this process has never read or written it, so it has no
  // edit here to lose. Save-as and first saves live in this branch.
  if (expected === undefined) return;

  let current: string;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return;
    throw new ProjectFileConflictError(
      path,
      `Refusing to save the project: ${path} could not be read to check it is safe to ` +
        `overwrite (${errorText(error)}). Saving blind could erase work written by the ` +
        `FramePilot app or another editing session. Fix access to that file, or save to a ` +
        `different path.`,
      { cause: error },
    );
  }

  if (digest(current) === expected) return;
  log.warn('refused project write over externally changed content', { path });
  throw new ProjectFileConflictError(
    path,
    `Refusing to save the project: ${path} changed on disk since this session last read ` +
      `it. Another writer — the FramePilot desktop app or an external agent editing the ` +
      `same project — saved it, and overwriting now would erase that edit. Reload the ` +
      `project from disk, re-apply this change on top of it, and save again.`,
  );
}

/**
 * fsync the directory so the rename itself survives a power cut, not just the data.
 *
 * Best effort by necessity: not every platform lets a directory be opened for sync
 * (Windows refuses outright). The project is ALREADY published by the time this runs, so a
 * failure here costs durability of the last rename, never the save — log it, do not throw.
 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    log.debug('could not fsync project directory', { directory, error: errorText(error) });
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
