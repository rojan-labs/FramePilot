/**
 * E2E.9 — Fast background removal from the Inspector: the Speed choice, whole-clip progress, a
 * Pause that pauses, Resume, and the committed edit (ADR 0182; plan 13 SP2/SP3).
 *
 *   Speed defaults to Fast with its own estimate → Remove background → the Inspector and the
 *   Jobs tab show the WHOLE clip's progress and time left → Pause in the Jobs tab stops the job
 *   within moments ("Paused") → Resume continues the SAME job as a resume → the matte lands on
 *   the clip as one edit.
 *
 * What is real: the editor (the Speed control, both progress views, the Jobs tab's actions), the
 * matte IPC, the desktop's job scheduler with its suspend hook, and `matteJobRunner`'s
 * suspend → checkpoint → resume loop. The maintainer's report was exactly this path failing: a
 * full bar beside "prepare", and a Pause that did nothing for hours.
 *
 * SIMULATED, and why (for RD3):
 *  - **The pack worker and Apple Vision.** CI's masking job is not a Mac with the helper, and no
 *    model runs in any masking spec: the scripted job reports progress the way Smart Mask 1.1.0
 *    does, stops when the host suspends it, and writes the synthetic matte. The real engine is
 *    measured in `workers/smart-mask` (tests, `eval/fast_gates.py`) and on real footage (plan 13).
 *  - **"Fast can run here".** The host's capability status says so (`fastMatte`), as the real one
 *    does on macOS with Smart Mask >= 1.1.0 (`capability-status.ts`, unit-tested).
 *  - Electron and `fp-media://` (see `fake-desktop.ts`).
 *
 * CI ONLY (`masking-e2e` job).
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { masksOf, type Project } from '../../../packages/timeline-schema/dist/index.js';
import type { MatteJobScript } from './masking/fake-desktop.js';
import {
  COLOURS,
  attachDiagnostics,
  clickInInspector,
  clip,
  clipsById,
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
const NAME = 'E2E.9 Fast background removal';
const FRAMES = 90;

const mattesOf = (document: Project, clipId: string) =>
  masksOf(clipsById(document).get(clipId)!).filter((mask) => mask.kind === 'matte');

let opened: OpenedEditor | undefined;
test.afterEach(async ({}, testInfo) => {
  if (opened !== undefined) await attachDiagnostics(testInfo, opened);
  opened = undefined;
});

test('E2E.9 Fast background removal: speed choice, whole-clip progress, pause, resume, commit', async ({
  page,
}, testInfo) => {
  test.setTimeout(6 * 60_000);
  const workspace = await Workspace.create('e2e9-fast');
  await workspace.media([video('subject', 'red', SECONDS), video('bg', 'blue', SECONDS)]);
  await workspace.writeProject(
    project({
      id: 'e2e9_fast',
      name: NAME,
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

  // The scripted worker: a third of the clip, then it holds until the host either suspends it
  // (Pause) or, on the resumed run, lets it finish.
  const runs: { intent: Record<string, unknown>; resume: boolean }[] = [];
  const matteJob: MatteJobScript = async (intent, context) => {
    runs.push({ intent, resume: context.resume });
    context.onProgress({
      phase: 'prepare',
      completed: 1,
      total: 1,
      overallCompleted: 0,
      overallTotal: FRAMES,
    });
    context.onProgress({
      phase: 'segment',
      completed: 12,
      total: 240,
      etaSeconds: 40,
      overallCompleted: context.resume ? 60 : 30,
      overallTotal: FRAMES,
      jobEtaSeconds: 300,
    });
    if (!context.resume) {
      // A real worker keeps going until the host stops it; nothing finishes on this run.
      await context.suspended;
      return {
        status: 'failed',
        code: 'cancelled',
        detail: 'Background removal cancelled.',
        retryable: false,
      };
    }
    const outcome = await context.desktop.synthesiseMatte(intent, context.project, {
      foreground: COLOURS.red[0],
      variant: 'first',
      needsReview: [],
      projectRevision: context.projectRevision,
    });
    context.onProgress({
      phase: 'encode',
      completed: 1,
      total: 1,
      overallCompleted: FRAMES,
      overallTotal: FRAMES,
    });
    return outcome;
  };

  opened = await openInDesktop(
    page,
    testInfo,
    {
      workspace,
      sidecarUrl: sidecarUrl(),
      fastMatte: true,
      matteJob,
      jobJournal: join(workspace.root, 'user-data', 'capability-pack-jobs.json'),
    },
    NAME,
  );
  const { desktop } = opened;
  page.on('dialog', (dialog) => void dialog.accept());
  await openMaskTab(page, 'clip_subject');
  const row = page.getByLabel('Background removal', { exact: true });

  // --- the Speed choice: Fast by default, priced as Fast, and honest about what it is for --------
  const speed = row.getByRole('combobox', { name: 'background removal speed', exact: true });
  await expect(speed).toContainText('Fast (minutes)');
  await expect(row.getByText(/Fast works best with one clear subject/)).toBeVisible();
  // 3 s + 2 s of handles each side, at Fast's 10 compute-seconds per footage second: not hours.
  await expect(
    row.getByText(/About \d+ seconds on this computer|About 1 minute on this computer/),
  ).toBeVisible();

  await clickInInspector(row.getByRole('button', { name: 'Remove background', exact: true }));
  await expect.poll(() => runs.length).toBe(1);
  expect(runs[0]!.intent).toMatchObject({ quality: 'fast', clipId: 'clip_subject', prompts: [] });
  expect(runs[0]!.resume).toBe(false);

  // --- progress is the WHOLE clip's, in the Inspector and in the Jobs tab ------------------------
  await expect(row.getByText('Finding the subject · 33% of the clip', { exact: true })).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  const inspectorBar = row.getByRole('progressbar', {
    name: 'Background removal progress',
    exact: true,
  });
  await expect(inspectorBar).toHaveAttribute('aria-valuetext', '30 of 90 frames');
  await expect(row.getByText(/about 5 minutes left$/)).toBeVisible();

  await page.getByRole('tab', { name: 'Jobs', exact: true }).click();
  const jobs = page.locator('.jobs-panel');
  const jobBar = jobs.getByRole('progressbar', { name: 'Remove background progress', exact: true });
  await expect(jobBar).toHaveAttribute('aria-valuenow', '33');
  await expect(jobs.getByText('About 5 min left', { exact: true })).toBeVisible();
  await expect(jobs.getByText(/in this step/)).toHaveCount(0);

  // --- Pause pauses: the job stops now, not when the clip is done ---------------------------------
  await jobs.getByRole('button', { name: 'Pause Remove background', exact: true }).click();
  await expect(
    jobs.getByRole('listitem', { name: 'Remove background: Paused', exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
  expect(runs).toHaveLength(1);
  // Nothing was committed by the suspended run.
  expect(desktop.saves.every((document) => mattesOf(document, 'clip_subject').length === 0)).toBe(
    true,
  );

  // --- Resume continues the SAME job, as a resume, and the matte lands as one edit -----------------
  await jobs.getByRole('button', { name: 'Resume Remove background', exact: true }).click();
  await expect.poll(() => runs.length, { timeout: 30_000 }).toBe(2);
  expect(runs[1]!.resume).toBe(true);
  expect(runs[1]!.intent).toMatchObject({ requestId: runs[0]!.intent.requestId, quality: 'fast' });

  const saved = await savedProject(
    desktop,
    (document) => mattesOf(document, 'clip_subject').length === 1,
    'the Fast background removal',
    90_000,
  );
  expect(mattesOf(saved, 'clip_subject')[0]).toMatchObject({
    kind: 'matte',
    target: { kind: 'alpha' },
  });
  await expect(
    jobs.getByRole('listitem', { name: 'Remove background: Done', exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
});
