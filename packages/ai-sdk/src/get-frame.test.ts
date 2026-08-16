/**
 * Tests for the `get_frame` vision path — the model LOOKING at its own edit.
 *
 * The failure this whole path exists to prevent is a model reasoning about how an edit
 * looks purely from numbers, so the tests are about the guarantees that make the picture
 * trustworthy:
 *
 *  - the frame is rendered from the run's WORKING copy, not a saved file;
 *  - a model that cannot see is never offered the tool at all;
 *  - the base64 blob never leaks into the text action log;
 *  - a frame is shown once and then dropped, never re-sent turn after turn.
 */
import { describe, expect, it } from 'vitest';
import { frameBody, unwrapFrame } from './sidecar-executor.js';
import { supportsVision } from './providers/model-capabilities.js';
import { framesBlock } from './prompts.js';
import { getTool } from './tool-registry.js';
import { withReplayedImageNote } from './tool-executor.js';
import type { Project } from '@framepilot/timeline-schema';

const project = { id: 'p1', name: 'Demo' } as unknown as Project;

/** A well-formed `/render/frame` response body. */
const engineResponse = {
  media_type: 'image/jpeg',
  base64: 'AAECAw==',
  width: 288,
  height: 512,
  time_seconds: 12.4,
  duration_seconds: 60,
};

describe('get_frame — the tool surface', () => {
  it('is registered, available, and declares the vision capability that gates it', () => {
    const tool = getTool('get_frame');
    expect(tool).toBeDefined();
    expect(tool?.available).toBe(true);
    expect(tool?.mutates).toBe(false);
    expect(tool?.capabilities).toContain('vision');
  });

  it('rejects a call with no time, and accepts the documented shape', () => {
    const tool = getTool('get_frame')!;
    expect(() => tool.parse({})).toThrow();
    expect(tool.parse({ timeSeconds: 12.4 })).toEqual({ timeSeconds: 12.4 });
    expect(tool.parse({ timeSeconds: 1, maxDimension: 768, burnCaptions: false })).toEqual({
      timeSeconds: 1,
      maxDimension: 768,
      burnCaptions: false,
    });
    // An image big enough to crowd the context out of the window is refused up front.
    expect(() => tool.parse({ timeSeconds: 1, maxDimension: 4096 })).toThrow();
  });
});

describe('supportsVision — who gets offered the tool', () => {
  it('recognises the multimodal families', () => {
    expect(supportsVision('anthropic', 'claude-sonnet-5')).toBe(true);
    expect(supportsVision('google', 'gemini-2.5-pro')).toBe(true);
    expect(supportsVision('openrouter', 'openai/gpt-4o-mini')).toBe(true);
    expect(supportsVision('nvidia', 'meta/llama-3.2-90b-vision-instruct')).toBe(true);
  });

  it('defaults to NO for a text-only or unknown model', () => {
    // The expensive failure: an image billed as input tokens, answered with a confident
    // description of a picture the model never received.
    expect(supportsVision('nvidia', 'meta/llama-3.1-70b-instruct')).toBe(false);
    expect(supportsVision('deepseek', 'deepseek-chat')).toBe(false);
    expect(supportsVision('ollama', 'some-model-nobody-has-heard-of')).toBe(false);
    expect(supportsVision('anthropic', undefined)).toBe(false);
  });
});

describe('frameBody — what goes to the engine', () => {
  it('sends the inline WORKING project, never a path', () => {
    // The frame is asked for to check an edit that has not been saved.
    const body = frameBody(project, { timeSeconds: 12.4 });
    expect(body.project).toBe(project);
    expect(body).not.toHaveProperty('project_path');
    expect(body.time_seconds).toBe(12.4);
  });

  it('omits the optional knobs entirely rather than sending nulls', () => {
    expect(frameBody(project, { timeSeconds: 0 })).not.toHaveProperty('max_dimension');
    const tuned = frameBody(project, { timeSeconds: 0, maxDimension: 768, burnCaptions: false });
    expect(tuned.max_dimension).toBe(768);
    expect(tuned.burn_captions).toBe(false);
  });
});

describe('unwrapFrame — how the picture reaches the model', () => {
  it('puts the image on the image channel and the FACTS in the data/log channel', () => {
    const outcome = unwrapFrame({ timeSeconds: 12.4 }, engineResponse);
    expect(outcome.status).toBe('completed');
    expect(outcome.images).toEqual([
      { mediaType: 'image/jpeg', base64: 'AAECAw==', label: 'the timeline at 12.40s' },
    ]);
    // The blob must NEVER end up in `data` — `data` is rendered into the run's text
    // action log, where a base64 image is unreadable and enormous.
    expect(JSON.stringify(outcome.data)).not.toContain('AAECAw==');
    expect(outcome.data).toMatchObject({ timeSeconds: 12.4, clamped: false, width: 288 });
  });

  it('says plainly when the frame is not from the time that was asked for', () => {
    // Being shown a different moment than you asked about, silently, is worse than an
    // error: the model reports a problem at the wrong timestamp.
    const outcome = unwrapFrame({ timeSeconds: 99 }, { ...engineResponse, time_seconds: 59.9 });
    expect(outcome.summary).toContain('clamped from 99.00s');
    expect(outcome.data).toMatchObject({ clamped: true, requestedTimeSeconds: 99 });
  });

  it('fails honestly when the engine returns no usable image', () => {
    const empty = unwrapFrame({ timeSeconds: 1 }, { ...engineResponse, base64: '' });
    expect(empty.status).toBe('failed');
    expect(empty.images).toBeUndefined();
    // A media type no provider accepts is not an image we can send.
    const wrongType = unwrapFrame(
      { timeSeconds: 1 },
      { ...engineResponse, media_type: 'image/gif' },
    );
    expect(wrongType.status).toBe('failed');
    expect(wrongType.summary).toContain('image/gif');
  });
});

describe('withReplayedImageNote — an honest payload when the picture is gone', () => {
  it('replaces the attachment claim and keeps every fact', () => {
    const replayed = withReplayedImageNote(unwrapFrame({ timeSeconds: 12.4 }, engineResponse).data);
    expect(replayed).toMatchObject({ timeSeconds: 12.4, width: 288, height: 512 });
    expect(JSON.stringify(replayed)).not.toContain('attached to this turn as an image');
    expect(JSON.stringify(replayed)).toContain('already rendered earlier in this run');
    // It must not send the model back for the same moment — the memo would just replay.
    expect(JSON.stringify(replayed)).toContain('a different time or different options');
  });

  it('leaves a payload that is not an object record alone', () => {
    // A failed outcome's `data` is the reason STRING; wrapping it in an object would turn
    // an error message into a fake frame record.
    expect(withReplayedImageNote('the engine returned no usable image')).toBe(
      'the engine returned no usable image',
    );
    expect(withReplayedImageNote(undefined)).toBeUndefined();
    expect(withReplayedImageNote([1, 2])).toEqual([1, 2]);
  });
});

describe('framesBlock — telling the model which picture is which', () => {
  it('is empty when nothing is attached, so an ordinary turn is unchanged', () => {
    expect(framesBlock()).toBe('');
    expect(framesBlock([])).toBe('');
  });

  it('labels each attached frame in order', () => {
    // Image content carries no caption on any wire format here; without this the model
    // sees three pictures and guesses which is which.
    const block = framesBlock([
      { label: 'the timeline at 2.00s' },
      { label: 'the timeline at 41.50s' },
    ]);
    expect(block).toContain('are 2 images');
    expect(block).toContain('1. the timeline at 2.00s');
    expect(block).toContain('2. the timeline at 41.50s');
    expect(framesBlock([{ label: 'the timeline at 2.00s' }])).toContain('is 1 image');
  });

  it('falls back to a generic label when a frame has none', () => {
    expect(framesBlock([{}])).toContain('1. a frame of the timeline');
  });
});
