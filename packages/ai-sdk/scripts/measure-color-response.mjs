#!/usr/bin/env node
/**
 * measure-color-response — the second script `color-solver.ts` asks for.
 *
 * ## What it settles that the first script cannot
 *
 * `fit-color-response.mjs` measures a graded frame through `/review/temporal-evidence`,
 * which reports Rec.709 luma and RGB percentiles on the composited float frame, and then
 * reconstructs warmth from RGB through the SAME BT.709 matrix `color-solver.ts` assumes.
 * That is why its most interesting result — `WARMTH_PER_TEMPERATURE` measuring ~0.59
 * against the derived 0.6936, a repeatable ~15% under-shoot — could not be acted on: a
 * wrong matrix and a shallower temperature curve produce the identical disagreement, and
 * a measurement made through the assumption cannot tell them apart.
 *
 * This script closes that by measuring the RENDERED FILE with the ledger's own chain:
 * ffmpeg `signalstats` over the encoded YUV, which is exactly what tier-0 enrolment runs
 * (`engine/python/framepilot_engine/analysis/shot_stats.py#measure_asset`). The warmth it
 * reports is the warmth the FACTS carry, in the units `color-solver.ts` solves in, with no
 * reconstruction step in between. If the two scripts still disagree, the matrix is wrong;
 * if they agree and both sit under the derived value, the renderer's curve is shallower
 * and the constant should move.
 *
 * ## Running it
 *
 *   1. Start the sidecar:  `uv run framepilot serve`      (defaults to :8799)
 *   2. Point it at a SHORT single-clip project — every grid cell renders the whole
 *      timeline, so a minute of footage is a minute per cell.
 *   3. node packages/ai-sdk/scripts/measure-color-response.mjs \
 *        --project /abs/path/project.fp.json --clip c1
 *
 * Options: `--sidecar <url>`, `--params temperature,tint`, `--json`, `--python "<cmd>"`
 * (default `uv run python`, run from the repo root).
 *
 * Nothing is written back into the runtime: it prints what it measured and what
 * `color-solver.ts` currently believes, side by side. Changing a constant is a human
 * decision, recorded in that file's docstring and TESTING_PLAN.md T16.4.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SIDECAR = 'http://127.0.0.1:8799';

/**
 * The parameter grid, and what each cell is evidence about.
 *
 * Deliberately the same values `fit-color-response.mjs` uses: the whole point is that the
 * two scripts measure the same grid through different chains, so a difference between
 * them is a fact about the chains and not about the sampling.
 */
const GRID = {
  temperature: {
    values: [-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1],
    constants: ['WARMTH_PER_TEMPERATURE', 'GREEN_MAGENTA_PER_TEMPERATURE'],
    derived: [0.6936, -0.0411],
  },
  tint: {
    values: [-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1],
    constants: ['WARMTH_PER_TINT', 'GREEN_MAGENTA_PER_TINT'],
    derived: [-0.0429, -0.5236],
  },
};

function parseArgs(argv) {
  const args = {
    sidecar: DEFAULT_SIDECAR,
    json: false,
    params: Object.keys(GRID),
    python: 'uv run python',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[(i += 1)];
    if (flag === '--project') args.project = next();
    else if (flag === '--clip') args.clip = next();
    else if (flag === '--sidecar') args.sidecar = next();
    else if (flag === '--params') args.params = next().split(',');
    else if (flag === '--python') args.python = next();
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

/** A copy of the project with exactly one `color_grade` effect on `clipId`. */
function projectWithGrade(project, clipId, params) {
  const copy = JSON.parse(JSON.stringify(project));
  let found = false;
  for (const track of copy.timeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.id !== clipId) continue;
      found = true;
      clip.effects = [
        ...(clip.effects ?? []).filter((effect) => effect.id !== 'measure__grade'),
        { id: 'measure__grade', type: 'color_grade', params },
      ];
    }
  }
  if (!found) throw new Error(`Clip "${clipId}" is not on this timeline.`);
  return copy;
}

/**
 * Render one graded project to a file through the real pipeline.
 *
 * `/render/preview` rather than `/render`: it is synchronous, it goes through the same
 * compiler and the same `render/color.py` grade, and a downscale changes no colour. A
 * queued export would be the same measurement with polling bolted on.
 */
async function render(sidecar, projectPath) {
  const response = await fetch(`${sidecar}/render/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath, burnCaptions: false }),
  });
  if (!response.ok) {
    throw new Error(`render/preview ${String(response.status)}: ${await response.text()}`);
  }
  const job = await response.json();
  const output = job.outputPath ?? job.output_path;
  if (!output) {
    throw new Error(`Render produced no file: ${job.error ?? JSON.stringify(job).slice(0, 300)}`);
  }
  return output;
}

/**
 * Measure a rendered file with THE LEDGER'S OWN CHAIN.
 *
 * `measure_asset` is what tier-0 enrolment calls, so what comes back here is
 * byte-for-byte the kind of fact `color-solver.ts` reads at runtime — `warmth` in its own
 * -1..1 units, `satMean` in the ledger's, computed off the encoded YUV rather than
 * reconstructed from RGB. That is the whole reason this script exists.
 */
function measureWithLedgerChain(python, file, durationSeconds) {
  const program = [
    'import json,sys',
    'from pathlib import Path',
    'from framepilot_engine.analysis.shot_stats import measure_asset',
    `stats = measure_asset(Path(${JSON.stringify(file)}), duration=${String(durationSeconds)})`,
    'rows = [{"lumaMean": s.luma_mean, "p10": s.luma_p10, "p90": s.luma_p90,',
    '         "contrastIdx": s.contrast_idx, "satMean": s.sat_mean, "warmth": s.warmth}',
    '        for s in stats]',
    'json.dump(rows, sys.stdout)',
  ].join('\n');
  const [command, ...prefix] = python.split(' ');
  const stdout = execFileSync(command, [...prefix, '-c', program], { encoding: 'utf8' });
  const rows = JSON.parse(stdout);
  if (rows.length === 0) throw new Error(`No shots measured in ${file}.`);
  // The whole render is one graded clip, so the shots are samples of one measurement:
  // average them rather than trusting whichever one the detector split first.
  const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  return {
    lumaMean: mean('lumaMean'),
    contrastIdx: mean('contrastIdx'),
    satMean: mean('satMean'),
    warmth: mean('warmth'),
  };
}

/** Least-squares slope through the origin — the response is a gain, not an offset. */
function slopeThroughOrigin(points) {
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += x * y;
    denominator += x * x;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Project duration, so the measurement pass knows how long the rendered file is. */
function timelineDuration(project) {
  let end = 0;
  for (const track of project.timeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) end = Math.max(end, clip.end ?? 0);
  }
  if (end <= 0) throw new Error('This project has no clips to render.');
  return end;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project || !args.clip) {
    process.stdout.write(
      'usage: measure-color-response.mjs --project <project.fp.json> --clip <clipId>\n' +
        '                                  [--sidecar http://127.0.0.1:8799]\n' +
        '                                  [--params temperature,tint] [--json]\n' +
        '                                  [--python "uv run python"]\n',
    );
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const project = JSON.parse(readFileSync(args.project, 'utf8'));
  const duration = timelineDuration(project);
  const workspace = mkdtempSync(join(tmpdir(), 'measure-color-'));
  const renderAndMeasure = async (params, label) => {
    const path = join(workspace, `${label}.fp.json`);
    writeFileSync(path, JSON.stringify(projectWithGrade(project, args.clip, params)));
    return measureWithLedgerChain(args.python, await render(args.sidecar, path), duration);
  };

  const baseline = await renderAndMeasure({}, 'baseline');
  const results = {};
  for (const parameter of args.params) {
    const spec = GRID[parameter];
    if (!spec) throw new Error(`Unknown parameter "${parameter}".`);
    const warmthPoints = [];
    const greenMagentaPoints = [];
    for (const value of spec.values) {
      const measured = await renderAndMeasure({ [parameter]: value }, `${parameter}_${value}`);
      // Per unit luma, exactly as `color-solver.ts` models it: the chroma shift a grade
      // produces scales with how much light there is to shift.
      const perLuma = baseline.lumaMean === 0 ? 1 : baseline.lumaMean;
      warmthPoints.push([value, (measured.warmth - baseline.warmth) / perLuma]);
      // The ledger's `warmth` is the only chroma axis `measure_asset` reports, so the
      // green/magenta arm is left to the RGB script rather than invented here.
      greenMagentaPoints.push([value, 0]);
    }
    results[parameter] = {
      warmth: slopeThroughOrigin(warmthPoints),
      points: warmthPoints,
      constants: spec.constants,
      derived: spec.derived,
    };
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ baseline, results }, null, 2)}\n`);
    return;
  }
  process.stdout.write('Measured through the ledger chain (signalstats over the render)\n\n');
  for (const [parameter, result] of Object.entries(results)) {
    process.stdout.write(
      `${parameter}: ${result.constants[0]} measures ${result.warmth.toFixed(4)} ` +
        `against ${String(result.derived[0])} derived\n`,
    );
  }
  process.stdout.write(
    '\nCompare with `fit-color-response.mjs` on the same clip. Agreement means the ' +
      'renderer’s curve is shallower than the derivation and the constant should move; ' +
      'disagreement means the BT.709 reconstruction in that script is what differs.\n',
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
