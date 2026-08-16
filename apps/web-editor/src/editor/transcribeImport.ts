/**
 * Auto-transcribe-on-import (Settings → AI → Speech-to-text → "Automatically on
 * import"). Mirrors {@link ./visualIndex.ts autoIndexImportedAssets}: a fire-and-forget
 * background job the MediaBin import flow `void`s so it never blocks import or preview.
 *
 * WHY it's shaped this way:
 * - The project transcript is **project-wide and singular** (`set_transcript` replaces
 *   the whole word list). So auto-transcribe **establishes** the transcript from the
 *   first transcribable clip and is **non-destructive**: it skips when a transcript
 *   already exists, so importing more B-roll later never clobbers your main clip's
 *   words. Re-transcribing a specific asset stays a deliberate act (the Transcript
 *   panel's button, or the AI agent).
 * - It reuses the exact trusted-host path the manual button uses (`transcribeAsset` →
 *   IPC → the selected local/hosted provider), then applies the same reversible
 *   `set_transcript` patch. Desktop only: hosted/local ASR needs the saved project.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Asset, TranscriptWord } from '@framepilot/timeline-schema';
import type { Patch } from '@framepilot/editor-core';
import type {
  AsrProviderName,
  TranscriptionRequest,
  TranscriptionResult,
} from '@framepilot/shared-types';
import { isActiveAsrProviderName } from '@framepilot/shared-types';
import { transcribeAsset } from './bridge.js';
import { setTranscriptPatch } from './patch-builders.js';
import {
  beginTranscriptionJob,
  failTranscriptionJob,
  finishTranscriptionJob,
} from './transcriptionJobs.js';

const log = createLogger('web-editor:transcribe-import');

/** One issue as returned by the editor's `applyPatchChecked`. */
interface PatchIssue {
  readonly message: string;
}

export interface AutoTranscribeInput {
  /**
   * The current asset list (from `editor.state.assets`, which reflects the just-applied
   * import — the `project` prop can still be stale here). Used to resolve `assetIds`.
   */
  readonly assets: readonly Asset[];
  /** The just-imported asset ids (the worklist for this run). */
  readonly assetIds: readonly string[];
  /**
   * How many words the project transcript already has. Non-zero ⇒ skip (import never
   * clobbers an existing transcript). Import doesn't touch the transcript, so the
   * `project` prop's value is accurate here.
   */
  readonly existingTranscriptWordCount: number;
  /** Whether the "Automatically on import" mode is enabled (settings.transcribeOnImport). */
  readonly enabled: boolean;
  /** The speech-to-text provider to use (settings.asrProvider). */
  readonly provider: AsrProviderName;
  /**
   * Save the project and return its on-disk path (desktop only), or `null` when it
   * can't be saved / isn't the desktop app. Reused from the Transcript panel wiring.
   */
  readonly ensureSaved?: () => Promise<string | null>;
  /** Apply the resulting `set_transcript` patch; returns validation issues (empty ⇒ ok). */
  readonly applyPatchChecked: (patch: Patch) => readonly PatchIssue[];
  /** Injectable for tests; defaults to the real trusted-host {@link transcribeAsset}. */
  readonly transcribe?: (req: TranscriptionRequest) => Promise<TranscriptionResult>;
}

/** The first transcribable (audio/video) asset among `assetIds`, or `undefined`. */
function firstTranscribable(
  assets: readonly Asset[],
  assetIds: readonly string[],
): Asset | undefined {
  for (const id of assetIds) {
    const asset = assets.find((candidate) => candidate.id === id);
    if (asset && (asset.kind === 'audio' || asset.kind === 'video')) return asset;
  }
  return undefined;
}

/**
 * Transcribe a freshly imported clip when auto-transcribe is enabled, gating skips
 * don't apply, and the project has no transcript yet. Resolves to the number of words
 * applied, or `0`/`undefined` when it does nothing — the caller `void`s it, so a
 * failure or an empty result never blocks import (it's logged, not thrown).
 */
export async function autoTranscribeImportedAssets(
  input: AutoTranscribeInput,
): Promise<number | undefined> {
  if (!input.enabled) return undefined;
  if (input.assetIds.length === 0) return undefined;
  if (!input.ensureSaved) return undefined; // desktop-only (needs the saved project on disk)
  // Non-destructive: only establish a transcript when none exists yet.
  if (input.existingTranscriptWordCount > 0) return undefined;
  const target = firstTranscribable(input.assets, input.assetIds);
  if (!target) return undefined;
  if (!isActiveAsrProviderName(input.provider)) {
    log.warn('auto-transcribe → legacy provider ignored', {
      assetId: target.id,
      provider: input.provider,
    });
    return undefined;
  }

  beginTranscriptionJob(target.id, input.provider);
  try {
    const projectPath = await input.ensureSaved();
    if (!projectPath) {
      failTranscriptionJob(target.id, 'Save the project before transcribing.');
      return undefined;
    }
    log.action('auto-transcribe → start', { assetId: target.id, provider: input.provider });
    const transcribe = input.transcribe ?? transcribeAsset;
    const result = await transcribe({
      projectPath,
      assetId: target.id,
      provider: input.provider,
    });
    if (!result.ok) {
      log.warn('auto-transcribe → provider unavailable', {
        assetId: target.id,
        error: result.error,
      });
      failTranscriptionJob(target.id, result.error);
      return undefined;
    }
    if (result.words.length === 0) {
      failTranscriptionJob(target.id, 'No spoken words were detected in this clip.');
      return undefined;
    }
    const words: readonly TranscriptWord[] = result.words;
    const issues = input.applyPatchChecked(setTranscriptPatch(result.assetId, words));
    if (issues.length > 0) {
      log.warn('auto-transcribe → patch rejected', {
        assetId: target.id,
        issues: issues.map((issue) => issue.message).join(' '),
      });
      failTranscriptionJob(target.id, issues.map((issue) => issue.message).join(' '));
      return undefined;
    }
    log.action('auto-transcribe → applied', { assetId: target.id, words: words.length });
    finishTranscriptionJob(target.id);
    return words.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('auto-transcribe → failed', {
      assetId: target.id,
      error: message,
    });
    failTranscriptionJob(target.id, message);
    return undefined;
  }
}
