/** Schema v19 project pins for immutable on-demand Capability Pack releases. */
import { describe, expect, it } from 'vitest';
import { CapabilityPackPinSchema, parseProject } from './index.js';

const digest = 'a'.repeat(64);

const pin = {
  id: 'framepilot.subject-intelligence',
  version: '1.2.0',
  releaseDigest: digest,
  capabilities: ['tracking.face', 'tracking.segmentation'],
  requiredFor: 'analysis' as const,
};

describe('CapabilityPackPinSchema', () => {
  it('accepts a platform-neutral immutable logical release pin', () => {
    expect(CapabilityPackPinSchema.parse(pin)).toEqual(pin);
  });

  it.each([
    ['invalid id', { ...pin, id: '../escape' }],
    ['invalid semantic version', { ...pin, version: 'latest' }],
    ['invalid release digest', { ...pin, releaseDigest: 'short' }],
    ['empty capability roster', { ...pin, capabilities: [] }],
    ['unknown dependency role', { ...pin, requiredFor: 'preview' }],
  ])('rejects %s', (_label, candidate) => {
    expect(CapabilityPackPinSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects duplicate pack ids in one project even when versions differ', () => {
    const project = {
      id: 'p',
      name: 'Pinned',
      version: 1,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      timeline: { tracks: [] },
      capabilityPacks: [pin, { ...pin, version: '1.3.0', releaseDigest: 'b'.repeat(64) }],
    };
    expect(() => parseProject(project)).toThrow(/pack ids must be unique/);
  });

  it('keeps projects without pack usage backward compatible', () => {
    const project = parseProject({
      id: 'p',
      name: 'No packs',
      version: 1,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      timeline: { tracks: [] },
    });
    expect(project.capabilityPacks).toBeUndefined();
  });
});
