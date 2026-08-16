/**
 * Tests for {@link describeOperation} (Phase 11 M1): turning typed operations into
 * the action/detail/refs a timeline-action card renders. Covers known + unknown op
 * types and the optional id/range fields. 100% coverage.
 */
import { describe, expect, it } from 'vitest';
import type { AnyOperation } from '@framepilot/editor-core';
import { describeOperation, describeToolCall } from './describe.js';
import type { ProjectNames } from './names.js';

const op = (o: Record<string, unknown>): AnyOperation => o as unknown as AnyOperation;

/** A stub resolver so name-aware assertions don't need a whole project. */
const names: ProjectNames = {
  clip: (id) => (id === 'clip_x' ? 'Intro.mp4' : id),
  track: (id) => (id === 'video_1' ? 'Video 1' : id),
  asset: (id) => (id === 'asset_1' ? 'Intro.mp4' : id),
};

describe('describeOperation', () => {
  it('labels a known op, extracts a track ref and a time range', () => {
    const d = describeOperation(
      op({ type: 'delete_range', trackId: 'video_1', start: 0, end: 3.2 }),
    );
    expect(d.action).toBe('Deleted range');
    expect(d.detail).toBe('0s–3.2s');
    expect(d.refs).toEqual([{ kind: 'track', id: 'video_1', label: 'video_1' }]);
  });

  it('extracts clip and asset refs', () => {
    const d = describeOperation(op({ type: 'add_clip', clipId: 'clip_x', assetId: 'asset_1' }));
    expect(d.action).toBe('Added clip');
    expect(d.refs.map((r) => r.kind)).toEqual(['clip', 'asset']);
    expect(d.detail).toBe('');
  });

  it('humanizes an unknown op type and yields no refs or detail', () => {
    const d = describeOperation(op({ type: 'frobnicate_widget' }));
    expect(d.action).toBe('Frobnicate widget');
    expect(d.refs).toEqual([]);
    expect(d.detail).toBe('');
  });

  it('labels a set_track_flags op and summarizes the flags it sets', () => {
    const d = describeOperation(
      op({ type: 'set_track_flags', trackId: 'video_1', muted: true, locked: false }),
    );
    expect(d.action).toBe('Updated track');
    expect(d.detail).toBe('muted, unlocked');
    expect(d.refs).toEqual([{ kind: 'track', id: 'video_1', label: 'video_1' }]);
  });

  it('labels the styling/timing/marker ops in editor language (no schema jargon)', () => {
    // These op types used to fall through to humanize() ("Set clip blend mode"),
    // leaking data-model naming into the sidebar. Pin the editor-speak labels.
    expect(describeOperation(op({ type: 'set_caption_style' })).action).toBe('Styled captions');
    expect(describeOperation(op({ type: 'set_clip_speed' })).action).toBe('Changed clip speed');
    expect(describeOperation(op({ type: 'set_clip_crop' })).action).toBe('Reframed clip');
    expect(describeOperation(op({ type: 'set_clip_blend_mode' })).action).toBe(
      'Changed blend mode',
    );
    expect(describeOperation(op({ type: 'set_effect_params' })).action).toBe('Adjusted effect');
    expect(describeOperation(op({ type: 'set_transcript' })).action).toBe('Updated transcript');
    expect(describeOperation(op({ type: 'add_marker' })).action).toBe('Added marker');
    expect(describeOperation(op({ type: 'remove_marker' })).action).toBe('Removed marker');
  });

  it('ignores non-string id fields and a half-present range', () => {
    const d = describeOperation(op({ type: 'trim_clip', clipId: 42, start: 1 }));
    expect(d.refs).toEqual([]);
    expect(d.detail).toBe('');
    expect(d.action).toBe('Trimmed clip');
  });

  it('resolves clip/track/asset refs to friendly names when a resolver is given', () => {
    const d = describeOperation(
      op({ type: 'add_clip', clipId: 'clip_x', assetId: 'asset_1' }),
      names,
    );
    expect(d.refs).toEqual([
      { kind: 'clip', id: 'clip_x', label: 'Intro.mp4' },
      { kind: 'asset', id: 'asset_1', label: 'Intro.mp4' },
    ]);
  });
});

describe('describeToolCall', () => {
  it('builds an imperative phrase with the resolved primary ref', () => {
    expect(describeToolCall({ name: 'trim_clip', arguments: { clipId: 'clip_x' } }, names)).toBe(
      'Trimming Intro.mp4',
    );
    expect(
      describeToolCall({ name: 'set_track_flags', arguments: { trackId: 'video_1' } }, names),
    ).toBe('Updating Video 1');
  });

  it('falls back to the verb alone with no ref, and humanizes unknown tools', () => {
    expect(describeToolCall({ name: 'get_timeline', arguments: {} })).toBe('Reading the timeline');
    expect(describeToolCall({ name: 'mystery_tool', arguments: null })).toBe('Mystery tool');
  });

  it('uses raw ids for clip/track/asset when no resolver is supplied', () => {
    expect(describeToolCall({ name: 'trim_clip', arguments: { clipId: 'clip_9' } })).toBe(
      'Trimming clip_9',
    );
    expect(describeToolCall({ name: 'set_track_flags', arguments: { trackId: 'track_9' } })).toBe(
      'Updating track_9',
    );
    expect(describeToolCall({ name: 'add_asset', arguments: { assetId: 'asset_9' } })).toBe(
      'Adding an asset asset_9',
    );
  });

  it('phrases analysis and styling tools in editor language with the resolved ref', () => {
    // These tool names used to humanize ("Analyze silence"), breaking the imperative
    // register the other verbs use. Pin the editor-speak phrasing.
    expect(
      describeToolCall({ name: 'analyze_silence', arguments: { assetId: 'asset_1' } }, names),
    ).toBe('Finding silences in Intro.mp4');
    expect(
      describeToolCall({ name: 'detect_scenes', arguments: { assetId: 'asset_1' } }, names),
    ).toBe('Detecting scene cuts in Intro.mp4');
    expect(
      describeToolCall({ name: 'detect_beats', arguments: { assetId: 'asset_1' } }, names),
    ).toBe('Finding the beat in Intro.mp4');
    expect(
      describeToolCall({ name: 'set_clip_crop', arguments: { clipId: 'clip_x' } }, names),
    ).toBe('Reframing Intro.mp4');
    expect(
      describeToolCall({ name: 'set_caption_style', arguments: { clipId: 'clip_x' } }, names),
      // No template named ⇒ the clip is the subject and the id-form verb applies.
    ).toBe('Styling captions on Intro.mp4');
    expect(describeToolCall({ name: 'list_assets', arguments: {} })).toBe('Browsing the media bin');
    expect(describeToolCall({ name: 'add_marker', arguments: { time: 3 } })).toBe(
      'Adding a marker',
    );
  });

  it('drops a dangling preposition when no ref resolves', () => {
    // analyze_silence's assetId is optional; without it the verb must still read
    // as a complete phrase ("Finding silences", never "Finding silences in").
    expect(describeToolCall({ name: 'analyze_silence', arguments: {} })).toBe('Finding silences');
    expect(describeToolCall({ name: 'delete_range', arguments: {} })).toBe('Deleting a range');
    expect(describeToolCall({ name: 'set_clip_speed', arguments: {} })).toBe('Changing the speed');
  });

  it('resolves an asset id through the resolver', () => {
    expect(describeToolCall({ name: 'add_asset', arguments: { assetId: 'asset_1' } }, names)).toBe(
      'Adding an asset Intro.mp4',
    );
  });

  // The activity card is where a user learns what the agent is doing. A row that reads
  // only "Load skill" is the same row four times over in a run that loaded four different
  // playbooks — the name was in the arguments and simply never read.
  describe("names the call's subject when it is an argument, not an id", () => {
    it('names the skill a load_skill call actually loaded', () => {
      expect(
        describeToolCall({ name: 'load_skill', arguments: { name: 'short-form-pacing' } }),
      ).toBe('Reading the short form pacing playbook');
      expect(describeToolCall({ name: 'load_skill', arguments: { name: 'caption-design' } })).toBe(
        'Reading the caption design playbook',
      );
    });

    it('names what a search/browse call was looking for', () => {
      expect(
        describeToolCall({ name: 'search_media', arguments: { query: 'harbour at dusk' } }),
      ).toBe('Searching media for harbour at dusk');
      expect(describeToolCall({ name: 'discover_effects', arguments: { query: 'glow' } })).toBe(
        'Browsing effects for glow',
      );
      // An unfiltered browse has no subject; the phrase must still be complete.
      expect(describeToolCall({ name: 'discover_effects', arguments: {} })).toBe(
        'Browsing effects',
      );
    });

    it('names the catalog entry an effect/transition call chose, not the clip', () => {
      expect(
        describeToolCall({
          name: 'add_transition',
          arguments: { fromClipId: 'clip_x', toClipId: 'clip_y', kind: 'whip-pan' },
        }),
      ).toBe('Adding a whip pan transition');
      expect(
        describeToolCall({ name: 'apply_effect', arguments: { effectId: 'film-grain' } }),
      ).toBe('Adding film grain effect');
    });

    it('names the caption template chosen, in preference to which cue it landed on', () => {
      expect(
        describeToolCall({
          name: 'set_caption_style',
          arguments: { clipId: 'clip_x', captionStyle: { template: 'neon-pop' } },
        }),
      ).toBe('Styling captions as neon pop');
    });

    it('names the moment a get_frame call is looking at', () => {
      expect(describeToolCall({ name: 'get_frame', arguments: { timeSeconds: 12.4 } })).toBe(
        'Looking at the frame at 12.40s',
      );
      // No time given ⇒ the phrase must still be complete, not "…the frame at".
      expect(describeToolCall({ name: 'get_frame', arguments: {} })).toBe('Looking at the frame');
    });

    it('surfaces the question an ask_user call is putting to the editor', () => {
      expect(
        describeToolCall({ name: 'ask_user', arguments: { question: 'Keep the intro?' } }),
      ).toBe('Asking you: Keep the intro?');
    });

    it('leaves free text as written and clamps it to one row', () => {
      // Un-hyphenating a query would change what was searched for.
      expect(
        describeToolCall({ name: 'search_media', arguments: { query: 'b-roll of rain' } }),
      ).toBe('Searching media for b-roll of rain');
      const long = 'a'.repeat(200);
      const title = describeToolCall({ name: 'search_media', arguments: { query: long } });
      expect(title.length).toBeLessThan(80);
      expect(title.endsWith('…')).toBe(true);
    });

    it('ignores a blank or non-string subject argument rather than titling with it', () => {
      expect(describeToolCall({ name: 'load_skill', arguments: { name: '   ' } })).toBe('Reading');
      expect(describeToolCall({ name: 'search_media', arguments: { query: 42 } })).toBe(
        'Searching media',
      );
      // A nested path through a null/short-circuited value must not throw.
      expect(
        describeToolCall({ name: 'set_caption_style', arguments: { captionStyle: null } }),
      ).toBe('Styling captions');
      expect(describeToolCall({ name: 'add_text_layer', arguments: { trackId: 't1' } })).toBe(
        'Adding a text layer to t1',
      );
    });
  });
});
