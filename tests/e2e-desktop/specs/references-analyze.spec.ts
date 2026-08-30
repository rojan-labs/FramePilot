import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import { launchDesktop, FIXTURE_PROJECTS, REPO, type DesktopSession } from './launch.js';

/**
 * `POST /references/analyze` against the REAL reference fixtures, through the sidecar the
 * desktop app itself spawned (plan/system-mission P3.7, P3.3's "Done when").
 *
 * The engine's own unit test (`engine/python/tests/test_service_references.py`) covers the
 * route's contract with a synthetic PNG. What it cannot cover is the thing P3.3 promises:
 * that a real, multi-shot camera video is measured **once** — scene detection, beat
 * detection, silence and colour sampling all run, produce numbers an editor would
 * recognise, and never run a second time for the same bytes. That needs real media and a
 * real ffmpeg, so it lives here, in the lane where the maintainer's fixtures exist.
 *
 * The fixture is copied into the projects sandbox first, because the route (correctly)
 * refuses anything outside it — and the last row proves that refusal is still in force.
 */

const REF_DIR = join(REPO, 'tests', 'fixtures', 'mission', 'ref');
const SIDECAR_PORT = 8784;
/** Where the host copies attachments: inside the sandbox, beside the project's media. */
const SANDBOX_DIR = join(FIXTURE_PROJECTS, 'media', 'e2e-references');

interface AnalysisResponse {
  kind: 'video' | 'image';
  contentHash: string;
  cached: boolean;
  video?: Record<string, number | Record<string, unknown>>;
  image?: Record<string, unknown>;
}

/** The first reference video the fixtures provide, whatever it was named. */
function referenceVideo(): string | null {
  if (!existsSync(REF_DIR)) return null;
  const name = readdirSync(REF_DIR)
    .filter((f) => /\.(mp4|mov|m4v)$/i.test(f))
    .sort()[0];
  return name ? join(REF_DIR, name) : null;
}

function referenceImage(): string | null {
  if (!existsSync(REF_DIR)) return null;
  const name = readdirSync(REF_DIR)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort()[0];
  return name ? join(REF_DIR, name) : null;
}

let session: DesktopSession;

async function analyze(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${SIDECAR_PORT}/references/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Copy a fixture into the sandbox under a fresh name, so no earlier cache can answer. */
function stage(source: string, name: string): string {
  mkdirSync(SANDBOX_DIR, { recursive: true });
  const target = join(SANDBOX_DIR, name);
  rmSync(target, { force: true });
  rmSync(`${target}.reference.json`, { force: true });
  copyFileSync(source, target);
  return target;
}

test.describe('POST /references/analyze with the real fixtures', () => {
  test.skip(
    referenceVideo() === null,
    'reference fixtures absent (tests/fixtures/mission/fetch-fixtures.sh)',
  );

  test.beforeAll(async () => {
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
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
  });

  test('a real reference video is measured once and served from cache after', async () => {
    test.setTimeout(15 * 60_000);
    const staged = stage(referenceVideo()!, 'e2e-fast-cut.mp4');

    const firstAt = Date.now();
    const first = await analyze({ input_path: staged });
    expect(
      first.ok,
      `POST /references/analyze → ${first.status} ${await first.clone().text()}`,
    ).toBe(true);
    const measured = (await first.json()) as AnalysisResponse;
    const firstMs = Date.now() - firstAt;

    expect(measured.kind).toBe('video');
    expect(measured.cached).toBe(false);
    expect(measured.contentHash).toHaveLength(64);

    // The numbers the profile builder turns into constraint lines. Asserting they are
    // PRESENT and PLAUSIBLE — not their exact values, which are properties of the
    // maintainer's own footage — is what keeps this row honest on any fixture set.
    const video = measured.video ?? {};
    expect(Object.keys(video)).toEqual(
      expect.arrayContaining(['durationS', 'shotCount', 'cutsPerMinute']),
    );
    expect(video['durationS'] as number).toBeGreaterThan(1);
    expect(video['shotCount'] as number).toBeGreaterThanOrEqual(1);
    expect(video['cutsPerMinute'] as number).toBeGreaterThanOrEqual(0);
    expect(video['width'] as number).toBeGreaterThan(0);
    expect(video['height'] as number).toBeGreaterThan(0);
    // A reference the editor attached twice must not be re-measured; the cache is
    // written beside the file, keyed by content hash.
    expect(existsSync(`${staged}.reference.json`)).toBe(true);

    const secondAt = Date.now();
    const second = (await (await analyze({ input_path: staged })).json()) as AnalysisResponse;
    const secondMs = Date.now() - secondAt;
    expect(second.cached).toBe(true);
    expect(second.contentHash).toBe(measured.contentHash);
    expect(second.video).toEqual(measured.video);
    // The point of the cache is cost, so assert cost: the second answer is a file read,
    // and a file read cannot take as long as scene + beat + colour analysis of real video.
    expect(secondMs, `first ${firstMs}ms, second ${secondMs}ms`).toBeLessThan(
      Math.max(firstMs / 2, 1_000),
    );

    // `refresh` is what the sidebar's "Re-analyze" sends; it must bypass the cache.
    const refreshed = (await (
      await analyze({ input_path: staged, refresh: true })
    ).json()) as AnalysisResponse;
    expect(refreshed.cached).toBe(false);
    expect(refreshed.contentHash).toBe(measured.contentHash);
  });

  test('a real reference image is measured for the fields the role classifier reads', async () => {
    const source = referenceImage();
    test.skip(source === null, 'no reference image fixture in tests/fixtures/mission/ref');
    test.setTimeout(5 * 60_000);
    const staged = stage(source!, `e2e-ref-image${source!.slice(source!.lastIndexOf('.'))}`);

    const measured = (await (await analyze({ input_path: staged })).json()) as AnalysisResponse;
    expect(measured.kind).toBe('image');
    // `hasAlpha` and the dimensions are exactly the deterministic signals P3.2 classifies
    // a logo from; if the route stops reporting them, role detection silently degrades to
    // "ambiguous" for every image.
    expect(Object.keys(measured.image ?? {})).toEqual(
      expect.arrayContaining(['width', 'height', 'hasAlpha']),
    );
    expect(measured.image!['width'] as number).toBeGreaterThan(0);
  });

  test('a reference outside the sandbox is refused, and a missing one is a 404', async () => {
    const outside = await analyze({ input_path: '/etc/hosts' });
    expect([400, 403, 422]).toContain(outside.status);
    const missing = await analyze({ input_path: join(SANDBOX_DIR, 'nope.png') });
    expect(missing.status).toBe(404);
  });
});
