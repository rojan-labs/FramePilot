#!/usr/bin/env node
/**
 * The efficiency half of the mission gate (plan/system-mission P9.5).
 *
 * `mission-score.mjs` asks "is the edit still as good?". This asks the question that
 * silently gets answered "no" over a quarter of prompt work: **is it still as cheap?**
 * A prompt, a skill, a tool schema or an orchestrator change that buys the same rubric
 * score for 30% more model calls is a regression, and nothing else in CI can see it.
 *
 * Per scenario it reduces a mission-baseline run to three p50s:
 *   - `calls`      — `metrics.modelCalls`, the calls it took to finish the task;
 *   - `tokensPerTurn` — (`tokens.prompt` + `tokens.output`) / `modelCalls`;
 *   - `score`      — the rubric score, so a cost rise can be *earned*.
 *
 * A scenario fails when calls **or** tokens/turn rise by more than `TOLERANCE` (10%)
 * over the committed floor `reports/system-mission/mission-efficiency.json` AND the
 * rubric score did not improve. Paying more for a better edit is a trade the maintainer
 * is allowed to make; paying more for the same edit is the thing this blocks.
 *
 * Usage:
 *   node scripts/mission-efficiency-gate.mjs <run.json>           # gate against the floor
 *   node scripts/mission-efficiency-gate.mjs <run.json> --write   # accept as the new floor
 *
 * `<run.json>` is resolved against the REPOSITORY ROOT, exactly like `mission-score.mjs`
 * and `mission-baseline.mjs --out`. One convention for all three.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const FLOOR = join(REPO, 'reports', 'system-mission', 'mission-efficiency.json');

/** Run-to-run noise on a 2-3 run sample is well under this; a real cost regression is not. */
const TOLERANCE = 0.1;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: mission-efficiency-gate.mjs <run.json> [--write]');
  process.exit(1);
}
const write = args.includes('--write');

const p50 = (xs) => {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  return a.length ? a[Math.floor((a.length - 1) / 2)] : null;
};

/**
 * Reduce one mission-baseline run to per-scenario efficiency figures.
 *
 * @param {{ results: Array<{ scenario: string, turns: Array<object> }> }} data
 * @returns {Record<string, { calls: number|null, tokensPerTurn: number|null, score: number|null, runs: number }>}
 */
export function efficiencyOf(data) {
  const byScenario = new Map();
  for (const r of data.results ?? []) {
    for (const t of r.turns ?? []) {
      // Same key convention as mission-score.mjs, so both gates name the same rows.
      const key = r.turns.length > 1 ? `${r.scenario}#t${t.turnIndex + 1}` : r.scenario;
      if (!byScenario.has(key)) byScenario.set(key, []);
      byScenario.get(key).push(t);
    }
  }
  const out = {};
  for (const [key, turns] of byScenario) {
    const calls = turns.map((t) => t.metrics?.modelCalls ?? NaN);
    const perTurn = turns.map((t) => {
      const m = t.metrics;
      if (!m?.modelCalls) return NaN;
      return ((m.tokens?.prompt ?? 0) + (m.tokens?.output ?? 0)) / m.modelCalls;
    });
    out[key] = {
      calls: p50(calls),
      tokensPerTurn: round(p50(perTurn)),
      score: p50(turns.map((t) => t.score ?? NaN)),
      runs: turns.length,
    };
  }
  return out;
}

const round = (n) => (n === null ? null : Math.round(n));

const current = efficiencyOf(JSON.parse(readFileSync(resolve(REPO, file), 'utf8')));

if (write) {
  writeFileSync(
    FLOOR,
    `${JSON.stringify({ recordedAt: new Date().toISOString(), source: file, tolerance: TOLERANCE, scenarios: current }, null, 2)}\n`,
  );
  console.log(`wrote ${FLOOR}`);
  process.exit(0);
}

if (!existsSync(FLOOR)) {
  console.error(`no efficiency floor at ${FLOOR}; record one with --write`);
  process.exit(1);
}
const floor = JSON.parse(readFileSync(FLOOR, 'utf8'));

const pct = (now, was) => (was ? ((now - was) / was) * 100 : 0);
const f = (v, digits = 0) => (v === null || v === undefined ? '—' : v.toFixed(digits));

let failed = 0;
console.log('| scenario | calls (floor → now) | tokens/turn (floor → now) | rubric | verdict |');
console.log('| --- | --- | --- | --- | --- |');
for (const [key, row] of Object.entries(current)) {
  const was = floor.scenarios?.[key];
  if (!was) {
    console.log(
      `| ${key} | — → ${f(row.calls)} | — → ${f(row.tokensPerTurn)} | ${f(row.score, 2)} | new |`,
    );
    continue;
  }
  const callsUp = pct(row.calls, was.calls);
  const tokensUp = pct(row.tokensPerTurn, was.tokensPerTurn);
  const overBudget = callsUp > TOLERANCE * 100 || tokensUp > TOLERANCE * 100;
  // A rubric gain earns the extra cost. Equal quality for more money does not.
  const earned = row.score !== null && was.score !== null && row.score > was.score;
  let verdict = 'held';
  if (overBudget && earned) verdict = 'costlier, but a better edit';
  else if (overBudget) {
    verdict = 'REGRESSION';
    failed += 1;
  } else if (callsUp < -1 || tokensUp < -1) verdict = 'cheaper';
  console.log(
    `| ${key} | ${f(was.calls)} → ${f(row.calls)} (${callsUp >= 0 ? '+' : ''}${callsUp.toFixed(1)}%) ` +
      `| ${f(was.tokensPerTurn)} → ${f(row.tokensPerTurn)} (${tokensUp >= 0 ? '+' : ''}${tokensUp.toFixed(1)}%) ` +
      `| ${f(was.score, 2)} → ${f(row.score, 2)} | ${verdict} |`,
  );
}

if (failed > 0) {
  console.error(
    `\n${failed} scenario(s) got more expensive by more than ${TOLERANCE * 100}% without a rubric gain, against ${FLOOR}`,
  );
  process.exit(2);
}
