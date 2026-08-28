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
import { existsSync, linkSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProject, SCHEMA_VERSION } from '@framepilot/timeline-schema';

process.env.FRAMEPILOT_LOG_LEVEL ??= 'silent';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const FIXTURES = join(REPO, 'tests', 'fixtures', 'mission');
const ROOT = join(FIXTURES, 'projects');
const BASE_URL = process.env.FRAMEPILOT_PYTHON_API_URL ?? 'http://127.0.0.1:8799';

const VIDEO_EXT = new Set(['.mp4', '.mov']);
const AUDIO_EXT = new Set(['.wav', '.mp3']);

/** @typedef {{ id: string, name: string, fps: number, resolution: {width:number,height:number}, media: {file: string, onTimeline?: boolean}[], transcribe?: string }} Def */

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
    id: 'mission-podcast',
    name: 'Mission podcast (9-minute dialogue)',
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    media: [{ file: 'speech-9min.mp4', onTimeline: true }],
    transcribe: 'speech-9min.mp4',
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
      clips.push({
        id: `clip_${String(clips.length + 1).padStart(3, '0')}`,
        assetId: id,
        trackId: 'video_1',
        start: cursor,
        end: cursor + durationSeconds,
        sourceStart: 0,
        sourceEnd: durationSeconds,
        effects: [],
        keyframes: [],
      });
      cursor += durationSeconds;
    }
  }
  let transcript = [];
  if (def.transcribe) {
    const asset = assets.find((a) => a.path.endsWith(basename(def.transcribe)));
    const draft = { id: def.id, name: def.name, version: 1, fps: def.fps, resolution: def.resolution, assets, timeline: { tracks: [{ id: 'video_1', type: 'video', clips }, { id: 'audio_1', type: 'audio', clips: [] }] } };
    process.stdout.write(`  transcribing ${asset.path} (local whisper)…`);
    const t0 = Date.now();
    const resp = await post('/transcribe', { project: draft, asset_id: asset.id, provider: 'whisper-cli', use_cache: true, project_id: def.id });
    transcript = resp.words.map((w) => ({ word: String(w.word ?? w.text ?? ''), start: Number(w.start), end: Number(w.end) })).filter((w) => w.word.length > 0 && w.end >= w.start);
    process.stdout.write(` ${transcript.length} words in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  }
  const project = parseProject({
    id: def.id,
    name: def.name,
    version: 1,
    fps: def.fps,
    resolution: def.resolution,
    assets,
    timeline: { tracks: [{ id: 'video_1', type: 'video', clips }, { id: 'audio_1', type: 'audio', clips: [] }] },
    transcript,
    aiMemory: {},
    history: [],
  });
  const out = join(ROOT, `${def.id}.fp.json`);
  writeFileSync(out, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...project }, null, 2));
  return { out, assets: assets.length, clips: clips.length, words: transcript.length, durationSeconds: cursor };
}

for (const def of DEFS) {
  process.stdout.write(`${def.id}\n`);
  const r = await buildProject(def);
  process.stdout.write(`  → ${basename(r.out)}: ${r.assets} assets, ${r.clips} clips (${r.durationSeconds.toFixed(1)}s), ${r.words} words\n`);
}
