/**
 * Mask tools end to end (MK4.5): draw a mask on the program monitor, animate it from the
 * Inspector, undo; draw a path with the keyboard only; and the pointer-to-paint budget (MK4.6)
 * read from the monitor's own telemetry while dragging a 200-point path on a 4K clip.
 *
 * The project is injected through localStorage (as the preview specs do) so the clip's media
 * carries a probed size: masks are stored in source pixels and refuse unmeasured media. The
 * media URL is never fetched successfully; the monitor shows its load error, which does not
 * affect the mask overlay, the Inspector or history (pixels are the parity oracle's job).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { clip, seekTo, selectClip, undoButton } from './helpers.js';

/**
 * Plan 06: editing a 200-vertex path on 4K footage must stay inside one frame. Asserted on the
 * monitor's `work` channel — handler entry to the paintable DOM, everything the monitor does with
 * the event. The 16 ms budget itself is unchanged.
 *
 * `commit` (which also contains `inputDelay`, the browser delivering the event) is logged, not
 * gated: `page.mouse.move` injects each move over CDP and its delivery alone measures 12–14 ms
 * p95 on the CI runner, which is a property of the harness, not of the monitor. All five channels
 * are logged on every run so a miss can be attributed rather than guessed at — the measurements,
 * and the two wrong guesses they killed, are in plan/background-removal-ai/MK4-BUDGETS.md.
 */
const POINTER_TO_PAINT_BUDGET_MS = 16;

function project(width: number, height: number, masks: unknown[] = []) {
  return {
    id: 'project_mask_tools',
    name: 'Mask Tools',
    version: 1,
    fps: 30,
    resolution: { width: 1280, height: 720 },
    assets: [
      {
        id: 'asset_a',
        path: 'https://fixtures.internal/mask-tools.mp4',
        kind: 'video',
        durationSeconds: 6,
        media: { width, height },
      },
    ],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_a',
              trackId: 'video_1',
              start: 0,
              end: 6,
              sourceStart: 0,
              sourceEnd: 6,
              effects: [],
              keyframes: [],
              ...(masks.length > 0 ? { masks } : {}),
            },
          ],
        },
      ],
    },
    transcript: [],
    markers: [],
    aiMemory: {},
    history: [],
  };
}

async function openMaskTab(page: Page, injected: unknown): Promise<Locator> {
  await page.route('**/fixtures.internal/**', (route) => route.abort());
  await page.addInitScript((p) => {
    localStorage.setItem(`framepilot:project:${(p as { id: string }).id}`, JSON.stringify(p));
    localStorage.setItem('framepilot:last-project-id', (p as { id: string }).id);
  }, injected);
  await page.goto('/');
  await expect(page.getByLabel('project name')).toHaveText('Mask Tools');
  await expect(clip(page, 'clip_a')).toBeVisible();
  await selectClip(page, 'clip_a');
  await page.getByRole('tab', { name: 'Inspector' }).click();
  await page.getByRole('tab', { name: 'Mask', exact: true }).click();
  // The Mask section is `defaultOpen: false` in the inspector registry, so the tab shows it
  // collapsed until someone expands it (the state then persists in EditorSettings). The monitor
  // tools are driven by the tab, not by the disclosure, so the canvas is already live — but the
  // mask list, properties and keyframes live inside the `<details>` and are not in the DOM yet.
  const panel = page.getByLabel('mask', { exact: true }).first();
  if (!(await panel.evaluate((node: HTMLDetailsElement) => node.open))) {
    await panel.locator('summary').click();
  }
  await expect(panel).toHaveJSProperty('open', true);
  const canvas = page.getByRole('application', { name: 'Mask canvas', exact: true });
  await expect(canvas).toBeVisible();
  return canvas;
}

/**
 * The rows of the Inspector's mask list. Scoped to `li.mask-list-row` rather than
 * `getByRole('option')`: each row carries a blend-mode `<select>`, whose six `<option>` elements
 * are descendants of the listbox and have the same implicit role, so a role query counts seven
 * elements per mask.
 */
const masks = (page: Page): Locator =>
  page.getByRole('listbox', { name: 'Masks', exact: true }).locator('li.mask-list-row');

test('draw a rectangle on the monitor, animate it, and undo', async ({ page }) => {
  const canvas = await openMaskTab(page, project(1920, 1080));
  const box = (await canvas.boundingBox())!;

  await page.getByRole('button', { name: 'Rectangle tool', exact: true }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(masks(page)).toHaveCount(1);
  await expect(masks(page).first()).toHaveAccessibleName('Mask 1');

  // Key the centre at 0 s, move the mask at 2 s: the move keys the new instant.
  await page
    .getByRole('button', {
      name: 'Animate Mask 1 centre x — adds a keyframe at the playhead',
      exact: true,
    })
    .click();
  await seekTo(page, 2);
  const centre = page.getByRole('spinbutton', { name: 'Mask 1 centre x', exact: true });
  const before = Number(await centre.inputValue());
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => Number(await centre.inputValue())).toBeGreaterThan(before);
  const previous = page.getByRole('button', {
    name: 'previous Mask 1 centre x keyframe',
    exact: true,
  });
  await expect(previous).toBeEnabled();

  await undoButton(page).click();
  await expect.poll(async () => Number(await centre.inputValue())).toBe(before);
  await undoButton(page).click();
  await undoButton(page).click();
  await expect(masks(page)).toHaveCount(0);
});

test('draw a path with the keyboard only', async ({ page }) => {
  const canvas = await openMaskTab(page, project(1920, 1080));
  await canvas.focus();
  await page.keyboard.press('p');
  await page.keyboard.press('Space');
  for (let step = 0; step < 20; step += 1) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Space');
  for (let step = 0; step < 20; step += 1) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await expect(masks(page)).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'Path mask added' })).toHaveCount(1);
  await expect(page.getByText('3 points', { exact: true })).toBeVisible();

  // Delete it from the keyboard, then undo.
  await canvas.focus();
  await page.keyboard.press('Delete');
  await expect(masks(page)).toHaveCount(0);
  await undoButton(page).click();
  await expect(masks(page)).toHaveCount(1);
});

test('pointer-to-paint stays within budget dragging a 200-point path on 4K media', async ({
  page,
}) => {
  const width = 3840;
  const height = 2160;
  const vertices = Array.from({ length: 200 }, (_, index) => {
    const angle = (index / 200) * Math.PI * 2;
    return [width / 2 + 900 * Math.cos(angle), height / 2 + 700 * Math.sin(angle)];
  });
  const mask = {
    kind: 'path',
    id: 'clip_a__mask',
    name: 'Roto',
    pathKeyframes: [
      {
        id: 'p0',
        sourceTime: 0,
        points: vertices.flatMap(([x, y]) => [x, y, 0, 0, 0, 0]),
        vertexTypes: vertices.map(() => 0),
      },
    ],
  };
  const canvas = await openMaskTab(page, project(width, height, [mask]));
  const box = (await canvas.boundingBox())!;
  await page.evaluate(() =>
    (
      window as unknown as { __fpMaskToolTelemetry: { clear(): void } }
    ).__fpMaskToolTelemetry.clear(),
  );
  // Drag the whole path from inside it: every move redraws the 200-point outline.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 0; step < 120; step += 1) {
    await page.mouse.move(
      box.x + box.width / 2 + (step % 40),
      box.y + box.height / 2 + (step % 25),
    );
  }
  await page.mouse.up();
  const stats = await page.evaluate(() => {
    const telemetry = (
      window as unknown as {
        __fpMaskToolTelemetry: { samples(c: string): number[]; p95(c: string): number };
      }
    ).__fpMaskToolTelemetry;
    return {
      samples: telemetry.samples('commit').length,
      inputDelayP95: telemetry.p95('inputDelay'),
      workP95: telemetry.p95('work'),
      commitP95: telemetry.p95('commit'),
      pointerToPaintP95: telemetry.p95('pointerToPaint'),
      compositeSamples: telemetry.samples('composite').length,
      compositeP95: telemetry.p95('composite'),
    };
  });
  test
    .info()
    .annotations.push({ type: 'mask pointer-to-paint', description: JSON.stringify(stats) });
  // The budget document (plan/background-removal-ai/MK4-BUDGETS.md) reads this line from CI logs.
  console.log(`MK4.6 pointer-to-paint ${JSON.stringify(stats)}`);
  expect(stats.samples).toBeGreaterThan(50);
  expect(stats.workP95).toBeLessThanOrEqual(POINTER_TO_PAINT_BUDGET_MS);
});
