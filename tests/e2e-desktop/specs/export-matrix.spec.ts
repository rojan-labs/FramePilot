import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import {
  descendants,
  exportThroughDialog,
  launchDesktop,
  recordReveals,
  FIXTURE_PROJECTS,
  type DesktopSession,
} from './launch.js';

/**
 * UC-13 export matrix on the real desktop host (plan/system-mission P9.4).
 *
 * Every row renders a fixture project through the sidecar the desktop app itself spawned —
 * the same `POST /render` → `GET /render/jobs/{id}` contract the export dialog uses — and
 * then asks **ffprobe** what actually came out. The expected numbers below are written by
 * hand from `engine/python/framepilot_engine/render/export_settings.py`'s rules, not derived
 * from the engine's own answer, because a matrix that asks the encoder to grade itself
 * cannot catch the encoder being wrong. The job's self-reported `target` is then compared
 * against the file as a second, independent check: engine and file must agree.
 *
 * The two facts the rows are built around, from the fixtures themselves:
 *   - `mission-export-30s`: a 1080x1920 portrait project at 30 fps, 30 s long, whose largest
 *     source is 4K (short edge 2160) — so anything up to 1440p is delivered uncapped.
 *   - `mission-export-60s`: a 1920x1080 project at 30 fps, 60 s long, whose only source is
 *     640x360 — so every request above 360p is **capped to the source**, never upscaled.
 *
 * Media fixtures are the maintainer's real camera files and are never committed. Without
 * them (or without ffprobe) the whole file skips with a stated reason rather than failing:
 * a red X that means "no media on this machine" teaches people to ignore red.
 */

const PROJECT_30S = 'mission-export-30s';
const PROJECT_60S = 'mission-export-60s';
const SIDECAR_PORT = 8796;
/** The history/reveal row runs its own app instance with the project open in the UI. */
const UI_SIDECAR_PORT = 8785;

/** ffprobe tolerance: the container duration must land within one frame of the timeline. */
const DURATION_TOLERANCE_FRAMES = 1;

interface ExportSettingsWire {
  resolution?: '480p' | '720p' | '1080p' | '1440p' | '2160p' | 'source';
  fps?: 24 | 25 | 30 | 50 | 60 | 'source';
  quality?: 'low' | 'recommended' | 'high';
  video_codec?: 'h264' | 'hevc';
  container?: 'mp4' | 'mov';
}

interface MatrixRow {
  readonly name: string;
  readonly project: string;
  readonly settings: ExportSettingsWire;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly codec: 'h264' | 'hevc';
  readonly container: 'mp4' | 'mov';
  readonly durationSeconds: number;
  readonly cappedToSource: boolean;
}

const MATRIX: MatrixRow[] = [
  {
    name: '1080p · source fps · H.264 · MP4 (the default export)',
    project: PROJECT_30S,
    settings: { resolution: '1080p', fps: 'source', video_codec: 'h264', container: 'mp4' },
    width: 1080,
    height: 1920,
    fps: 30,
    codec: 'h264',
    container: 'mp4',
    durationSeconds: 30,
    cappedToSource: false,
  },
  {
    name: '720p · 30 fps · H.264 · MP4 (a downscale, low quality tier)',
    project: PROJECT_30S,
    settings: {
      resolution: '720p',
      fps: 30,
      quality: 'low',
      video_codec: 'h264',
      container: 'mp4',
    },
    width: 720,
    height: 1280,
    fps: 30,
    codec: 'h264',
    container: 'mp4',
    durationSeconds: 30,
    cappedToSource: false,
  },
  {
    name: '1080p · 24 fps · HEVC · MOV (a frame-rate change and the other codec/container)',
    project: PROJECT_30S,
    settings: { resolution: '1080p', fps: 24, video_codec: 'hevc', container: 'mov' },
    width: 1080,
    height: 1920,
    fps: 24,
    codec: 'hevc',
    container: 'mov',
    durationSeconds: 30,
    cappedToSource: false,
  },
  {
    name: '2160p requested from a 360p source · capped, never upscaled',
    project: PROJECT_60S,
    settings: { resolution: '2160p', fps: 'source', video_codec: 'h264', container: 'mp4' },
    width: 640,
    height: 360,
    fps: 30,
    codec: 'h264',
    container: 'mp4',
    durationSeconds: 60,
    cappedToSource: true,
  },
  {
    name: 'source resolution · 25 fps · HEVC · MOV',
    project: PROJECT_60S,
    settings: { resolution: 'source', fps: 25, video_codec: 'hevc', container: 'mov' },
    width: 640,
    height: 360,
    fps: 25,
    codec: 'hevc',
    container: 'mov',
    durationSeconds: 60,
    cappedToSource: false,
  },
];

interface RenderTask {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage?: string | null;
  progress?: number;
  error?: string | null;
  result?: {
    output_path?: string | null;
    error?: string | null;
    target?: {
      width: number;
      height: number;
      fps: number;
      /** The ffmpeg ENCODER, not the codec enum: `libx264`, `hevc_videotoolbox`, … */
      video_codec: string;
      container: string;
      capped_to_source: boolean;
      effective_resolution: string | null;
    } | null;
  } | null;
}

function haveFfprobe(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const projectFile = (id: string): string => join(FIXTURE_PROJECTS, `${id}.fp.json`);
const haveFixtures = (): boolean =>
  [PROJECT_30S, PROJECT_60S].every((id) => existsSync(projectFile(id)));

/** What ffprobe says is actually in the file — the only opinion this suite trusts. */
interface Probe {
  width: number;
  height: number;
  fps: number;
  codec: string;
  formatNames: string[];
  durationSeconds: number;
}

function probe(path: string): Probe {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const json = JSON.parse(raw) as {
    streams: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }[];
    format: { duration: string; format_name: string };
  };
  const video = json.streams.find((s) => s.codec_type === 'video');
  expect(video, `${path} should contain a video stream`).toBeDefined();
  const [num = 0, den = 1] = (video!.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: video!.width ?? 0,
    height: video!.height ?? 0,
    fps: den ? num / den : 0,
    codec: video!.codec_name,
    formatNames: json.format.format_name.split(','),
    durationSeconds: Number(json.format.duration),
  };
}

let session: DesktopSession;

async function job(id: string): Promise<RenderTask> {
  const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/render/jobs/${id}`);
  expect(res.ok, `GET /render/jobs/${id} → ${res.status}`).toBe(true);
  return (await res.json()) as RenderTask;
}

async function submit(project: string, settings: ExportSettingsWire): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_path: `${project}.fp.json`, settings }),
  });
  expect(res.ok, `POST /render → ${res.status} ${await res.clone().text()}`).toBe(true);
  // `RenderAcceptedResponse` serializes through its `jobId` alias; accept the field name
  // too, so this suite is not the thing that breaks if that alias is ever dropped.
  const body = (await res.json()) as { jobId?: string; job_id?: string };
  const id = body.jobId ?? body.job_id;
  expect(id, 'POST /render must return a job id').toBeTruthy();
  return id!;
}

/** Poll to a terminal state, sampling `progress` on the way (the queue's live field). */
async function awaitJob(
  id: string,
  onSample?: (atMs: number, task: RenderTask) => void,
  pollMs = 1000,
): Promise<RenderTask> {
  const started = Date.now();
  for (;;) {
    const task = await job(id);
    onSample?.(Date.now() - started, task);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')
      return task;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** ffmpeg/ffprobe children of the app right now — an orphan encoder is a resource leak. */
const mediaChildren = (): number =>
  descendants(session.mainPid).filter((c) => /ffmpeg/.test(c.cmd)).length;

test.describe('UC-13 export matrix', () => {
  test.skip(
    !haveFixtures(),
    'mission media fixtures absent (tests/fixtures/mission/fetch-fixtures.sh)',
  );
  test.skip(!haveFfprobe(), 'ffprobe not on PATH; the matrix asserts on the real file');

  test.beforeAll(async () => {
    // One app launch for the whole matrix: the export goes through the sidecar the desktop
    // itself spawned, so this is the real desktop path, but it is paid for once.
    session = await launchDesktop({ sidecarPort: SIDECAR_PORT });
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 120_000, message: 'the desktop app should bring up its sidecar' },
      )
      .toBe(true);
  });

  test.afterAll(async () => {
    await session?.app.close();
  });

  for (const row of MATRIX) {
    test(`${row.project} → ${row.name}`, async () => {
      test.setTimeout(15 * 60_000);
      const id = await submit(row.project, row.settings);
      const task = await awaitJob(id);
      expect(task.status, `render failed: ${task.error ?? task.result?.error ?? ''}`).toBe(
        'completed',
      );

      const output = task.result?.output_path;
      expect(output, 'a completed export must report its output file').toBeTruthy();
      const path = output!.startsWith('/') ? output! : join(FIXTURE_PROJECTS, output!);
      expect(existsSync(path), `${path} should exist`).toBe(true);

      const p = probe(path);
      expect({ width: p.width, height: p.height }).toEqual({
        width: row.width,
        height: row.height,
      });
      expect(p.fps).toBeCloseTo(row.fps, 2);
      expect(p.codec).toBe(row.codec);
      // ffprobe names MP4/MOV as one muxer family (`mov,mp4,m4a,...`); the extension is
      // what the user gets handed, so assert both the family and the extension asked for.
      expect(p.formatNames.some((n) => n === 'mp4' || n === 'mov')).toBe(true);
      expect(path.endsWith(`.${row.container}`)).toBe(true);
      expect(Math.abs(p.durationSeconds - row.durationSeconds)).toBeLessThanOrEqual(
        DURATION_TOLERANCE_FRAMES / row.fps,
      );

      // Second, independent check: what the engine says it encoded must be what it encoded.
      const target = task.result?.target;
      expect(target, 'the job should report the encode target it used').toBeTruthy();
      expect({
        width: target!.width,
        height: target!.height,
        container: target!.container,
        capped: target!.capped_to_source,
      }).toEqual({
        width: row.width,
        height: row.height,
        container: row.container,
        capped: row.cappedToSource,
      });
      expect(target!.fps).toBeCloseTo(row.fps, 2);
      // The job names the ENCODER it picked (libx264, hevc_videotoolbox, …), which is
      // hardware-dependent; only the codec family is a promise, and ffprobe above already
      // pinned the codec that actually landed in the file.
      expect(target!.video_codec).toMatch(row.codec === 'h264' ? /264/ : /265|hevc/);

      expect(mediaChildren(), 'no encoder may outlive its own job').toBe(0);
    });
  }

  test('cancelling an export leaves no partial file and no orphan encoder', async () => {
    test.setTimeout(10 * 60_000);
    const outputPath = join(FIXTURE_PROJECTS, 'exports', `${PROJECT_30S}.mp4`);
    // Start from nothing so "the file is there" can only mean this run wrote it.
    rmSync(outputPath, { force: true });

    const id = await submit(PROJECT_30S, {
      resolution: '1080p',
      video_codec: 'h264',
      container: 'mp4',
    });
    // Let it actually start encoding — cancelling a queued job proves nothing.
    await expect.poll(async () => (await job(id)).status, { timeout: 120_000 }).toBe('running');
    await new Promise((r) => setTimeout(r, 5_000));

    const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/render/jobs/${id}/cancel`, {
      method: 'POST',
    });
    expect(res.ok).toBe(true);

    await expect
      .poll(async () => (await job(id)).status, {
        timeout: 120_000,
        message: 'the job should end up cancelled',
      })
      .toBe('cancelled');

    // A cancelled export must leave nothing behind that looks like a finished video.
    expect(
      existsSync(outputPath) ? statSync(outputPath).size : 0,
      'a cancelled export must not leave a partial file where the finished one goes',
    ).toBe(0);
    await expect
      .poll(() => mediaChildren(), {
        timeout: 30_000,
        message: 'the encoder must die with the job',
      })
      .toBe(0);
  });

  /**
   * UC-13's last two promises, which only exist in the UI: after an export finishes the
   * user can find the file again, and the app remembers what they chose.
   *
   * This row goes through the export popover rather than the sidecar, on its own app
   * instance with the project actually open, because "Recent exports" and "Reveal" are
   * renderer state that the HTTP contract knows nothing about. The native Save-As modal
   * is cancelled and `shell.showItemInFolder` is recorded instead of opening Finder: the
   * assertion is that Reveal hands the OS the exact path of the file that was produced.
   */
  test('a finished export is remembered, revealable, and its settings survive a reload', async () => {
    test.setTimeout(20 * 60_000);
    const ui = await launchDesktop({ projectId: PROJECT_30S, sidecarPort: UI_SIDECAR_PORT });
    try {
      const reveals = await recordReveals(ui);
      const outputPath = await exportThroughDialog(ui, {
        resolution: '720p',
        quality: 'Low',
        container: 'MP4',
      });
      expect(existsSync(outputPath), `${outputPath} should exist on disk`).toBe(true);
      expect(probe(outputPath).height).toBeGreaterThan(0);

      const dialog = ui.page.getByRole('dialog', { name: 'Export video' });
      const name = outputPath.split('/').pop()!;
      await expect(dialog.getByRole('region', { name: 'Recent exports' })).toBeVisible();
      await dialog.getByRole('button', { name: `Reveal ${name} in folder` }).click();
      // Reveal must point at the file that was just written — not the folder, not a
      // stale entry from an earlier run.
      await expect.poll(async () => await reveals()).toContain(outputPath);

      // Reload the whole renderer and reopen the project: history and the chosen
      // settings are what the user comes back to, so they have to outlive the window.
      await ui.page.goto('http://127.0.0.1:5173/');
      await ui.page.getByRole('button', { name: PROJECT_30S }).first().click();
      await expect(ui.page.locator('section[aria-label="timeline"]')).toBeVisible({
        timeout: 60_000,
      });
      await ui.page.getByRole('button', { name: 'Export video' }).click();
      const reopened = ui.page.getByRole('dialog', { name: 'Export video' });
      await expect(
        reopened.getByRole('button', { name: `Reveal ${name} in folder` }),
      ).toBeVisible();
      await expect(reopened.getByRole('combobox', { name: 'Resolution' })).toHaveText(/720p/);
    } finally {
      await ui.app.close();
    }
  });

  test('reported progress tracks the real elapsed fraction after the first 10%', async () => {
    test.setTimeout(15 * 60_000);
    const samples: { atMs: number; progress: number }[] = [];
    const id = await submit(PROJECT_30S, {
      resolution: '720p',
      video_codec: 'h264',
      container: 'mp4',
    });
    const task = await awaitJob(
      id,
      (atMs, t) => {
        if (t.status === 'running') samples.push({ atMs, progress: t.progress ?? 0 });
      },
      500,
    );
    expect(task.status).toBe('completed');
    const last = samples.at(-1);
    const totalMs = last ? last.atMs : 0;
    expect(samples.length, 'the export should report progress while running').toBeGreaterThan(4);

    // Monotonic: a bar that goes backwards is worse than no bar.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.progress).toBeGreaterThanOrEqual(samples[i - 1]!.progress);
    }
    // Accurate: past the first 10%, what it claims must be within 5 points of the truth
    // (the truth being the fraction of the run's own wall clock that had elapsed).
    const worst = samples
      .filter((s) => s.progress >= 0.1)
      .map((s) => Math.abs(s.progress - s.atMs / totalMs))
      .reduce((a, b) => Math.max(a, b), 0);
    expect(worst, `worst progress error ${(worst * 100).toFixed(1)}%`).toBeLessThan(0.05);
  });
});
