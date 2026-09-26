/**
 * Elements · Shapes end to end (plan/elements EL4a, EL7, EL11): add a highlight box from the Shapes
 * tab, resize it on the monitor, recolour it in the Inspector, export, check the monitor draws what
 * the export draws, and undo it all; animate a shape — Pop in and Pulse from the Animation section
 * the clip menu opens — through the export and the undo; and drop a highlight box on the monitor at
 * a point, which the export draws centred there.
 *
 * What is real: the editor (Elements → Shapes, the monitor handles, the Inspector's Shape
 * section, History), the engine's shape rasteriser behind the monitor (the sidecar's
 * `/preview/text-raster` with `kind: "shape"`), and the export (`render()` with validation), read
 * back through the same parity gates as the PX4 oracle.
 *
 * SIMULATED, and why: Electron and `fp-media://` (see `masking/fake-desktop.ts`); the Photos tab's
 * Pexels calls, which this spec never makes, are not served by the fake host. The drop onto the
 * monitor is a real pointer drag — Chromium drives HTML5 drag from the mouse — so the tile's own
 * `dragstart` and the monitor's own `dragenter`, `dragover` and `drop` run as they do for a person.
 * (A `DataTransfer` built in the page cannot stand in for that check: Chromium makes it a
 * copy-and-paste transfer, whose drop effect stays "none" whatever a handler sets.)
 *
 * CI ONLY (`elements-e2e` job): it renders.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  attachDiagnostics,
  clip,
  clipsById,
  expectValidExport,
  openInDesktop,
  project,
  savedProject,
  sidecarUrl,
  video,
  type OpenedEditor,
} from './masking/session.js';
import { expectPreviewMatchesExport, waitForMonitor } from './masking/parity.js';
import { Workspace } from './masking/workspace.js';
import { presetShapeParams, type Project } from '../../../packages/timeline-schema/dist/index.js';

const SECONDS = 3;
const NAME = 'Elements shapes';

const shapesOf = (document: Project) =>
  [...clipsById(document).values()].filter((entry) => entry.assetId === '__shape__');
const paramsOf = (document: Project, clipId: string) =>
  clipsById(document)
    .get(clipId)
    ?.effects.find((effect) => effect.type === 'shape')?.params;

let opened: OpenedEditor | undefined;
test.afterEach(async ({}, testInfo) => {
  if (opened !== undefined) await attachDiagnostics(testInfo, opened);
  opened = undefined;
});

test('Shapes: add a highlight box, resize it on the monitor, recolour it, export, undo', async ({
  page,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const workspace = await Workspace.create('elements-shapes');
  await workspace.media([video('bg', 'blue', SECONDS)]);
  await workspace.writeProject(
    project({
      id: 'elements_shapes',
      name: NAME,
      videos: [{ id: 'bg', seconds: SECONDS }],
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
        },
      ],
    }),
  );
  opened = await openInDesktop(page, testInfo, { workspace, sidecarUrl: sidecarUrl() }, NAME);
  const { desktop } = opened;

  // --- add: one click on the tile, one shape at the playhead, selected --------------------------
  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Shapes', exact: true })
    .click();
  await page.getByRole('button', { name: 'Highlight box, shape', exact: true }).click();
  const added = await savedProject(desktop, (doc) => shapesOf(doc).length === 1, 'one shape');
  const shape = shapesOf(added)[0]!;
  expect(shape.start).toBe(0);
  expect(paramsOf(added, shape.id)).toMatchObject({
    shape: 'rounded-rect',
    stroke: '#FFD400',
    width: 48,
    height: 27,
  });

  // --- resize on the monitor: one drag of a corner handle, one patch ----------------------------
  // The corner is pointer-only (hidden from assistive tech; the Inspector's Box fields are the
  // keyboard route), so it is found by its place on this shape's handle layer, not by a role.
  await expect(
    page.getByRole('button', { name: 'Move Rounded rectangle', exact: true }),
  ).toBeVisible();
  const corner = page.locator(
    `.preview-shape-editor[data-clip-id="${shape.id}"] .preview-shape-handle.is-se`,
  );
  await expect(corner).toBeVisible();
  const start = (await corner.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 40, start.y + start.height / 2 + 24, {
    steps: 10,
  });
  await page.mouse.up();
  const resized = await savedProject(
    desktop,
    (doc) => {
      const params = paramsOf(doc, shape.id);
      return params !== undefined && Number(params.width) > 48 && Number(params.height) > 27;
    },
    'the shape resized from its corner',
  );
  expect(shapesOf(resized)).toHaveLength(1);

  // --- recolour in the Inspector: one patch --------------------------------------------------------
  await page.getByRole('tab', { name: 'Inspector', exact: true }).click();
  await page.getByLabel('shape stroke color', { exact: true }).fill('#ff3b30');
  await savedProject(
    desktop,
    (doc) => paramsOf(doc, shape.id)?.stroke === '#ff3b30',
    'the shape recoloured red',
  );

  // --- export: valid, and the monitor draws the engine's own pixels -------------------------------
  expectValidExport(await workspace.export('shapes.mp4'), SECONDS);
  await expectPreviewMatchesExport(page, workspace, [0.5, 1.5], 'shapes', testInfo);

  // --- undo: recolour, resize, add — the shape is gone and the footage untouched ------------------
  const undo = page
    .getByRole('toolbar', { name: 'editor tools', exact: true })
    .getByRole('button', { name: 'Undo', exact: true });
  for (let step = 0; step < 3; step += 1) await undo.click();
  const undone = await savedProject(
    desktop,
    (doc) => shapesOf(doc).length === 0,
    'the project with the shape undone',
  );
  expect(clipsById(undone).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
});

test('Animation: pop a shape in and pulse it from the clip menu, export, undo (EL7)', async ({
  page,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const workspace = await Workspace.create('elements-animation');
  await workspace.media([video('bg', 'blue', SECONDS)]);
  const box = {
    ...clip('overlay_1', { id: 'clip_box', assetId: '__shape__', start: 0, end: SECONDS }),
    effects: [
      {
        id: 'clip_box__shape',
        type: 'shape',
        params: presetShapeParams('rounded-rect/highlight'),
        keyframes: [],
      },
    ],
  };
  await workspace.writeProject(
    project({
      id: 'elements_animation',
      name: NAME,
      videos: [{ id: 'bg', seconds: SECONDS }],
      tracks: [
        { id: 'overlay_1', type: 'overlay', clips: [box] },
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
        },
      ],
    }),
  );
  opened = await openInDesktop(page, testInfo, { workspace, sidecarUrl: sidecarUrl() }, NAME);
  const { desktop } = opened;

  // --- the clip menu opens the Inspector on the Animation section ---------------------------------
  await page.getByLabel('clip clip_box', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Animation…', exact: true }).click();
  const inAnimation = page.getByRole('combobox', { name: 'In animation', exact: true });
  await expect(inAnimation).toBeVisible();

  // --- Pop in, then Pulse: one edit each ----------------------------------------------------------
  await inAnimation.click();
  await page.getByRole('option', { name: 'Pop', exact: true }).click();
  await savedProject(
    desktop,
    (doc) =>
      clipsById(doc)
        .get('clip_box')
        ?.effects.some((e) => e.type === 'transition' && e.params.kind === 'zoom-out') === true,
    'the box popping in',
  );
  await page.getByRole('combobox', { name: 'Loop animation', exact: true }).click();
  await page.getByRole('option', { name: 'Pulse', exact: true }).click();
  await savedProject(
    desktop,
    (doc) =>
      clipsById(doc)
        .get('clip_box')
        ?.keyframes.some((k) => k.id.startsWith('loop__pulse__')) === true,
    'the box pulsing',
  );

  // --- export: valid, and the monitor draws the export's frames mid-pop and on the pulse ------------
  expectValidExport(await workspace.export('animation.mp4'), SECONDS);
  await expectPreviewMatchesExport(page, workspace, [0.2, 1.25], 'animation', testInfo);

  // --- undo: the pulse, then the pop ----------------------------------------------------------------
  const undo = page
    .getByRole('toolbar', { name: 'editor tools', exact: true })
    .getByRole('button', { name: 'Undo', exact: true });
  for (let step = 0; step < 2; step += 1) await undo.click();
  const undone = await savedProject(
    desktop,
    (doc) => {
      const shape = clipsById(doc).get('clip_box');
      return (
        shape !== undefined &&
        !shape.effects.some((e) => e.type === 'transition') &&
        !shape.keyframes.some((k) => k.id.startsWith('loop__'))
      );
    },
    'the animation undone',
  );
  expect(clipsById(undone).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
});

/**
 * The centre of the highlight box's yellow in an engine frame, in that frame's pixels: the middle
 * of the box the yellow stroke spans (the straight sides reach its extremes; the rounded corners
 * do not change them).
 */
async function yellowBoxCentre(
  page: Page,
  url: string,
): Promise<{ x: number; y: number; width: number; height: number; pixels: number }> {
  return page.evaluate(async (frameUrl) => {
    const bitmap = await createImageBitmap(await (await fetch(frameUrl)).blob(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let [left, top, right, bottom, pixels] = [bitmap.width, bitmap.height, -1, -1, 0];
    for (let y = 0; y < bitmap.height; y += 1) {
      for (let x = 0; x < bitmap.width; x += 1) {
        const at = (y * bitmap.width + x) * 4;
        // #FFD400 through an encode: strong red and green, little blue. No sentinel is near it.
        if (data[at]! > 200 && data[at + 1]! > 160 && data[at + 2]! < 100) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
          pixels += 1;
        }
      }
    }
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { x: (left + right) / 2, y: (top + bottom) / 2, ...size, pixels };
  }, url);
}

test('Monitor drop: a highlight box let go over the picture lands centred there, exports there, undoes (EL11)', async ({
  page,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const workspace = await Workspace.create('elements-shapes-monitor-drop');
  await workspace.media([video('bg', 'blue', SECONDS)]);
  await workspace.writeProject(
    project({
      id: 'elements_shapes_monitor_drop',
      name: NAME,
      videos: [{ id: 'bg', seconds: SECONDS }],
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
        },
      ],
    }),
  );
  opened = await openInDesktop(page, testInfo, { workspace, sidecarUrl: sidecarUrl() }, NAME);
  const { desktop } = opened;
  await waitForMonitor(page);

  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Shapes', exact: true })
    .click();

  // --- drag the tile onto the monitor with the pointer, letting go about 30% across and 40% down
  // the picture (on a whole client pixel, which is where a drag event reports the pointer) ------
  const frame = page.locator('.preview-stage .preview-frame');
  const frameBox = (await frame.boundingBox())!;
  const target = {
    x: Math.round(frameBox.x + frameBox.width * 0.3),
    y: Math.round(frameBox.y + frameBox.height * 0.4),
  };
  /** Where on the picture the pointer lets go, as fractions of the frame. */
  const DROP = {
    x: (target.x - frameBox.x) / frameBox.width,
    y: (target.y - frameBox.y) / frameBox.height,
  };
  await page.getByRole('button', { name: 'Highlight box, shape', exact: true }).hover();
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  // The monitor takes it: the picture's edge lights while the tile is over it.
  await expect(frame).toHaveClass(/is-element-drop/);
  await page.mouse.up();
  await expect(frame).not.toHaveClass(/is-element-drop/);

  // --- one shape at the playhead, its box centred where it was dropped, selected, announced -------
  const dropped = await savedProject(desktop, (doc) => shapesOf(doc).length === 1, 'one shape');
  const shape = shapesOf(dropped)[0]!;
  expect(shape.start).toBe(0);
  const params = paramsOf(dropped, shape.id)!;
  expect(params).toMatchObject({ shape: 'rounded-rect', stroke: '#FFD400' });
  expect(Math.abs(Number(params.x) - DROP.x * 100)).toBeLessThanOrEqual(0.2);
  expect(Math.abs(Number(params.y) - DROP.y * 100)).toBeLessThanOrEqual(0.2);
  await expect(page.getByText('Added the highlight box at 0:00', { exact: true })).toBeAttached();
  await expect(page.getByRole('button', { name: `clip ${shape.id}`, exact: true })).toHaveAttribute(
    'data-selected',
    'true',
  );
  expect(clipsById(dropped).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });

  // --- export: valid, the box's centre on the drop point, and the monitor draws the same pixels ---
  expectValidExport(await workspace.export('shapes-monitor-drop.mp4'), SECONDS);
  const [still] = await workspace.frames([1], 'shapes-monitor-drop-centre');
  const origin = new URL(page.url()).origin;
  const centre = await yellowBoxCentre(page, `${origin}${workspace.urlPath(still!.path)}`);
  expect(centre.pixels, 'the exported frame draws the highlight box').toBeGreaterThan(100);
  // Within a few pixels of where the pointer let go, in the export's own pixels.
  expect(Math.abs(centre.x - DROP.x * (centre.width - 1))).toBeLessThanOrEqual(3);
  expect(Math.abs(centre.y - DROP.y * (centre.height - 1))).toBeLessThanOrEqual(3);
  await expectPreviewMatchesExport(page, workspace, [0.5, 1.5], 'shapes-monitor-drop', testInfo);

  // --- one undo takes the drop back, and the footage is as it was ---------------------------------
  await page
    .getByRole('toolbar', { name: 'editor tools', exact: true })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  const undone = await savedProject(
    desktop,
    (doc) => shapesOf(doc).length === 0,
    'the project with the dropped shape undone',
  );
  expect(clipsById(undone).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
});
