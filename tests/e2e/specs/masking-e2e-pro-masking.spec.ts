/**
 * E2E.3 — manual professional masking (plan/background-removal-ai/07, E2E.3).
 *
 *   pen path (keyboard) → animate (a second path keyframe) → track (perspective) → review the
 *   flagged range and lock a constraint → re-track from constraints → Add blur and limit it to
 *   the tracked mask → preview == export → export.
 *
 * What each step proves: UI state from the real editor in desktop mode; the resulting
 * operations from the SAVED `project.fp.json` (exact on keyframe times, the track's method,
 * reference frame, review ranges and constraints, and the blur's target); preview == export
 * with the PX4 oracle's comparison and gates at three moments (before, inside and after the
 * flagged range) of an animated, perspective-tracked, blur-limiting path; and that the blur
 * actually changes the exported picture (frame hashes with and without it differ).
 *
 * The blur is the clip `blur` effect (`render/clip_blur.py`), added for this item: before it,
 * a clip's only picture effects were a grade and a LUT, and a blur lived on an adjustment lane
 * whose mask cannot follow a track.
 *
 * SIMULATED: the tracker. No Tracking Lite release exists (MO-1..MO-5), so the host's track
 * job writes a `track.json` (MK7.1 format: per-frame 3x3 transforms on the source's real pts,
 * identity at the reference frame, a slow drift with a perspective term, low confidence over
 * 1.0-1.2 s) and returns that range as flagged. Everything downstream of the artifact — the
 * mask tracking command, the review list, constraints, the monitor's track reader and the
 * export's `render/tracks.py` — is real. Electron and `fp-media://` (`masking/fake-desktop.ts`).
 *
 * CI ONLY (`masking-e2e` job).
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { masksOf, type Project } from '../../../packages/timeline-schema/dist/index.js';
import { writeProjectFile } from '../../../packages/timeline-schema/dist/project-file.js';
import type { FakeDesktop } from './masking/fake-desktop.js';
import { expectPreviewMatchesExport } from './masking/parity.js';
import {
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
import { Workspace } from './masking/workspace.js';

const SECONDS = 3;
const FLAGGED = { start: 1, end: 1.2 } as const;

const pathMask = (document: Project) => {
  const mask = masksOf(clipsById(document).get('clip_top')!)[0];
  return mask?.kind === 'path' ? mask : undefined;
};

let opened: OpenedEditor | null = null;
test.afterEach(async ({}, testInfo) => {
  await attachDiagnostics(testInfo, opened);
  opened = null;
});

test('E2E.3 pen path, animate, perspective track, review and constrain, effect target, export', async ({
  page,
}, testInfo) => {
  test.setTimeout(6 * 60_000);
  const workspace = await Workspace.create('e2e3-pro-masking');
  await workspace.media([video('top', 'green', SECONDS), video('base', 'blue', SECONDS)]);
  await workspace.writeProject(
    project({
      id: 'e2e3_pro_masking',
      name: 'E2E.3 Pro masking',
      videos: [
        { id: 'top', seconds: SECONDS },
        { id: 'base', seconds: SECONDS },
      ],
      tracks: [
        {
          id: 'video_2',
          type: 'video',
          clips: [
            clip('video_2', {
              id: 'clip_top',
              assetId: 'top',
              start: 0,
              end: SECONDS,
            }),
          ],
        },
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_base', assetId: 'base', start: 0, end: SECONDS })],
        },
      ],
    }),
  );

  // The tracker: per-frame transforms on the source's own pts, identity at the reference frame.
  const trackIntents: Record<string, unknown>[] = [];
  const trackJob = async (intent: Record<string, unknown>, desktop: FakeDesktop) => {
    trackIntents.push(intent);
    const timing = await desktop.inspector.videoTiming(join(workspace.projectDir, 'media/top.mp4'));
    const [num, den] = timing.timeBase;
    const seconds = timing.pts.map((pts) => ((pts - timing.pts[0]!) * num) / den);
    const reference = Number(intent.referenceSourceTime);
    let ref = 0;
    for (let index = 0; index < seconds.length; index += 1) {
      if (seconds[index]! <= reference + 1e-9) ref = index;
    }
    const transforms: number[] = [];
    const confidence: number[] = [];
    for (let index = 0; index < seconds.length; index += 1) {
      const step = index - ref;
      transforms.push(1, 0, 3 * step, 0, 1, 0.5 * step, 2e-6 * step, 0, 1);
      const flagged = seconds[index]! >= FLAGGED.start && seconds[index]! < FLAGGED.end;
      confidence.push(flagged && trackIntents.length === 1 ? 0.3 : 0.95);
    }
    const artifact = await desktop.writeTrack({
      version: 1,
      method: intent.method,
      timeBase: [num, den],
      originPts: timing.pts[0],
      firstFrame: 0,
      pts: timing.pts,
      transforms,
      confidence,
    });
    return {
      ok: true,
      artifact,
      method: intent.method,
      frames: seconds.length,
      flagged: trackIntents.length === 1 ? [FLAGGED] : [],
      worstResidualPx: 0.4,
      engine: 'framepilot.tracking-lite@1.0.0',
      projectRevision: 1,
    };
  };

  opened = await openInDesktop(
    page,
    testInfo,
    { workspace, sidecarUrl: sidecarUrl(), trackJob },
    'E2E.3 Pro masking',
  );
  const { desktop } = opened;
  const canvas = await openMaskTab(page, 'clip_top');

  // --- pen path, from the keyboard (the a11y path MK4.5 requires) --------------------------------
  // Start up and left of the centre so the shape straddles the sentinel's quadrant edges, where
  // a blur is visible (a flat colour blurs to itself).
  await canvas.focus();
  await page.keyboard.press('p');
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('Shift+ArrowUp');
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Space');
  for (let step = 0; step < 8; step += 1) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Space');
  for (let step = 0; step < 6; step += 1) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Space');
  for (let step = 0; step < 8; step += 1) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Path mask added' })).toHaveCount(1);
  const drawn = pathMask(
    await savedProject(desktop, (document) => pathMask(document) !== undefined, 'the pen path'),
  )!;
  expect(drawn.pathKeyframes).toHaveLength(1);
  expect(drawn.pathKeyframes[0]!.vertexTypes).toHaveLength(4);

  // --- animate: the drawn shape is the 0 s key; key 2 s and nudge the shape there ----------------
  const animatePath = page.getByRole('button', {
    name: 'Animate Mask 1 path — adds a keyframe at the playhead',
    exact: true,
  });
  // At the only shape's own instant the button refuses with the remedy rather than doing nothing.
  await clickInInspector(animatePath);
  await expect(
    page
      .locator('.mask-canvas-message')
      .getByText(/This is the path’s only shape\. Move the playhead/),
  ).toBeVisible();
  await page.getByLabel('playhead', { exact: true }).fill('2');
  await clickInInspector(animatePath);
  await canvas.focus();
  // V: the Selection tool, where arrows nudge the selected mask (Shift: 10 px).
  await page.keyboard.press('v');
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('Shift+ArrowRight');
  const animated = pathMask(
    await savedProject(
      desktop,
      (document) => (pathMask(document)?.pathKeyframes.length ?? 0) === 2,
      'a second path keyframe',
    ),
  )!;
  expect(animated.pathKeyframes.map((keyframe) => keyframe.sourceTime)).toEqual([0, 2]);
  const [k0, k1] = animated.pathKeyframes;
  // The nudge moved every vertex 30 px right at 2 s and left 0 s where it was.
  expect(k1!.points[0]! - k0!.points[0]!).toBeCloseTo(30, 6);

  // --- track (perspective) -------------------------------------------------------------------------
  const tracking = page.getByLabel('mask tracking', { exact: true });
  await tracking.getByRole('combobox', { name: 'tracking method', exact: true }).click();
  await page.getByRole('option', { name: 'Perspective', exact: true }).click();
  await clickInInspector(tracking.getByRole('button', { name: 'Track this mask', exact: true }));
  await expect(tracking.getByText('Tracked. 1 range(s) need review.', { exact: true })).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  expect(trackIntents[0]).toMatchObject({
    clipId: 'clip_top',
    maskId: animated.id,
    method: 'perspective',
    direction: 'forward',
    referenceSourceTime: 2,
  });
  const tracked = pathMask(
    await savedProject(
      desktop,
      (document) => pathMask(document)?.tracking !== undefined,
      'the track',
    ),
  )!;
  expect(tracked.tracking).toMatchObject({
    method: 'perspective',
    referenceSourceTime: 2,
    constraints: [],
    review: { flagged: [{ start: FLAGGED.start, end: FLAGGED.end }], approved: [], locked: [] },
  });

  // --- review: go to the flagged range, lock a constraint there, re-track from constraints ------
  const review = tracking.getByLabel('Review', { exact: true });
  await review.getByRole('button', { name: /^1\.00s – 1\.20s/ }).click();
  await clickInInspector(review.getByRole('button', { name: 'Lock this frame', exact: true }));
  await expect(
    review.getByText('This frame is locked. Re-measure to fix the range.'),
  ).toBeVisible();
  const constrained = pathMask(
    await savedProject(
      desktop,
      (document) => (pathMask(document)?.tracking?.constraints ?? []).length === 1,
      'the constraint',
    ),
  )!;
  expect(constrained.tracking!.constraints![0]!.sourceTime).toBeCloseTo(FLAGGED.start, 6);

  await clickInInspector(
    tracking.getByRole('button', { name: 'Re-track from constraints', exact: true }),
  );
  await expect(tracking.getByText('Tracked. Nothing needs review.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(trackIntents[1]).toMatchObject({ fromConstraints: true, method: 'perspective' });
  const retracked = pathMask(
    await savedProject(
      desktop,
      (document) => {
        const mask = pathMask(document);
        return mask?.tracking !== undefined && mask.tracking.review?.flagged.length === 0;
      },
      'the re-track',
    ),
  )!;
  // A re-track measured FROM the constraint keeps it: the next re-track needs it again.
  expect(retracked.tracking!.constraints!.map((entry) => entry.sourceTime)).toEqual([
    FLAGGED.start,
  ]);
  expect(retracked.tracking!.artifact.key).not.toBe(tracked.tracking!.artifact.key);

  // --- effect target: a blur only inside the tracked shape ----------------------------------------
  // The Inspector's Effects tab (the activity bar has an Effects tab of its own).
  const inspector = page.getByRole('region', { name: 'inspector', exact: true });
  await inspector.getByRole('tab', { name: 'Effects', exact: true }).click();
  // Its "Applied effects" section starts collapsed, like the Mask section.
  const effects = inspector.getByRole('group', { name: 'effects', exact: true });
  if (!(await effects.evaluate((node: HTMLDetailsElement) => node.open))) {
    await effects.locator('summary').click();
  }
  await clickInInspector(page.getByRole('button', { name: 'Add blur', exact: true }));
  const withBlur = await savedProject(
    desktop,
    (document) =>
      clipsById(document)
        .get('clip_top')!
        .effects.some((effect) => effect.type === 'blur'),
    'the blur',
  );
  expect(clipsById(withBlur).get('clip_top')!.effects).toEqual([
    { id: 'clip_top__blur', type: 'blur', params: { amount: 0.04 }, keyframes: [] },
  ]);
  await inspector.getByRole('tab', { name: 'Mask', exact: true }).click();
  await clickInInspector(page.getByRole('combobox', { name: 'Mask 1 target', exact: true }));
  await page.getByRole('option', { name: 'Effect: blur', exact: true }).click();
  const targeted = pathMask(
    await savedProject(
      desktop,
      (document) => pathMask(document)?.target.kind === 'effect',
      'the effect target',
    ),
  )!;
  expect(targeted.target).toEqual({ kind: 'effect', effectId: 'clip_top__blur' });
  // Retargeting keeps the track, its constraint and the animation.
  expect(targeted.tracking).toEqual(retracked.tracking);
  expect(targeted.pathKeyframes).toEqual(retracked.pathKeyframes);

  // --- the monitor matches the export: animated + tracked + blur-limiting ------------------------
  const TIMES = [0.5, 1.1, 2.5];
  await expectPreviewMatchesExport(page, workspace, TIMES, 'e2e3-pro-masking', testInfo);

  // The blur changes the exported picture: the same project with a zero-strength blur differs.
  const saved = await workspace.readProject();
  const unblurredPath = join(workspace.projectDir, 'unblurred.fp.json');
  await writeProjectFile(unblurredPath, {
    ...saved,
    timeline: {
      ...saved.timeline,
      tracks: saved.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((entry) => ({
          ...entry,
          effects: entry.effects.map((effect) =>
            effect.type === 'blur' ? { ...effect, params: { amount: 0 } } : effect,
          ),
        })),
      })),
    },
  });
  const blurred = await workspace.frameHashes(TIMES);
  const plain = await workspace.frameHashes(TIMES, unblurredPath);
  for (const [index, frame] of blurred.entries()) {
    expect(frame.sha256, `t=${frame.time}: the blur is visible`).not.toBe(plain[index]!.sha256);
  }

  expectValidExport(await workspace.export('pro-masking.mp4'), SECONDS);
});
