#!/usr/bin/env node
/**
 * Foundation real-provider (Google Gemini) capture — CLI entry point.
 *
 * `packages/ai-sdk/src/eval/foundation-real-eval.ts` holds every pure/testable piece; this
 * script is the thin, untested glue that imports the built dist (see
 * `generate-tool-parity-fixture.mjs` for the same local convention), runs it against real
 * process env, and prints/writes results. Requires `pnpm --filter @framepilot/ai-sdk build`
 * to have already produced `dist/`.
 *
 * Usage:
 *   GOOGLE_API_KEY=... node scripts/run-foundation-real-eval.mjs
 *
 * See `pnpm eval:agent:foundation:real` (root package.json) and
 * `.github/workflows/foundation-real-eval.yml` for the wired invocations.
 */
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const { runFoundationRealEval } = await import(
  join(pkgRoot, 'dist', 'eval', 'foundation-real-eval.js')
).catch((error) => {
  console.error(
    '\n[foundation-real-eval] Could not load @framepilot/ai-sdk dist/eval/foundation-real-eval.js. ' +
      'Run: pnpm --filter @framepilot/ai-sdk build\n',
  );
  throw error;
});

try {
  const result = await runFoundationRealEval();
  console.log(`\n${result.jobSummary}`);
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    await appendFile(stepSummaryPath, result.jobSummary, 'utf8');
  }
  console.log(`[foundation-real-eval] wrote ${result.outputPath}`);
  console.log(`[foundation-real-eval] wrote ${result.latestPath}`);
} catch (error) {
  console.error(`\n[foundation-real-eval] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
