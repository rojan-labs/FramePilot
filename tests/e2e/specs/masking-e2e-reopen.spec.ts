/**
 * E2E.2 — reopening a project with a background removal (plan/background-removal-ai/07, E2E.2).
 *
 *  1. With NO pack installed (this build cannot even download one), the project opens, the
 *     matte previews exactly as it exports, and the export succeeds: a finished background
 *     removal is project data, and packs are only needed to make a new one.
 *  2. With the matte's `matte.mkv` deleted, the clip shows BROKEN with the engine's remedy in
 *     the Inspector and the export dialog, and the export refuses with that same sentence.
 *
 * Real: the project file layer (open), the desktop's matte validation and re-check handlers,
 * the preview's matte decode, the engine export and its typed refusal (`MatteRefusal`).
 * SIMULATED: the artifact itself was written by the engine helper to the pack's output
 * contract (no pack exists in CI, MO-1..MO-5); Electron and `fp-media://` (`fake-desktop.ts`).
 *
 * CI ONLY (`masking-e2e` job).
 */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  masksOf,
  parseProject,
  type Project,
} from '../../../packages/timeline-schema/dist/index.js';
import { FakeDesktop } from './masking/fake-desktop.js';
import { expectPreviewMatchesExport } from './masking/parity.js';
import {
  COLOURS,
  attachDiagnostics,
  clip,
  clipsById,
  openInDesktop,
  openMaskTab,
  project,
  sidecarUrl,
  video,
  type OpenedEditor,
} from './masking/session.js';
import { Workspace } from './masking/workspace.js';

const SECONDS = 2;
/** `MATTE_REMEDIES['matte_missing']` in the engine (`render/mattes.py`), verbatim. */
const MISSING_REMEDY = 'Background removal data is missing — run Remove background again.';

/** A saved project whose subject clip already carries a finished, verified background removal. */
async function projectWithMatte(name: string): Promise<{ workspace: Workspace; key: string }> {
  const workspace = await Workspace.create(name);
  await workspace.media([video('subject', 'red', SECONDS), video('bg', 'blue', SECONDS)]);
  const base = project({
    id: name.replace(/-/g, '_'),
    name: 'E2E.2 Reopen',
    videos: [
      { id: 'subject', seconds: SECONDS },
      { id: 'bg', seconds: SECONDS },
    ],
    tracks: [
      {
        id: 'video_2',
        type: 'video',
        clips: [
          clip('video_2', { id: 'clip_subject', assetId: 'subject', start: 0, end: SECONDS }),
        ],
      },
      {
        id: 'video_1',
        type: 'video',
        clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
      },
    ],
  });
  // What an earlier session's Remove background left behind: the artifact and the host record.
  const maker = new FakeDesktop({ workspace, sidecarUrl: sidecarUrl() });
  const made = await maker.synthesiseMatte(
    { requestId: 'earlier-session', assetId: 'subject', sourceStart: 0, sourceEnd: SECONDS },
    base,
    { foreground: COLOURS.red[0], projectRevision: 1 },
  );
  if (made.status !== 'completed') throw new Error('The seed matte was not made.');
  const withMatte = parseProject({
    ...base,
    timeline: {
      ...base.timeline,
      tracks: base.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((entry) =>
          entry.id !== 'clip_subject'
            ? entry
            : {
                ...entry,
                masks: [
                  {
                    id: 'clip_subject__matte',
                    name: 'Background removal',
                    kind: 'matte',
                    artifact: made.artifact,
                    prompts: [],
                    review: { flagged: [], approved: [], locked: [] },
                  },
                ],
              },
        ),
      })),
    },
  });
  await workspace.writeProject(withMatte);
  return { workspace, key: made.artifact.key };
}

const matteOn = (document: Project) =>
  masksOf(clipsById(document).get('clip_subject')!).find((mask) => mask.kind === 'matte');

let opened: OpenedEditor | null = null;
test.afterEach(async ({}, testInfo) => {
  await attachDiagnostics(testInfo, opened);
  opened = null;
});

test.describe('E2E.2 reopening a project with a background removal', () => {
  test.describe.configure({ timeout: 5 * 60_000 });

  test('with no pack installed it previews as it exports, and exports', async ({
    page,
  }, testInfo) => {
    const { workspace } = await projectWithMatte('e2e2-no-packs');
    opened = await openInDesktop(
      page,
      testInfo,
      {
        workspace,
        sidecarUrl: sidecarUrl(),
        packs: {
          'subject.matte': 'catalog_unconfigured',
          'subject.detect': 'catalog_unconfigured',
          'tracking.region': 'catalog_unconfigured',
        },
      },
      'E2E.2 Reopen',
    );
    const answersBefore = opened.desktop.results.length;
    await openMaskTab(page, 'clip_subject');
    const row = page.getByLabel('Background removal', { exact: true });
    // Reopened, the matte is re-checked through main: neither stale nor broken.
    expect(await opened.desktop.recheckAfter(answersBefore)).toEqual([]);
    // New removals need the pack, and the editor is told so; the finished one is untouched.
    const warning = page.locator('#background-removal-pack-note');
    await expect(warning).toContainText("Smart Mask can't be installed from this build.");
    await expect(
      row.getByRole('button', { name: 'Remove background', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('listbox', { name: 'Masks', exact: true }).locator('li.mask-list-row'),
    ).toHaveCount(1);
    await expect(
      page.getByLabel('Review', { exact: true }).getByText('VERIFIED', { exact: true }),
    ).toBeVisible();
    await expect(row.getByRole('alert')).toHaveCount(0);

    await expectPreviewMatchesExport(page, workspace, [0.5, 1.5], 'e2e2-no-packs', testInfo);

    await page.getByRole('button', { name: 'Export video', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export video', exact: true });
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Exported.', { timeout: 120_000 });
    const engine = opened.desktop.exports.at(-1)!.result.engine as {
      state: string;
      validation: { ok: boolean };
      probe: { durationSeconds: number };
    };
    expect(engine.state).toBe('completed');
    expect(engine.validation.ok).toBe(true);
    expect(engine.probe.durationSeconds).toBeCloseTo(SECONDS, 1);
    // Nothing asked for a pack along the way.
    expect(
      opened.desktop.calls.filter((call) => call.method === 'capabilityPackMatte'),
    ).toHaveLength(0);
    expect(
      opened.desktop.calls.filter((call) => call.method === 'capabilityPackInstall'),
    ).toHaveLength(0);
  });

  test('with the matte deleted the clip is BROKEN and the export refuses with the remedy', async ({
    page,
  }, testInfo) => {
    const { workspace, key } = await projectWithMatte('e2e2-matte-deleted');
    await rm(join(workspace.projectDir, '.framepilot-derived', 'mattes', key, 'matte.mkv'));
    opened = await openInDesktop(
      page,
      testInfo,
      { workspace, sidecarUrl: sidecarUrl() },
      'E2E.2 Reopen',
    );
    await openMaskTab(page, 'clip_subject');
    const row = page.getByLabel('Background removal', { exact: true });
    // The mask is still there (the project says what the editor made), marked with the remedy.
    expect(matteOn(await workspace.readProject())).toBeDefined();
    await expect(row.getByRole('alert')).toHaveText(MISSING_REMEDY, { timeout: 20_000 });

    await page.getByRole('button', { name: 'Export video', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export video', exact: true });
    await expect(dialog.getByRole('alert').filter({ hasText: MISSING_REMEDY })).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    // The render refuses before any frame, with the SAME sentence (engine MatteRefusal).
    await expect
      .poll(() => opened!.desktop.exports.length, { timeout: 120_000 })
      .toBeGreaterThan(0);
    const engine = opened.desktop.exports.at(-1)!.result.engine as {
      state: string;
      error: string;
      outputPath: string | null;
    };
    expect(engine.state).toBe('failed');
    expect(engine.error).toBe(MISSING_REMEDY);
    expect(engine.outputPath).toBeNull();
    await expect(
      dialog.locator('.export-status--error').getByText(MISSING_REMEDY, { exact: true }),
    ).toBeVisible();
  });
});
