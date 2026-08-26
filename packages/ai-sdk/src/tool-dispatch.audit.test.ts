import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { ToolSpec } from './tool-registry.js';
import { operationsForCall, sanitizeToolArgs, ToolInvocationError } from './tool-dispatch.js';

const ctx = { project: {} as Project };

const stubTool = {
  parameters: {
    type: 'object',
    properties: { durationSeconds: { type: 'number' } },
    additionalProperties: false,
  },
} as ToolSpec;

describe('strict tool intent boundary', () => {
  it('preserves unknown arguments so the registered strict schema can reject them', () => {
    const raw = { durationSeconds: 1, durationSecond: 99 };
    expect(sanitizeToolArgs(stubTool, raw)).toBe(raw);
  });

  it('rejects an unknown top-level argument instead of deleting it', () => {
    expect(() =>
      operationsForCall(
        {
          id: 'strict-extra',
          name: 'adjust_audio',
          arguments: { clipId: 'clip-1', gainDb: -3, projectId: 'invented' },
        },
        ctx,
      ),
    ).toThrow(ToolInvocationError);
  });

  // GAP-006. `add_text_layer` took four fields and produced a default centred caption, so
  // a brief asking for "large typography, important words visually dominant" had no way
  // through — the run that tried reached for punch_in instead, on clips the renderer then
  // ignored. Both runtimes emit the same two ops in the same order.
  it('carries text styling into the effect params, on the clip it just created', () => {
    const ops = operationsForCall(
      {
        id: 't',
        name: 'add_text_layer',
        arguments: {
          trackId: 'txt_main',
          text: '$327,000,000',
          start: 0,
          end: 2,
          sizePercent: 18,
          color: '#ff2d55',
          yPercent: 30,
        },
      },
      { project: { timeline: { tracks: [] } } as unknown as Project },
    );
    expect(ops.map((op) => op.type)).toEqual(['add_text_overlay', 'set_effect_params']);
    const [created, styled] = ops as [
      { clipId: string },
      { clipId: string; effectId: string; params: Record<string, unknown> },
    ];
    expect(styled.clipId).toBe(created.clipId);
    expect(styled.effectId).toBe(`${created.clipId}__text`);
    expect(styled.params).toEqual({ fontSizePercent: 18, color: '#ff2d55', yPercent: 30 });
  });

  it('adds no styling op when no styling was asked for', () => {
    const ops = operationsForCall(
      {
        id: 't',
        name: 'add_text_layer',
        arguments: { trackId: 'txt_main', text: 'GONE.', start: 0, end: 2 },
      },
      { project: { timeline: { tracks: [] } } as unknown as Project },
    );
    expect(ops.map((op) => op.type)).toEqual(['add_text_overlay']);
  });

  // GAP-004. A transform keyframe on a caption clip validates, applies, survives undo,
  // reports an edit — and renders as nothing, because caption motion comes from the
  // caption style. Text overlays DO read the transform now, so only captions refuse.
  it('refuses a keyframe on a caption clip and names where caption motion lives', () => {
    const captioned = {
      timeline: {
        tracks: [
          {
            id: 'cap_1',
            type: 'caption',
            clips: [{ id: 'cue_1', assetId: '__caption__', trackId: 'cap_1', start: 0, end: 1 }],
          },
          {
            id: 'ov_1',
            type: 'overlay',
            clips: [{ id: 'txt_1', assetId: '__text__', trackId: 'ov_1', start: 0, end: 1 }],
          },
        ],
      },
    } as unknown as Project;
    expect(() =>
      operationsForCall(
        { id: 'p', name: 'punch_in', arguments: { clipId: 'cue_1', toScale: 1.2 } },
        { project: captioned },
      ),
    ).toThrow(/caption style/);
    expect(() =>
      operationsForCall(
        {
          id: 'k',
          name: 'add_keyframes',
          arguments: {
            clipId: 'cue_1',
            keyframes: [{ time: 0, property: 'scale', value: 1 }],
          },
        },
        { project: captioned },
      ),
    ).toThrow(/caption style/);
    // The text overlay next to it is untouched: that one really animates.
    expect(
      operationsForCall(
        { id: 't', name: 'punch_in', arguments: { clipId: 'txt_1', toScale: 1.2 } },
        { project: captioned },
      ),
    ).toHaveLength(1);
  });

  it('rejects an inverted punch-in window instead of silently replacing the end time', () => {
    expect(() =>
      operationsForCall(
        {
          id: 'bad-punch',
          name: 'punch_in',
          arguments: { clipId: 'clip-1', startTime: 2, endTime: 1 },
        },
        ctx,
      ),
    ).toThrow(/endTime \(1\) must be greater than startTime \(2\)/);
  });

  it('rejects an explicit empty manage-assets plan instead of switching to by-kind', () => {
    expect(() =>
      operationsForCall(
        {
          id: 'empty-plan',
          name: 'manage_assets',
          arguments: { strategy: 'plan', folders: [], assignments: [] },
        },
        ctx,
      ),
    ).toThrow(/requires at least one folder or assignment/);
  });
});
