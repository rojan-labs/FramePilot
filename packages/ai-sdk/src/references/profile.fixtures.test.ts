/**
 * The profile builder against REAL engine measurements (plan/system-mission P3.3).
 *
 * `profile.test.ts` holds the builder to hand-written numbers, which is the right way to
 * test a branch. This file holds it to what the engine actually produced for the mission's
 * reference fixtures — `tests/fixtures/mission/ref/` — so a change to either side of the
 * contract shows up as a diff in a committed profile rather than as a surprise in a
 * desktop run.
 *
 * The media is never committed (it is the maintainer's, and gigabytes of it), so what is
 * committed is the sidecar's payload for each file. Regenerate after changing
 * `engine/python/framepilot_engine/analysis/reference.py`:
 *
 * ```
 * cd engine/python && uv run python -c "
 * import json; from pathlib import Path
 * from framepilot_engine.analysis.reference import (analyze_reference_video,
 *     analyze_reference_image, analysis_to_dict)
 * root = Path('../../tests/fixtures/mission/ref')
 * print(json.dumps({n: analysis_to_dict(analyze_reference_video(root / n, timeout=600))
 *                   for n in ['fast-cut-vertical.mp4']}, indent=2))"
 * ```
 */
import { describe, expect, it } from 'vitest';
import measured from './__fixtures__/mission-ref-analysis.json' with { type: 'json' };
import { buildReferenceProfile, type ReferenceProfile } from './profile.js';
import type { ReferenceRole } from './role.js';

type MeasuredEntry = { readonly kind: 'video' | 'image'; readonly video?: unknown; image?: unknown };

const analyses = measured as unknown as Record<string, MeasuredEntry>;

function profileFor(fileName: string, role: ReferenceRole): ReferenceProfile {
  const entry = analyses[fileName];
  if (!entry) throw new Error(`No measured fixture for ${fileName}`);
  return buildReferenceProfile({
    id: `ref_${fileName.replace(/\W+/g, '_')}`,
    role,
    kind: entry.kind,
    fileName,
    // Fixed so the snapshot is about the measurements, not about when they were taken.
    contentHash: `hash_${fileName}`,
    analyzedAt: '2026-08-29T00:00:00.000Z',
    ...(entry.video ? { video: entry.video as ReferenceProfile['video'] } : {}),
    ...(entry.image ? { image: entry.image as ReferenceProfile['image'] } : {}),
  });
}

describe('profiles built from the real mission fixtures', () => {
  it('reads fast-cut-vertical.mp4 as a fast reel with a beat', () => {
    const profile = profileFor('fast-cut-vertical.mp4', 'pacing');
    // Every line is a measurement stated the way an editor would say it — no adjective
    // the numbers do not carry, and no number without its unit.
    expect(profile.constraints).toEqual([
      'Pacing: rapid-fire — median shot 0.9s (most shots 0.6–0.9s), 72 cuts/min',
      'Music: about 86 BPM with a clear beat',
      'Dialogue-led: speech covers most of the runtime',
      'Frame: portrait 1080×1920',
      'Look: neutral, desaturated',
      'Apply: match the shot-length range above; do not copy content',
    ]);
    expect(profile).toMatchSnapshot();
  });

  it('reads slow-cinematic-4k.mov as one held take, with no pace to match', () => {
    const profile = profileFor('slow-cinematic-4k.mov', 'style');
    // The honest answer for a single-shot reference: it cannot supply a cut rhythm, and
    // saying so beats inventing one from a 21s "median shot".
    expect(profile.constraints[0]).toBe(
      'Pacing: one continuous take over 21.6s — no cuts to match',
    );
    expect(profile.constraints).toContain('Frame: landscape 3840×2160');
    expect(profile).toMatchSnapshot();
  });

  it('reads caption-talk.mp4 as a flat, near-monochrome talking head', () => {
    const profile = profileFor('caption-talk.mp4', 'caption-style');
    expect(profile.constraints).toContain('Look: neutral, desaturated, high-contrast');
    // No audio measurement survived, so no BPM and no speech line are asserted — a field
    // the analysis could not produce must not appear as a constraint.
    expect(profile.constraints.some((line) => line.startsWith('Music:'))).toBe(false);
    expect(profile).toMatchSnapshot();
  });

  it('reads logo.png as an image with a palette and an overlay instruction', () => {
    const profile = profileFor('logo.png', 'brand-logo');
    expect(profile.constraints[0]).toBe('Image: 1254×1254');
    expect(profile.constraints).toContain('Palette: #f1f0e9 #422e24 #120905 #a89784');
    expect(profile.constraints.at(-1)).toMatch(/^Apply: place as an overlay/);
    expect(profile).toMatchSnapshot();
  });

  it('reads colorchart.png as a dark, flat grade target', () => {
    const profile = profileFor('colorchart.png', 'color');
    expect(profile.constraints).toContain('Image: 607×403, transparent background');
    // −0.14 is inside the ±0.15 neutral band, so the line says "neutral" and not "cool".
    // The threshold is what keeps a look word from being asserted off a measurement that
    // barely moved — an editor told "cool" would go looking for a cast that is not there.
    expect(profile.constraints).toContain('Look: neutral, desaturated, flat, low-contrast, dark');
    expect(profile.constraints.at(-1)).toMatch(/^Apply: grade toward this look/);
    expect(profile).toMatchSnapshot();
  });

  it('never exceeds the twelve lines the model is promised', () => {
    for (const fileName of Object.keys(analyses)) {
      if (fileName.startsWith('_')) continue;
      const profile = profileFor(fileName, 'style');
      expect(profile.constraints.length).toBeLessThanOrEqual(12);
    }
  });
});
