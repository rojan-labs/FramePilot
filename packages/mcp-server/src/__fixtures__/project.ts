/**
 * Test fixture: write a small, valid project.fp.json into a temp sandbox so the
 * session/dispatch tests exercise the real file IO + sandbox path. Mirrors the
 * shape used across the ai-sdk tests (one video track with two clips).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { onTestFinished } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { writeProjectFile } from '@framepilot/timeline-schema/file';

export function makeProject(overrides: Partial<Project> = {}): Project {
  return parseProject({
    id: 'proj_1',
    name: 'Demo',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 }],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_1',
              trackId: 'video_1',
              start: 0,
              end: 6,
              sourceStart: 0,
              sourceEnd: 6,
              effects: [],
              keyframes: [],
            },
            {
              id: 'clip_b',
              assetId: 'asset_1',
              trackId: 'video_1',
              start: 6,
              end: 10,
              sourceStart: 6,
              sourceEnd: 10,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'audio_1', type: 'audio', clips: [] },
      ],
    },
    transcript: [
      { word: 'hello', start: 0, end: 0.5 },
      { word: 'world', start: 0.5, end: 1 },
    ],
    aiMemory: {},
    history: [],
    ...overrides,
  });
}

/**
 * Remove a test's sandbox when that test ends.
 *
 * Every caller got a fresh `mkdtemp` and nothing ever removed it, so a machine that runs
 * this suite regularly accumulates them — 588 were found on one developer's box. Vitest
 * runs tests in worker processes that do not run `process.on('exit')` handlers, so the
 * cleanup has to be registered with the runner: `onTestFinished` fires for the test that
 * asked for the sandbox, pass or fail, and needs no change at any call site.
 */
function removeWhenTheTestEnds(root: string): void {
  try {
    onTestFinished(() => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // A temp dir we cannot remove is not worth failing a test run over.
      }
    });
  } catch {
    // Called outside a running test (a setup file, or a helper reused by a script):
    // there is no test to hang the cleanup on, and leaking one dir beats throwing here.
  }
}

/** Create a temp sandbox root containing `project.fp.json`; returns both paths. */
export async function makeSandboxProject(): Promise<{ root: string; projectPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'framepilot-mcp-'));
  removeWhenTheTestEnds(root);
  const projectPath = join(root, 'project.fp.json');
  await writeProjectFile(projectPath, makeProject());
  return { root, projectPath };
}
