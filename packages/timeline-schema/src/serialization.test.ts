/**
 * Round-trip + golden-fixture tests for project serialization (PLAN §1.1).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseProject, SCHEMA_VERSION, type Project } from './index.js';
import { deserializeProject, serializeProject } from './serialization.js';

const goldenText = readFileSync(
  fileURLToPath(new URL('./__fixtures__/demo.project.fp.json', import.meta.url)),
  'utf8',
);

describe('serialization round-trip', () => {
  it('serialize → deserialize reproduces the project exactly', () => {
    const project = deserializeProject(goldenText);
    const restored = deserializeProject(serializeProject(project));
    expect(restored).toEqual(project);
  });

  it('stamps the current schemaVersion envelope and strips it on parse', () => {
    const project = deserializeProject(goldenText);
    const text = serializeProject(project);
    expect(JSON.parse(text).schemaVersion).toBe(SCHEMA_VERSION);
    // The validated Project never carries the envelope field.
    expect((project as unknown as { schemaVersion?: number }).schemaVersion).toBeUndefined();
  });
});

describe('golden fixture', () => {
  it('parses to the expected project', () => {
    const project = deserializeProject(goldenText);
    expect(project.name).toBe('Demo Video');
    expect(project.timeline.tracks.map((t) => t.type)).toEqual([
      'video',
      'audio',
      'caption',
      'overlay',
    ]);
    expect(project.timeline.tracks[0]!.clips[0]!.id).toBe('clip_001');
  });

  it('deserialized fixture is itself a valid Project', () => {
    const project: Project = deserializeProject(goldenText);
    expect(() => parseProject(project)).not.toThrow();
  });
});

describe('deserialize errors', () => {
  it('throws on non-object JSON', () => {
    expect(() => deserializeProject('[]')).toThrow(/must contain a JSON object/);
    expect(() => deserializeProject('42')).toThrow(/must contain a JSON object/);
    expect(() => deserializeProject('null')).toThrow(/must contain a JSON object/);
  });

  it('propagates JSON syntax errors', () => {
    expect(() => deserializeProject('{ not json')).toThrow(SyntaxError);
  });
});
