#!/usr/bin/env node
/**
 * The mission scenario suite as a quality gate (plan/system-mission P4.4).
 *
 * Offline half: reads one mission-baseline JSON (`reports/system-mission/*.json`, written by
 * `mission-baseline.mjs` against the real desktop fixtures) and reduces it to one p50 rubric
 * score per scenario, then compares against the committed floor
 * `reports/system-mission/mission-score.json`. A scenario whose p50 drops by more than
 * TOLERANCE fails the gate; `--write` records the current scores as the new floor.
 *
 * Usage:
 *   node scripts/mission-score.mjs <run.json>              # gate against the committed floor
 *   node scripts/mission-score.mjs <run.json> --write      # accept as the new floor
 *
 * `<run.json>` is resolved against the repository root, like `mission-baseline.mjs --out`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const FLOOR = join(REPO, 'reports', 'system-mission', 'mission-score.json');
/** A p50 may wobble by one rubric check on a 3-run sample; more than that is a regression. */
const TOLERANCE = 0.05;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: mission-score.mjs <run.json> [--write]');
  process.exit(1);
}
const write = args.includes('--write');

const p50 = (xs) => {
  const a = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((x, y) => x - y);
  return a.length ? a[Math.floor((a.length - 1) / 2)] : null;
};

/** @returns {Record<string, { score: number | null, runs: number, notDone: number }>} */
export function scoreRun(data) {
  const byScenario = new Map();
  for (const r of data.results) {
    for (const t of r.turns) {
      const key = r.turns.length > 1 ? `${r.scenario}#t${t.turnIndex + 1}` : r.scenario;
      if (!byScenario.has(key)) byScenario.set(key, []);
      byScenario.get(key).push(t);
    }
  }
  const out = {};
  for (const [key, turns] of byScenario) {
    out[key] = {
      score: p50(turns.map((t) => t.score ?? NaN)),
      runs: turns.length,
      notDone: turns.filter((t) => t.crashed || (t.metrics && t.metrics.finalStatus !== 'completed')).length,
    };
  }
  return out;
}

// Resolved against the REPOSITORY ROOT, exactly like `mission-baseline.mjs`'s `--out`.
// One convention for both scripts: a `../../`-style path from `packages/ai-sdk` silently
// wrote a whole run's results outside the repo once, which is not a mistake worth
// leaving available twice.
const current = scoreRun(JSON.parse(readFileSync(resolve(REPO, file), 'utf8')));
const floor = existsSync(FLOOR) ? JSON.parse(readFileSync(FLOOR, 'utf8')) : { scenarios: {} };

let failed = 0;
console.log('| scenario | floor | now | runs | not done | verdict |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const [key, row] of Object.entries(current)) {
  const prior = floor.scenarios?.[key]?.score ?? null;
  let verdict = 'new';
  if (prior !== null && row.score !== null) {
    verdict = row.score + TOLERANCE < prior ? 'REGRESSION' : row.score > prior ? 'better' : 'held';
    if (verdict === 'REGRESSION') failed += 1;
  } else if (row.score === null) {
    verdict = 'no score (every run crashed)';
  }
  const f = (v) => (v === null ? '—' : v.toFixed(2));
  console.log(`| ${key} | ${f(prior)} | ${f(row.score)} | ${row.runs} | ${row.notDone} | ${verdict} |`);
}

if (write) {
  writeFileSync(
    FLOOR,
    `${JSON.stringify({ recordedAt: new Date().toISOString(), source: file, tolerance: TOLERANCE, scenarios: current }, null, 2)}\n`,
  );
  console.log(`\nwrote ${FLOOR}`);
} else if (failed > 0) {
  console.error(`\n${failed} scenario(s) regressed by more than ${TOLERANCE} against ${FLOOR}`);
  process.exit(2);
}
