/**
 * Elements budgets measured in the browser (plan/elements 02 §9): opening the Stickers tab again
 * draws its first tiles within 100 ms.
 *
 * The budget is the app's, so it is measured where the app runs: in Chromium, from the click on
 * the tab to the frame after its first tile is in the document. jsdom times React against a DOM
 * without layout, two to three times slower on a CI runner than on a laptop, so a wall-clock gate
 * there measured the runner; `StickersBrowser.perf.test.tsx` keeps the part jsdom can judge
 * exactly (only the rows in view are drawn) and the search budget, which is the work itself.
 *
 * What is real: the editor and its Elements panel, over main's own `ElementsLibrary` through the
 * desktop harness (`masking/fake-desktop.ts`); Electron itself is simulated there.
 *
 * CI ONLY (`elements-e2e` job).
 */
import { expect, test, type Page } from '@playwright/test';
import {
  attachDiagnostics,
  clip,
  openInDesktop,
  project,
  sidecarUrl,
  video,
  type OpenedEditor,
} from './masking/session.js';
import { Workspace } from './masking/workspace.js';

/** 02 §9: open Stickers (warm) → first tiles painted. */
const FIRST_TILES_BUDGET_MS = 100;
const WARM_OPENS = 5;
const SECONDS = 3;

let opened: OpenedEditor | undefined;
test.afterEach(async ({}, testInfo) => {
  if (opened !== undefined) await attachDiagnostics(testInfo, opened);
  opened = undefined;
});

/**
 * Click a sub-tab inside the page and resolve with the milliseconds until the frame after the
 * first element matching `drawn` appears; measured in the page, so no round trip is counted.
 */
async function timeToFirst(page: Page, tab: string, drawn: string): Promise<number> {
  return page.evaluate(
    ({ tab, drawn }) =>
      new Promise<number>((resolve, reject) => {
        const target = [
          ...document.querySelectorAll('[role="tablist"][aria-label="Elements"] [role="tab"]'),
        ].find((element) => element.textContent?.trim() === tab) as HTMLElement | undefined;
        if (target === undefined) {
          reject(new Error(`No "${tab}" tab in the Elements panel.`));
          return;
        }
        const started = performance.now();
        const settle = (): void => {
          requestAnimationFrame(() => resolve(performance.now() - started));
        };
        const observer = new MutationObserver(() => {
          if (document.querySelector(drawn) === null) return;
          observer.disconnect();
          settle();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        target.click();
        if (document.querySelector(drawn) !== null) {
          observer.disconnect();
          settle();
          return;
        }
        setTimeout(() => {
          observer.disconnect();
          reject(new Error(`"${tab}" drew nothing within five seconds.`));
        }, 5_000);
      }),
    { tab, drawn },
  );
}

test('Stickers: a warm open draws its first tiles within the budget', async ({
  page,
}, testInfo) => {
  test.setTimeout(3 * 60_000);
  const workspace = await Workspace.create('elements-budgets');
  await workspace.media([video('bg', 'blue', SECONDS)]);
  await workspace.writeProject(
    project({
      id: 'elements_budgets',
      name: 'Elements budgets',
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
    { workspace, sidecarUrl: sidecarUrl() },
    'Elements budgets',
  );

  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  // Cold: the first open of the session loads the catalogue; 02 §9 budgets the warm open.
  const cold = await timeToFirst(page, 'Stickers', '.stickers-grid-tile');
  const warm: number[] = [];
  for (let round = 0; round < WARM_OPENS; round += 1) {
    await timeToFirst(page, 'Shapes', '.shapes-grid-tile');
    warm.push(await timeToFirst(page, 'Stickers', '.stickers-grid-tile'));
  }
  const median = [...warm].sort((a, b) => a - b)[Math.floor(warm.length / 2)]!;
  console.info(
    `[elements budgets] Stickers cold open ${cold.toFixed(1)} ms (not budgeted), warm median ${median.toFixed(1)} ms of ${warm.map((ms) => ms.toFixed(1)).join(', ')}`,
  );
  expect(median).toBeLessThanOrEqual(FIRST_TILES_BUDGET_MS);
  // Only the rows in view: the grid never draws the library to paint its first tiles.
  expect(await page.locator('.stickers-grid-tile').count()).toBeLessThan(200);
});
