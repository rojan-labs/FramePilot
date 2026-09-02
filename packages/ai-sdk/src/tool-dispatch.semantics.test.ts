/**
 * Relationships between arguments that a per-field schema cannot express.
 *
 * These are the calls whose individual fields are all well-typed but whose combination is
 * not a request the tool can honor. Rejecting them here costs the agent one turn and a
 * precise message; repairing them silently costs it the edit it thought it made.
 */
import { describe, expect, it } from 'vitest';
import { parseProject } from '@framepilot/timeline-schema';
import {
  ToolInvocationError,
  operationsForCall,
  validateSemanticToolArgs,
} from './tool-dispatch.js';

const call = (name: string, args: unknown) => ({ id: 'c', name, arguments: args });

describe('punch_in windows', () => {
  it('accepts an ordered window and leaves an unspecified one alone', () => {
    expect(() =>
      validateSemanticToolArgs(call('punch_in', { startTime: 1, endTime: 3 })),
    ).not.toThrow();
    expect(() => validateSemanticToolArgs(call('punch_in', { startTime: 1 }))).not.toThrow();
    expect(() => validateSemanticToolArgs(call('punch_in', {}))).not.toThrow();
  });

  it('refuses an inverted or collapsed window instead of substituting a default span', () => {
    expect(() => validateSemanticToolArgs(call('punch_in', { startTime: 5, endTime: 3 }))).toThrow(
      /greater than startTime/i,
    );
    expect(() => validateSemanticToolArgs(call('punch_in', { startTime: 5, endTime: 5 }))).toThrow(
      /greater than startTime/i,
    );
  });
});

describe('manage_assets plans', () => {
  it('accepts a plan that actually contains a plan', () => {
    expect(() =>
      validateSemanticToolArgs(call('manage_assets', { strategy: 'plan', folders: [{ id: 'f' }] })),
    ).not.toThrow();
    expect(() =>
      validateSemanticToolArgs(
        call('manage_assets', { strategy: 'plan', assignments: [{ assetId: 'a' }] }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSemanticToolArgs(call('manage_assets', { strategy: 'by-kind' })),
    ).not.toThrow();
  });

  it('refuses an empty plan rather than silently reorganising by kind', () => {
    // Falling back to by-kind would reshape the whole bin under a request that asked for
    // something specific — a different edit than the one the model believes it made.
    expect(() => validateSemanticToolArgs(call('manage_assets', { strategy: 'plan' }))).toThrow(
      /at least one folder or assignment/i,
    );
    expect(() =>
      validateSemanticToolArgs(
        call('manage_assets', { strategy: 'plan', folders: [], assignments: [] }),
      ),
    ).toThrow(/at least one folder or assignment/i);
    expect(() =>
      validateSemanticToolArgs(
        call('manage_assets', { strategy: 'plan', folders: 'nope', assignments: 'nope' }),
      ),
    ).toThrow(/at least one folder or assignment/i);
  });
});

describe('malformed envelopes', () => {
  it('leaves a non-object argument payload to the schema layer', () => {
    for (const args of [undefined, null, 'nope', [1, 2]]) {
      expect(() => validateSemanticToolArgs(call('punch_in', args))).not.toThrow();
    }
  });
});

describe('a refusal is not a bad argument', () => {
  /**
   * The defect this pins: every throw out of `buildOps` was wrapped as
   * `invalid_args`, so a policy refusal reached the model as `Invalid arguments
   * for "add_clip": Refused: …`. Told its arguments were wrong, a model fixes
   * arguments — it nudges `start`, tries another `trackId` — instead of taking
   * the alternative the refusal sentence names.
   */
  const project = parseProject({
    id: 'proj_refusal',
    name: 'Refusal',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'asset_v', path: 'media/a.mp4', kind: 'video', durationSeconds: 60 },
      { id: 'asset_b', path: 'media/b.mp4', kind: 'video', durationSeconds: 60 },
    ],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_v',
              trackId: 'video_1',
              start: 0,
              end: 10,
              sourceStart: 0,
              sourceEnd: 10,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'video_2', type: 'video', clips: [] },
      ],
      markers: [],
    },
  });

  const stack = () =>
    operationsForCall(
      call('add_clip', {
        trackId: 'video_2',
        assetId: 'asset_b',
        start: 2,
        end: 6,
        sourceStart: 0,
      }),
      { project },
    );

  it('is classified `refusal`, never `invalid_args`', () => {
    let error: unknown;
    try {
      stack();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ToolInvocationError);
    expect((error as ToolInvocationError).code).toBe('refusal');
    expect((error as ToolInvocationError).code).not.toBe('invalid_args');
  });

  it('carries the refusal sentence verbatim, with no "Invalid arguments" prefix', () => {
    expect(stack).toThrow(/^Refused: /);
    let error: ToolInvocationError | undefined;
    try {
      stack();
    } catch (caught) {
      error = caught as ToolInvocationError;
    }
    expect(error?.message).not.toContain('Invalid arguments');
    // The editor sees the same plain sentence — a refusal needs no translation.
    expect(error?.editorSummary).toBe(error?.message);
  });

  it('still classifies a genuinely malformed call as `invalid_args`', () => {
    let error: ToolInvocationError | undefined;
    try {
      operationsForCall(call('add_clip', { trackId: 'video_2' }), { project });
    } catch (caught) {
      error = caught as ToolInvocationError;
    }
    expect(error?.code).toBe('invalid_args');
    expect(error?.message).toContain('Invalid arguments');
  });
});
