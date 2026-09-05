/**
 * Relationships between arguments that a per-field schema cannot express.
 *
 * These are the calls whose individual fields are all well-typed but whose combination is
 * not a request the tool can honor. Rejecting them here costs the agent one turn and a
 * precise message; repairing them silently costs it the edit it thought it made.
 */
import { describe, expect, it } from 'vitest';
import { parseProject } from '@framepilot/timeline-schema';
import { z } from 'zod/v4';
import {
  ToolInvocationError,
  describeArgValidationError,
  operationsForCall,
  validateSemanticToolArgs,
} from './tool-dispatch.js';
import { makeProject } from './__fixtures__/project.js';

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
        {
          id: 'video_2',
          type: 'video',
          clips: [
            {
              id: 'clip_b',
              assetId: 'asset_b',
              trackId: 'video_2',
              start: 20,
              end: 24,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              // A punch-in: the one thing that makes a stacked layer un-showable.
              keyframes: [{ id: 'k1', time: 0, property: 'scale', value: 0.5, easing: 'linear' }],
            },
          ],
        },
      ],
      markers: [],
    },
  });

  // A bare `add_clip` over picture is no longer refused — ADR 0169 lifts it to a front
  // layer. What is still refused is a layer the preview cannot show: here a scaled clip
  // moved over `clip_a`.
  const stack = () =>
    operationsForCall(call('move_clip', { clipId: 'clip_b', toTrackId: 'video_2', toStart: 2 }), {
      project,
    });

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

/**
 * `Unrecognized keys: "subject", "intent"` says which words were wrong and nothing about
 * where they belong, and the mistake behind it is almost always one tool's arguments sent
 * to its neighbour. Run `137d8fd0` sent `track_object` the `subject` and `intent` that
 * belong to `track_subject_automatically`, read the bare key list, and moved on without
 * ever finding the tool it wanted.
 */
describe('arguments sent to the wrong tool', () => {
  const reasonFor = (name: string, args: Record<string, unknown>): string => {
    try {
      operationsForCall({ id: 'c1', name, arguments: args }, { project: makeProject() } as never);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected a rejection');
  };

  it('names the tool the rejected arguments belong to', () => {
    const reason = reasonFor('track_object', {
      clipId: 'clip_a',
      target: 'object',
      region: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      subject: 'object',
      intent: 'track',
    });
    expect(reason).toContain('Unrecognized keys');
    expect(reason).toContain('those arguments belong to');
    expect(reason).toContain('track_subject_automatically');
  });

  it('offers nothing when no tool declares all of them', () => {
    const reason = reasonFor('track_object', {
      clipId: 'clip_a',
      target: 'object',
      region: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      subject: 'object',
      zzNotAnArgumentAnywhere: 1,
    });
    expect(reason).toContain('Unrecognized keys');
    expect(reason).not.toContain('belong to');
  });

  it('never offers the tool that was called', () => {
    const reason = reasonFor('track_object', {
      clipId: 'clip_a',
      target: 'object',
      region: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      subject: 'object',
      intent: 'track',
    });
    expect(reason).not.toMatch(/belong to[^.]*"track_object"/);
  });
});

/**
 * Zod 4 phrases an enum rejection as `Invalid option: expected one of "photo"|"video"` —
 * every legal value, and never the illegal one that was actually sent. The finalized
 * issue does not carry the input either, so the value has to be read back out of the
 * arguments.
 *
 * Run `137d8fd0` is what the omission costs: two `search_stock` calls and one
 * `track_subject_automatically` call rejected on an enum, each told the options, none
 * told what it had written, none corrected.
 *
 * These parse with a REAL `zod/v4` schema rather than a hand-built issue list, so the
 * test fails if Zod ever changes the issue shape the formatter reads.
 */
describe('a rejected value is quoted back', () => {
  const kindSchema = z.object({ query: z.string(), kind: z.enum(['photo', 'video']) });
  const subjectSchema = z.object({
    target: z.literal('this'),
    subject: z.enum(['point', 'region', 'plane', 'silhouette']),
  });

  const reasonFor = (schema: z.ZodType, args: Record<string, unknown>, tool = ''): string => {
    const result = schema.safeParse(args);
    if (result.success) throw new Error('expected a rejection');
    return describeArgValidationError(result.error, tool, args);
  };

  it('names the value the enum refused, not only the ones it accepts', () => {
    const reason = reasonFor(kindSchema, { query: 'chairlift overhead', kind: 'clip' });
    expect(reason).toContain('expected one of');
    expect(reason).toContain('received "clip"');
  });

  it('points a near-miss at the option it plainly meant', () => {
    const reason = reasonFor(kindSchema, { query: 'snow texture', kind: 'Videos' });
    expect(reason).toContain('received "Videos"; use "video"');
  });

  it('says nothing extra when the value is nowhere near an option', () => {
    // A different intention, not a typo. Guessing here would send the run somewhere it
    // never asked to go, so the refusal stops at quoting what arrived.
    const reason = reasonFor(subjectSchema, { target: 'this', subject: 'object' });
    expect(reason).toContain('received "object"');
    expect(reason).not.toContain('; use "');
  });

  it('quotes the value a literal refused too', () => {
    // `professional_audio` was refused three times this way in the same run, on
    // `target: Invalid input: expected "this"` with no mention of what it passed.
    const reason = reasonFor(subjectSchema, { target: 'selection', subject: 'point' });
    expect(reason).toContain('received "selection"');
  });

  it('is silent when the arguments were not passed, rather than inventing a value', () => {
    const result = kindSchema.safeParse({ query: 'q', kind: 'clip' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(describeArgValidationError(result.error, '')).not.toContain('received');
  });

  it('leaves the wrong-tool routing clause alone when both could apply', () => {
    // `ownerHint` is the more actionable of the two and wins; the value clause is the
    // fallback, not an addition, so a refusal never carries two competing remedies.
    let reason = '';
    try {
      operationsForCall(
        {
          id: 'c1',
          name: 'track_object',
          arguments: {
            clipId: 'clip_a',
            target: 'object',
            region: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
            subject: 'object',
            intent: 'track',
          },
        },
        { project: makeProject() } as never,
      );
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    expect(reason).toContain('those arguments belong to');
  });
});
