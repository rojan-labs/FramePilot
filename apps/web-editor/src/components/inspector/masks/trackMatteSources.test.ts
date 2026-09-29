/**
 * The Mask tab's track matte picker offers what the validator and the export accept as a source:
 * any clip that draws a picture on a video or overlay lane, and those whole lanes (AL31a).
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline, Track } from '@framepilot/timeline-schema';

import { trackMatteOptions } from './trackMatteSources.js';

const clip = (id: string, assetId: string, trackId: string, effects: Clip['effects'] = []) =>
  ({
    id,
    assetId,
    trackId,
    start: 0,
    end: 4,
    sourceStart: 0,
    sourceEnd: 4,
    effects,
    keyframes: [],
  }) as Clip;

const lane = (id: string, type: Track['type'], clips: Clip[]): Track => ({ id, type, clips });

describe('trackMatteOptions', () => {
  it('offers titles and shapes on overlay lanes, and never audio or caption lanes', () => {
    const fill = clip('fill', 'cam', 'v1');
    const timeline: Timeline = {
      tracks: [
        lane('o1', 'overlay', [
          clip('title', '__text__', 'o1', [
            { id: 't', type: 'text', params: { text: 'HELLO' }, keyframes: [] },
          ]),
          clip('box', '__shape__', 'o1'),
        ]),
        lane('v1', 'video', [fill]),
        lane('v2', 'video', [clip('shot', 'cam', 'v2')]),
        lane('a1', 'audio', [clip('song', 'song', 'a1')]),
        lane('c1', 'caption', [clip('cue', '__caption__', 'c1')]),
      ],
    };
    expect(trackMatteOptions(timeline, fill).map((option) => option.value)).toEqual([
      'clip:title',
      'clip:box',
      'clip:shot',
      'track:o1',
      'track:v2',
    ]);
  });

  it('leaves out a caption cue parked on a picture lane: it is not drawn there', () => {
    const fill = clip('fill', 'cam', 'v1');
    const timeline: Timeline = {
      tracks: [
        lane('o1', 'overlay', [clip('cue', '__caption__', 'o1')]),
        lane('v1', 'video', [fill]),
      ],
    };
    expect(trackMatteOptions(timeline, fill).map((option) => option.value)).toEqual(['track:o1']);
  });
});
