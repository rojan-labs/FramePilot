import { defineConfig } from '@playwright/test';

/**
 * Desktop-host Playwright config (plan/system-mission P9.0). The unpackaged Electron main
 * loads the renderer from the Vite dev server, so the same web server the browser e2e uses
 * is reused here; the Electron app itself is launched per test by `specs/launch.ts`.
 */
export default defineConfig({
  testDir: './specs',
  timeout: Number(process.env.E2E_DESKTOP_TIMEOUT_MS ?? 15 * 60_000),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @framepilot/web-editor dev --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
