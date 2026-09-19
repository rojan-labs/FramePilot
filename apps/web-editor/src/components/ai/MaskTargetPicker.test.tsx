import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { candidateIdsIn } from '@framepilot/ai-sdk';
import {
  MaskTargetPicker,
  maskTargetChoice,
  pickMessage,
  positionWords,
} from './MaskTargetPicker.js';
import { cropRect } from './useCandidateThumbnail.js';

const face = (candidateId: string, x: number) => ({
  candidateId,
  label: 'face',
  score: 0.9,
  box: { x, y: 0.2, width: 0.1, height: 0.2 },
  sourceTime: 2,
  persistence: 1,
});

const LEFT = face('pick.f48_aaaaaaaa', 0.1);
const RIGHT = face('pick.f48_bbbbbbbb', 0.75);

const result = (status: string, candidates: unknown[] = [LEFT, RIGHT]) => ({
  kind: 'mask_targets',
  clipId: 'shot',
  description: 'blur the face',
  status,
  candidates,
  chosenCandidateIds: [],
  reranker: 'none',
  engine: 'pack@1',
});

describe('maskTargetChoice', () => {
  it('reads a result that is asking, and nothing else', () => {
    expect(maskTargetChoice(result('ambiguous_target'))?.candidates).toHaveLength(2);
    expect(maskTargetChoice(result('needs_click', []))?.status).toBe('needs_click');
    expect(maskTargetChoice(result('resolved'))).toBeNull();
    expect(maskTargetChoice(result('no_candidates', []))).toBeNull();
    expect(maskTargetChoice({ code: 'pack_missing' })).toBeNull();
    expect(maskTargetChoice(null)).toBeNull();
  });

  it('drops a malformed candidate rather than offering a broken choice', () => {
    const choice = maskTargetChoice(
      result('ambiguous_target', [LEFT, { candidateId: 'x' }, { ...RIGHT, box: { x: 4 } }]),
    );
    expect(choice?.candidates.map((candidate) => candidate.candidateId)).toEqual([
      LEFT.candidateId,
    ]);
  });
});

describe('the message a pick sends', () => {
  it('carries the id create_mask looks for, and words a person can read', () => {
    const choice = maskTargetChoice(result('ambiguous_target'))!;
    const message = pickMessage(choice, [choice.candidates[0]!]);
    expect(candidateIdsIn(message)).toEqual([LEFT.candidateId]);
    expect(message).toBe(
      'For "blur the face" on clip shot, use pick.f48_aaaaaaaa (the face at the top left).',
    );
    expect(candidateIdsIn(pickMessage(choice, choice.candidates))).toEqual([
      LEFT.candidateId,
      RIGHT.candidateId,
    ]);
  });

  it('describes position the way an editor would', () => {
    expect(positionWords({ x: 0.45, y: 0.45, width: 0.1, height: 0.1 })).toBe('centre');
    expect(positionWords({ x: 0.8, y: 0.8, width: 0.1, height: 0.1 })).toBe('bottom right');
  });
});

describe('MaskTargetPicker', () => {
  it('sends the pick with one click, and is usable without a decodable thumbnail', () => {
    const onPick = vi.fn();
    render(
      <MaskTargetPicker choice={maskTargetChoice(result('ambiguous_target'))!} onPick={onPick} />,
    );
    expect(screen.getByText('Which one did you mean?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pick the face at the top right' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(candidateIdsIn(onPick.mock.calls[0]![0] as string)).toEqual([RIGHT.candidateId]);
  });

  it('collects several faces for an identity question before sending anything', () => {
    const onPick = vi.fn();
    render(
      <MaskTargetPicker
        choice={maskTargetChoice(result('needs_face_selection'))!}
        onPick={onPick}
      />,
    );
    const use = screen.getByRole('button', { name: 'Use selected' }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pick the face at the top left' }));
    expect(onPick).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole('button', { name: 'Pick the face at the top left' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(use);
    expect(candidateIdsIn(onPick.mock.calls[0]![0] as string)).toEqual([LEFT.candidateId]);
  });

  it('waits for the run that asked to end, and says so', () => {
    const onPick = vi.fn();
    render(
      <MaskTargetPicker
        choice={maskTargetChoice(result('ambiguous_target'))!}
        onPick={onPick}
        disabled
      />,
    );
    const option = screen.getByRole('button', {
      name: 'Pick the face at the top left',
    }) as HTMLButtonElement;
    expect(option.disabled).toBe(true);
    expect(screen.getByText(/as soon as the assistant finishes/)).toBeTruthy();
  });

  it('sends an out-of-vocabulary target to a click, with no candidates to choose from', () => {
    const onOpen = vi.fn();
    render(
      <MaskTargetPicker
        choice={maskTargetChoice({ ...result('needs_click', []), description: 'the sky' })!}
        onOpenMaskTools={onOpen}
      />,
    );
    expect(screen.getByRole('group', { name: 'click the target' }).textContent).toContain(
      'the sky',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select the clip' }));
    expect(onOpen).toHaveBeenCalledWith('shot');
  });
});

describe('cropRect', () => {
  it('pads the box for context and never leaves the frame', () => {
    const rect = cropRect({ x: 0.4, y: 0.2, width: 0.1, height: 0.2 }, 1000, 1000);
    expect(rect.x).toBeCloseTo(365);
    expect(rect.width).toBeCloseTo(170);
    const edge = cropRect({ x: 0.95, y: 0, width: 0.05, height: 0.05 }, 1000, 1000);
    expect(edge.x + edge.width).toBeLessThanOrEqual(1000);
    expect(edge.y).toBe(0);
  });
});
