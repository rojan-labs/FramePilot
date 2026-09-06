import { describe, expect, it } from 'vitest';

import { neverSucceededTools, type ToolAttempt } from './unfinished-work.js';

/**
 * GOLDEN-C.19. Desktop run `137d8fd0` called `caption_the_edit` eleven times and
 * `professional_audio` ten, never succeeded at either, and closed with a receipt that said
 * neither. This is the derivation the receipt was missing.
 */
describe('neverSucceededTools', () => {
  const failed = (tool: string, failureReason: string): ToolAttempt => ({
    tool,
    status: 'failed',
    failureReason,
  });

  it('lists a tool whose every call failed, with its LAST reason', () => {
    const attempts: ToolAttempt[] = [
      failed('caption_the_edit', 'add_caption_layer.end must be greater than start.'),
      failed('caption_the_edit', 'no transcript on the timeline'),
    ];
    expect(neverSucceededTools(attempts)).toEqual([
      { tool: 'caption_the_edit', reason: 'no transcript on the timeline' },
    ]);
  });

  it('drops a tool that failed and then succeeded — a fixed retry is not unfinished work', () => {
    const attempts: ToolAttempt[] = [
      failed('trim_clip', 'overlaps a neighbour'),
      { tool: 'trim_clip', status: 'completed' },
    ];
    expect(neverSucceededTools(attempts)).toEqual([]);
  });

  it('counts a warning as success — an advisory is still a real answer', () => {
    const attempts: ToolAttempt[] = [
      failed('add_clip', 'the range is occupied'),
      { tool: 'add_clip', status: 'warning' },
    ];
    expect(neverSucceededTools(attempts)).toEqual([]);
  });

  it('drops a tool that succeeded before it later failed', () => {
    // One later failure does not make a tool the run never got working.
    const attempts: ToolAttempt[] = [
      { tool: 'detect_beats', status: 'completed' },
      failed('detect_beats', 'ffprobe exited 1'),
    ];
    expect(neverSucceededTools(attempts)).toEqual([]);
  });

  it('ignores calls that never settled either way', () => {
    // `cancelled` is the editor stopping the run, not the tool being unable; `running` has
    // no outcome at all. Neither is evidence, so neither creates or clears an entry.
    expect(
      neverSucceededTools([
        { tool: 'transcribe', status: 'cancelled' },
        { tool: 'transcribe', status: 'running' },
      ]),
    ).toEqual([]);
    expect(
      neverSucceededTools([
        failed('transcribe', 'sidecar is not running'),
        { tool: 'transcribe', status: 'cancelled' },
      ]),
    ).toEqual([{ tool: 'transcribe', reason: 'sidecar is not running' }]);
  });

  it('keeps a failure that stated no reason, rather than dropping the tool', () => {
    expect(neverSucceededTools([{ tool: 'professional_audio', status: 'failed' }])).toEqual([
      { tool: 'professional_audio', reason: '' },
    ]);
  });

  it('reports in first-call order — the earliest dead end shaped everything after it', () => {
    const attempts: ToolAttempt[] = [
      failed('professional_audio', 'no audio track'),
      failed('measure_color', 'not available in this stage'),
      failed('professional_audio', 'no audio track'),
    ];
    expect(neverSucceededTools(attempts).map((t) => t.tool)).toEqual([
      'professional_audio',
      'measure_color',
    ]);
  });

  it('says nothing about a run where everything worked', () => {
    expect(
      neverSucceededTools([
        { tool: 'get_timeline', status: 'completed' },
        { tool: 'trim_clip', status: 'completed' },
      ]),
    ).toEqual([]);
  });
});
