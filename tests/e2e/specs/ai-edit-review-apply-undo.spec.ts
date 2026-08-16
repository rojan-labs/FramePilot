/**
 * PRD §16.1 / Phase 11 M9 — the streaming AI sidebar (ADR 0033), through the
 * offline **mock** provider (the browser default).
 *
 * "use AI edit command → the edit lands on the timeline → undo it". The mock provider
 * deterministically proposes `delete_range` on `video_1` from 0–3.2s whenever editing
 * tools are offered (ai-sdk/providers/mock.ts); against the seeded demo timeline that
 * trims `clip_intro` (0–6s) down to 3.2–6s.
 *
 * There is no Accept/Reject step any more: a validated edit applies as it arrives and Undo
 * is how it is taken back (plan/INSTANT-APPLY.md). What this pins is the property that
 * change exists for — the timeline actually moves, without a click — and that undo still
 * fully reverses it, since Undo is now the whole safety net.
 *
 * No network, no Electron, no Python engine: the sidebar's `AiSession` falls back
 * to the mock orchestrator in the browser (editor/ai.ts → createAiSession).
 */
import { test, expect } from '@playwright/test';
import { clipGeometry, openEditor, rightTab, undoButton } from './helpers.js';

/** Pick a sidebar mode from the AI-mode dropdown (the mode selector is a menu,
 *  not a tab strip, since the sidebar rework). */
async function selectMode(page: import('@playwright/test').Page, mode: 'Chat' | 'Edit' | 'Agent') {
  await page.getByRole('button', { name: 'AI mode' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${mode}\\b`) }).click();
}

/** The change line the mock edit produces against the demo timeline. */
const EXPECTED_CHANGE = '[video_1] ~ clip clip_intro (0–6s → 3.2–6s)';

test.describe('AI sidebar: edit → review → apply → undo', () => {
  test('keeps the active chat mounted while Inspector is open', async ({ page }) => {
    await openEditor(page);
    await rightTab(page, 'AI');

    const sidebar = page.getByTestId('ai-sidebar');
    await page.getByLabel('Message FramePilot').fill('keep this draft while I inspect a clip');
    const sidebarNode = await sidebar.elementHandle();
    await sidebar.evaluate((node) => node.setAttribute('data-e2e-instance', 'preserved'));

    await rightTab(page, 'Inspector');
    expect(await sidebarNode?.evaluate((node) => node.isConnected)).toBe(true);

    await rightTab(page, 'AI');
    await expect(page.getByTestId('ai-sidebar')).toBeAttached();
    await expect(page.getByTestId('ai-sidebar')).toHaveAttribute('data-e2e-instance', 'preserved');
    await expect(page.getByLabel('Message FramePilot')).toHaveValue(
      'keep this draft while I inspect a clip',
    );
  });

  test('shows the active context window immediately before Send with hover details', async ({
    page,
  }) => {
    await openEditor(page);
    await rightTab(page, 'AI');

    const context = page.getByRole('button', { name: /^Context:/ });
    const send = page.getByLabel('Send');
    await expect(context).toBeVisible();
    await expect(context).toHaveAttribute('aria-label', /No request accounted for yet/);
    const immediatelyBeforeSend = await context.evaluate(
      (element) =>
        element.closest('.ai-context')?.nextElementSibling?.getAttribute('aria-label') === 'Send',
    );
    expect(immediatelyBeforeSend).toBe(true);

    await context.hover();
    await expect(page.getByRole('tooltip')).toContainText('No request accounted for yet');

    await page.getByLabel('Message FramePilot').fill('how long is this video?');
    await send.click();
    await expect(context).not.toHaveAttribute('aria-label', /No request accounted for yet/);
  });

  test('applies the streamed edit to the timeline with no click, and undoes it', async ({
    page,
  }) => {
    await openEditor(page);

    const before = await clipGeometry(page, 'clip_intro');
    expect(before.left).toBe(0); // clip_intro starts the timeline at 0px for 6s.

    await rightTab(page, 'AI');
    await selectMode(page, 'Edit');
    await page.getByLabel('Message FramePilot').fill('tighten the intro');
    await page.getByLabel('Send').click();

    // The receipt: past tense, with the structured change list. Nothing to accept.
    const diff = page.locator('.ai-event--diff');
    await expect(diff).toBeVisible();
    await expect(diff.locator('.ai-diff-changes li')).toHaveText(EXPECTED_CHANGE);
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);

    // The timeline moved on its own: clip_intro now starts at 3.2s.
    await expect
      .poll(async () => (await clipGeometry(page, 'clip_intro')).left)
      .toBeGreaterThan(before.left);
    const after = await clipGeometry(page, 'clip_intro');
    expect(after.width).toBeLessThan(before.width); // duration 6s → 2.8s

    // Undo is the whole safety net now, so it must fully reverse the run.
    await undoButton(page).click();
    const reverted = await clipGeometry(page, 'clip_intro');
    expect(reverted.left).toBe(before.left);
    expect(reverted.width).toBeCloseTo(before.width, 0);
  });

  test('offers Undo run for the edits the run just made', async ({ page }) => {
    await openEditor(page);
    const before = await clipGeometry(page, 'clip_intro');

    await rightTab(page, 'AI');
    await selectMode(page, 'Edit');
    // Wording with no recipe topic/action match (see RECIPE_SIGNATURES), so the mock's
    // canned tool call reaches the sidebar as a normal Edit-mode proposal rather than
    // being claimed by the deterministic `remove_silence` recipe, which needs a sidecar
    // this offline browser test intentionally has none of.
    await page.getByLabel('Message FramePilot').fill('shorten the start of the clip');
    await page.getByLabel('Send').click();

    await expect(page.locator('.ai-event--diff')).toBeVisible();
    const footer = page.locator('.ai-run-footer');
    await expect(footer).toContainText('Made 1 edit');

    await footer.getByRole('button', { name: 'Undo run' }).click();
    const reverted = await clipGeometry(page, 'clip_intro');
    expect(reverted.left).toBe(before.left);
    expect(reverted.width).toBeCloseTo(before.width, 0);
  });

  test('chat mode answers as streamed text without proposing an edit', async ({ page }) => {
    await openEditor(page);
    await rightTab(page, 'AI');
    await selectMode(page, 'Chat');
    await page.getByLabel('Message FramePilot').fill('how long is this video?');
    await page.getByLabel('Send').click();

    // The mock returns a deterministic chat answer; no diff card appears.
    await expect(page.locator('.ai-bubble--assistant')).toContainText(
      'deterministic offline answer',
    );
    await expect(page.locator('.ai-event--diff')).toHaveCount(0);
  });
});
