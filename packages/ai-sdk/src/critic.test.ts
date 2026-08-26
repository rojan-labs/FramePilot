/**
 * Tests for the Critic / Review agent (PRD §8.6). The Critic is pure and
 * deterministic — every check is exercised across pass / warn / fail / skipped.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { CAPTION_ASSET_ID, TEXT_OVERLAY_ASSET_ID } from '@framepilot/editor-core';
import { critique, explicitDurationTargetSeconds, timelineDuration } from './critic.js';
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
    ]);
  });

  it('ok is false only when a check fails; warnings still pass', () => {
    const ok = critique(makeProject(), { producedChanges: true });
    expect(ok.ok).toBe(true);
    expect(ok.summary).toBe('All checks passed.');

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
