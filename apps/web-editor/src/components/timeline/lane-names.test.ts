import { describe, expect, it } from 'vitest';
import type { Track } from '@framepilot/timeline-schema';
import { laneNames } from './lane-names.js';

const track = (id: string, type: Track['type']): Track =>
  ({ id, type, clips: [] }) as unknown as Track;

describe('laneNames', () => {
  it('numbers each prefix independently, top to bottom', () => {
    const tracks = [
      track('t1', 'video'),
      track('t2', 'video'),
      track('t3', 'audio'),
      track('t4', 'audio'),
    ];
    const names = laneNames(tracks, (t) => (t.type === 'video' ? 'video' : 'audio'));
    expect([...names.values()]).toEqual(['V1', 'V2', 'A1', 'A2']);
  });

  it('names by the kind a lane actually holds, not its advisory type', () => {
    // A layer is type-agnostic (ADR 0032): audio dropped on a "video" lane makes
    // it an audio lane, and the header must say so.
    const tracks = [track('t1', 'video'), track('t2', 'video')];
    const names = laneNames(tracks, (t) => (t.id === 't2' ? 'audio' : 'video'));
    expect(names.get('t1')).toBe('V1');
    expect(names.get('t2')).toBe('A1');
  });

  it('groups images with video, since both are picture lanes', () => {
    const tracks = [track('t1', 'video'), track('t2', 'video')];
    const names = laneNames(tracks, (t) => (t.id === 't2' ? 'image' : 'video'));
    expect([...names.values()]).toEqual(['V1', 'V2']);
  });

  it('names an adjustment lane FX without consulting the clip kind', () => {
    const tracks = [track('fx', 'effect'), track('fx2', 'effect')];
    const names = laneNames(tracks, () => {
      throw new Error('effect lanes hold no clips, so their kind must not be read');
    });
    expect([...names.values()]).toEqual(['FX1', 'FX2']);
  });

  it('falls back to a generic lane prefix rather than rendering "undefined"', () => {
    const names = laneNames([track('t1', 'video')], () => undefined);
    expect(names.get('t1')).toBe('L1');
  });

  it('returns an empty map for an empty stack', () => {
    expect(laneNames([], () => 'video').size).toBe(0);
  });
});
