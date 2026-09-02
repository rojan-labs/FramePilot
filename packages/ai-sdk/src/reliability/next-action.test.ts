import { describe, expect, it } from 'vitest';
import { namesNextAction, toolsNamedIn } from './next-action.js';

/**
 * A stand-in registry. The gate itself walks the real `TOOL_REGISTRY`; these unit tests
 * only need names to match against, and pinning three keeps the fixtures readable.
 */
const TOOLS = ['add_clip', 'get_frame', 'get_clips', 'search_stock'];

describe('namesNextAction — the two historical dead ends', () => {
  // Both strings are quoted EXACTLY as they reached the model in captured run `369e8c82`,
  // before `92a0387` fixed them. They are the reason this predicate exists: if a rule
  // change ever lets one of them through, the rule is wrong, not the fixture.
  it('rejects the bare machine token map_footage returned six times', () => {
    const verdict = namesNextAction('"map_footage": not_indexed', TOOLS);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain('bare token');
  });

  it('rejects the Sounds panel sentence add_music refused with', () => {
    const verdict = namesNextAction(
      'That track is already in your media bin — it was not downloaded again. ' +
        'Place it from the bin, or pick a different track.',
      TOOLS,
    );
    expect(verdict.ok).toBe(false);
    // The point of this fixture: it DOES offer an alternative ("pick a different track")
    // and is still a dead end, because the alternative is not a move the caller can make.
    expect(verdict.why).toContain('from the bin');
  });

  it('accepts the replacement 92a0387 shipped for it', () => {
    const verdict = namesNextAction(
      'That track is already in your media bin as asset "music_openverse_ov_1" — it was ' +
        'not downloaded again. Place it with add_clip on an audio track (assetId ' +
        '"music_openverse_ov_1"), or search for a different track.',
      ['add_clip', 'add_music'],
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toContain('add_clip');
  });
});

describe('namesNextAction — rule 1, it said what happened', () => {
  it('rejects an empty message', () => {
    expect(namesNextAction('', TOOLS).ok).toBe(false);
  });

  it('rejects a message that is only the executor envelope', () => {
    expect(namesNextAction('"get_frame" failed:', TOOLS).ok).toBe(false);
  });

  it('rejects a four-word fragment with no instruction in it', () => {
    const verdict = namesNextAction('"search_media" failed: search response was malformed', TOOLS);
    expect(verdict.ok).toBe(false);
  });
});

describe('namesNextAction — rule 2, it named a move the model can make', () => {
  it('accepts a sentence naming a registered tool', () => {
    const verdict = namesNextAction(
      'Cannot measure color: that clip is missing or is not visual. Call get_clips to see ' +
        'the clips on the timeline and their ids, then measure one on a video track.',
      TOOLS,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toContain('get_clips');
  });

  it('accepts a sentence that closes itself off with no tool at all', () => {
    const verdict = namesNextAction(
      'the understanding backend is not available for this project, so no clip can be ' +
        'described in this run. Select on the search text and titles you already have, and ' +
        'say plainly that you could not inspect the footage.',
      TOOLS,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toContain('closes itself off');
  });

  it('does not let a tool name in the envelope stand in for an instruction', () => {
    // Without the envelope strip, EVERY host outcome would pass rule 2 by quoting itself.
    const verdict = namesNextAction(
      '"get_frame" failed: the engine returned nothing at all',
      TOOLS,
    );
    expect(verdict.ok).toBe(false);
  });

  it('does not let a quoted id stand in for an instruction', () => {
    const verdict = namesNextAction(
      'The asset "get_frame" could not be read from disk on this machine.',
      TOOLS,
    );
    expect(verdict.ok).toBe(false);
  });

  it('rejects a tool name that is not registered', () => {
    // "naming a real tool with its real arguments, verified in the registry, never
    // guessed" — a sentence pointing at `place_clip` names a move nobody can make.
    const verdict = namesNextAction(
      'That clip is already downloaded. Place it with place_clip on a video track instead.',
      TOOLS,
    );
    expect(verdict.ok).toBe(false);
  });
});

describe('toolsNamedIn', () => {
  it('does not match a tool name inside a longer identifier', () => {
    expect(toolsNamedIn('use add_clips for several at once', ['add_clip'])).toEqual([]);
    expect(toolsNamedIn('use add_clip for one', ['add_clip'])).toEqual(['add_clip']);
  });

  it('ignores names that only appear quoted', () => {
    expect(toolsNamedIn('"add_clip" was called with no assetId', ['add_clip'])).toEqual([]);
  });
});
