/**
 * E2E.8 — split, mirror band, gradient, track matte, text as a mask, an adjustment-lane mask and an
 * edge style, each made through the editor's own controls, each proved preview == export
 * (plan/background-removal-ai/07, E2E.8).
 *
 * Every flow: open a saved desktop project → select → make the mask with the monitor tools or the
 * Inspector → assert the operation the editor committed (the saved `project.fp.json`, exact on
 * the fields the gesture decides) → compare the live program monitor with the export's own
 * compositor at two times (the PX4 oracle's comparison and gates, `masking/parity.ts`) → export
 * the saved file with the engine and validate it (duration, video stream, the engine's checks).
 *
 * Simulated (see `masking/fake-desktop.ts`): Electron and `fp-media://` only. No pack is involved
 * in these flows. Media are 2 s, 640x360 sentinel videos generated per test.
 *
 * CI ONLY (`masking-e2e` job): needs the engine (uv), ffmpeg, real Chrome and the sidecar.
 */
import { expect, test } from '@playwright/test';
import {
  EDGE_STYLE_EFFECT_TYPE,
  masksOf,
  type Project,
} from '../../../packages/timeline-schema/dist/index.js';
import { expectPreviewMatchesExport } from './masking/parity.js';
import {
  attachDiagnostics,
  clickInInspector,
  clip,
  clipsById,
  dragOnCanvas,
  expectValidExport,
  openInDesktop,
  openMaskTab,
  project,
  savedProject,
  sidecarUrl,
  title,
  video,
  type OpenedEditor,
} from './masking/session.js';
import { Workspace } from './masking/workspace.js';

const SECONDS = 2;
const SAMPLES = [0.5, 1.5];

/** Two stacked pictures: `clip_top` (green) over `clip_base` (blue), plus any extra tracks. */
async function twoLayerWorkspace(
  name: string,
  extraTracks: Record<string, unknown>[] = [],
  extraVideos: { id: string; colour: 'magenta' | 'yellow' }[] = [],
): Promise<Workspace> {
  const workspace = await Workspace.create(`e2e8-${name}`);
  await workspace.media([
    video('top', 'green', SECONDS),
    video('base', 'blue', SECONDS),
    ...extraVideos.map((entry) => video(entry.id, entry.colour, SECONDS)),
  ]);
  await workspace.writeProject(
    project({
      id: `e2e8_${name.replace(/-/g, '_')}`,
      name: `E2E.8 ${name}`,
      videos: [
        { id: 'top', seconds: SECONDS },
        { id: 'base', seconds: SECONDS },
        ...extraVideos.map((entry) => ({ id: entry.id, seconds: SECONDS })),
      ],
      tracks: [
        ...extraTracks,
        {
          id: 'video_2',
          type: 'video',
          clips: [clip('video_2', { id: 'clip_top', assetId: 'top', start: 0, end: SECONDS })],
        },
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_base', assetId: 'base', start: 0, end: SECONDS })],
        },
      ],
    }),
  );
  return workspace;
}

const topMasks = (document: Project) => masksOf(clipsById(document).get('clip_top')!);

let opened: OpenedEditor | null = null;
test.afterEach(async ({}, testInfo) => {
  await attachDiagnostics(testInfo, opened);
  opened = null;
});

test.describe('E2E.8 compositing masks: each flow previews exactly as it exports', () => {
  test.describe.configure({ timeout: 4 * 60_000 });

  const ANALYTIC = [
    { name: 'split', tool: 'Split tool', kind: 'linear', announced: 'Split mask added' },
    { name: 'mirror', tool: 'Mirror band tool', kind: 'band', announced: 'Mirror band mask added' },
    {
      name: 'gradient',
      tool: 'Gradient tool (Alt-drag for radial)',
      kind: 'gradient',
      announced: 'Gradient mask added',
    },
  ] as const;

  for (const flow of ANALYTIC) {
    test(`${flow.name}: drawn on the monitor`, async ({ page }, testInfo) => {
      const workspace = await twoLayerWorkspace(flow.name);
      opened = await openInDesktop(
        page,
        testInfo,
        { workspace, sidecarUrl: sidecarUrl() },
        `E2E.8 ${flow.name}`,
      );
      const canvas = await openMaskTab(page, 'clip_top');

      await page.getByRole('button', { name: flow.tool, exact: true }).click();
      await dragOnCanvas(page, canvas, [0.3, 0.5], [0.7, 0.55]);
      await expect(page.getByRole('status').filter({ hasText: flow.announced })).toHaveCount(1);

      const saved = await savedProject(
        opened.desktop,
        (document) => topMasks(document).some((mask) => mask.kind === flow.kind),
        `a ${flow.kind} mask on clip_top`,
      );
      const masks = topMasks(saved);
      expect(masks).toHaveLength(1);
      expect(masks[0]).toMatchObject({ kind: flow.kind, enabled: true, target: { kind: 'alpha' } });

      await expectPreviewMatchesExport(page, workspace, SAMPLES, `e2e8-${flow.name}`, testInfo);
      expectValidExport(await workspace.export(`${flow.name}.mp4`), SECONDS);
    });
  }

  test('track matte: another clip, by luma', async ({ page }, testInfo) => {
    const workspace = await twoLayerWorkspace(
      'track-matte',
      [
        {
          id: 'video_3',
          type: 'video',
          clips: [clip('video_3', { id: 'clip_matte', assetId: 'matte', start: 0, end: SECONDS })],
        },
      ],
      [{ id: 'matte', colour: 'magenta' }],
    );
    opened = await openInDesktop(
      page,
      testInfo,
      { workspace, sidecarUrl: sidecarUrl() },
      'E2E.8 track-matte',
    );
    await openMaskTab(page, 'clip_top');

    const row = page.getByRole('group', { name: 'Track matte', exact: true });
    await expect(row.getByRole('combobox', { name: 'Track matte source', exact: true })).toHaveText(
      /Clip clip_matte \(track video_3\)/,
    );
    await row.getByRole('combobox', { name: 'Track matte channel', exact: true }).click();
    await page.getByRole('option', { name: 'Luma', exact: true }).click();
    await clickInInspector(row.getByRole('button', { name: 'Use as mask', exact: true }));

    const saved = await savedProject(
      opened.desktop,
      (document) => topMasks(document).some((mask) => mask.kind === 'layer'),
      'a track matte on clip_top',
    );
    expect(topMasks(saved)[0]).toMatchObject({
      kind: 'layer',
      source: { kind: 'clip', clipId: 'clip_matte' },
      channel: 'luma',
    });

    await expectPreviewMatchesExport(page, workspace, SAMPLES, 'e2e8-track-matte', testInfo);
    expectValidExport(await workspace.export('track-matte.mp4'), SECONDS);
  });

  test('text as a mask: a title as the clip’s alpha', async ({ page }, testInfo) => {
    // The title sits on a picture track above the clip, the configuration the Track matte row
    // offers (`trackMatteOptions` lists picture tracks only).
    const workspace = await twoLayerWorkspace('text-mask', [
      { id: 'video_3', type: 'video', clips: [title('video_3', 'clip_title', 'MASK', 0, SECONDS)] },
    ]);
    opened = await openInDesktop(
      page,
      testInfo,
      { workspace, sidecarUrl: sidecarUrl() },
      'E2E.8 text-mask',
    );
    await openMaskTab(page, 'clip_top');

    const row = page.getByRole('group', { name: 'Track matte', exact: true });
    const source = row.getByRole('combobox', { name: 'Track matte source', exact: true });
    await expect(source).toHaveText(/Text “MASK” \(track video_3\)/);
    await clickInInspector(row.getByRole('button', { name: 'Use as mask', exact: true }));

    const saved = await savedProject(
      opened.desktop,
      (document) => topMasks(document).some((mask) => mask.kind === 'layer'),
      'a text mask on clip_top',
    );
    expect(topMasks(saved)[0]).toMatchObject({
      kind: 'layer',
      source: { kind: 'clip', clipId: 'clip_title' },
      channel: 'alpha',
    });

    await expectPreviewMatchesExport(page, workspace, SAMPLES, 'e2e8-text-mask', testInfo);
    expectValidExport(await workspace.export('text-mask.mp4'), SECONDS);
  });

  test('adjustment lane: a frame-space mask limits the effect', async ({ page }, testInfo) => {
    const workspace = await twoLayerWorkspace('lane-mask', [
      {
        id: 'fx',
        type: 'effect',
        clips: [],
        effectLayers: [
          {
            id: 'fx0',
            effectId: 'motion-streak',
            kind: 'blur-directional',
            start: 0,
            end: SECONDS,
            params: { radius: 22, angle: 0 },
            intensity: 0.75,
            keyframes: [],
          },
        ],
      },
    ]);
    opened = await openInDesktop(
      page,
      testInfo,
      { workspace, sidecarUrl: sidecarUrl() },
      'E2E.8 lane-mask',
    );

    await page.locator('.fx-layer[data-effect-id="motion-streak"]').click();
    await page.getByRole('tab', { name: 'Inspector', exact: true }).click();
    await page
      .getByRole('tablist', { name: 'effect inspector categories', exact: true })
      .getByRole('tab', { name: 'Mask', exact: true })
      .click();
    const lanePanel = page.getByLabel('effect layer mask stack', { exact: true });
    await clickInInspector(
      lanePanel.getByRole('button', { name: 'Draw rectangle mask', exact: true }),
    );
    const canvas = page.getByRole('application', { name: 'Mask canvas', exact: true });
    await dragOnCanvas(page, canvas, [0.2, 0.25], [0.6, 0.75]);

    const saved = await savedProject(
      opened.desktop,
      (document) =>
        document.timeline.tracks.some((track) =>
          (track.effectLayers ?? []).some((layer) => (layer.masks ?? []).length > 0),
        ),
      'a mask on the adjustment lane',
    );
    const layer = saved.timeline.tracks.find((track) => track.id === 'fx')!.effectLayers![0]!;
    expect(layer.masks).toHaveLength(1);
    expect(layer.masks![0]).toMatchObject({ kind: 'rectangle', space: 'frame' });

    await expectPreviewMatchesExport(page, workspace, SAMPLES, 'e2e8-lane-mask', testInfo);
    expectValidExport(await workspace.export('lane-mask.mp4'), SECONDS);
  });

  test('edge style: an outline around a drawn cut-out', async ({ page }, testInfo) => {
    const workspace = await twoLayerWorkspace('edge-style');
    opened = await openInDesktop(
      page,
      testInfo,
      { workspace, sidecarUrl: sidecarUrl() },
      'E2E.8 edge-style',
    );
    const canvas = await openMaskTab(page, 'clip_top');

    await page.getByRole('button', { name: 'Ellipse tool', exact: true }).click();
    await dragOnCanvas(page, canvas, [0.3, 0.25], [0.7, 0.75]);
    await savedProject(
      opened.desktop,
      (document) => topMasks(document).some((mask) => mask.kind === 'ellipse'),
      'an ellipse on clip_top',
    );

    const edge = page.getByRole('group', { name: 'Edge style', exact: true });
    await clickInInspector(
      edge.getByRole('switch', { name: 'Outline around the cut-out', exact: true }),
    );

    const saved = await savedProject(
      opened.desktop,
      (document) =>
        clipsById(document)
          .get('clip_top')!
          .effects.some((effect) => effect.type === EDGE_STYLE_EFFECT_TYPE),
      'an outline edge style on clip_top',
    );
    const style = clipsById(saved)
      .get('clip_top')!
      .effects.filter((effect) => effect.type === EDGE_STYLE_EFFECT_TYPE);
    expect(style).toHaveLength(1);
    expect(style[0]!.params).toMatchObject({ kind: 'stroke' });

    await expectPreviewMatchesExport(page, workspace, SAMPLES, 'e2e8-edge-style', testInfo);
    expectValidExport(await workspace.export('edge-style.mp4'), SECONDS);
  });
});
