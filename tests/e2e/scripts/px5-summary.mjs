#!/usr/bin/env node
/**
 * PX5: turn `tests/e2e/.tmp-px5-scale/results/*.json` into a Markdown table (the CI job
 * summary, and the source of the tables in `plan/background-removal-ai/PX5-BUDGETS.md`).
 *
 *   node tests/e2e/scripts/px5-summary.mjs [resultsDir]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = process.argv[2] ?? join(HERE, '..', '.tmp-px5-scale', 'results');

const ms = (value) => (typeof value === 'number' ? value.toFixed(1) : '-');
const mb = (bytes) => (typeof bytes === 'number' ? (bytes / 1024 / 1024).toFixed(0) : '-');
const read = (name) => JSON.parse(readFileSync(join(RESULTS, name), 'utf8'));

const lines = [];
const runs = readdirSync(RESULTS)
  .filter((name) => /^scale.*\.(proxy|original)\.json$/.test(name))
  .map(read);
if (runs.length > 0) {
  lines.push(`### PX5 Scale row (${runs[0].gl})`, '');
  lines.push(
    '| variant | media | dropped | lowest scale | frame interval p95 | composite p50/p95 | seek p50/p95 | step composite p50 | mask raster p95 | decode p50 | cache peak MB | GL pool MB | decoders peak |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const run of runs) {
    const playback = run.playback;
    lines.push(
      `| ${run.variant} | ${run.mode} | ${playback.droppedFrames}/${playback.expectedFrames} ` +
        `(${(playback.droppedShare * 100).toFixed(2)}%) | ${playback.lowestRenderScale} | ` +
        `${ms(run.frameInterval.p95)} | ${ms(run.composite.p50)}/${ms(run.composite.p95)}` +
        `${run.gpuSync ? ' (GPU sync)' : ''} | ` +
        `${ms(run.seekToPresent.p50)}/${ms(run.seekToPresent.p95)} | ` +
        `${ms(run.stepExactComposite?.p50)} | ${ms(run.maskRaster.p95)} | ${ms(run.decode.p50)} | ` +
        `${mb(run.gauges.pictureCacheBytes.peak)} | ${mb(run.gauges.glPoolBytes.peak)} | ` +
        `${run.gauges.liveDecoders.peak} |`,
    );
  }
  lines.push('');
}
if (existsSync(join(RESULTS, 'export-ratio.json'))) {
  const ratio = read('export-ratio.json');
  lines.push(
    `### Export, masks + 4K matte vs without (${ratio.machine}, ${ratio.windowSeconds} s window)`,
    '',
    `plain ${ratio.runs['scale-plain'].seconds} s, with the matte ${ratio.runs.scale.seconds} s: ` +
      `**${ratio.ratio}x** (budget ${ratio.budget}x)`,
    '',
  );
}
if (existsSync(join(RESULTS, 'pts-probe.json'))) {
  const probe = read('pts-probe.json');
  lines.push(`### pts probe (${probe.machine})`, '');
  for (const name of ['camera', 'long']) {
    const row = probe[name];
    if (!row) continue;
    lines.push(
      `- ${name}: ${(row.bytes / 1e9).toFixed(2)} GB, ${row.frames} packets: ` +
        `${row.firstCallSeconds} s first call, ${(row.cachedCallSeconds * 1000).toFixed(2)} ms cached`,
    );
  }
  lines.push('');
}
console.log(lines.join('\n'));
