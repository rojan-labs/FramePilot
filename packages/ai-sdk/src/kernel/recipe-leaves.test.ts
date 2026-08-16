/**
 * Unit tests for the deterministic recipe leaves (plan P1.2) — every branch of the pure
 * timeline-editing core: silent-range → ripple-delete synthesis (ordering, malformed rows,
 * track resolution), patch assembly, and the structural verify, plus the honest
 * {@link RecipeLeafError} paths (missing upstream, unknown track).
 */
import { describe, expect, it } from 'vitest';
import { type AnyOperation, applyProjectPatch } from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { makeProject } from '../__fixtures__/project.js';
import { assembleEdit, type EditResult } from '../assemble.js';
import {
  RECIPE_LEAVES,
  RecipeLeafError,
  type LeafContext,
  type RecipeTaskOutput,
} from './recipe-leaves.js';

const synth = RECIPE_LEAVES.synth_ripple_deletes!;
const assemble = RECIPE_LEAVES.assemble_patch!;
const verify = RECIPE_LEAVES.verify!;
const transcriptCues = RECIPE_LEAVES.transcript_cues!;
const synthCaptionLayer = RECIPE_LEAVES.synth_caption_layer!;
const diagnosePacing = RECIPE_LEAVES.diagnose_pacing!;
const synthPacingOps = RECIPE_LEAVES.synth_pacing_ops!;
const findHook = RECIPE_LEAVES.find_hook!;
const synthHookRestructure = RECIPE_LEAVES.synth_hook_restructure!;
const synthPunchIn = RECIPE_LEAVES.synth_punch_in!;
const detectFillerCleanup = RECIPE_LEAVES.detect_filler_cleanup!;
const synthFillerDeletes = RECIPE_LEAVES.synth_filler_deletes!;

/** A project with a caption track + transcript, for the P2 leaves. */
function p2Project(firstWordStart = 2): Project {
  return parseProject({
    id: 'p',
    name: 'P2',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 }],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_1',
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
        { id: 'cap_1', type: 'caption', clips: [] },
      ],
    },
    transcript: [
      { word: 'a', start: firstWordStart, end: firstWordStart + 0.4 },
      { word: 'b', start: firstWordStart + 0.5, end: firstWordStart + 0.9 },
      { word: 'c', start: firstWordStart + 3, end: firstWordStart + 3.4 },
    ],
    aiMemory: {},
    history: [],
  });
}

/** LeafContext over a given project + args + upstream. */
function p2ctx(
  project: Project,
  args: Record<string, unknown>,
  upstream: Record<string, RecipeTaskOutput> = {},
): LeafContext {
  return { project, args, reason: 'r', upstream: (id) => upstream[id] };
}

/** Build a LeafContext with an inline upstream map. */
function ctx(
  args: Record<string, unknown>,
  upstream: Record<string, RecipeTaskOutput> = {},
  extra: Partial<LeafContext> = {},
): LeafContext {
  return {
    project: makeProject(),
    args,
    reason: 'test',
    upstream: (id) => upstream[id],
    ...extra,
  };
}

describe('synth_ripple_deletes', () => {
  const ranges = {
    data: {
      ranges: [
        { start: 2, end: 3 },
        { start: 7, end: 8 },
      ],
    },
  };

  it('synthesizes ripple deletes ordered latest-first on the track with clips', () => {
    const out = synth(ctx({ from: 'T1' }, { T1: ranges }));
    const ops = out.operations as AnyOperation[];
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => (o as { start: number }).start)).toEqual([7, 2]);
    expect(ops.every((o) => o.type === 'ripple_delete')).toBe(true);
    expect((ops[0] as { trackId: string }).trackId).toBe('video_1');
  });

  it('drops malformed/zero-length ranges (never a negative-length delete)', () => {
    const out = synth(
      ctx(
        { from: 'T1' },
        {
          T1: {
            data: {
              ranges: [
                { start: 5, end: 4 },
                { start: 'x', end: 2 },
                { start: 1, end: 2 },
              ],
            },
          },
        },
      ),
    );
    expect(out.operations).toHaveLength(1);
  });

  it('handles a payload with no ranges as zero operations', () => {
    const out = synth(ctx({ from: 'T1' }, { T1: { data: {} } }));
    expect(out.operations).toHaveLength(0);
  });

  it('tolerates an absent data payload and null rows', () => {
    // Upstream output with no `data` field at all.
    expect(synth(ctx({ from: 'T1' }, { T1: {} })).operations).toHaveLength(0);
    // A ranges array containing a null row is skipped, not a crash.
    const out = synth(
      ctx({ from: 'T1' }, { T1: { data: { ranges: [null, { start: 1, end: 2 }] } } }),
    );
    expect(out.operations).toHaveLength(1);
  });

  it('honours an explicit track arg', () => {
    const out = synth(ctx({ from: 'T1', track: 'audio_1' }, { T1: ranges }));
    expect((out.operations?.[0] as { trackId: string }).trackId).toBe('audio_1');
  });

  it('throws on an unknown explicit track', () => {
    expect(() => synth(ctx({ from: 'T1', track: 'nope' }, { T1: ranges }))).toThrow(
      RecipeLeafError,
    );
  });

  it('falls back to the first track when none has clips', () => {
    const empty: LeafContext = {
      project: makeProject({
        timeline: { tracks: [{ id: 'only', type: 'video', clips: [] }] },
      }),
      args: { from: 'T1' },
      reason: 'r',
      upstream: () => ranges,
    };
    expect((synth(empty).operations?.[0] as { trackId: string }).trackId).toBe('only');
  });

  it('throws when the "from" reference is missing or the upstream is absent', () => {
    expect(() => synth(ctx({}, {}))).toThrow(/missing its "from"/);
    expect(() => synth(ctx({ from: 'T9' }, {}))).toThrow(/produced no result/);
  });

  it('throws when the timeline has no track to edit', () => {
    // A timeline with zero tracks can't be produced by parseProject; construct it
    // directly to exercise the defensive guard.
    const noTracks = {
      project: { timeline: { tracks: [] } } as unknown as ReturnType<typeof makeProject>,
      args: { from: 'T1' },
      reason: 'r',
      upstream: () => ranges,
    } satisfies LeafContext;
    expect(() => synth(noTracks)).toThrow(/no track to edit/);
  });
});

describe('assemble_patch', () => {
  it('assembles a valid, reversible patch from upstream operations', () => {
    const ops: AnyOperation[] = [{ type: 'ripple_delete', trackId: 'video_1', start: 2, end: 3 }];
    const out = assemble(ctx({ from: 'T2' }, { T2: { operations: ops } }));
    expect(out.edit?.validation.valid).toBe(true);
    expect(out.edit?.patch.operations).toHaveLength(1);
  });

  it('treats a missing operations list as an empty (valid) patch', () => {
    const out = assemble(ctx({ from: 'T2' }, { T2: {} }));
    expect(out.edit?.validation.valid).toBe(true);
    expect(out.edit?.patch.operations).toHaveLength(0);
  });

  it('assembles operations from every declared upstream result', () => {
    const out = assemble(
      ctx(
        { from: ['T1', 'T2'] },
        {
          T1: { operations: [{ type: 'split_clip', clipId: 'clip_a', at: 2 }] },
          T2: { operations: [{ type: 'split_clip', clipId: 'clip_b', at: 8 }] },
        },
      ),
    );

    expect(out.edit?.validation.valid).toBe(true);
    expect(out.edit?.patch.operations).toHaveLength(2);
  });

  it('reports the validator issue when defense-in-depth assembly rejects a patch', () => {
    const out = assemble(
      ctx(
        { from: 'T1' },
        {
          T1: {
            operations: [
              {
                type: 'add_clip',
                trackId: 'audio_1',
                assetId: 'audio_1',
                start: 10,
                end: 12,
                sourceStart: 0,
                sourceEnd: 2,
              },
            ],
          },
        },
      ),
    );

    expect(out.edit?.validation.valid).toBe(false);
    expect(out.summary).toContain("Unknown asset 'audio_1'");
    expect(out.summary).not.toContain('Assembled patch with');
  });

  it('bounds defense-in-depth validation summaries for large rejected patches', () => {
    const operations: AnyOperation[] = Array.from({ length: 9 }, (_, index) => ({
      type: 'add_clip',
      trackId: 'audio_1',
      assetId: `missing_${String(index)}`,
      start: index * 2,
      end: index * 2 + 1,
      sourceStart: 0,
      sourceEnd: 1,
    }));
    const out = assemble(ctx({ from: 'T1' }, { T1: { operations } }));

    expect(out.summary).toContain('plus 1 more error(s)');
    expect(out.summary).not.toContain("Unknown asset 'missing_8'");
  });

  it('refuses to assemble when one of several declared upstream tasks produced no result', () => {
    expect(() => assemble(ctx({ from: ['T1', 'T2'] }, { T1: { operations: [] } }))).toThrow(
      /produced no result/,
    );
  });

  it('refuses to assemble with no "from" upstream reference', () => {
    expect(() => assemble(ctx({}, {}))).toThrow(/missing its "from"/);
  });

  it('refuses to assemble when a "from" array holds a non-string entry', () => {
    // A model-authored plan could hand back a mixed array; treating it the same as an
    // empty ref (rather than silently coercing or crashing on `ctx.upstream`) keeps the
    // error message actionable.
    expect(() => assemble(ctx({ from: ['T1', 7] }, { T1: {} }))).toThrow(/missing its "from"/);
  });
});

describe('verify', () => {
  const validEdit: EditResult = assembleEdit(
    makeProject(),
    [{ type: 'ripple_delete', trackId: 'video_1', start: 2, end: 3 }],
    'r',
  );

  it('passes when the run edit validated (reads the threaded runEdit)', () => {
    const out = verify(ctx({ goal: 'no silence' }, {}, { runEdit: validEdit }));
    expect(out.verdict?.ok).toBe(true);
  });

  it('reads the assembled edit from an explicit "from" ref', () => {
    const out = verify(ctx({ goal: 'g', from: 'T3' }, { T3: { edit: validEdit } }));
    expect(out.verdict?.ok).toBe(true);
  });

  it('fails honestly when the patch did not validate', () => {
    const invalid: EditResult = {
      ...validEdit,
      validation: { valid: false, issues: [{ severity: 'error', message: 'bad' }] },
    };
    const out = verify(ctx({ goal: 'g' }, {}, { runEdit: invalid }));
    expect(out.verdict?.ok).toBe(false);
    expect(out.summary).toMatch(/Verification failed/);
  });

  it('passes with no patch to check (e.g. a render-only recipe) and a default goal', () => {
    const out = verify(ctx({}, {}));
    expect(out.verdict?.ok).toBe(true);
    expect(out.summary).toMatch(/Verified: goal/);
  });

  // P11.5 — verify now runs the SAME real technical-safety battery `critic.ts#critique`
  // runs on the sequential agent path, not just structural patch validity.
  describe('P11.5 — runs the real critique battery, not just structural validity', () => {
    it('runs the full technical battery and folds a clean result into an `ok` verdict', () => {
      const out = verify(ctx({ goal: 'no silence' }, {}, { runEdit: validEdit }));
      expect(out.verdict?.ok).toBe(true);
      expect(out.critique).toBeDefined();
      expect(out.critique?.ok).toBe(true);
      expect(out.critique?.checks.map((c) => c.id)).toEqual([
        'request_match',
        'duration_target',
        'caption_alignment',
        'safe_area',
        'audio_clipping',
        'black_frames',
        'missing_assets',
        'export_settings',
      ]);
      // Render-gated checks stay honestly `skipped` — a pure leaf never renders a preview.
      expect(out.critique?.checks.find((c) => c.id === 'audio_clipping')?.status).toBe('skipped');
      expect(out.critique?.checks.find((c) => c.id === 'black_frames')?.status).toBe('skipped');
    });

    it('fails the verdict when a technical check fails, even though the patch validated', () => {
      // The edit is structurally valid, but the step asks for a duration target the
      // resulting timeline (10s, from `makeProject()`'s fixture clips) misses badly.
      const out = verify(
        ctx(
          { goal: 'hit the target length', durationTargetSeconds: 45 },
          {},
          { runEdit: validEdit },
        ),
      );
      expect(out.verdict?.ok).toBe(false);
      expect(out.critique?.ok).toBe(false);
      expect(out.critique?.checks.find((c) => c.id === 'duration_target')?.status).toBe('fail');
      // Distinguishable from a structural failure: never says "did not validate".
      expect(out.summary).toMatch(/Verification failed/);
      expect(out.summary).not.toMatch(/did not validate/);
    });

    it('passes the target-platform check when a recognised platform arg is given', () => {
      const out = verify(
        ctx({ goal: 'export ready', targetPlatform: 'reels' }, {}, { runEdit: validEdit }),
      );
      expect(out.critique?.checks.find((c) => c.id === 'export_settings')?.status).toBe(
        // The fixture project is 1920x1080 (landscape) — Reels wants 9:16, so this warns
        // (not fails) rather than blocking the run on a non-fatal platform mismatch.
        'warn',
      );
      // A warning alone does not fail the overall verdict (only a `fail` status does).
      expect(out.verdict?.ok).toBe(true);
    });

    it('ignores an unrecognised targetPlatform arg (never fabricates a platform check)', () => {
      const out = verify(
        ctx({ goal: 'g', targetPlatform: 'not-a-real-platform' }, {}, { runEdit: validEdit }),
      );
      expect(out.critique?.checks.find((c) => c.id === 'export_settings')?.status).toBe('skipped');
    });

    it('reports request_match as a warning (not a failure) for a no-op patch', () => {
      const empty = assembleEdit(makeProject(), [], 'r');
      const out = verify(ctx({ goal: 'g' }, {}, { runEdit: empty }));
      expect(out.critique?.checks.find((c) => c.id === 'request_match')?.status).toBe('warn');
      expect(out.verdict?.ok).toBe(true);
    });
  });
});

describe('P2 leaves', () => {
  it('transcript_cues groups words and splits on long gaps', () => {
    const out = transcriptCues(p2ctx(p2Project(2), {}));
    // "a b" (gap<0.8) is one cue; "c" (gap>0.8) is a second.
    expect((out.value as unknown[]).length).toBe(2);
  });

  it('transcript_cues returns no cues for an empty transcript', () => {
    const out = transcriptCues(p2ctx(makeProject({ transcript: [] }), {}));
    expect((out.value as unknown[]).length).toBe(0);
  });

  it('transcript_cues yields a single cue for closely-spaced words', () => {
    // The fixture transcript ("hello world", no big gap) is one cue.
    const out = transcriptCues(p2ctx(makeProject(), {}));
    expect((out.value as unknown[]).length).toBe(1);
    expect(out.summary).toMatch(/1 caption cue$/);
  });

  it("transcript_cues caps words-per-cue to a known template's suggestedWordsPerLine", () => {
    // 'punchline' is the one-word-per-cue family (suggestedWordsPerLine: 1), so
    // "hello world" (no big gap, otherwise one cue) splits into two.
    const out = transcriptCues(p2ctx(makeProject(), { templateId: 'punchline' }));
    expect((out.value as unknown[]).length).toBe(2);
  });

  it('transcript_cues is uncapped for an unknown templateId', () => {
    const out = transcriptCues(p2ctx(makeProject(), { templateId: 'not-a-real-template' }));
    expect((out.value as unknown[]).length).toBe(1);
  });

  /**
   * A cue as the shared segmenter produces it (schema v11): its own text and word
   * timings, not just a span. `synth_caption_layer` persists both so an
   * AI-generated caption is editable afterwards.
   */
  const draft = (text: string, start: number, end: number) => ({
    text,
    start,
    end,
    words: text.split(' ').map((word, i, all) => ({
      word,
      start: start + ((end - start) * i) / all.length,
      end: start + ((end - start) * (i + 1)) / all.length,
    })),
  });

  it('synth_caption_layer sets the track style once, then adds + cues each caption', () => {
    const cues = [draft('hello world', 0, 1), draft('again', 3, 3.5)];
    const out = synthCaptionLayer(p2ctx(p2Project(), { from: 'T1' }, { T1: { value: cues } }));
    const ops = out.operations as AnyOperation[];
    // ONE track style op (schema v11) + add/cue per cue — not one style per cue,
    // which is what made a 400-cue restyle a 400-operation patch.
    expect(ops).toHaveLength(5);
    expect(ops[0]).toMatchObject({
      type: 'set_track_caption_style',
      trackId: 'cap_1',
      captionStyle: { templateId: 'karaoke' },
    });
    expect(ops[1]).toMatchObject({ type: 'add_caption_layer', trackId: 'cap_1' });
    expect(ops[2]).toMatchObject({ type: 'set_caption_cue', captionCue: { text: 'hello world' } });
  });

  it("synth_caption_layer persists each cue's own word timings", () => {
    const cues = [draft('hello world', 0, 1)];
    const out = synthCaptionLayer(p2ctx(p2Project(), { from: 'T1' }, { T1: { value: cues } }));
    const cueOp = (out.operations as AnyOperation[])[2] as {
      captionCue: { words: readonly { word: string }[] };
    };
    expect(cueOp.captionCue.words.map((w) => w.word)).toEqual(['hello', 'world']);
  });

  it('synth_caption_layer derives stable clip ids from the cue start time', () => {
    // Start-derived rather than index-derived, so regenerating the same
    // transcript reuses ids instead of colliding on `caption_<track>_<n>`.
    const out = synthCaptionLayer(
      p2ctx(p2Project(), { from: 'T1' }, { T1: { value: [draft('hi', 3.25, 4)] } }),
    );
    expect((out.operations as AnyOperation[])[1]).toMatchObject({ clipId: 'caption_cap_1_3250' });
  });

  it('synth_caption_layer honors a known args.templateId and ignores unknown ids', () => {
    const cues = [draft('hello', 0, 1)];
    const known = synthCaptionLayer(
      p2ctx(p2Project(), { from: 'T1', templateId: 'hormozi' }, { T1: { value: cues } }),
    );
    expect(known.operations?.[0]).toMatchObject({ captionStyle: { templateId: 'hormozi' } });
    const unknown = synthCaptionLayer(
      p2ctx(p2Project(), { from: 'T1', templateId: 'nope' }, { T1: { value: cues } }),
    );
    expect(unknown.operations?.[0]).toMatchObject({ captionStyle: { templateId: 'karaoke' } });
  });

  it('synth_caption_layer treats a missing cue list as zero captions', () => {
    // Not even a track-style op: an empty transcript must not produce a patch
    // that reads as though something happened.
    const out = synthCaptionLayer(p2ctx(p2Project(), { from: 'T1' }, { T1: {} }));
    expect(out.operations).toHaveLength(0);
  });

  it('synth_caption_layer with a single cue', () => {
    const out = synthCaptionLayer(
      p2ctx(p2Project(), { from: 'T1' }, { T1: { value: [draft('hello', 0, 1)] } }),
    );
    expect(out.operations).toHaveLength(3);
    expect(out.summary).toMatch(/1 caption layer \(karaoke\)$/);
  });

  /**
   * Regenerating captions on a project that already has them. The clip ids are
   * start-derived and therefore stable, so without a clear step the second run
   * hands `insertClip` an id it already holds and the whole patch dies with
   * `duplicate_clip` — which is what made "add captions" a silent no-op on any
   * project captioned once before.
   */
  function captionedProject(): Project {
    const base = p2Project();
    const cue = { text: 'old', words: [{ word: 'old', start: 0, end: 1 }] };
    return parseProject({
      ...base,
      timeline: {
        ...base.timeline,
        tracks: base.timeline.tracks.map((track) =>
          track.id !== 'cap_1'
            ? track
            : {
                ...track,
                clips: [
                  {
                    id: 'caption_cap_1_0',
                    assetId: '__caption__',
                    trackId: 'cap_1',
                    start: 0,
                    end: 1,
                    sourceStart: 0,
                    sourceEnd: 1,
                    effects: [
                      {
                        id: 'caption_cap_1_0__caption',
                        type: 'caption',
                        params: {},
                        keyframes: [],
                      },
                    ],
                    keyframes: [],
                    captionCue: cue,
                  },
                ],
              },
        ),
      },
    });
  }

  it('synth_caption_layer clears the existing caption set before laying down the new one', () => {
    const out = synthCaptionLayer(
      p2ctx(captionedProject(), { from: 'T1' }, { T1: { value: [draft('hello', 0, 1)] } }),
    );
    const ops = out.operations as AnyOperation[];
    // The clear leads, so the new cue's id is free by the time it is inserted.
    expect(ops[0]).toMatchObject({ type: 'delete_range', trackId: 'cap_1', start: 0, end: 1 });
    expect(ops[1]).toMatchObject({ type: 'set_track_caption_style', trackId: 'cap_1' });
    expect(out.summary).toMatch(/replacing 1$/);
  });

  it('synth_caption_layer regenerates onto a captioned track without a duplicate-id failure', () => {
    // The end-to-end property the clear exists for: the patch must APPLY. The
    // colliding id (`caption_cap_1_0`) is deliberately the one already on the
    // track, which is exactly the case that used to throw.
    const project = captionedProject();
    // A full `DerivedCue`: `set_caption_cue` requires the source provenance that
    // the shared derivation stamps, so a patch that must really apply needs it.
    const derived = {
      ...draft('hello world', 0, 1.5),
      clipId: 'clip_a',
      assetId: 'asset_1',
      sourceStart: 0,
      sourceEnd: 1.5,
      revision: project.timeline.revision ?? 0,
    };
    const out = synthCaptionLayer(p2ctx(project, { from: 'T1' }, { T1: { value: [derived] } }));
    const applied = applyProjectPatch(project, {
      patchId: 'regenerate_captions',
      operations: out.operations as AnyOperation[],
    });
    const captions = applied.timeline.tracks.find((t) => t.id === 'cap_1')?.clips ?? [];
    expect(captions).toHaveLength(1);
    expect(captions[0]?.captionCue?.text).toBe('hello world');
  });

  it('synth_caption_layer leaves an existing caption set alone when there are no cues', () => {
    // An empty transcript is a reason not to touch the user's captions, not a
    // reason to delete them — so the clear must not run on its own.
    const out = synthCaptionLayer(p2ctx(captionedProject(), { from: 'T1' }, { T1: { value: [] } }));
    expect(out.operations).toHaveLength(0);
  });

  it('synth_caption_layer throws when there is no caption/overlay track', () => {
    const out = () =>
      synthCaptionLayer(
        p2ctx(makeProject(), { from: 'T1' }, { T1: { value: [draft('hello', 0, 1)] } }),
      );
    expect(out).toThrow(/No caption or overlay track/);
  });

  /**
   * `resolveCaptionTrack` falls back to a plain `overlay` track when a project
   * has no dedicated caption track — the same track type other tools default to
   * for logos/watermarks/graphics (domain-tools/timeline.ts's `add_track`
   * defaults `type` to `'overlay'`). Regression for the bug where the clear step
   * used to span the whole track's clip extent instead of just prior captions,
   * silently deleting whatever else lived on that overlay track.
   */
  function overlayProjectWithLogo(withPriorCaption: boolean): Project {
    const base = p2Project();
    const cue = { text: 'old', words: [{ word: 'old', start: 0, end: 1 }] };
    return parseProject({
      ...base,
      timeline: {
        ...base.timeline,
        tracks: base.timeline.tracks.map((track) =>
          track.id !== 'cap_1'
            ? track
            : {
                ...track,
                type: 'overlay',
                clips: [
                  {
                    id: 'logo_1',
                    assetId: 'asset_1',
                    trackId: 'cap_1',
                    start: 5,
                    end: 8,
                    sourceStart: 0,
                    sourceEnd: 3,
                    effects: [],
                    keyframes: [],
                  },
                  ...(withPriorCaption
                    ? [
                        {
                          id: 'caption_cap_1_0',
                          assetId: '__caption__',
                          trackId: 'cap_1',
                          start: 0,
                          end: 1,
                          sourceStart: 0,
                          sourceEnd: 1,
                          effects: [
                            {
                              id: 'caption_cap_1_0__caption',
                              type: 'caption',
                              params: {},
                              keyframes: [],
                            },
                          ],
                          keyframes: [],
                          captionCue: cue,
                        },
                      ]
                    : []),
                ],
              },
        ),
      },
    });
  }

  it('synth_caption_layer does not delete unrelated content on a first-time overlay track', () => {
    const project = overlayProjectWithLogo(false);
    const derived = {
      ...draft('hello world', 0, 1),
      clipId: 'clip_a',
      assetId: 'asset_1',
      sourceStart: 0,
      sourceEnd: 1,
      revision: project.timeline.revision ?? 0,
    };
    const out = synthCaptionLayer(p2ctx(project, { from: 'T1' }, { T1: { value: [derived] } }));
    const ops = out.operations as AnyOperation[];
    expect(ops.some((op) => op.type === 'delete_range')).toBe(false);
    const applied = applyProjectPatch(project, { patchId: 'add_captions', operations: ops });
    const clips = applied.timeline.tracks.find((t) => t.id === 'cap_1')?.clips ?? [];
    expect(clips.some((c) => c.id === 'logo_1')).toBe(true);
  });

  it('synth_caption_layer regenerating on a mixed overlay+caption track leaves the logo alone', () => {
    const project = overlayProjectWithLogo(true);
    const derived = {
      ...draft('hello world', 0, 1.5),
      clipId: 'clip_a',
      assetId: 'asset_1',
      sourceStart: 0,
      sourceEnd: 1.5,
      revision: project.timeline.revision ?? 0,
    };
    const out = synthCaptionLayer(p2ctx(project, { from: 'T1' }, { T1: { value: [derived] } }));
    const applied = applyProjectPatch(project, {
      patchId: 'regenerate_captions',
      operations: out.operations as AnyOperation[],
    });
    const clips = applied.timeline.tracks.find((t) => t.id === 'cap_1')?.clips ?? [];
    expect(clips.some((c) => c.id === 'logo_1')).toBe(true);
    expect(clips.find((c) => c.captionCue?.text === 'hello world')).toBeTruthy();
  });

  it('diagnose_pacing forwards a range and defaults to null', () => {
    expect(diagnosePacing(p2ctx(makeProject(), { range: [0, 5] })).value).toEqual({
      range: [0, 5],
    });
    expect(diagnosePacing(p2ctx(makeProject(), {})).value).toEqual({ range: null });
  });

  it('synth_pacing_ops reads silence from an array "from" and cuts latest-first', () => {
    const t1 = {
      data: {
        ranges: [
          { start: 2, end: 3 },
          { start: 6, end: 7 },
        ],
      },
    };
    const out = synthPacingOps(
      p2ctx(makeProject(), { from: ['T1', 'T2'] }, { T1: t1, T2: { value: {} } }),
    );
    const ops = out.operations as AnyOperation[];
    expect(ops.map((o) => (o as { start: number }).start)).toEqual([6, 2]);
  });

  it('synth_pacing_ops handles a string "from" and a missing one', () => {
    const t1 = { data: { ranges: [{ start: 1, end: 2 }] } };
    expect(
      synthPacingOps(p2ctx(makeProject(), { from: 'T1' }, { T1: t1 })).operations,
    ).toHaveLength(1);
    // No "from" at all → no silence source → zero ops (honest, not a crash).
    expect(synthPacingOps(p2ctx(makeProject(), {})).operations).toHaveLength(0);
    // A "from" whose upstream carries no data is skipped.
    expect(
      synthPacingOps(p2ctx(makeProject(), { from: ['T2'] }, { T2: { value: {} } })).operations,
    ).toHaveLength(0);
  });

  it('find_hook returns the first word start (0 for an empty transcript)', () => {
    expect((findHook(p2ctx(p2Project(2), {})).value as { leadInEnd: number }).leadInEnd).toBe(2);
    expect(
      (findHook(p2ctx(makeProject({ transcript: [] }), {})).value as { leadInEnd: number })
        .leadInEnd,
    ).toBe(0);
  });

  it('synth_hook_restructure trims a dead lead-in, else nothing', () => {
    const trim = synthHookRestructure(
      p2ctx(makeProject(), { from: 'T1' }, { T1: { value: { leadInEnd: 2 } } }),
    );
    expect(trim.operations).toHaveLength(1);
    expect(trim.operations?.[0]).toMatchObject({ type: 'ripple_delete', start: 0, end: 2 });
    // Below threshold → no edit.
    const none = synthHookRestructure(
      p2ctx(makeProject(), { from: 'T1' }, { T1: { value: { leadInEnd: 0.1 } } }),
    );
    expect(none.operations).toHaveLength(0);
    // Missing value → treated as no lead-in.
    const missing = synthHookRestructure(p2ctx(makeProject(), { from: 'T1' }, { T1: {} }));
    expect(missing.operations).toHaveLength(0);
  });

  it('synth_punch_in ramps scale on the target clip (default and explicit)', () => {
    const def = synthPunchIn(p2ctx(p2Project(), {}));
    expect(def.operations?.[0]).toMatchObject({ type: 'add_keyframes', clipId: 'clip_a' });
    const explicit = synthPunchIn(p2ctx(p2Project(), { target: 'clip_a', zoom: 1.5 }));
    expect((explicit.operations?.[0] as { clipId: string }).clipId).toBe('clip_a');
  });

  it('synth_punch_in throws when the target clip is unknown or absent', () => {
    expect(() => synthPunchIn(p2ctx(p2Project(), { target: 'nope' }))).toThrow(/No clip "nope"/);
    expect(() =>
      synthPunchIn(p2ctx(makeProject({ transcript: [] }), { target: 'selection' })),
    ).not.toThrow();
    // A timeline with no clips at all.
    const empty = parseProject({
      ...JSON.parse(JSON.stringify(p2Project())),
      timeline: { tracks: [{ id: 't', type: 'video', clips: [] }] },
    });
    expect(() => synthPunchIn(p2ctx(empty, {}))).toThrow(/No clip on the timeline/);
  });
});

describe('filler_cleanup leaves (H1.4)', () => {
  /** A project whose transcript has filler words (with punctuation/case variants), a
   *  real word that must NOT match ("like"), and one awkward pause (gap > 0.8s). */
  function fillerProject(): Project {
    return parseProject({
      ...JSON.parse(JSON.stringify(p2Project())),
      transcript: [
        { word: 'so', start: 0, end: 0.3 },
        { word: 'Um,', start: 0.3, end: 0.6 }, // filler, punctuation + case
        { word: 'I', start: 0.6, end: 0.7 },
        { word: 'UH!', start: 0.7, end: 0.9 }, // filler, all-caps + punctuation
        { word: 'like', start: 0.9, end: 1.1 }, // real word "like" — must NOT be cut
        { word: 'this', start: 2.0, end: 2.3 }, // gap from 1.1 → 2.0 is 0.9s (> 0.8s threshold)
      ],
    });
  }

  it('detect_filler_cleanup finds filler words (case/punctuation-insensitive) and never matches "like"', () => {
    const out = detectFillerCleanup(p2ctx(fillerProject(), {}));
    const { fillerSpans, pauseSpans } = out.value as {
      fillerSpans: { start: number; end: number }[];
      pauseSpans: { start: number; end: number }[];
    };
    expect(fillerSpans).toEqual([
      { start: 0.3, end: 0.6 },
      { start: 0.7, end: 0.9 },
    ]);
    expect(pauseSpans).toEqual([{ start: 1.35, end: 2.0 }]); // tightened to 0.25s, not 0
    expect(out.summary).toMatch(/2 filler words and 1 awkward pause/);
  });

  it('detect_filler_cleanup treats a gap at exactly the threshold as not awkward (boundary)', () => {
    const project = parseProject({
      ...JSON.parse(JSON.stringify(p2Project())),
      transcript: [
        { word: 'a', start: 0, end: 0.2 },
        { word: 'b', start: 1.0, end: 1.2 }, // gap = 0.8s exactly → not > threshold
      ],
    });
    const out = detectFillerCleanup(p2ctx(project, {}));
    expect((out.value as { pauseSpans: unknown[] }).pauseSpans).toHaveLength(0);
  });

  it('detect_filler_cleanup reports an honest empty result for no transcript', () => {
    const out = detectFillerCleanup(p2ctx(makeProject({ transcript: [] }), {}));
    const { fillerSpans, pauseSpans } = out.value as {
      fillerSpans: unknown[];
      pauseSpans: unknown[];
    };
    expect(fillerSpans).toHaveLength(0);
    expect(pauseSpans).toHaveLength(0);
    expect(out.summary).toMatch(/No transcript yet/);
  });

  it('synth_filler_deletes combines filler + pause spans latest-first on one track', () => {
    const detected = {
      value: {
        fillerSpans: [
          { start: 0.3, end: 0.6 },
          { start: 0.7, end: 0.9 },
        ],
        pauseSpans: [{ start: 1.35, end: 2.0 }],
      },
    };
    const out = synthFillerDeletes(p2ctx(fillerProject(), { from: 'T1' }, { T1: detected }));
    const ops = out.operations as AnyOperation[];
    expect(ops).toHaveLength(3);
    // Descending by start: pause (1.35) > uh (0.7) > um (0.3).
    expect(ops.map((o) => (o as { start: number }).start)).toEqual([1.35, 0.7, 0.3]);
    expect(ops.every((o) => o.type === 'ripple_delete' && o.trackId === 'video_1')).toBe(true);
  });

  it('synth_filler_deletes uses singular wording for exactly one cut', () => {
    const out = synthFillerDeletes(
      p2ctx(
        fillerProject(),
        { from: 'T1' },
        { T1: { value: { fillerSpans: [{ start: 0.3, end: 0.6 }] } } },
      ),
    );
    expect(out.operations).toHaveLength(1);
    expect(out.summary).toBe('Cleaned up 1 filler word/pause');
  });

  it('synth_filler_deletes yields zero ops when nothing was detected (honest no-op)', () => {
    const out = synthFillerDeletes(p2ctx(fillerProject(), { from: 'T1' }, { T1: { value: {} } }));
    expect(out.operations).toHaveLength(0);
  });

  it('synth_filler_deletes throws when its upstream reference is missing', () => {
    expect(() => synthFillerDeletes(p2ctx(fillerProject(), {}))).toThrow(/missing its "from"/);
  });
});
