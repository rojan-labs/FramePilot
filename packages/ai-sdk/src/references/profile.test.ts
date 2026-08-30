import { describe, expect, it } from 'vitest';
import { buildReferenceProfile, renderConstraints, summarizeReferences } from './profile.js';

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

describe('renderConstraints', () => {
  it('turns a fast-cut vertical reel into editor-vocabulary lines', () => {
    const lines = renderConstraints({
      role: 'style',
      kind: 'video',
      fileName: 'ref.mp4',
      video: fastCut,
    });
    expect(lines).toContain('Pacing: fast — median shot 1.1s (most shots 0.6–2.4s), 51 cuts/min');
    expect(lines).toContain('Music: about 128 BPM with a clear beat');
    expect(lines).toContain('Visual-led: little or no speech');
    expect(lines).toContain('Frame: portrait 1080×1920');
    expect(lines).toContain('Look: warm, saturated, high-contrast');
    expect(lines.at(-1)).toMatch(/^Apply: match pacing and look/);
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  it('says so when a video is one continuous take', () => {
    const lines = renderConstraints({
      role: 'pacing',
      kind: 'video',
      fileName: 'a.mov',
      video: { durationS: 21.6, shotCount: 1 },
    });
    expect(lines[0]).toBe('Pacing: one continuous take over 21.6s — no cuts to match');
  });

  it('describes images by role', () => {
    const logo = renderConstraints({
      role: 'brand-logo',
      kind: 'image',
      fileName: 'logo.png',
      image: { width: 512, height: 512, hasAlpha: true },
    });
    expect(logo[0]).toBe('Image: 512×512, transparent background');
    expect(logo.at(-1)).toMatch(/place as an overlay/);
    const mood = renderConstraints({
      role: 'color',
      kind: 'image',
      fileName: 'm.jpg',
      image: {
        width: 1200,
        height: 800,
        dominantColors: ['#a0522d', '#f4e1c1'],
        color: { temperature: -0.3, saturation: 0.1 },
      },
    });
    expect(mood).toContain('Palette: #a0522d #f4e1c1');
    expect(mood).toContain('Look: cool, desaturated');
  });
});

describe('buildReferenceProfile / summarizeReferences', () => {
  it('derives constraints, validates the shape, and renders the context block', () => {
    const p = buildReferenceProfile({
      id: 'ref_1',
      role: 'style',
      kind: 'video',
      fileName: 'ref.mp4',
      contentHash: 'abcdef0123456789',
      analyzedAt: '2026-08-29T00:00:00Z',
      video: fastCut,
    });
    expect(p.constraints.length).toBeGreaterThan(3);
    const block = summarizeReferences([p]);
    expect(block).toContain('- ref_1 · ref.mp4 · style');
    expect(block).toContain('  Music: about 128 BPM');
    expect(summarizeReferences([])).toBe('');
  });

  it('hands the model the derived targets and tells the plan to cite them (P4.2)', () => {
    const reel = buildReferenceProfile({
      id: 'ref_1',
      role: 'pacing',
      kind: 'video',
      fileName: 'ref.mp4',
      contentHash: 'abcdef0123456789',
      analyzedAt: '2026-08-29T00:00:00Z',
      video: fastCut,
    });
    const logo = buildReferenceProfile({
      id: 'ref_2',
      role: 'brand-logo',
      kind: 'image',
      fileName: 'logo.png',
      contentHash: 'abcdef0123456789',
      analyzedAt: '2026-08-29T00:00:00Z',
      image: { width: 512, height: 512, hasAlpha: true },
    });
    const block = summarizeReferences([reel, logo]);
    expect(block).toContain('Targets taken from those measurements:');
    expect(block).toContain('aim for a median of 1.1s per picture clip');
    // The measured reference this product has no route for is named as NOT applied rather
    // than quietly dropped — the whole point of P4.2's "and which it is ignoring, with a
    // reason".
    expect(block).toContain('- NOT applied — ref_2 (brand-logo):');
    expect(block.trimEnd().endsWith('say which listed lines you are not applying and why.')).toBe(
      true,
    );
  });

  it('still asks for citations when nothing numeric was measured', () => {
    const held = buildReferenceProfile({
      id: 'ref_1',
      role: 'style',
      kind: 'video',
      fileName: 'a.mov',
      contentHash: 'abcdef0123456789',
      analyzedAt: 't',
      video: { durationS: 21.6, shotCount: 1 },
    });
    const block = summarizeReferences([held]);
    expect(block).not.toContain('Targets taken from those measurements:');
    expect(block).toContain('Measured but not driving anything:');
    expect(block).toContain('- NOT applied — ref_1 (style): one continuous take');
    expect(block).toContain('In your plan, name the reference id');
  });

  it('rejects an oversized constraint list at the boundary', () => {
    expect(() =>
      buildReferenceProfile({
        id: 'x',
        role: 'style',
        kind: 'image',
        fileName: 'a.png',
        contentHash: 'short',
        analyzedAt: 't',
      }),
    ).toThrow();
  });
});
