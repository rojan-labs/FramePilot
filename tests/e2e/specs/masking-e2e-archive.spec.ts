/**
 * E2E.7 — a project with masks, mattes and tracks moves between machines
 * (plan/background-removal-ai/07, E2E.7; audit P14).
 *
 * A project is a folder: `project.fp.json` with media paths relative to it, the media, and the
 * project-owned artifacts under `.framepilot-derived/` (mattes, tracks), each pinned by digest.
 * Archiving it is copying the folder. This spec builds one (a background-removal matte; an
 * ellipse on a perspective track limiting the clip blur; a keyframed rectangle), exports it and
 * records reference frames (`engine/python/tests/masking_archive.py create`), MOVES the folder
 * (a different absolute root; the original removed, so nothing can resolve back to it), then:
 *
 *  - opens it the way the desktop does (`scripts/masking-archive-open.mjs`: the project file
 *    layer, every path relative and present, every track at its pinned digest, the desktop's
 *    FULL matte validation) — clean;
 *  - exports it again and compares with the reference (`masking_archive reopen`): the same probe,
 *    and on the same platform bit-identical frames and export file;
 *  - with the track artifact left out of the archive, the open check names it and the export
 *    refuses, rather than exporting a mask that no longer follows its subject.
 *
 * The CROSS-PLATFORM half runs in CI's `masking-archive-*` jobs: the folder is made on macOS and
 * reopened on Windows and the reverse (artifact hand-off), where the frames must pass the PX4
 * gates (PSNR >= 40 dB, >= 99.5% within 8/255) and bit-identity is reported, not required (the
 * decoder builds differ by platform). What those jobs cannot show is a packaged Electron app on
 * the maintainer's own Mac and Windows machines (MO-9); that stays a release-gate check (RD3).
 *
 * CI ONLY (`masking-e2e` job).
 */
import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ENGINE_DIR, REPO, WORK_ROOT } from './masking/workspace.js';

const run = promisify(execFile);

interface OpenReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly masks: number;
}

interface ReopenReport {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly exportIdentical: boolean;
  readonly frames: readonly { time: number; identical: boolean; psnr: number | null }[];
}

async function archive(command: 'create' | 'reopen', dir: string): Promise<ReopenReport> {
  const { stdout } = await run(
    'uv',
    ['run', '--quiet', 'python', '-m', 'tests.masking_archive', command, dir],
    { cwd: ENGINE_DIR, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 },
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
  const last = stdout.trim().split('\n').pop() ?? '{}';
  return JSON.parse(last) as ReopenReport;
}

async function openAsDesktop(projectPath: string): Promise<OpenReport> {
  const module = (await import(
    join(REPO, 'tests', 'e2e', 'scripts', 'masking-archive-open.mjs')
  )) as { openArchive(path: string): Promise<OpenReport> };
  return module.openArchive(projectPath);
}

test('E2E.7 an archive with masks, mattes and tracks moves and reopens identically', async ({}, testInfo) => {
  test.setTimeout(8 * 60_000);
  const root = join(WORK_ROOT, 'e2e7-archive');
  await rm(root, { recursive: true, force: true });
  const origin = join(root, 'made-here');
  const created = (await archive('create', origin)) as unknown as { ok: boolean };
  expect(created.ok, 'the archive was built and its reference export validated').toBe(true);

  // Moved: a different absolute root, and the original gone.
  const moved = join(root, 'another', 'machine');
  await mkdir(join(root, 'another'), { recursive: true });
  await cp(origin, moved, { recursive: true });
  await rm(origin, { recursive: true, force: true });

  const opened = await openAsDesktop(join(moved, 'project', 'project.fp.json'));
  expect(opened.problems).toEqual([]);
  expect(opened.masks).toBe(3);

  const reopened = await archive('reopen', moved);
  testInfo.annotations.push({ type: 'reopen', description: JSON.stringify(reopened) });
  expect(reopened.failures).toEqual([]);
  // Same platform, same decoder: nothing may move at all.
  expect(reopened.frames.map((frame) => frame.identical)).toEqual([true, true, true]);
  expect(reopened.exportIdentical).toBe(true);

  // An archive made without its track: named on open, refused on export.
  const partial = join(root, 'partial');
  await cp(moved, partial, { recursive: true });
  await rm(join(partial, 'project', '.framepilot-derived', 'tracks'), {
    recursive: true,
    force: true,
  });
  const incomplete = await openAsDesktop(join(partial, 'project', 'project.fp.json'));
  expect(incomplete.problems).toEqual(['track of clip_subject__face is missing']);
  const refused = await archive('reopen', partial);
  expect(refused.ok).toBe(false);
  expect(refused.failures.join(' ')).toMatch(/export: failed/u);
});
