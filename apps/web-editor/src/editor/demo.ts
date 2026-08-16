/**
 * A small in-memory demo project so the editor shell renders something real
 * before project import (plan Phase 3.2) is wired to the desktop bridge. Replaced
 * by an opened `project.fp.json` once `window.framepilot.openProject` is used.
 */
import { type Project, type TranscriptWord, parseProject } from '@framepilot/timeline-schema';
import type { Timeline } from '@framepilot/timeline-schema';

/** Asset ids referenced by {@link demoTimeline}, used for clip-reference validation. */
export const demoAssetIds = ['asset_intro', 'asset_voiceover'] as const;

/** A two-track (video + audio) demo timeline with placed clips. */
export const demoTimeline: Timeline = {
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [
        {
          id: 'clip_intro',
          assetId: 'asset_intro',
          trackId: 'video_1',
          start: 0,
          end: 6,
          sourceStart: 0,
          sourceEnd: 6,
          effects: [],
          keyframes: [],
        },
        {
          id: 'clip_body',
          assetId: 'asset_intro',
          trackId: 'video_1',
          start: 6,
          end: 14,
          sourceStart: 6,
          sourceEnd: 14,
          effects: [],
          keyframes: [],
        },
      ],
    },
    {
      id: 'audio_1',
      type: 'audio',
      clips: [
        {
          id: 'clip_vo',
          assetId: 'asset_voiceover',
          trackId: 'audio_1',
          start: 0,
          end: 14,
          sourceStart: 0,
          sourceEnd: 14,
          effects: [],
          keyframes: [],
        },
      ],
    },
    { id: 'caption_1', type: 'caption', clips: [] },
  ],
};

/** A short word-level transcript aligned to {@link demoTimeline}. */
export const demoTranscript: readonly TranscriptWord[] = [
  { word: 'Welcome', start: 0.0, end: 0.6 },
  { word: 'to', start: 0.6, end: 0.8 },
  { word: 'FramePilot', start: 0.8, end: 1.8 },
  { word: 'the', start: 2.0, end: 2.2 },
  { word: 'cursor', start: 2.2, end: 2.8 },
  { word: 'for', start: 2.8, end: 3.0 },
  { word: 'video', start: 3.0, end: 3.6 },
  { word: 'editing', start: 3.6, end: 4.4 },
];

/** A full, schema-valid demo project wrapping {@link demoTimeline}. */
export const demoProject: Project = parseProject({
  id: 'project_demo',
  name: 'Demo Project',
  version: 1,
  fps: 30,
  resolution: { width: 1080, height: 1920 },
  assets: [
    { id: 'asset_intro', path: '/media/intro.mp4', kind: 'video', durationSeconds: 14 },
    { id: 'asset_voiceover', path: '/media/voiceover.wav', kind: 'audio', durationSeconds: 14 },
  ],
  timeline: demoTimeline,
  transcript: demoTranscript,
  aiMemory: {},
  history: [],
});
