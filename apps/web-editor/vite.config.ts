/**
 * Vite + Vitest config for @framepilot/web-editor.
 * Dev server on port 5173; component tests run in jsdom.
 * See plan/PLAN.md Phase 3 (Editor UI).
 */
/// <reference types="vitest/config" />
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Resolve `@anthropic-ai/sdk`'s deep subpath imports for the browser bundle.
 *
 * `@langchain/anthropic` imports `@anthropic-ai/sdk/lib/transform-json-schema`. That
 * specifier is valid — the package's `exports` map has a `./lib/*` pattern and Node
 * resolves it — but Rollup does not apply the pattern, so the build fails outright with
 * "failed to resolve import". This was invisible until ADR 0105, because the whole
 * package was aliased to a throwing stub; making LangChain the only provider path is what
 * required the browser to bundle it for real.
 *
 * The path is computed, never hardcoded: pnpm's store paths contain content hashes that
 * change on every version bump. `@anthropic-ai/sdk` is a transitive dependency, so it is
 * resolved *through* `@langchain/anthropic` rather than from this app, which does not
 * depend on it directly and should not have to.
 */
function anthropicSdkSubpaths() {
  const fromApp = createRequire(import.meta.url);
  const fromLangChain = createRequire(fromApp.resolve('@langchain/anthropic'));
  return {
    name: 'framepilot:anthropic-sdk-subpaths',
    resolveId(source: string) {
      if (!source.startsWith('@anthropic-ai/sdk/')) return null;
      try {
        return fromLangChain.resolve(source);
      } catch {
        // Let Rollup report it rather than swallowing a genuinely missing module.
        return null;
      }
    },
  };
}

// SECURITY / CORRECTNESS: do NOT inject AI provider env vars
// (FRAMEPILOT_AI_PROVIDER, ANTHROPIC_API_KEY, NVIDIA_API_KEY, …) into the
// renderer bundle. Two reasons:
//   1. Secrets — inlining API keys into client JS leaks them to anyone who opens
//      the page. Provider keys must never leave the main process (AGENTS.md §6).
//   2. CORS — the browser cannot call api.anthropic.com / NVIDIA directly, so a
//      real provider in the renderer fails with "Failed to fetch".
// Real providers run in Electron's main process (apps/desktop/electron/main.ts), where
// the key never reaches the renderer. That is the path to protect and the one the desktop
// product uses.
//
// The STANDALONE browser build is different and this comment used to deny it: since H11,
// `apps/web-editor/src/editor/ai.ts → buildBrowserProvider` constructs a real provider
// from a key the user typed into Settings, held in localStorage. It falls back to the
// offline mock only when no key is saved. So "the browser uses the mock provider" was the
// intent, not the behaviour.
//
// Until ADR 0105 the LangChain adapters were additionally aliased to a throwing stub here,
// on the reasoning that the renderer could never select them — true while a `process.env`
// flag gated them, false once LangChain became the only implementation. The alias is gone
// because the browser now genuinely needs these adapters to run.
//
// What still holds: do NOT define `process.env` here, and do not move Electron's key
// handling into the renderer. A browser user supplying their own key to their own browser
// is a different trust story from a desktop app leaking one.
export default defineConfig({
  // Relative base so the production bundle works when Electron loads it via
  // `loadFile()` (file:// — absolute /assets/ URLs would resolve to the
  // filesystem root and 404). Harmless for the dev server and any http host.
  base: './',
  plugins: [react(), anthropicSdkSubpaths()],
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Heavy jsdom renders and 20k-event persistence round-trips sit near the
    // vitest default when the full turbo graph runs in parallel; give them
    // real headroom instead of load-dependent flakes.
    testTimeout: 15_000,
    coverage: {
      // Measure source modules only. `main.tsx` is the DOM mount glue
      // (createRoot) with no logic to unit-test — mirroring the desktop app
      // excluding `main.ts`/`preload.ts`.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/vite-env.d.ts',
        '**/*.test.{ts,tsx}',
        '**/*.config.{ts,js}',
        '**/dist/**',
        // WebCodecs preview glue (plan PREVIEW-WEBCODECS-COMPOSITOR.md P0/P1):
        // touches VideoDecoder/AudioContext/Worker, none of which jsdom
        // implements — covered by Playwright specs instead. The modules
        // these wire together (demux/, decode/{frame-ring,worker-client}, clock/)
        // are NOT excluded — those are pure/injectable and unit-tested normally.
        'src/preview/spike/harness.ts',
        'src/preview/spike/main.ts',
        'src/preview/engine/webcodecs-preview-engine.ts',
      ],
    },
  },
});
