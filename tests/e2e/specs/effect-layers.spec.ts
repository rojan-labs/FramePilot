/**
 * Effect layers end to end (schema v13, ADR 0088).
 *
 * Walks the whole workflow the feature promises, in the real browser against the
 * real editor store: discover → hover-preview → apply → adjust → trim → move →
 * duplicate → bypass → stack → save/reopen → remove, plus undo at each step.
 *
 * WHY this exists on top of the unit tests: every layer of this feature is
 * unit-tested in isolation, but nothing else proves the pieces are actually wired
 * to each other — that clicking a real tile reaches the real patch builder,
 * reaches the real store, and puts a real chip on a real lane that survives a
 * reload. That wiring is exactly what unit tests with mocked neighbours cannot
 * catch.
 *
 * No network, no Electron, no Python engine.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  clipGeometry,
  leftTab,
  openEditor,
  redoButton,
  rightTab,
  seekTo,
  selectClip,
  undoButton,
} from './helpers.js';

/** An effect tile in the library, by its visible label. */
function tile(page: Page, label: string): Locator {
  // The accessible name is `${label}. ${description}`, so anchor to the start —
  // a bare substring would also match a description mentioning another effect.
  return page.getByRole('button', { name: new RegExp(`^${label}\\.`) });
}

/** Every effect chip currently on the timeline. */
function chips(page: Page): Locator {
  return page.locator('.fx-layer');
}

/** One effect chip by the catalog id it came from. */
function chip(page: Page, effectId: string): Locator {
  return page.locator(`.fx-layer[data-effect-id="${effectId}"]`);
}

/** Read a chip's left/width px, a faithful proxy for its start/duration. */
async function chipGeometry(locator: Locator): Promise<{ left: number; width: number }> {
  const style = (await locator.getAttribute('style')) ?? '';
  const left = Number(/left:\s*([\d.]+)px/.exec(style)?.[1] ?? '0');
  const width = Number(/width:\s*([\d.]+)px/.exec(style)?.[1] ?? '0');
  return { left, width };
}

/**
 * Wait for the debounced autosave to actually land.
 *
 * The app autosaves 2s after the last change (AUTOSAVE_DEBOUNCE_MS), so a reload
 * fired immediately after an edit loses it — not because persistence is broken but
 * because nothing was written yet. The topbar status is the app's own signal that
 * the write completed, so waiting on it tests persistence rather than timing.
 */
async function waitForAutosave(page: Page): Promise<void> {
  const status = page.getByLabel('save state');
  // It goes 'saving' → 'saved'; only the settled state means the bytes are in
  // localStorage.
  await expect(status).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
}

/** Drag from one point to another with real pointer events. */
async function drag(page: Page, from: Locator, dx: number): Promise<void> {
  const box = await from.boundingBox();
  if (box === null) throw new Error('drag source has no box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  // Two intermediate moves: a single jump can be coalesced, and the gesture must
  // survive a real move stream.
  await page.mouse.move(box.x + box.width / 2 + dx / 2, y);
  await page.mouse.move(box.x + box.width / 2 + dx, y);
  await page.mouse.up();
}

test.describe('effect layers: discover → apply → adjust → edit → reopen', () => {
  test('applies an effect from the library as a timeline layer', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');

    // The library needs NO clip selection — an effect applies to whatever is
    // beneath it, so gating on a selection would block the normal case.
    await expect(tile(page, 'Halo Bloom')).toBeEnabled();
    await expect(chips(page)).toHaveCount(0);

    await seekTo(page, 2);
    await tile(page, 'Halo Bloom').click();

    // One chip, on a lane that did not exist a moment ago.
    await expect(chips(page)).toHaveCount(1);
    await expect(chip(page, 'halo-bloom')).toBeVisible();
    await expect(page.locator('.track-lane.is-effect')).toHaveCount(1);
    // Marked in use, back in the library.
    await expect(page.getByText('In use')).toBeVisible();
  });

  test('creates the lane and the layer as ONE undo step', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await tile(page, 'Halo Bloom').click();
    await expect(chips(page)).toHaveCount(1);

    // A single undo must remove both, or an orphan empty effect lane is left.
    await undoButton(page).click();
    await expect(chips(page)).toHaveCount(0);
    await expect(page.locator('.track-lane.is-effect')).toHaveCount(0);

    await redoButton(page).click();
    await expect(chips(page)).toHaveCount(1);
  });

  test('renders the effect lane shorter than a media lane', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await tile(page, 'Halo Bloom').click();

    const effectLane = page.locator('.track-lane.is-effect').first();
    const videoLane = page.locator('.track-lane.is-video').first();
    const effectBox = await effectLane.boundingBox();
    const videoBox = await videoLane.boundingBox();
    expect(effectBox).not.toBeNull();
    expect(videoBox).not.toBeNull();
    // A stated product requirement, not a style detail.
    expect(effectBox!.height).toBeLessThan(videoBox!.height);
  });

  test('searches by tag synonym and filters by category', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');

    // A term the label does not contain — the whole point of tags.
    await page.getByLabel('search effects').fill('teal orange');
    await expect(tile(page, 'Teal & Amber')).toBeVisible();
    await expect(tile(page, 'Halo Bloom')).toHaveCount(0);

    await page.getByLabel('search effects').fill('');
    await page.getByRole('button', { name: /Glitch & Digital/ }).click();
    await expect(tile(page, 'Block Shift')).toBeVisible();
    await expect(tile(page, 'Halo Bloom')).toHaveCount(0);
  });

  test('shows an actionable empty state for a miss', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await page.getByLabel('search effects').fill('zzzznotathing');
    await expect(page.getByText(/No effects match/)).toBeVisible();
  });

  test('keeps favourites and recents across a reload', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');

    await page.getByRole('button', { name: 'Add Halo Bloom to favourites' }).click();
    await tile(page, 'Cine Grain').click();

    // These are USER state, not project state — they follow the editor, which is
    // why they must survive a reload. Still waits for the autosave so the reload
    // does not race the project write and leave the page in a half-saved state.
    await waitForAutosave(page);
    await page.reload();
    await expect(page.getByLabel('project name')).toHaveText('Demo Project');
    await leftTab(page, 'Effects');

    await page.getByRole('button', { name: /Favourites/ }).click();
    await expect(tile(page, 'Halo Bloom')).toBeVisible();
    await page.getByRole('button', { name: /Recently used/ }).click();
    await expect(tile(page, 'Cine Grain')).toBeVisible();
  });

  test('animates the tile on hover without breaking the static state', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');

    const target = tile(page, 'Tape Warp');
    // Static: the still frame only, no canvas mounted.
    await expect(target.locator('.fx-thumb-still')).toBeVisible();
    await expect(target.locator('.fx-thumb-canvas')).toHaveCount(0);

    await target.hover();
    // Hovering runs the effect's real shader over the same frame. If WebGL is
    // unavailable in this browser the component keeps the still, so the canvas is
    // asserted as "appears or cleanly does not" rather than required — a missing
    // GPU must degrade, not fail the workflow.
    const canvas = target.locator('.fx-thumb-canvas');
    const appeared = await canvas
      .waitFor({ state: 'attached', timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      // `data-painted` only lands once a real shader frame has been drawn, which
      // is what proves the preview is the EFFECT and not an empty canvas.
      await expect(canvas).toHaveAttribute('data-painted', 'true', { timeout: 3000 });
    }
    // The still stays mounted either way — it is the fallback and the no-flash
    // layer underneath.
    await expect(target.locator('.fx-thumb-still')).toBeAttached();
  });

  test('adjusts an applied effect from the Inspector, one undo per change', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await tile(page, 'Mosaic Block').click();

    await chip(page, 'mosaic-block').click();
    await rightTab(page, 'Inspector');

    // Controls are generated from the catalog's param descriptors — `mosaic`
    // declares exactly one, `size`.
    await expect(page.getByLabel('Cell size')).toBeVisible();
    await expect(page.getByLabel('Strength')).toBeVisible();

    const size = page.getByLabel('Cell size');
    await size.fill('64');
    // A slider drag must be ONE undo step, so the commit happens on release.
    await size.dispatchEvent('keyup');
    await expect(size).toHaveValue('64');

    await undoButton(page).click();
    await expect(size).not.toHaveValue('64');
  });

  test('trims, moves and duplicates a layer on the lane', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await seekTo(page, 1);
    await tile(page, 'Cine Grain').click();

    const target = chip(page, 'cine-grain');
    const before = await chipGeometry(target);

    // Move right.
    await drag(page, target, 120);
    const afterMove = await chipGeometry(target);
    expect(afterMove.left).toBeGreaterThan(before.left);
    // A move preserves duration — it is a move, not a trim.
    expect(Math.abs(afterMove.width - before.width)).toBeLessThan(2);

    // Trim from the out edge — the layer gets longer, its start does not move.
    const handle = target.locator('.fx-layer-handle--end');
    await drag(page, handle, 80);
    const afterTrim = await chipGeometry(target);
    expect(afterTrim.width).toBeGreaterThan(afterMove.width);
    expect(Math.abs(afterTrim.left - afterMove.left)).toBeLessThan(2);

    // Duplicate via the context menu.
    await target.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(chips(page)).toHaveCount(2);
  });

  test('bypasses and deletes a layer from the context menu', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await tile(page, 'Halo Bloom').click();
    const target = chip(page, 'halo-bloom');

    await target.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Bypass' }).click();
    // Bypassed reads as present-but-inert: still on the timeline, still selectable.
    await expect(target).toHaveClass(/is-disabled/);
    await expect(target).toBeVisible();

    await target.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Enable' }).click();
    await expect(target).not.toHaveClass(/is-disabled/);

    await target.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(chips(page)).toHaveCount(0);

    await undoButton(page).click();
    await expect(chips(page)).toHaveCount(1);
  });

  test('shares one lane when two effects do not overlap in time', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');

    // Cine Grain defaults to 4s and Edge Fall to 3s, so starting at 0 and 6
    // leaves them disjoint.
    await seekTo(page, 0);
    await tile(page, 'Cine Grain').click();
    await seekTo(page, 6);
    await tile(page, 'Edge Fall').click();

    await expect(chips(page)).toHaveCount(2);
    // One lane: a second effect must not spawn a track it does not need.
    await expect(page.locator('.track-lane.is-effect')).toHaveCount(1);
  });

  test('auto-stacks onto a new lane when two effects conflict in time', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');

    // Overlapping spans: both must apply, and two chips on one lane over the same
    // moment would be ambiguous to read.
    await seekTo(page, 1);
    await tile(page, 'Cine Grain').click();
    await seekTo(page, 2);
    await tile(page, 'Edge Fall').click();

    await expect(chips(page)).toHaveCount(2);
    await expect(page.locator('.track-lane.is-effect')).toHaveCount(2);
    await expect(chip(page, 'cine-grain')).toBeVisible();
    await expect(chip(page, 'edge-fall')).toBeVisible();
  });

  test('survives a save and reopen', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await seekTo(page, 2);
    await tile(page, 'Tape Warp').click();
    await expect(chips(page)).toHaveCount(1);
    const before = await chipGeometry(chip(page, 'tape-warp'));

    // The app autosaves to localStorage and restores on reload, so this exercises
    // the real serialize → schema parse → restore round trip. If the layer did not
    // persist through the project file, this is where it vanishes.
    await waitForAutosave(page);
    await page.reload();
    await expect(page.getByLabel('project name')).toHaveText('Demo Project');

    await expect(chips(page)).toHaveCount(1);
    const after = await chipGeometry(chip(page, 'tape-warp'));
    expect(Math.abs(after.left - before.left)).toBeLessThan(2);
    expect(Math.abs(after.width - before.width)).toBeLessThan(2);
  });
});

/**
 * The synthetic preview frame, asserted on its actual pixels.
 *
 * These live here rather than in vitest because jsdom implements no canvas 2D
 * context, and adding the `canvas` npm package to get one would be a new
 * dependency for something a real browser does natively.
 *
 * What they guard: the frame must have the STRUCTURE the effects act on. The
 * first version was a gradient with a circle on it, abstract enough that half the
 * catalog's tiles looked like no-ops.
 */
test.describe('effect preview frame', () => {
  /** Paint the frame in-page and read back its tonal statistics. */
  async function frameStats(page: Page): Promise<{
    brightest: number;
    darkest: number;
    strongestEdge: number;
    deviation: number;
  }> {
    await openEditor(page);
    await leftTab(page, 'Effects');
    // Read the still that every tile already shows, rather than re-implementing
    // the painter here — this asserts the real shipped image.
    return page.evaluate(async () => {
      const img = document.querySelector('.fx-thumb-still') as HTMLImageElement;
      if (!img) throw new Error('no thumbnail still rendered');
      if (!img.complete) await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      // Drawn WITHOUT the CSS filter: the filter is a per-effect approximation,
      // and this is asserting the base frame.
      ctx.drawImage(img, 0, 0, 128, 128);
      const d = ctx.getImageData(0, 0, 128, 128);
      const luma = (x: number, y: number): number => {
        const i = (y * 128 + x) * 4;
        return 0.2126 * d.data[i]! + 0.7152 * d.data[i + 1]! + 0.0722 * d.data[i + 2]!;
      };
      let brightest = 0;
      let darkest = 255;
      let strongestEdge = 0;
      const values: number[] = [];
      for (let y = 1; y < 127; y++) {
        for (let x = 1; x < 127; x++) {
          const v = luma(x, y);
          brightest = Math.max(brightest, v);
          darkest = Math.min(darkest, v);
          if (x % 4 === 0 && y % 4 === 0) values.push(v);
          const gx =
            -luma(x - 1, y - 1) -
            2 * luma(x - 1, y) -
            luma(x - 1, y + 1) +
            luma(x + 1, y - 1) +
            2 * luma(x + 1, y) +
            luma(x + 1, y + 1);
          const gy =
            -luma(x - 1, y - 1) -
            2 * luma(x, y - 1) -
            luma(x + 1, y - 1) +
            luma(x - 1, y + 1) +
            2 * luma(x, y + 1) +
            luma(x + 1, y + 1);
          strongestEdge = Math.max(strongestEdge, Math.sqrt(gx * gx + gy * gy) / 4 / 255);
        }
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const deviation =
        Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) / 255;
      return { brightest: brightest / 255, darkest: darkest / 255, strongestEdge, deviation };
    });
  }

  test('has the tonal range and structure every effect family needs', async ({ page }) => {
    const stats = await frameStats(page);
    // Bloom and halation threshold around 0.7 luma — without a region above it
    // they render as no-ops on every tile.
    expect(stats.brightest).toBeGreaterThan(0.85);
    // Deep shadow, so the frame spans a real range rather than sitting in the
    // midtones where grades are invisible.
    expect(stats.darkest).toBeLessThan(0.2);
    // A Sobel edge above the outline family's 0.3 default threshold, or
    // edge-outline, sketch and neon-edge all do nothing.
    expect(stats.strongestEdge).toBeGreaterThan(0.3);
    // Real tonal variation for the quantising effects to bite on.
    expect(stats.deviation).toBeGreaterThan(0.12);
  });

  test('renders every tile as a square card', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    const thumb = page.locator('.fx-thumb').first();
    const box = await thumb.boundingBox();
    expect(box).not.toBeNull();
    // Square within a pixel of rounding.
    expect(Math.abs(box!.width - box!.height)).toBeLessThan(1.5);
  });

  test('shows the same frame on every tile, so hover reads as the effect switching on', async ({
    page,
  }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    const sources = await page
      .locator('.fx-thumb-still')
      .evaluateAll((imgs) => imgs.slice(0, 6).map((i) => (i as HTMLImageElement).src));
    expect(new Set(sources).size).toBe(1);
  });
});

test.describe('effect selection and keyboard', () => {
  /** Click the timeline so the shortcut layer's `timelineFocus` guard passes. */
  async function focusTimeline(page: Page): Promise<void> {
    await page
      .locator('.lane-scroll')
      .first()
      .click({ position: { x: 4, y: 4 } });
  }

  test('Backspace deletes the selected effect layer', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await tile(page, 'Halo Bloom').click();
    await expect(chips(page)).toHaveCount(1);

    await chip(page, 'halo-bloom').click();
    await page.keyboard.press('Backspace');
    await expect(chips(page)).toHaveCount(0);

    await undoButton(page).click();
    await expect(chips(page)).toHaveCount(1);
  });

  test('Delete works the same as Backspace', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await tile(page, 'Halo Bloom').click();
    await chip(page, 'halo-bloom').click();
    await page.keyboard.press('Delete');
    await expect(chips(page)).toHaveCount(0);
  });

  test('Cmd/Ctrl+A selects every effect layer, and Backspace clears them in one step', async ({
    page,
  }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await seekTo(page, 0);
    await tile(page, 'Cine Grain').click();
    await seekTo(page, 6);
    await tile(page, 'Edge Fall').click();
    await expect(chips(page)).toHaveCount(2);

    await focusTimeline(page);
    await page.keyboard.press('ControlOrMeta+a');
    // Both selected, not just the last one clicked.
    await expect(page.locator('.fx-layer.is-selected')).toHaveCount(2);

    // Select-all covers the clips too, so Delete takes the whole timeline down —
    // effect layers used to be deleted "exclusively", sparing every clip.
    await expect(page.locator('.clip-block[data-selected="true"]')).toHaveCount(3);

    // One patch for the lot, so ONE undo brings everything back.
    await page.keyboard.press('Backspace');
    await expect(chips(page)).toHaveCount(0);
    await expect(page.locator('.clip-block')).toHaveCount(0);
    await undoButton(page).click();
    await expect(chips(page)).toHaveCount(2);
    await expect(page.locator('.clip-block')).toHaveCount(3);
  });

  test('shift-click extends the effect selection', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await seekTo(page, 0);
    await tile(page, 'Cine Grain').click();
    await seekTo(page, 6);
    await tile(page, 'Edge Fall').click();

    await chip(page, 'cine-grain').click();
    await expect(page.locator('.fx-layer.is-selected')).toHaveCount(1);
    await chip(page, 'edge-fall').click({ modifiers: ['Shift'] });
    await expect(page.locator('.fx-layer.is-selected')).toHaveCount(2);
  });
});

test.describe('applying an effect to a selected clip', () => {
  test('spans exactly that clip rather than a default length at the playhead', async ({ page }) => {
    await openEditor(page);
    // clip_intro runs 0-6s in the demo project.
    await selectClip(page, 'clip_intro');
    const clipBox = await clipGeometry(page, 'clip_intro');

    await leftTab(page, 'Effects');
    // Halo Bloom's catalog default is 2s, so a playhead-anchored layer would be
    // visibly shorter than the clip. Matching the clip is the whole assertion.
    await tile(page, 'Halo Bloom').click();

    const fx = await (async () => {
      const style = (await chip(page, 'halo-bloom').getAttribute('style')) ?? '';
      return {
        left: Number(/left:\s*([\d.]+)px/.exec(style)?.[1] ?? '0'),
        width: Number(/width:\s*([\d.]+)px/.exec(style)?.[1] ?? '0'),
      };
    })();

    expect(Math.abs(fx.left - clipBox.left)).toBeLessThan(2);
    expect(Math.abs(fx.width - clipBox.width)).toBeLessThan(2);
  });

  test('falls back to the playhead when no clip is selected', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await seekTo(page, 4);
    await tile(page, 'Halo Bloom').click();
    const style = (await chip(page, 'halo-bloom').getAttribute('style')) ?? '';
    const left = Number(/left:\s*([\d.]+)px/.exec(style)?.[1] ?? '0');
    // Starts at the playhead, not at zero.
    expect(left).toBeGreaterThan(0);
  });
});

test.describe('search field', () => {
  test('centres its icon on the field', async ({ page }) => {
    // The wrapper used to be `display: block`, so its height came from the line
    // box rather than the input and the icon sat ~3.6px high. This affected every
    // icon input in the app, not just this one.
    await openEditor(page);
    await leftTab(page, 'Effects');
    const offset = await page.evaluate(() => {
      const icon = document
        .querySelector('.fx-search [data-ui="input-icon"]')!
        .getBoundingClientRect();
      const input = document.querySelector('.fx-search [data-ui="input"]')!.getBoundingClientRect();
      return Math.abs(icon.y + icon.height / 2 - (input.y + input.height / 2));
    });
    expect(offset).toBeLessThan(0.6);
  });

  test('shows no result count in the panel header', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await expect(page.locator('.effects .panel-count')).toHaveCount(0);
  });
});

test.describe('effect lane sizing and panel chrome', () => {
  test('reserves exactly the lane height, leaving no empty band', async ({ page }) => {
    // The virtualiser sizes rows independently of what the lane renders. Omitting
    // the track type there reserved a full 56px media row for a 20px effect lane,
    // which showed as a whitespace gap under every effect lane.
    await openEditor(page);
    await leftTab(page, 'Effects');
    await tile(page, 'Halo Bloom').click();

    const sizes = await page.evaluate(() => {
      const lane = document.querySelector('.track-lane.is-effect')!.getBoundingClientRect();
      const row = document
        .querySelector('.track-lane.is-effect')!
        .closest('.track')!
        .getBoundingClientRect();
      const head = document.querySelector('.track-head.is-effect')?.getBoundingClientRect();
      return { lane: lane.height, row: row.height, head: head?.height ?? 0 };
    });
    expect(sizes.row - sizes.lane).toBeLessThan(1);
    // The header strip must track the lane, or the two columns drift apart.
    expect(Math.abs(sizes.head - sizes.lane)).toBeLessThan(1);
  });

  test('is markedly shorter than a media lane', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await tile(page, 'Halo Bloom').click();
    const effect = await page.locator('.track-lane.is-effect').first().boundingBox();
    const video = await page.locator('.track-lane.is-video').first().boundingBox();
    expect(effect!.height).toBeLessThan(video!.height / 2);
  });

  test('scrolls the filter strip horizontally with a vertical wheel', async ({ page }) => {
    // The strip has no vertical overflow, so without the handler a wheel over it
    // does nothing and the later categories are only reachable by dragging.
    await openEditor(page);
    await leftTab(page, 'Effects');
    const strip = page.locator('.fx-filters');
    const before = await strip.evaluate((el) => el.scrollLeft);
    await strip.hover();
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(150);
    const after = await strip.evaluate((el) => el.scrollLeft);
    expect(after).toBeGreaterThan(before);
  });

  test('shows no redundant Effects heading in the panel', async ({ page }) => {
    // The rail tab already names the panel; repeating it cost a row the grid uses.
    await openEditor(page);
    await leftTab(page, 'Effects');
    await expect(page.locator('.effects .panel-head')).toHaveCount(0);
    // Still named for assistive tech.
    await expect(page.getByLabel('effects panel')).toBeAttached();
  });
});

test.describe('manual overlap relocates the layer', () => {
  test('dragging a layer onto a neighbour moves it to another lane', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    // Two disjoint layers on one lane.
    await seekTo(page, 0);
    await tile(page, 'Cine Grain').click();
    await seekTo(page, 8);
    await tile(page, 'Edge Fall').click();
    await expect(page.locator('.track-lane.is-effect')).toHaveCount(1);

    // Drag the later one left, over the first.
    await drag(page, chip(page, 'edge-fall'), -320);

    // Both still exist, now on separate lanes — the edit is honoured AND the
    // timeline stays readable.
    await expect(chips(page)).toHaveCount(2);
    await expect(page.locator('.track-lane.is-effect')).toHaveCount(2);
  });

  test('the relocation is one undo step', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Effects');
    await seekTo(page, 0);
    await tile(page, 'Cine Grain').click();
    await seekTo(page, 8);
    await tile(page, 'Edge Fall').click();

    await drag(page, chip(page, 'edge-fall'), -320);
    await expect(page.locator('.track-lane.is-effect')).toHaveCount(2);

    // The lane creation and the move are one patch, so a single undo removes both.
    await undoButton(page).click();
    await expect(page.locator('.track-lane.is-effect')).toHaveCount(1);
    await expect(chips(page)).toHaveCount(2);
  });
});
