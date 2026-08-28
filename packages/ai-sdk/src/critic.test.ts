/**
 * Tests for the Critic / Review agent (PRD §8.6). The Critic is pure and
 * deterministic — every check is exercised across pass / warn / fail / skipped.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { CAPTION_ASSET_ID, TEXT_OVERLAY_ASSET_ID } from '@framepilot/editor-core';
import {
  critique,
  explicitDurationTarget,
  explicitDurationTargetSeconds,
  timelineDuration,
} from './critic.js';
import { makeProject } from './__fixtures__/project.js';

const clip = (over: Record<string, unknown>) => ({
  assetId: 'asset_1',
  trackId: 't',
  start: 0,
  end: 2,
  sourceStart: 0,
  sourceEnd: 2,
  effects: [],
  keyframes: [],
  ...over,
});

/** Build a project with arbitrary tracks for a targeted check. */
const withTracks = (tracks: unknown[], over: Partial<Project> = {}): Project =>
  makeProject({ timeline: { tracks } as Project['timeline'], ...over });

const idOf = (report: ReturnType<typeof critique>, id: string) =>
  report.checks.find((c) => c.id === id);

describe('timelineDuration', () => {
  it('is the latest clip end, 0 for empty', () => {
    expect(timelineDuration(makeProject().timeline)).toBe(10);
    expect(timelineDuration({ tracks: [] })).toBe(0);
  });
});

describe('explicitDurationTargetSeconds', () => {
  it('extracts explicit whole-deliverable lengths', () => {
    expect(explicitDurationTargetSeconds('I want full video of 30 seconds')).toBe(30);
    expect(explicitDurationTargetSeconds('Create a 45-second montage')).toBe(45);
    expect(explicitDurationTargetSeconds('Make it 1.5 minutes long')).toBe(90);
  });

  it('does not mistake an edit timestamp for a duration goal', () => {
    expect(explicitDurationTargetSeconds('Cut at 30 seconds and add a transition')).toBeUndefined();
    expect(explicitDurationTargetSeconds('Move this clip to 12s')).toBeUndefined();
  });

  it('regression: a montage brief\u2019s pacing spec is not the deliverable length', () => {
    // Run `f014f3ac`. `build` is in the anchor list because people say "build me a
    // 30-second reel" — but it is also a PACING PHASE heading, and the lazy gap then
    // skipped past `0.3\u2013` to take `0.6` as the length of a fifty-clip montage. The run
    // was told "Timeline is 203.068s but the target is 0.6s" and reported itself failed.
    const brief = [
      '# PACING',
      'Suggested progression:',
      '### INTRO',
      'Approximately:',
      '**0.5\u20131.0s per clip**',
      '### BUILD',
      'Approximately:',
      '**0.3\u20130.6s per clip**',
      '### PEAK',
      'Approximately:',
      '**0.1\u20130.35s per clip**',
    ].join('\n\n');
    expect(explicitDurationTargetSeconds(brief)).toBeUndefined();
  });

  it('reads neither the far end of a range nor a per-clip figure', () => {
    // The two structural guards, stated on their own so a future anchor-list edit cannot
    // quietly remove either.
    expect(
      explicitDurationTargetSeconds('Build a montage at 0.3\u20130.6s per clip'),
    ).toBeUndefined();
    expect(explicitDurationTargetSeconds('Create a video with 2 seconds per shot')).toBeUndefined();
    expect(explicitDurationTargetSeconds('Make it 4s each cut')).toBeUndefined();
    // The far end alone is still never the target: 2 minutes is not what this asked for.
    expect(explicitDurationTargetSeconds('Build a reel, 1\u20132 minutes')).not.toBe(120);
  });

  it('reads a stated range as an interval, not as nothing', () => {
    // Run 4c9b5f82. `endsARange` refuses the far end, and in `20\u201335 seconds` only the far
    // number carries the unit \u2014 so the near end was never matched and the whole range was
    // dropped. The brief said its length as plainly as a brief can, and `duration_target`
    // reported `skipped` over a 10-second answer.
    expect(
      explicitDurationTarget('**Duration:** Approximately 20\u201335 seconds, depending on music'),
    ).toEqual({ seconds: 27.5, toleranceSeconds: 7.5 });
    expect(explicitDurationTarget('Build a reel, 1\u20132 minutes')).toEqual({
      seconds: 90,
      toleranceSeconds: 30,
    });
  });

  it('does not read a pacing range as the deliverable length', () => {
    // The range reading must not undo the guard it sits beside: a per-clip figure is
    // pacing whether it is stated as one number or as two.
    expect(explicitDurationTarget('Build a montage at 0.3\u20130.6s per clip')).toBeUndefined();
  });

  it('still finds a real length stated after the pacing talk', () => {
    // The guards skip candidates; they must not stop the scan. A brief that describes its
    // rhythm and THEN names a deliverable length still gets a target.
    expect(
      explicitDurationTargetSeconds(
        'Cut at roughly 0.3\u20130.6s per clip. Export a 45 second reel.',
      ),
    ).toBe(45);
  });
});

describe('shot count', () => {
  it('fails a cut that used fewer shots than the request asked for', () => {
    // The captured run: "at least of 20+ different best moments", delivered as eight shots,
    // reported as a success because the run's only criterion was the request's own text.
    const timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: Array.from({ length: 8 }, (_, index) => ({
            id: `c${String(index)}`,
            assetId: 'a1',
            trackId: 'v',
            start: index,
            end: index + 1,
            sourceStart: 0,
            sourceEnd: 1,
            effects: [],
            keyframes: [],
          })),
        },
      ],
    };
    const project = makeProject({ timeline } as never);
    const failed = critique(project, { minShotCount: 20 });
    expect(failed.checks.find((c) => c.id === 'shot_count')).toMatchObject({ status: 'fail' });
    expect(failed.ok).toBe(false);
    const passed = critique(project, { minShotCount: 8 });
    expect(passed.checks.find((c) => c.id === 'shot_count')).toMatchObject({ status: 'pass' });
  });

  it('skips when the request named no number', () => {
    expect(critique(makeProject(), {}).checks.find((c) => c.id === 'shot_count')).toMatchObject({
      status: 'skipped',
    });
  });

  it('counts picture only — the music bed is not a shot', () => {
    // The captured montage run ended with exactly one clip on the timeline: the track it had
    // just downloaded. Counting `allClips` minus overlays made that a shot, the same
    // derivation that let `picture_present` report "pass: 1 picture clip" on a fifty-clip
    // request whose timeline held nothing but its soundtrack.
    const project = withTracks(
      [
        {
          id: 'music_1',
          type: 'audio',
          clips: [
            clip({
              id: 'clip_bed',
              assetId: 'music_bed',
              trackId: 'music_1',
              end: 121,
              sourceEnd: 121,
            }),
          ],
        },
      ],
      {
        assets: [{ id: 'music_bed', path: 'media/bed.mp3', kind: 'audio', durationSeconds: 121 }],
      } as never,
    );
    const report = critique(project, { minShotCount: 50 });
    expect(idOf(report, 'shot_count')).toMatchObject({ status: 'fail' });
    expect(idOf(report, 'shot_count')?.detail).toContain('0 shots');
    expect(report.ok).toBe(false);
  });

  it('warns when a spec-length brief states a count the reader could not read', () => {
    const spec = `${'Make a montage. '.repeat(120)} Use 2 clips.`;
    expect(idOf(critique(makeProject(), { request: spec }), 'shot_count')).toMatchObject({
      status: 'warn',
    });
  });

  it('a warned shot count never blocks the run', () => {
    const spec = `${'Make a montage. '.repeat(120)} Use 2 clips.`;
    const report = critique(makeProject(), { request: spec });
    expect(report.checks.some((c) => c.id === 'shot_count' && c.status === 'warn')).toBe(true);
    expect(report.checks.filter((c) => c.status === 'fail')).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('stays skipped when a short request genuinely named no count', () => {
    expect(
      idOf(critique(makeProject(), { request: 'tighten the intro' }), 'shot_count'),
    ).toMatchObject({ status: 'skipped' });
  });
});

describe('treatment coverage', () => {
  /** A cut of `total` clips where `treated` carry a grade and `moved` carry keyframes. */
  const cut = (total: number, treated: number, moved: number) =>
    makeProject({
      timeline: {
        tracks: [
          {
            id: 'v',
            type: 'video',
            clips: Array.from({ length: total }, (_, index) => ({
              id: `c${String(index)}`,
              assetId: 'asset_1',
              trackId: 'v',
              start: index,
              end: index + 1,
              sourceStart: 0,
              sourceEnd: 1,
              effects:
                index < treated
                  ? [{ id: `g${String(index)}`, type: 'color_grade', params: {}, keyframes: [] }]
                  : [],
              keyframes:
                index < moved
                  ? [
                      {
                        id: `k${String(index)}`,
                        time: 0,
                        property: 'scale',
                        value: 1,
                        easing: 'linear',
                      },
                    ]
                  : [],
            })),
          },
        ],
      },
    } as never);

  it('fails when a treatment the request demanded of every clip is on one clip', () => {
    // Run 2 exactly: the grade landed on 1 of 47 and the Ken Burns move on that same clip,
    // and every criterion the run had — a duration and a shot count — was satisfied.
    const report = critique(cut(47, 1, 1), { coverage: ['grade', 'motion'] });
    const found = report.checks.find((c) => c.id === 'treatment_coverage');
    expect(found).toMatchObject({ status: 'fail' });
    expect(found?.detail).toContain('colour grade: 1 of 47');
    expect(found?.detail).toContain('own motion (zoom/pan): 1 of 47');
    expect(report.ok).toBe(false);
  });

  it('passes when every clip carries every demanded treatment', () => {
    expect(
      critique(cut(5, 5, 5), { coverage: ['grade', 'motion'] }).checks.find(
        (c) => c.id === 'treatment_coverage',
      ),
    ).toMatchObject({ status: 'pass' });
  });

  it('names only the treatment that fell short', () => {
    const found = critique(cut(5, 5, 2), { coverage: ['grade', 'motion'] }).checks.find(
      (c) => c.id === 'treatment_coverage',
    );
    expect(found?.detail).toContain('own motion (zoom/pan): 2 of 5');
    expect(found?.detail).not.toContain('colour grade');
  });

  it('skips when the request asked nothing of every clip', () => {
    expect(
      critique(cut(5, 0, 0), {}).checks.find((c) => c.id === 'treatment_coverage'),
    ).toMatchObject({ status: 'skipped' });
  });
});

describe('reframe coverage', () => {
  /** A portrait project with `cropped` of its `total` picture clips reframed. */
  const verticalCut = (total: number, cropped: number) =>
    makeProject({
      resolution: { width: 1080, height: 1920 },
      timeline: {
        tracks: [
          {
            id: 'v',
            type: 'video',
            clips: Array.from({ length: total }, (_, index) => ({
              id: `c${String(index)}`,
              assetId: 'asset_1',
              trackId: 'v',
              start: index,
              end: index + 1,
              sourceStart: 0,
              sourceEnd: 1,
              effects: [],
              keyframes: [],
              ...(index < cropped ? { crop: { x: 0.34, y: 0, width: 0.3164, height: 1 } } : {}),
            })),
          },
        ],
      },
    } as never);

  it('fails a cut where some shots are reframed and the rest are not', () => {
    // Two captured runs failed exactly this way: the editor asked for a full-bleed vertical
    // cut, the agent reframed the opening shots, stopped, and the run reported "All checks
    // passed" over 9 reframed and 38 letterboxed shots.
    const report = critique(verticalCut(10, 3), {});
    const found = report.checks.find((c) => c.id === 'reframe_coverage');
    expect(found).toMatchObject({ status: 'fail' });
    expect(found?.detail).toContain('3 of 10');
    expect(found?.detail).toContain('c3');
    expect(report.ok).toBe(false);
  });

  it('passes when every picture clip is reframed', () => {
    expect(
      critique(verticalCut(10, 10), {}).checks.find((c) => c.id === 'reframe_coverage'),
    ).toMatchObject({ status: 'pass' });
  });

  it('warns — never fails — when a portrait frame has no reframing at all', () => {
    // Might be a same-aspect edit that needs none; the project does not carry each asset's
    // pixel dimensions, so this cannot be settled, only raised.
    const found = critique(verticalCut(10, 0), {}).checks.find((c) => c.id === 'reframe_coverage');
    expect(found).toMatchObject({ status: 'warn' });
    expect(found?.detail).toContain('black bars');
  });

  it('says nothing about an uncropped landscape edit', () => {
    // The default fixture is 1920x1080 with no crops — the ordinary case, and not a defect.
    expect(
      critique(makeProject(), {}).checks.find((c) => c.id === 'reframe_coverage'),
    ).toMatchObject({ status: 'skipped' });
  });
});

describe('critique — shape', () => {
  it('preserves the existing PRD §8.6 check set when no temporal review ran', () => {
    const report = critique(makeProject());
    expect(report.checks.map((c) => c.id)).toEqual([
      'request_match',
      'picture_present',
      'picture_coverage',
      'duration_target',
      'shot_count',
      'reframe_coverage',
      'treatment_coverage',
      'caption_alignment',
      'safe_area',
      'audio_clipping',
      'black_frames',
      'missing_assets',
      'export_settings',
      // Editorial checks (context-management Phase 4). The battery above answers "is the
      // deliverable well-formed?" and not one of it answers "is this a good cut?"; these
      // six do, and they run on every review rather than behind a flag.
      'jump_cut',
      'word_severed',
      'dead_air',
      'transition_fit',
      'audio_slam',
      'shot_rhythm',
    ]);
  });

  it('ok is false only when a check fails; warnings still pass', () => {
    // The fixture is a 10s timeline whose two transcript words end at 1s, so `dead_air`
    // warns about the nine seconds of nothing after the last word — correctly, and as a
    // warning rather than a failure (see the check's own note on promotion).
    const ok = critique(makeProject(), { producedChanges: true });
    expect(ok.ok).toBe(true);
    expect(ok.summary).toMatch(/warning/);

    const warned = critique(makeProject(), { producedChanges: false });
    expect(warned.ok).toBe(true);
    expect(warned.summary).toMatch(/warning/);
  });
});

describe('picture_present', () => {
  /** The shape run e30c1fe9 shipped: text overlays over an empty video track. */
  const textOnBlack = () =>
    withTracks([
      {
        id: 'txt_main',
        type: 'overlay',
        clips: [
          clip({ id: 'txt_1', assetId: '__text__', trackId: 'txt_main', start: 0, end: 15 }),
          clip({ id: 'txt_2', assetId: '__text__', trackId: 'txt_main', start: 15, end: 30 }),
        ],
      },
      { id: 'v_main', type: 'video', clips: [] },
    ]);

  it('fails a reel that is text on black when a visual deliverable was asked for', () => {
    const report = critique(textOnBlack(), { durationTargetSeconds: 30 });
    expect(idOf(report, 'picture_present')).toMatchObject({ status: 'fail' });
    expect(idOf(report, 'picture_present')?.detail).toMatch(/no picture under them/);
    expect(report.ok).toBe(false);
  });

  it('stops the duration check from certifying that reel as on target in silence', () => {
    // It IS 30 seconds long, and saying so is fine — as long as it also says of what.
    const duration = idOf(
      critique(textOnBlack(), { durationTargetSeconds: 30 }),
      'duration_target',
    );
    expect(duration).toMatchObject({ status: 'pass' });
    expect(duration?.detail).toMatch(/Only 0s of that is picture or sound/);
  });

  it('only warns when nothing visual was asked for', () => {
    expect(idOf(critique(textOnBlack()), 'picture_present')).toMatchObject({ status: 'warn' });
  });

  it('passes an ordinary cut and skips an empty timeline', () => {
    expect(idOf(critique(makeProject()), 'picture_present')).toMatchObject({ status: 'pass' });
    expect(idOf(critique(withTracks([])), 'picture_present')).toMatchObject({ status: 'skipped' });
  });

  it('regression: a music bed alone is not picture', () => {
    // Run `f014f3ac`. A fifty-clip montage request ended with one clip on the timeline —
    // the track it had just downloaded — and this check, written for exactly that failure,
    // reported "pass: 1 picture clip". "Picture" was derived as "not an overlay", so a
    // sound file satisfied the one check that exists to say there is no film here.
    const musicOnly = withTracks(
      [
        { id: 'v_main', type: 'video', clips: [] },
        {
          id: 'a_music',
          type: 'audio',
          clips: [clip({ id: 'bed', assetId: 'music_1', trackId: 'a_music', start: 0, end: 203 })],
        },
      ],
      {
        assets: [
          { id: 'music_1', path: 'media/bed.mp3', kind: 'audio' },
        ] as unknown as Project['assets'],
      },
    );
    const report = critique(musicOnly, { durationTargetSeconds: 30 });
    expect(idOf(report, 'picture_present')).toMatchObject({ status: 'fail' });
    expect(report.ok).toBe(false);
  });

  it('regression: the per-clip checks do not ask an audio clip for a reframe', () => {
    // The same wrong predicate told the run "own reframe: 0 of 1 clips" about its music.
    const musicOnly = withTracks(
      [
        {
          id: 'a_music',
          type: 'audio',
          clips: [clip({ id: 'bed', assetId: 'music_1', trackId: 'a_music', start: 0, end: 203 })],
        },
      ],
      {
        assets: [
          { id: 'music_1', path: 'media/bed.mp3', kind: 'audio' },
        ] as unknown as Project['assets'],
      },
    );
    const report = critique(musicOnly, { coverage: ['crop'] });
    expect(idOf(report, 'treatment_coverage')).toMatchObject({ status: 'skipped' });
    expect(idOf(report, 'reframe_coverage')).toMatchObject({ status: 'skipped' });
  });
});

describe('request_match', () => {
  it('warns when no changes were produced, passes otherwise', () => {
    expect(idOf(critique(makeProject(), { producedChanges: false }), 'request_match')?.status).toBe(
      'warn',
    );
    expect(idOf(critique(makeProject(), { producedChanges: true }), 'request_match')?.status).toBe(
      'pass',
    );
    expect(idOf(critique(makeProject()), 'request_match')?.status).toBe('pass');
  });
});

describe('duration_target', () => {
  it('skips with no target, passes within tolerance, fails outside', () => {
    expect(idOf(critique(makeProject()), 'duration_target')?.status).toBe('skipped');
    expect(
      idOf(critique(makeProject(), { durationTargetSeconds: 10 }), 'duration_target')?.status,
    ).toBe('pass');
    expect(
      idOf(critique(makeProject(), { durationTargetSeconds: 45 }), 'duration_target')?.status,
    ).toBe('fail');
    // custom tolerance widens the pass window
    expect(
      idOf(
        critique(makeProject(), { durationTargetSeconds: 14, durationToleranceSeconds: 5 }),
        'duration_target',
      )?.status,
    ).toBe('pass');
  });
});

describe('caption_alignment', () => {
  it('skips when no caption track exists', () => {
    expect(idOf(critique(makeProject()), 'caption_alignment')?.status).toBe('skipped');
  });

  it('passes captions inside the program with positive duration', () => {
    const project = withTracks([
      { id: 'video_1', type: 'video', clips: [clip({ id: 'v', end: 10, sourceEnd: 10 })] },
      {
        id: 'caption_1',
        type: 'caption',
        clips: [clip({ id: 'c', assetId: CAPTION_ASSET_ID, start: 1, end: 3, sourceEnd: 3 })],
      },
    ]);
    expect(idOf(critique(project), 'caption_alignment')?.status).toBe('pass');
  });

  it('falls back to full timeline length when there is no video/audio content', () => {
    // A caption-only timeline has no video/audio, so contentDuration falls back
    // to the overall timeline length and the caption is considered in-bounds.
    const project = withTracks([
      {
        id: 'caption_1',
        type: 'caption',
        clips: [clip({ id: 'c', assetId: CAPTION_ASSET_ID, start: 0, end: 3, sourceEnd: 3 })],
      },
    ]);
    expect(idOf(critique(project), 'caption_alignment')?.status).toBe('pass');
  });

  it('fails a caption that runs past the program end', () => {
    const project = withTracks([
      { id: 'video_1', type: 'video', clips: [clip({ id: 'v', end: 5, sourceEnd: 5 })] },
      {
        id: 'caption_1',
        type: 'caption',
        clips: [clip({ id: 'c', assetId: CAPTION_ASSET_ID, start: 4, end: 9, sourceEnd: 9 })],
      },
    ]);
    const check = idOf(critique(project), 'caption_alignment');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/past program end/);
  });
});

describe('safe_area', () => {
  it('skips when overlays carry no explicit position', () => {
    const project = withTracks([
      {
        id: 'overlay_1',
        type: 'overlay',
        clips: [clip({ id: 'o', assetId: TEXT_OVERLAY_ASSET_ID })],
      },
    ]);
    expect(idOf(critique(project), 'safe_area')?.status).toBe('skipped');
  });

  it('passes a positioned overlay inside the safe area', () => {
    const project = withTracks([
      {
        id: 'overlay_1',
        type: 'overlay',
        clips: [
          clip({
            id: 'o',
            assetId: TEXT_OVERLAY_ASSET_ID,
            effects: [{ id: 'e', type: 'transform', params: { x: 0.5, y: 0.5 }, keyframes: [] }],
          }),
        ],
      },
    ]);
    expect(idOf(critique(project), 'safe_area')?.status).toBe('pass');
  });

  it('warns when a positioned overlay sits outside the safe area', () => {
    const project = withTracks([
      {
        id: 'overlay_1',
        type: 'overlay',
        clips: [
          clip({
            id: 'o',
            assetId: TEXT_OVERLAY_ASSET_ID,
            effects: [{ id: 'e', type: 'transform', params: { x: 0.02, y: 0.5 }, keyframes: [] }],
          }),
        ],
      },
    ]);
    expect(idOf(critique(project), 'safe_area')?.status).toBe('warn');
  });

  it('ignores non-positional effects, non-numeric coords, and partial coords', () => {
    const project = withTracks([
      {
        id: 'overlay_1',
        type: 'overlay',
        clips: [
          clip({
            id: 'o',
            assetId: TEXT_OVERLAY_ASSET_ID,
            effects: [
              // no x/y — skipped
              { id: 'e0', type: 'color_grade', params: { exposure: 0.2 }, keyframes: [] },
              // non-numeric x is ignored; y is in-range
              { id: 'e1', type: 'transform', params: { x: 'nope', y: 0.5 }, keyframes: [] },
              // y-only, out of range → flagged with an em-dash for the missing x
              { id: 'e2', type: 'transform', params: { y: 0.98 }, keyframes: [] },
              // x-only, out of range → flagged with an em-dash for the missing y
              { id: 'e3', type: 'transform', params: { x: 0.99 }, keyframes: [] },
            ],
          }),
        ],
      },
    ]);
    const check = idOf(critique(project), 'safe_area');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('(—,');
    expect(check?.detail).toContain(', —)');
  });
});

describe('audio_clipping / black_frames (render-derived)', () => {
  it('skips without a render report', () => {
    const report = critique(makeProject());
    expect(idOf(report, 'audio_clipping')?.status).toBe('skipped');
    expect(idOf(report, 'black_frames')?.status).toBe('skipped');
  });

  it('reflects the render validator verdict', () => {
    const bad = critique(makeProject(), { render: { audioClipping: true, hasBlackFrames: true } });
    expect(idOf(bad, 'audio_clipping')?.status).toBe('fail');
    expect(idOf(bad, 'black_frames')?.status).toBe('fail');

    const good = critique(makeProject(), {
      render: { audioClipping: false, hasBlackFrames: false },
    });
    expect(idOf(good, 'audio_clipping')?.status).toBe('pass');
    expect(idOf(good, 'black_frames')?.status).toBe('pass');
  });
});

describe('temporal_evidence', () => {
  it('is additive when a temporal review ran and passes a complete report', () => {
    expect(idOf(critique(makeProject()), 'temporal_evidence')).toBeUndefined();
    const report = critique(makeProject(), {
      temporal: {
        ok: true,
        projectRevision: 4,
        evidenceRequestIds: ['window'],
        checks: [{ requestId: 'window', kind: 'range', status: 'pass', issues: [] }],
      },
    });
    expect(idOf(report, 'temporal_evidence')?.status).toBe('pass');
  });

  it('fails when evidence fails or was not returned', () => {
    const report = critique(makeProject(), {
      temporal: {
        ok: false,
        projectRevision: 4,
        evidenceRequestIds: ['window'],
        checks: [
          {
            requestId: 'window',
            kind: 'range',
            status: 'skipped',
            issues: ['Evidence was not returned.'],
          },
        ],
      },
    });
    expect(idOf(report, 'temporal_evidence')).toMatchObject({ status: 'fail' });
    expect(report.ok).toBe(false);
  });
});

describe('missing_assets', () => {
  it('passes when every clip references a known or synthetic asset', () => {
    const project = withTracks([
      { id: 'video_1', type: 'video', clips: [clip({ id: 'v' })] },
      { id: 'caption_1', type: 'caption', clips: [clip({ id: 'c', assetId: CAPTION_ASSET_ID })] },
    ]);
    expect(idOf(critique(project), 'missing_assets')?.status).toBe('pass');
  });

  it('fails when a clip references an unknown asset', () => {
    const project = withTracks([
      { id: 'video_1', type: 'video', clips: [clip({ id: 'v', assetId: 'ghost' })] },
    ]);
    const check = idOf(critique(project), 'missing_assets');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/ghost/);
  });
});

describe('export_settings', () => {
  it('skips without a target platform', () => {
    expect(idOf(critique(makeProject()), 'export_settings')?.status).toBe('skipped');
  });

  it('warns when a vertical platform gets a landscape frame', () => {
    expect(
      idOf(critique(makeProject(), { targetPlatform: 'reels' }), 'export_settings')?.status,
    ).toBe('warn');
  });

  it('passes when the frame suits the platform', () => {
    const portrait = makeProject({ resolution: { width: 1080, height: 1920 } });
    expect(idOf(critique(portrait, { targetPlatform: 'reels' }), 'export_settings')?.status).toBe(
      'pass',
    );
    // landscape platform with landscape frame
    expect(
      idOf(critique(makeProject(), { targetPlatform: 'linkedin' }), 'export_settings')?.status,
    ).toBe('pass');
  });
});

describe('picture_coverage', () => {
  /**
   * The shape run 4c9b5f82 shipped: a 36.1s music bed with ten photos over only its
   * first 10.0 seconds. 72% of the programme rendered as black with music playing.
   */
  const musicOutrunsPicture = () =>
    withTracks(
      [
        {
          id: 'v_main',
          type: 'video',
          clips: [
            clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 5.004 }),
            clip({ id: 'p_2', trackId: 'v_main', start: 5.004, end: 10.008 }),
          ],
        },
        {
          id: 'a_music',
          type: 'audio',
          clips: [
            clip({ id: 'music', assetId: 'asset_music', trackId: 'a_music', start: 0, end: 36.107 }),
          ],
        },
      ],
      {
        assets: [
          { id: 'asset_1', path: 'media/a.jpeg', kind: 'image', durationSeconds: 5 },
          { id: 'asset_music', path: 'media/m.mp3', kind: 'audio', durationSeconds: 47.8 },
        ] as Project['assets'],
      },
    );

  it('regression: fails a montage whose music outruns its picture', () => {
    const report = critique(musicOutrunsPicture(), { minShotCount: 61 });
    const coverage = idOf(report, 'picture_coverage');
    expect(coverage).toMatchObject({ status: 'fail' });
    expect(coverage?.detail).toMatch(/26\.099s of the 36\.107s programme has no picture/);
    expect(coverage?.detail).toMatch(/10\.008s–36\.107s/);
    expect(report.ok).toBe(false);
  });

  it('is what picture_present cannot ask: that check passes the same timeline', () => {
    const report = critique(musicOutrunsPicture(), { minShotCount: 61 });
    expect(idOf(report, 'picture_present')).toMatchObject({ status: 'pass' });
  });

  it('reports an interior hole, not only a tail', () => {
    const project = withTracks([
      {
        id: 'v_main',
        type: 'video',
        clips: [
          clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 4 }),
          clip({ id: 'p_2', trackId: 'v_main', start: 9, end: 12 }),
        ],
      },
    ]);
    const coverage = idOf(critique(project, { minShotCount: 2 }), 'picture_coverage');
    expect(coverage).toMatchObject({ status: 'fail' });
    expect(coverage?.detail).toMatch(/4s–9s/);
  });

  it('only warns when nothing visual was asked for', () => {
    expect(idOf(critique(musicOutrunsPicture()), 'picture_coverage')).toMatchObject({
      status: 'warn',
    });
  });

  it('tolerates a gap under a second and overlapping picture layers', () => {
    const project = withTracks([
      {
        id: 'v_main',
        type: 'video',
        clips: [clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 6 })],
      },
      {
        id: 'v_b',
        type: 'video',
        clips: [clip({ id: 'p_2', trackId: 'v_b', start: 5, end: 9.9 })],
      },
      {
        id: 'a_music',
        type: 'audio',
        clips: [
          clip({ id: 'music', assetId: 'asset_music', trackId: 'a_music', start: 0, end: 10 }),
        ],
      },
    ]);
    expect(idOf(critique(project, { minShotCount: 2 }), 'picture_coverage')).toMatchObject({
      status: 'pass',
    });
  });

  it('skips a timeline with no picture at all — picture_present owns that', () => {
    expect(idOf(critique(withTracks([])), 'picture_coverage')).toMatchObject({ status: 'skipped' });
  });
});
