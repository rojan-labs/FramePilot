/**
 * PX4 — the preview/export pixel parity oracle (plan
 * `plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md`, "PX4 — the pixel parity oracle"),
 * plus PX0.3's colour-conversion measurement.
 *
 * For every frame-plan matrix case (`tests/fixtures/frame-plan/*.json`) and every sample time,
 * this loads the case into the real editor, seeks the WebCodecs program monitor, waits for the
 * presented frame, reads the canvas back and compares it with the export's frame at the same
 * time and resolution (`render/frame_grab.py`, lossless mode). Four checks per case:
 *
 *  - `renderer`  the desktop program monitor is the WebCodecs canvas. A case the gates route to
 *                the DOM `PreviewPlayer` fails here as `renderer: DOM` and cannot be read back,
 *                so its other checks fail with the same reason. Nothing is skipped.
 *  - `pixels`    PSNR >= 40 dB over the whole frame AND max per-channel error <= 8/255 on
 *                >= 99.5% of pixels.
 *  - `sentinel`  every synthetic asset is a flat sentinel colour (two shades), so a missing,
 *                extra or misordered layer changes which sentinels are visible. Exact: the
 *                sets must match and no pixel that is solidly one sentinel in both frames may
 *                be a different sentinel.
 *  - `pts`       the preview's own report of the source frame it drew per picture layer
 *                (`WebCodecsPreviewEngine.debugPresentedFrame`) equals the frame plan's, in
 *                back-to-front order. Off-by-one is a failure, not a tolerance.
 *
 * Thresholds are the plan's initial gates. They are tightened as fixes land, never loosened.
 * CPU GL (SwiftShader) is allowed on CI with the SAME thresholds.
 *
 * Known failures are listed in `tests/e2e/fixtures/preview-parity-baseline.json` and marked
 * `test.fail()` per case and check: CI stays green while the list is honest, and a listed
 * check that starts PASSING fails the run ("expected to fail, but passed"), which forces the
 * list to shrink. A new failure is never listed automatically.
 *
 * **CI ONLY. Do not run this spec, or a full `pnpm px4:frames`, on a workstation.** A local run
 * (4 render workers holding a composition per clip, next to Chromium) once took a maintainer's
 * machine past 70 GB and shut it down. The job `preview-parity-oracle` in `.github/workflows/ci.yml`
 * runs it and uploads the results; the baseline is regenerated from that artifact
 * (`gh run download`, then `node tests/e2e/scripts/px4-baseline.mjs --write-baseline`). To debug
 * ONE failing case locally, render just that case with a memory cap and grep the spec to it:
 *
 *   pnpm px4:frames --case layering/layers-2 --max-rss-mb 4000
 *   pnpm --filter @framepilot/e2e exec playwright test --project=preview-parity \
 *     specs/preview-parity-oracle.spec.ts --grep 'layering/layers-2'
 *
 * Bounded by design: the `preview-parity` project runs with one worker; the file uses one page
 * for every case (parked on a blank document between cases so the previous editor's decoders,
 * frames and audio context are released); engine PNGs are fetched and decoded one sample at a
 * time and closed; image artifacts are built only for failing samples (at most
 * MAX_ATTACHED_SAMPLES_PER_CASE per case); each case has caseTimeoutMs(samples).
 *
 * Inputs are generated before this runs (`pnpm px4:frames`): synthetic media both sides read
 * (so codec loss is identical), the engine frames and a manifest. The media are served to the
 * page from the app's own origin (so canvases are never cross-origin tainted), like
 * `preview-webcodecs-p3.spec.ts` serves its fixture. Per-case results land in
 * `.tmp-px4-parity/results/` for `scripts/px4-baseline.mjs`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { seekAndCompare, type PageCompare, type Rgb } from './parity-compare.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const FIXTURE_DIR = join(REPO, 'tests', 'fixtures', 'frame-plan');
const OUT_DIR = join(REPO, 'tests', 'e2e', '.tmp-px4-parity');
const RESULTS_DIR = join(OUT_DIR, 'results');
const BASELINE_PATH = join(HERE, '..', 'fixtures', 'preview-parity-baseline.json');
/** Must equal `MANIFEST_VERSION` in `engine/python/tests/px4_parity_frames.py`. */
const MANIFEST_VERSION = 3;
const MEDIA_PREFIX = '/__px4-media/';
/**
 * The engine sidecar the desktop monitor would reach through its bridge for text rasters
 * (PX2.3). CI starts one and sets this; the page gets a stand-in for the bridge method that
 * forwards to it. Unset, text renders through the browser fallback.
 */
const SIDECAR_URL = process.env.PX4_SIDECAR_URL ?? '';

// --- gates (09-PREVIEW-EXPORT-PARITY.md, PX4). Tighten only. ---------------------------------
const PSNR_MIN_DB = 40;
const CHANNEL_TOLERANCE = 8;
const WITHIN_TOLERANCE_MIN_FRACTION = 0.995;
/** A pixel "is" a sentinel within this Chebyshev distance. Sentinels are >= 96 apart. */
const SENTINEL_RADIUS = 40;
/** A sentinel is "visible" when at least this many of its pixels are solidly it (3x3). */
const SENTINEL_MIN_PIXELS = 64;
/** PX0.3: preview RGB vs engine RGB per patch, per channel. The same 8/255 as the pixel gate. */
const COLOUR_TOLERANCE = CHANNEL_TOLERANCE;
/** The in-page pass's per-pixel thresholds, from the gates above. */
const COMPARE_GATES = { channelTolerance: CHANNEL_TOLERANCE, sentinelRadius: SENTINEL_RADIUS };
/** Failing samples per case that get preview/engine/diff PNGs attached (report size bound). */
const MAX_ATTACHED_SAMPLES_PER_CASE = 3;
/**
 * Per-case budget (hook + checks): six minutes, plus fifteen seconds per sample beyond 24. Not a
 * parity gate: every effect kind (41 samples) composites the export's own blurs on CPU GL and
 * outgrew a flat six minutes.
 */
const CASE_TIMEOUT_BASE_MS = 6 * 60_000;
/** Software-GL frame effects on the CI runner took over 17 s a sample (effect-kinds timed out). */
const CASE_TIMEOUT_PER_SAMPLE_MS = 25_000;
const caseTimeoutMs = (samples: number): number =>
  Math.max(CASE_TIMEOUT_BASE_MS, samples * CASE_TIMEOUT_PER_SAMPLE_MS);

const CHECKS = ['renderer', 'pixels', 'sentinel', 'pts'] as const;
type Check = (typeof CHECKS)[number];
const COLOUR_PATHS = ['canvas2d', 'webgl'] as const;
type ColourPath = (typeof COLOUR_PATHS)[number];

interface PlanLayer {
  kind: string;
  role: string;
  source: { assetId: string; assetKind: string; time: number; frame: number | null } | null;
}
interface FramePlan {
  time: number;
  width: number;
  height: number;
  background: Rgb;
  layers: PlanLayer[];
}
interface Asset {
  id: string;
  path: string;
  kind: string;
  durationSeconds?: number;
  media?: {
    width?: number;
    height?: number;
    proxyPath?: string | null;
    pixelAspectRatio?: number;
    rotation?: number;
  };
}
interface MatrixCase {
  id: string;
  row: string;
  probe: { fps: Record<string, number> };
  burnCaptions: boolean;
  project: { name: string; id: string; assets: Asset[] } & Record<string, unknown>;
  samples: number[];
  expected: FramePlan[];
}
interface ManifestSample {
  time: number;
  frame: string | null;
  error: string | null;
}
interface Manifest {
  version: number;
  inputHash: string;
  sentinels: Record<string, { primary: Rgb; secondary: Rgb }>;
  cases: { area: string; id: string; samples: ManifestSample[] }[];
  mattes?: Record<string, ManifestMatte>;
  colour: {
    time: number;
    patches: { name: string; authored: Rgb; box: [number, number, number, number] }[];
    encodings: Record<
      string,
      { matrix: string; range: string; tag: string; project: MatrixCase['project']; engine: Rgb[] }
    >;
  };
}
/** A matte artifact the preview reads (BR5): where it is served and what the mask pins. */
interface ManifestMatte {
  root: string;
  artifact: Record<string, unknown>;
  processedSourceFrames?: [number, number];
  /** PX5.3: where the artifact's monitor tier is served from, when the generator made one. */
  tierRoot?: string;
}
interface Baseline {
  cases: Record<string, Check[]>;
  colour: Record<string, ColourPath[]>;
}

interface SampleResult {
  time: number;
  psnr: number | null;
  withinFraction: number | null;
  maxChannelError: number | null;
  sentinel: {
    engine: Record<string, number>;
    preview: Record<string, number>;
    disagreements: number;
  } | null;
  expectedPts: string[];
  presentedPts: string[] | null;
  failures: Partial<Record<Check, string>>;
  /** Readback facts recorded for a far-off sample (diagnosis only, never a verdict). */
  diagnostic?: Record<string, unknown>;
  /**
   * PX5.3: per matte layer of the presented frame, the tier the artifact has and whether this
   * frame's decontamination came from it: which path the pixels judged. Fact, not a verdict.
   */
  mattes?: { tier: string | null; fromTier: boolean; alphaFromTier: boolean; state: string }[];
}
interface CaseResult {
  key: string;
  row: string;
  renderer: 'webcodecs' | 'dom' | 'error';
  rendererDetail: string | null;
  samples: SampleResult[];
}

// --- inputs ------------------------------------------------------------------------------------

/** Same digest as `input_hash()` in the generator: version, then each fixture's name + bytes. */
function fixtureHash(): string {
  const digest = createHash('sha256');
  digest.update(`v${MANIFEST_VERSION}`);
  for (const name of readdirSync(FIXTURE_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    digest.update(name);
    digest.update(readFileSync(join(FIXTURE_DIR, name)));
  }
  return digest.digest('hex');
}

function loadManifest(): Manifest {
  const path = join(OUT_DIR, 'manifest.json');
  if (!existsSync(path)) {
    throw new Error(`No PX4 engine output at ${path}. Run \`pnpm px4:frames\` first.`);
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (manifest.version !== MANIFEST_VERSION || manifest.inputHash !== fixtureHash()) {
    throw new Error(`PX4 engine output at ${OUT_DIR} is stale. Re-run \`pnpm px4:frames\`.`);
  }
  return manifest;
}

function loadCases(): { area: string; kase: MatrixCase }[] {
  const cases = readdirSync(FIXTURE_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const doc = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as {
        cases: MatrixCase[];
      };
      return doc.cases.map((kase) => ({ area: name.replace(/\.json$/, ''), kase }));
    });
  separateMediaVariants(cases);
  return cases;
}

/**
 * Give a case its own media file when it describes a shared path with different facts (frame
 * rate, duration, size, pixel aspect, rotation): `proxies/land.2.mp4`, in encounter order.
 * Mirrors `_separate_media_variants` in `px4_parity_frames.py`; both sides read the same bytes.
 */
function separateMediaVariants(cases: { kase: MatrixCase }[]): void {
  const variants = new Map<string, string[]>();
  for (const { kase } of cases) {
    for (const asset of kase.project.assets) {
      if (asset.kind !== 'video') continue;
      const rel = mediaPathOf(asset);
      const facts = JSON.stringify([
        Number(asset.media?.width ?? 0),
        Number(asset.media?.height ?? 0),
        Number(kase.probe.fps[asset.id] ?? 0),
        Number(asset.durationSeconds || 10),
        Number(asset.media?.pixelAspectRatio || 1),
        Number(asset.media?.rotation || 0),
      ]);
      const known = variants.get(rel) ?? [];
      variants.set(rel, known);
      if (!known.includes(facts)) known.push(facts);
      const index = known.indexOf(facts);
      if (index === 0) continue;
      const dot = rel.lastIndexOf('.');
      const variant =
        dot > rel.lastIndexOf('/')
          ? `${rel.slice(0, dot)}.${index + 1}${rel.slice(dot)}`
          : `${rel}.${index + 1}`;
      if (asset.media?.proxyPath) asset.media.proxyPath = variant;
      else asset.path = variant;
    }
  }
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
const manifest = existsSync(join(OUT_DIR, 'manifest.json')) ? loadManifest() : null;

/** The file both sides read: the proxy when there is one (the generator's `engine_asset_path`). */
function mediaPathOf(asset: Asset): string {
  const proxy = asset.media?.proxyPath;
  return proxy ? proxy : asset.path;
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.cube': 'text/plain',
  '.json': 'application/json',
  '.mkv': 'video/x-matroska',
};

/** Blank same-origin document the page parks on between cases (see {@link openInEditor}). */
const BLANK_PAGE = `${MEDIA_PREFIX}blank.html`;

/**
 * The ONE page this file uses (memory bound): created on first use per worker, reused for every
 * case, closed in the file's `afterAll`. A page per case would keep a renderer process, a GPU
 * context and every decoder per case alive until Playwright got round to closing them.
 */
let sharedPage: Page | null = null;

async function oraclePage(browser: Browser): Promise<Page> {
  if (sharedPage !== null && !sharedPage.isClosed()) return sharedPage;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route(`**${MEDIA_PREFIX}**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === BLANK_PAGE) {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>px4</title>' });
    }
    const file = join(OUT_DIR, decodeURIComponent(pathname.slice(MEDIA_PREFIX.length)));
    if (!file.startsWith(OUT_DIR) || !existsSync(file)) return route.fulfill({ status: 404 });
    // Served by path: Playwright streams the file, nothing is buffered here.
    return route.fulfill({
      path: file,
      headers: { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' },
    });
  });
  // The desktop monitor reads matte artifacts from the project folder over fp-media (BR5); here
  // they are served from the generated output. The directory per key comes from the manifest
  // (a progressive job's preview copy lives apart from the export's whole artifact).
  await page.addInitScript((prefix: string) => {
    const host = window as unknown as {
      __fpMatteArtifactUrl: (key: string, name: string) => string | null;
    };
    host.__fpMatteArtifactUrl = (key, name) => {
      let roots: Record<string, string> = {};
      try {
        roots = JSON.parse(localStorage.getItem('px4:matte-roots') ?? '{}') as Record<
          string,
          string
        >;
      } catch {
        roots = {};
      }
      const root = roots[key];
      return root === undefined ? null : `${location.origin}${prefix}${root}/${key}/${name}`;
    };
    // PX5.3: the monitor tier beside each artifact, as the desktop reads it from the project.
    (
      host as unknown as { __fpMatteTierUrl: (key: string, name: string) => string | null }
    ).__fpMatteTierUrl = (key, name) => {
      let roots: Record<string, string> = {};
      try {
        roots = JSON.parse(localStorage.getItem('px4:matte-tier-roots') ?? '{}') as Record<
          string,
          string
        >;
      } catch {
        roots = {};
      }
      const root = roots[key];
      return root === undefined ? null : `${location.origin}${prefix}${root}/${key}/${name}`;
    };
  }, MEDIA_PREFIX);
  if (SIDECAR_URL) {
    // Node-side forwarding: the page never talks to the sidecar directly, as on the desktop.
    await page.exposeFunction('__fpSidecarTextRaster', async (req: Record<string, unknown>) => {
      const response = await fetch(`${SIDECAR_URL}/preview/text-raster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: req.kind,
          ...(req.kind === 'text' ? { params: req.params } : { text: req.text }),
          frame_width: req.frameWidth,
          frame_height: req.frameHeight,
        }),
      });
      if (!response.ok) return { ok: false, error: `sidecar ${response.status}` };
      return { ok: true, ...(await response.json()) };
    });
    await page.addInitScript(() => {
      type Wire = {
        ok: boolean;
        error?: string;
        width: number;
        height: number;
        rgba_base64: string;
        x: number | null;
        y: number | null;
      };
      const host = window as unknown as {
        __fpSidecarTextRaster: (req: unknown) => Promise<Wire>;
        __fpTextRasterSource: (req: unknown) => Promise<unknown>;
      };
      host.__fpTextRasterSource = async (req) => {
        const wire = await host.__fpSidecarTextRaster(req);
        if (!wire.ok) return { ok: false, error: wire.error ?? 'refused' };
        const binary = atob(wire.rgba_base64);
        const rgba = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) rgba[i] = binary.charCodeAt(i);
        return { ok: true, width: wire.width, height: wire.height, rgba, x: wire.x, y: wire.y };
      };
    });
  }
  sharedPage = page;
  return page;
}

/**
 * Open `project` in the editor on the shared page, serving the generated media from the app's
 * own origin (so canvases are never cross-origin tainted).
 *
 * The page first navigates to a blank same-origin document: unloading the previous editor
 * disposes its engine, and with it every decoder, held `VideoFrame` and `AudioContext`, before
 * the next case allocates its own.
 */
async function openInEditor(
  page: Page,
  project: MatrixCase['project'],
  burnCaptions = false,
  mattes: Record<string, ManifestMatte> = {},
): Promise<string> {
  const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:5173').origin;
  const doc = JSON.parse(JSON.stringify(project)) as MatrixCase['project'];
  // Pin the artifacts the generator actually wrote (real digests, coverage), as a real job does.
  const matteRoots: Record<string, string> = {};
  const tierRoots: Record<string, string> = {};
  const docTimeline = (
    doc as { timeline?: { tracks?: { clips?: { masks?: Record<string, unknown>[] }[] }[] } }
  ).timeline;
  for (const track of docTimeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      for (const mask of clip.masks ?? []) {
        if (mask.kind !== 'matte') continue;
        const artifact = mask.artifact as Record<string, unknown>;
        const served = mattes[String(artifact.key)];
        if (served === undefined) continue;
        Object.assign(artifact, served.artifact);
        matteRoots[String(artifact.key)] = served.root;
        if (served.tierRoot !== undefined) tierRoots[String(artifact.key)] = served.tierRoot;
      }
    }
  }
  for (const asset of doc.assets) {
    const url = `${origin}${MEDIA_PREFIX}${mediaPathOf(asset)}`;
    if (asset.media?.proxyPath) asset.media.proxyPath = url;
    asset.path = url;
  }
  // A `.cube` LUT is project-relative media too: serve it from the same origin.
  const timeline = (
    doc as {
      timeline?: {
        tracks?: { clips?: { effects?: { type: string; params: Record<string, unknown> }[] }[] }[];
      };
    }
  ).timeline;
  for (const track of timeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      for (const effect of clip.effects ?? []) {
        if (effect.type === 'lut' && typeof effect.params.path === 'string') {
          effect.params.path = `${origin}${MEDIA_PREFIX}${effect.params.path}`;
        }
      }
    }
  }
  await page.goto(`${origin}${BLANK_PAGE}`);
  await page.evaluate(
    ({ p, burn, roots, tiers }) => {
      localStorage.clear();
      localStorage.setItem(`framepilot:project:${(p as { id: string }).id}`, JSON.stringify(p));
      localStorage.setItem('framepilot:last-project-id', (p as { id: string }).id);
      localStorage.setItem('px4:matte-roots', JSON.stringify(roots));
      localStorage.setItem('px4:matte-tier-roots', JSON.stringify(tiers));
      // The monitor burns captions in exactly when the case's export does.
      localStorage.setItem('framepilot.settings', JSON.stringify({ previewBurnCaptions: burn }));
    },
    { p: doc, burn: burnCaptions, roots: matteRoots, tiers: tierRoots },
  );
  await page.goto(`${origin}/`);
  await expect(page.getByLabel('project name')).toHaveText(project.name, { timeout: 30_000 });
  await expect(page.locator('.preview-frame').first()).toBeVisible({ timeout: 30_000 });
  return origin;
}

/** Which program monitor mounted, and (for WebCodecs) wait until its first load presented. */
async function waitForRenderer(
  page: Page,
): Promise<{ renderer: CaseResult['renderer']; detail: string | null }> {
  if ((await page.locator('.webcodecs-preview').count()) === 0) {
    return { renderer: 'dom', detail: 'desktop program monitor mounted the DOM PreviewPlayer' };
  }
  try {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const engine = (
              window as unknown as { __fpPreviewEngine?: { debugStats(): Record<string, number> } }
            ).__fpPreviewEngine;
            return engine ? engine.debugStats().segCount : 0;
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  } catch {
    return { renderer: 'error', detail: 'WebCodecs engine never loaded its segments' };
  }
  const error = page.locator('.webcodecs-preview-error');
  if ((await error.count()) > 0) {
    return {
      renderer: 'error',
      detail: `WebCodecs preview error: ${await error.first().textContent()}`,
    };
  }
  return { renderer: 'webcodecs', detail: null };
}

// --- verdicts ------------------------------------------------------------------------------------

function sentinelPalette(m: Manifest): { name: string; rgb: Rgb }[] {
  return Object.entries(m.sentinels).flatMap(([asset, { primary, secondary }]) => [
    { name: `${asset}/primary`, rgb: primary },
    { name: `${asset}/secondary`, rgb: secondary },
  ]);
}

function visible(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .filter(([, pixels]) => pixels >= SENTINEL_MIN_PIXELS)
    .map(([name]) => name)
    .sort();
}

/** `asset@frame` (video) / `asset@still` (image) per plan picture layer, back to front. */
function expectedPts(plan: FramePlan): string[] {
  return plan.layers
    .filter((layer) => layer.kind === 'picture' && layer.source !== null)
    .map((layer) =>
      layer.source!.assetKind === 'video'
        ? `${layer.source!.assetId}@${layer.source!.frame}`
        : `${layer.source!.assetId}@still`,
    );
}

function presentedPts(
  presented: NonNullable<PageCompare['presented']>,
  fps: Record<string, number>,
): string[] {
  return presented.layers.map((layer) => {
    const id = layer.sourceId ?? '?';
    if (layer.kind !== 'video' || layer.timestampUs === null) return `${id}@still`;
    const rate = fps[id];
    return rate === undefined
      ? `${id}@?${layer.timestampUs}us`
      : `${id}@${Math.round((layer.timestampUs * rate) / 1e6)}`;
  });
}

async function measureCase(
  browser: Browser,
  area: string,
  kase: MatrixCase,
  m: Manifest,
  testInfo: TestInfo,
): Promise<CaseResult> {
  const key = `${area}/${kase.id}`;
  const entry = m.cases.find((c) => c.area === area && c.id === kase.id);
  if (!entry) throw new Error(`Manifest has no case ${key}; re-run pnpm px4:frames`);
  const result: CaseResult = {
    key,
    row: kase.row,
    renderer: 'error',
    rendererDetail: null,
    samples: [],
  };
  const page = await oraclePage(browser);
  let attachedSamples = 0;
  try {
    const origin = await openInEditor(page, kase.project, kase.burnCaptions, m.mattes ?? {});
    const { renderer, detail } = await waitForRenderer(page);
    result.renderer = renderer;
    result.rendererDetail = detail;
    const palette = sentinelPalette(m);
    for (const [index, time] of kase.samples.entries()) {
      const plan = kase.expected[index]!;
      const engineSample = entry.samples[index]!;
      const sample: SampleResult = {
        time,
        psnr: null,
        withinFraction: null,
        maxChannelError: null,
        sentinel: null,
        expectedPts: expectedPts(plan),
        presentedPts: null,
        failures: {},
      };
      result.samples.push(sample);
      if (renderer !== 'webcodecs') {
        const reason = renderer === 'dom' ? 'renderer: DOM (not read back)' : `renderer: ${detail}`;
        for (const check of CHECKS) sample.failures[check] = reason;
        continue;
      }
      const compareArgs = {
        time,
        background: plan.background,
        engineUrl: engineSample.frame ? `${origin}${MEDIA_PREFIX}${engineSample.frame}` : null,
        palette,
        wantImages: false,
      };
      // Metrics only: the preview/diff PNGs are built on a second pass for failing samples.
      const compared = await seekAndCompare(page, compareArgs, COMPARE_GATES);
      if (compared.presented === null) {
        const reason = 'preview never presented this time (seek superseded or no frame decoded)';
        sample.failures.pixels = reason;
        sample.failures.sentinel = reason;
        sample.failures.pts = reason;
        continue;
      }
      sample.presentedPts = presentedPts(compared.presented, kase.probe.fps);
      if (Object.keys(m.mattes ?? {}).length > 0) {
        sample.mattes = await page.evaluate(() =>
          (
            (
              window as unknown as {
                __fpPreviewEngine?: {
                  debugPresentedMattes?: () => {
                    tier?: string | null;
                    fromTier?: boolean;
                    alphaFromTier?: boolean;
                    state: string;
                  }[];
                };
              }
            ).__fpPreviewEngine?.debugPresentedMattes?.() ?? []
          ).map(({ tier, fromTier, alphaFromTier, state }) => ({
            tier: tier ?? null,
            fromTier: fromTier ?? false,
            // PX5.8: whether the alpha was drawn from the tier's alpha plane.
            alphaFromTier: alphaFromTier ?? false,
            state,
          })),
        );
      }
      if (JSON.stringify(sample.presentedPts) !== JSON.stringify(sample.expectedPts)) {
        sample.failures.pts = `presented [${sample.presentedPts.join(', ')}] != plan [${sample.expectedPts.join(', ')}]`;
      }
      if (engineSample.error) {
        sample.failures.pixels = `engine: ${engineSample.error}`;
        sample.failures.sentinel = `engine: ${engineSample.error}`;
      } else if (compared.psnr === null) {
        const reason = `size: preview ${compared.width}x${compared.height} != engine ${compared.engineWidth}x${compared.engineHeight}`;
        sample.failures.pixels = reason;
        sample.failures.sentinel = reason;
      } else {
        sample.psnr = compared.psnr;
        sample.withinFraction = compared.withinFraction;
        sample.maxChannelError = compared.maxChannelError;
        if (compared.diagnostic) sample.diagnostic = compared.diagnostic;
        sample.sentinel = compared.sentinel;
        if (
          compared.psnr < PSNR_MIN_DB ||
          compared.withinFraction! < WITHIN_TOLERANCE_MIN_FRACTION
        ) {
          sample.failures.pixels = `PSNR ${compared.psnr.toFixed(2)} dB (min ${PSNR_MIN_DB}), ${(compared.withinFraction! * 100).toFixed(3)}% within ${CHANNEL_TOLERANCE}/255 (min ${WITHIN_TOLERANCE_MIN_FRACTION * 100}%)`;
        }
        const s = compared.sentinel!;
        const engineVisible = visible(s.engine);
        const previewVisible = visible(s.preview);
        const missing = engineVisible.filter((name) => !previewVisible.includes(name));
        const extra = previewVisible.filter((name) => !engineVisible.includes(name));
        if (missing.length || extra.length || s.disagreements > 0) {
          sample.failures.sentinel = [
            missing.length ? `missing [${missing.join(', ')}]` : '',
            extra.length ? `extra [${extra.join(', ')}]` : '',
            s.disagreements > 0 ? `${s.disagreements} px show a different layer` : '',
          ]
            .filter(Boolean)
            .join('; ');
        }
      }
      if (
        (sample.failures.pixels || sample.failures.sentinel) &&
        attachedSamples < MAX_ATTACHED_SAMPLES_PER_CASE
      ) {
        attachedSamples++;
        const label = `${area}-${kase.id}-t${time}`;
        const images = await seekAndCompare(
          page,
          { ...compareArgs, wantImages: true },
          COMPARE_GATES,
        );
        compared.previewPng = images.previewPng;
        compared.diffPng = images.diffPng;
        if (compared.previewPng) {
          await testInfo.attach(`${label}-preview.png`, {
            body: Buffer.from(compared.previewPng, 'base64'),
            contentType: 'image/png',
          });
        }
        if (engineSample.frame) {
          await testInfo.attach(`${label}-engine.png`, {
            path: join(OUT_DIR, engineSample.frame),
            contentType: 'image/png',
          });
        }
        if (compared.diffPng) {
          await testInfo.attach(`${label}-diff.png`, {
            body: Buffer.from(compared.diffPng, 'base64'),
            contentType: 'image/png',
          });
        }
      }
    }
  } catch (error) {
    result.renderer = result.renderer === 'dom' ? 'dom' : 'error';
    result.rendererDetail = `harness: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    for (const sample of result.samples)
      for (const check of CHECKS) sample.failures[check] ??= result.rendererDetail;
    if (result.samples.length === 0) {
      result.samples.push({
        time: Number.NaN,
        psnr: null,
        withinFraction: null,
        maxChannelError: null,
        sentinel: null,
        expectedPts: [],
        presentedPts: null,
        failures: Object.fromEntries(CHECKS.map((c) => [c, result.rendererDetail!])),
      });
    }
  }
  if (result.renderer !== 'webcodecs') {
    result.samples[0]!.failures.renderer ??= result.rendererDetail ?? 'renderer: DOM';
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    join(RESULTS_DIR, `${area}__${kase.id}.json`),
    `${JSON.stringify(result, (_key, value: unknown) => (value === Number.POSITIVE_INFINITY ? 'Infinity' : value), 2)}\n`,
  );
  return result;
}

function failuresOf(result: CaseResult, check: Check): string[] {
  return result.samples
    .filter((sample) => sample.failures[check])
    .map((sample) => `t=${sample.time}: ${sample.failures[check]}`);
}

// --- the matrix ------------------------------------------------------------------------------------

test.afterAll(async () => {
  await sharedPage?.close();
  sharedPage = null;
});

test.describe('PX4 preview/export parity oracle', () => {
  test('engine output is present and current, and the sentinel palette is separable', () => {
    expect(manifest, 'run `pnpm px4:frames` before this spec').not.toBeNull();
    const palette = sentinelPalette(manifest!);
    for (const [i, a] of palette.entries()) {
      for (const b of palette.slice(i + 1)) {
        const distance = Math.max(...a.rgb.map((v, c) => Math.abs(v - b.rgb[c]!)));
        // Two classes within 2x the radius could both claim one pixel.
        expect(distance, `${a.name} vs ${b.name}`).toBeGreaterThan(2 * SENTINEL_RADIUS);
      }
    }
    const listed = Object.keys(baseline.cases);
    const known = new Set(loadCases().map(({ area, kase }) => `${area}/${kase.id}`));
    expect(
      listed.filter((key) => !known.has(key)),
      'baseline lists cases that no longer exist',
    ).toEqual([]);
  });

  for (const { area, kase } of loadCases()) {
    const key = `${area}/${kase.id}`;
    test.describe(key, () => {
      test.describe.configure({ mode: 'serial', timeout: caseTimeoutMs(kase.samples.length) });
      let result: CaseResult | null = null;

      test.beforeAll(async ({ browser }, testInfo) => {
        if (manifest === null) return;
        // A hook does not inherit `describe.configure({ timeout })` everywhere; set it here.
        testInfo.setTimeout(caseTimeoutMs(kase.samples.length));
        result = await measureCase(browser, area, kase, manifest, testInfo);
      });

      for (const check of CHECKS) {
        test(check, async () => {
          if ((baseline.cases[key] ?? []).includes(check)) test.fail();
          expect(result, 'run `pnpm px4:frames` before this spec').not.toBeNull();
          expect(failuresOf(result!, check), `${key} ${check} (${kase.row})`).toEqual([]);
        });
      }
    });
  }
});

// --- PX0.3: Chromium VideoFrame -> texture colour vs the engine's YUV -> RGB -------------------------

interface ColourMeasurement {
  encoding: string;
  matrix: string;
  range: string;
  chromiumColorSpace: Record<string, unknown> | null;
  canvas2d: Rgb[] | null;
  webgl: Rgb[] | null;
  engine: Rgb[];
  error: string | null;
}

test.describe('PX0.3 colour conversion (BT.601/709 x limited/full)', () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });
  const measurements = new Map<string, ColourMeasurement>();

  test.beforeAll(async ({ browser }) => {
    if (manifest === null) return;
    const { colour } = manifest;
    for (const [encoding, facts] of Object.entries(colour.encodings)) {
      const measurement: ColourMeasurement = {
        encoding,
        matrix: facts.matrix,
        range: facts.range,
        chromiumColorSpace: null,
        canvas2d: null,
        webgl: null,
        engine: facts.engine,
        error: null,
      };
      measurements.set(encoding, measurement);
      const page = await oraclePage(browser);
      try {
        const origin = await openInEditor(page, facts.project);
        const { renderer, detail } = await waitForRenderer(page);
        const boxes = colour.patches.map((patch) => patch.box);
        if (renderer === 'webcodecs') {
          measurement.canvas2d = await page.evaluate(
            async ({ time, boxes }) => {
              const engine = (
                window as unknown as {
                  __fpPreviewEngine: {
                    seek(t: number): Promise<void>;
                    debugPresentedFrame(): { projectTimeSec: number; layers: unknown[] };
                  };
                }
              ).__fpPreviewEngine;
              // Same rule as the matrix: read only a frame the engine reports it presented for
              // this time. Reading right after the load once returned a still-blank canvas.
              let presented = false;
              for (let attempt = 0; attempt < 8 && !presented; attempt++) {
                await engine.seek(time);
                const now = engine.debugPresentedFrame();
                presented = Math.abs(now.projectTimeSec - time) < 1e-9 && now.layers.length > 0;
                if (!presented) await new Promise((resolve) => setTimeout(resolve, 150));
              }
              if (!presented) return null;
              const canvas = document.querySelector<HTMLCanvasElement>(
                '.webcodecs-preview-canvas',
              )!;
              const ctx = canvas.getContext('2d')!;
              return boxes.map(([x, y, w, h]) => {
                const data = ctx.getImageData(x + w / 4, y + h / 4, w / 2, h / 2).data;
                const sum = [0, 0, 0];
                for (let i = 0; i < data.length; i += 4)
                  for (let c = 0; c < 3; c++) sum[c]! += data[i + c]!;
                return sum.map((v) => Math.round((v / (data.length / 4)) * 1000) / 1000) as [
                  number,
                  number,
                  number,
                ];
              });
            },
            { time: colour.time, boxes },
          );
        } else {
          measurement.error = `canvas2d: ${detail ?? renderer}`;
        }
        if (renderer === 'webcodecs' && measurement.canvas2d === null) {
          measurement.error = 'canvas2d: the preview never presented the sample time';
        }
        const url = `${origin}${MEDIA_PREFIX}${facts.project.assets[0]!.path}`;
        const gl = await page.evaluate(
          async ({ url, time, boxes }) => {
            const video = document.createElement('video');
            video.muted = true;
            video.src = url;
            await new Promise<void>((resolve, reject) => {
              video.onloadeddata = () => resolve();
              video.onerror = () => reject(new Error(`video element could not load ${url}`));
            });
            video.currentTime = time;
            await new Promise<void>((resolve) => (video.onseeked = () => resolve()));
            const frame = new VideoFrame(video, { timestamp: Math.round(time * 1e6) });
            const colorSpace = frame.colorSpace.toJSON() as Record<string, unknown>;
            const width = frame.displayWidth;
            const height = frame.displayHeight;
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('webgl2');
            if (!context) {
              frame.close();
              return { colorSpace, patches: null, renderer: 'no webgl2' };
            }
            const texture = context.createTexture();
            context.bindTexture(context.TEXTURE_2D, texture);
            context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
            context.texImage2D(
              context.TEXTURE_2D,
              0,
              context.RGBA,
              context.RGBA,
              context.UNSIGNED_BYTE,
              frame,
            );
            frame.close();
            const framebuffer = context.createFramebuffer();
            context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
            context.framebufferTexture2D(
              context.FRAMEBUFFER,
              context.COLOR_ATTACHMENT0,
              context.TEXTURE_2D,
              texture,
              0,
            );
            const pixels = new Uint8Array(width * height * 4);
            context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
            const debug = context.getExtension('WEBGL_debug_renderer_info');
            const renderer = debug
              ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL))
              : 'unknown';
            // The framebuffer is a texture: row 0 is the texture's first row, the image's top.
            const patches = boxes.map(([x, y, w, h]) => {
              const sum = [0, 0, 0];
              let count = 0;
              for (let yy = y + h / 4; yy < y + (3 * h) / 4; yy++) {
                for (let xx = x + w / 4; xx < x + (3 * w) / 4; xx++) {
                  const i = (yy * width + xx) * 4;
                  for (let c = 0; c < 3; c++) sum[c]! += pixels[i + c]!;
                  count++;
                }
              }
              return sum.map((v) => Math.round((v / count) * 1000) / 1000) as [
                number,
                number,
                number,
              ];
            });
            context.getExtension('WEBGL_lose_context')?.loseContext();
            video.removeAttribute('src');
            video.load();
            return { colorSpace, patches, renderer };
          },
          { url, time: colour.time, boxes },
        );
        measurement.chromiumColorSpace = { ...gl.colorSpace, glRenderer: gl.renderer };
        measurement.webgl = gl.patches;
      } catch (error) {
        measurement.error = `${measurement.error ? `${measurement.error}; ` : ''}${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
      }
    }
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
      join(RESULTS_DIR, 'px03-colour.json'),
      `${JSON.stringify({ patches: colour.patches, measurements: [...measurements.values()] }, null, 2)}\n`,
    );
  });

  const encodings = ['bt601-limited', 'bt601-full', 'bt709-limited', 'bt709-full'];
  for (const encoding of encodings) {
    for (const path of COLOUR_PATHS) {
      test(`${encoding} ${path} matches the engine within ${COLOUR_TOLERANCE}/255`, () => {
        if ((baseline.colour[encoding] ?? []).includes(path)) test.fail();
        expect(manifest, 'run `pnpm px4:frames` before this spec').not.toBeNull();
        const measured = measurements.get(encoding);
        expect(measured?.[path], measured?.error ?? `${encoding} not measured`).not.toBeNull();
        const worst = measured![path]!.map((rgb, patch) =>
          Math.max(...rgb.map((v, c) => Math.abs(v - measured!.engine[patch]![c]!))),
        );
        const names = manifest!.colour.patches.map((patch) => patch.name);
        const over = worst
          .map((error, patch) => ({ patch: names[patch], error: Math.round(error * 100) / 100 }))
          .filter(({ error }) => error > COLOUR_TOLERANCE);
        expect(over, `${encoding} ${path}: patches beyond ${COLOUR_TOLERANCE}/255`).toEqual([]);
      });
    }
  }
});
