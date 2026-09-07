#!/usr/bin/env node
/**
 * propose-fixture-labels — regenerate `tests/fixtures/mission/labels/` in one command
 * (plan/visual-understanding VU0.2).
 *
 * ## What this produces, and what it deliberately does not
 *
 * The labelled fixture set is what VU0.3's answer cases are scored against by a human, so
 * it has to exist before those cases mean anything. Two of its four files can be filled in
 * by a machine and two cannot, and this script is careful about the difference:
 *
 *  - **`tier0.json` — PROPOSED.** Every class in it (exposure, warmth, motion, sharpness,
 *    black, freeze) is computed by running the shipped tier-0 pass
 *    (`framepilot_engine.analysis.shot_stats.measure_asset`, one ffmpeg decode per asset)
 *    and then naming its numbers with the shipped word functions
 *    (`kernel/context/shot-words.ts`). Every entry carries `"source": "proposed"` and
 *    `"verified": false`, and the raw measurement sits next to the word so a human can see
 *    what the machine saw. **A proposed label is not ground truth** — see the README in
 *    that directory for the one rule that follows from it.
 *  - **`cuts.json` — PARTLY proposed.** Structure and measured deltas come from tier 0;
 *    `sameSetting` and the expected transition reason need an eye and are emitted `null`.
 *  - **`tier1.json` / `tier2.json` — SCAFFOLDS, not proposals.** Shot size, subject,
 *    setting, screen content, faces, person clusters, on-screen text: none of that is
 *    measurable without the tier-1 embedding pack or a tier-2 captioner, neither of which
 *    runs here. Emitting a guess would be worse than emitting nothing, because the guess
 *    would be read as a label. So every field is `null` with `"source": "unlabelled"`, one
 *    row per shot, ready for the human pass.
 *
 * ## How a human fills them in
 *
 *   node packages/ai-sdk/scripts/propose-fixture-labels.mjs   # this script (needs ffmpeg + uv)
 *   node packages/ai-sdk/scripts/contact-sheet.mjs            # a thumbnail per shot to look at
 *
 * Then edit the JSON: correct a proposed class, fill a null, and flip that entry's
 * `"source"` to `"confirmed"` (or `"corrected"`) and `"verified"` to `true`. Re-running this
 * script REGENERATES the files, so do the human pass after a fixture change, not before.
 *
 * Dev tooling. Nothing at run time reads these files.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const PROJECTS_DIR = join(REPO, 'tests/fixtures/mission/projects');
const MEDIA_ROOT = join(PROJECTS_DIR, 'media');
const OUT_DIR = join(REPO, 'tests/fixtures/mission/labels');

/** The fixture projects the golden set runs against. Their union is the footage to label. */
const FIXTURE_PROJECTS = [
  'mission-montage',
  'mission-talk',
  'mission-podcast',
  'mission-overlay',
  'mission-photos',
];

/** How many shots tier 2 is asked for. VU0.2 names 50; the rest stay unlabelled. */
const TIER2_SHOT_BUDGET = 50;

/** Sharpness below which an editor would call the shot soft — `PICTURE_FLAG_THRESHOLDS`. */
const SOFT_SHARPNESS = 0.35;

/**
 * The word functions the product itself uses, loaded from the built package.
 *
 * Imported rather than reimplemented on purpose: a second copy of the exposure bands here
 * would drift from the ones the agent reads, and then the labels and the product would
 * disagree about what "dark" means — which is exactly the bug a labelled set exists to
 * catch.
 */
async function loadWords() {
  const url = pathToFileURL(join(HERE, '../dist/kernel/context/shot-words.js')).href;
  try {
    return await import(url);
  } catch (error) {
    throw new Error(
      `Could not load the shot-word functions from dist. Build the package first ` +
        `(pnpm --filter @framepilot/ai-sdk build). Cause: ${String(error)}`,
    );
  }
}

/** SHA-256 of a media file, the way the ledger keys an asset's shots. */
function contentHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Every visual asset of every fixture project, deduplicated by CONTENT.
 *
 * By content and not by path because the fixture projects keep a copy of the same file in
 * each project's media directory — `speech-9min-b.mp4` is under both `mission-talk/` and
 * `mission-overlay/` — and measuring it twice would put 221 identical shot rows in the
 * label set for a human to label twice and then disagree with themselves. Content hash is
 * also how the ledger itself keys a shot (ADR 0175), so this matches what the product does.
 */
function fixtureAssets() {
  /** @type {Map<string, { file: string, key: string, isImage: boolean, durationSeconds: number, refs: {project: string, assetId: string}[] }>} */
  const byFile = new Map();
  for (const project of FIXTURE_PROJECTS) {
    const doc = JSON.parse(readFileSync(join(PROJECTS_DIR, `${project}.fp.json`), 'utf8'));
    for (const asset of doc.assets ?? []) {
      if (asset.kind !== 'video' && asset.kind !== 'image') continue;
      const file = resolve(PROJECTS_DIR, asset.path);
      const hash = contentHash(file);
      const existing = byFile.get(hash);
      if (existing) {
        existing.refs.push({ project, assetId: asset.id });
        continue;
      }
      byFile.set(hash, {
        file,
        key: relative(MEDIA_ROOT, file),
        isImage: asset.kind === 'image',
        durationSeconds: Number(asset.durationSeconds ?? 0),
        refs: [{ project, assetId: asset.id }],
      });
    }
  }
  return [...byFile.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Run the shipped tier-0 pass over every asset, in one Python process.
 *
 * Through `uv run` and the engine's own module rather than a filtergraph written here: the
 * point of these labels is to describe what the PRODUCT measures, so anything else would be
 * measuring a second implementation.
 */
function measureAll(assets) {
  const program = `
import json, sys
from pathlib import Path
from framepilot_engine.analysis.shot_stats import measure_asset

out = []
for spec in json.load(sys.stdin):
    # Per asset, because one file ffmpeg cannot read must not cost the other seventy-one
    # their labels. The failure is reported by key rather than swallowed.
    try:
        shots = measure_asset(
            Path(spec["file"]),
            duration=spec["durationSeconds"],
            is_image=spec["isImage"],
        )
    except Exception as exc:  # noqa: BLE001 - reported, not handled
        out.append({"key": spec["key"], "shots": [], "error": str(exc).splitlines()[0][:200]})
        continue
    out.append({"key": spec["key"], "shots": [s.model_dump() for s in shots]})
json.dump(out, sys.stdout)
`;
  const payload = JSON.stringify(
    assets.map((a) => ({
      file: a.file,
      key: a.key,
      isImage: a.isImage,
      durationSeconds: a.durationSeconds,
    })),
  );
  const stdout = execFileSync('uv', ['run', 'python', '-c', program], {
    cwd: REPO,
    input: payload,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

/** The exposure word, with the shipped function's "nothing worth saying" spelled out. */
function exposureClass(words, lumaMean) {
  return words.exposureWord(lumaMean) || 'normal';
}

function warmthClass(words, warmth) {
  return words.warmthWord(warmth) || 'neutral';
}

function header(kind, note) {
  return {
    schemaVersion: 1,
    kind,
    generatedAt: new Date().toISOString().slice(0, 10),
    generator: 'packages/ai-sdk/scripts/propose-fixture-labels.mjs',
    note,
  };
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function main() {
  return loadWords().then((words) => {
    const assets = fixtureAssets();
    process.stdout.write(`measuring ${String(assets.length)} fixture asset(s)…\n`);
    const measured = measureAll(assets);
    const byKey = new Map(measured.map((m) => [m.key, m.shots]));
    const unmeasured = measured
      .filter((m) => m.error)
      .map((m) => ({ asset: m.key, reason: m.error }));
    for (const failure of unmeasured) {
      process.stdout.write(`  ! ${failure.asset}: ${failure.reason}\n`);
    }

    const tier0Shots = [];
    const tier1Shots = [];
    const tier2Shots = [];
    for (const asset of assets) {
      const shots = byKey.get(asset.key) ?? [];
      for (const shot of shots) {
        const id = `${asset.key}#${String(shot.shot_index)}`;
        tier0Shots.push({
          id,
          asset: asset.key,
          refs: asset.refs,
          shotIndex: shot.shot_index,
          t0: round(shot.t0, 3),
          t1: round(shot.t1, 3),
          keyframeT: round(shot.keyframe_t, 3),
          splitOf: shot.split_of,
          source: 'proposed',
          verified: false,
          proposed: {
            exposure: exposureClass(words, shot.luma_mean),
            warmth: warmthClass(words, shot.warmth),
            motion: shot.motion_class,
            sharpness: shot.sharpness < SOFT_SHARPNESS ? 'soft' : 'sharp',
            black: shot.black,
            freeze: shot.freeze,
          },
          measured: {
            lumaMean: round(shot.luma_mean),
            lumaP10: round(shot.luma_p10),
            lumaP90: round(shot.luma_p90),
            warmth: round(shot.warmth),
            contrastIdx: round(shot.contrast_idx),
            satMean: round(shot.sat_mean),
            ti: round(shot.ti, 3),
            sharpness: round(shot.sharpness),
          },
        });
        tier1Shots.push({
          id,
          asset: asset.key,
          shotIndex: shot.shot_index,
          source: 'unlabelled',
          verified: false,
          shotSize: null,
          subjectKind: null,
          setting: null,
          screenContent: null,
          faces: null,
          personClusterId: null,
          duplicateOf: null,
        });
      }
    }
    for (const shot of tier0Shots.slice(0, TIER2_SHOT_BUDGET)) {
      tier2Shots.push({
        id: shot.id,
        asset: shot.asset,
        shotIndex: shot.shotIndex,
        keyframeT: shot.keyframeT,
        source: 'unlabelled',
        verified: false,
        subject: null,
        setting: null,
        onScreenText: null,
      });
    }

    writeFiles(tier0Shots, tier1Shots, tier2Shots, unmeasured);
  });
}

/** The cuts of `mission-montage`, which is the fixture the transition case runs against. */
function montageCuts(tier0Shots) {
  const doc = JSON.parse(readFileSync(join(PROJECTS_DIR, 'mission-montage.fp.json'), 'utf8'));
  const assetPath = new Map(
    doc.assets.map((a) => [a.id, relative(MEDIA_ROOT, resolve(PROJECTS_DIR, a.path))]),
  );
  const clips = doc.timeline.tracks
    .filter((t) => t.type === 'video')
    .flatMap((t) => t.clips)
    .sort((a, b) => a.start - b.start);
  const shotAt = (assetId, seconds) => {
    const key = assetPath.get(assetId);
    return tier0Shots.find((s) => s.asset === key && s.t0 <= seconds && s.t1 > seconds) ?? null;
  };
  const cuts = [];
  for (let i = 1; i < clips.length; i++) {
    const from = clips[i - 1];
    const to = clips[i];
    // The outgoing shot is the one playing at the last frame the cut shows, and the
    // incoming shot is the one playing at its first — not the shots at the clip's ends.
    const outgoing = shotAt(from.assetId, Math.max(from.sourceStart, from.sourceEnd - 0.1));
    const incoming = shotAt(to.assetId, to.sourceStart);
    const delta = (field) =>
      outgoing && incoming ? round(incoming.measured[field] - outgoing.measured[field]) : null;
    cuts.push({
      id: `mission-montage#${String(i - 1)}`,
      atSeconds: round(to.start, 3),
      fromClipId: from.id,
      toClipId: to.id,
      outgoingShot: outgoing?.id ?? null,
      incomingShot: incoming?.id ?? null,
      source: 'partly-proposed',
      verified: false,
      // Machine-derivable: two different source files cannot be a jump cut.
      proposed: {
        sourceChange: from.assetId !== to.assetId,
        jumpCut: from.assetId === to.assetId ? null : false,
        lumaDelta: delta('lumaMean'),
        warmthDelta: delta('warmth'),
      },
      // A human pass. `sameSetting` needs tier 1 or an eye; the reason is an editorial
      // judgement, and must be one of `TRANSITION_REASONS` in editor-core.
      sameSetting: null,
      expectedTransitionReason: null,
    });
  }
  return cuts;
}

function writeFiles(tier0Shots, tier1Shots, tier2Shots, unmeasured) {
  mkdirSync(OUT_DIR, { recursive: true });
  const write = (name, body) => {
    writeFileSync(join(OUT_DIR, name), `${JSON.stringify(body, null, 2)}\n`);
    process.stdout.write(`  ${name}\n`);
  };
  write('tier0.json', {
    ...header(
      'tier0',
      'PROPOSED by the shipped tier-0 pass (ffmpeg signalstats/scdet/siti/blurdetect) and ' +
        'named with the shipped word functions. Not verified by a human. Never tune a ' +
        'threshold against these — see README.md.',
    ),
    tier0Version: 1,
    shotCount: tier0Shots.length,
    // Named, never silently absent: an asset missing from `shots` because ffmpeg could not
    // read it looks identical to an asset with nothing to say, and they are different facts.
    unmeasured,
    shots: tier0Shots,
  });
  write('tier1.json', {
    ...header(
      'tier1',
      'SCAFFOLD. Shot size, subject, setting, screen content, faces and person clusters ' +
        'need the tier-1 embedding pack or a human eye; neither ran, so every field is null.',
    ),
    tier1Version: 1,
    shotCount: tier1Shots.length,
    shots: tier1Shots,
  });
  write('tier2.json', {
    ...header(
      'tier2',
      `SCAFFOLD for the first ${String(TIER2_SHOT_BUDGET)} shots. Subject, setting and ` +
        'on-screen text need a captioner or a human eye; neither ran, so every field is null.',
    ),
    tier2Version: 1,
    shotCount: tier2Shots.length,
    shots: tier2Shots,
  });
  const cuts = montageCuts(tier0Shots);
  write('cuts.json', {
    ...header(
      'cuts',
      'The cuts of mission-montage. Structure and measured deltas are derived from tier 0; ' +
        'sameSetting and expectedTransitionReason are a human pass and are null.',
    ),
    project: 'mission-montage',
    cutCount: cuts.length,
    cuts,
  });
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
