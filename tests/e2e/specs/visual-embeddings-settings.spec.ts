/**
 * Media intelligence — Settings → AI, the browser-reachable slice
 * (plan MEDIA-INTELLIGENCE MI7.4).
 *
 * The visual index lives in the Python sidecar (single writer, TS never opens
 * the file), and this harness boots neither the sidecar nor Electron (see
 * playwright.config.ts — the web build runs fully in-browser with the offline
 * mock provider, no network, no engine). So a real index or a real
 * `search_visual` round-trip cannot run here and is deliberately NOT attempted.
 *
 * Scope, stated plainly rather than implied — the sidecar-backed halves are
 * covered at the integration level, not here:
 *  - Building the index and searching it (import → index → search →
 *    search-driven edit) needs a live engine. It is covered by the engine
 *    pytest suite (`engine/python/tests/test_service_brain.py` and the
 *    vector-store / visual-index tests) and by ai-sdk's visual-index unit tests.
 *  - The orchestrator search→cite→edit round-trip is covered by ai-sdk's
 *    `orchestrator-stream.test.ts` (the MI6.3 golden test).
 *
 * **What this suite covers changed with the product.** Preparation is automatic
 * now: there is no Embeddings sub-view, no NVIDIA key field, no auto-index switch
 * and no "Index now" button — configuring a key IS the opt-in, and FramePilot
 * prepares media on import or first need. The invariant underneath is unchanged
 * and is what these still prove: with no key and no engine, the panel says so
 * rather than implying footage is understood. That is the visual-index analogue
 * of what `brain-absent-degradation.spec.ts` proves for the brain.
 *
 * The default `openEditor` harness boots the fixed Demo Project, so a project
 * IS open (App.tsx passes `projectId={project.id}`); the honest-unavailable
 * state exercised here is therefore "project open, no key configured".
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './helpers.js';

const KEY_LABEL = 'TwelveLabs API key';

/** Open Settings → AI and return the scoped Settings dialog. */
async function openAiSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  // The left nav "AI" tab (scoped to the dialog to avoid the right-rail AI tab).
  await dialog.getByRole('tab', { name: 'AI' }).click();
  return dialog;
}

/** The Media intelligence group, scoped so shared labels resolve unambiguously. */
function mediaIntelligence(dialog: ReturnType<Page['getByRole']>) {
  return dialog.getByRole('region', { name: 'Media intelligence' });
}

test.describe('media intelligence settings: browser surface + honest-unavailable', () => {
  test('renders the key input and states that preparation is automatic', async ({ page }) => {
    await openEditor(page);
    const panel = mediaIntelligence(await openAiSettings(page));

    await expect(panel.getByLabel(KEY_LABEL)).toBeVisible();
    await expect(panel.getByText(/no manual indexing step/)).toBeVisible();
  });

  test('offers no manual indexing controls', async ({ page }) => {
    await openEditor(page);
    const dialog = await openAiSettings(page);

    // These are gone by design. Asserting their absence keeps a future "helpful"
    // re-add from quietly reintroducing a workflow the product decided against.
    await expect(dialog.getByRole('button', { name: 'Index now' })).toHaveCount(0);
    await expect(dialog.getByRole('switch', { name: 'Auto-index imported media' })).toHaveCount(0);
    // The panel CAN offer to retry, but only ever next to a named failure. On a healthy
    // project there is nothing that has gone wrong, so there is nothing to offer — which
    // is the line between recovery and a manual indexing step sneaking back in.
    await expect(dialog.getByRole('button', { name: /Retry/ })).toHaveCount(0);
  });

  test('with no key, the panel is truthful about what is unavailable', async ({ page }) => {
    await openEditor(page);
    const panel = mediaIntelligence(await openAiSettings(page));

    // A project is open (Demo Project) but no key is set: the panel must say the
    // understanding backend is off and name what still works, rather than implying
    // footage is understood — the never-claim-a-fake-result invariant.
    await expect(panel.getByText('Local facts only')).toBeVisible();
    await expect(
      panel.getByText(/remain available without a media-understanding key/),
    ).toBeVisible();
  });

  test('a configured key flips the reported state, and the value round-trips', async ({ page }) => {
    await openEditor(page);
    const panel = mediaIntelligence(await openAiSettings(page));

    const keyInput = panel.getByLabel(KEY_LABEL);
    await keyInput.fill('tlk-test-key');
    await expect(keyInput).toHaveValue('tlk-test-key');

    await expect(panel.getByText('TwelveLabs ready')).toBeVisible();
    await expect(panel.getByText('Local facts only')).toHaveCount(0);
  });
});
