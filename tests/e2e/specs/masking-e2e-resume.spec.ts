/**
 * E2E.6 — a background removal survives a crash, and changed media is caught and recomputed
 * (plan/background-removal-ai/07, E2E.6).
 *
 *   Remove background → the app dies mid-job (window 1 finished, window 2 started) → relaunch
 *   and reopen → the Jobs panel resumes the job ("Resumed after restart") and the worker
 *   restores window 1 instead of recomputing it → the matte is byte-identical to an
 *   uninterrupted run of the same request → Remove background applies it (cache hit) →
 *   relink the clip to different media → STALE with the engine's remedy, and the export refuses
 *   → Remove background again → a new matte replaces the stale one → preview == export → export.
 *
 * What each step proves, and on what:
 *  - The job survives through the REAL host: the desktop's job scheduler and its file journal,
 *    resume-on-open (`resumeMatteJobs`, what `main.ts` runs), the real matte service (staging,
 *    orphan adoption, verification, commit) and `runCapabilityPackWorker`.
 *  - "Resumes from finished windows" is the WORKER's own evidence: the resumed run reports
 *    `resumed a finished window` and decodes one window fewer than an uninterrupted run.
 *  - "Identical" is bytes: `matte.mkv`, `frames.json` and `preview.webm` of the resumed run equal
 *    an uninterrupted run's (same request, a second project folder), and the export's frames of
 *    both projects hash the same. (`report.json` records timings and is not compared.)
 *  - STALE comes from main's re-check (the real relink handler and media inspector hashing
 *    decoded frames through the sidecar) and the export's own refusal sentence.
 *
 * SIMULATED, and why (for RD3):
 *  - **The crash.** A Playwright host cannot kill itself and come back. The worker exits 137 as
 *    window 2 starts (after window 1's checkpoint is on disk) and the host's run never returns,
 *    so no cleanup runs: the journal and the staging folder are exactly what a killed app leaves.
 *    "Relaunch" is a second host on the same journal file in a fresh browser context.
 *  - **The models** (`smart-mask-pack.ts`): the real Smart Mask pipeline runs with the worker
 *    suite's scripted models, because no weights exist in CI; windows are 16 frames.
 *  - The pack install, the auto prompt (a fixed box stands in for Subject Intelligence),
 *    Electron and `fp-media://` (`masking/fake-desktop.ts`).
 *
 * CI ONLY (`masking-e2e` job; needs workers/smart-mask's `cv` extra).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { masksOf, type Project } from '../../../packages/timeline-schema/dist/index.js';
import { writeProjectFile } from '../../../packages/timeline-schema/dist/project-file.js';
import { DesktopMatteMediaInspector } from '../../../apps/desktop/dist/capability-packs/matte-media-inspector.js';
import { readMatteRecord } from '../../../apps/desktop/dist/capability-packs/matte-store.js';
import type { CapabilityPackMatteService } from '../../../apps/desktop/dist/capability-packs/matte.js';
import { expectPreviewMatchesExport } from './masking/parity.js';
import {
  FPS,
  HEIGHT,
  WIDTH,
  attachDiagnostics,
  clickInInspector,
  clip,
  clipsById,
  expectValidExport,
  openInDesktop,
  openMaskTab,
  project,
  savedProject,
  sidecarUrl,
  video,
  type OpenedEditor,
} from './masking/session.js';
import { ScriptedSmartMaskPack, type WorkerEvent } from './masking/smart-mask-pack.js';
import { Workspace, type VideoRequest } from './masking/workspace.js';

const SECONDS = 2;
const NAME = 'E2E.6 Resume';
/** A gray picture with the "subject" (red, what the scripted models follow) top right. */
const subjectVideo = (path: string, gray: number): VideoRequest => ({
  path,
  width: WIDTH,
  height: HEIGHT,
  fps: FPS,
  seconds: SECONDS,
  primary: [gray, gray, gray],
  secondary: [220, 30, 30],
});
/** `MATTE_REMEDIES['matte_media_changed']` in the engine (`render/mattes.py`), verbatim. */
const STALE_REMEDY = 'Media changed since background removal ran — run Remove background again.';
/** Files a resumed run must reproduce bit for bit (`report.json` carries timings). */
const COMPARED = ['matte.mkv', 'frames.json', 'preview.webm'];

const mattesOf = (document: Project) =>
  masksOf(clipsById(document).get('clip_subject')!).filter((mask) => mask.kind === 'matte');
const windowsDecoded = (events: readonly WorkerEvent[]) =>
  events.filter((event) => event.phase === 'decode' && event.completed === 1).length;

/** A fresh browser context: the relaunched app shares nothing in memory with the dead one. */
async function newEditorPage(browser: Browser, baseURL: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });
  return context.newPage();
}

async function compared(projectDir: string, key: string): Promise<Record<string, string>> {
  const record = await readMatteRecord(projectDir, key);
  if (record === undefined) throw new Error(`No matte record for ${key}`);
  return Object.fromEntries(
    record.files
      .filter((file) => COMPARED.includes(file.name))
      .map((file) => [file.name, file.sha256]),
  );
}

let opened: OpenedEditor | null = null;
test.afterEach(async ({}, testInfo) => {
  await attachDiagnostics(testInfo, opened);
  opened = null;
});

test('E2E.6 crash mid-job, relaunch, resume from finished windows, identical output; relink → STALE → recompute', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(12 * 60_000);
  const workspace = await Workspace.create('e2e6-resume');
  await workspace.media([
    subjectVideo('media/subject.mp4', 90),
    subjectVideo('media/subject-v2.mp4', 150),
    video('bg', 'blue', SECONDS),
  ]);
  const base = project({
    id: 'e2e6_resume',
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
  });
  await workspace.writeProject(base);
  const pack = await ScriptedSmartMaskPack.install(workspace);
  const journal = join(workspace.root, 'user-data', 'capability-pack-jobs.json');
  const crashedRun = join(workspace.root, 'worker-run-1.jsonl');
  const resumedRun = join(workspace.root, 'worker-run-2.jsonl');
  const referenceRun = join(workspace.root, 'worker-reference.jsonl');

  // ---- run 1: Remove background, and the app dies in window 2 ---------------------------------
  await pack.setControl({ crashAtWindow: 2, eventsLog: crashedRun });
  let firstService: CapabilityPackMatteService | undefined;
  opened = await openInDesktop(
    page,
    testInfo,
    {
      workspace,
      sidecarUrl: sidecarUrl(),
      jobJournal: journal,
      matteService: async (host) => (firstService ??= pack.service(host.inspector)),
    },
    NAME,
  );
  const first = opened.desktop;
  await openMaskTab(page, 'clip_subject');
  const row = page.getByLabel('Background removal', { exact: true });
  await clickInInspector(row.getByRole('button', { name: 'Remove background', exact: true }));
  await pack.crashed;
  const intent = first.calls.find((call) => call.method === 'capabilityPackMatte')!.args[0] as {
    requestId: string;
  } & Record<string, unknown>;
  const staging = join(
    workspace.projectDir,
    '.framepilot-derived',
    'mattes',
    '.staging',
    intent.requestId,
  );
  // What the dead app left: window 1's checkpoint, and the job in the journal.
  expect(existsSync(join(staging, 'windows', '1', 'done.json'))).toBe(true);
  expect(windowsDecoded(await ScriptedSmartMaskPack.events(crashedRun))).toBe(2);
  const journaled = JSON.parse(await readFile(journal, 'utf8')) as {
    jobs: { id: string; kind: string; projectPath: string }[];
  };
  expect(journaled.jobs).toEqual([
    expect.objectContaining({
      id: intent.requestId,
      kind: 'matte',
      projectPath: workspace.projectPath,
    }),
  ]);
  await attachDiagnostics(testInfo, opened);
  await page.close();

  // ---- run 2: relaunch on the same journal; the job resumes when the project opens -----------
  await pack.setControl({ eventsLog: resumedRun });
  const relaunched = await newEditorPage(
    browser,
    testInfo.project.use.baseURL ?? 'http://127.0.0.1:5173',
  );
  let secondService: CapabilityPackMatteService | undefined;
  opened = await openInDesktop(
    relaunched,
    testInfo,
    {
      workspace,
      sidecarUrl: sidecarUrl(),
      jobJournal: journal,
      matteService: async (host) => (secondService ??= pack.service(host.inspector)),
      relinkTo: join(workspace.projectDir, 'media', 'subject-v2.mp4'),
    },
    NAME,
  );
  const second = opened.desktop;
  await relaunched.getByRole('tab', { name: 'Jobs', exact: true }).click();
  await expect(
    relaunched.locator('.jobs-panel').getByText('Resumed after restart').first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    relaunched.getByRole('listitem', { name: 'Remove background: Done', exact: true }),
  ).toBeVisible({ timeout: 180_000 });
  const resumedEvents = await ScriptedSmartMaskPack.events(resumedRun);
  expect(
    resumedEvents.some(
      (event) => event.phase === 'encode' && event.detail === 'resumed a finished window',
    ),
  ).toBe(true);
  // The resumed staging folder was adopted and committed; nothing is left behind.
  expect(existsSync(staging)).toBe(false);

  // Remove background again: the resumed job already committed this matte, so it is a cache hit.
  await openMaskTab(relaunched, 'clip_subject');
  const row2 = relaunched.getByLabel('Background removal', { exact: true });
  await clickInInspector(row2.getByRole('button', { name: 'Remove background', exact: true }));
  await expect(row2.getByText(/^Background removed\./)).toBeVisible({ timeout: 60_000 });
  const applied = await savedProject(
    second,
    (document) => mattesOf(document).length === 1,
    'the resumed background removal',
  );
  const resumed = mattesOf(applied)[0]!;
  if (resumed.kind !== 'matte') throw new Error('expected a matte');
  expect(
    second.results.find((entry) => entry.method === 'capabilityPackMatte')?.result,
  ).toMatchObject({ ok: true, cacheHit: true });

  // ---- the same request, uninterrupted, in a second project folder ------------------------------
  const reference = await Workspace.create('e2e6-reference');
  for (const name of ['subject.mp4', 'bg.mp4']) {
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(reference.projectDir, 'media'), { recursive: true }),
    );
    await copyFile(
      join(workspace.projectDir, 'media', name),
      join(reference.projectDir, 'media', name),
    );
  }
  await reference.writeProject(base);
  const referencePack = await ScriptedSmartMaskPack.install(reference);
  await referencePack.setControl({ eventsLog: referenceRun });
  const inspector = new DesktopMatteMediaInspector({
    ffprobe: process.env.FRAMEPILOT_FFPROBE ?? 'ffprobe',
    sidecarBaseUrl: sidecarUrl(),
    fetch: globalThis.fetch,
  });
  const referenceProject = await reference.readProject();
  const revision = referenceProject.timeline.revision ?? 0;
  const uninterrupted = await referencePack.service(inspector).run(
    { ...intent, requestId: 'reference', timelineRevision: revision },
    {
      projectDir: reference.projectDir,
      project: referenceProject,
      projectRevision: revision,
      readCurrent: async () => ({ revision, project: referenceProject }),
    },
  );
  expect(uninterrupted.status).toBe('completed');
  if (uninterrupted.status !== 'completed') return;
  expect(uninterrupted.artifact.key).toBe(resumed.artifact.key);
  expect(await compared(workspace.projectDir, resumed.artifact.key)).toEqual(
    await compared(reference.projectDir, uninterrupted.artifact.key),
  );
  expect(Object.keys(await compared(workspace.projectDir, resumed.artifact.key)).sort()).toEqual(
    [...COMPARED].sort(),
  );
  // The worker's own account: the resumed run restored window 1 instead of decoding it.
  expect(windowsDecoded(resumedEvents)).toBe(
    windowsDecoded(await ScriptedSmartMaskPack.events(referenceRun)) - 1,
  );
  // And the export renders the two identically.
  await writeProjectFile(reference.projectPath, applied);
  const TIMES = [0.25, 1, 1.75];
  expect(await reference.frameHashes(TIMES)).toEqual(await workspace.frameHashes(TIMES));

  // ---- relink the clip to different media: STALE, the export refuses, recompute ---------------
  // The card's actions appear on hover (the media bin's own rule), as for a pointer user.
  await relaunched.getByRole('listitem', { name: 'asset subject', exact: true }).hover();
  await relaunched.getByRole('button', { name: 'relink subject', exact: true }).click();
  await expect(relaunched.getByText(STALE_REMEDY).first()).toBeVisible({ timeout: 30_000 });
  // The native dialog answers an absolute path, and the relink stores it as chosen.
  const relinkTarget = join(workspace.projectDir, 'media', 'subject-v2.mp4');
  const relinked = await savedProject(
    second,
    (document) => document.assets.find((asset) => asset.id === 'subject')?.path === relinkTarget,
    'the relink',
  );
  expect(mattesOf(relinked)).toHaveLength(1);
  await openMaskTab(relaunched, 'clip_subject');
  await expect(row2.getByRole('alert').filter({ hasText: STALE_REMEDY })).toBeVisible();
  const refused = await workspace.export('stale.mp4');
  expect(refused.state).not.toBe('completed');
  expect(`${refused.error ?? ''} ${refused.errorDetail ?? ''}`).toContain(STALE_REMEDY);

  await clickInInspector(row2.getByRole('button', { name: 'Remove background', exact: true }));
  const recomputed = await savedProject(
    second,
    (document) => {
      const [matte] = mattesOf(document);
      return matte?.kind === 'matte' && matte.artifact.key !== resumed.artifact.key;
    },
    'the recomputed background removal',
    180_000,
  );
  // Replaced, not stacked: one matte, the same mask, a new artifact for the new media.
  expect(mattesOf(recomputed).map((mask) => mask.id)).toEqual([resumed.id]);
  await expect(row2.getByRole('alert').filter({ hasText: STALE_REMEDY })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expectPreviewMatchesExport(relaunched, workspace, [0.5, 1.5], 'e2e6-recomputed', testInfo);
  expectValidExport(await workspace.export('recomputed.mp4'), SECONDS);
});
