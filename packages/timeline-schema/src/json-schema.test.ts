/**
 * Guards the cross-language contract (`schema/project.schema.json`).
 *
 * The committed JSON Schema is the artifact the Python Pydantic models mirror.
 * These tests fail if someone changes the Zod schema (the source of truth)
 * without regenerating the committed file, or if the contract no longer accepts
 * a real project document — the two ways the TS/PY schemas could silently drift.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProjectJsonSchema, parseProject } from './index.js';
import demoProject from './__fixtures__/demo.project.fp.json';

const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema',
  'project.schema.json',
);

const committed = JSON.parse(readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>;

describe('project JSON Schema (cross-language contract)', () => {
  it('matches the committed schema/project.schema.json (run `schema:generate` after editing the Zod schema)', () => {
    expect(buildProjectJsonSchema()).toEqual(committed);
  });

  it('declares every top-level Project field as a JSON Schema property', () => {
    const properties = (committed.properties ?? {}) as Record<string, unknown>;
    // `schemaVersion` is the file *envelope*, not part of Project, so it is not a
    // schema property; every other top-level fixture key must be declared.
    const documentKeys = Object.keys(demoProject).filter((key) => key !== 'schemaVersion');
    for (const key of documentKeys) {
      expect(properties, `missing JSON Schema property: ${key}`).toHaveProperty(key);
    }
  });

  it('describes a draft-2020-12 object schema', () => {
    expect(committed.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(committed.type).toBe('object');
  });

  it('still accepts the demo project document under the Zod source of truth', () => {
    // `parseProject` ignores the envelope's extra `schemaVersion` key.
    expect(() => parseProject(demoProject)).not.toThrow();
  });
});
