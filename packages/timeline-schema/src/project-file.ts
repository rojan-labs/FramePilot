/**
 * @framepilot/timeline-schema/project-file — Node-only atomic reader/writer for
 * `project.fp.json` (PLAN §1.1: "file format reader/writer (atomic writes)").
 *
 * Imports `node:fs`, so it is exposed only via the package's `./file` subpath and
 * never from the browser-safe barrel (`index.ts`).
 *
 * Writes are atomic: the JSON is written to a sibling temp file which is then
 * `rename`d over the target. `rename` is atomic on the same filesystem, so a
 * crash mid-write can never leave a half-written, unparseable project file.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from './index.js';
import { deserializeProject, serializeProject } from './serialization.js';

const log = createLogger('timeline-schema:project-file');

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
 * @param path - Absolute path to a `project.fp.json` file.
 * @returns The validated, current-schema project.
 */
export async function readProjectFile(path: string): Promise<Project> {
  const text = await readFile(path, 'utf8');
  if (text.length <= MAX_PARSED_PROJECT_BYTES) return deserializeProject(text);

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
  return deserializeProject(withoutHistory);
}

/**
 * Atomically write a project to disk as `project.fp.json`.
 *
 * @param path - Absolute destination path.
 * @param project - A validated project.
 */
export async function writeProjectFile(path: string, project: Project): Promise<void> {
  const text = serializeProject(project);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, text, 'utf8');
  await rename(tempPath, path);
}
