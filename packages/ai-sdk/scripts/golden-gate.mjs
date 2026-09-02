#!/usr/bin/env node
/**
 * THE regression gate for the golden set (goal.md Phase 0: "treat regressions as build
 * failures"). One command, one floor, three families of numbers:
 *
 *   rubric     — per scenario/turn, the p50 outcome score (was `mission-score.mjs`);
 *   efficiency — per scenario/turn, p50 model calls and tokens per turn, where paying
 *                more for a BETTER edit is allowed and paying more for the same edit is
 *                not (was `mission-efficiency-gate.mjs`);
 *   golden     — run-wide intent accuracy, target resolution, boundary precision,
 *                operation validity, first-pass acceptance, silent successes,
 *                reversibility, tokens per ACCEPTED edit; latency and failure quality
 *                reported, never gated.
 *
 * Input is either a run JSON written by `mission-baseline.mjs --out` (has `results`, and
 * `golden` when the run computed the metrics) or a `summary.json` from a run directory.
 * The floor is `reports/golden/floor.json`; `--write` accepts the input as the new floor.
 * A family the input cannot supply (an older run with no `golden` block) is reported as
 * n/a rather than failed — no data is not a regression.
 *
 * Usage:
 *   node scripts/golden-gate.mjs reports/golden/baseline.json            # gate
 *   node scripts/golden-gate.mjs reports/golden/baseline.json --write    # accept as floor
 *
 * Paths resolve against the REPOSITORY ROOT, like every mission script.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const FLOOR = join(REPO, 'reports', 'golden', 'floor.json');
/** A p50 may wobble by one rubric check on a 3-run sample; more than that is a regression. */
const SCORE_TOLERANCE = 0.05;
/** Run-to-run noise on a 2-3 run sample is well under this; a real cost regression is not. */
const COST_TOLERANCE = 0.1;
/** One turn out of ~20 flipping is noise on a small sample; more than that is a regression. */
const RATE_TOLERANCE = 0.05;

const p50 = (xs) => {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  return a.length ? a[Math.floor((a.length - 1) / 2)] : null;
};
const fmt = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);
const round = (n) => (n === null ? null : Math.round(n));

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: golden-gate.mjs <run.json | summary.json> [--write]');
  process.exit(1);
}
const write = args.includes('--write');
const input = JSON.parse(readFileSync(resolve(REPO, file), 'utf8'));
const current = reduce(input);
if (!current.scenarios && !current.summary) {
  console.error(`${file} is neither a mission run (no .results) nor a golden summary (no .summary)`);
  process.exit(1);
}

if (write) {
  writeFileSync(
    FLOOR,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        source: file,
        label: input.label ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        generatedAt: input.generatedAt ?? null,
        tolerances: { score: SCORE_TOLERANCE, cost: COST_TOLERANCE, rate: RATE_TOLERANCE },
        scenarios: current.scenarios,
        summary: current.summary,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${FLOOR.slice(REPO.length + 1)}`);
  process.exit(0);
}
if (!existsSync(FLOOR)) {
  console.error(`no golden floor at ${FLOOR.slice(REPO.length + 1)}; record one with --write`);
  process.exit(1);
}
const floor = JSON.parse(readFileSync(FLOOR, 'utf8'));


/**
 * Reduce a run JSON or a summary JSON to the two things the floor stores.
 *
 * @returns {{ scenarios: Record<string, {score:number|null, calls:number|null, tokensPerTurn:number|null, runs:number, notDone:number}> | null, summary: object | null }}
 */
function reduce(data) {
  let scenarios = null;
  if (Array.isArray(data.results)) {
    const byKey = new Map();
    for (const r of data.results) {
      for (const t of r.turns ?? []) {
        // One key convention for every family: `scenario` for a single-turn case,
        // `scenario#tN` for a multi-turn one.
        const key = r.turns.length > 1 ? `${r.scenario}#t${t.turnIndex + 1}` : r.scenario;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(t);
      }
    }
    scenarios = {};
    for (const [key, turns] of byKey) {
      scenarios[key] = {
        score: p50(turns.map((t) => t.score ?? NaN)),
        calls: p50(turns.map((t) => t.metrics?.modelCalls ?? NaN)),
        tokensPerTurn: round(
          p50(
            turns.map((t) => {
              const m = t.metrics;
              if (!m?.modelCalls) return NaN;
              return ((m.tokens?.prompt ?? 0) + (m.tokens?.output ?? 0)) / m.modelCalls;
            }),
          ),
        ),
        runs: turns.length,
        notDone: turns.filter((t) => t.crashed || (t.metrics && t.metrics.finalStatus !== 'completed')).length,
      };
    }
  }
  const summary = data.summary?.perCase ? data.summary : data.golden?.perCase ? data.golden : null;
  return { scenarios, summary };
}
let failed = 0;

// ── rubric + efficiency, per scenario ─────────────────────────────────────────────
if (current.scenarios) {
  console.log('| scenario | rubric floor → now | calls floor → now | tokens/turn floor → now | runs | not done | verdict |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const [key, row] of Object.entries(current.scenarios)) {
    const was = floor.scenarios?.[key];
    if (!was) {
      console.log(`| ${key} | — → ${fmt(row.score, 2)} | — → ${fmt(row.calls)} | — → ${fmt(row.tokensPerTurn)} | ${row.runs} | ${row.notDone} | new |`);
      continue;
    }
    const verdicts = [];
    if (row.score === null) verdicts.push('no score (every run crashed)');
    else if (was.score !== null && row.score + SCORE_TOLERANCE < was.score) verdicts.push('RUBRIC REGRESSION');
    else if (was.score !== null && row.score > was.score) verdicts.push('better edit');
    const pctUp = (now, then) => (then ? (now - then) / then : 0);
    const callsUp = row.calls !== null && was.calls !== null ? pctUp(row.calls, was.calls) : 0;
    const tokensUp = row.tokensPerTurn !== null && was.tokensPerTurn !== null ? pctUp(row.tokensPerTurn, was.tokensPerTurn) : 0;
    const overBudget = callsUp > COST_TOLERANCE || tokensUp > COST_TOLERANCE;
    const earned = row.score !== null && was.score !== null && row.score > was.score;
    if (overBudget && earned) verdicts.push('costlier, but a better edit');
    else if (overBudget) verdicts.push('COST REGRESSION');
    else if (callsUp < -0.01 || tokensUp < -0.01) verdicts.push('cheaper');
    if (verdicts.some((v) => v.includes('REGRESSION'))) failed += 1;
    console.log(
      `| ${key} | ${fmt(was.score, 2)} → ${fmt(row.score, 2)} | ${fmt(was.calls)} → ${fmt(row.calls)} | ${fmt(was.tokensPerTurn)} → ${fmt(row.tokensPerTurn)} | ${row.runs} | ${row.notDone} | ${verdicts.join('; ') || 'held'} |`,
    );
  }
} else {
  console.log('(no per-scenario rubric/efficiency rows: input carries no `results`)');
}

// ── golden metrics, run-wide ───────────────────────────────────────────────────────
const now = current.summary;
const was = floor.summary;
console.log('\n| golden metric | floor | now | verdict |');
console.log('| --- | --- | --- | --- |');
if (!now || !was) {
  console.log(`| (all) | ${was ? 'recorded' : '—'} | ${now ? 'present' : '—'} | n/a — ${!now ? 'input has no golden block' : 'floor has no golden block'} |`);
} else {
  const rate = (name, key) => {
    const a = was[key];
    const b = now[key];
    let verdict = 'held';
    if (a == null || b == null) verdict = 'n/a';
    else if (b + RATE_TOLERANCE < a) { verdict = 'REGRESSION'; failed += 1; }
    else if (b > a) verdict = 'better';
    console.log(`| ${name} | ${pct(a)} | ${pct(b)} | ${verdict} |`);
  };
  rate('intent accuracy', 'intentAccuracy');
  rate('target resolution', 'targetAccuracy');
  rate('boundary precision', 'boundaryPrecision');
  rate('operation validity', 'validityRate');
  rate('first-pass acceptance', 'firstPassAcceptance');
  rate('reversibility', 'reversibility');
  {
    const a = was.silentSuccesses ?? 0;
    const b = now.silentSuccesses ?? 0;
    const verdict = b > a ? 'REGRESSION' : b < a ? 'better' : 'held';
    if (verdict === 'REGRESSION') failed += 1;
    console.log(`| silent successes | ${a} | ${b} | ${verdict} |`);
  }
  {
    const a = was.tokensPerAcceptedEdit;
    const b = now.tokensPerAcceptedEdit;
    let verdict = 'held';
    if (a == null || b == null) verdict = 'n/a';
    else {
      const up = (b - a) / a;
      const earned = (now.firstPassAcceptance ?? 0) > (was.firstPassAcceptance ?? 0);
      if (up > COST_TOLERANCE && earned) verdict = 'costlier, but more edits accepted';
      else if (up > COST_TOLERANCE) { verdict = 'REGRESSION'; failed += 1; }
      else if (up < -0.01) verdict = 'cheaper';
    }
    console.log(`| tokens / accepted edit | ${fmt(a)} | ${fmt(b)} | ${verdict} |`);
  }
  {
    const a = was.usdPerAcceptedEdit;
    const b = now.usdPerAcceptedEdit;
    console.log(`| USD / accepted edit | ${a == null ? '—' : `$${a.toFixed(3)}`} | ${b == null ? '—' : `$${b.toFixed(3)}`} | reported |`);
  }
  {
    const a = was.latency?.doneMs?.p95;
    const b = now.latency?.doneMs?.p95;
    const up = a && b ? (b - a) / a : null;
    console.log(`| done p95 | ${a == null ? '—' : `${(a / 1000).toFixed(0)}s`} | ${b == null ? '—' : `${(b / 1000).toFixed(0)}s`} | ${up === null ? 'n/a' : up > 0.25 ? 'slower (not gated)' : 'reported'} |`);
  }
  {
    const share = (s) => (s?.failureQuality?.failures ? s.failureQuality.explained / s.failureQuality.failures : null);
    console.log(`| failures explained | ${pct(share(was))} | ${pct(share(now))} | reported |`);
  }
  const dropped = [];
  for (const [id, c] of Object.entries(now.perCase)) {
    const prior = was.perCase?.[id];
    if (prior && c.firstPass + RATE_TOLERANCE < prior.firstPass) dropped.push(`${id} (${pct(prior.firstPass)} → ${pct(c.firstPass)})`);
    if (prior && c.silentSuccesses > (prior.silentSuccesses ?? 0)) dropped.push(`${id} (new silent success)`);
  }
  if (dropped.length) console.log(`\nCases that moved the wrong way: ${dropped.join(', ')}`);
}

if (failed > 0) {
  console.error(`\n${failed} regression(s) against ${FLOOR.slice(REPO.length + 1)} (floor from ${floor.generatedAt ?? floor.recordedAt})`);
  process.exit(2);
}
