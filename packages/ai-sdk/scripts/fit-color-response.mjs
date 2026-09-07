#!/usr/bin/env node
/**
 * fit-color-response — measure what the renderer's grade parameters actually do.
 *
 * `packages/editor-core/src/color-solver.ts` inverts a first-order model of the
 * colour grade that was **derived from the renderer's source, not measured**
 * (`render/color.py` plus `analysis/shot_stats.py`). VU3.1 asks for the real
 * thing: render a grid of parameter values through the deterministic path,
 * measure every cell, and fit a response per parameter. That needs a running
 * sidecar and real render time, so it lives here as a dev script rather than in
 * the runtime.
 *
 * ## Running it
 *
 *   1. Start the sidecar:  `uv run framepilot serve`      (defaults to :8799)
 *   2. Pick a project with one long, well-exposed clip — `ref/colorchart.png` on
 *      a timeline is the cleanest, a mid-tone camera shot is the more honest.
 *   3. node packages/ai-sdk/scripts/fit-color-response.mjs \
 *        --project /abs/path/project.fp.json --clip c1 --time 1.0
 *
 * Options: `--sidecar <url>` (default http://127.0.0.1:8799), `--json` for the
 * raw grid, `--params exposure,contrast` to fit a subset.
 *
 * It prints, for each parameter, the fitted coefficient and the constant in
 * `color-solver.ts` to replace with it. Nothing is written to disk and nothing in
 * the runtime reads this file.
 *
 * ## What it measures, and the one thing it cannot
 *
 * Measurement goes through `POST /review/temporal-evidence` with a `scope`
 * request, which renders the composite at full resolution with captions off and
 * reports per-channel percentiles. Three honest caveats, because a fit that
 * quietly changes units is worse than no fit:
 *
 *  - **`scope` is not the ledger's chain.** The ledger's tier-0 pass runs
 *    ffmpeg `signalstats` on the ENCODED YUV of a 160px decode; `scope` computes
 *    Rec.709 luma and RGB percentiles on the composited float frame. Luma and the
 *    percentiles agree closely. Chroma does not: `scope`'s `saturation` channel is
 *    `max(rgb) - min(rgb)`, while the ledger's `satMean` is `sqrt(U^2+V^2)/181`.
 *    Both are linear in chroma magnitude, so the RATIO response fitted here
 *    transfers; an absolute value does not.
 *  - **Warmth is reconstructed, not read.** There is no U/V channel in `scope`,
 *    so warmth and green/magenta are computed from the red/blue/luma means through
 *    the same BT.709 matrix the solver assumes. That means this script CANNOT
 *    settle whether the ledger's chain is full-range BT.709 — the one assumption
 *    behind `WARMTH_PER_TEMPERATURE` that most deserves settling. Doing that needs
 *    a `signalstats` pass over a rendered file, which is a second script.
 *  - **One frame of one clip.** The response depends on the material, because
 *    every stage ends in a clamp. Run it on more than one fixture before believing
 *    a number, and record which fixture produced it.
 */
import { readFileSync } from 'node:fs';

const DEFAULT_SIDECAR = 'http://127.0.0.1:8799';

/**
 * BT.709 chroma divisors, matching `color-solver.ts`. Rec.709 luma weights are not
 * needed here: `scope` computes the luma channel with them already.
 */
const BT709_CB_DIVISOR = 1.8556;
const BT709_CR_DIVISOR = 1.5748;
const CHROMA_SCALE = 255 / 128;

/**
 * The grid, per parameter.
 *
 * `axis` names the fact the parameter is supposed to move; `model` is what the
 * solver currently believes, printed alongside the fit so a disagreement is
 * visible rather than buried in a diff.
 */
const GRID = {
  exposure: {
    values: [-2, -1.5, -1, -0.5, -0.25, 0.25, 0.5, 1, 1.5, 2],
    constant: 'EXPOSURE_RESPONSE',
    axis: 'log2(luma.mean) vs exposure',
  },
  contrast: {
    values: [-0.8, -0.6, -0.4, -0.2, 0.2, 0.4, 0.6, 0.8],
    constant: 'CONTRAST_RESPONSE',
    axis: '(p90 - p10) ratio vs (1 + contrast)',
  },
  saturation: {
    values: [-0.9, -0.6, -0.3, 0.3, 0.6, 1, 1.5, 2],
    constant: 'SATURATION_RESPONSE',
    axis: 'saturation-channel mean ratio vs (1 + saturation)',
  },
  temperature: {
    values: [-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1],
    constant: 'WARMTH_PER_TEMPERATURE / GREEN_MAGENTA_PER_TEMPERATURE',
    axis: 'warmth and green/magenta vs temperature, per unit luma',
  },
  tint: {
    values: [-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1],
    constant: 'WARMTH_PER_TINT / GREEN_MAGENTA_PER_TINT',
    axis: 'warmth and green/magenta vs tint, per unit luma',
  },
};

function parseArgs(argv) {
  const args = { sidecar: DEFAULT_SIDECAR, time: 1, json: false, params: Object.keys(GRID) };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[(i += 1)];
    if (flag === '--project') args.project = next();
    else if (flag === '--clip') args.clip = next();
    else if (flag === '--time') args.time = Number(next());
    else if (flag === '--sidecar') args.sidecar = next();
    else if (flag === '--params') args.params = next().split(',');
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

/** A copy of the project with exactly one `color_grade` effect on `clipId`. */
function projectWithGrade(project, clipId, params) {
  // JSON round-trip rather than structuredClone: the project document is plain JSON
  // by definition, and this keeps the script runnable on older Node.
  const copy = JSON.parse(JSON.stringify(project));
  let found = false;
  for (const track of copy.timeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.id !== clipId) continue;
      found = true;
      clip.effects = [
        ...(clip.effects ?? []).filter((effect) => effect.id !== 'fit__grade'),
        { id: 'fit__grade', type: 'color_grade', params },
      ];
    }
  }
  if (!found) throw new Error(`Clip "${clipId}" is not on this timeline.`);
  return copy;
}

/** Timeline frame index for a time in seconds, from the project's own fps. */
function frameAt(project, seconds) {
  const fps = project.timeline?.frameRate ?? project.timeline?.fps ?? 30;
  return Math.max(0, Math.round(seconds * fps));
}

async function measure(sidecar, project, frame, revision) {
  const body = {
    project,
    requests: [
      {
        schemaVersion: 1,
        requestId: `fit-${String(frame)}`,
        projectRevision: revision,
        reason: 'fit-color-response: measuring one graded frame',
        kind: 'scope',
        startFrame: frame,
        endFrame: frame + 1,
        channels: ['luma', 'red', 'green', 'blue', 'saturation'],
        legalMin: 0,
        legalMax: 1,
      },
    ],
  };
  const response = await fetch(`${sidecar}/review/temporal-evidence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`temporal-evidence ${String(response.status)}: ${await response.text()}`);
  }
  const batch = await response.json();
  const samples = batch.results?.[0]?.samples ?? [];
  if (samples.length === 0) {
    throw new Error(`No scope samples returned. Raw: ${JSON.stringify(batch).slice(0, 400)}`);
  }
  const byChannel = {};
  for (const sample of samples) byChannel[sample.channel] = sample;
  return byChannel;
}

/** The facts the solver reasons in, rebuilt from the scope channels. */
function facts(byChannel) {
  const mean = (channel) => byChannel[channel]?.mean ?? byChannel[channel]?.p50 ?? 0;
  const luma = mean('luma');
  const red = mean('red');
  const blue = mean('blue');
  const cr = (red - luma) / BT709_CR_DIVISOR;
  const cb = (blue - luma) / BT709_CB_DIVISOR;
  return {
    lumaMean: luma,
    p10: byChannel.luma?.p10 ?? 0,
    p90: byChannel.luma?.p90 ?? 0,
    contrastIdx: (byChannel.luma?.p90 ?? 0) - (byChannel.luma?.p10 ?? 0),
    satMean: mean('saturation'),
    warmth: CHROMA_SCALE * (cr - cb),
    greenMagenta: CHROMA_SCALE * (cr + cb),
  };
}

/** Least-squares slope of y on x through the origin — the response is a gain, not an offset. */
function slopeThroughOrigin(points) {
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += x * y;
    denominator += x * x;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function fit(parameter, baseline, cells) {
  const points = [];
  const secondary = [];
  for (const { value, measured } of cells) {
    if (parameter === 'exposure') {
      points.push([value, Math.log2(measured.lumaMean / baseline.lumaMean)]);
    } else if (parameter === 'contrast') {
      points.push([value, measured.contrastIdx / baseline.contrastIdx - 1]);
    } else if (parameter === 'saturation') {
      points.push([value, measured.satMean / baseline.satMean - 1]);
    } else {
      const perLuma = baseline.lumaMean === 0 ? 1 : baseline.lumaMean;
      points.push([value, (measured.warmth - baseline.warmth) / perLuma]);
      secondary.push([value, (measured.greenMagenta - baseline.greenMagenta) / perLuma]);
    }
  }
  return {
    primary: slopeThroughOrigin(points),
    secondary: secondary.length > 0 ? slopeThroughOrigin(secondary) : undefined,
    points,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project || !args.clip) {
    process.stdout.write(
      'usage: fit-color-response.mjs --project <project.fp.json> --clip <clipId>\n' +
        '                             [--time 1.0] [--sidecar http://127.0.0.1:8799]\n' +
        '                             [--params exposure,contrast,...] [--json]\n',
    );
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const project = JSON.parse(readFileSync(args.project, 'utf8'));
  const revision = project.timeline?.revision ?? 0;
  const frame = frameAt(project, args.time);

  const baseline = facts(
    await measure(args.sidecar, projectWithGrade(project, args.clip, {}), frame, revision),
  );
  if (baseline.contrastIdx <= 0 || baseline.satMean <= 0) {
    process.stderr.write(
      'WARNING: the ungraded frame has no contrast or no chroma. The contrast and\n' +
        'saturation fits will be meaningless on this fixture — pick another frame.\n',
    );
  }

  const report = { fixture: args.project, clip: args.clip, frame, baseline, fits: {} };
  for (const parameter of args.params) {
    const grid = GRID[parameter];
    if (grid === undefined) throw new Error(`No grid for "${parameter}".`);
    const cells = [];
    for (const value of grid.values) {
      const graded = projectWithGrade(project, args.clip, { [parameter]: value });
      cells.push({ value, measured: facts(await measure(args.sidecar, graded, frame, revision)) });
    }
    report.fits[parameter] = {
      ...fit(parameter, baseline, cells),
      constant: grid.constant,
      axis: grid.axis,
    };
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `\nfit-color-response — ${args.project} clip ${args.clip} frame ${String(frame)}\n`,
  );
  process.stdout.write(
    `baseline luma.mean=${baseline.lumaMean.toFixed(4)} contrastIdx=${baseline.contrastIdx.toFixed(4)} satMean=${baseline.satMean.toFixed(4)} warmth=${baseline.warmth.toFixed(4)}\n\n`,
  );
  for (const [parameter, result] of Object.entries(report.fits)) {
    process.stdout.write(`${parameter}\n`);
    process.stdout.write(`  ${result.axis}\n`);
    process.stdout.write(`  fitted: ${result.primary.toFixed(5)}`);
    if (result.secondary !== undefined) process.stdout.write(` / ${result.secondary.toFixed(5)}`);
    process.stdout.write(`\n  paste into color-solver.ts as: ${result.constant}\n\n`);
  }
  process.stdout.write(
    'Record the fixture and its content hash next to whatever you paste. A coefficient\n' +
      'without the material it was measured on is the same guess it replaced.\n',
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
