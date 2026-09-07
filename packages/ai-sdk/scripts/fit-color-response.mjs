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
 * Below these the frame has too little spread for a RATIO fit to mean anything.
 *
 * Both fits divide by the baseline, so a near-black, near-monochrome frame divides a small
 * difference by a small number and returns noise — or a sign flip. Set from measurement,
 * not taste: `mission-montage` clip_004 sits at contrastIdx 0.137 / satMean 0.042 and fits
 * contrast at -0.251, while clip_001 and clip_002 (0.686 / 0.461) fit 0.79 and 0.96.
 */
const LOW_CONTRAST = 0.25;
const LOW_SATURATION = 0.06;

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
  const args = { sidecar: DEFAULT_SIDECAR, json: false, params: Object.keys(GRID) };
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

/**
 * Timeline frame index for a time in seconds, from the project's own fps.
 *
 * `fps` is a TOP-LEVEL field of the project document, not a member of `timeline`. Reading
 * it from `timeline` found nothing and silently fell back to 30, so on any project that is
 * not 30fps every measured frame was the wrong one.
 */
function frameAt(project, seconds) {
  const fps = project.fps ?? project.timeline?.frameRate ?? project.timeline?.fps ?? 30;
  return Math.max(0, Math.round(seconds * fps));
}

/** The clip's own timeline span, so a frame can be checked against the clip being graded. */
function clipSpan(project, clipId) {
  for (const track of project.timeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.id === clipId) return { start: clip.start, end: clip.end };
    }
  }
  return null;
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
        '                             [--time <s, default: the clip midpoint>]\n' +
        '                             [--sidecar http://127.0.0.1:8799]\n' +
        '                             [--params exposure,contrast,...] [--json]\n',
    );
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const project = JSON.parse(readFileSync(args.project, 'utf8'));
  const revision = project.timeline?.revision ?? 0;

  // MEASURE A FRAME THE GRADED CLIP IS ACTUALLY ON.
  //
  // `--clip` and `--time` were independent, and nothing checked that the time fell inside
  // the clip. Grade clip_002, measure t=1s while clip_001 is on screen, and every cell of
  // the grid measures the same ungraded frame: identical numbers, a least-squares slope of
  // exactly 0, and a confident instruction to paste `0.00000` into `color-solver.ts` as
  // `EXPOSURE_RESPONSE`. A zero response means "this parameter does nothing", which would
  // make the solver ask for an unbounded parameter to move anything. Measured on
  // `mission-montage`: clip_002 runs 39.8–61.4s, and the documented example `--time 1.0`
  // sits in clip_001. So the time now defaults to the clip's own midpoint and is refused
  // when it falls outside.
  const span = clipSpan(project, args.clip);
  if (span === null) throw new Error(`Clip "${args.clip}" is not on this timeline.`);
  const time = args.time ?? (span.start + span.end) / 2;
  if (time < span.start || time >= span.end) {
    throw new Error(
      `--time ${String(time)}s is not on clip "${args.clip}", which runs ` +
        `${span.start.toFixed(2)}–${span.end.toFixed(2)}s. Every grid cell would measure an ` +
        'ungraded frame and fit a slope of zero. Omit --time to use the clip midpoint.',
    );
  }
  const frame = frameAt(project, time);

  const baseline = facts(
    await measure(args.sidecar, projectWithGrade(project, args.clip, {}), frame, revision),
  );
  // The old test was `<= 0`, which only fires on a frame with literally no contrast and no
  // chroma at all — so it never fired. Measured on `mission-montage` clip_004 (luma_mean
  // 0.078, contrastIdx 0.137): the contrast fit came back **-0.251**, a NEGATIVE response,
  // meaning "more contrast makes the shot flatter". That is not a measurement, it is a
  // near-black frame with no spread to scale, and it printed next to "paste into
  // color-solver.ts" without a word of caution. These thresholds are where a fit stops
  // being about the parameter and starts being about the material.
  if (baseline.contrastIdx < LOW_CONTRAST || baseline.satMean < LOW_SATURATION) {
    process.stderr.write(
      `WARNING: this frame measures contrastIdx=${baseline.contrastIdx.toFixed(3)} ` +
        `satMean=${baseline.satMean.toFixed(3)}. Below ${String(LOW_CONTRAST)} / ` +
        `${String(LOW_SATURATION)} there is too little spread for a ratio to mean anything, ` +
        'and the contrast/saturation fits can come back negative. Trust the chroma fits, ' +
        'not these, and pick a better-exposed frame before believing a number.\n',
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
    const fitted = fit(parameter, baseline, cells);
    // A grid that moved nothing did not measure a response of zero — it failed to measure.
    // Printing it next to "paste into color-solver.ts" is how a broken run becomes a broken
    // solver, so it is named as a failure here instead.
    const moved = cells.some(({ measured }) => Math.abs(measured.lumaMean - baseline.lumaMean) > 1e-6 || Math.abs(measured.satMean - baseline.satMean) > 1e-6 || Math.abs(measured.warmth - baseline.warmth) > 1e-6);
    report.fits[parameter] = {
      ...fitted,
      constant: grid.constant,
      axis: grid.axis,
      ...(moved ? {} : { dead: true }),
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
    if (result.dead) {
      process.stdout.write(
        '  NOT MEASURED — every grid cell came back identical to the ungraded frame, so\n' +
          '  this is a failed measurement, not a response of zero. Do NOT paste it. Check the\n' +
          '  frame is on the graded clip and that the render honours the effect.\n\n',
      );
      process.exitCode = 1;
      continue;
    }
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
