#!/usr/bin/env node
/**
 * The golden-set regression gate (goal.md Phase 0: "treat regressions as build failures").
 *
 * Reads one golden summary (`reports/golden/<label>/summary.json`, written by
 * `mission-baseline.mjs`) and compares it with the committed floor
 * `reports/golden/floor.json`. The two older gates still cover the rubric score
 * (`mission-score.mjs`) and calls/tokens per turn (`mission-efficiency-gate.mjs`); this one
 * covers what goal.md adds and neither of them can see:
 *
 *   intent accuracy · target resolution · boundary precision · operation validity ·
 *   first-pass acceptance · silent successes · reversibility · tokens per ACCEPTED edit ·
 *   latency to done p95 · failure quality (explained share)
 *
 * A rate that drops by more than RATE_TOLERANCE, a silent success where the floor had
 * none, or tokens-per-accepted-edit rising by more than COST_TOLERANCE without a
 * first-pass gain, fails the gate. Latency is reported, never gated: one slow provider
 * evening is not a code regression. Per-case first-pass drops are listed so the operator
 * knows which verb moved.
 *
 * Usage:
 *   node scripts/golden-gate.mjs reports/golden/baseline/summary.json           # gate
 *   node scripts/golden-gate.mjs reports/golden/baseline/summary.json --write   # accept as floor
 *
 * Paths resolve against the REPOSITORY ROOT, like every other mission script.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const FLOOR = join(REPO, 'reports', 'golden', 'floor.json');
/** One turn out of ~20 flipping is noise on a small sample; more than that is a regression. */
const RATE_TOLERANCE = 0.05;
/** Same bar as mission-efficiency-gate.mjs. */
const COST_TOLERANCE = 0.1;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: golden-gate.mjs <summary.json> [--write]');
  process.exit(1);
}
const write = args.includes('--write');
const current = JSON.parse(readFileSync(resolve(REPO, file), 'utf8'));
if (!current?.summary?.perCase) {
  console.error(`${file} is not a golden summary (no .summary.perCase)`);
  process.exit(1);
}

if (write) {
  writeFileSync(
    FLOOR,
    `${JSON.stringify({ recordedAt: new Date().toISOString(), source: file, rateTolerance: RATE_TOLERANCE, costTolerance: COST_TOLERANCE, label: current.label, provider: current.provider, model: current.model, generatedAt: current.generatedAt, summary: current.summary }, null, 2)}\n`,
  );
  console.log(`wrote ${FLOOR.slice(REPO.length + 1)}`);
  process.exit(0);
}
if (!existsSync(FLOOR)) {
  console.error(`no golden floor at ${FLOOR.slice(REPO.length + 1)}; record one with --write`);
  process.exit(1);
}
const floor = JSON.parse(readFileSync(FLOOR, 'utf8'));
const was = floor.summary;
const now = current.summary;

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);
const num = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
let failed = 0;
const rows = [];

/** A share that must not fall. */
function rate(name, key) {
  const a = was[key];
  const b = now[key];
  let verdict = 'held';
  if (a === null || a === undefined || b === null || b === undefined) verdict = 'n/a';
  else if (b + RATE_TOLERANCE < a) { verdict = 'REGRESSION'; failed += 1; }
  else if (b > a) verdict = 'better';
  rows.push([name, pct(a), pct(b), verdict]);
}

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
  rows.push(['silent successes', String(a), String(b), verdict]);
}
{
  const a = was.tokensPerAcceptedEdit;
  const b = now.tokensPerAcceptedEdit;
  let verdict = 'held';
  if (a === null || a === undefined || b === null || b === undefined) verdict = 'n/a';
  else {
    const up = (b - a) / a;
    const earned = (now.firstPassAcceptance ?? 0) > (was.firstPassAcceptance ?? 0);
    if (up > COST_TOLERANCE && earned) verdict = 'costlier, but more edits accepted';
    else if (up > COST_TOLERANCE) { verdict = 'REGRESSION'; failed += 1; }
    else if (up < -0.01) verdict = 'cheaper';
  }
  rows.push(['tokens / accepted edit', num(a), num(b), verdict]);
}
{
  const a = was.usdPerAcceptedEdit;
  const b = now.usdPerAcceptedEdit;
  rows.push(['USD / accepted edit', a == null ? '—' : `$${a.toFixed(3)}`, b == null ? '—' : `$${b.toFixed(3)}`, 'reported']);
}
{
  const a = was.latency?.doneMs?.p95;
  const b = now.latency?.doneMs?.p95;
  const up = a && b ? (b - a) / a : null;
  rows.push(['done p95', a == null ? '—' : `${(a / 1000).toFixed(0)}s`, b == null ? '—' : `${(b / 1000).toFixed(0)}s`, up === null ? 'n/a' : up > 0.25 ? 'slower (not gated)' : 'reported']);
}
{
  const share = (s) => (s?.failureQuality?.failures ? s.failureQuality.explained / s.failureQuality.failures : null);
  rows.push(['failures explained', pct(share(was)), pct(share(now)), 'reported']);
}

console.log('| metric | floor | now | verdict |');
console.log('| --- | --- | --- | --- |');
for (const r of rows) console.log(`| ${r.join(' | ')} |`);

const caseRows = [];
for (const [id, c] of Object.entries(now.perCase)) {
  const prior = was.perCase?.[id];
  if (!prior) { caseRows.push([id, '—', pct(c.firstPass), 'new']); continue; }
  let verdict = 'held';
  if (c.firstPass + RATE_TOLERANCE < prior.firstPass) verdict = 'DROPPED';
  else if (c.firstPass > prior.firstPass) verdict = 'better';
  if (c.silentSuccesses > (prior.silentSuccesses ?? 0)) verdict += ' + silent success';
  caseRows.push([id, pct(prior.firstPass), pct(c.firstPass), verdict]);
}
console.log('\n| case | first-pass floor | now | verdict |');
console.log('| --- | --- | --- | --- |');
for (const r of caseRows) console.log(`| ${r.join(' | ')} |`);
const dropped = caseRows.filter((r) => r[3].startsWith('DROPPED'));
if (dropped.length) console.log(`\n${dropped.length} case(s) lost first-pass acceptance: ${dropped.map((r) => r[0]).join(', ')}`);

if (failed > 0) {
  console.error(`\n${failed} golden metric(s) regressed against ${FLOOR.slice(REPO.length + 1)} (floor from ${floor.generatedAt ?? floor.recordedAt})`);
  process.exit(2);
}
