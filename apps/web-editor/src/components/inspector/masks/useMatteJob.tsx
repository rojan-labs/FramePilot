/**
 * React views of the background-removal job store (BR6.4), and the one place a finished run
 * becomes a project edit.
 *
 * The split matters: the ROW starts and cancels and renders progress, but it may be unmounted
 * when the job ends, so committing the result belongs to a component that is always mounted
 * ({@link useMatteJobCommits}, called once from the editor shell). A result that arrives while
 * the editor is looking at another clip still lands on the right clip, as one reversible edit.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { createLogger } from '@framepilot/shared-types';
import { runMaskCommand } from '../../../editor/mask-editing.js';
import type { UseEditor } from '../../../editor/useEditor.js';
import {
  matteJobStore,
  type MatteJobState,
  type MatteJobStore,
  type MatteJobsState,
  type MatteNotice,
  type MatteOutcome,
} from './matteJobStore.js';
import { rememberReviewReasons } from './matteReviewReasons.js';

const log = createLogger('web-editor:matte-job');

/** Subscribe to every job in the window (the jobs panel, the timeline's processing bands). */
export function useMatteJobs(store: MatteJobStore = matteJobStore): MatteJobsState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** The live job for one clip, or `null`. */
export function useMatteJob(
  clipId: string,
  store: MatteJobStore = matteJobStore,
): MatteJobState | null {
  return useMatteJobs(store).jobs[clipId] ?? null;
}

/** What the editor is told about a finished job, whichever clip they are looking at. */
export function matteNoticeFor(outcome: MatteOutcome, refusal: string | null): MatteNotice {
  if (refusal !== null) return { tone: 'alert', message: refusal };
  switch (outcome.kind) {
    case 'done':
      return {
        tone: 'status',
        message:
          outcome.needsReview.length === 0
            ? 'Background removed. Every frame was checked.'
            : `Background removed. ${String(outcome.needsReview.length)} moment${
                outcome.needsReview.length === 1 ? '' : 's'
              } need a look.`,
      };
    case 'cancelled':
      return { tone: 'status', message: 'Stopped. Nothing changed.' };
    case 'needs_prompt':
      return {
        tone: 'alert',
        message: 'Click the subject on the monitor, then try again.',
      };
    case 'pack_missing':
      return {
        tone: 'alert',
        message: outcome.error ?? 'The Smart Mask pack is not installed yet.',
        packMissing: true,
      };
    case 'failed':
      return {
        tone: 'alert',
        message: outcome.retryable ? `${outcome.message} You can try again.` : outcome.message,
      };
  }
}

/**
 * Commit every finished background-removal run as one reversible `add_matte_mask`.
 *
 * Call this ONCE, from a component that stays mounted for the life of the editor. It is what
 * makes "a selection change does not lose the job" true rather than a claim.
 *
 * @param editor - The editor the patch is applied to.
 */
export function useMatteJobCommits(editor: UseEditor, store: MatteJobStore = matteJobStore): void {
  const state = useMatteJobs(store);

  useEffect(() => {
    for (const clipId of Object.keys(state.outcomes)) {
      const outcome = store.takeOutcome(clipId);
      if (outcome === null) continue;
      let refusal: string | null = null;
      if (outcome.kind === 'done') {
        rememberReviewReasons(outcome.artifact.key, outcome.needsReview);
        refusal = runMaskCommand(editor, {
          type: 'add_matte_mask',
          clipId,
          ...(outcome.maskId === null ? {} : { maskId: outcome.maskId }),
          artifact: outcome.artifact,
          prompts: outcome.prompts,
          ...(outcome.edgeMode === null ? {} : { edgeMode: outcome.edgeMode }),
          review: {
            flagged: outcome.needsReview.map((range) => ({ start: range.start, end: range.end })),
            approved: [],
            locked: [],
          },
        });
        log.action('matte committed', {
          clipId,
          flagged: outcome.needsReview.length,
          refused: refusal !== null,
        });
      }
      store.setNotice(clipId, matteNoticeFor(outcome, refusal));
    }
  }, [editor, state.outcomes, store]);
}

/**
 * Commit finished background-removal runs. Renders nothing; mount it once, high enough in the
 * tree that it is alive for the whole session.
 */
export function MatteJobCommitter({ editor }: { readonly editor: UseEditor }): null {
  useMatteJobCommits(editor);
  return null;
}

/** Start and cancel the job for one clip, plus its live progress. */
export function useClipMatteJob(
  clipId: string,
  store: MatteJobStore = matteJobStore,
): {
  readonly job: MatteJobState | null;
  readonly start: (intent: Parameters<MatteJobStore['start']>[0]) => Promise<string | null>;
  readonly cancel: () => void;
} {
  const job = useMatteJob(clipId, store);
  const start = useCallback(
    (intent: Parameters<MatteJobStore['start']>[0]) => store.start(intent),
    [store],
  );
  const cancel = useCallback(() => store.cancel(clipId), [clipId, store]);
  return { job, start, cancel };
}
