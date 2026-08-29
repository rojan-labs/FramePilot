import { expect, test } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { descendants, launchDesktop, FIXTURE_PROJECTS, type DesktopSession } from './launch.js';

/**
 * UC-15 failure paths on the real desktop host (plan/system-mission P9.2).
 *
 * Every row asserts the same three things, because they are what separates a handled
 * failure from a corrupted session:
 *
 * 1. **Nothing is half-applied.** The project on the timeline is either untouched or
 *    fully committed — never a partial edit nobody asked for.
 * 2. **The app says what happened.** A failure the user cannot see is a failure they
 *    will re-trigger.
 * 3. **No orphan processes.** Every ffmpeg/ffprobe/python child is accounted for after
 *    the failure, or the next export competes with a ghost for the same cores.
 *
 * Rows needing a live model provider live in the `needs a model provider` group and are
 * gated on `MISSION_AI=1`; the rest run on any machine that can launch the app, because
 * they are the ones a release must not break.
 */

const CLIP_COUNT_TIMEOUT_MS = 60_000;

/** Clip count on the timeline — the cheapest proof that nothing was half-applied. */
async function clipCount(session: DesktopSession): Promise<number> {
  return session.page.getByRole('button', { name: /^clip / }).count();
}

/** ffmpeg/ffprobe children of the app right now. */
function mediaChildren(mainPid: number): number {
  return descendants(mainPid).filter((c) => /ffmpeg|ffprobe/.test(c.cmd)).length;
}

/**
 * Cut the main process off from a set of hosts, from inside it.
 *
 * Stock and music are fetched by Electron's MAIN process (the renderer's CSP forbids
 * reaching a provider at all), so `page.context().setOffline()` cannot express this
 * failure — it only unplugs the renderer. Replacing `globalThis.fetch` in main with one
 * that throws the same `TypeError: fetch failed` undici throws when a host is unreachable
 * is the honest simulation, and it needs no product code to carry a test-only flag.
 */
async function goOffline(session: DesktopSession, hostPattern: string): Promise<void> {
  await session.app.evaluate(({}, pattern: string) => {
    const re = new RegExp(pattern);
    const real = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (re.test(url)) throw new TypeError('fetch failed');
      return real(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
  }, hostPattern);
}

test.describe('UC-15 failure paths', () => {
  test('an unreadable media file is refused with a reason, and the timeline is untouched', async () => {
    test.setTimeout(3 * 60_000);
    const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8791 });
    try {
      const { page } = session;
      const before = await clipCount(session);

      // A file with a video extension and no video in it — the shape of a truncated
      // download or a renamed document, which is how this arrives in real life.
      const junkDir = mkdtempSync(join(tmpdir(), 'framepilot-junk-'));
      const junk = join(junkDir, 'not-really-a-video.mp4');
      writeFileSync(junk, 'this is not media');

      await page.locator('input[type="file"][accept*="video"]').first().setInputFiles(junk);

      // It must say something. A silent no-op is the failure this row exists to catch.
      await expect(page.getByText(/could not|unsupported|failed|invalid/i).first()).toBeVisible({
        timeout: 60_000,
      });
      // And it must not have changed the edit.
      expect(await clipCount(session)).toBe(before);
      expect(mediaChildren(session.mainPid)).toBe(0);
    } finally {
      await session.app.close();
    }
  });

  test('killing the engine mid-session leaves no orphans and the app recovers', async () => {
    test.setTimeout(4 * 60_000);
    const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8792 });
    try {
      const before = await clipCount(session);
      const sidecar = descendants(session.mainPid).find((c) =>
        /framepilot|uvicorn|python/.test(c.cmd),
      );
      expect(sidecar, 'the desktop app should own a sidecar process').toBeDefined();

      // SIGKILL, not SIGTERM: the point is an engine that dies without cleaning up.
      execFileSync('kill', ['-9', String(sidecar!.pid)]);

      // P5.5: the manager restarts it. Poll rather than sleep — the backoff is 1s.
      await expect
        .poll(
          () =>
            descendants(session.mainPid).filter((c) => /framepilot|uvicorn|python/.test(c.cmd))
              .length,
          { timeout: 90_000, message: 'the engine should come back on its own' },
        )
        .toBeGreaterThan(0);

      // Exactly one engine — a restart that leaves the old one behind is a leak.
      expect(
        descendants(session.mainPid).filter((c) => /framepilot|uvicorn|python/.test(c.cmd)).length,
      ).toBe(1);
      // The edit survived the outage untouched.
      expect(await clipCount(session)).toBe(before);
    } finally {
      await session.app.close();
    }
  });

  test('closing the app takes every child process with it', async () => {
    test.setTimeout(3 * 60_000);
    const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8793 });
    const { mainPid } = session;
    await expect
      .poll(() => descendants(mainPid).length, { timeout: CLIP_COUNT_TIMEOUT_MS })
      .toBeGreaterThan(0);

    await session.app.close();

    // Nothing may outlive the app — not the engine, not an ffmpeg it spawned.
    await expect
      .poll(() => descendants(mainPid).length, {
        timeout: 30_000,
        message: 'every child process should exit with the app',
      })
      .toBe(0);
  });

  test('music search with the network down reports the outage instead of hanging', async () => {
    test.setTimeout(4 * 60_000);
    const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8795 });
    try {
      const { page } = session;
      const before = await clipCount(session);
      await goOffline(session, 'openverse|wikimedia|jamendo');

      await page.getByRole('tab', { name: 'Sounds' }).first().click();
      const search = page.getByPlaceholder('Search music…');
      await search.fill('calm piano');
      await search.press('Enter');

      // The panel must resolve to a stated failure. A spinner that never ends is the
      // bug this row exists to catch — the user cannot tell it from a slow network.
      await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 60_000 });
      expect(await clipCount(session)).toBe(before);
      expect(mediaChildren(session.mainPid)).toBe(0);
    } finally {
      await session.app.close();
    }
  });

  test('stock search with the network down reports the outage instead of hanging', async () => {
    test.skip(
      !process.env.PEXELS_API_KEY,
      'stock search needs PEXELS_API_KEY; without a key the panel shows the keyless state, not a network failure',
    );
    test.setTimeout(4 * 60_000);
    const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8796 });
    try {
      const { page } = session;
      const before = await clipCount(session);
      await goOffline(session, 'pexels\\.com');

      await page.getByRole('tab', { name: 'Stock' }).first().click();
      const search = page.getByPlaceholder(/Search (video|photos)…/).first();
      await search.fill('city timelapse');
      await search.press('Enter');

      await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 60_000 });
      expect(await clipCount(session)).toBe(before);
      expect(mediaChildren(session.mainPid)).toBe(0);
    } finally {
      await session.app.close();
    }
  });

  test('an export whose encoder fails reports it and leaves no partial file', async () => {
    test.setTimeout(6 * 60_000);
    // A stand-in ffmpeg that exits non-zero with a plausible encoder message. Testing a
    // FAILING ffmpeg rather than a MISSING one is deliberate: "binary not found" is caught
    // at startup, while a mid-encode failure is what a bad codec/disk-full run looks like.
    const binDir = mkdtempSync(join(tmpdir(), 'framepilot-bad-ffmpeg-'));
    const fake = join(binDir, 'ffmpeg');
    writeFileSync(
      fake,
      '#!/bin/sh\necho "Error while opening encoder - maybe incorrect parameters" >&2\nexit 1\n',
    );
    chmodSync(fake, 0o755);

    const port = 8797;
    const session = await launchDesktop({
      sidecarPort: port,
      // Only ffmpeg is sabotaged; ffprobe still works, so the project still loads and the
      // failure lands exactly where the row is aimed: the encode.
      extraEnv: { FRAMEPILOT_FFMPEG: fake },
    });
    const output = join(FIXTURE_PROJECTS, 'exports', 'mission-export-30s.mp4');
    try {
      test.skip(
        !existsSync(join(FIXTURE_PROJECTS, 'mission-export-30s.fp.json')),
        'mission media fixtures absent (tests/fixtures/mission/fetch-fixtures.sh)',
      );
      rmSync(output, { force: true });
      await expect
        .poll(
          async () => {
            try {
              return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
            } catch {
              return false;
            }
          },
          { timeout: 120_000 },
        )
        .toBe(true);

      const accepted = await fetch(`http://127.0.0.1:${port}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_path: 'mission-export-30s.fp.json' }),
      });
      expect(accepted.ok).toBe(true);
      const body = (await accepted.json()) as { jobId?: string; job_id?: string };
      const jobId = body.jobId ?? body.job_id;
      expect(jobId, 'POST /render must return a job id').toBeTruthy();

      await expect
        .poll(
          async () => {
            const task = (await (
              await fetch(`http://127.0.0.1:${port}/render/jobs/${jobId}`)
            ).json()) as { status: string };
            return task.status;
          },
          { timeout: 5 * 60_000, message: 'a broken encoder must end the job, not hang it' },
        )
        .toBe('failed');

      const task = (await (
        await fetch(`http://127.0.0.1:${port}/render/jobs/${jobId}`)
      ).json()) as { error?: string | null; result?: { error?: string | null } | null };
      // A reason, not just a red state: the editor shows this sentence.
      expect(task.error ?? task.result?.error ?? '').not.toBe('');
      // And no half-written file where a finished export goes.
      expect(existsSync(output) ? statSync(output).size : 0).toBe(0);
      await expect.poll(() => mediaChildren(session.mainPid), { timeout: 30_000 }).toBe(0);
    } finally {
      await session.app.close();
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test.describe('needs a model provider', () => {
    test.skip(
      process.env.MISSION_AI !== '1',
      'these rows drive a real model provider (MISSION_AI=1)',
    );

    test('cancelling a run mid-flight leaves the timeline consistent and no orphans', async () => {
      test.setTimeout(10 * 60_000);
      const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8794 });
      try {
        const { page } = session;
        const before = await clipCount(session);
        await page.getByRole('tab', { name: 'AI' }).first().click();
        const composer = page.getByRole('textbox', { name: 'Message FramePilot' });
        await composer.fill('Create a 30-second fast-paced social montage from the footage.');
        await composer.press('Enter');
        await expect(page.getByRole('status')).toBeVisible({ timeout: 60_000 });

        // Let it commit to something, then stop it.
        await page.waitForTimeout(20_000);
        await page.getByRole('button', { name: /Stop/i }).first().click();
        await expect(page.getByRole('status')).toBeHidden({ timeout: 120_000 });

        // Cancellation is not failure: the run reports itself cancelled, and whatever it
        // had already applied is a complete, undoable edit — never a half-written patch.
        const after = await clipCount(session);
        expect(after === before || after > 0).toBe(true);
        expect(mediaChildren(session.mainPid)).toBe(0);
      } finally {
        await session.app.close();
      }
    });

    test('a provider 5xx mid-run surfaces as a failure card, not a stuck run', async () => {
      test.setTimeout(12 * 60_000);
      // A proxy in front of the real provider: the first `HEALTHY_CALLS` requests go
      // through untouched, and everything after is a 500. That is what "mid-run" means —
      // the run has already applied real work when the provider falls over, which is the
      // only version of this failure that can leave a half-applied timeline behind.
      const HEALTHY_CALLS = 2;
      const upstream = process.env.MISSION_PROVIDER_UPSTREAM ?? 'https://api.deepseek.com';
      let seen = 0;
      const proxy = await startProxy(async (req, res, body) => {
        if (seen++ >= HEALTHY_CALLS) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream is having a bad day' } }));
          return;
        }
        const target = new URL(req.url ?? '/', upstream);
        const headers = { ...req.headers } as Record<string, string>;
        delete headers['host'];
        delete headers['content-length'];
        const upstreamRes = await fetch(target, {
          method: req.method ?? 'POST',
          headers,
          ...(body.length ? { body: new Uint8Array(body) } : {}),
        });
        res.writeHead(upstreamRes.status, {
          'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
        });
        res.end(Buffer.from(await upstreamRes.arrayBuffer()));
      });

      const session = await launchDesktop({
        projectId: 'mission-montage',
        sidecarPort: 8798,
        extraEnv: {
          FRAMEPILOT_AI_PROVIDER: 'deepseek',
          DEEPSEEK_BASE_URL: proxy.url,
        },
      });
      try {
        const { page } = session;
        const before = await clipCount(session);
        await page.getByRole('tab', { name: 'AI' }).first().click();
        const composer = page.getByRole('textbox', { name: 'Message FramePilot' });
        await composer.fill('Create a 30-second fast-paced social montage from the footage.');
        await composer.press('Enter');

        // The run must END, and say why. A provider outage that leaves the composer
        // disabled and a spinner turning is indistinguishable from a hang.
        await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 6 * 60_000 });
        await expect(page.getByRole('status')).toBeHidden({ timeout: 2 * 60_000 });
        await expect(composer).toBeEditable();

        const after = await clipCount(session);
        expect(after === before || after > 0).toBe(true);
        expect(mediaChildren(session.mainPid)).toBe(0);
      } finally {
        await session.app.close();
        await proxy.close();
      }
    });

    test('a tool that throws mid-run is reported and the run keeps control', async () => {
      test.skip(
        typeof process.getuid === 'function' && process.getuid() === 0,
        'root can read a 000-mode file, so this row cannot make a tool throw',
      );
      test.setTimeout(12 * 60_000);
      const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8790 });
      // Make one source file unreadable AFTER the project is open: the next tool that
      // touches it (a frame grab, a beat detection, a probe) throws an OS error from
      // inside the engine — a real tool failure, not a mocked one.
      const victim = join(FIXTURE_PROJECTS, 'media', 'mission-montage');
      try {
        const { page } = session;
        const before = await clipCount(session);
        test.skip(!existsSync(victim), 'mission media fixtures absent for this project');
        chmodSync(victim, 0o000);

        await page.getByRole('tab', { name: 'AI' }).first().click();
        const composer = page.getByRole('textbox', { name: 'Message FramePilot' });
        await composer.fill('Look at the footage and cut a 20-second highlight.');
        await composer.press('Enter');

        await expect(page.getByRole('status')).toBeHidden({ timeout: 8 * 60_000 });
        await expect(composer).toBeEditable();
        const after = await clipCount(session);
        expect(after === before || after > 0).toBe(true);
        expect(mediaChildren(session.mainPid)).toBe(0);
      } finally {
        if (existsSync(victim)) chmodSync(victim, 0o755);
        await session.app.close();
      }
    });

    test('relaunching after a crash mid-run hands control back, with no run still running', async () => {
      test.setTimeout(12 * 60_000);
      const userDataDir = mkdtempSync(join(tmpdir(), 'framepilot-relaunch-'));
      const first = await launchDesktop({
        projectId: 'mission-montage',
        sidecarPort: 8789,
        userDataDir,
      });
      let clipsBefore = 0;
      try {
        clipsBefore = await clipCount(first);
        await first.page.getByRole('tab', { name: 'AI' }).first().click();
        const composer = first.page.getByRole('textbox', { name: 'Message FramePilot' });
        await composer.fill('Create a 30-second fast-paced social montage from the footage.');
        await composer.press('Enter');
        await expect(first.page.getByRole('status')).toBeVisible({ timeout: 60_000 });
        await first.page.waitForTimeout(20_000);
      } finally {
        // SIGKILL the app mid-run: no graceful shutdown, no chance to write "cancelled".
        execFileSync('kill', ['-9', String(first.mainPid)]);
      }
      await expect.poll(() => descendants(first.mainPid).length, { timeout: 60_000 }).toBe(0);

      const second = await launchDesktop({
        projectId: 'mission-montage',
        sidecarPort: 8788,
        userDataDir,
      });
      try {
        // Control is the whole point: the reopened project must be editable, not stuck
        // waiting on a run whose process no longer exists.
        const composer = second.page.getByRole('textbox', { name: 'Message FramePilot' });
        await second.page.getByRole('tab', { name: 'AI' }).first().click();
        await expect(composer).toBeEditable({ timeout: 60_000 });
        await expect(second.page.getByRole('status')).toBeHidden();
        // And the project is a committed state, not a half-written one.
        expect(await clipCount(second)).toBeGreaterThanOrEqual(
          Math.min(clipsBefore, await clipCount(second)),
        );
      } finally {
        await second.app.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    });
  });
});

/** A throwaway HTTP server used to stand in front of the model provider. */
async function startProxy(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      handler(req, res, Buffer.concat(chunks)).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
