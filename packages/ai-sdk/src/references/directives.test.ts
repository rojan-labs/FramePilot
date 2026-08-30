import { describe, expect, it } from 'vitest';
import { buildReferenceProfile, type ReferenceProfile } from './profile.js';
import {
  hasReferenceDirectives,
  referenceDecisions,
  referenceDirectives,
  renderDirectives,
  renderIgnoredReferences,
  shotLengthTolerance,
} from './directives.js';
import type { ReferenceRole } from './role.js';

const fastCut = {
  durationS: 20,
  fps: 30,
  width: 1080,
  height: 1920,
  shotCount: 18,
  medianShotS: 1.1,
  shotLengthP10S: 0.6,
  shotLengthP90S: 2.4,
  cutsPerMinute: 51,
  music: { bpm: 128, beatCount: 42 },
  speechShare: 0.05,
  color: { brightness: 0.55, contrast: 0.31, saturation: 0.58, temperature: 0.3 },
};

function video(role: ReferenceRole, id = 'ref_1', over = {}): ReferenceProfile {
  return buildReferenceProfile({
    id,
    role,
    kind: 'video',
    fileName: `${id}.mp4`,
    contentHash: 'abcdef0123456789',
    analyzedAt: '2026-08-29T00:00:00Z',
    video: { ...fastCut, ...over },
  });
}

function image(role: ReferenceRole, id = 'ref_2'): ReferenceProfile {
  return buildReferenceProfile({
    id,
    role,
    kind: 'image',
    fileName: `${id}.png`,
    contentHash: 'abcdef0123456789',
    analyzedAt: '2026-08-29T00:00:00Z',
    image: { width: 512, height: 512, hasAlpha: true },
  });
}

describe('referenceDirectives', () => {
  it('turns a measured style reel into the numbers the run is graded on', () => {
    const directives = referenceDirectives([video('style')]);
    expect(directives.medianShotSeconds).toBe(1.1);
    expect(directives.shotLengthRangeSeconds).toEqual([0.6, 2.4]);
    expect(directives.bpm).toBe(128);
    expect(directives.gradeTarget).toEqual({
      brightness: 0.55,
      contrast: 0.31,
      saturation: 0.58,
      temperature: 0.3,
    });
    expect(hasReferenceDirectives(directives)).toBe(true);
    expect(directives.ignored).toEqual([]);
    // Citations are the profile's own constraint lines, so the plan cites what the
    // sidebar shows rather than a paraphrase of it.
    expect(directives.applied.map((c) => c.line)).toEqual([
      'Pacing: fast — median shot 1.1s (most shots 0.6–2.4s), 51 cuts/min',
      'Music: about 128 BPM with a clear beat',
      'Look: warm, saturated, high-contrast',
    ]);
  });

  it('names what it ignores and why, rather than dropping it in silence', () => {
    const directives = referenceDirectives([image('brand-logo'), image('b-roll', 'ref_3')]);
    expect(hasReferenceDirectives(directives)).toBe(false);
    expect(directives.ignored).toEqual([
      {
        profileId: 'ref_2',
        role: 'brand-logo',
        reason:
          'no route places an overlay from a reference file — import the logo into the media bin and ask for it by name',
      },
      {
        profileId: 'ref_3',
        role: 'b-roll',
        reason:
          'a reference is not a project asset — import the clip into the media bin to cut with it',
      },
    ]);
  });

  it('takes no pacing target from a single continuous take, and says which', () => {
    const held = video('pacing', 'ref_9', {
      shotCount: 1,
      medianShotS: undefined,
      music: undefined,
      color: undefined,
    });
    const directives = referenceDirectives([held]);
    expect(directives.medianShotSeconds).toBeUndefined();
    expect(directives.ignored[0]?.reason).toBe(
      'one continuous take — there is no shot-length target in it',
    );
  });

  it('lets the first reference win and says the second set nothing', () => {
    const directives = referenceDirectives([video('pacing', 'ref_1'), video('pacing', 'ref_2')]);
    expect(directives.medianShotSeconds).toBe(1.1);
    expect(directives.ignored).toEqual([
      {
        profileId: 'ref_2',
        role: 'pacing',
        reason: 'another reference already sets every target this one could',
      },
    ]);
  });

  it('reads a colour target off a colour still even with no video anywhere', () => {
    const mood = buildReferenceProfile({
      id: 'ref_c',
      role: 'color',
      kind: 'image',
      fileName: 'mood.jpg',
      contentHash: 'abcdef0123456789',
      analyzedAt: 't',
      image: { width: 1200, height: 800, color: { temperature: -0.3, saturation: 0.1 } },
    });
    const directives = referenceDirectives([mood]);
    expect(directives.gradeTarget).toEqual({ saturation: 0.1, temperature: -0.3 });
  });

  it('ignores a colour role whose analysis measured no colour at all', () => {
    const blank = buildReferenceProfile({
      id: 'ref_b',
      role: 'color',
      kind: 'image',
      fileName: 'blank.png',
      contentHash: 'abcdef0123456789',
      analyzedAt: 't',
      image: { width: 10, height: 10 },
    });
    const directives = referenceDirectives([blank]);
    expect(directives.gradeTarget).toBeUndefined();
    expect(directives.ignored[0]?.reason).toBe('the analysis measured nothing this role can drive');
  });
});

describe('shotLengthTolerance', () => {
  it('is undefined without a target', () => {
    expect(shotLengthTolerance(referenceDirectives([]))).toBeUndefined();
  });

  it("uses the reference's own spread when it is wider than the proportional band", () => {
    // p90 2.4 is 1.3s above the 1.1s median — wider than 40% of 1.1 and than the 0.5s floor.
    expect(shotLengthTolerance(referenceDirectives([video('style')]))).toBeCloseTo(1.3, 6);
  });

  it('falls back to the floor for a reference with no measured spread', () => {
    const noSpread = video('pacing', 'ref_1', {
      shotLengthP10S: undefined,
      shotLengthP90S: undefined,
    });
    expect(shotLengthTolerance(referenceDirectives([noSpread]))).toBe(0.5);
  });

  it('scales with a slow reference', () => {
    const slow = video('pacing', 'ref_1', {
      medianShotS: 6,
      shotLengthP10S: undefined,
      shotLengthP90S: undefined,
    });
    expect(shotLengthTolerance(referenceDirectives([slow]))).toBeCloseTo(2.4, 6);
  });
});

describe('renderDirectives', () => {
  it('states the numbers once and marks the checked one as checked', () => {
    const text = renderDirectives(referenceDirectives([video('style'), image('brand-logo')]));
    expect(text).toContain(
      '- Shot length: aim for a median of 1.1s per picture clip (the reference runs 0.6–2.4s). This is checked.',
    );
    expect(text).toContain('- Tempo: the reference sits at about 128 BPM.');
    expect(text).toContain(
      '- Grade target (0..1 measured): temperature 0.30, contrast 0.31, saturation 0.58, brightness 0.55.',
    );
    expect(text).not.toContain('NOT applied');
  });

  it('renders the not-applied list under its own heading', () => {
    const directives = referenceDirectives([video('style'), image('brand-logo')]);
    expect(renderIgnoredReferences(directives)).toBe(
      '- NOT applied — ref_2 (brand-logo): no route places an overlay from a reference file — ' +
        'import the logo into the media bin and ask for it by name.',
    );
    expect(renderIgnoredReferences(referenceDirectives([video('style')]))).toBe('');
  });

  it('is empty when nothing was measured', () => {
    expect(renderDirectives(referenceDirectives([]))).toBe('');
  });

  it('omits a grade line when the target carries no channel', () => {
    const noColor = video('style', 'ref_1', { color: {} });
    expect(renderDirectives(referenceDirectives([noColor]))).not.toContain('Grade target');
  });
});

describe('referenceDecisions', () => {
  it('carries the measured line verbatim inside the decision text', () => {
    const decisions = referenceDecisions([video('pacing')]);
    expect(decisions).toEqual([
      {
        subject: 'ref_1',
        decision:
          'Match reference ref_1 (pacing) — Pacing: fast — median shot 1.1s (most shots 0.6–2.4s), 51 cuts/min',
        reconsiderIf: 'the editor removes reference ref_1 or asks for something different',
      },
      {
        subject: 'ref_1',
        decision: 'Match reference ref_1 (pacing) — Music: about 128 BPM with a clear beat',
        reconsiderIf: 'the editor removes reference ref_1 or asks for something different',
      },
    ]);
  });

  it('commits to nothing when nothing is applied', () => {
    expect(referenceDecisions([image('thumbnail')])).toEqual([]);
  });
});
