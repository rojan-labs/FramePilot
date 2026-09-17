/**
 * Auto prompt for background removal (plan 03, BR4.5): "Auto (main subject)".
 *
 * When the editor gives no click or box, the host asks the Subject Intelligence pack's
 * `subject.detect` about the clip's first in-range frame and turns the largest confident
 * person (else object) box into a box prompt. When that pack is not installed and healthy, or
 * it finds nothing, the answer is `undefined` and the UI asks for a click.
 *
 * It never proposes a download: a missing Subject Intelligence pack is checked against the
 * local storage index BEFORE any request, so the tracking service's install proposal (and its
 * catalog fetch) is never reached from here (05-INSPECTOR-UX: "never proposes a second
 * download on its own").
 */
import type { CapabilityPackWorkerRequest, MattePrompt } from '@framepilot/capability-packs';
import { createLogger } from '@framepilot/shared-types';
import type { MatteAutoPrompt } from './matte.js';
import type { CapabilityPackTrackingService } from './tracking.js';

const log = createLogger('desktop:capability-packs:matte-auto-prompt');

/** Detections below this confidence are not trusted to name the main subject. */
export const AUTO_PROMPT_MIN_CONFIDENCE = 0.5;
/** A box smaller than this share of the frame is not the main subject. */
export const AUTO_PROMPT_MIN_AREA = 0.01;

export interface SubjectDetectAutoPromptDependencies {
  /** Whether a healthy Subject Intelligence release is installed, from the local index only. */
  readonly subjectPackReady: () => Promise<boolean>;
  readonly tracking: () => CapabilityPackTrackingService;
}

export function createSubjectDetectAutoPrompt(dependencies: SubjectDetectAutoPromptDependencies): MatteAutoPrompt {
  return async (context) => {
    if (!(await dependencies.subjectPackReady())) return undefined;
    const request: CapabilityPackWorkerRequest = {
      type: 'request',
      protocolVersion: 1,
      requestId: `${context.requestId}-detect`,
      projectRevision: context.projectRevision,
      capability: 'subject.detect',
      media: {
        handleId: `media:${context.requestId}-detect`,
        assetId: context.asset.id,
        absolutePath: context.asset.path,
        sourceStartSeconds: context.frame.seconds,
        sourceEndSeconds: context.frame.seconds + 1 / context.fps,
        fps: context.fps,
        firstFrame: context.frame.index,
        lastFrameExclusive: context.frame.index + 1,
      },
      parameters: { labels: ['person', 'object'], maxDetections: 20 },
    };
    const outcome = await dependencies.tracking().run(request, {
      projectRevision: context.projectRevision,
      mediaRoot: context.mediaRoot,
      signal: context.signal,
    });
    if (outcome.status !== 'completed' || !('detections' in outcome.result)) {
      log.debug('autoPromptUnavailable', { status: outcome.status, ...(outcome.status === 'failed' ? { code: outcome.code } : {}) });
      return undefined;
    }
    const box = mainSubjectBox(outcome.result.detections);
    return box === undefined ? undefined : [{ kind: 'box', pts: context.frame.pts, box } satisfies MattePrompt];
  };
}

type Detection = { readonly label: 'face' | 'person' | 'object'; readonly box: { x: number; y: number; width: number; height: number }; readonly confidence: number };

/** The largest confident person box, else the largest confident object box. */
export function mainSubjectBox(detections: readonly Detection[]): Detection['box'] | undefined {
  const largest = (label: Detection['label']): Detection | undefined =>
    detections
      .filter(
        (detection) =>
          detection.label === label &&
          detection.confidence >= AUTO_PROMPT_MIN_CONFIDENCE &&
          detection.box.width * detection.box.height >= AUTO_PROMPT_MIN_AREA,
      )
      .sort((left, right) => right.box.width * right.box.height - left.box.width * left.box.height)[0];
  const chosen = largest('person') ?? largest('object');
  return chosen === undefined ? undefined : { ...chosen.box };
}
