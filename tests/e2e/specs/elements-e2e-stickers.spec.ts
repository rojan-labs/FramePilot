/**
 * Elements · Stickers end to end (plan/elements EL6a, EL6b): add the fire sticker from the Stickers
 * tab, replace it with a heart from the Inspector, export, check the monitor draws what the export
 * draws, undo it all; open a project whose sticker file went missing to find it back; and, with
 * the installer's packaged set, list and place a sticker from the whole library, star it, and drag
 * one onto a lane.
 *
 * What is real: the editor (Elements → Stickers, the Inspector's Sticker section, History, the
 * timeline's drop), main's own `ElementsLibrary` copying a sticker into the project folder by id
 * (and healing it on open, and answering packaged tiles), and the export (`render()` with
 * validation), read back through the same parity gates as the PX4 oracle.
 *
 * SIMULATED, and why: Electron and `fp-media://` (see `masking/fake-desktop.ts`). The packaged set
 * is one sticker's files standing in for the 1,344 packaging encodes (the `desktop-build` job
 * builds and checks the real set); its manifest is written as `build:elements` writes one. The
 * drag is dispatched with a real `DataTransfer`: the tile's own `dragstart` writes the payload and
 * the lane's own `drop` reads it (headless Chromium has no pointer-driven HTML5 drag to replay).
 *
 * CI ONLY (`elements-e2e` job): it renders.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { loadStickerCatalog } from '../../../packages/ai-sdk/dist/index.js';

const SECONDS = 3;
const FIRE = 'element_fluent3d_fire';
const HEART = 'element_fluent3d_red_heart';
const SHIPPED = join(REPO, 'apps', 'web-editor', 'public', 'elements', 'stickers', 'full');
/** A sticker the renderer does not ship: only the installer's packaged set has it. */
const LLAMA = 'element_fluent3d_llama';

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
  // The grid draws only the rows in view (EL6b), so a sticker is found as a person finds one in
  // 1,595: by search.
  const search = page.getByRole('searchbox', { name: 'Search stickers', exact: true });
  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Stickers', exact: true })
    .click();
  await search.fill('fire');
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
  await search.fill('fire');
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
  await search.fill('red heart');
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

/**
 * A packaged set holding one sticker, `llama`, as `build:elements` lays one out: its full file and
 * tile (a curated sticker's bytes, standing in), the licence, and a manifest of what was encoded,
 * for the catalogue's library commit.
 */
async function packagedSet(root: string): Promise<{ readonly full: string }> {
  const stickers = join(REPO, 'apps', 'web-editor', 'public', 'elements', 'stickers');
  await mkdir(join(root, 'full'), { recursive: true });
  await mkdir(join(root, 'thumbs'), { recursive: true });
  const full = join(root, 'full', 'llama.webp');
  await copyFile(join(stickers, 'full', 'fire.webp'), full);
  await copyFile(join(stickers, 'thumbs', 'fire.webp'), join(root, 'thumbs', 'llama.webp'));
  await writeFile(join(root, 'LICENSE-fluent-emoji.txt'), 'MIT');
  const bytes = (await stat(full)).size;
  const thumbBytes = (await stat(join(root, 'thumbs', 'llama.webp'))).size;
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      commit: (await loadStickerCatalog()).commit,
      totalBytes: bytes + thumbBytes,
      items: {
        llama: {
          file: 'full/llama.webp',
          thumb: 'thumbs/llama.webp',
          sha256: await sha256(full),
          bytes,
          thumbBytes,
          width: 318,
          height: 318,
          sharpSize: 256,
        },
      },
    }),
  );
  return { full };
}

test('Stickers: the whole library where the installer ships it — list, place, star, drag', async ({
  page,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const workspace = await workspaceWith('elements-stickers-packaged', 'elements_packaged');
  const { full } = await packagedSet(join(workspace.root, 'resources', 'elements', 'stickers'));
  opened = await openInDesktop(
    page,
    testInfo,
    {
      workspace,
      sidecarUrl: sidecarUrl(),
      packagedStickers: join(workspace.root, 'resources', 'elements', 'stickers'),
    },
    'Elements stickers',
  );
  const { desktop } = opened;

  // --- listed: a sticker only the packaged set has, its tile from main ------------------------
  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Stickers', exact: true })
    .click();
  await page.getByRole('searchbox', { name: 'Search stickers', exact: true }).fill('llama');
  const llama = page.getByRole('button', { name: 'Add Llama', exact: true });
  await expect(llama).toBeVisible();
  await expect(llama.locator('img')).toHaveAttribute('src', /^blob:/);
  await expectPanelAxeClean(page, 'Stickers, the whole library');

  // --- placed: main copies the packaged file in by id, byte for byte -------------------------
  await llama.click();
  const added = await savedProject(
    desktop,
    (doc) => stickersOf(doc).some((entry) => entry.assetId === LLAMA),
    'the packaged sticker placed',
  );
  const asset = added.assets.find((candidate) => candidate.id === LLAMA)!;
  expect(await sha256(join(workspace.projectDir, asset.path))).toBe(await sha256(full));
  const lane = stickersOf(added).find((entry) => entry.assetId === LLAMA)!.trackId;

  // --- starred: F on the tile, then the Favourites chip lists it ------------------------------
  await llama.focus();
  await page.keyboard.press('f');
  await page.getByRole('searchbox', { name: 'Search stickers', exact: true }).fill('');
  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add Llama', exact: true })).toBeVisible();
  await expect(page.locator('.stickers-grid-tile')).toHaveCount(1);
  await page.getByRole('button', { name: 'All', exact: true }).click();

  // --- dragged: the heart dropped on the sticker's lane lands there, at the drop time ---------
  // Searched for, so its tile is drawn: the grid draws only the rows in view.
  await page.getByRole('searchbox', { name: 'Search stickers', exact: true }).fill('red heart');
  const heart = page.getByRole('button', { name: 'Add Red heart', exact: true });
  const target = page.locator(`[data-track-id="${lane}"]`);
  const box = (await target.boundingBox())!;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await heart.dispatchEvent('dragstart', { dataTransfer });
  const at = { clientX: box.x + box.width * 0.6, clientY: box.y + box.height / 2 };
  await target.dispatchEvent('dragover', { dataTransfer, ...at });
  await target.dispatchEvent('drop', { dataTransfer, ...at });
  const dropped = await savedProject(
    desktop,
    (doc) => stickersOf(doc).some((entry) => entry.assetId === 'element_fluent3d_red_heart'),
    'the dragged heart placed',
  );
  const placed = stickersOf(dropped).find(
    (entry) => entry.assetId === 'element_fluent3d_red_heart',
  )!;
  expect(placed.trackId).toBe(lane);
  expect(placed.start).toBeGreaterThan(0);

  // --- and both undo ---------------------------------------------------------------------------
  const undo = page
    .getByRole('toolbar', { name: 'editor tools', exact: true })
    .getByRole('button', { name: 'Undo', exact: true });
  for (let step = 0; step < 2; step += 1) await undo.click();
  await savedProject(desktop, (doc) => stickersOf(doc).length === 0, 'both stickers undone');
});
