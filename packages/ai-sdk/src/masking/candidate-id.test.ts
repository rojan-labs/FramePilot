import { describe, expect, it } from 'vitest';
import { MaskCandidateIdSchema } from './contracts.js';
import {
  candidateIdFor,
  candidateIdMatches,
  candidateIdsIn,
  parseCandidateId,
  requirePick,
} from './candidate-id.js';

const face = {
  assetId: 'asset_1',
  frame: 48,
  label: 'face',
  box: { x: 0.4, y: 0.2, width: 0.1, height: 0.2 },
} as const;

describe('candidate ids', () => {
  it('is a pure function of the measurement, so a recalled id resolves after the payload is gone', () => {
    expect(candidateIdFor(face)).toBe(candidateIdFor({ ...face }));
    expect(candidateIdFor(face)).toMatch(/^f48_[0-9a-f]{8}$/);
    expect(MaskCandidateIdSchema.safeParse(candidateIdFor(face)).success).toBe(true);
    expect(MaskCandidateIdSchema.safeParse(requirePick(candidateIdFor(face))).success).toBe(true);
  });

  it('survives sub-quantum detector jitter and changes with anything that matters', () => {
    const id = candidateIdFor(face);
    expect(candidateIdFor({ ...face, box: { ...face.box, x: 0.4002 } })).toBe(id);
    expect(candidateIdFor({ ...face, box: { ...face.box, x: 0.41 } })).not.toBe(id);
    expect(candidateIdFor({ ...face, frame: 49 })).not.toBe(id);
    expect(candidateIdFor({ ...face, assetId: 'asset_2' })).not.toBe(id);
    expect(candidateIdFor({ ...face, label: 'person' })).not.toBe(id);
  });

  it('says which frame to re-detect and whether the editor must confirm', () => {
    const id = candidateIdFor(face);
    expect(parseCandidateId(id)).toEqual({
      label: 'face',
      frame: 48,
      pickRequired: false,
      bareId: id,
    });
    expect(parseCandidateId(requirePick(id))).toMatchObject({
      label: 'face',
      frame: 48,
      pickRequired: true,
    });
    expect(requirePick(requirePick(id))).toBe(requirePick(id));
  });

  it('cannot be turned into a usable plain id by dropping the pick marker (AM5.3)', () => {
    const id = candidateIdFor(face);
    const pick = requirePick(id);
    const stripped = pick.slice('pick.'.length);
    expect(stripped).not.toBe(id);
    expect(parseCandidateId(stripped)?.pickRequired).toBe(false);
    expect(candidateIdMatches(stripped, id)).toBe(false);
    expect(candidateIdMatches(pick, id)).toBe(true);
    expect(candidateIdMatches(id, id)).toBe(true);
    expect(candidateIdMatches(requirePick(candidateIdFor({ ...face, frame: 49 })), id)).toBe(false);
  });

  it('refuses an id it did not mint', () => {
    for (const invented of ['face_1', 'f48', 'x48_0011aabb', 'f48_zzzzzzzz', 'pick.', '']) {
      expect(parseCandidateId(invented)).toBeNull();
    }
  });

  it('finds the ids the picker wrote into the editor’s message', () => {
    const id = requirePick(candidateIdFor(face));
    expect(candidateIdsIn(`Use ${id} — the face on the left — on clip shot.`)).toEqual([id]);
    expect(candidateIdsIn('blur the face on the left')).toEqual([]);
  });
});
