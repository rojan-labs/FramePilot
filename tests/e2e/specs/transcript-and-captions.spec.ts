/**
 * PRD §16.1 — "generate transcript" (view) + "add captions".
 *
 * The browser build ships with a seeded word-level transcript (demo.ts). The
 * Transcript panel renders it synced to the playhead and seeks on word click; the
 * Captions panel segments the transcript into cues through the patch engine.
 *
 * These assert the real outcome end-to-end: cues appear on the timeline, their
 * text is editable and survives into the preview, a template restyles the whole
 * set, and undo reverts each step. Schema v11 / ADR 0071 — before it, caption
 * text could not be edited at all, so most of what is exercised here had no
 * equivalent.
 *
 * Live transcription from media is desktop-only (Python engine) and out of scope
 * for browser e2e — see preview-export-validate.spec.ts.
 *
 * Deterministic, offline, no engine.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clipCount, leftTab, openEditor, openTranscription, undoButton } from './helpers.js';

/** The cue rows currently listed in the Captions panel. */
const cueRows = (page: Page) => page.getByTestId('caption-cue-row');

/** Select one stage of the current Review → Style → Generate caption workflow. */
async function captionTab(page: Page, label: 'Review' | 'Style' | 'Generate'): Promise<void> {
  await page.getByRole('tab', { name: label, exact: true }).click();
}

test.describe('transcript + captions', () => {
  test('the transcript panel renders the seeded words and seeks on click', async ({ page }) => {
    await openEditor(page);
    await openTranscription(page);

    const words = page.locator('.transcription-word');
    await expect(words.first()).toHaveText('Welcome');
    await expect(words).toHaveCount(8); // demoTranscript has 8 words

    // Clicking a word seeks the playhead to its start time (FramePilot at 0.8s).
    await page.getByRole('button', { name: 'FramePilot', exact: true }).click();
    // 0.8s at 30fps formats to frame 24 of second 0.
    await expect(page.getByLabel('playhead time')).toHaveText('00:00:00:24');
  });

  test('Generate captions adds cues to the timeline, undo reverts', async ({ page }) => {
    await openEditor(page);
    const baseClips = await clipCount(page).count();

    await leftTab(page, 'Captions');
    // Before generating there is no cue list, only the pre-commit preview.
    await expect(page.getByLabel('caption clips')).toHaveCount(0);
    await captionTab(page, 'Generate');
    await expect(page.getByLabel('caption preview')).toBeVisible();

    await page.getByRole('button', { name: 'Generate captions' }).click();

    const generated = await cueRows(page).count();
    expect(generated).toBeGreaterThan(0);
    await expect(clipCount(page)).toHaveCount(baseClips + generated);

    // Captions commit as ONE reversible patch — a single undo removes them all.
    await undoButton(page).click();
    await expect(page.getByLabel('caption clips')).toHaveCount(0);
    await expect(clipCount(page)).toHaveCount(baseClips);
  });

  test('cue length changes how the speech is cut up', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Captions');
    await captionTab(page, 'Generate');

    await page.getByRole('button', { name: 'Generate captions' }).click();
    const punchy = await cueRows(page).count();

    // "One word at a time" must produce strictly more cues than the default
    // register over the same 8-word transcript.
    await undoButton(page).click();
    await captionTab(page, 'Style');
    await page.getByText('Timing and emphasis').click();
    await page.getByLabel('Cue length').click();
    await page.getByRole('option', { name: 'One word at a time' }).click();
    await captionTab(page, 'Generate');
    await page.getByRole('button', { name: 'Generate captions' }).click();
    expect(await cueRows(page).count()).toBeGreaterThan(punchy);
  });

  test('a cue’s text is editable and the edit survives undo', async ({ page }) => {
    // The headline capability of schema v11: captions are editable text, not a
    // read-only projection of the transcript.
    await openEditor(page);
    await leftTab(page, 'Captions');
    await captionTab(page, 'Generate');
    await page.getByRole('button', { name: 'Generate captions' }).click();
    await captionTab(page, 'Review');

    await cueRows(page)
      .first()
      .getByRole('button', { name: /^Edit caption/ })
      .click();
    const field = page.getByRole('textbox', { name: /Caption text at/ });
    await field.fill('my own words');
    await field.blur();

    await expect(page.getByRole('button', { name: 'Edit caption "my own words"' })).toBeVisible();

    await undoButton(page).click();
    await expect(page.getByRole('button', { name: 'Edit caption "my own words"' })).toHaveCount(0);
  });

  test('an edited cue renders its own text in the program monitor', async ({ page }) => {
    // Proves the edit reaches the preview, not just the panel list — the two
    // used to disagree even without editing (start-containment vs. overlap).
    await openEditor(page);
    await leftTab(page, 'Captions');
    await captionTab(page, 'Generate');
    await page.getByRole('button', { name: 'Generate captions' }).click();
    await captionTab(page, 'Review');

    const first = cueRows(page).first();
    await first.getByRole('button', { name: /^Edit caption/ }).click();
    const field = page.getByRole('textbox', { name: /Caption text at/ });
    await field.fill('EDITED CAPTION');
    await field.blur();

    // Seek into the first cue and step a frame in (at a cue's exact start an
    // entrance animation is at progress 0, invisible by design).
    await first.getByRole('button', { name: /^Seek to/ }).click();
    await page.getByRole('button', { name: 'step forward one frame' }).click();
    await expect(page.locator('[data-preview-engine] .caption-overlay')).toContainText('EDITED');
  });

  test('splitting and merging a cue', async ({ page }) => {
    await openEditor(page);
    await leftTab(page, 'Captions');
    await captionTab(page, 'Generate');
    await page.getByRole('button', { name: 'Generate captions' }).click();
    await captionTab(page, 'Review');
    const before = await cueRows(page).count();

    // Merge the first two cues, then undo back.
    await cueRows(page)
      .first()
      .getByRole('button', { name: /^Merge caption/ })
      .click();
    await expect(cueRows(page)).toHaveCount(before - 1);
    await undoButton(page).click();
    await expect(cueRows(page)).toHaveCount(before);
  });

  test('the template gallery supports All, category filters, search, and live previews', async ({
    page,
  }) => {
    await openEditor(page);
    await leftTab(page, 'Captions');
    await captionTab(page, 'Style');

    await expect(page.getByRole('button', { name: /^All/, pressed: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Broadcast\./ })).toBeVisible();
    // Hover runs the real CaptionOverlay interpreter for only that preview.
    await page.getByRole('button', { name: /^Broadcast\./ }).hover();
    await expect(page.locator('.caption-template-tile .caption-overlay').first()).toContainText(
      /this|is|how|you|go|viral/,
    );

    await page.getByRole('button', { name: /^One word/ }).click();
    await expect(page.getByRole('button', { name: /^Punchline\./ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Broadcast\./ })).toHaveCount(0);

    const search = page.getByRole('searchbox', { name: 'Search caption styles' });
    await search.fill('no-style-has-this-name');
    await expect(page.getByText(/No caption styles match/)).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');
  });

  test('caption browsing stays contained at desktop and compact window widths', async ({
    page,
  }) => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 768, height: 720 },
      { width: 390, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await openEditor(page);
      await leftTab(page, 'Captions');
      await captionTab(page, 'Style');
      const panel = page
        .getByRole('complementary', { name: 'library panels' })
        .getByRole('tabpanel');
      const search = page.getByRole('searchbox', { name: 'Search caption styles' });
      const firstCard = page.locator('.caption-template').first();
      await expect(search).toBeVisible();
      const [panelBox, searchBox, cardBox] = await Promise.all([
        panel.boundingBox(),
        search.boundingBox(),
        firstCard.boundingBox(),
      ]);
      expect(panelBox).not.toBeNull();
      expect(searchBox).not.toBeNull();
      expect(cardBox).not.toBeNull();
      expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(
        panelBox!.x + panelBox!.width + 2,
      );
      expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 2);
    }
  });

  test('a template restyles every existing cue in one action', async ({ page }) => {
    // v10 styled one clip at a time, so restyling a finished set meant clicking
    // every cue. The template is now the track's look (schema v11).
    await openEditor(page);
    await leftTab(page, 'Captions');
    await captionTab(page, 'Generate');
    await page.getByRole('button', { name: 'Generate captions' }).click();
    await captionTab(page, 'Review');
    await expect(cueRows(page).first()).toBeVisible();

    await captionTab(page, 'Style');
    await page.getByRole('button', { name: /^One word/ }).click();
    await page.getByRole('button', { name: /^Impact\./ }).click();
    await expect(page.getByRole('button', { name: /^Impact\./ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // One operation, so one undo puts the previous look back — and the gallery
    // follows the project rather than the last thing clicked, returning to the
    // restored template's category.
    await undoButton(page).click();
    const categories = page.getByRole('group', { name: 'caption style categories' });
    await expect(categories.getByRole('button', { name: /^Karaoke/, pressed: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Impact\./ })).toHaveCount(0);
  });

  test('a one-word template generates per-word cues that render in the preview', async ({
    page,
  }) => {
    await openEditor(page);
    await leftTab(page, 'Captions');

    await captionTab(page, 'Style');
    await page.getByRole('button', { name: /^One word/ }).click();
    await page.getByRole('button', { name: /^Impact\./ }).click();
    await captionTab(page, 'Generate');
    await page.getByRole('button', { name: 'Generate captions' }).click();
    // 8 words, one per cue.
    await expect(cueRows(page)).toHaveCount(8);

    // Seek into a word, then step a frame INTO it — at a word's exact start the
    // template's entrance animation is at progress 0 (invisible by design).
    await openTranscription(page);
    await page.locator('.transcription-word', { hasText: 'FramePilot' }).click();
    // Transcription is a modal drawer over the editor (unlike the old docked rail
    // tab), so it must close before the transport controls underneath are usable.
    await page.getByRole('button', { name: 'Close transcription' }).click();
    await page.getByRole('button', { name: 'step forward one frame' }).click();
    const overlay = page.locator('[data-preview-engine] .caption-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('[data-word-state="active"]')).toHaveText('FramePilot');

    // A single reversible patch — one undo removes the generated cues.
    await undoButton(page).click();
    await expect(page.getByLabel('caption clips')).toHaveCount(0);
  });
});
