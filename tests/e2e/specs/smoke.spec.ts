/**
 * Smoke test: the web editor boots and its core surfaces are reachable.
 *
 * The full PRD §16.1 critical-flow coverage lives in dedicated specs:
 *   - project-and-transport.spec.ts        (create/load project, J/K/L/Space)
 *   - timeline-interaction.spec.ts         (select/split/trim/move/delete/undo/redo/seek)
 *   - transcript-and-captions.spec.ts      (transcript view, generate captions)
 *   - ai-edit-review-apply-undo.spec.ts    (mock AI: propose → review → apply → undo)
 *   - preview-export-validate.spec.ts      (preview engine; export desktop-only boundary)
 *   - visual.spec.ts                       (visual regression of the key surfaces)
 *
 * Flows that are desktop-only (real export/render + output validation, live
 * media import/transcription via the Python engine) are intentionally not faked
 * here; see preview-export-validate.spec.ts for the rationale.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './helpers.js';

test.describe('FramePilot web editor smoke', () => {
  test('boots and exposes the editor chrome + rails', async ({ page }) => {
    await openEditor(page);
    await expect(page.getByRole('toolbar', { name: 'editor tools' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'timeline' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'AI' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Inspector' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Transcription' })).toBeVisible();
  });
});
