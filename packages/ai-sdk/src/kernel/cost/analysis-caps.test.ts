/**
 * Tests for the per-run analysis budget (plan B5.4). Pure arithmetic + charge derivation
 * are exhaustively covered (100%-coverage core); the stateful wrapper is exercised through
 * its check/record surface.
 */
import { describe, expect, it } from 'vitest';
import {
  type AnalysisCharge,
  DEFAULT_ANALYSIS_CAPS,
  addCharge,
  createAnalysisBudget,
  decideCharge,
  describeAnalysisSpend,
  emptyAnalysisSpend,
  outcomeCharge,
  preflightCharge,
} from './analysis-caps.js';

const CAPS = { maxFfmpegSeconds: 100, maxTranscriptionMinutes: 5 };

describe('decideCharge', () => {
  it('allows a charge that fits under the cap', () => {
    const spend = { ffmpegSeconds: 3, transcriptionMinutes: 0 };
    expect(decideCharge(CAPS, spend, { resource: 'ffmpegSeconds', amount: 7 })).toEqual({
      allowed: true,
    });
  });

  it('denies a charge that would exceed the cap, naming the resource and totals', () => {
    const spend = { ffmpegSeconds: 98, transcriptionMinutes: 0 };
    const decision = decideCharge(CAPS, spend, { resource: 'ffmpegSeconds', amount: 5 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('98/100 s ffmpeg');
      expect(decision.reason).toContain('needs 5 more');
      expect(decision.reason).toContain('B5.4');
    }
  });

  it('allows a zero-amount charge while under the cap but denies it once reached', () => {
    const under = { ffmpegSeconds: 99, transcriptionMinutes: 0 };
    expect(decideCharge(CAPS, under, { resource: 'ffmpegSeconds', amount: 0 })).toEqual({
      allowed: true,
    });
    const reached = { ffmpegSeconds: 100, transcriptionMinutes: 0 };
    const decision = decideCharge(CAPS, reached, { resource: 'ffmpegSeconds', amount: 0 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).not.toContain('needs');
  });

  it('covers each resource axis with its own unit label', () => {
    const spend = { ffmpegSeconds: 200, transcriptionMinutes: 10 };
    const ff = decideCharge(CAPS, spend, { resource: 'ffmpegSeconds', amount: 1 });
    const tx = decideCharge(CAPS, spend, { resource: 'transcriptionMinutes', amount: 1 });
    expect(ff.allowed).toBe(false);
    expect(tx.allowed).toBe(false);
    if (!ff.allowed) expect(ff.reason).toContain('s ffmpeg');
    if (!tx.allowed) expect(tx.reason).toContain('min transcribed');
  });
});

describe('addCharge', () => {
  it('folds a charge into the right axis, leaving others untouched', () => {
    const spend = addCharge(emptyAnalysisSpend(), { resource: 'ffmpegSeconds', amount: 4 });
    expect(spend).toEqual({ ffmpegSeconds: 4, transcriptionMinutes: 0 });
    const both = addCharge(spend, { resource: 'transcriptionMinutes', amount: 2 });
    expect(both).toEqual({ ffmpegSeconds: 4, transcriptionMinutes: 2 });
  });
});

describe('preflightCharge', () => {
  it('returns null because no analysis tool has a caller-known capped size', () => {
    expect(preflightCharge({ name: 'search_media', arguments: { query: 'x' } })).toBeNull();
  });
});

describe('outcomeCharge', () => {
  it('charges transcription minutes from the last word end', () => {
    expect(outcomeCharge('transcribe', { words: [{ end: 30 }, { end: 90 }] })).toEqual({
      resource: 'transcriptionMinutes',
      amount: 1.5,
    });
  });

  it('returns null for an empty transcript or an uncapped tool', () => {
    expect(outcomeCharge('transcribe', { words: [] })).toBeNull();
    expect(outcomeCharge('detect_scenes', { cuts: [] })).toBeNull();
  });

  it('treats a word with no numeric end as zero duration', () => {
    expect(outcomeCharge('transcription', { words: [{ start: 1 }] })).toEqual({
      resource: 'transcriptionMinutes',
      amount: 0,
    });
  });
});

describe('createAnalysisBudget', () => {
  it('applies partial cap overrides on top of the defaults', () => {
    const budget = createAnalysisBudget({ maxFfmpegSeconds: 2 });
    expect(budget.caps.maxFfmpegSeconds).toBe(2);
    expect(budget.caps.maxTranscriptionMinutes).toBe(DEFAULT_ANALYSIS_CAPS.maxTranscriptionMinutes);
  });

  it('check is pure; record advances spend and blocks once the cap is hit', () => {
    const budget = createAnalysisBudget({ maxFfmpegSeconds: 3 });
    const charge: AnalysisCharge = { resource: 'ffmpegSeconds', amount: 2 };
    expect(budget.check(charge).allowed).toBe(true);
    // check did not mutate — still zero spent.
    expect(budget.spend().ffmpegSeconds).toBe(0);
    budget.record(charge);
    expect(budget.spend().ffmpegSeconds).toBe(2);
    // A second 2-frame charge would exceed the cap of 3.
    expect(budget.check(charge).allowed).toBe(false);
  });

  it('record ignores non-positive charges', () => {
    const budget = createAnalysisBudget();
    budget.record({ resource: 'ffmpegSeconds', amount: -5 });
    expect(budget.spend()).toEqual(emptyAnalysisSpend());
  });
});

describe('describeAnalysisSpend', () => {
  it('lists only the axes actually used', () => {
    expect(describeAnalysisSpend({ ffmpegSeconds: 34.6, transcriptionMinutes: 2.05 })).toBe(
      '35s ffmpeg · 2.1 min transcribed',
    );
  });

  it('reports "no analysis" for an all-zero run', () => {
    expect(describeAnalysisSpend(emptyAnalysisSpend())).toBe('no analysis');
  });
});
