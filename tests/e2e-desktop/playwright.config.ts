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
  /**
   * A BUILT renderer, served statically — deliberately not the HMR dev server.
   *
   * The unpackaged Electron main loads its renderer from `http://localhost:5173`, and the
   * preload only exposes the IPC bridge on that exact origin, so the port is fixed. What
   * changes here is what is behind it. With `vite dev` there, any edit to
   * `apps/web-editor/src` (a concurrent agent, a developer, a formatter) triggers a full
   * renderer reload — and a reload throws away the open project, so a 10-30 minute AI row
   * lands back on the launch screen and fails with "composer not found". That happened:
   * the 2026-08-29 provider run failed four rows with byte-identical launch-screen
   * snapshots while the editor's sources were being edited. `vite preview` serves a
   * snapshot of `dist` and has no file watcher, so nothing can reload underneath a run.
   *
   * `vite build` directly rather than `pnpm build`, which additionally runs `tsc --noEmit`:
   * a type error somewhere else in the renderer should not stop the desktop suite from
   * running against the code that is there. `reuseExistingServer` stays on so iterating on
   * a single row does not rebuild each time — run `pnpm --filter @framepilot/web-editor
   * exec vite build` by hand after changing the renderer, or stop the server.
   */
  webServer: {
    command:
      'pnpm --filter @framepilot/web-editor exec vite build && ' +
      'pnpm --filter @framepilot/web-editor exec vite preview --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 300_000,
  },
});
