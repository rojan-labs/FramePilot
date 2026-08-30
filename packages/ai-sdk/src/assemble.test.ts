/**
 * assemble — the diagnosability of a rejected patch.
 *
 * A batch tool builds one operation per cue or per entry, so "which one?" is the only
 * question a rejection has to answer. These tests pin that the answer survives both gates:
 * the semantic contract (which never captured the index) and the structural validator
 * (which captured it and had it discarded on the way out).
 */
import { describe, expect, it } from 'vitest';
import type { AnyOperation, ValidationIssue } from '@framepilot/editor-core';
import { parseProject } from '@framepilot/timeline-schema';
import { assembleEdit, describeValidationIssue } from './assemble.js';
import { makeProject } from './__fixtures__/project.js';

const captionOp = (start: number, end: number): AnyOperation =>
  ({ type: 'add_caption_layer', trackId: 'caption_1', start, end }) as AnyOperation;

/** The fixture project plus an empty caption track to hold caption layers. */
function projectWithCaptionTrack() {
  const base = makeProject();
  return parseProject({
    ...base,
    timeline: {
      ...base.timeline,
      tracks: [...base.timeline.tracks, { id: 'caption_1', type: 'caption', clips: [] }],
    },
  });
}

const errorMessages = (issues: readonly ValidationIssue[], ops: readonly AnyOperation[]): string =>
  issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => describeValidationIssue(issue, ops))
    .join('; ');

describe('describeValidationIssue', () => {
  const ops: readonly AnyOperation[] = [captionOp(0, 1), captionOp(2, 3)];

  it('returns the bare message when the issue names no operation', () => {
    const issue: ValidationIssue = {
      code: 'negative_duration',
      severity: 'error',
      message: 'Transition duration must be positive.',
    };
    expect(describeValidationIssue(issue, ops)).toBe('Transition duration must be positive.');
  });

  it('returns the bare message when the index does not resolve to an operation', () => {
    const issue: ValidationIssue = {
      code: 'invalid_cue',
      severity: 'error',
      message: 'Cue is empty.',
      operationIndex: 7,
    };
    expect(describeValidationIssue(issue, ops)).toBe('Cue is empty.');
  });

  it('adds only the position when the reason already opens with the operation type', () => {
    const issue: ValidationIssue = {
      code: 'unsupported_operation',
      severity: 'error',
      message: 'add_caption_layer.end must be greater than start: both are 2s.',
      operationIndex: 1,
    };
    expect(describeValidationIssue(issue, ops)).toBe(
      'op 2 of 2: add_caption_layer.end must be greater than start: both are 2s.',
    );
  });

  it('adds the position, type, and time range when the reason names neither', () => {
    const issue: ValidationIssue = {
      code: 'overlap_error',
      severity: 'error',
      message: 'Clips overlap on track caption_1.',
      operationIndex: 1,
    };
    expect(describeValidationIssue(issue, ops)).toBe(
      'op 2 of 2 (add_caption_layer, 2s–3s): Clips overlap on track caption_1.',
    );
  });

  it('names an operation that carries no time range by type alone', () => {
    const split = { type: 'split_clip', clipId: 'clip_a', at: 3 } as unknown as AnyOperation;
    const issue: ValidationIssue = {
      code: 'missing_reference',
      severity: 'error',
      message: 'Clip not found: clip_a.',
      operationIndex: 0,
    };
    expect(describeValidationIssue(issue, [split])).toBe(
      'op 1 of 1 (split_clip): Clip not found: clip_a.',
    );
  });
});

describe('assembleEdit → locating the operation that was rejected', () => {
  it('names which raw operation the semantic contract refused', () => {
    const project = projectWithCaptionTrack();
    const operations = [captionOp(0, 1), captionOp(2, 2), captionOp(4, 5)];

    const result = assembleEdit(project, operations, 'captions');

    expect(result.validation.valid).toBe(false);
    // The index the replay loop knew all along: without it, all three operations produce
    // the identical sentence and the author cannot tell them apart.
    expect(result.validation.issues[0]?.operationIndex).toBe(1);
    expect(errorMessages(result.validation.issues, result.patch.operations)).toBe(
      'op 2 of 3: add_caption_layer.end must be greater than start: both are 2s, so it ' +
        'would occupy no time.',
    );
  });

  it('names which operation the structural validator refused', () => {
    const project = projectWithCaptionTrack();
    const operations = [
      captionOp(0, 1),
      {
        type: 'add_clip',
        trackId: 'video_1',
        assetId: 'asset_missing',
        start: 20,
        end: 22,
        sourceStart: 0,
        sourceEnd: 2,
      } as unknown as AnyOperation,
    ];

    const result = assembleEdit(project, operations, 'insert');

    expect(result.validation.valid).toBe(false);
    const message = errorMessages(result.validation.issues, result.patch.operations);
    expect(message).toContain('op 2 of 2 (add_clip, 20s–22s):');
    expect(message).toContain('asset_missing');
  });

  it('does not repeat the operation type when the reason already carries it', () => {
    const project = projectWithCaptionTrack();
    const result = assembleEdit(project, [captionOp(5, 4)], 'backwards cue');

    const message = errorMessages(result.validation.issues, result.patch.operations);
    expect(message.match(/add_caption_layer/g)).toHaveLength(1);
    expect(message).toBe(
      'op 1 of 1: add_caption_layer.end must be greater than start: 5s → 4s runs backwards.',
    );
  });
});

describe('assembleEdit → the contract gate after frame quantization', () => {
  it('rejects a cue that snapping collapses onto a single frame, and says which one', () => {
    // The run this fix comes from: a caption pass emitted a sub-frame cue among dozens of
    // good ones. 18.06s and 18.07s are both frame 542 at 30fps, so the snapped layer would
    // occupy no time — intent the RAW contract accepts (0.01s > 0) and only the
    // post-normalization contract can catch. This branch was annotated "unreachable".
    const project = projectWithCaptionTrack();
    const operations = [captionOp(0, 1), captionOp(18.06, 18.07), captionOp(20, 21)];

    const result = assembleEdit(project, operations, 'captions');

    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues[0]?.code).toBe('unsupported_operation');
    expect(result.validation.issues[0]?.operationIndex).toBe(1);
    const message = errorMessages(result.validation.issues, result.patch.operations);
    expect(message).toContain('op 2 of 3:');
    expect(message).toContain('add_caption_layer.end must be greater than start');
    // Reported in the SNAPPED numbers, because those are the ones that are equal — the
    // model's own 18.06/18.07 would look fine and explain nothing.
    expect(message).toContain('18.06666');
  });

  it('accepts a cue that is short but still lands on two distinct frames', () => {
    const project = projectWithCaptionTrack();
    const result = assembleEdit(project, [captionOp(18.06, 18.1)], 'captions');

    expect(result.validation.valid).toBe(true);
  });
});
