#!/usr/bin/env node
/**
 * perception-baseline — how much the agent LOOKED, read off runs that already happened.
 *
 * The visual-understanding plan (VU0.1) needs a floor to measure against, and the honest
 * way to get one is NOT to spend hours and provider money re-running the golden set: every
 * run the harness has ever done left per-case result files under `reports/golden/<run>/cases/`,
 * and each turn of those records `metrics.toolCallsByName` — which is exactly the evidence
 * these metrics are computed from. This script folds those files into the baseline table.
 *
 * What it can and cannot say, stated plainly:
 *
 *  - Tool calls by name are recorded per turn, so frames seen, footage-surface calls, and
 *    grade/transition calls are exact.
 *  - Operation TYPES are not recorded per turn (only a count), so the guess rate is computed
 *    over `apply_color_grade`/`add_transition` TOOL calls rather than applied operations.
 *    At baseline no solver tool exists, so a run that graded without calling `measure_color`
 *    first guessed by construction; the number is a floor, and the live harness (which does
 *    see operations) will refine it.
 *  - A run directory with no `cases/` is skipped and named, never silently dropped.
 *
 * Usage:
 *   node scripts/perception-baseline.mjs <runDir> [runDir...]      # markdown table on stdout
 *   node scripts/perception-baseline.mjs --json <runDir>           # the same as JSON
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Kept in step with `src/eval/perception-metrics.ts` — the same names, by hand. */
const FRAME_TOOLS = new Set(['get_frame']);
const PERCEPTION_TOOLS = new Set([
  'search_visual',
  'describe_footage',
  'map_footage',
  'measure_color',
]);
const SOLVER_TOOLS = new Set([
  'measure_color',
  'match_color',
  'normalize_exposure',
  'apply_look',
  'add_transitions',
]);
const JUDGED_TOOLS = new Set(['apply_color_grade', 'add_transition']);

function caseFiles(runDir) {
  const dir = join(runDir, 'cases');
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f));
}

function foldRun(runDir) {
  const files = caseFiles(runDir);
  const totals = {
    runDir,
    caseFiles: files.length,
    turns: 0,
    framesSeen: 0,
    perceptionCalls: 0,
    byTool: {},
    timelineReads: 0,
    judgedCalls: 0,
    groundedTurns: 0,
    judgedTurns: 0,
    acceptedEdits: 0,
    operations: 0,
  };
  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    for (const turn of doc.turns ?? []) {
      const byName = turn.metrics?.toolCallsByName ?? {};
      totals.turns += 1;
      totals.operations += turn.metrics?.operations ?? 0;
      // "Accepted edit" as the harness defines it: a full-score turn that applied something.
      if ((turn.score ?? 0) === 1 && (turn.metrics?.operations ?? 0) > 0) totals.acceptedEdits += 1;
      let judgedHere = 0;
      let solverHere = 0;
      for (const [tool, count] of Object.entries(byName)) {
        if (FRAME_TOOLS.has(tool)) totals.framesSeen += count;
        if (PERCEPTION_TOOLS.has(tool)) {
          totals.perceptionCalls += count;
          totals.byTool[tool] = (totals.byTool[tool] ?? 0) + count;
        }
        if (tool === 'get_timeline' || tool === 'get_timeline_summary')
          totals.timelineReads += count;
        if (JUDGED_TOOLS.has(tool)) judgedHere += count;
        if (SOLVER_TOOLS.has(tool)) solverHere += count;
      }
      totals.judgedCalls += judgedHere;
      if (judgedHere > 0) {
        totals.judgedTurns += 1;
        if (solverHere > 0) totals.groundedTurns += 1;
      }
    }
  }
  return totals;
}

function ratio(a, b) {
  return b > 0 ? a / b : null;
}

function num(v, digits = 2) {
  return v === null ? '—' : v.toFixed(digits);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dirs = args.filter((a) => a !== '--json');
if (dirs.length === 0) {
  console.error('usage: perception-baseline.mjs [--json] <runDir> [runDir...]');
  process.exit(2);
}

const rows = dirs.map(foldRun);
const skipped = rows.filter((r) => r.caseFiles === 0).map((r) => r.runDir);
const scored = rows.filter((r) => r.caseFiles > 0);
const total = scored.reduce(
  (acc, r) => ({
    turns: acc.turns + r.turns,
    framesSeen: acc.framesSeen + r.framesSeen,
    perceptionCalls: acc.perceptionCalls + r.perceptionCalls,
    timelineReads: acc.timelineReads + r.timelineReads,
    judgedCalls: acc.judgedCalls + r.judgedCalls,
    judgedTurns: acc.judgedTurns + r.judgedTurns,
    groundedTurns: acc.groundedTurns + r.groundedTurns,
    acceptedEdits: acc.acceptedEdits + r.acceptedEdits,
    byTool: (() => {
      const out = { ...acc.byTool };
      for (const [k, v] of Object.entries(r.byTool)) out[k] = (out[k] ?? 0) + v;
      return out;
    })(),
  }),
  {
    turns: 0,
    framesSeen: 0,
    perceptionCalls: 0,
    timelineReads: 0,
    judgedCalls: 0,
    judgedTurns: 0,
    groundedTurns: 0,
    acceptedEdits: 0,
    byTool: {},
  },
);

if (asJson) {
  console.log(JSON.stringify({ runs: scored, total, skipped }, null, 2));
  process.exit(0);
}

const out = [];
out.push(
  '| run | turns | accepted edits | frames seen | frames/edit | footage calls | calls/turn |',
);
out.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of scored) {
  out.push(
    `| ${r.runDir} | ${r.turns} | ${r.acceptedEdits} | ${r.framesSeen} | ${num(ratio(r.framesSeen, r.acceptedEdits))} | ${r.perceptionCalls} | ${num(ratio(r.perceptionCalls, r.turns))} |`,
  );
}
out.push(
  `| **all** | **${total.turns}** | **${total.acceptedEdits}** | **${total.framesSeen}** | **${num(ratio(total.framesSeen, total.acceptedEdits))}** | **${total.perceptionCalls}** | **${num(ratio(total.perceptionCalls, total.turns))}** |`,
);
out.push('');
out.push(`Timeline reads (\`get_timeline\`/\`get_timeline_summary\`): **${total.timelineReads}**`);
out.push(
  `Timeline reads per frame seen: **${num(ratio(total.timelineReads, total.framesSeen), 1)}**`,
);
out.push(
  `Footage surfaces called: ${
    Object.keys(total.byTool).length === 0
      ? '**none, in any run**'
      : Object.entries(total.byTool)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `\`${k}\` ${v}`)
          .join(' · ')
  }`,
);
out.push(
  `Grade/transition tool calls: **${total.judgedCalls}** over ${total.judgedTurns} turn(s); turns that measured first: **${total.groundedTurns}** ⇒ guess rate **${num(ratio(total.judgedTurns - total.groundedTurns, total.judgedTurns))}**`,
);
if (skipped.length > 0) out.push('', `Skipped (no \`cases/\`): ${skipped.join(', ')}`);
console.log(out.join('\n'));
