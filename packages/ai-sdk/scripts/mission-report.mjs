#!/usr/bin/env node
/**
 * Summarize one or two mission-baseline JSON files as markdown (plan/system-mission).
 * Usage: node scripts/mission-report.mjs <baseline.json> [after.json]
 * Per scenario/turn: p50 over runs of model calls, prompt tokens, output tokens, cache share,
 * tool calls, repeated tool calls, ops, wall, USD, rubric score, and the failure share.
 */
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: mission-report.mjs <baseline.json> [after.json]'); process.exit(1); }
const load = (f) => JSON.parse(readFileSync(f, 'utf8'));
const p50 = (xs) => { const a = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const fmt = (v, d = 0) => (v === null || v === undefined ? '—' : typeof v === 'number' ? v.toFixed(d) : String(v));

function rows(data) {
  const byKey = new Map();
  for (const r of data.results) for (const t of r.turns) {
    const key = `${r.scenario} · t${t.turnIndex + 1}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }
  const out = [];
  for (const [key, turns] of byKey) {
    const m = (f) => p50(turns.map((t) => (t.metrics ? f(t.metrics) : NaN)));
    const crashed = turns.filter((t) => t.crashed).length;
    const failed = turns.filter((t) => t.metrics && t.metrics.finalStatus !== 'completed').length;
    out.push({
      key,
      runs: turns.length,
      calls: m((x) => x.modelCalls),
      prompt: m((x) => x.tokens.prompt ?? x.tokens.input + (x.tokens.cacheRead ?? 0)),
      out: m((x) => x.tokens.output),
      cache: m((x) => { const p = x.tokens.prompt ?? x.tokens.input + (x.tokens.cacheRead ?? 0); return p ? (x.tokens.cacheRead ?? 0) / p : NaN; }),
      tools: m((x) => x.toolCalls),
      repeats: m((x) => x.repeatedToolCalls),
      ops: m((x) => x.operations),
      wall: m((x) => x.wallMs / 1000),
      usd: m((x) => x.usd),
      score: p50(turns.map((t) => t.score ?? NaN)),
      notDone: `${failed + crashed}/${turns.length}`,
    });
  }
  return out;
}

const a = rows(load(files[0]));
const b = files[1] ? rows(load(files[1])) : null;
const cols = ['calls', 'prompt', 'out', 'cache', 'tools', 'repeats', 'ops', 'wall', 'usd', 'score', 'notDone'];
const digits = { cache: 2, wall: 0, usd: 2, score: 2 };
console.log(`| scenario · turn | runs | ${cols.join(' | ')} |`);
console.log(`| --- | --- | ${cols.map(() => '---').join(' | ')} |`);
for (const r of a) {
  const after = b?.find((x) => x.key === r.key);
  const cell = (c) => {
    const base = fmt(r[c], digits[c] ?? 0);
    if (!after) return base;
    return `${base} → ${fmt(after[c], digits[c] ?? 0)}`;
  };
  console.log(`| ${r.key} | ${r.runs}${after ? `/${after.runs}` : ''} | ${cols.map(cell).join(' | ')} |`);
}
