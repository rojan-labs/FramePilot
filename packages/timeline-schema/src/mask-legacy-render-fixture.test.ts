/**
 * The v21 → v22 migration of the legacy mask render fixtures (MK2.4).
 *
 * `tests/fixtures/mask-render/legacy-v21.json` holds v21 clips with `mask` effects. This test
 * migrates each through the real `migrateMaskEffectsToStack` and pins the result in
 * `legacy-v21.migrated.json` (regenerate with `vitest -u`). The engine's
 * `test_mask_legacy_render.py` then requires the migrated stack to rasterise byte-identically
 * to the v21 renderer, so the byte-identity claim is about what the app actually migrates.
 *
 * The `timings` variants (MK2.5) re-time the moving cases to 1 s clips that start mid-timeline at
 * several frame rates, where the frame instants (`n / fps - start`) are not round and a stored
 * centre stops being one-to-one with v21's fractions. They are written compactly, one clip per
 * line, to `legacy-v21.timings.migrated.json`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { migrateMaskEffectsToStack } from './mask-migration.js';

type Raw = Record<string, unknown>;

const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/mask-render/', import.meta.url));

interface LegacyFixture {
  readonly fps: number;
  readonly media: Raw;
  readonly clipTemplate: Raw;
  readonly cases: readonly { id: string; media?: Raw | null; clip: Raw }[];
  readonly timings: {
    readonly cases: readonly string[];
    readonly duration: number;
    readonly variants: readonly { readonly start: number; readonly fps: number }[];
  };
}

const readFixture = (): LegacyFixture =>
  JSON.parse(readFileSync(`${FIXTURE_DIR}legacy-v21.json`, 'utf8')) as LegacyFixture;

/** The migrated clip of one v21 clip in a one-asset project at `fps`. */
function migrate(media: Raw | null | undefined, clip: Raw, fps: number): Raw {
  const raw: Raw = {
    schemaVersion: 21,
    fps,
    assets: [{ id: 'a1', path: 'a.mp4', kind: 'video', ...(media ? { media } : {}) }],
    timeline: { tracks: [{ id: 'v1', type: 'video', clips: [clip] }] },
  };
  const out = migrateMaskEffectsToStack(raw) as { timeline: { tracks: { clips: Raw[] }[] } };
  return out.timeline.tracks[0]!.clips[0]!;
}

it('pins the migrated mask stack of every legacy render fixture', async () => {
  const fixture = readFixture();
  const migrated = fixture.cases.map((entry) => {
    const media = entry.media === undefined ? fixture.media : entry.media;
    const clip = { ...fixture.clipTemplate, ...entry.clip };
    return { id: entry.id, clip: migrate(media, clip, fixture.fps) };
  });
  await expect(`${JSON.stringify({ cases: migrated }, null, 2)}\n`).toMatchFileSnapshot(
    `${FIXTURE_DIR}legacy-v21.migrated.json`,
  );
});

it('pins the migrated mask stack of every mid-timeline timing variant', async () => {
  const fixture = readFixture();
  const lines: string[] = [];
  for (const caseId of fixture.timings.cases) {
    const entry = fixture.cases.find((candidate) => candidate.id === caseId)!;
    const media = entry.media === undefined ? fixture.media : entry.media;
    for (const { start, fps } of fixture.timings.variants) {
      const clip = {
        ...fixture.clipTemplate,
        ...entry.clip,
        start,
        end: start + fixture.timings.duration,
      };
      const v22 = migrate(media, clip, fps);
      lines.push(JSON.stringify({ id: caseId, start, fps, v21: clip, clip: v22 }));
    }
  }
  await expect(`{"variants": [\n${lines.join(',\n')}\n]}\n`).toMatchFileSnapshot(
    `${FIXTURE_DIR}legacy-v21.timings.migrated.json`,
  );
});
