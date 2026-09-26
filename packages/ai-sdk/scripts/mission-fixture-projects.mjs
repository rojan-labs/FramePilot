#!/usr/bin/env node
/**
 * Build the mission fixture projects (plan/system-mission Phase 0) the way the desktop
 * import path builds them: media hard-linked under `<projectsRoot>/media/<projectId>/`,
 * engine-derived media from `POST /asset-media`, a transcript from `POST /transcribe`
 * (local whisper) for the dialogue projects, and a `<projectId>.fp.json` that passes
 * `parseProject`. The point is that every later measurement runs against the same shape
 * of project a real user has — not a hand-written stub.
 *
 * Usage:
 *   FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799 node scripts/mission-fixture-projects.mjs
 * Requires a sidecar started with FRAMEPILOT_PROJECTS_ROOT=tests/fixtures/mission/projects.
 */
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProject, presetShapeParams, SCHEMA_VERSION } from '@framepilot/timeline-schema';
import {
  applyProjectPatch,
  buildAddShapeOps,
  buildAddStickerOps,
  elementArtFraction,
  normalizeOperationTime,
} from '@framepilot/editor-core';
import { detectTranscriptLoop } from '../dist/critic.js';
import { loadStickerCatalog, stickerSourceUrl } from '../dist/index.js';

process.env.FRAMEPILOT_LOG_LEVEL ??= 'silent';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const FIXTURES = join(REPO, 'tests', 'fixtures', 'mission');
const ROOT = join(FIXTURES, 'projects');
const BASE_URL = process.env.FRAMEPILOT_PYTHON_API_URL ?? 'http://127.0.0.1:8799';

const VIDEO_EXT = new Set(['.mp4', '.mov']);
const AUDIO_EXT = new Set(['.wav', '.mp3']);

/** @typedef {{ id: string, name: string, fps: number, resolution: {width:number,height:number}, media: {file: string, onTimeline?: boolean}[], transcribe?: string, transcriptFrom?: string, overlayTrackId?: string, graphics?: Graphics }} Def */
/** Elements already on the timeline, placed as the Shapes and Stickers tabs place them. */
/** @typedef {{ shape?: { preset: string, start: number, end: number }, sticker?: { id: string, start: number, end: number } }} Graphics */

/** @type {Def[]} */
const DEFS = [
  {
    id: 'mission-montage',
    name: 'Mission montage (raw camera + b-roll + music)',
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    media: [
      { file: 'camera-4k60-40s.mov', onTimeline: true },
      { file: 'broll/b1-4k30-22s.mov', onTimeline: true },
      { file: 'broll/b2-4k60-9s.mov', onTimeline: true },
      { file: 'broll/b3-1080p60-15s.mov', onTimeline: true },
      { file: 'broll/b4-1080p-50s.mp4', onTimeline: true },
      { file: 'vertical-30s.mp4' },
      { file: 'talk-1080p-98s.mp4' },
      { file: 'music/beat-100bpm.wav' },
      { file: 'music/beat-ramp.wav' },
    ],
  },
  {
    // `speech-9min-c`, NOT `speech-9min`. The original media's transcript is 2,384 of
    // 2,431 words of one sentence whisper looped over quiet audio, so every case here that
    // reads words — `podcast-highlight-60s` asks for the best 60 seconds,
    // `hook-strongest-line` for the strongest line — was selecting from a fabrication, and
    // a run that refused on those grounds was scored as failing. Swapping to
    // `speech-9min-b`, the one fetched fixture with real narration, would have traded that
    // for the mirror defect: it has no silent gap at any threshold, so `remove-dead-air`
    // and the first half of `compound-silence-captions` would have asked for the removal of
    // dead air that is not there. `speech-9min-c` is `-b`'s narration with 116 real pauses
    // cut in at its own sentence boundaries (`fetch-fixtures.sh`), which is the one shape
    // that measures both: real words, real dead air, ~11.9 minutes.
    id: 'mission-podcast',
    name: 'Mission podcast (12-minute narration with pauses)',
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    media: [{ file: 'speech-9min-c.mp4', onTimeline: true }],
    transcribe: 'speech-9min-c.mp4',
  },
  {
    id: 'mission-talk',
    name: 'Mission talk (9-minute narration + music)',
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    media: [{ file: 'speech-9min-b.mp4', onTimeline: true }, { file: 'music/beat-100bpm.wav' }],
    transcribe: 'speech-9min-b.mp4',
  },
  {
    // The shape that trapped run `369e8c82`: narration gapless across the WHOLE sequence
    // on the occupied video track, and a second video track that is empty. Under ADR 0140
    // every placement on the empty track overlaps picture and is refused, so the track is
    // an invitation with no legal move behind it — the run took it four times over fifteen
    // minutes. No other fixture can reproduce that: they all have exactly one video track.
    //
    // Same narration file as `mission-talk` on purpose. It makes the pair of b-roll cases
    // differ in one variable only (the empty overlay track), and whisper hits its
    // content-hash cache (`engine/python/.../audio/asr.py#transcribe`) instead of
    // transcribing a second file, so the transcript costs nothing extra.
    id: 'mission-overlay',
    name: 'Mission overlay (gapless narration + an empty b-roll track)',
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    overlayTrackId: 'b_roll',
    media: [
      { file: 'speech-9min-b.mp4', onTimeline: true },
      // In the bin, deliberately NOT on the timeline: the b-roll a request asks for has to
      // be cut into the narration track, because `b_roll` has no free span to receive it.
      { file: 'broll/b2-4k60-9s.mov' },
      { file: 'broll/b3-1080p60-15s.mov' },
    ],
    transcribe: 'speech-9min-b.mp4',
  },
  {
    // Elements, case 1 (plan/elements 07 section 8): a drawn screen recording whose Export
    // button box and narration are known exactly (`tests/screen_demo_fixture.py`). The
    // transcript is the labels' words, not whisper's: there is no speech in the file, and the
    // case scores placement on the word, which only a known word time can measure.
    id: 'mission-screen-demo',
    name: 'Mission screen demo (a drawn app with an Export button)',
    fps: 30,
    resolution: { width: 1280, height: 720 },
    media: [{ file: 'screen-demo-20s.mp4', onTimeline: true }],
    transcriptFrom: 'labels/screen-demo.json',
  },
  {
    id: 'mission-reaction-demo',
    name: 'Mission reaction demo (a drawn talking head who says "this is fire")',
    fps: 30,
    resolution: { width: 1280, height: 720 },
    media: [{ file: 'reaction-demo-12s.mp4', onTimeline: true }],
    transcriptFrom: 'labels/reaction-demo.json',
  },
  {
    // plan/elements 07 section 8, case 3: the two elements "make the arrow pop in and the
    // sticker pulse" names, already on screen, so the case scores only the animation.
    id: 'mission-animate-demo',
    name: 'Mission animate demo (the reaction demo with an arrow and a sticker on it)',
    fps: 30,
    resolution: { width: 1280, height: 720 },
    media: [{ file: 'reaction-demo-12s.mp4', onTimeline: true }],
    transcriptFrom: 'labels/reaction-demo.json',
    graphics: {
      shape: { preset: 'line-arrow/red', start: 2, end: 6 },
      sticker: { id: 'fire', start: 3, end: 7 },
    },
  },
  {
    id: 'mission-photos',
    name: 'Mission photos (60 stills + music)',
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    media: [
      ...readdirSync(join(FIXTURES, 'photos'))
        .filter((f) => f.endsWith('.jpg'))
        .sort()
        .map((f) => ({ file: `photos/${f}` })),
      { file: 'music/beat-ramp.wav' },
    ],
  },
];

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

function kindOf(file) {
  const ext = extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'image';
}

/**
 * The project's tracks, in composite order.
 *
 * `tracks[0]` is the visual FRONT (`activeEffectLayersAt` in `@framepilot/timeline-schema`
 * composites bottom-up from the last track), so a def's `overlayTrackId` goes first — it is
 * the layer a model reaches for when it wants to put something "over" the picture.
 *
 * @param {Def} def
 * @param {unknown[]} clips - the clips laid on the occupied video track.
 */
function tracksOf(def, clips) {
  const occupied = { id: 'video_1', type: 'video', clips };
  const audio = { id: 'audio_1', type: 'audio', clips: [] };
  if (!def.overlayTrackId) return [occupied, audio];
  return [{ id: def.overlayTrackId, type: 'video', clips: [] }, occupied, audio];
}

async function buildProject(def) {
  const mediaDir = join(ROOT, 'media', def.id);
  mkdirSync(mediaDir, { recursive: true });
  const assets = [];
  const clips = [];
  let cursor = 0;
  for (const [i, m] of def.media.entries()) {
    const src = join(FIXTURES, m.file);
    const name = basename(m.file);
    const dst = join(mediaDir, name);
    if (!existsSync(dst)) linkSync(src, dst);
    const relPath = `media/${def.id}/${name}`;
    const derived = await post('/asset-media', { input_path: dst, buckets: 400, thumbnails: 5 });
    const id = `asset_${String(i + 1).padStart(3, '0')}`;
    const kind = derived.kind ?? kindOf(name);
    const durationSeconds = derived.durationSeconds ?? (kind === 'image' ? 5 : undefined);
    assets.push({
      id,
      path: relPath,
      kind,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      media: {
        ...(derived.width ? { width: derived.width } : {}),
        ...(derived.height ? { height: derived.height } : {}),
        ...(derived.peaks ? { peaks: derived.peaks, peaksPerSecond: derived.peaksPerSecond } : {}),
        ...(derived.thumbnailPaths ? { thumbnailPaths: derived.thumbnailPaths } : {}),
        ...(derived.proxyPath ? { proxyPath: derived.proxyPath } : {}),
      },
    });
    if (m.onTimeline && kind === 'video' && durationSeconds) {
      // Lay the clip through the SAME boundary a real placement crosses. A person dropping
      // this asset on the timeline builds an `add_clip` operation, and `commitProjectPatch`
      // runs `quantizePatch` over it (ADR 0146 / GAP-005) — so their clip lands on the
      // project's frame grid with its source range rescaled around `sourceStart`. Laying
      // raw media durations here instead produced a project the product cannot produce:
      // every fixture started off-grid, and `cuts-on-frame-grid` then failed on every case
      // no matter what the agent did, charging an inherited defect to the agent and pinning
      // goal.md's boundary-precision metric to the fixture rather than the run.
      const snapped = normalizeOperationTime(
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: id,
          start: cursor,
          end: cursor + durationSeconds,
          sourceStart: 0,
          sourceEnd: durationSeconds,
        },
        def.fps,
      );
      clips.push({
        id: `clip_${String(clips.length + 1).padStart(3, '0')}`,
        assetId: id,
        trackId: 'video_1',
        start: snapped.start,
        end: snapped.end,
        sourceStart: snapped.sourceStart,
        sourceEnd: snapped.sourceEnd,
        effects: [],
        keyframes: [],
      });
      // Advance by the SNAPPED end, so the next clip's start is on-grid too — the same way
      // an append-at-end placement reads the committed timeline, not the raw asset duration.
      cursor = snapped.end;
    }
  }
  let transcript = [];
  if (def.transcriptFrom) {
    const labels = JSON.parse(readFileSync(join(FIXTURES, def.transcriptFrom), 'utf8'));
    const asset = assets.find((a) => a.kind === 'video');
    transcript = labels.transcript.map((w) => ({ ...w, assetId: asset.id }));
  }
  if (def.transcribe) {
    const asset = assets.find((a) => a.path.endsWith(basename(def.transcribe)));
    const draft = { id: def.id, name: def.name, version: 1, fps: def.fps, resolution: def.resolution, assets, timeline: { tracks: tracksOf(def, clips) } };
    process.stdout.write(`  transcribing ${asset.path} (local whisper)…`);
    const t0 = Date.now();
    const resp = await post('/transcribe', { project: draft, asset_id: asset.id, provider: 'whisper-cli', use_cache: true, project_id: def.id });
    transcript = resp.words.map((w) => ({ word: String(w.word ?? w.text ?? ''), start: Number(w.start), end: Number(w.end) })).filter((w) => w.word.length > 0 && w.end >= w.start);
    process.stdout.write(` ${transcript.length} words in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    // Say so at BUILD time when the transcript is mostly one phrase repeated. Whisper loops
    // over quiet audio and the result is indistinguishable from speech downstream, so a
    // fabricated transcript otherwise becomes the silent ground truth for every
    // transcript-grounded case measured against this fixture. `mission-podcast` is 92% one
    // sentence, and nothing said so until a run refused the case and was scored as failing.
    const loop = detectTranscriptLoop(transcript);
    if (loop) {
      process.stdout.write(
        `  WARNING: this transcript repeats "${loop.phrase}" ${loop.repeats} times back to back, ` +
          `covering ${loop.seconds.toFixed(0)}s (${Math.round(loop.share * 100)}% of it).\n` +
          `  That is speech recognition looping over quiet audio, not speech. Any case that ` +
          `selects or cuts on words in this fixture is measuring a fabrication.\n`,
      );
    }
  }
  const project = await withGraphics(
    def,
    mediaDir,
    parseProject({
      id: def.id,
      name: def.name,
      version: 1,
      fps: def.fps,
      resolution: def.resolution,
      assets,
      timeline: { tracks: tracksOf(def, clips) },
      transcript,
      aiMemory: {},
      history: [],
    }),
  );
  const out = join(ROOT, `${def.id}.fp.json`);
  writeFileSync(out, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...project }, null, 2));
  return { out, assets: assets.length, clips: clips.length, words: transcript.length, durationSeconds: cursor };
}

/**
 * Place a def's elements with the builders the Shapes and Stickers tabs use, so the project is
 * one the product can make: a shape on a graphics lane, and a curated sticker copied into the
 * project's media folder with its provenance.
 *
 * @param {Def} def
 * @param {string} mediaDir
 * @param {import('@framepilot/timeline-schema').Project} project
 */
async function withGraphics(def, mediaDir, project) {
  if (!def.graphics) return project;
  const patch = (operations) => ({
    patchId: `fixture_${def.id}_${operations.length}`,
    createdBy: 'user',
    reason: 'Fixture graphics',
    operations: [...operations],
  });
  let next = project;
  const { shape, sticker } = def.graphics;
  if (shape) {
    const placed = buildAddShapeOps(
      next.timeline,
      presetShapeParams(shape.preset),
      shape.start,
      shape.end,
    );
    next = applyProjectPatch(next, patch(placed.operations));
  }
  if (sticker) {
    const catalog = await loadStickerCatalog();
    const item = catalog.byId.get(sticker.id);
    if (!item?.file) throw new Error(`${def.id}: ${sticker.id} is not a curated sticker`);
    const dir = join(mediaDir, 'elements', catalog.library);
    mkdirSync(dir, { recursive: true });
    copyFileSync(
      join(REPO, 'apps', 'web-editor', 'public', 'elements', 'stickers', item.file),
      join(dir, `${item.id}.webp`),
    );
    const asset = {
      id: `element_${catalog.library}_${item.id}`,
      path: `media/${def.id}/elements/${catalog.library}/${item.id}.webp`,
      kind: 'image',
      media: { width: item.width, height: item.height },
      source: {
        provider: catalog.provider,
        remoteId: item.id,
        license: catalog.license,
        licenseUrl: catalog.licenseUrl,
        attributionRequired: catalog.attributionRequired,
        attribution: catalog.attribution,
        creator: catalog.creator,
        sourceUrl: stickerSourceUrl(catalog, item),
        fetchedAt: '2026-09-26T00:00:00.000Z',
      },
    };
    const placed = buildAddStickerOps(next, asset, sticker.start, sticker.end, {
      artFraction: elementArtFraction(asset),
    });
    next = applyProjectPatch(next, patch(placed.operations));
  }
  return parseProject(next);
}

// `--only <id>` rebuilds one project. Whisper is content-hash cached and the derived media
// is idempotent, so a full rebuild is safe — but it rewrites four fixtures nobody asked
// about, and a fixture rewrite is the kind of change that has to be reviewable on its own.
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
if (only && !DEFS.some((d) => d.id === only)) {
  throw new Error(`--only ${only}: no such project. Known: ${DEFS.map((d) => d.id).join(', ')}`);
}

for (const def of DEFS.filter((d) => !only || d.id === only)) {
  process.stdout.write(`${def.id}\n`);
  const r = await buildProject(def);
  process.stdout.write(`  → ${basename(r.out)}: ${r.assets} assets, ${r.clips} clips (${r.durationSeconds.toFixed(1)}s), ${r.words} words\n`);
}
