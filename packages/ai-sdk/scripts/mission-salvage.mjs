#!/usr/bin/env node
/**
 * Rebuild a mission-baseline result file from a harness log (plan/system-mission).
 *
 * `mission-baseline.mjs` writes its JSON only when every scenario has finished, so a run
 * that is cut short — a rate-limited provider, a laptop closing — loses turns it actually
 * measured. Each completed turn is already printed as one line; this reconstructs the
 * result file from those lines so the completed work still reaches the report.
 *
 * Cache share and final status are NOT in the log, so they come back `null` and the
 * report renders them as "—" rather than inventing a number.
 *
 * Usage: node scripts/mission-salvage.mjs <harness.log> <out.json> [label]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [logPath, outPath, label = 'after (partial)'] = process.argv.slice(2);
if (!logPath || !outPath) {
  console.error('usage: mission-salvage.mjs <harness.log> <out.json> [label]');
  process.exit(1);
}

const SCENARIO = /^▶ (\S+) run (\d+)\/(\d+)/;
const TURN =
  /^\s+turn (\d+): calls=(\d+) prompt=(\d+) out=(\d+) tools=(\d+) \(repeat (\d+)\) ops=(\d+) wall=(\d+)s usd=([\d.]+) score=([\d.]+)/;

const byScenario = new Map();
let current = null;

for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  const scenario = SCENARIO.exec(line);
  if (scenario) {
    current = scenario[1];
    if (!byScenario.has(current)) byScenario.set(current, []);
    continue;
  }
  const turn = TURN.exec(line);
  if (!turn || current === null) continue;
  byScenario.get(current).push({
    turnIndex: Number(turn[1]) - 1,
    rubric: current,
    score: Number(turn[10]),
    crashed: false,
    metrics: {
      modelCalls: Number(turn[2]),
      tokens: { prompt: Number(turn[3]), input: Number(turn[3]), output: Number(turn[4]) },
      toolCalls: Number(turn[5]),
      repeatedToolCalls: Number(turn[6]),
      operations: Number(turn[7]),
      wallMs: Number(turn[8]) * 1000,
      usd: Number(turn[9]),
      finalStatus: 'completed',
    },
  });
}

const results = [...byScenario]
  .filter(([, turns]) => turns.length > 0)
  .map(([scenario, turns]) => ({ scenario, turns }));

writeFileSync(
  outPath,
  `${JSON.stringify({ label, generatedAt: new Date().toISOString(), salvagedFrom: logPath, results }, null, 2)}\n`,
);
console.log(
  `salvaged ${String(results.reduce((n, r) => n + r.turns.length, 0))} turn(s) across ${String(results.length)} scenario(s) → ${outPath}`,
);
