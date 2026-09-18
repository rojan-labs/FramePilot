/**
 * E2E.5 — a v21 project with masks opens, migrates with a backup, and exports byte-identically
 * (plan/background-removal-ai/07, E2E.5; 12 §B P8).
 *
 * The project is written as a v21 file (`mask` effects, `schemaVersion: 21`) from the MK2.4
 * fixture cases (`tests/fixtures/mask-render/legacy-v21.json`), laid end to end on one track
 * over a background, and opened from the Home screen as an editor would. Then:
 *
 *  - the desktop open path (`readProjectFile({ backupBeforeMigration: true })`) wrote
 *    `project.v21.backup.fp.json` beside it, byte-identical to the original, and a save keeps it;
 *  - the editor shows each clip's migrated mask stack;
 *  - the Export dialog saves the project in the current schema and the engine exports it;
 *  - that export is BYTE-IDENTICAL to the reference: the same migrated file rendered with each
 *    clip's alpha drawn by the v21 renderer's own functions (`rasterize_mask(mask_spec_at(...))`,
 *    still in `render/masks.py`; `legacy-export` in `engine/python/tests/masking_e2e_engine.py`).
 *    There is no v21 build to run, so that is the closest honest reference: everything but the
 *    mask step is the same code both ways. Software encode on both sides (a hardware encoder is
 *    not bit-reproducible).
 *
 * Simulated: Electron and `fp-media://` only (`masking/fake-desktop.ts`). CI ONLY.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seekTo } from './helpers.js';
import { REPO, Workspace } from './masking/workspace.js';
import {
  attachDiagnostics,
  openInDesktop,
  openMaskTab,
  sidecarUrl,
  type OpenedEditor,
} from './masking/session.js';

interface LegacyFixture {
  readonly clipTemplate: Record<string, unknown>;
  readonly cases: readonly { readonly id: string; readonly clip: Record<string, unknown> }[];
}
const FIXTURE = JSON.parse(
  readFileSync(join(REPO, 'tests', 'fixtures', 'mask-render', 'legacy-v21.json'), 'utf8'),
) as LegacyFixture;

const WIDTH = 320;
const HEIGHT = 240;
const MEDIA_SECONDS = 8;

/** The timeline clip id `v21Project` gives a fixture case. */
const clipIdOf = (caseId: string): string => `c_${caseId.replace(/-/g, '_')}`;

/** A v21 project: one clip per fixture case, one second each, end to end over a background. */
function v21Project(name: string, caseIds: readonly string[], firstStart: number): string {
  const clips = caseIds.map((caseId, index) => {
    const fixture = FIXTURE.cases.find((entry) => entry.id === caseId);
    if (fixture === undefined) throw new Error(`No legacy fixture case ${caseId}`);
    const start = firstStart + index;
    return {
      ...FIXTURE.clipTemplate,
      ...fixture.clip,
      id: clipIdOf(caseId),
      assetId: 'shot',
      trackId: 'v1',
      start,
      end: start + 1,
      sourceStart: 1 + index * 0.5,
      sourceEnd: 2 + index * 0.5,
    };
  });
  const end = firstStart + caseIds.length;
  return `${JSON.stringify(
    {
      schemaVersion: 21,
      id: name.replace(/-/g, '_'),
      name: 'E2E.5 Legacy masks',
      version: 1,
      fps: 30,
      resolution: { width: WIDTH, height: HEIGHT },
      assets: [
        {
          id: 'shot',
          path: 'media/shot.mp4',
          kind: 'video',
          durationSeconds: MEDIA_SECONDS,
          media: { width: WIDTH, height: HEIGHT },
        },
        {
          id: 'bg',
          path: 'media/bg.mp4',
          kind: 'video',
          durationSeconds: MEDIA_SECONDS,
          media: { width: WIDTH, height: HEIGHT },
        },
      ],
      timeline: {
        tracks: [
          { id: 'v1', type: 'video', clips },
          {
            id: 'v0',
            type: 'video',
            clips: [
              {
                id: 'c_bg',
                assetId: 'bg',
                trackId: 'v0',
                start: 0,
                end,
                sourceStart: 0,
                sourceEnd: end,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
      transcript: [],
      markers: [],
      aiMemory: {},
      history: [],
    },
    null,
    2,
  )}\n`;
}

async function sentinelMedia(workspace: Workspace): Promise<void> {
  const shot = { width: WIDTH, height: HEIGHT, fps: 30, seconds: MEDIA_SECONDS };
  await workspace.media([
    { path: 'media/shot.mp4', ...shot, primary: [236, 44, 44], secondary: [140, 44, 44] },
    { path: 'media/bg.mp4', ...shot, primary: [44, 44, 236], secondary: [44, 44, 140] },
  ]);
}

/** Open, check the backup, export through the dialog, and compare with the v21 reference. */
async function migrateAndExport(
  page: Page,
  testInfo: TestInfo,
  name: string,
  caseIds: readonly string[],
  firstStart: number,
  maskedClip: string,
): Promise<{ opened: OpenedEditor; exportSha: string; referenceSha: string }> {
  const workspace = await Workspace.create(name);
  await sentinelMedia(workspace);
  const original = v21Project(name, caseIds, firstStart);
  await workspace.writeProjectText(original);
  const opened = await openInDesktop(
    page,
    testInfo,
    { workspace, sidecarUrl: sidecarUrl() },
    'E2E.5 Legacy masks',
  );
  current = opened;

  // P8: the original bytes were copied aside before anything could rewrite the file.
  const backup = join(workspace.projectDir, 'project.v21.backup.fp.json');
  expect(await readFile(backup, 'utf8')).toBe(original);

  // The migrated stack is what the editor shows. The monitor's mask canvas is mounted only for
  // the selected clip drawn under the playhead, so park the playhead inside that clip first
  // (each case clip is one second long, starting at `firstStart + index`).
  const maskedIndex = caseIds.findIndex((caseId) => clipIdOf(caseId) === maskedClip);
  if (maskedIndex < 0) throw new Error(`${maskedClip} is not one of the case clips.`);
  await seekTo(page, firstStart + maskedIndex + 0.5);
  await openMaskTab(page, maskedClip);
  await expect(
    page.getByRole('listbox', { name: 'Masks', exact: true }).locator('li.mask-list-row'),
  ).not.toHaveCount(0);

  // Export: the dialog saves the project (now current schema), then the engine renders it.
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export video', exact: true });
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Exported.', { timeout: 180_000 });
  const saved = JSON.parse(await workspace.readProjectText()) as { schemaVersion: number };
  expect(saved.schemaVersion).toBeGreaterThan(21);
  expect(await readFile(backup, 'utf8')).toBe(original);
  const engine = opened.desktop.exports.at(-1)!.result.engine as {
    state: string;
    validation: { ok: boolean };
    sha256: string;
  };
  expect(engine.state).toBe('completed');
  expect(engine.validation.ok).toBe(true);

  const v21Path = join(workspace.root, 'v21.fp.json');
  await (await import('node:fs/promises')).writeFile(v21Path, original);
  const reference = await workspace.legacyExport('v21-reference.mp4', v21Path);
  expect(reference.state, reference.errorDetail ?? '').toBe('completed');
  testInfo.annotations.push({
    type: 'E2E.5 export sha256',
    description: JSON.stringify({ migrated: engine.sha256, v21Reference: reference.sha256 }),
  });
  return { opened, exportSha: engine.sha256, referenceSha: reference.sha256! };
}

let current: OpenedEditor | null = null;
test.afterEach(async ({}, testInfo) => {
  await attachDiagnostics(testInfo, current);
  current = null;
});

test.describe('E2E.5 a v21 project with masks opens, migrates and exports byte-identically', () => {
  test.describe.configure({ timeout: 6 * 60_000 });

  test('static rectangle, ellipse, polygon, feathered/inverted and an ignored second mask', async ({
    page,
  }, testInfo) => {
    const { exportSha, referenceSha } = await migrateAndExport(
      page,
      testInfo,
      'e2e5-static',
      [
        'static-rectangle',
        'feathered-inverted-rectangle',
        'static-ellipse-feathered',
        'polygon',
        'second-mask-disabled',
      ],
      0,
      'c_second_mask_disabled',
    );
    // v21 rendered only the FIRST mask; the migration keeps the second, disabled, with a note.
    await expect(
      page.getByRole('listbox', { name: 'Masks', exact: true }).locator('li.mask-list-row'),
    ).toHaveCount(2);
    expect(exportSha).toBe(referenceSha);
  });

  test('a keyframed mask on a clip that starts mid-timeline', async ({ page }, testInfo) => {
    // Found by this spec (2026-09-18), fixed by MK2.5: off t = 0 the frame instants are not
    // round, and one frame in 30 drew an edge a pixel off. The stored centre is not one-to-one
    // with v21's fractions (x = 0.19999999999999996 and 0.2 store the same centre, yet v21 drew
    // `x * width`: 63.99999999999999 vs 64.0), so the migration now keeps the v21 spec itself
    // (`legacySpec`) and the export draws from it. `test_mask_legacy_render.py` pins this clip
    // (`keyframed-ellipse-mid-timeline`) and 24 more mid-timeline timings at every frame.
    const { exportSha, referenceSha } = await migrateAndExport(
      page,
      testInfo,
      'e2e5-keyframed',
      ['keyframed-ellipse'],
      4,
      'c_keyframed_ellipse',
    );
    expect(exportSha).toBe(referenceSha);
  });
});
