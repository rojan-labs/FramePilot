/**
 * Tests for auto-transcribe-on-import gating + apply. Fully offline: the trusted-host
 * `transcribe` call is injected, so no bridge/IPC is exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, TranscriptWord } from '@framepilot/timeline-schema';
import type { Patch } from '@framepilot/editor-core';
import type { TranscriptionResult } from '@framepilot/shared-types';
import { autoTranscribeImportedAssets, type AutoTranscribeInput } from './transcribeImport.js';
import { getTranscriptionJobsSnapshot, resetTranscriptionJobs } from './transcriptionJobs.js';

const video = (id: string): Asset => ({ id, kind: 'video', path: `${id}.mp4` });
const image = (id: string): Asset => ({ id, kind: 'image', path: `${id}.png` });
const words: readonly TranscriptWord[] = [
  { word: 'hello', start: 0, end: 0.4 },
  { word: 'world', start: 0.4, end: 0.9 },
];

function baseInput(overrides: Partial<AutoTranscribeInput> = {}): AutoTranscribeInput {
  return {
    assets: [video('a1')],
    assetIds: ['a1'],
    existingTranscriptWordCount: 0,
    enabled: true,
    provider: 'whisper-cli',
    ensureSaved: async () => '/projects/p.fp.json',
    applyPatchChecked: () => [],
    transcribe: async (): Promise<TranscriptionResult> => ({ ok: true, assetId: 'a1', words }),
    ...overrides,
  };
}

describe('autoTranscribeImportedAssets', () => {
  beforeEach(() => resetTranscriptionJobs());

  it('transcribes the first imported clip and applies a set_transcript patch when enabled', async () => {
    let appliedPatch: Patch | undefined;
    const applyPatchChecked = (patch: Patch): [] => {
      appliedPatch = patch;
      return [];
    };
    const transcribe = vi.fn(
      async (): Promise<TranscriptionResult> => ({ ok: true, assetId: 'a1', words }),
    );
    const applied = await autoTranscribeImportedAssets(
      baseInput({ applyPatchChecked, transcribe }),
    );
    expect(applied).toBe(words.length);
    expect(transcribe).toHaveBeenCalledWith({
      projectPath: '/projects/p.fp.json',
      assetId: 'a1',
      provider: 'whisper-cli',
    });
    expect(appliedPatch?.operations).toEqual([{ type: 'set_transcript', words }]);
  });

  it('does nothing when the mode is on-demand (disabled)', async () => {
    const transcribe = vi.fn();
    expect(
      await autoTranscribeImportedAssets(baseInput({ enabled: false, transcribe })),
    ).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('does not clobber an existing transcript', async () => {
    const transcribe = vi.fn();
    expect(
      await autoTranscribeImportedAssets(baseInput({ existingTranscriptWordCount: 5, transcribe })),
    ).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('is skipped in the browser (no ensureSaved)', async () => {
    const transcribe = vi.fn();
    const input = { ...baseInput({ transcribe }) };
    delete (input as { ensureSaved?: unknown }).ensureSaved;
    expect(await autoTranscribeImportedAssets(input)).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('ignores a migrated legacy provider without starting a background job', async () => {
    const ensureSaved = vi.fn(async () => '/projects/p.fp.json');
    const transcribe = vi.fn();

    expect(
      await autoTranscribeImportedAssets(
        baseInput({ provider: 'nvidia', ensureSaved, transcribe }),
      ),
    ).toBeUndefined();
    expect(ensureSaved).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(getTranscriptionJobsSnapshot().has('a1')).toBe(false);
  });

  it('skips when no imported asset is transcribable (images only)', async () => {
    const transcribe = vi.fn();
    expect(
      await autoTranscribeImportedAssets(
        baseInput({ assets: [image('a1')], assetIds: ['a1'], transcribe }),
      ),
    ).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('does not apply a patch when the provider is unavailable or returns no words', async () => {
    const applyPatchChecked = vi.fn(() => []);
    const unavailable = await autoTranscribeImportedAssets(
      baseInput({
        applyPatchChecked,
        transcribe: async () => ({ ok: false, error: 'model not installed', unavailable: true }),
      }),
    );
    expect(unavailable).toBeUndefined();
    const empty = await autoTranscribeImportedAssets(
      baseInput({
        applyPatchChecked,
        transcribe: async () => ({ ok: true, assetId: 'a1', words: [] }),
      }),
    );
    expect(empty).toBeUndefined();
    expect(applyPatchChecked).not.toHaveBeenCalled();
  });

  it('picks the first transcribable asset when a batch mixes images and video', async () => {
    const transcribe = vi.fn(
      async (): Promise<TranscriptionResult> => ({ ok: true, assetId: 'v1', words }),
    );
    await autoTranscribeImportedAssets(
      baseInput({
        assets: [image('i1'), video('v1'), video('v2')],
        assetIds: ['i1', 'v1', 'v2'],
        transcribe,
      }),
    );
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'v1' }));
  });

  it('publishes a running job while automatic transcription is in flight', async () => {
    let resolveResult: ((result: TranscriptionResult) => void) | undefined;
    const pending = new Promise<TranscriptionResult>((resolve) => {
      resolveResult = resolve;
    });
    const run = autoTranscribeImportedAssets(baseInput({ transcribe: () => pending }));

    expect(getTranscriptionJobsSnapshot().get('a1')).toMatchObject({
      kind: 'running',
      provider: 'whisper-cli',
    });
    resolveResult?.({ ok: true, assetId: 'a1', words });
    await run;
    expect(getTranscriptionJobsSnapshot().has('a1')).toBe(false);
  });
});
