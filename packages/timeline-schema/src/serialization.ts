/**
 * @framepilot/timeline-schema/serialization — pure (filesystem-free) conversion
 * between a {@link Project} and its `project.fp.json` text form (PLAN §1.1).
 *
 * Kept free of `node:fs` so it is safe to bundle in the browser editor. The
 * Node-only atomic reader/writer lives in `project-file.ts`.
 */
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
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...project }, null, JSON_INDENT);
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
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('project.fp.json must contain a JSON object.');
  }
  const { raw } = migrateToCurrent(parsed as RawProject);
  return parseProject(raw);
}
