#!/usr/bin/env node
/**
 * Build the call ledger (plan/system-mission P0.2/P1.1) from a dumped event stream
 * (`mission-baseline.mjs --dump-events`). One row per model request: stage, prompt
 * composition, what the model did with it (tool calls with their inputs, edits), and the
 * output size — so each request can be classified: keep / deterministic / cache /
 * parallel / less-context / structured-state.
 *
 * Usage: node scripts/mission-ledger.mjs reports/system-mission/runs/<file>.json [--md]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const events = JSON.parse(readFileSync(file, 'utf8'));
const calls = [];
let current = null;
let stage = '?';
let lastToolByCallId = new Map();
for (const e of events) {
  if (e.type === 'run_state' || e.type === 'status') {
    const s = e.working?.stage ?? e.stage ?? e.status?.stage;
    if (typeof s === 'string') stage = s;
  }
  if (e.type === 'context_usage' && e.estimated) {
    current = { n: calls.length + 1, stage, ctx: e.manifest?.sections?.map((s) => `${s.type}:${s.tokens}`).join(' ') ?? '', used: e.usedTokens, tools: [], edits: [], reasoning: '', text: '', out: null, cached: null };
    calls.push(current);
    continue;
  }
  if (!current) continue;
  if (e.type === 'context_usage' && !e.estimated) {
    current.reported = e.usedTokens;
    current.cached = e.manifest?.usage?.cachedInputTokens ?? null;
    current.out = e.manifest?.usage?.providerReportedOutputTokens ?? null;
  }
  if (e.type === 'reasoning') current.reasoning += (e.summaries ?? []).join(' / ').slice(0, 200);
  if (e.type === 'assistant_message') current.text += String(e.text ?? '').slice(0, 200);
  if (e.type === 'tool_call') { const t = { name: e.toolName, status: e.status, args: e.argsSummary ?? '', input: '', ms: e.runtimeMs ?? null, id: e.id }; current.tools.push(t); lastToolByCallId.set(e.id, t); }
  if (e.type === 'tool_result') { const t = lastToolByCallId.get(e.toolCallId); if (t) { t.input = String(e.input ?? '').slice(0, 160); t.result = String(e.summary ?? e.result ?? '').slice(0, 120); } }
  if (e.type === 'diff') current.edits.push(`${e.edit?.valid ? 'valid' : 'INVALID'}:${(e.edit?.ops ?? []).join('+')}`);
}
const md = process.argv.includes('--md');
if (md) {
  console.log('| # | stage | prompt (est→reported, cached) | out | tools (input) | edits | model text |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of calls) {
    const tools = c.tools.map((t) => `${t.name}(${t.input || t.args})`).join('<br>');
    console.log(`| ${c.n} | ${c.stage} | ${c.used}→${c.reported ?? '?'}, c${c.cached ?? '?'} | ${c.out ?? '?'} | ${tools} | ${c.edits.join('<br>')} | ${(c.reasoning || c.text).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 120)} |`);
  }
} else {
  for (const c of calls) {
    console.log(`#${c.n} [${c.stage}] prompt ${c.used}→${c.reported ?? '?'} cached ${c.cached ?? '?'} out ${c.out ?? '?'}  ctx: ${c.ctx}`);
    for (const t of c.tools) console.log(`    ${t.name} ${t.status} ${t.ms ?? ''}ms  ${t.input || t.args}  → ${t.result ?? ''}`);
    for (const d of c.edits) console.log(`    EDIT ${d}`);
    if (c.reasoning || c.text) console.log(`    text: ${(c.reasoning || c.text).replace(/\n/g, ' ').slice(0, 160)}`);
  }
}
console.log(`\n${calls.length} model requests, ${calls.reduce((s, c) => s + c.tools.length, 0)} tool calls, ${calls.reduce((s, c) => s + c.edits.length, 0)} diffs`);
