/**
 * Elements · Stickers end to end (plan/elements EL6a): add the fire sticker from the Stickers tab,
 * replace it with a heart from the Inspector, export, check the monitor draws what the export
 * draws, undo it all; and open a project whose sticker file went missing to find it back.
 *
 * What is real: the editor (Elements → Stickers, the Inspector's Sticker section, History), main's
 * own `ElementsLibrary` copying the sticker the app ships into the project folder by id (and
 * healing it on open), and the export (`render()` with validation), read back through the same
 * parity gates as the PX4 oracle.
 *
 * SIMULATED, and why: Electron and `fp-media://` (see `masking/fake-desktop.ts`).
 *
 * CI ONLY (`elements-e2e` job): it renders.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  attachDiagnostics,
  clip,
  clipsById,
  expectValidExport,
  openInDesktop,
  project,
  savedProject,
  sidecarUrl,
  video,
  type OpenedEditor,
} from './masking/session.js';
import { expectPreviewMatchesExport } from './masking/parity.js';
import { REPO, Workspace } from './masking/workspace.js';
import type { Project } from '../../../packages/timeline-schema/dist/index.js';

const SECONDS = 3;
const FIRE = 'element_fluent3d_fire';
const HEART = 'element_fluent3d_red_heart';
const SHIPPED = join(REPO, 'apps', 'web-editor', 'public', 'elements', 'stickers', 'full');

/**
 * The Elements panel is desktop-only, so the browser `accessibility.spec` never reaches it: it is
 * scanned here, in both themes, with the same WCAG A/AA rules and none of that spec's owned
 * exceptions (plan/elements 13 §1).
 */
async function expectPanelAxeClean(page: Page, label: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const { violations } = await new AxeBuilder({ page })
      .include('.elements-panel')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      violations.map(({ id }) => id),
      `${label} (${colorScheme}): ${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: null });
}

const stickersOf = (document: Project) =>
  [...clipsById(document).values()].filter((entry) => entry.assetId.startsWith('element_'));

const sha256 = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

let opened: OpenedEditor | undefined;
test.afterEach(async ({}, testInfo) => {
  if (opened !== undefined) await attachDiagnostics(testInfo, opened);
  opened = undefined;
});

/** A project with one blue clip, and optionally a sticker already in its bin and on a lane. */
async function workspaceWith(
  name: string,
  id: string,
  sticker?: { readonly asset: Record<string, unknown>; readonly clip: Record<string, unknown> },
): Promise<Workspace> {
  const workspace = await Workspace.create(name);
  await workspace.media([video('bg', 'blue', SECONDS)]);
  const base = project({
    id,
    name: 'Elements stickers',
    videos: [{ id: 'bg', seconds: SECONDS }],
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
      },
    ],
  });
  await workspace.writeProject(
    sticker === undefined
      ? base
      : ({
          ...base,
          assets: [...base.assets, sticker.asset],
          timeline: {
            ...base.timeline,
            tracks: [
              { id: 'overlay_1', type: 'overlay', clips: [sticker.clip] },
              ...base.timeline.tracks,
            ],
          },
        } as unknown as Project),
  );
  return workspace;
}

test('Stickers: add the fire sticker, replace it with a heart, export, undo', async ({
  page,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const workspace = await workspaceWith('elements-stickers', 'elements_stickers');
  opened = await openInDesktop(
    page,
    testInfo,
    { workspace, sidecarUrl: sidecarUrl() },
    'Elements stickers',
  );
  const { desktop } = opened;

  // --- add: one click on the tile; main copies the file in, one patch places it ----------------
  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Stickers', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Add Fire', exact: true })).toBeVisible();
  await expectPanelAxeClean(page, 'Stickers');
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Shapes', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Add Highlight box', exact: true })).toBeVisible();
  await expectPanelAxeClean(page, 'Shapes');
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Stickers', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add Fire', exact: true }).click();
  const added = await savedProject(desktop, (doc) => stickersOf(doc).length === 1, 'one sticker');
  const sticker = stickersOf(added)[0]!;
  expect(sticker).toMatchObject({ assetId: FIRE, start: 0, end: SECONDS });
  const fire = added.assets.find((asset) => asset.id === FIRE)!;
  expect(fire.source?.provider).toBe('fluent-emoji');
  const copied = join(workspace.projectDir, fire.path);
  expect(await sha256(copied)).toBe(await sha256(join(SHIPPED, 'fire.webp')));

  // --- replace from the Inspector: the heart takes the fire's place, timing and size kept -------
  await page.getByRole('tab', { name: 'Inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Replace…', exact: true }).click();
  await expect(page.getByText('Pick a sticker to replace “Fire”.')).toBeVisible();
  await page.getByRole('button', { name: 'Use Red heart', exact: true }).click();
  const replaced = await savedProject(
    desktop,
    (doc) => stickersOf(doc)[0]?.assetId === HEART,
    'the sticker replaced with a heart',
  );
  expect(stickersOf(replaced)).toHaveLength(1);
  expect(stickersOf(replaced)[0]).toEqual({ ...sticker, assetId: HEART });

  // --- export: valid, and the monitor draws the engine's own pixels ----------------------------
  expectValidExport(await workspace.export('stickers.mp4'), SECONDS);
  await expectPreviewMatchesExport(page, workspace, [0.5, 1.5], 'stickers', testInfo);

  // --- undo: replace, add — the sticker is gone and the footage untouched -----------------------
  const undo = page
    .getByRole('toolbar', { name: 'editor tools', exact: true })
    .getByRole('button', { name: 'Undo', exact: true });
  for (let step = 0; step < 2; step += 1) await undo.click();
  const undone = await savedProject(
    desktop,
    (doc) => stickersOf(doc).length === 0,
    'the project with the sticker undone',
  );
  expect(clipsById(undone).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
});

test('Stickers: a sticker file that went missing is back when the project opens', async ({
  page,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const path = 'media/elements_heal/elements/fluent3d/fire.webp';
  const workspace = await workspaceWith('elements-stickers-heal', 'elements_heal', {
    asset: {
      id: FIRE,
      path,
      kind: 'image',
      media: { width: 318, height: 318 },
      source: {
        provider: 'fluent-emoji',
        remoteId: 'fire',
        license: 'mit',
        licenseUrl: 'https://github.com/microsoft/fluentui-emoji/blob/main/LICENSE',
        attributionRequired: false,
        attribution: 'Fluent Emoji by Microsoft (MIT)',
        creator: 'Microsoft',
        sourceUrl: 'https://github.com/microsoft/fluentui-emoji',
        fetchedAt: '2026-09-26T00:00:00.000Z',
      },
    },
    clip: clip('overlay_1', { id: 'clip_fire', assetId: FIRE, start: 0, end: SECONDS }),
  });
  const missing = join(workspace.projectDir, path);
  await rm(missing, { force: true });
  expect(existsSync(missing)).toBe(false);

  opened = await openInDesktop(
    page,
    testInfo,
    { workspace, sidecarUrl: sidecarUrl() },
    'Elements stickers',
  );
  // Healed from the library by id as the project opened, byte for byte what the app ships.
  expect(await sha256(missing)).toBe(await sha256(join(SHIPPED, 'fire.webp')));
  // So the export finds it: nothing to relink, nothing refused.
  expectValidExport(await workspace.export('healed.mp4'), SECONDS);
});
