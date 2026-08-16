#!/usr/bin/env node
/**
 * Capture the M0.1 AI-orchestration performance baseline (plan/LANGCHAIN-MIGRATION.md).
 *
 * Runs real agent turns against a real project with a real provider, measures every
 * model call at the provider seam, and writes the report every later phase is judged
 * against. Nothing here is synthesized — if the run does not happen, no numbers appear.
 *
 * ## Usage
 *
 *   pnpm --filter @framepilot/ai-sdk build          # the script reads built dist
 *   ANTHROPIC_API_KEY=sk-… FRAMEPILOT_AI_PROVIDER=anthropic \
 *     node scripts/capture-ai-baseline.mjs --project path/to/project.fp.json
 *
 * Options:
 *   --project <path>   Required. A real project file; use desktop-scale media.
 *   --prompts <path>   Newline-separated prompts. Defaults to a built-in set.
 *   --runs <n>         How many prompts to execute (default: all of them).
 *   --label <text>     Optional cross-check only. Derived from FRAMEPILOT_AI_PROVIDER_IMPL;
 *                      a value that disagrees with the environment aborts the run.
 *   --out <path>       Report path. Defaults to reports/<date>-ai-orchestration-<adapter>.md.
 *
 * To measure the LangChain adapter for comparison, set
 * `FRAMEPILOT_AI_PROVIDER_IMPL=langchain`; the rig sits at the provider seam so both paths
 * are measured identically, and the adapter names both the report and its file so one
 * capture cannot overwrite the other.
 *
 * ## What it costs
 *
 * Real provider calls against real footage. That is the point — M0.1 exists precisely
 * because these numbers cannot be produced any other way, and a fabricated baseline
 * would silently validate every phase measured against it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const DEFAULT_PROMPTS = [
  'Tighten the intro — cut the dead air before the first sentence.',
  'Remove the long silences across the whole timeline.',
  'Find the strongest hook and move it to the front.',
  'Add captions for the first thirty seconds.',
  'Trim the outro so the video ends on the last spoken word.',
];

function parseArgs(argv) {
  const args = { runs: undefined, label: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) continue;
    const value = argv[index + 1];
    if (flag === '--project') args.project = value;
    else if (flag === '--prompts') args.prompts = value;
    else if (flag === '--runs') args.runs = Number(value);
    else if (flag === '--label') args.label = value;
    else if (flag === '--out') args.out = value;
    else if (flag === '--allow-mock') args.allowMock = true;
  }
  return args;
}

/**
 * The adapter that actually served the run, read from the same env the provider factory
 * reads — never defaulted, never taken on the operator's word.
 *
 * `--label` used to default to `'native'`. A `.env` carrying
 * `FRAMEPILOT_AI_PROVIDER_IMPL=langchain` therefore produced a report titled "baseline —
 * native" that had measured LangChain, and the mislabel is not cosmetic: comparing the
 * LangChain adapter against a LangChain-derived "native baseline" compares it to itself
 * and passes trivially. A wrong baseline is worse than no baseline, because a missing one
 * announces itself.
 */
function resolveAdapter() {
  return process.env.FRAMEPILOT_AI_PROVIDER_IMPL === 'langchain' ? 'langchain' : 'native';
}

function fail(message) {
  console.error(`\n[baseline] ${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.project) fail('--project <path to a real .fp.json> is required.');

const adapter = resolveAdapter();
if (args.label !== undefined && args.label !== adapter) {
  fail(
    `--label "${args.label}" contradicts the environment, which selects the "${adapter}" ` +
      `adapter (FRAMEPILOT_AI_PROVIDER_IMPL=${process.env.FRAMEPILOT_AI_PROVIDER_IMPL ?? '<unset>'}). ` +
      'Refusing to write a report that misnames what it measured. Check your .env — it is ' +
      'read before this script runs and it is the usual cause.',
  );
}
args.label = adapter;

const sdk = await import(path.join(root, 'packages/ai-sdk/dist/index.js')).catch(() => {
  fail('Could not load @framepilot/ai-sdk dist. Run: pnpm --filter @framepilot/ai-sdk build');
});

const {
  BaselineCaptureProvider,
  DEFAULT_TIER_PRICING,
  Orchestrator,
  createResilientProvider,
  summarizeRunMetrics,
} = sdk;

const providerName = process.env.FRAMEPILOT_AI_PROVIDER;
if (!providerName || (providerName === 'mock' && !args.allowMock)) {
  fail(
    'FRAMEPILOT_AI_PROVIDER must name a real provider (e.g. anthropic). ' +
      'A mock run measures nothing and would produce a false budget. ' +
      'Pass --allow-mock only to smoke-test this script itself.',
  );
}

const project = JSON.parse(await readFile(path.resolve(args.project), 'utf8'));
const prompts = args.prompts
  ? (await readFile(path.resolve(args.prompts), 'utf8')).split('\n').filter((line) => line.trim())
  : DEFAULT_PROMPTS;
const selected = args.runs ? prompts.slice(0, args.runs) : prompts;

if (selected.length < 20) {
  console.warn(
    `[baseline] WARNING: ${selected.length} prompt(s). M0.1 asks for at least 20 real runs; ` +
      'fewer makes p95 meaningless. Pass --prompts with a larger set for the real baseline.',
  );
}

// The rig wraps the provider BEFORE the resilience decorator, so it measures what the
// provider actually did — a retried call is two samples, which is the honest reading.
const capture = new BaselineCaptureProvider(createResilientProvider(providerName), {
  prices: DEFAULT_TIER_PRICING,
});
const orchestrator = new Orchestrator(capture);

const runStarted = Date.now();
let completed = 0;
let failed = 0;

for (const [index, prompt] of selected.entries()) {
  process.stdout.write(`[baseline] ${index + 1}/${selected.length} ${prompt.slice(0, 60)}…\n`);
  try {
    const stream = orchestrator.streamAgent(
      { project, userPrompt: prompt },
      { conversationId: `baseline_${index}`, turnId: `baseline_turn_${index}` },
      {},
    );
    // One run is one outcome. This used to `failed += 1` on the status event and then
    // `completed += 1` unconditionally, so a failed run was counted in both columns —
    // which is how a 5-prompt run reported "5 completed, 2 failed".
    let runFailed = false;
    for await (const event of stream) {
      if (event.type === 'status' && event.status === 'failed') runFailed = true;
    }
    if (runFailed) failed += 1;
    else completed += 1;
  } catch (error) {
    failed += 1;
    console.error(`[baseline]   run failed: ${error instanceof Error ? error.message : error}`);
  }
}

const samples = capture.captured();
if (samples.length === 0) fail('No model calls were measured — nothing to report.');

const summary = summarizeRunMetrics(samples);
const streamed = samples.filter((sample) => sample.streamed).length;
const degenerate = samples.filter((sample) => sample.ttftMs === sample.wallMs).length;
const date = new Date().toISOString().slice(0, 10);
// The filename carries the adapter, for the same reason the title does. It used to be a
// fixed `-baseline.md`, so capturing native and then LangChain wrote both to one path and
// the second silently destroyed the first — the two runs the whole comparison needs.
// Fixing the label without fixing the filename fixed half the problem.
const outPath = args.out
  ? path.resolve(args.out)
  : path.join(root, 'reports', `${date}-ai-orchestration-${adapter}.md`);

const pct = (p) =>
  `p50 ${Math.round(p.p50)} · p95 ${Math.round(p.p95)} · min ${Math.round(p.min)} · max ${Math.round(p.max)}`;

// Costs are cents-scale, so `Math.round` rendered every one of them as `0` — a report
// claiming the run was free while the JSON beside it held the real figures. Cost per turn
// is one of M0.1's three acceptance metrics; it cannot be the one that rounds away.
const usd = (p) =>
  `p50 $${p.p50.toFixed(4)} · p95 $${p.p95.toFixed(4)} · min $${p.min.toFixed(4)} · max $${p.max.toFixed(4)}`;

const mockWarning =
  providerName === 'mock'
    ? '\n> **⚠️ THIS IS NOT A BASELINE.** It was captured against the offline mock provider ' +
      'to smoke-test the harness. The timings are of a stub and the costs are fictional. ' +
      'Do not use it as the M0.1 budget.\n'
    : '';

// Caveats belong at the top of the report, not in the terminal scrollback of whoever ran
// it. Whoever reads this file later did not see that output.
const caveats = [
  selected.length < 20 &&
    `**Only ${selected.length} prompt(s) were run; M0.1 asks for at least 20.** p95 over a ` +
      'handful of prompts is one unlucky call, not a percentile. Treat this as indicative.',
  failed > 0 &&
    `**${failed} of ${selected.length} run(s) failed.** Their model calls are still in the ` +
      'sample set — a call that happened and then errored still cost money and time, and ' +
      'dropping it would flatter the numbers. But a failed run is a short run, so it pulls ' +
      'the per-turn figures down.',
].filter(Boolean);

const caveatBlock =
  caveats.length > 0 ? `\n> [!WARNING]\n${caveats.map((c) => `> - ${c}`).join('\n')}\n` : '';

const report = `# AI orchestration baseline — ${args.label}
${mockWarning}${caveatBlock}
> Captured ${date} by \`scripts/capture-ai-baseline.mjs\`. **Measured, not estimated.**
${
  adapter === 'native'
    ? '> This is the M0.1 budget every later phase of `plan/LANGCHAIN-MIGRATION.md` is judged\n' +
      '> against: no worse than these p50/p95 TTFT and cost-per-turn figures, and no lower\n' +
      '> prompt-cache hit rate.'
    : '> **This is a candidate measurement, not the budget.** It ran on the LangChain adapter,\n' +
      '> so it is the thing being judged. The budget is a `native` capture under the same\n' +
      '> project, prompts and model; compare them with `checkAgainstBudget`.'
}

## Conditions

| | |
| --- | --- |
| Provider | \`${providerName}\` (adapter: \`${adapter}\`) |
| Model | \`${samples[0]?.modelId ?? 'unknown'}\` |
| Project | \`${path.basename(args.project)}\` |
| Prompts run | ${selected.length} (${completed} completed, ${failed} failed) |
| Model calls measured | ${samples.length} (${streamed} streamed, ${samples.length - streamed} non-streaming) |
| Wall time | ${Math.round((Date.now() - runStarted) / 1000)}s |

## Per-turn measurements

| Metric | Value |
| --- | --- |
| Time to first token (ms) | ${pct(summary.ttftMs)} |
| Turn wall time (ms) | ${pct(summary.wallMs)} |
| Input tokens | ${pct(summary.inputTokensPerTurn)} |
| Output tokens | ${pct(summary.outputTokensPerTurn)} |
| Cost per turn (USD) | ${summary.usdPerTurn ? usd(summary.usdPerTurn) : '— not priced'} |
| Total spend (USD) | $${samples.reduce((total, sample) => total + (sample.usd ?? 0), 0).toFixed(4)} |
| Prompt-cache hit rate | ${summary.cacheHitRate === undefined ? '— not reported by this provider' : `${(summary.cacheHitRate * 100).toFixed(1)}%`} |

## How to read this

- **TTFT is time to the first _content_ chunk**, not the first chunk of any kind. Anthropic
  sends usage on \`message_start\`; counting that would report a latency nobody experienced.
- **Non-streaming calls carry \`ttftMs === wallMs\`** because they have no first-token
  moment. ${samples.length - streamed} of ${samples.length} samples are non-streaming.
- **${degenerate} of ${samples.length} samples have \`ttftMs === wallMs\` in total**${
  degenerate > samples.length - streamed
    ? `, which is ${degenerate - (samples.length - streamed)} more than the non-streaming ` +
      'count above. A **streamed** call with no gap between first token and last one did not ' +
      'stream in any way a user would perceive — the whole answer landed at once. Reasoning ' +
      'models that buffer until the reasoning block closes do this. For those samples TTFT is ' +
      'not a first-token latency, it is the full turn, so the TTFT percentiles above are ' +
      'pulled upward and a later adapter could "beat" them by streaming no differently.'
    : '.'
}
- **An absent cache-hit rate means the provider did not report cache counts**, not that
  the hit rate was zero. Unreported turns are excluded from the denominator so a provider
  gap cannot masquerade as a 0% rate a later phase then "matches".
- **Percentiles are nearest-rank**, so every figure above is a real observation rather
  than an interpolation between two.

## Comparing a later phase against this

\`\`\`ts
import { checkAgainstBudget } from '@framepilot/ai-sdk';
checkAgainstBudget(baseline, candidate, 0.05); // 5% tolerance for measurement noise
\`\`\`

To measure the other adapter under identical conditions, re-run with
\`FRAMEPILOT_AI_PROVIDER_IMPL=${adapter === 'native' ? 'langchain' : 'native'}\` — same
\`--project\`, same \`--prompts\`, same model. The label is derived from that variable, not
passed in, so the two reports cannot be confused for one another.
`;

// Belt and braces for the `--out` path, which can still aim two adapters at one file.
// Refusing costs a re-run of something already measured; overwriting costs the run that
// is not repeatable, because the other adapter's data is gone and the spend is spent.
const jsonPath = outPath.replace(/\.md$/, '.json');
const existing = await readFile(jsonPath, 'utf8').catch(() => undefined);
if (existing !== undefined) {
  const previous = JSON.parse(existing).adapter;
  if (previous !== undefined && previous !== adapter) {
    fail(
      `${path.relative(root, jsonPath)} holds a "${previous}" capture and this run is ` +
        `"${adapter}". Refusing to overwrite the other half of the comparison. Drop --out ` +
        'to get the adapter-named default path.',
    );
  }
}

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, report, 'utf8');
await writeFile(
  jsonPath,
  `${JSON.stringify(
    {
      label: args.label,
      adapter,
      provider: providerName,
      promptsRun: selected.length,
      completed,
      failed,
      summary,
      samples,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`\n[baseline] wrote ${path.relative(root, outPath)}`);
console.log(`[baseline] wrote ${path.relative(root, jsonPath)}`);
console.log(`[baseline] ${samples.length} model calls measured across ${completed} runs.`);
