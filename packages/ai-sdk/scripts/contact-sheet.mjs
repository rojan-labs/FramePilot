#!/usr/bin/env node
/**
 * contact-sheet — one thumbnail per shot, tiled, for the human labelling pass (VU0.2).
 *
 * The labelled fixture set (`tests/fixtures/mission/labels/`) needs an eye on the footage:
 * shot size, subject, setting and on-screen text are not measurable, and VU0.3's answer
 * cases are scored against them. Scrubbing seventy-two files by hand is the reason that
 * pass has never happened, so this renders every shot of every fixture asset once, at the
 * shot's own `keyframeT`, and lays them out as a sheet a person can label from in one sitting.
 *
 * ## What it is not
 *
 * A DEV tool, not an agent tool and not a runtime path. It goes through the engine's
 * `/render/frame` route — the same deterministic composite `get_frame` uses (ADR 0096) — so
 * the pictures a labeller sees are the pictures the product would show, but nothing in the
 * product calls this and no test depends on it.
 *
 * ## Running it
 *
 *   # 1. the shot boundaries, if they are not already committed
 *   node packages/ai-sdk/scripts/propose-fixture-labels.mjs
 *
 *   # 2. the sidecar, rooted at the fixture projects so inline media paths resolve
 *   FRAMEPILOT_PROJECTS_ROOT="$PWD/tests/fixtures/mission/projects" uv run framepilot serve
 *
 *   # 3. the sheets
 *   node packages/ai-sdk/scripts/contact-sheet.mjs                       # every asset
 *   node packages/ai-sdk/scripts/contact-sheet.mjs --asset mission-montage/vertical-30s.mp4
 *   node packages/ai-sdk/scripts/contact-sheet.mjs --out artifacts/sheets --max-dimension 320
 *
 * Output per asset, under `artifacts/contact-sheets/<asset>/`:
 *
 *   shot-000.jpg …   one composited frame per shot, at its keyframe time
 *   index.json       shot index, times and the proposed tier-0 classes, in render order
 *   sheet.html       the tiled sheet — every thumbnail captioned with its shot index and
 *                    time, which is what makes a labelling note attachable to a row
 *
 * The caption lives under the tile rather than burnt into the pixels on purpose: burning
 * text needs ffmpeg's drawtext (and therefore a libfreetype build that is not guaranteed on
 * a contributor's machine), and a caption that is real text can be copied into the label
 * file. `index.json` carries the same pairing for anyone working without a browser.
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const PROJECTS_DIR = join(REPO, 'tests/fixtures/mission/projects');
const LABELS = join(REPO, 'tests/fixtures/mission/labels/tier0.json');

const DEFAULT_SIDECAR = process.env.FRAMEPILOT_SIDECAR_URL ?? 'http://127.0.0.1:8799';
const DEFAULT_OUT = join(REPO, 'artifacts/contact-sheets');
const DEFAULT_MAX_DIMENSION = 240;

function parseArgs(argv) {
  const args = {
    asset: null,
    out: DEFAULT_OUT,
    maxDimension: DEFAULT_MAX_DIMENSION,
    sidecar: DEFAULT_SIDECAR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--help' || flag === '-h') {
      args.help = true;
    } else if (flag === '--asset') {
      args.asset = value;
      i += 1;
    } else if (flag === '--out') {
      args.out = resolve(REPO, value);
      i += 1;
    } else if (flag === '--max-dimension') {
      args.maxDimension = Number(value);
      i += 1;
    } else if (flag === '--sidecar') {
      args.sidecar = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

/** A filesystem-safe name for an asset key like `mission-montage/vertical-30s.mp4`. */
function slug(assetKey) {
  return assetKey.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/** `0:06.2` — the way a labeller writes a time down. */
function timecode(seconds) {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}.${String(
    Math.floor((seconds - whole) * 10),
  )}`;
}

/**
 * A one-clip project that plays the whole asset from zero.
 *
 * WHY synthesised rather than the fixture project itself: half the footage worth labelling
 * is in the bin and not on any timeline (mission-montage carries two unplaced videos), and
 * `/render/frame` composites a TIMELINE. Laying the asset alone on one track makes the
 * shot's asset-seconds and the frame's timeline-seconds the same number, which is what lets
 * a shot row and a thumbnail be matched without a projection step that could be wrong.
 */
function soloProject(fixture, assetId) {
  const doc = JSON.parse(readFileSync(join(PROJECTS_DIR, `${fixture}.fp.json`), 'utf8'));
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`${fixture} has no asset ${assetId}`);
  const duration = Number(asset.durationSeconds) || 10;
  const resolution =
    asset.media?.width > 0 && asset.media?.height > 0
      ? { width: asset.media.width, height: asset.media.height }
      : doc.resolution;
  return {
    ...doc,
    name: `contact-sheet ${assetId}`,
    resolution,
    // A still has no timeline duration of its own; give it something to render.
    timeline: {
      ...doc.timeline,
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'sheet_clip',
              assetId,
              trackId: 'video_1',
              start: 0,
              end: duration,
              sourceStart: 0,
              sourceEnd: duration,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    // Captions and markers would be drawn into the frame; a contact sheet wants the picture.
    transcript: [],
    markers: [],
  };
}

async function grabFrame(sidecar, project, timeSeconds, maxDimension) {
  const response = await fetch(`${sidecar}/render/frame`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project,
      time_seconds: timeSeconds,
      max_dimension: maxDimension,
      image_format: 'jpeg',
      burn_captions: false,
    }),
  });
  if (!response.ok)
    throw new Error(`/render/frame ${String(response.status)}: ${await response.text()}`);
  return response.json();
}

function sheetHtml(assetKey, tiles) {
  const cells = tiles
    .map(
      (tile) =>
        `<figure><img src="${tile.file}" alt="shot ${String(tile.shotIndex)}" loading="lazy">` +
        `<figcaption><b>#${String(tile.shotIndex)}</b> ${timecode(tile.keyframeT)}` +
        `<br><span>${tile.t0.toFixed(1)}–${tile.t1.toFixed(1)}s</span>` +
        `<br><span>${tile.proposed}</span></figcaption></figure>`,
    )
    .join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<title>contact sheet — ${assetKey}</title>
<style>
  body { font: 13px/1.4 system-ui, sans-serif; margin: 24px; background: #fafaf9; color: #1c1917; }
  h1 { font-size: 15px; font-weight: 600; }
  p.note { max-width: 60ch; color: #57534e; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
  figure { margin: 0; }
  img { width: 100%; display: block; background: #000; border-radius: 4px; }
  figcaption { margin-top: 4px; font-size: 12px; }
  figcaption span { color: #78716c; }
</style>
<h1>${assetKey} — ${String(tiles.length)} shot(s)</h1>
<p class="note">The third caption line is the tier-0 machine PROPOSAL, not a label. Correct
it in <code>tests/fixtures/mission/labels/</code> and mark that row verified.</p>
<div class="grid">
${cells}
</div>
`;
}

async function sheetFor(args, assetKey, shots) {
  const dir = join(args.out, slug(assetKey));
  mkdirSync(dir, { recursive: true });
  const ref = shots[0].refs[0];
  const project = soloProject(ref.project, ref.assetId);
  const tiles = [];
  for (const shot of shots) {
    const file = `shot-${String(shot.shotIndex).padStart(3, '0')}.jpg`;
    const frame = await grabFrame(args.sidecar, project, shot.keyframeT, args.maxDimension);
    writeFileSync(join(dir, file), Buffer.from(frame.base64, 'base64'));
    tiles.push({
      file,
      shotIndex: shot.shotIndex,
      t0: shot.t0,
      t1: shot.t1,
      keyframeT: shot.keyframeT,
      proposed: `${shot.proposed.exposure} · ${shot.proposed.warmth} · ${shot.proposed.motion} · ${shot.proposed.sharpness}`,
    });
  }
  writeFileSync(
    join(dir, 'index.json'),
    `${JSON.stringify({ asset: assetKey, refs: shots[0].refs, shots: tiles }, null, 2)}\n`,
  );
  writeFileSync(join(dir, 'sheet.html'), sheetHtml(assetKey, tiles));
  process.stdout.write(`  ${assetKey}: ${String(tiles.length)} shot(s) → ${dir}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  const labels = JSON.parse(readFileSync(LABELS, 'utf8'));
  const byAsset = new Map();
  for (const shot of labels.shots) {
    if (args.asset && shot.asset !== args.asset) continue;
    const list = byAsset.get(shot.asset) ?? [];
    list.push(shot);
    byAsset.set(shot.asset, list);
  }
  if (byAsset.size === 0) {
    throw new Error(
      args.asset
        ? `no shots for "${args.asset}" in ${LABELS}`
        : `${LABELS} has no shots — run propose-fixture-labels.mjs first`,
    );
  }
  process.stdout.write(`rendering ${String(byAsset.size)} contact sheet(s) via ${args.sidecar}\n`);
  for (const [assetKey, shots] of [...byAsset].sort(([a], [b]) => a.localeCompare(b))) {
    await sheetFor(args, assetKey, shots);
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
