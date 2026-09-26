/**
 * Elements · Photos and Videos end to end (plan/elements EL9, ADR 0193): pick a category in the
 * project's own shape, lay a Pexels clip over the footage with **Add as overlay** — a
 * picture-in-picture on a lane in front of the footage, 40% of its size, centred — export it, check
 * the monitor draws what the export draws, and undo it all.
 *
 * What is real: the editor (Elements → Videos, the category chips and orientation filter, the tile's
 * Add and Add as overlay, the shared download flow and its tile registry, the overlay's patch,
 * History and Undo) and the export (`render()` with validation), read back through the same parity
 * gates as the PX4 oracle.
 *
 * SIMULATED, and why: Electron and `fp-media://` (see `masking/fake-desktop.ts`), and Pexels itself —
 * a search answers one item and a download copies a sentinel clip into the project's media folder,
 * answering as main's service does. The service's cache, quota and download are unit-tested in
 * `apps/desktop` (`stock-service.test.ts`).
 *
 * CI ONLY (`elements-e2e` job): it renders.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  attachDiagnostics,
  clip,
  clipsById,
  expectValidExport,
  HEIGHT,
  openInDesktop,
  project,
  savedProject,
  sidecarUrl,
  video,
  WIDTH,
  type OpenedEditor,
} from './masking/session.js';
import { expectPreviewMatchesExport } from './masking/parity.js';
import { Workspace } from './masking/workspace.js';
import type { Project } from '../../../packages/timeline-schema/dist/index.js';

const SECONDS = 3;
/** The stand-in Pexels item: a red sentinel clip the "download" copies into the project. */
const REMOTE_ID = '9000001';
const STOCK_ASSET = `stock_pexels_${REMOTE_ID}`;
const TITLE = 'Red sentinel skyline';

/** As main sends a search result to the renderer: dimensions and credits, never a URL. */
const ITEM = {
  remoteId: REMOTE_ID,
  provider: 'pexels',
  kind: 'video',
  title: TITLE,
  width: WIDTH,
  height: HEIGHT,
  durationSeconds: SECONDS,
  avgColor: '#aa3322',
  // No hover preview: the harness serves no tile bytes, and hovering must not ask for any.
  hasPreview: false,
  variants: [
    {
      id: 'sd',
      width: WIDTH,
      height: HEIGHT,
      fps: 30,
      contentType: 'video/mp4',
      format: 'mp4',
      approxBytes: 200_000,
    },
  ],
  license: 'pexels',
  licenseUrl: 'https://www.pexels.com/license/',
  attributionRequired: false,
  attribution: 'Video by Sentinel on Pexels',
  creator: 'Sentinel',
};

/**
 * The Elements panel is desktop-only, so the browser `accessibility.spec` never reaches it: it is
 * scanned here, in both themes, with the same WCAG A/AA rules the Stickers spec uses (plan/elements
 * 13 §1). Run before the pointer rests on a tile, whose caption fades in over the photograph.
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

const overlaysOf = (document: Project) =>
  [...clipsById(document).values()].filter((entry) => entry.assetId === STOCK_ASSET);

let opened: OpenedEditor | undefined;
test.afterEach(async ({}, testInfo) => {
  if (opened !== undefined) await attachDiagnostics(testInfo, opened);
  opened = undefined;
});

test('Videos: a category in the project’s shape, Add as overlay over the footage, export, undo', async ({
  page,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const workspace = await Workspace.create('elements-photos');
  // The footage (blue) and the clip the stand-in Pexels hands over (red), as sentinel colours the
  // parity gates can tell apart.
  await workspace.media([video('bg', 'blue', SECONDS), video('pexels_source', 'red', SECONDS)]);
  await workspace.writeProject(
    project({
      id: 'elements_photos',
      name: 'Elements photos',
      videos: [{ id: 'bg', seconds: SECONDS }],
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
        },
      ],
    }),
  );
  opened = await openInDesktop(
    page,
    testInfo,
    {
      workspace,
      sidecarUrl: sidecarUrl(),
      stock: {
        items: [ITEM],
        files: {
          [REMOTE_ID]: {
            path: 'media/pexels_source.mp4',
            kind: 'video',
            width: WIDTH,
            height: HEIGHT,
            durationSeconds: SECONDS,
          },
        },
      },
    },
    'Elements photos',
  );
  const { desktop } = opened;

  // --- the Videos tab, in the project's shape; a category is one search ------------------------
  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Videos', exact: true })
    .click();
  const orientation = page.getByRole('group', { name: 'Orientation', exact: true });
  // The project is landscape, so the filter starts there.
  await expect(orientation.getByRole('button', { name: 'Landscape', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page
    .getByRole('group', { name: 'Video categories', exact: true })
    .getByRole('button', { name: 'City', exact: true })
    .click();
  await expect
    .poll(() =>
      desktop.stockSearches.filter(
        (request) => request.text === 'city' && request.orientation === 'landscape',
      ),
    )
    .toHaveLength(1);
  await expect(
    page.getByText('Each category is one search of your Pexels allowance.'),
  ).toBeVisible();
  const results = page.getByRole('list', { name: 'City — video', exact: true });
  const tile = results.getByRole('listitem').first();
  await expect(tile).toBeVisible();
  await expectPanelAxeClean(page, 'Videos');

  // --- over the footage: Add is a cutaway and says why not; Add as overlay places it -----------
  await tile.hover();
  await expect(tile.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await tile.getByRole('button', { name: 'Add as overlay', exact: true }).click();
  const added = await savedProject(
    desktop,
    (doc) => overlaysOf(doc).length === 1,
    'the overlay placed',
  );
  const overlay = overlaysOf(added)[0]!;
  expect(overlay).toMatchObject({ start: 0, end: SECONDS });
  // 40% of its size, centred: the base keyframes the on-canvas handles write.
  expect(overlay.keyframes.map((key) => [key.property, key.time, key.value])).toEqual([
    ['scale', 0, 0.4],
    ['x', 0, 0],
    ['y', 0, 0],
  ]);
  // On its own lane, in front of the footage.
  const lanes = added.timeline.tracks.map((track) => track.id);
  expect(overlay.trackId).not.toBe('video_1');
  expect(lanes.indexOf(overlay.trackId)).toBeLessThan(lanes.indexOf('video_1'));
  expect(clipsById(added).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
  expect(added.assets.find((asset) => asset.id === STOCK_ASSET)?.source?.provider).toBe('pexels');
  // The tile now says the clip is in the project.
  await expect(tile.getByText('In this project', { exact: true })).toBeVisible();

  // --- export: valid, and the monitor draws the engine's own pixels ----------------------------
  expectValidExport(await workspace.export('photos-overlay.mp4'), SECONDS);
  await expectPreviewMatchesExport(page, workspace, [0.5, 1.5], 'photos-overlay', testInfo);

  // --- undo: one step takes back the clip, its lane and the asset ------------------------------
  await page
    .getByRole('toolbar', { name: 'editor tools', exact: true })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  const undone = await savedProject(
    desktop,
    (doc) => overlaysOf(doc).length === 0,
    'the overlay undone',
  );
  expect(undone.timeline.tracks.map((track) => track.id)).toEqual(['video_1']);
  expect(undone.assets.some((asset) => asset.id === STOCK_ASSET)).toBe(false);
  expect(clipsById(undone).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
});
