/**
 * Arguments a model reaches for that mean exactly one thing, accepted rather than refused.
 *
 * Run `cc907070` lost turns to three of these: `trim_clip {clipId, end}` ("start: expected
 * number, received undefined"), `search_stock {kind: "footage"}` ("expected one of
 * photo|video"), and `professional_audio duck_roles {target: "playhead"}`. The last is
 * covered in `professional-audio.test.ts`; these are the first two.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { operationsForCall } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import { getTool } from '../tool-registry.js';

function project(): Project {
  return parseProject({
    id: 'lenient',
    name: 'Lenient args',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'a', path: 'a.mp4', kind: 'video', durationSeconds: 20 }],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'a',
              trackId: 'v1',
              start: 2,
              end: 6,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
  });
}

const ctx = (): ToolContext => ({ project: project() }) as unknown as ToolContext;

describe('trim_clip fills in the edge that was left out', () => {
  it('reads the missing start from the clip', () => {
    const ops = operationsForCall(
      { id: 'c', name: 'trim_clip', arguments: { clipId: 'clip_a', end: 5 } },
      ctx(),
    );
    expect(ops).toEqual([{ type: 'trim_clip', clipId: 'clip_a', start: 2, end: 5 }]);
  });

  it('reads the missing end from the clip', () => {
    const ops = operationsForCall(
      { id: 'c', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 3 } },
      ctx(),
    );
    expect(ops).toEqual([{ type: 'trim_clip', clipId: 'clip_a', start: 3, end: 6 }]);
  });

  it('still refuses a trim with no edge at all, and an unknown clip with one missing', () => {
    expect(() =>
      operationsForCall({ id: 'c', name: 'trim_clip', arguments: { clipId: 'clip_a' } }, ctx()),
    ).toThrow(/Give start, end, or both/);
    expect(() =>
      operationsForCall(
        { id: 'c', name: 'trim_clip', arguments: { clipId: 'nope', end: 5 } },
        ctx(),
      ),
    ).toThrow(/no clip "nope"/);
  });
});

describe('stock kind accepts the words a model reaches for', () => {
  const parse = (name: string, args: unknown) => getTool(name)!.parse(args) as { kind: string };

  it('maps footage/clip/videos to video and image/still/photos to photo', () => {
    expect(parse('search_stock', { query: 'chairlift', kind: 'footage' }).kind).toBe('video');
    expect(parse('search_stock', { query: 'chairlift', kind: 'Clips' }).kind).toBe('video');
    expect(parse('search_stock', { query: 'snow', kind: 'image' }).kind).toBe('photo');
    expect(parse('add_stock', { remoteId: '123', kind: 'still' }).kind).toBe('photo');
  });

  it('still refuses a kind that means neither', () => {
    expect(() => parse('search_stock', { query: 'x', kind: 'audio' })).toThrow();
  });
});
