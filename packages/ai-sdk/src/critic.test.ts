/**
 * Tests for the Critic / Review agent (PRD §8.6). The Critic is pure and
 * deterministic — every check is exercised across pass / warn / fail / skipped.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import {
  CAPTION_ASSET_ID,
  TEXT_OVERLAY_ASSET_ID,
  applyProjectPatch,
} from '@framepilot/editor-core';
import {
  INHERITED_PREFIX,
  critique,
  explicitDurationTarget,
  detectTranscriptLoop,
  reconcileInheritedFailures,
  explicitDurationTargetSeconds,
  repairTrailingSoundOverrun,
  standingAgainstAcceptance,
  timelineDuration,
  type CritiqueOptions,
  type CritiqueReport,
} from './critic.js';
import { checkableAcceptance } from './acceptance.js';
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

  it('reads the deliverable nouns people actually use, and the bare "best N" idiom', () => {
    // The golden set's own podcast case stated its length as plainly as a request can and
    // yielded nothing, so `duration_target` reported "skipped — no duration target was set"
    // and a run that answered a 60-second brief with 36 seconds completed as a success.
    expect(
      explicitDurationTargetSeconds(
        'Pull the best 60 seconds of this recording into a highlight clip. Do not cut mid-sentence.',
      ),
    ).toBe(60);
    // No anchor anywhere: the length itself names the deliverable.
    expect(explicitDurationTargetSeconds('Give me the best 60 seconds.')).toBe(60);
    expect(explicitDurationTargetSeconds('Build a 20-35 second teaser')).toBe(27.5);
    expect(explicitDurationTargetSeconds('Make a 30 second supercut')).toBe(30);
  });

  it('reads "cut this down to N" only when the object is the whole deliverable', () => {
    expect(explicitDurationTargetSeconds('Cut this down to 45 seconds.')).toBe(45);
    expect(explicitDurationTargetSeconds('Shorten it down to 2 minutes.')).toBe(120);
    expect(explicitDurationTargetSeconds('Bring the video down to 90s')).toBe(90);
    // …and never when it is one clip. This is why the bare preposition is not an anchor.
    expect(explicitDurationTargetSeconds('Trim the first clip down to 5 seconds.')).toBeUndefined();
    expect(
      explicitDurationTargetSeconds('Trim the first clip so it ends at exactly 10 seconds.'),
    ).toBeUndefined();
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

  /** A 9:16 project holding one landscape clip and one already-vertical clip. */
  const mixedSourceCut = (cropLandscape: boolean): Project =>
    makeProject({
      resolution: { width: 1080, height: 1920 },
      assets: [
        {
          id: 'land',
          path: 'media/a.mov',
          kind: 'video',
          durationSeconds: 40,
          media: { width: 3840, height: 2160 },
        },
        {
          id: 'port',
          path: 'media/b.mp4',
          kind: 'video',
          durationSeconds: 30,
          media: { width: 1080, height: 1920 },
        },
      ],
      timeline: {
        tracks: [
          {
            id: 'v',
            type: 'video',
            clips: [
              {
                id: 'c0',
                assetId: 'land',
                trackId: 'v',
                start: 0,
                end: 5,
                sourceStart: 0,
                sourceEnd: 5,
                effects: [],
                keyframes: [],
                ...(cropLandscape ? { crop: { x: 0.2917, y: 0, width: 0.4167, height: 1 } } : {}),
              },
              {
                id: 'c1',
                assetId: 'port',
                trackId: 'v',
                start: 5,
                end: 10,
                sourceStart: 0,
                sourceEnd: 5,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    } as never);

  it('counts a clip that already fills the frame as satisfying a "no black bars" demand', () => {
    // `crop` coverage is parsed from "reframe / fill the frame / no black bars", so it is
    // the framing requirement — and a source already no wider than the frame meets it while
    // carrying no crop, which is exactly what `add_clip`'s placer leaves behind.
    expect(
      critique(mixedSourceCut(true), { coverage: ['crop'] }).checks.find(
        (c) => c.id === 'treatment_coverage',
      ),
    ).toMatchObject({ status: 'pass' });
  });

  it('still fails the demand when the landscape clip is the one left uncropped', () => {
    const found = critique(mixedSourceCut(false), { coverage: ['crop'] }).checks.find(
      (c) => c.id === 'treatment_coverage',
    );
    expect(found).toMatchObject({ status: 'fail' });
    expect(found?.detail).toContain('1 of 2');
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
    // Every clip here comes off ONE unmeasured asset, so nobody can measure the shape —
    // but the run itself cropped three of them, which is its own evidence that the source
    // does not fill the frame, and the seven it skipped will letterbox beside them.
    const report = critique(verticalCut(10, 3), {});
    const found = report.checks.find((c) => c.id === 'reframe_coverage');
    expect(found).toMatchObject({ status: 'fail' });
    // The count names the clips that are WRONG (7), not the ones already right (3): it is
    // the number an editor has to act on.
    expect(found?.detail).toContain('7 of 10');
    expect(found?.detail).toContain('c3');
    expect(report.ok).toBe(false);
  });

  it('passes a mixed-source cut where the uncropped clips already fill the frame', () => {
    // The montage failure this check caused: a 9:16 montage pulling from a 4K landscape
    // camera and one phone clip shot vertically. `add_clip` crops the landscape sources and
    // deliberately leaves the vertical one bare — `coverCropForFrame` returns undefined for
    // a source no wider than the frame — and the run was failed for that single correct
    // clip, after thirty edits the rubric scored perfect.
    const project = makeProject({
      resolution: { width: 1080, height: 1920 },
      assets: [
        {
          id: 'land',
          path: 'media/a.mov',
          kind: 'video',
          durationSeconds: 40,
          media: { width: 3840, height: 2160 },
        },
        {
          id: 'port',
          path: 'media/b.mp4',
          kind: 'video',
          durationSeconds: 30,
          media: { width: 1080, height: 1920 },
        },
      ],
      timeline: {
        tracks: [
          {
            id: 'v',
            type: 'video',
            clips: [
              {
                id: 'c0',
                assetId: 'land',
                trackId: 'v',
                start: 0,
                end: 5,
                sourceStart: 0,
                sourceEnd: 5,
                effects: [],
                keyframes: [],
                crop: { x: 0.2917, y: 0, width: 0.4167, height: 1 },
              },
              {
                id: 'c1',
                assetId: 'port',
                trackId: 'v',
                start: 5,
                end: 10,
                sourceStart: 0,
                sourceEnd: 5,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    } as never);
    const report = critique(project, {});
    expect(report.checks.find((c) => c.id === 'reframe_coverage')).toMatchObject({
      status: 'pass',
    });
  });

  it('still fails when a measured landscape clip is left uncropped beside a fitting one', () => {
    // The same shape, except the landscape clip was never cropped: that one really does
    // render with bars, and measurement — not the presence of a crop elsewhere — says so.
    const project = makeProject({
      resolution: { width: 1080, height: 1920 },
      assets: [
        {
          id: 'land',
          path: 'media/a.mov',
          kind: 'video',
          durationSeconds: 40,
          media: { width: 3840, height: 2160 },
        },
        {
          id: 'port',
          path: 'media/b.mp4',
          kind: 'video',
          durationSeconds: 30,
          media: { width: 1080, height: 1920 },
        },
      ],
      timeline: {
        tracks: [
          {
            id: 'v',
            type: 'video',
            clips: [
              {
                id: 'c0',
                assetId: 'land',
                trackId: 'v',
                start: 0,
                end: 5,
                sourceStart: 0,
                sourceEnd: 5,
                effects: [],
                keyframes: [],
              },
              {
                id: 'c1',
                assetId: 'port',
                trackId: 'v',
                start: 5,
                end: 10,
                sourceStart: 0,
                sourceEnd: 5,
                effects: [],
                keyframes: [],
                crop: { x: 0, y: 0.2, width: 1, height: 0.6 },
              },
            ],
          },
        ],
      },
    } as never);
    const found = critique(project, {}).checks.find((c) => c.id === 'reframe_coverage');
    expect(found).toMatchObject({ status: 'fail' });
    expect(found?.detail).toContain('c0');
  });

  it('passes when every picture clip is reframed', () => {
    expect(
      critique(verticalCut(10, 10), {}).checks.find((c) => c.id === 'reframe_coverage'),
    ).toMatchObject({ status: 'pass' });
  });

  it('warns — never fails — when a portrait frame has no reframing and no measurements', () => {
    // Might be a same-aspect edit that needs none: with the sources unmeasured this cannot
    // be settled, only raised. The warning has to say THAT, though. Its old text ("any
    // landscape source will render with black bars … if that is not intended") described a
    // framing check that had run; none had.
    const found = critique(verticalCut(10, 0), {}).checks.find((c) => c.id === 'reframe_coverage');
    expect(found).toMatchObject({ status: 'warn' });
    expect(found?.detail).toContain('Not checked');
    expect(found?.detail).toContain('never measured');
  });

  it('says nothing about an uncropped landscape edit', () => {
    // The default fixture is 1920x1080 with no crops — the ordinary case, and not a defect.
    expect(
      critique(makeProject(), {}).checks.find((c) => c.id === 'reframe_coverage'),
    ).toMatchObject({ status: 'skipped' });
  });
});

/**
 * P3.4/P4.2: "make it feel like this" becomes a number the run is graded on, taken from a
 * measured reference and never from the prompt.
 */
describe('shot_length_target', () => {
  const shots = (durations: readonly number[]) => {
    let at = 0;
    const clips = durations.map((duration, index) => {
      const clip = {
        id: `clip_${String(index)}`,
        assetId: 'asset_1',
        trackId: 'video_1',
        start: at,
        end: at + duration,
        sourceStart: 0,
        sourceEnd: duration,
        effects: [],
        keyframes: [],
      };
      at += duration;
      return clip;
    });
    return makeProject({
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips }] },
    } as never);
  };
  const idOf = (project: ReturnType<typeof makeProject>, options: CritiqueOptions) =>
    critique(project, options).checks.find((c) => c.id === 'shot_length_target')!;

  it('skips when no reference set a target', () => {
    expect(idOf(shots([1, 1, 1, 1]), {}).status).toBe('skipped');
  });

  it('skips a cut too short to have a median', () => {
    const check = idOf(shots([1, 1]), { medianShotTargetSeconds: 1.1 });
    expect(check.status).toBe('skipped');
    expect(check.detail).toContain('too few to have a median');
  });

  it('passes a cut holding the reference pace and names the reference', () => {
    const check = idOf(shots([1, 1.2, 1.1, 0.9, 1.3]), {
      medianShotTargetSeconds: 1.1,
      medianShotToleranceSeconds: 0.5,
      medianShotSource: 'ref_1: Pacing: fast — median shot 1.1s',
    });
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('ref_1');
  });

  it('fails a cut that is slower than the reference and says which way', () => {
    const check = idOf(shots([4, 4.2, 4.1, 3.9, 4.3]), {
      medianShotTargetSeconds: 1.1,
      medianShotToleranceSeconds: 0.5,
    });
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('slower than the reference');
    // The advice matters: adding shots would move the median without matching the pace.
    expect(check.detail).toContain('do not add shots');
  });

  it('fails a cut that is faster than the reference', () => {
    const check = idOf(shots([0.2, 0.25, 0.2, 0.3, 0.2]), { medianShotTargetSeconds: 4 });
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('faster than the reference');
  });

  it('is one of the whole-cut conditions a running turn is shown', () => {
    const standing = standingAgainstAcceptance(shots([4, 4.2, 4.1, 3.9, 4.3]), {
      medianShotTargetSeconds: 1.1,
      medianShotToleranceSeconds: 0.5,
    });
    expect(standing.some((line) => line.includes('the reference runs 1.1s'))).toBe(true);
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
      'shot_length_target',
      'reframe_coverage',
      'treatment_coverage',
      'caption_alignment',
      'safe_area',
      'audio_clipping',
      'black_frames',
      'missing_assets',
      'export_settings',
      // Whether the words the transcript-reading checks below are about were ever spoken.
      'transcript_reliable',
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
    // And it says the RIGHT thing about it. The overlay count was `allClips(timeline)`, so
    // in run `ea8e46ec` — a music bed and nothing else — the editor was told "1
    // overlay/caption clip … the whole thing renders as text on black", naming a caption
    // that did not exist and text that was never placed. The remedy for sound-with-no-
    // picture is not the remedy for text-on-black, and the wrong sentence sends the editor
    // after the wrong thing.
    const detail = idOf(report, 'picture_present')?.detail ?? '';
    expect(detail).toContain('sound but no picture');
    expect(detail).not.toContain('overlay/caption');
    expect(detail).not.toContain('text on black');
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

// GAP-014. The same checks the final self-check runs, consulted while the run can still
// act on them — in the check's own words, so what a run is told in flight is exactly what
// it will be judged by.
describe('standingAgainstAcceptance', () => {
  it('names every unmet whole-cut condition, in the words the verdict will use', () => {
    const project = withTracks(
      [
        {
          id: 'v_main',
          type: 'video',
          clips: [clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 4 })],
        },
        {
          id: 'a_music',
          type: 'audio',
          clips: [
            clip({ id: 'music', assetId: 'asset_music', trackId: 'a_music', start: 0, end: 30 }),
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
    const standing = standingAgainstAcceptance(project, {
      durationTargetSeconds: 4,
      minShotCount: 61,
    });
    expect(standing.join('\n')).toMatch(/no picture under it/);
    expect(standing.join('\n')).toMatch(/Timeline is 30s but the target is 4s/);
    expect(standing.join('\n')).toMatch(/uses 1 shots but at least 61/);
    // Every line is verbatim from a check, so the in-flight account and the verdict can
    // never describe the same condition two different ways.
    const details = critique(project, { durationTargetSeconds: 4, minShotCount: 61 }).checks.map(
      (c) => c.detail,
    );
    for (const line of standing) expect(details).toContain(line);
  });

  it('is empty for a cut that meets every stated condition', () => {
    const project = withTracks([
      {
        id: 'v_main',
        type: 'video',
        clips: [
          clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 2 }),
          clip({ id: 'p_2', trackId: 'v_main', start: 2, end: 4 }),
        ],
      },
    ]);
    expect(
      standingAgainstAcceptance(project, { durationTargetSeconds: 4, minShotCount: 2 }),
    ).toEqual([]);
  });

  it('reports nothing when the request stated no checkable condition', () => {
    const project = withTracks([
      {
        id: 'v_main',
        type: 'video',
        clips: [clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 4 })],
      },
    ]);
    expect(standingAgainstAcceptance(project, {})).toEqual([]);
  });

  // The in-flight block is built from `critiqueOptions(input, agentOptions, true)` with no
  // evidence store, while the verdict passes one. That is only safe while no whole-cut
  // check reads evidence — an invariant nothing enforced, and the first check that starts
  // reading `measuredSilences` would make a run judged by something it was never shown.
  it('is measured by options the verdict cannot disagree with', () => {
    const project = withTracks([
      {
        id: 'v_main',
        type: 'video',
        clips: [clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 30 })],
      },
    ]);
    const options = { durationTargetSeconds: 4, minShotCount: 61 };
    expect(standingAgainstAcceptance(project, options)).toEqual(
      standingAgainstAcceptance(project, {
        ...options,
        measuredSilences: [{ start: 1, end: 2 }],
        blackFrames: [{ start: 0, end: 3 }],
      }),
    );
  });

  it('leaves local defects to the seam that shows them, not to a standing count', () => {
    // A jump cut is something the model finds by looking at the edit point. These five
    // checks are properties of the finished thing that no single edit reveals.
    const project = withTracks([
      {
        id: 'v_main',
        type: 'video',
        clips: [
          clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 2, sourceStart: 0, sourceEnd: 2 }),
          clip({ id: 'p_2', trackId: 'v_main', start: 2, end: 4, sourceStart: 8, sourceEnd: 10 }),
        ],
      },
    ]);
    expect(
      standingAgainstAcceptance(project, { durationTargetSeconds: 4, minShotCount: 2 }),
    ).toEqual([]);
  });
});

// GAP-009 (run `fc10301a`). This check used to say, in its own docstring, that "the
// project does not carry each asset's pixel dimensions" — true until schema v21 added
// them. With the sources measured, uncropped landscape picture in a portrait frame is not
// a risk to warn about: it is what the render will produce.
describe('reframe_coverage with measured sources', () => {
  const portraitProjectOf = (media: Record<string, unknown> | undefined) =>
    withTracks(
      [
        {
          id: 'v_main',
          type: 'video',
          clips: [
            clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 2 }),
            clip({ id: 'p_2', trackId: 'v_main', start: 2, end: 4 }),
          ],
        },
      ],
      {
        resolution: { width: 1080, height: 1920 },
        assets: [
          {
            id: 'asset_1',
            path: 'media/a.jpeg',
            kind: 'image',
            durationSeconds: 5,
            ...(media ? { media } : {}),
          },
        ] as Project['assets'],
      },
    );

  it('fails an uncropped landscape source in a portrait frame, and names the clips', () => {
    const report = critique(portraitProjectOf({ width: 4032, height: 3024 }), { minShotCount: 2 });
    const reframe = idOf(report, 'reframe_coverage');
    expect(reframe).toMatchObject({ status: 'fail' });
    expect(reframe?.detail).toMatch(/2 of 2 picture clips use a landscape source/);
    expect(reframe?.detail).toContain('p_1, p_2');
    expect(report.ok).toBe(false);
  });

  it('PASSES when the source is measured and already matches the frame', () => {
    // Used to warn. A warning here claimed doubt the check did not have: every source is
    // measured, every one matches 1080x1920, and there is nothing to crop. Reserving the
    // warning for the genuinely unknown case is what makes it worth reading.
    const found = idOf(
      critique(portraitProjectOf({ width: 1080, height: 1920 }), { minShotCount: 2 }),
      'reframe_coverage',
    );
    expect(found).toMatchObject({ status: 'pass' });
    expect(found?.detail).toContain('every picture source is measured');
  });

  it('warns when a measured source is portrait but a DIFFERENT portrait aspect', () => {
    // 4:5 in 9:16 still letterboxes — the renderer fits whatever aspect it is given. Not a
    // failure (padding a 4:5 still is a real choice), but not a clean pass either.
    const found = idOf(
      critique(portraitProjectOf({ width: 1080, height: 1350 }), { minShotCount: 2 }),
      'reframe_coverage',
    );
    expect(found).toMatchObject({ status: 'warn' });
    expect(found?.detail).toContain('aspect differs');
    expect(found?.detail).toContain('p_1, p_2');
  });

  it('warns that the MEASUREMENT is missing when nothing was measured', () => {
    // Absent dimensions mean unknown. Failing a run over a shape nobody probed would be
    // worse than the gap this closes — but the warning must name the gap, not imply the
    // framing was inspected and accepted.
    const found = idOf(
      critique(portraitProjectOf(undefined), { minShotCount: 2 }),
      'reframe_coverage',
    );
    expect(found).toMatchObject({ status: 'warn' });
    expect(found?.detail).toContain('Not checked: 2 of 2 picture clips');
    expect(found?.detail).toContain('p_1, p_2');
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
            clip({
              id: 'music',
              assetId: 'asset_music',
              trackId: 'a_music',
              start: 0,
              end: 36.107,
            }),
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

  /**
   * Run `25e06a6f`: the talking head laid down to frame 1493 (its real 49.783s, snapped)
   * and the music bed to frame 1494 (49.8s — the rounded figure every summary of that
   * asset prints). One frame apart, and that frame is the last thing the viewer sees.
   */
  const soundOneFrameLongerThanPicture = () =>
    withTracks(
      [
        {
          id: 'v_main',
          type: 'video',
          clips: [clip({ id: 'talk', trackId: 'v_main', start: 0, end: 1493 / 30 })],
        },
        {
          id: 'music_1',
          type: 'audio',
          clips: [
            clip({
              id: 'bed',
              assetId: 'asset_music',
              trackId: 'music_1',
              start: 0,
              end: 1494 / 30,
            }),
          ],
        },
      ],
      {
        assets: [
          { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 49.783 },
          { id: 'asset_music', path: 'media/m.ogx', kind: 'audio', durationSeconds: 93.64 },
        ] as Project['assets'],
      },
    );

  it('reports a programme that ends on a single black frame', () => {
    // One frame is not thirty, so this passed — and the only thing that caught it was the
    // perceptual reviewer, twice, as "Program ending is black (frame 1493)": a symptom with
    // no cause attached. The run spent two correction attempts on it and concluded it was
    // "likely a render or transition-model defect rather than something this edit can fix".
    // It was one frame of sound past the end of the picture, which this check's own sentence
    // says how to fix.
    const coverage = idOf(
      critique(soundOneFrameLongerThanPicture(), { minShotCount: 1 }),
      'picture_coverage',
    );
    expect(coverage).toMatchObject({ status: 'fail' });
    expect(coverage?.detail).toMatch(/renders as black/);
    expect(coverage?.detail).toMatch(/trim the sound back to the/);
  });

  it('still says nothing about a few frames of black BETWEEN two shots', () => {
    // The middle of a piece is where a beat of black is a beat. Reporting it there would
    // bury the real defects, which is what the one-second threshold is for.
    const withBeat = withTracks(
      [
        {
          id: 'v_main',
          type: 'video',
          clips: [
            clip({ id: 'a', trackId: 'v_main', start: 0, end: 5 }),
            clip({ id: 'b', trackId: 'v_main', start: 5 + 10 / 30, end: 10 }),
          ],
        },
      ],
      {
        assets: [
          { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 20 },
        ] as Project['assets'],
      },
    );
    expect(idOf(critique(withBeat, { minShotCount: 1 }), 'picture_coverage')).toMatchObject({
      status: 'pass',
    });
  });

  it('says nothing when picture and sound end together', () => {
    // Two clips that genuinely end together differ by float noise, not by a frame.
    const together = withTracks(
      [
        {
          id: 'v_main',
          type: 'video',
          clips: [clip({ id: 'talk', trackId: 'v_main', start: 0, end: 1493 / 30 })],
        },
        {
          id: 'music_1',
          type: 'audio',
          clips: [
            clip({
              id: 'bed',
              assetId: 'asset_music',
              trackId: 'music_1',
              start: 0,
              end: 1493 / 30,
            }),
          ],
        },
      ],
      {
        assets: [
          { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 49.783 },
          { id: 'asset_music', path: 'media/m.ogx', kind: 'audio', durationSeconds: 93.64 },
        ] as Project['assets'],
      },
    );
    expect(idOf(critique(together, { minShotCount: 1 }), 'picture_coverage')).toMatchObject({
      status: 'pass',
    });
  });

  it('repairs the single black frame it now reports, rather than only naming it', () => {
    // The check and the repair share one tail rule. When they did not, this reported a
    // defect the repair declined to fix — a finding the run cannot act on, which is how a
    // run becomes a loop.
    const ops = repairTrailingSoundOverrun(soundOneFrameLongerThanPicture(), {
      minShotCount: 1,
    });
    expect(ops).toEqual([{ type: 'trim_clip', clipId: 'bed', start: 0, end: 1493 / 30 }]);
  });

  it('regression: fails a montage whose music outruns its picture', () => {
    const report = critique(musicOutrunsPicture(), { minShotCount: 61 });
    const coverage = idOf(report, 'picture_coverage');
    expect(coverage).toMatchObject({ status: 'fail' });
    expect(coverage?.detail).toMatch(/26\.099s of the 36\.107s programme has no picture/);
    expect(coverage?.detail).toMatch(/10\.008s–36\.107s/);
    expect(report.ok).toBe(false);
  });

  // GAP-007 (run `fc10301a`). The most user-visible failure the Critic can report was
  // absent from `FIXABLE_CHECKS`, so a timeline whose last 23.7 of 47.8 seconds were black
  // went to the editor unrepaired — over a fix that is two numbers and a trim.
  describe('repairTrailingSoundOverrun', () => {
    it('trims the bed back to where the picture ends', () => {
      const project = musicOutrunsPicture();
      const ops = repairTrailingSoundOverrun(project, { minShotCount: 61 });
      expect(ops).toEqual([{ type: 'trim_clip', clipId: 'music', start: 0, end: 10.008 }]);
    });

    it('refuses an interior hole — that needs picture, not a trim', () => {
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
      expect(repairTrailingSoundOverrun(project, { minShotCount: 2 })).toEqual([]);
    });

    it('refuses when nothing visual was asked for — sound over no picture is the deliverable', () => {
      expect(repairTrailingSoundOverrun(musicOutrunsPicture(), {})).toEqual([]);
    });

    it('does nothing when the picture already covers the programme', () => {
      const project = withTracks([
        {
          id: 'v_main',
          type: 'video',
          clips: [clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 6 })],
        },
      ]);
      expect(repairTrailingSoundOverrun(project, { minShotCount: 1 })).toEqual([]);
    });

    it('leaves a bed that starts after the picture ends for a human', () => {
      // Trimming it back would invert the clip; removing it is a bigger decision than a
      // repair pass is allowed to make on its own.
      const project = withTracks(
        [
          {
            id: 'v_main',
            type: 'video',
            clips: [clip({ id: 'p_1', trackId: 'v_main', start: 0, end: 4 })],
          },
          {
            id: 'a_music',
            type: 'audio',
            clips: [
              clip({ id: 'music', assetId: 'asset_music', trackId: 'a_music', start: 8, end: 20 }),
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
      expect(repairTrailingSoundOverrun(project, { minShotCount: 1 })).toEqual([]);
    });

    it('closes the hole it was given — the check passes on the repaired timeline', () => {
      const project = musicOutrunsPicture();
      const ops = repairTrailingSoundOverrun(project, { minShotCount: 61 });
      const repaired = applyProjectPatch(project, {
        patchId: 'p' as never,
        createdBy: 'agent',
        reason: 'test',
        operations: [...ops],
      });
      expect(idOf(critique(repaired, { minShotCount: 61 }), 'picture_coverage')).toMatchObject({
        status: 'pass',
      });
    });
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

describe('run 4c9b5f82, end to end', () => {
  /**
   * The whole chain the run walked through, from the brief it was given to the verdict it
   * should have reached. Every link was individually broken:
   *
   * - the brief's "61 photos" was not a shot noun, so no floor was read;
   * - the brief's "20-35 seconds" range was dropped whole, so no duration was read;
   * - with neither, the only checks that could fail were skipped;
   * - and `picture_present` passed on ten clips over a thirty-six-second programme.
   *
   * So the run reported `completed` over ten of sixty-one photos and twenty-six seconds
   * of black. This asserts the chain, not the links, because that is what failed.
   */
  const brief = [
    'I have provided **approximately 61 hiking photos**. Turn them into a montage.',
    '# FORMAT',
    'Create the final video for Instagram:',
    '**Aspect ratio:** 9:16 vertical',
    '**Frame rate:** 30fps',
    '**Resolution:** 1080 × 1920 or higher',
    '**Duration:** Approximately 20–35 seconds, depending on the selected music.',
    '# IMPORTANT. USE ALL PHOTOS INTELLIGENTLY',
    'Attempt to use **all approximately 61 hiking photos**.',
  ].join('\n\n');

  /** Ten photos over the first 10.008s; the music bed runs to 36.107s. */
  const whatItShipped = () =>
    withTracks(
      [
        {
          id: 'layer_video_2',
          type: 'video',
          clips: Array.from({ length: 10 }, (_, index) =>
            clip({
              id: `p_${String(index)}`,
              trackId: 'layer_video_2',
              start: index * 1.0008,
              end: (index + 1) * 1.0008,
            }),
          ),
        },
        {
          id: 'layer_audio_1',
          type: 'audio',
          clips: [
            clip({
              id: 'music',
              assetId: 'asset_music',
              trackId: 'layer_audio_1',
              start: 0,
              end: 36.107,
            }),
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

  it('reads the brief and fails what the run shipped against it', () => {
    const stated = explicitDurationTarget(brief);
    expect(stated).toEqual({ seconds: 27.5, toleranceSeconds: 7.5 });
    const acceptance = checkableAcceptance(brief, stated?.seconds);
    expect(acceptance.minShotCount).toBe(61);

    const report = critique(whatItShipped(), {
      request: brief,
      durationTargetSeconds: stated!.seconds,
      durationToleranceSeconds: stated!.toleranceSeconds,
      minShotCount: acceptance.minShotCount,
    });
    expect(report.ok).toBe(false);
    const failed = report.checks
      .filter((check) => check.status === 'fail')
      .map((check) => check.id);
    expect(failed).toContain('picture_coverage');
    expect(failed).toContain('shot_count');
    expect(failed).toContain('duration_target');
  });

  it('passes the same brief once the cut actually answers it', () => {
    // 61 photos filling the whole 36.107s bed, which is outside 20-35s — so the honest
    // answer is still a duration failure and nothing else. Proof the checks discriminate
    // rather than firing together on anything imperfect.
    const shots = 61;
    const project = withTracks(
      [
        {
          id: 'layer_video_2',
          type: 'video',
          clips: Array.from({ length: shots }, (_, index) =>
            clip({
              id: `p_${String(index)}`,
              trackId: 'layer_video_2',
              start: (index * 30) / shots,
              end: ((index + 1) * 30) / shots,
            }),
          ),
        },
        {
          id: 'layer_audio_1',
          type: 'audio',
          clips: [clip({ id: 'music', assetId: 'asset_music', trackId: 'layer_audio_1', end: 30 })],
        },
      ],
      {
        assets: [
          { id: 'asset_1', path: 'media/a.jpeg', kind: 'image', durationSeconds: 5 },
          { id: 'asset_music', path: 'media/m.mp3', kind: 'audio', durationSeconds: 47.8 },
        ] as Project['assets'],
      },
    );
    const report = critique(project, {
      request: brief,
      durationTargetSeconds: 27.5,
      durationToleranceSeconds: 7.5,
      minShotCount: 61,
    });
    expect(report.checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// goal.md Workstream A/D: verification judges the delta, not the absolute state.
describe('reconcileInheritedFailures', () => {
  type Check = CritiqueReport['checks'][number];
  const check = (id: Check['id'], status: Check['status'], detail: string): Check => ({
    id,
    label: id,
    status,
    detail,
  });
  const report = (checks: readonly Check[]): CritiqueReport => ({
    checks,
    ok: checks.every((c) => c.status !== 'fail'),
    summary: 'x',
  });

  it('a health check that failed identically before the run becomes an advisory', () => {
    const before = report([check('reframe_coverage', 'fail', '5 of 5 landscape')]);
    const after = report([check('reframe_coverage', 'fail', '5 of 5 landscape')]);
    const out = reconcileInheritedFailures(before, after);
    expect(out.ok).toBe(true);
    expect(out.checks[0]).toMatchObject({
      status: 'warn',
      detail: `${INHERITED_PREFIX}5 of 5 landscape`,
    });
    expect(out.summary).toBe('Passed with 1 warning(s) (1 inherited from the footage).');
  });

  it('a request-derived check is never inherited — the run was asked to change it', () => {
    const before = report([check('duration_target', 'fail', '136s vs 30s')]);
    const after = report([check('duration_target', 'fail', '136s vs 30s')]);
    const out = reconcileInheritedFailures(before, after);
    expect(out).toBe(after);
    expect(out.ok).toBe(false);
  });

  it("a health check whose reading changed is the edit's finding, not the footage's", () => {
    const before = report([check('reframe_coverage', 'fail', '5 of 5 landscape')]);
    const after = report([check('reframe_coverage', 'fail', '9 of 9 landscape')]);
    expect(reconcileInheritedFailures(before, after).ok).toBe(false);
  });

  it("a check that passed before and fails now is the edit's finding", () => {
    const before = report([check('picture_coverage', 'pass', 'covered')]);
    const after = report([check('picture_coverage', 'fail', '3.2s uncovered')]);
    expect(reconcileInheritedFailures(before, after).ok).toBe(false);
  });

  it('mixed: the summary counts remaining failures and the inherited advisory', () => {
    const before = report([
      check('reframe_coverage', 'fail', 'landscape'),
      check('picture_coverage', 'pass', 'covered'),
    ]);
    const after = report([
      check('reframe_coverage', 'fail', 'landscape'),
      check('picture_coverage', 'fail', '3.2s uncovered'),
    ]);
    const out = reconcileInheritedFailures(before, after);
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('1 check(s) failed, 1 warning(s) (1 inherited from the footage).');
  });
});

describe('detectTranscriptLoop — ASR hallucination, not speech', () => {
  /** `n` repeats of `phrase`, one word per `step` seconds, starting at `from`. */
  const repeated = (phrase: string, n: number, from = 0, step = 0.3) => {
    const parts = phrase.split(' ');
    const out: { word: string; start: number; end: number }[] = [];
    let t = from;
    for (let i = 0; i < n; i++) {
      for (const word of parts) {
        out.push({ word, start: t, end: t + step });
        t += step;
      }
    }
    return out;
  };

  it('flags a phrase looping over most of the recording', () => {
    // `mission-podcast`: real speech stops around 30s and whisper then emits one sentence
    // 397 times to 575s, with plausible timings, over quiet audio.
    const words = [
      ...repeated('meeting at the bottom of this cliff', 3),
      ...repeated("i'll try to follow you later", 200, 60),
    ];
    const loop = detectTranscriptLoop(words);
    expect(loop).toBeDefined();
    expect(loop?.repeats).toBe(200);
    expect(loop?.share).toBeGreaterThan(0.5);
  });

  it('leaves a real transcript alone', () => {
    expect(
      detectTranscriptLoop([
        ...repeated('the first thing to understand here', 1),
        ...repeated('and that changes how we think about it', 1, 10),
        ...repeated('so the answer is usually no', 1, 20),
      ]),
    ).toBeUndefined();
  });

  it('does not flag a chorus, which repeats without taking over', () => {
    // A refrain repeats often and still leaves most of the song to the verses. Both
    // conditions have to hold, which is what keeps a song, a chant or a drill out of this.
    const words = [
      ...repeated('some verse words that carry the song along here', 12),
      ...repeated('we will never stop', 9, 200),
      ...repeated('more verse words that carry the song along again', 12, 260),
    ];
    expect(detectTranscriptLoop(words)).toBeUndefined();
  });

  it('does not flag a phrase repeated only a few times', () => {
    expect(detectTranscriptLoop(repeated('say it again', 4))).toBeUndefined();
  });

  it('warns without failing the run — the edit may still be the best available', () => {
    const project = makeProject({
      transcript: repeated("i'll try to follow you later", 120),
    } as never);
    const report = critique(project, {});
    const found = report.checks.find((c) => c.id === 'transcript_reliable');
    expect(found).toMatchObject({ status: 'warn' });
    expect(found?.detail).toContain('do not select or cut on them');
    expect(report.ok).toBe(true);
  });
});
