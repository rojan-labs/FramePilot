/**
 * The v21 → v22 migration of the legacy mask render fixtures (MK2.4).
 *
 * `tests/fixtures/mask-render/legacy-v21.json` holds v21 clips with `mask` effects. This test
 * migrates each through the real `migrateMaskEffectsToStack` and pins the result in
 * `legacy-v21.migrated.json` (regenerate with `vitest -u`). The engine's
 * `test_mask_legacy_render.py` then requires the migrated stack to rasterise byte-identically
 * to the v21 renderer, so the byte-identity claim is about what the app actually migrates.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { migrateMaskEffectsToStack } from './mask-migration.js';

type Raw = Record<string, unknown>;

const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/mask-render/', import.meta.url));

interface LegacyFixture {
  readonly media: Raw;
  readonly clipTemplate: Raw;
  readonly cases: readonly { id: string; media?: Raw | null; clip: Raw }[];
}

it('pins the migrated mask stack of every legacy render fixture', async () => {
  const fixture = JSON.parse(
    readFileSync(`${FIXTURE_DIR}legacy-v21.json`, 'utf8'),
  ) as LegacyFixture;
  const migrated = fixture.cases.map((entry) => {
    const media = entry.media === undefined ? fixture.media : entry.media;
    const clip = { ...fixture.clipTemplate, ...entry.clip };
    const raw: Raw = {
      schemaVersion: 21,
      assets: [{ id: 'a1', path: 'a.mp4', kind: 'video', ...(media ? { media } : {}) }],
      timeline: { tracks: [{ id: 'v1', type: 'video', clips: [clip] }] },
    };
    const out = migrateMaskEffectsToStack(raw) as { timeline: { tracks: { clips: Raw[] }[] } };
    return { id: entry.id, clip: out.timeline.tracks[0]!.clips[0]! };
  });
  await expect(`${JSON.stringify({ cases: migrated }, null, 2)}\n`).toMatchFileSnapshot(
    `${FIXTURE_DIR}legacy-v21.migrated.json`,
  );
});
