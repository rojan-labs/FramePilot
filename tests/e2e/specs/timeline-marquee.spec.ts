/**
 * Marquee (rubber-band) multi-select on the timeline (M2a).
 *
 * Regression cover for the bug where a drag over empty timeline space did
 * nothing: the marquee handlers used to live on the `.tracks` <ol>, which is only
 * as wide as its clips and — in a packed project — has no empty background to grab.
 * They now live on the full-width `.lane-scroll` viewport, so a band-select can
 * start from any empty pixel (right of the clips, an empty lane, below the tracks)
 * and drag over clips to select, then delete / drag them as a group.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor, clip, clipCount, clipGeometry, leftTab } from './helpers';

async function box(page: Page, id: string) {
  return (await clip(page, id).boundingBox())!;
}

/** Drag a marquee rectangle between two viewport points. */
async function marquee(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test('marquee from empty space selects both video clips', async ({ page }) => {
  await openEditor(page);
  const intro = await box(page, 'clip_intro');
  const body = await box(page, 'clip_body');
  await marquee(
    page,
    { x: body.x + body.width + 60, y: intro.y - 4 },
    { x: intro.x + 10, y: intro.y + intro.height + 4 },
  );
  await expect(clip(page, 'clip_intro')).toHaveAttribute('data-selected', 'true');
  await expect(clip(page, 'clip_body')).toHaveAttribute('data-selected', 'true');
});

test('a tall marquee spans multiple track rows (video + audio)', async ({ page }) => {
  await openEditor(page);
  const intro = await box(page, 'clip_intro');
  const vo = await box(page, 'clip_vo');
  // Start right of the clips at the video row, drag down-left into the audio row.
  await marquee(
    page,
    { x: intro.x + intro.width + 60, y: intro.y - 4 },
    { x: intro.x + 20, y: vo.y + vo.height / 2 },
  );
  await expect(clip(page, 'clip_intro')).toHaveAttribute('data-selected', 'true');
  await expect(clip(page, 'clip_body')).toHaveAttribute('data-selected', 'true');
  await expect(clip(page, 'clip_vo')).toHaveAttribute('data-selected', 'true');
});

test('marquee-selected clips delete together with one keypress', async ({ page }) => {
  await openEditor(page);
  const intro = await box(page, 'clip_intro');
  const body = await box(page, 'clip_body');
  await expect(clipCount(page)).toHaveCount(3); // intro, body, vo
  await marquee(
    page,
    { x: body.x + body.width + 60, y: intro.y - 4 },
    { x: intro.x + 10, y: intro.y + intro.height + 4 },
  );
  await page.keyboard.press('Delete');
  // Both video clips removed; the audio clip remains.
  await expect(clip(page, 'clip_vo')).toBeVisible();
  await expect(clipCount(page)).toHaveCount(1);
});

test('dragging one marquee-selected clip moves the whole selection', async ({ page }) => {
  await openEditor(page);
  const intro = await box(page, 'clip_intro');
  const body = await box(page, 'clip_body');
  await marquee(
    page,
    { x: body.x + body.width + 60, y: intro.y - 4 },
    { x: intro.x + 10, y: intro.y + intro.height + 4 },
  );
  const introBefore = await clipGeometry(page, 'clip_intro');
  const bodyBefore = await clipGeometry(page, 'clip_body');
  // Grab clip_body and drag it right by ~80px; both selected clips should shift.
  const b = await box(page, 'clip_body');
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40 + 40, b.y + b.height / 2, { steps: 5 });
  await page.mouse.move(b.x + 40 + 80, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  const introAfter = await clipGeometry(page, 'clip_intro');
  const bodyAfter = await clipGeometry(page, 'clip_body');
  expect(bodyAfter.left).toBeGreaterThan(bodyBefore.left);
  expect(introAfter.left).toBeGreaterThan(introBefore.left);
});

test('regression: single clip drag still moves only that clip', async ({ page }) => {
  await openEditor(page);
  const introBefore = await clipGeometry(page, 'clip_intro');
  const bodyBefore = await clipGeometry(page, 'clip_body');
  const b = await box(page, 'clip_body');
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 80, b.y + b.height / 2, { steps: 5 });
  await page.mouse.move(b.x + 120, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  const introAfter = await clipGeometry(page, 'clip_intro');
  const bodyAfter = await clipGeometry(page, 'clip_body');
  expect(bodyAfter.left).toBeGreaterThan(bodyBefore.left);
  expect(introAfter.left).toBeCloseTo(introBefore.left, 0); // intro untouched
});

test('regression: clicking the ruler still seeks (no marquee hijack)', async ({ page }) => {
  await openEditor(page);
  const playhead = page.getByLabel('playhead time');
  await page.locator('.ruler').click({ position: { x: 200, y: 8 } });
  await expect(playhead).not.toHaveText('00:00:00:00');
});

/**
 * The rows a marquee hit-tests against used to be derived by dividing the lane
 * container's height by the row count — a uniform average that is wrong the
 * moment the lanes differ in height, which they always do once an effect lane
 * (20px) sits above the video/audio lanes (56px). A band drawn over one lane then
 * landed on another: it swept in clips the user never covered and, with enough
 * skew (several effect lanes, a collapsed lane, an expanded keyframe strip),
 * missed the clips under the pointer entirely. These tests pin the real geometry.
 */
test.describe('marquee row mapping with mixed lane heights', () => {
  /** Apply an effect so the project has a short (20px) effect lane on top. */
  async function addEffectLane(page: Page): Promise<void> {
    await leftTab(page, 'Effects');
    await page.getByRole('button', { name: /^Halo Bloom\./ }).click();
    await expect(page.locator('.fx-layer')).toHaveCount(1);
  }

  test('a band over the audio lane selects ONLY the audio clip', async ({ page }) => {
    await openEditor(page);
    await addEffectLane(page);
    const vo = await box(page, 'clip_vo');
    // Stay inside the audio row for the whole drag, starting right of the clip.
    await marquee(
      page,
      { x: vo.x + vo.width + 60, y: vo.y + 4 },
      { x: vo.x + 10, y: vo.y + vo.height - 4 },
    );
    await expect(clip(page, 'clip_vo')).toHaveAttribute('data-selected', 'true');
    await expect(clip(page, 'clip_intro')).toHaveAttribute('data-selected', 'false');
    await expect(clip(page, 'clip_body')).toHaveAttribute('data-selected', 'false');
  });

  test('a band over the video lane still selects its clips', async ({ page }) => {
    await openEditor(page);
    await addEffectLane(page);
    const intro = await box(page, 'clip_intro');
    const body = await box(page, 'clip_body');
    // Start right of the LAST clip: a press that lands on a clip starts a clip
    // drag, not a marquee.
    await marquee(
      page,
      { x: body.x + body.width + 60, y: intro.y + 4 },
      { x: intro.x + 10, y: intro.y + intro.height - 4 },
    );
    await expect(clip(page, 'clip_intro')).toHaveAttribute('data-selected', 'true');
    await expect(clip(page, 'clip_body')).toHaveAttribute('data-selected', 'true');
    await expect(clip(page, 'clip_vo')).toHaveAttribute('data-selected', 'false');
  });

  test('a band across an effect lane selects its layers too', async ({ page }) => {
    await openEditor(page);
    await addEffectLane(page);
    const fx = (await page.locator('.fx-layer').boundingBox())!;
    await marquee(
      page,
      { x: fx.x + fx.width + 200, y: fx.y + 2 },
      { x: fx.x + 2, y: fx.y + fx.height - 2 },
    );
    await expect(page.locator('.fx-layer')).toHaveClass(/is-selected/);
  });
});
