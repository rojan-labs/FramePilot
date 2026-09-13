/**
 * Audit a saved `.fp.json` project's FINAL state for structural defects.
 *
 * WHY this exists: the patch validator checks each operation as it is applied, but
 * nothing re-checks a project file that has been saved, hand-edited, migrated, or
 * round-tripped through a crash-recovery snapshot. This reads the file as shipped.
 *
 * It deliberately imports the engine's own `clipTimelineDuration` rather than
 * reimplementing the speed/ramp arithmetic: a linter that disagrees with the engine
 * is worse than no linter, because it reports defects the renderer does not have.
 *
 * Usage: node scripts/audit-project.mjs <project.fp.json> [more.fp.json ...]
 * Exits non-zero if any ERROR-severity issue is found (warnings do not fail).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const enginePath = resolve(here, '../packages/editor-core/dist/speed-curve.js');
let clipTimelineDuration;
try {
  ({ clipTimelineDuration } = await import(enginePath));
} catch {
  console.error(
    `Cannot load the timeline engine from ${enginePath}.\n` +
      'Build it first:  pnpm --filter @framepilot/editor-core build',
  );
  process.exit(2);
}

const SPEED_EPSILON = 1e-6;
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/audit-project.mjs <project.fp.json> [...]');
  process.exit(2);
}
let totalErrors = 0;
for (const file of files) totalErrors += auditOne(file);
process.exit(totalErrors > 0 ? 1 : 0);

function auditOne(file) {
const d = JSON.parse(readFileSync(file, 'utf8'));
const issues = [];
const add = (sev, code, msg) => issues.push({ sev, code, msg });

const assets = new Map(d.assets.map((a) => [a.id, a]));

for (const t of d.timeline.tracks) {
  const clips = [...t.clips].sort((a, b) => a.start - b.start);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const tl = c.end - c.start;

    // 1. speed/duration invariant, via the engine's own function
    const expected = clipTimelineDuration(c);
    if (expected !== null && Math.abs(tl - expected) > 1e-3) {
      add('error', 'speed_duration_mismatch',
        `${t.id}/${c.id}: timeline ${tl.toFixed(4)}s vs implied ${expected.toFixed(4)}s`);
    }

    // 2. source range beyond the asset
    const a = assets.get(c.assetId);
    if (a?.durationSeconds != null && c.sourceEnd > a.durationSeconds + 1e-6) {
      add('error', 'source_overrun',
        `${t.id}/${c.id}: sourceEnd ${c.sourceEnd} > asset duration ${a.durationSeconds}`);
    }
    if (c.sourceStart < -1e-9) add('error', 'negative_source', `${t.id}/${c.id}`);
    if (tl <= 0) add('error', 'zero_duration', `${t.id}/${c.id}`);

    // 3. overlap / gap on the same track
    if (i > 0) {
      const p = clips[i - 1];
      if (c.start < p.end - 1e-6) {
        add('error', 'overlap', `${t.id}: ${p.id} ends ${p.end.toFixed(3)} but ${c.id} starts ${c.start.toFixed(3)}`);
      } else if (c.start > p.end + 1e-6) {
        add('warn', 'gap', `${t.id}: ${(c.start - p.end).toFixed(3)}s hole after ${p.id} at ${p.end.toFixed(3)}s`);
      }
    }

    // 4. frame-grid alignment (fps)
    const fps = d.fps;
    for (const [name, v] of [['start', c.start], ['end', c.end]]) {
      const frames = v * fps;
      if (Math.abs(frames - Math.round(frames)) > 1e-4) {
        add('warn', 'off_grid', `${t.id}/${c.id}: ${name}=${v} is ${(frames % 1).toFixed(4)} of a frame off the ${fps}fps grid`);
      }
    }

    // 5. ramp points beyond the source span
    if (c.speedRamp?.length) {
      const span = c.sourceEnd - c.sourceStart;
      for (const pt of c.speedRamp) {
        if (pt.sourceTime < -SPEED_EPSILON || pt.sourceTime > span + SPEED_EPSILON) {
          add('error', 'invalid_speed', `${t.id}/${c.id}: ramp point at sourceTime ${pt.sourceTime} outside span ${span.toFixed(3)}`);
        }
      }
    }
  }
}

const errs = issues.filter((i) => i.sev === 'error');
const warns = issues.filter((i) => i.sev === 'warn');
console.log(`\n### ${file.split('/').pop()}  — ${errs.length} errors, ${warns.length} warnings`);
const byCode = {};
for (const i of issues) (byCode[i.code] ??= []).push(i);
for (const [code, list] of Object.entries(byCode)) {
  console.log(`  [${list[0].sev}] ${code} x${list.length}`);
  for (const i of list.slice(0, 6)) console.log(`      ${i.msg}`);
  if (list.length > 6) console.log(`      ... ${list.length - 6} more`);
}
return errs.length;
}
