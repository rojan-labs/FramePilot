/**
 * Opening a masking end-to-end project in the desktop-mode editor, and the waits every spec
 * shares. See `fake-desktop.ts` for what is real and what is simulated.
 */
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { parseProject, type Project } from '../../../../packages/timeline-schema/dist/index.js';
import { FakeDesktop, type FakeDesktopOptions } from './fake-desktop.js';
import type { EngineExport, Rgb3, VideoRequest } from './workspace.js';

/** The engine sidecar CI starts for these specs (text rasters, decoded frame hashes). */
export function sidecarUrl(): string {
  const url = process.env.MASKING_E2E_SIDECAR_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'MASKING_E2E_SIDECAR_URL is not set. These specs need the engine sidecar ' +
        '(`cd engine/python && uv run framepilot serve --port 8799`); see the CI job masking-e2e.',
    );
  }
  return url;
}

/** Sentinel colours on the PX4 grid: any two differ by >= 96/255 on some channel. */
export const COLOURS = {
  red: [
    [236, 44, 44],
    [140, 44, 44],
  ],
  green: [
    [44, 236, 44],
    [44, 140, 44],
  ],
  blue: [
    [44, 44, 236],
    [44, 44, 140],
  ],
  yellow: [
    [236, 236, 44],
    [140, 140, 44],
  ],
  magenta: [
    [236, 44, 236],
    [140, 44, 140],
  ],
  cyan: [
    [44, 236, 236],
    [44, 140, 140],
  ],
} as const satisfies Record<string, readonly [Rgb3, Rgb3]>;

export const WIDTH = 640;
export const HEIGHT = 360;
export const FPS = 30;

/** One sentinel video in `media/`, sized like the project. */
export function video(name: string, colour: keyof typeof COLOURS, seconds: number): VideoRequest {
  return {
    path: `media/${name}.mp4`,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    seconds,
    primary: COLOURS[colour][0],
    secondary: COLOURS[colour][1],
  };
}

export interface ClipSpec {
  readonly id: string;
  readonly assetId: string;
  readonly start: number;
  readonly end: number;
  readonly sourceStart?: number;
  readonly extra?: Record<string, unknown>;
}

/** A clip on a track, with the fields a saved desktop clip carries. */
export function clip(trackId: string, spec: ClipSpec): Record<string, unknown> {
  const sourceStart = spec.sourceStart ?? 0;
  return {
    id: spec.id,
    assetId: spec.assetId,
    trackId,
    start: spec.start,
    end: spec.end,
    sourceStart,
    sourceEnd: sourceStart + (spec.end - spec.start),
    effects: [],
    keyframes: [],
    ...spec.extra,
  };
}

/** A title clip (the text overlay the Text panel makes). */
export function title(trackId: string, id: string, text: string, start: number, end: number) {
  return {
    id,
    assetId: '__text__',
    trackId,
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [{ id: `${id}_text`, type: 'text', params: { text }, keyframes: [] }],
    keyframes: [],
  };
}

/** A validated project (the same parser the app opens files with). */
export function project(input: {
  readonly id: string;
  readonly name: string;
  readonly videos: readonly { readonly id: string; readonly seconds: number }[];
  readonly tracks: readonly Record<string, unknown>[];
}): Project {
  return parseProject({
    id: input.id,
    name: input.name,
    version: 1,
    fps: FPS,
    resolution: { width: WIDTH, height: HEIGHT },
    assets: input.videos.map((entry) => ({
      id: entry.id,
      path: `media/${entry.id}.mp4`,
      kind: 'video',
      durationSeconds: entry.seconds,
      media: { width: WIDTH, height: HEIGHT },
    })),
    timeline: { revision: 1, tracks: input.tracks },
    transcript: [],
    markers: [],
    aiMemory: {},
    history: [],
  });
}

export interface OpenedEditor {
  readonly desktop: FakeDesktop;
  /** Page errors seen so far (attached to the report; never silently ignored). */
  readonly pageErrors: string[];
}

/**
 * Install the desktop host on `page`, open the workspace project from the Home screen as an
 * editor does (Open Project), and wait for the timeline.
 */
export async function openInDesktop(
  page: Page,
  testInfo: TestInfo,
  options: FakeDesktopOptions,
  projectName: string,
): Promise<OpenedEditor> {
  const desktop = new FakeDesktop(options);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await desktop.install(page, testInfo.project.use.baseURL ?? 'http://127.0.0.1:5173');
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Project', exact: true }).click();
  await expect(page.getByLabel('project name')).toHaveText(projectName, { timeout: 30_000 });
  return { desktop, pageErrors };
}

/** Attach what crossed the bridge, what the app looked for and did not find, and page errors. */
export async function attachDiagnostics(
  testInfo: TestInfo,
  opened: OpenedEditor | null,
): Promise<void> {
  if (opened === null) return;
  await testInfo.attach('bridge-calls.json', {
    body: JSON.stringify(
      opened.desktop.calls.map((call) => ({
        method: call.method,
        // Project documents and bytes are large; the method sequence is what diagnoses a flow.
        args: JSON.stringify(call.args).slice(0, 400),
      })),
      null,
      2,
    ),
    contentType: 'application/json',
  });
  await testInfo.attach('bridge-missing-members.json', {
    body: JSON.stringify(await opened.desktop.missingMembers().catch(() => []), null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('page-errors.json', {
    body: JSON.stringify(opened.pageErrors, null, 2),
    contentType: 'application/json',
  });
}

/** The timeline clip block for a clip id. */
export function timelineClip(page: Page, id: string): Locator {
  return page.getByRole('button', { name: `clip ${id}`, exact: true });
}

/** Select a clip and open its Inspector Mask tab, expanded; returns the monitor mask canvas. */
export async function openMaskTab(page: Page, clipId: string): Promise<Locator> {
  await timelineClip(page, clipId).click();
  await expect(timelineClip(page, clipId)).toHaveAttribute('data-selected', 'true');
  await page.getByRole('tab', { name: 'Inspector', exact: true }).click();
  await page.getByRole('tab', { name: 'Mask', exact: true }).click();
  // The Mask section starts collapsed (inspector registry `defaultOpen: false`).
  const panel = page.getByLabel('mask', { exact: true }).first();
  if (!(await panel.evaluate((node: HTMLDetailsElement) => node.open))) {
    await panel.locator('summary').click();
  }
  await expect(panel).toHaveJSProperty('open', true);
  const canvas = page.getByRole('application', { name: 'Mask canvas', exact: true });
  await expect(canvas).toBeVisible();
  return canvas;
}

/** Scroll an Inspector control to the centre, then click it (see mask-tools.spec.ts). */
export async function clickInInspector(target: Locator): Promise<void> {
  await target.evaluate((node: Element) => node.scrollIntoView({ block: 'center' }));
  await target.click();
}

/** Drag on the mask canvas between two points given as fractions of its box. */
export async function dragOnCanvas(
  page: Page,
  canvas: Locator,
  from: readonly [number, number],
  to: readonly [number, number],
): Promise<void> {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    const f = step / steps;
    await page.mouse.move(
      box.x + box.width * (from[0] + (to[0] - from[0]) * f),
      box.y + box.height * (from[1] + (to[1] - from[1]) * f),
    );
  }
  await page.mouse.up();
}

/**
 * Wait until the desktop host has SAVED a project that satisfies `predicate` (the autosave is
 * debounced), and return it. Assertions on "the resulting patch" read this document: it is what
 * went to disk and what the export renders.
 */
export async function savedProject(
  desktop: FakeDesktop,
  predicate: (project: Project) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<Project> {
  let found: Project | undefined;
  await expect
    .poll(
      () => {
        const last = desktop.saves[desktop.saves.length - 1];
        found = last !== undefined && predicate(last) ? last : undefined;
        return found !== undefined;
      },
      { message: `the editor saved ${what}`, timeout: timeoutMs },
    )
    .toBe(true);
  return found!;
}

/** All clips of a saved project, by id. */
export function clipsById(
  document: Project,
): Map<string, Project['timeline']['tracks'][number]['clips'][number]> {
  return new Map(
    document.timeline.tracks.flatMap((track) =>
      track.clips.map((entry) => [entry.id, entry] as const),
    ),
  );
}

/** Assert an engine export completed, validated, and has the expected picture and length. */
export function expectValidExport(result: EngineExport, seconds: number): void {
  expect(result.error, `export error: ${result.errorDetail ?? ''}`).toBeNull();
  expect(result.state).toBe('completed');
  expect(result.validation?.ok).toBe(true);
  expect(result.probe?.durationSeconds ?? 0).toBeCloseTo(seconds, 1);
  expect(result.probe?.streams.some((stream) => stream.codecType === 'video')).toBe(true);
}
