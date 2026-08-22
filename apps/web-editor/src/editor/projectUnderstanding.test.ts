/**
 * Tests for the per-run understanding assembly.
 *
 * The defect this closes is a parity one: the desktop hub read the visual status, the cached
 * footage map and the session digest before every run; the browser session read none of them.
 * In a captured browser run the editor said "choose from footage map", the agent had no map in
 * context, never called for one, and narrated chapter titles it had invented instead.
 *
 * What must hold is that all three are attempted, that any of them failing costs the run
 * nothing but its own block, and that nothing empty is passed off as knowledge.
 */
import { describe, expect, it, vi } from 'vitest';
import { readProjectUnderstanding, type UnderstandingReads } from './projectUnderstanding.js';

const reads = (over: Partial<UnderstandingReads> = {}): UnderstandingReads => ({
  visualStatus: () => Promise.resolve('this footage is indexed'),
  footageMap: () => Promise.resolve('Footage map — 3 chapters'),
  sessionContext: () => Promise.resolve('### Decisions\nthe editor chose full-bleed'),
  ...over,
});

describe('readProjectUnderstanding', () => {
  it('keeps every block that answered', async () => {
    expect(await readProjectUnderstanding(reads())).toEqual({
      visualStatus: 'this footage is indexed',
      footageMap: 'Footage map — 3 chapters',
      sessionContext: '### Decisions\nthe editor chose full-bleed',
    });
  });

  it('attempts all three, concurrently rather than in sequence', async () => {
    const started: string[] = [];
    const slow = (label: string, value: string): (() => Promise<string>) => async () => {
      started.push(label);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    };
    const result = await readProjectUnderstanding({
      visualStatus: slow('status', 'a'),
      footageMap: slow('map', 'b'),
      sessionContext: slow('session', 'c'),
    });
    // All three were in flight before the first resolved — they must not queue at the head of
    // every run.
    expect(started).toEqual(['status', 'map', 'session']);
    expect(result).toEqual({ visualStatus: 'a', footageMap: 'b', sessionContext: 'c' });
  });

  it('drops a block whose read rejected, and keeps the others', async () => {
    const result = await readProjectUnderstanding(
      reads({
        footageMap: () => Promise.reject(new Error('sidecar unreachable')),
      }),
    );
    expect(result.footageMap).toBeUndefined();
    expect(result.visualStatus).toBe('this footage is indexed');
    expect(result.sessionContext).toContain('full-bleed');
  });

  it('survives every read failing — a run must never die for want of context', async () => {
    const boom = () => Promise.reject(new Error('down'));
    await expect(
      readProjectUnderstanding({ visualStatus: boom, footageMap: boom, sessionContext: boom }),
    ).resolves.toEqual({});
  });

  it('treats an empty or blank answer as nothing to say', async () => {
    // An empty block would spend prompt budget announcing that there is nothing to announce.
    const result = await readProjectUnderstanding(
      reads({
        visualStatus: () => Promise.resolve(''),
        footageMap: () => Promise.resolve('   \n  '),
        sessionContext: () => Promise.resolve(undefined),
      }),
    );
    expect(result).toEqual({});
  });

  it('does not let a rejection escape as an unhandled rejection', async () => {
    const spy = vi.fn();
    process.on('unhandledRejection', spy);
    await readProjectUnderstanding(reads({ sessionContext: () => Promise.reject(new Error('x')) }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', spy);
    expect(spy).not.toHaveBeenCalled();
  });
});
