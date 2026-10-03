/**
 * Every project in the projects folder, one page at a time, for the home screen.
 *
 * WHY: the home screen used to show only the recently-opened list (ten entries), so a
 * project copied into the folder, or one not opened lately, could only be reached through
 * the file picker. This lists the folder itself: recently opened projects first, in the
 * order the recents list keeps, then every other project by last change, newest first.
 *
 * All file IO is injected ({@link ProjectListIO}) so ordering, exclusions, dedupe and paging
 * are unit-testable and this module stays free of `electron`/`fs` imports. The IO is
 * responsible for the path sandbox: every path it touches resolves inside the projects root.
 *
 * Cost: every request reads the root's top level and stats each project file (needed to sort
 * by last change), but it reads file contents only for the entries on the returned page, and
 * then only the first {@link NAME_PROBE_BYTES} of each. Project files run to several MB (and a
 * history-heavy one far larger), so parsing them to draw a list is never an option.
 */
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import type {
  ProjectListEntry,
  ProjectListRequest,
  ProjectListResult,
  RecentProject,
} from '../ipc/contract.js';

const log = createLogger('desktop:project-list');

/** The extension every FramePilot project file carries. */
const PROJECT_FILE_SUFFIX = '.fp.json';

/**
 * Pre-migration copies (`<project>.v<N>.backup.fp.json`, ADR 0178) end with this. They are
 * the user's way back from a format upgrade, not projects to open from the home screen.
 */
const BACKUP_FILE_SUFFIX = '.backup.fp.json';

/** Most entries one request may ask for; a larger `limit` is capped, not refused. */
export const PROJECT_LIST_MAX_LIMIT = 50;

/**
 * How much of a project file is read to find its name. The writer puts `name` third, after
 * `schemaVersion` and `id`, within the first hundred bytes; 64 KiB leaves room for a
 * hand-edited file with other keys first while bounding a full page to
 * {@link PROJECT_LIST_MAX_LIMIT} × 64 KiB of reads.
 */
export const NAME_PROBE_BYTES = 64 * 1024;

/** A regular project file inside the projects root. */
export interface ProjectFileInfo {
  /** Absolute path, resolved inside the projects root. */
  readonly path: string;
  /**
   * Identity of the file on disk. Two paths that reach the same file (a recents entry and
   * the folder listing, a symlink and its target) share it, which is how they are deduped.
   */
  readonly fileKey: string;
  /** Last modification, epoch milliseconds. */
  readonly modifiedAt: number;
}

/** File access for one projects root. Every path it touches resolves inside that root. */
export interface ProjectListIO {
  /** Names of the root's top-level entries. Throws when the root is missing or unreadable. */
  readRootNames(): Promise<readonly string[]>;
  /**
   * The file at `candidate` (a bare top-level name or an absolute path), or `null` when it
   * escapes the root, does not exist, or is not a regular file.
   */
  statProjectFile(candidate: string): Promise<ProjectFileInfo | null>;
  /** Up to `maxBytes` from the start of a file inside the root, decoded as UTF-8. */
  readHead(filePath: string, maxBytes: number): Promise<string>;
}

/** The full list and how many projects it holds. */
export interface ProjectListPage {
  readonly entries: ProjectListEntry[];
  readonly total: number;
}

/** A listed project before its page is chosen; a folder entry's name is not read yet. */
type ListedProject =
  | { readonly kind: 'recent'; readonly entry: ProjectListEntry }
  | { readonly kind: 'folder'; readonly file: ProjectFileInfo };

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * True for a file name the list shows: a `.fp.json` project that is neither a dotfile nor a
 * pre-migration backup. Case-insensitive, as the default macOS file system is.
 */
export function isListableProjectFileName(fileName: string): boolean {
  if (fileName.startsWith('.')) return false;
  const lower = fileName.toLowerCase();
  return lower.endsWith(PROJECT_FILE_SUFFIX) && !lower.endsWith(BACKUP_FILE_SUFFIX);
}

/** The file name without its `.fp.json` extension, shown when a project's name can't be read. */
export function projectFileStem(filePath: string): string {
  const fileName = path.basename(filePath);
  return fileName.toLowerCase().endsWith(PROJECT_FILE_SUFFIX)
    ? fileName.slice(0, -PROJECT_FILE_SUFFIX.length)
    : fileName;
}

/**
 * Validate a renderer-supplied page request. The renderer is untrusted, so anything but
 * whole numbers (`offset` ≥ 0, `limit` ≥ 1) is refused; `limit` is capped at
 * {@link PROJECT_LIST_MAX_LIMIT}.
 *
 * @returns The request to serve, or `null` when it is malformed.
 */
export function parseProjectListRequest(request: unknown): ProjectListRequest | null {
  if (typeof request !== 'object' || request === null) return null;
  const { offset, limit } = request as Record<string, unknown>;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return null;
  return { offset, limit: Math.min(limit, PROJECT_LIST_MAX_LIMIT) };
}

/** Index of the `"` closing the JSON string that opens at `open`, or -1 if it is cut off. */
function closingQuote(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '\\') index += 1;
    else if (ch === '"') return index;
  }
  return -1;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && WHITESPACE.has(text[index]!)) index += 1;
  return index;
}

/** Decode one JSON string literal (quotes included), or `null` when it is malformed. */
function decodeJsonString(literal: string): string | null {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The top-level `name` string from the START of a project file, which is usually not valid
 * JSON on its own (it is cut off at {@link NAME_PROBE_BYTES}).
 *
 * Scans rather than parses: tracks string state and nesting depth so a `name` key inside an
 * asset or clip is never mistaken for the project's own. Returns `null` when the head is not
 * a JSON object, the key is absent or cut off, or its value is not a non-empty string.
 */
export function readTopLevelName(head: string): string | null {
  const start = skipWhitespace(head, 0);
  if (head[start] !== '{') return null;
  let depth = 0;
  for (let index = start; index < head.length; index += 1) {
    const ch = head[index];
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth <= 0) return null;
    } else if (ch === '"') {
      const end = closingQuote(head, index);
      if (end === -1) return null;
      const colon = skipWhitespace(head, end + 1);
      // A depth-1 string followed by `:` is a top-level key; values are followed by `,`/`}`.
      if (
        depth === 1 &&
        head[colon] === ':' &&
        decodeJsonString(head.slice(index, end + 1)) === 'name'
      ) {
        const valueStart = skipWhitespace(head, colon + 1);
        if (head[valueStart] !== '"') return null;
        const valueEnd = closingQuote(head, valueStart);
        if (valueEnd === -1) return null;
        const name = decodeJsonString(head.slice(valueStart, valueEnd + 1))?.trim();
        return name ? name : null;
      }
      index = end;
    }
  }
  return null;
}

/** A project's display name from its file head; the file name when that fails. Never throws. */
async function readDisplayName(io: ProjectListIO, filePath: string): Promise<string> {
  try {
    const name = readTopLevelName(await io.readHead(filePath, NAME_PROBE_BYTES));
    if (name !== null) return name;
    log.debug('project name not found in file head; showing the file name', { path: filePath });
  } catch (error) {
    log.debug('project name unreadable; showing the file name', {
      path: filePath,
      error: errorText(error),
    });
  }
  return projectFileStem(filePath);
}

/** `statProjectFile`, with an unexpected IO failure costing only that one entry. */
async function statOrNull(io: ProjectListIO, candidate: string): Promise<ProjectFileInfo | null> {
  try {
    return await io.statProjectFile(candidate);
  } catch (error) {
    log.debug('project file skipped: stat failed', { candidate, error: errorText(error) });
    return null;
  }
}

/** Recents that are still project files inside the root, in recents order, deduped. */
async function listedRecents(
  io: ProjectListIO,
  recents: readonly RecentProject[],
  seen: Set<string>,
): Promise<ListedProject[]> {
  const candidates = recents.filter((recent) =>
    isListableProjectFileName(path.basename(recent.path)),
  );
  const files = await Promise.all(candidates.map((recent) => statOrNull(io, recent.path)));
  const listed: ListedProject[] = [];
  candidates.forEach((recent, index) => {
    const file = files[index];
    if (!file || seen.has(file.fileKey)) return;
    seen.add(file.fileKey);
    // The recents path, not the resolved one: opening it then behaves exactly as before.
    listed.push({
      kind: 'recent',
      entry: { path: recent.path, name: recent.name, lastActiveAt: recent.openedAt, recent: true },
    });
  });
  return listed;
}

/** Project files at the root's top level that are not already listed, newest change first. */
async function listedFolderFiles(
  io: ProjectListIO,
  rootNames: readonly string[],
  seen: Set<string>,
): Promise<ListedProject[]> {
  const stats = await Promise.all(
    rootNames.filter(isListableProjectFileName).map((name) => statOrNull(io, name)),
  );
  const files = stats.filter((file): file is ProjectFileInfo => file !== null);
  // Sorted before deduping, with the path breaking ties, so equal timestamps page in the same
  // order on every request and the same spelling of a twice-reachable file always wins.
  files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  const listed: ListedProject[] = [];
  for (const file of files) {
    if (seen.has(file.fileKey)) continue;
    seen.add(file.fileKey);
    listed.push({ kind: 'folder', file });
  }
  return listed;
}

async function toEntry(io: ProjectListIO, item: ListedProject): Promise<ProjectListEntry> {
  if (item.kind === 'recent') return item.entry;
  return {
    path: item.file.path,
    name: await readDisplayName(io, item.file.path),
    lastActiveAt: item.file.modifiedAt,
    recent: false,
  };
}

/**
 * One page of the projects folder: recents first, then the rest by last change.
 *
 * @param io - File access for the projects root (sandboxed).
 * @param recents - The recently-opened list, most recent first.
 * @param request - A validated page request (see {@link parseProjectListRequest}).
 * @returns The page's entries and the total listed. A missing or unreadable root lists nothing.
 */
export async function listProjectPage(
  io: ProjectListIO,
  recents: readonly RecentProject[],
  request: ProjectListRequest,
): Promise<ProjectListPage> {
  let rootNames: readonly string[];
  try {
    rootNames = await io.readRootNames();
  } catch (error) {
    log.warn('projects folder unreadable; listing no projects', { error: errorText(error) });
    return { entries: [], total: 0 };
  }
  const seen = new Set<string>();
  const ordered = [
    ...(await listedRecents(io, recents, seen)),
    ...(await listedFolderFiles(io, rootNames, seen)),
  ];
  const page = ordered.slice(request.offset, request.offset + request.limit);
  const entries = await Promise.all(page.map((item) => toEntry(io, item)));
  return { entries, total: ordered.length };
}

/**
 * The `projectList` IPC handler body: validate the untrusted request, then list.
 *
 * @param request - Whatever the renderer sent.
 * @param io - File access for the projects root (sandboxed).
 * @param loadRecents - The recently-opened list. If it can't be read the folder is still listed.
 */
export async function serveProjectList(
  request: unknown,
  io: ProjectListIO,
  loadRecents: () => Promise<readonly RecentProject[]>,
): Promise<ProjectListResult> {
  const page = parseProjectListRequest(request);
  if (page === null) {
    return {
      ok: false,
      error: 'Project list request needs a whole-number offset (0 or more) and limit (1 or more).',
    };
  }
  let recents: readonly RecentProject[] = [];
  try {
    recents = await loadRecents();
  } catch (error) {
    log.warn('recent projects unreadable; listing the folder alone', { error: errorText(error) });
  }
  const { entries, total } = await listProjectPage(io, recents, page);
  return { ok: true, entries, total };
}
