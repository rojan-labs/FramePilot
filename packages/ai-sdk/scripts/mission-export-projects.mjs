#!/usr/bin/env node
/**
 * Derive the two export-baseline projects (plan/system-mission P0.5) from the fixture
 * projects: a ≈30 s vertical assembly of the montage footage with music, and a ≈60 s
 * slice of the podcast. Same assets, same media dir — only the timeline is cut down.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject, SCHEMA_VERSION } from '@framepilot/timeline-schema';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'mission', 'projects');
const load = (id) => { const { schemaVersion: _v, ...p } = JSON.parse(readFileSync(join(ROOT, `${id}.fp.json`), 'utf8')); return parseProject(p); };
const save = (p) => writeFileSync(join(ROOT, `${p.id}.fp.json`), JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...p }, null, 2));

function cutTo(project, id, name, seconds, { music } = {}) {
  const video = project.timeline.tracks.find((t) => t.type === 'video');
  const clips = [];
  let cursor = 0;
  for (const c of video.clips) {
    if (cursor >= seconds) break;
    const len = Math.min(c.end - c.start, seconds - cursor);
    clips.push({ ...c, id: `x_${clips.length + 1}`, start: cursor, end: cursor + len, sourceStart: c.sourceStart, sourceEnd: c.sourceStart + len });
    cursor += len;
  }
  const audioClips = [];
  if (music) {
    const asset = project.assets.find((a) => a.path.endsWith(music));
    audioClips.push({ id: 'x_music', assetId: asset.id, trackId: 'audio_1', start: 0, end: cursor, sourceStart: 0, sourceEnd: cursor, effects: [], keyframes: [] });
  }
  return parseProject({
    ...project,
    id,
    name,
    timeline: { ...project.timeline, tracks: [{ id: 'video_1', type: 'video', clips }, { id: 'audio_1', type: 'audio', clips: audioClips }] },
    history: [],
  });
}

const montage = load('mission-montage');
save(cutTo(montage, 'mission-export-30s', 'Export baseline 30s (4K camera → 1080×1920 + music)', 30, { music: 'beat-100bpm.wav' }));
const podcast = load('mission-podcast');
save(cutTo(podcast, 'mission-export-60s', 'Export baseline 60s (podcast 360p → 1920×1080)', 60));
console.log('wrote mission-export-30s.fp.json, mission-export-60s.fp.json');
