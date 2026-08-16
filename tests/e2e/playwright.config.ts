import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for FramePilot E2E tests.
 *
 * Covers the PRD §16.1 critical flows that are reachable in the browser build of
 * `apps/web-editor`: create/load project → transcript → captions → trim/split →
 * timeline gestures → AI edit → review diff → apply → undo/redo → transport.
 * Real export/render is desktop-only (Electron + Python engine) and intentionally
 * out of scope here — see specs/preview-export-validate.spec.ts for the rationale.
 *
 * Reports are written under the repo-level `reports/e2e` tree so CI can upload
 * a single artifacts directory.
 *
 * Determinism guarantees (PRD §16, e2e-testing SKILL):
 *  - The web build runs fully in-browser with the offline **mock** AI provider
 *    (no network, no Electron, no Python engine).
 *  - `reducedMotion: 'reduce'` disables the app's CSS animations (the app honours
 *    `prefers-reduced-motion`) so screenshots and timing are stable.
 *  - A pinned 1280x800 viewport keeps visual baselines reproducible.
 */
export default defineConfig({
  testDir: './specs',
  // Keep the per-test artifacts dir OUTSIDE the HTML report dir; the HTML
  // reporter clears its own folder on each run, which would otherwise wipe these.
  outputDir: '../../reports/e2e-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Spread rather than `workers: undefined`: the config type is checked with
  // exactOptionalPropertyTypes, where an explicit undefined is NOT the same as an
  // absent key — and absent is what makes Playwright pick its own default
  // locally. Pre-existing type error, fixed here.
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../reports/e2e', open: 'never' }],
    ['json', { outputFile: '../../reports/e2e/results.json' }],
  ],
  // Perceptual tolerance for golden screenshots: a couple of anti-aliased pixels
  // may differ across machines; structural changes still fail the diff. Visual
  // baselines are environment-sensitive — regenerate with `--update-snapshots`.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
  },
  use: {
    baseURL: process.env.FRAMEPILOT_WEB_URL ?? 'http://127.0.0.1:5173',
    viewport: { width: 1280, height: 800 },
    // Passed through contextOptions: this Playwright version's `UseOptions` type
    // does not declare `reducedMotion` at the top level, so declaring it there
    // was a type error while still working at runtime. Same effect, typed.
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /preview-(spike|webcodecs-p[0-9]+)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // P0 WebCodecs feasibility spike (plan PREVIEW-WEBCODECS-COMPOSITOR.md).
    // Separate project because:
    //  - `channel: 'chrome'` uses real Google Chrome, not Playwright's bundled
    //    open-codecs Chromium — the bundled build has no H.264/AAC decode, so
    //    VideoDecoder.isConfigSupported would report the real proxy codec
    //    unsupported and the spike would "fail feasibility" falsely.
    //  - The autoplay-policy/background-throttling launch args below are
    //    spike-specific and would be an odd default for the main app suite.
    //  - The spec runs its gates as one serial describe block (see the spec
    //    file) rather than relying on a per-project worker cap — parallel
    //    workers would share one GPU process, which would make the
    //    decode-latency gates measure GPU contention instead of themselves.
    {
      name: 'preview-spike',
      testMatch: /preview-(spike|webcodecs-p[0-9]+)\.spec\.ts/,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
          ],
        },
      },
    },
  ],

  // Vite binds to IPv6 `localhost` (::1) by default, so we pin it to the IPv4
  // loopback that `baseURL` uses. `reuseExistingServer` lets a dev server already
  // running locally be reused; CI always starts a fresh one.
  webServer: {
    command: 'pnpm --filter @framepilot/web-editor dev --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
