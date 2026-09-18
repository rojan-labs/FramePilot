/**
 * E2E.1 — background removal from a missing pack to an exported, undoable edit
 * (plan/background-removal-ai/07, E2E.1; states and copy from 05).
 *
 *   Smart Mask absent → warning + disabled tools → install → no restart → Remove background →
 *   review the flagged range, fix it with the Keep brush → VERIFIED → lock the frame → Put text
 *   behind subject → preview frame == export frame → Export (dialog) → undo the whole chain.
 *
 * What each step proves, and on what:
 *  - UI state from the real editor in desktop mode (`masking/fake-desktop.ts`).
 *  - The resulting operations from the SAVED `project.fp.json` (what the export reads), exact on
 *    the fields the flow decides: artifact keys, review ranges, lock times, the brush prompt.
 *  - Preview == export with the PX4 oracle's comparison and gates (`masking/parity.ts`).
 *  - The export through the Export dialog → the engine's own `render()` → validation (duration,
 *    streams, the engine's checks).
 *
 * SIMULATED, and why (for RD3):
 *  - **Install.** No signed Smart Mask release exists (MO-1..MO-5) and local registration is a
 *    terminal command (`framepilot-pack register-local`), not an editor action. The host answers
 *    "missing" with a stand-in proposal; approving it runs the editor's real approve → install →
 *    progress → `capabilityPackInstalled` path, and the host then answers "ready". Download,
 *    signature and health check are `packages/capability-packs`' tests.
 *  - **The pack worker.** No model runs: each job writes a synthetic matte (left 40% subject,
 *    soft 64 px edge) to the pack's output contract with the engine helper, and the host record
 *    is made with the host's own functions and the real inspector.
 *  - Electron and `fp-media://` (see `fake-desktop.ts`).
 *
 * CI ONLY (`masking-e2e` job).
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { masksOf, type Project } from '../../../packages/timeline-schema/dist/index.js';
import type { MatteJobScript } from './masking/fake-desktop.js';
import { expectPreviewMatchesExport } from './masking/parity.js';
import {
  COLOURS,
  attachDiagnostics,
  clickInInspector,
  clip,
  clipsById,
  dragOnCanvas,
  openInDesktop,
  openMaskTab,
  project,
  savedProject,
  sidecarUrl,
  video,
  type OpenedEditor,
} from './masking/session.js';
import { Workspace } from './masking/workspace.js';

const SECONDS = 3;
/** The flagged moment the first run reports (asset source seconds). */
const FLAGGED = { start: 1, end: 1.5, reason: 'edge_misaligned' } as const;

const undoButton = (page: Page) =>
  page.getByRole('button', { name: 'Undo', exact: true }).and(page.locator('.icon-btn'));

const mattesOf = (document: Project, clipId: string) =>
  masksOf(clipsById(document).get(clipId)!).filter((mask) => mask.kind === 'matte');

let opened: OpenedEditor | null = null;
test.afterEach(async ({}, testInfo) => {
  await attachDiagnostics(testInfo, opened);
  opened = null;
});

test('E2E.1 background removal: install, remove, review and fix, verify, text behind, export, undo', async ({
  page,
}, testInfo) => {
  test.setTimeout(8 * 60_000);
  const workspace = await Workspace.create('e2e1-background-removal');
  await workspace.media([video('subject', 'red', SECONDS), video('bg', 'blue', SECONDS)]);
  await workspace.writeProject(
    project({
      id: 'e2e1_background_removal',
      name: 'E2E.1 Background removal',
      videos: [
        { id: 'subject', seconds: SECONDS },
        { id: 'bg', seconds: SECONDS },
      ],
      tracks: [
        {
          id: 'video_2',
          type: 'video',
          clips: [
            clip('video_2', { id: 'clip_subject', assetId: 'subject', start: 0, end: SECONDS }),
          ],
        },
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
        },
      ],
    }),
  );

  // The pack job: first run flags one moment; a re-run after a fix (previous artifact given)
  // covers the previous artifact's whole range, as the worker's partial re-run does.
  const intents: Record<string, unknown>[] = [];
  const matteJob: MatteJobScript = async (intent, context) => {
    intents.push(intent);
    context.onProgress({ phase: 'segment', completed: 0, total: 90 });
    const previous = intent.previousArtifactKey as string | undefined;
    const covered = previous
      ? masksOf(clipsById(context.project).get(String(intent.clipId))!).find(
          (mask) => mask.kind === 'matte' && mask.artifact.key === previous,
        )
      : undefined;
    const coverage =
      covered?.kind === 'matte'
        ? covered.artifact.coverage
        : { sourceStart: Number(intent.sourceStart), sourceEnd: Number(intent.sourceEnd) };
    const outcome = await context.desktop.synthesiseMatte(
      { ...intent, ...coverage },
      context.project,
      {
        foreground: COLOURS.red[0],
        variant: previous === undefined ? 'first' : 'fixed',
        needsReview: previous === undefined ? [FLAGGED] : [],
        projectRevision: context.projectRevision,
      },
    );
    context.onProgress({ phase: 'encode', completed: 90, total: 90 });
    return outcome;
  };

  opened = await openInDesktop(
    page,
    testInfo,
    { workspace, sidecarUrl: sidecarUrl(), packs: { 'subject.matte': 'missing' }, matteJob },
    'E2E.1 Background removal',
  );
  const { desktop } = opened;
  page.on('dialog', (dialog) => void dialog.accept());
  const canvas = await openMaskTab(page, 'clip_subject');
  const row = page.getByLabel('Background removal', { exact: true });
  const removeBackground = row.getByRole('button', { name: 'Remove background', exact: true });

  // --- absent: a warning that says what fixes it, and every pack-backed tool disabled ----------
  const warning = page.locator('#background-removal-pack-note');
  await expect(warning).toContainText("Background removal isn't installed.");
  await expect(warning).toContainText('install the Smart Mask pack');
  await expect(removeBackground).toBeDisabled();
  await expect(removeBackground).toHaveAttribute(
    'aria-describedby',
    'background-removal-pack-note',
  );
  await expect(page.getByRole('button', { name: 'AI Object tool', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'AI Brush tool', exact: true })).toBeDisabled();

  // --- install, and no restart: the same page, re-checked by the installed event ---------------
  const boot = await page.evaluate(
    () => (window as unknown as { __fpE2EBoot: string }).__fpE2EBoot,
  );
  await warning.getByRole('button', { name: /^Install / }).click();
  await expect(removeBackground).toBeEnabled({ timeout: 15_000 });
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'AI Object tool', exact: true })).toBeEnabled();
  expect(
    await page.evaluate(() => (window as unknown as { __fpE2EBoot: string }).__fpE2EBoot),
  ).toBe(boot);
  const install = desktop.calls.find((call) => call.method === 'capabilityPackInstall');
  expect(install?.args[0]).toMatchObject({
    proposalId: 'proposal-framepilot.smart-mask',
    approvedSizeBytes: 1_050_000_000,
    approvedLicenseSpdx: ['Apache-2.0'],
    approvedMediaEgress: false,
  });

  // --- Remove background: one reversible add_matte_mask with the flagged moment -----------------
  await clickInInspector(removeBackground);
  await expect(
    row.getByText('Background removed. 1 moment needs a look.', { exact: true }),
  ).toBeVisible({
    timeout: 60_000,
  });
  expect(intents[0]).toMatchObject({ assetId: 'subject', clipId: 'clip_subject', prompts: [] });
  expect(Number(intents[0]!.sourceStart)).toBe(0);
  expect(Number(intents[0]!.sourceEnd)).toBeGreaterThanOrEqual(SECONDS);
  const first = await savedProject(
    desktop,
    (document) => mattesOf(document, 'clip_subject').length === 1,
    'the background removal',
  );
  const firstMatte = mattesOf(first, 'clip_subject')[0]!;
  expect(firstMatte).toMatchObject({
    kind: 'matte',
    target: { kind: 'alpha' },
    review: { flagged: [{ start: FLAGGED.start, end: FLAGGED.end }], approved: [], locked: [] },
  });
  // Nothing about a freshly made matte is stale or broken: the Inspector shows no remedy.
  await expect(row.getByRole('alert')).toHaveCount(0);

  // --- review: the flagged moment, fixed with the Keep brush, re-run from the previous matte -----
  const review = page.getByLabel('Review', { exact: true });
  await expect(review.getByRole('status').first()).toContainText('1 moment needs a look.');
  await review.getByRole('button', { name: /^1\.00s – 1\.50s/ }).click();
  await review.getByRole('button', { name: 'Keep brush', exact: true }).click();
  await dragOnCanvas(page, canvas, [0.3, 0.4], [0.5, 0.6]);
  await clickInInspector(review.getByRole('button', { name: 'Apply fix', exact: true }));
  await expect(
    row.getByText('Background removed. Every frame was checked.', { exact: true }),
  ).toBeVisible({
    timeout: 60_000,
  });
  const brush = (
    intents[1]!.prompts as { kind: string; sha256?: string; sourceTime?: number }[]
  ).find((prompt) => prompt.kind === 'brush');
  expect(intents[1]).toMatchObject({
    previousArtifactKey: firstMatte.kind === 'matte' ? firstMatte.artifact.key : '',
  });
  expect(brush?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(brush?.sourceTime).toBeCloseTo(FLAGGED.start, 3);
  // The stroke went to the project-owned correction store through the real host handler.
  expect(
    existsSync(
      join(
        workspace.projectDir,
        '.framepilot-derived',
        'mattes',
        '.inputs',
        `${brush!.sha256!}.png`,
      ),
    ),
  ).toBe(true);
  const fixed = await savedProject(
    desktop,
    (document) => {
      const [matte] = mattesOf(document, 'clip_subject');
      return matte?.kind === 'matte' && matte.review?.flagged.length === 0;
    },
    'the fixed background removal',
  );
  const fixedMatte = mattesOf(fixed, 'clip_subject')[0]!;
  expect(fixedMatte.kind === 'matte' && fixedMatte.artifact.key).not.toBe(
    firstMatte.kind === 'matte' && firstMatte.artifact.key,
  );

  // --- VERIFIED is earned (nothing flagged), then the frame under the playhead is locked --------
  await expect(review.getByText('VERIFIED', { exact: true })).toBeVisible();
  await expect(review.getByText('Every frame checked.')).toBeVisible();
  await clickInInspector(review.getByRole('button', { name: 'Lock this frame', exact: true }));
  await expect(
    review.getByText('This frame is locked. Later runs cannot change it.'),
  ).toBeVisible();
  const locked = await savedProject(
    desktop,
    (document) => {
      const [matte] = mattesOf(document, 'clip_subject');
      return matte?.kind === 'matte' && (matte.review?.locked ?? []).length === 1;
    },
    'the locked frame',
  );
  const lockedMatte = mattesOf(locked, 'clip_subject')[0]!;
  expect(lockedMatte.kind === 'matte' && lockedMatte.review?.locked[0]).toBeCloseTo(
    FLAGGED.start,
    3,
  );
  await expect(review.getByText('VERIFIED', { exact: true })).toBeVisible();

  // --- Put text behind subject: subject copy over the title over the original --------------------
  await row.getByLabel('Text behind the subject').fill('TITLE');
  await clickInInspector(row.getByRole('button', { name: 'Put text behind subject', exact: true }));
  const behind = await savedProject(
    desktop,
    (document) => document.timeline.tracks.length === 4,
    'the text behind the subject',
  );
  const [subjectTrack, textTrack, originalTrack, bgTrack] = behind.timeline.tracks;
  expect(subjectTrack!.clips).toHaveLength(1);
  expect(masksOf(subjectTrack!.clips[0]!).map((mask) => mask.kind)).toEqual(['matte']);
  expect(textTrack!.type).toBe('overlay');
  expect(textTrack!.clips[0]!.effects[0]).toMatchObject({
    type: 'text',
    params: { text: 'TITLE' },
  });
  expect(originalTrack!.clips[0]!.id).toBe('clip_subject');
  expect(masksOf(originalTrack!.clips[0]!)).toHaveLength(0);
  expect(bgTrack!.clips[0]!.id).toBe('clip_bg');

  // --- the monitor shows exactly what the export renders ------------------------------------------
  await expectPreviewMatchesExport(page, workspace, [0.5, 1.2, 2.5], 'e2e1-text-behind', testInfo);

  // --- export through the dialog: the engine renders the saved file and validates it ------------
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export video', exact: true });
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Exported.', { timeout: 120_000 });
  const exported = desktop.exports[desktop.exports.length - 1]!.result.engine as {
    state: string;
    validation: { ok: boolean };
    probe: { durationSeconds: number; streams: { codecType: string }[] };
  };
  expect(exported.state).toBe('completed');
  expect(exported.validation.ok).toBe(true);
  expect(exported.probe.durationSeconds).toBeCloseTo(SECONDS, 1);
  expect(exported.probe.streams.some((stream) => stream.codecType === 'video')).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // --- undo the chain, newest first; each step lands on disk ------------------------------------
  const clickUndo = async (): Promise<void> => {
    await expect(undoButton(page)).toBeEnabled();
    await undoButton(page).click();
  };
  await clickUndo();
  await savedProject(
    desktop,
    (document) =>
      document.timeline.tracks.length === 2 && mattesOf(document, 'clip_subject').length === 1,
    'undo of text behind subject',
  );
  await clickUndo();
  await savedProject(
    desktop,
    (document) => {
      const [matte] = mattesOf(document, 'clip_subject');
      return (
        matte?.kind === 'matte' &&
        (matte.review?.locked ?? []).length === 0 &&
        matte.review?.flagged.length === 0
      );
    },
    'undo of the lock',
  );
  await clickUndo();
  await savedProject(
    desktop,
    (document) => {
      const [matte] = mattesOf(document, 'clip_subject');
      return (
        matte?.kind === 'matte' &&
        firstMatte.kind === 'matte' &&
        matte.artifact.key === firstMatte.artifact.key &&
        matte.review?.flagged.length === 1
      );
    },
    'undo of the fix (the first matte and its flagged moment are back)',
  );
  await clickUndo();
  await savedProject(
    desktop,
    (document) => masksOf(clipsById(document).get('clip_subject')!).length === 0,
    'undo of the background removal',
  );
  // Undo removes the edit, never the data: both artifacts stay on disk for redo.
  for (const matte of [firstMatte, fixedMatte]) {
    if (matte.kind !== 'matte') continue;
    expect(
      existsSync(
        join(
          workspace.projectDir,
          '.framepilot-derived',
          'mattes',
          matte.artifact.key,
          'matte.mkv',
        ),
      ),
    ).toBe(true);
  }
});
