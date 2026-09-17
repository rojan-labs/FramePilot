/**
 * @framepilot/timeline-schema/serialization — pure (filesystem-free) conversion
 * between a {@link Project} and its `project.fp.json` text form (PLAN §1.1).
 *
 * Kept free of `node:fs` so it is safe to bundle in the browser editor. The
 * Node-only atomic reader/writer lives in `project-file.ts`.
 */
import { encodeFloat64Array } from './float-array-codec.js';
import { parseProject, SCHEMA_VERSION, type Project } from './index.js';
import { migrateToCurrent, type RawProject } from './migrations.js';

/** Pretty-print indentation for `project.fp.json` (human-diffable). */
const JSON_INDENT = 2;

/**
 * Serialize a validated project to its on-disk JSON text, stamping the current
 * {@link SCHEMA_VERSION} envelope field.
 *
 * @param project - A validated project.
 * @returns Deterministic, pretty-printed JSON.
 */
export function serializeProject(project: Project): string {
  if (lastSerialized !== null && lastSerialized.project === project) return lastSerialized.text;
  const text = stringifyWithInlineNumberArrays({ schemaVersion: SCHEMA_VERSION, ...project });
  lastSerialized = { project, text };
  return text;
}

/**
 * Number arrays at least this long are written on ONE line (MK4.6).
 *
 * WHY: a rotoscoped path stores six numbers per vertex per keyframe (ADR 0178). Pretty-printed
 * one number per line, 1,000 keyframes of 200 vertices were a 55 MB file and a 350 ms write,
 * missing the 250 ms save budget (plan 06). Inline, the same document is about a third of the
 * size. Short arrays (bezier handles, crop tuples) keep the familiar layout, so ordinary
 * projects serialise byte-identically to before.
 */
const INLINE_NUMBER_ARRAY_MIN_LENGTH = 16;

/**
 * Path keyframe arrays at least this long (64 vertices of six numbers) are written in the exact
 * `f64le:` binary form instead of decimals: formatting a million decimals alone takes ~120 ms,
 * the whole save budget's half. Short paths stay readable decimals.
 */
const BINARY_MIN_LENGTH = 384;
const BINARY_FIELDS: ReadonlySet<string> = new Set(['points', 'featherPx']);

/**
 * The last project serialised and its text.
 *
 * WHY: one desktop save serialises the SAME validated project object several times (revision
 * fingerprint, watcher self-write mark, the atomic write). Projects are immutable values (every
 * edit builds a new object), so identity is a safe key; one entry bounds the memory to the
 * document being saved.
 */
let lastSerialized: { readonly project: Project; readonly text: string } | null = null;

function isLongNumberArray(value: readonly unknown[]): value is readonly number[] {
  if (value.length < INLINE_NUMBER_ARRAY_MIN_LENGTH) return false;
  for (const item of value) if (typeof item !== 'number') return false;
  return true;
}

function stringifyWithInlineNumberArrays(document: unknown): string {
  const inlined: string[] = [];
  // Swap long number arrays for placeholders BEFORE stringifying, rather than through a
  // `JSON.stringify` replacer: a replacer is called for every one of the million numbers.
  // Placeholder: a whole string value of U+0001, digits, U+0001. JSON.stringify escapes the
  // control character, so only such a string (never typed by an editor) could look the same.
  const swap = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) {
      const items = value as unknown[];
      if (isLongNumberArray(items)) {
        if (BINARY_FIELDS.has(key) && items.length >= BINARY_MIN_LENGTH) {
          return encodeFloat64Array(items);
        }
        inlined.push(JSON.stringify(items));
        return `\u0001${String(inlined.length - 1)}\u0001`;
      }
      return items.map((item) => swap(item, ''));
    }
    if (value === null || typeof value !== 'object') return value;
    const copy: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(value)) copy[field] = swap(item, field);
    return copy;
  };
  const pretty = JSON.stringify(swap(document, ''), null, JSON_INDENT);
  if (inlined.length === 0) return pretty;
  return pretty.replace(
    /"\\u0001(\d+)\\u0001"/g,
    (_match, index: string) => inlined[Number(index)]!,
  );
}

/**
 * Parse, migrate, and validate `project.fp.json` text into a {@link Project}.
 *
 * @param text - Raw file contents.
 * @returns A migrated, validated project.
 * @throws {SyntaxError} when the text is not valid JSON.
 * @throws {RangeError} when the file is newer than this build or a migration is missing.
 * @throws {import('zod').ZodError} when the migrated shape fails validation.
 */
export function deserializeProject(text: string): Project {
  return projectFromDocument(parseProjectDocument(text));
}

/**
 * Parse `project.fp.json` text into its raw, unmigrated document.
 *
 * @throws {SyntaxError} when the text is not valid JSON.
 * @throws {TypeError} when the JSON is not an object.
 */
export function parseProjectDocument(text: string): RawProject {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('project.fp.json must contain a JSON object.');
  }
  return parsed as RawProject;
}

/** Migrate and validate an already-parsed raw document (see {@link deserializeProject}). */
export function projectFromDocument(document: RawProject): Project {
  const { raw } = migrateToCurrent(document);
  return parseProject(raw);
}
