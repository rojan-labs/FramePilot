/**
 * Shared Playwright helpers for the FramePilot browser E2E suite.
 *
 * The web build of `apps/web-editor` runs fully in-browser with the offline mock
 * AI provider — no Electron, no Python engine, no network. It boots into a fixed
 * "Demo Project" (`src/editor/demo.ts`): a video track with `clip_intro` (0–6s)
 * and `clip_body` (6–14s), an audio track with `clip_vo` (0–14s), an empty
 * caption track, and an 8-word transcript starting with "Welcome".
 *
 * These helpers centralise the selectors so a UI rename touches one place. They
 * prefer role/label selectors (matching the real DOM) over invented test ids.
 */
import { type Locator, type Page, expect } from '@playwright/test';

/** Open the editor on a clean slate (no carried-over localStorage project). */
export async function openEditor(page: Page): Promise<void> {
  // The app autosaves the working project to localStorage and restores it on
  // reload (App.tsx). Each Playwright test gets a fresh context, so storage is
  // empty; `?demo` boots the fixed Demo Project directly (past the HomeScreen).
  await page.goto('/?demo');
  await expect(page.getByLabel('project name')).toHaveText('Demo Project');
  // Wait for the timeline to render its seed clips before any interaction.
  await expect(clip(page, 'clip_intro')).toBeVisible();
}

/** The timeline clip block for a clip id (e.g. `clip_intro`). */
export function clip(page: Page, id: string): Locator {
  return page.getByRole('button', { name: `clip ${id}`, exact: true });
}

/** Count of clip blocks currently rendered across all tracks. */
export function clipCount(page: Page): Locator {
  return page.locator('.clip-block');
}

/** The toolbar Undo button (disambiguated from the toast "Undo" action by its title). */
export function undoButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Undo', exact: true }).and(page.locator('.icon-btn'));
}

/** The toolbar Redo button. */
export function redoButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Redo', exact: true }).and(page.locator('.icon-btn'));
}

/** Select a clip on the timeline (records the selection in the editor store). */
export async function selectClip(page: Page, id: string): Promise<void> {
  await clip(page, id).click();
  await expect(clip(page, id)).toHaveAttribute('data-selected', 'true');
}

/** Move the playhead to an absolute time (seconds) via the accessible scrubber. */
export async function seekTo(page: Page, seconds: number): Promise<void> {
  await page.getByLabel('playhead', { exact: true }).fill(String(seconds));
}

/** Switch the right-hand rail to a tab (AI / Inspector). */
export async function rightTab(page: Page, name: 'AI' | 'Inspector'): Promise<void> {
  await page.getByRole('tab', { name }).click();
}

/** Open the Transcription drawer from its Topbar button (it is not a right-rail tab). */
export async function openTranscription(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Transcription' }).click();
}

/** Switch the left-hand rail to a tab (Assets / Effects / Text / Captions). */
export async function leftTab(
  page: Page,
  name: 'Assets' | 'Effects' | 'Text' | 'Captions',
): Promise<void> {
  await page.getByRole('tab', { name }).click();
}

/**
 * Read the absolute `left`/`width` (px) of a clip block from its inline style.
 * The timeline projects time→pixels with the pure `secondsToPx`, so geometry is a
 * faithful, assertable proxy for the clip's `start`/`duration`.
 */
export async function clipGeometry(
  page: Page,
  id: string,
): Promise<{ left: number; width: number }> {
  const style = (await clip(page, id).getAttribute('style')) ?? '';
  const left = Number(/left:\s*([\d.]+)px/.exec(style)?.[1] ?? 'NaN');
  const width = Number(/width:\s*([\d.]+)px/.exec(style)?.[1] ?? 'NaN');
  return { left, width };
}
