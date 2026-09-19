#!/usr/bin/env node
// Summarise a PX4 parity-oracle run (tests/e2e/.tmp-px4-parity/results/*.json, written by
// specs/preview-parity-oracle.spec.ts) into:
//   - a Markdown table (stdout) for plan/background-removal-ai/PX4-BASELINE.md, and
//   - with --write-baseline, tests/e2e/fixtures/preview-parity-baseline.json: the failing
//     checks per case, which the spec marks test.fail().
//
// The baseline is only ever regenerated from a real run. The spec fails when a listed check
// starts passing, so the list shrinks as PX2 lands; nothing adds to it except a deliberate,
// reviewed regeneration.
//
// Known failures are kept per renderer class (the `rendererClass` every result records: the
// spec's `rendererClass()`, `swiftshader-subzero` | `swiftshader-llvm` | `gpu`), because a
// failure is only known where it was measured. A regeneration replaces the entry of the class
// the run was measured on and leaves every other class as it was.
//
// Usage: node tests/e2e/scripts/px4-baseline.mjs [--write-baseline]

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', '.tmp-px4-parity', 'results');
const BASELINE = join(HERE, '..', 'fixtures', 'preview-parity-baseline.json');
const CHECKS = ['renderer', 'pixels', 'sentinel', 'pts'];
const COLOUR_TOLERANCE = 8;

if (!existsSync(RESULTS)) {
  process.stderr.write(`No results at ${RESULTS}; run the preview-parity project first.\n`);
  process.exit(1);
}

const readBaseline = () => {
  if (!existsSync(BASELINE)) return { renderers: {} };
  const parsed = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (parsed.renderers === undefined) {
    process.stderr.write(`${BASELINE} predates per-renderer entries; migrate it by hand first.\n`);
    process.exit(1);
  }
  return parsed;
};

const cases = readdirSync(RESULTS)
  .filter((name) => name.endsWith('.json') && name !== 'px03-colour.json')
  .map((name) => JSON.parse(readFileSync(join(RESULTS, name), 'utf8')))
  .sort((a, b) => a.key.localeCompare(b.key));

const colourPath = join(RESULTS, 'px03-colour.json');
const colour = existsSync(colourPath) ? JSON.parse(readFileSync(colourPath, 'utf8')) : null;
// One run is one browser: every result must name the same renderer class.
const classes = new Set([
  ...cases.map((result) => result.rendererClass),
  ...(colour?.measurements ?? []).map((m) => m.rendererClass),
]);
if (classes.size !== 1 || classes.has(undefined)) {
  process.stderr.write(
    `Results name renderer classes ${JSON.stringify([...classes])}; expected exactly one. ` +
      'Re-run the preview-parity project with the current spec.\n',
  );
  process.exit(1);
}
const [runClass] = classes;

const fmt = (value, digits) =>
  value === null || value === undefined
    ? 'n/a'
    : value === Infinity
      ? 'inf'
      : Number(value).toFixed(digits);

const failingChecks = (result) =>
  CHECKS.filter((check) => result.samples.some((sample) => sample.failures[check]));

const lines = [
  '| Case | Renderer | Samples | Min PSNR (dB) | Min % within 8/255 | Failing checks | First failure per check |',
  '| --- | --- | --- | --- | --- | --- | --- |',
];
const baselineCases = {};
const summary = {};
let passing = 0;
for (const result of cases) {
  const failing = failingChecks(result);
  if (failing.length === 0) passing++;
  else baselineCases[result.key] = failing;
  const psnrs = result.samples
    .map((s) => s.psnr)
    .filter((v) => v !== null)
    .map(Number);
  const within = result.samples.map((s) => s.withinFraction).filter((v) => v !== null);
  summary[result.key] = {
    renderer: result.renderer,
    minPsnr: psnrs.length
      ? Math.min(...psnrs) === Infinity
        ? 'Infinity'
        : Number(Math.min(...psnrs).toFixed(2))
      : null,
    minWithinPercent: within.length ? Number((Math.min(...within) * 100).toFixed(3)) : null,
    failing,
  };
  const renderer =
    result.renderer === 'dom' ? 'DOM' : result.renderer === 'webcodecs' ? 'WebCodecs' : 'error';
  const first = failing
    .map((check) => {
      const sample = result.samples.find((s) => s.failures[check]);
      const reason = String(sample.failures[check]).replace(/\|/g, '/');
      return `**${check}** t=${sample.time}: ${reason.length > 160 ? `${reason.slice(0, 157)}...` : reason}`;
    })
    .join('<br>');
  lines.push(
    `| \`${result.key}\` | ${renderer} | ${result.samples.length} | ${psnrs.length ? fmt(Math.min(...psnrs), 2) : 'n/a'} | ${
      within.length ? fmt(Math.min(...within) * 100, 3) : 'n/a'
    } | ${failing.join(', ') || 'none'} | ${first || ''} |`,
  );
}

const baselineColour = {};
const colourLines = [];
if (colour !== null) {
  colourLines.push(
    '| Encoding | Patch | Authored | Engine | Preview canvas2d | WebGL texture | max err canvas2d | max err webgl |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const m of colour.measurements) {
    const failing = [];
    for (const path of ['canvas2d', 'webgl']) {
      const worst = m[path]
        ? Math.max(
            ...m[path].map((rgb, i) =>
              Math.max(...rgb.map((v, c) => Math.abs(v - m.engine[i][c]))),
            ),
          )
        : Infinity;
      if (worst > COLOUR_TOLERANCE) failing.push(path);
    }
    if (failing.length) baselineColour[m.encoding] = failing;
    colour.patches.forEach((patch, i) => {
      const err = (path) =>
        m[path]
          ? fmt(Math.max(...m[path][i].map((v, c) => Math.abs(v - m.engine[i][c]))), 1)
          : 'n/a';
      const rgb = (v) => (v ? v.map((x) => fmt(x, 1)).join(', ') : 'n/a');
      colourLines.push(
        `| ${m.encoding} | ${patch.name} | ${patch.authored.join(', ')} | ${rgb(m.engine[i])} | ${rgb(m.canvas2d?.[i])} | ${rgb(
          m.webgl?.[i],
        )} | ${err('canvas2d')} | ${err('webgl')} |`,
      );
    });
    colourLines.push(
      `| ${m.encoding} | _Chromium colorSpace_ | | | | ${JSON.stringify(m.chromiumColorSpace ?? null).replace(/\|/g, '/')} | ${
        m.error ?? ''
      } | |`,
    );
  }
}

process.stdout.write(
  `**${cases.length} cases on \`${runClass}\`:** ${passing} pass every check, ${cases.length - passing} fail at least one.\n\n${lines.join('\n')}\n\n${colourLines.join('\n')}\n`,
);

if (process.argv.includes('--write-baseline')) {
  const baseline = readBaseline();
  const renderers = { ...baseline.renderers };
  renderers[runClass] = { cases: baselineCases, colour: baselineColour, summary };
  const sorted = Object.fromEntries(
    Object.keys(renderers)
      .sort()
      .map((klass) => [klass, renderers[klass]]),
  );
  writeFileSync(BASELINE, `${JSON.stringify({ renderers: sorted }, null, 2)}\n`);
  process.stderr.write(`wrote ${BASELINE} (${runClass})\n`);
}
