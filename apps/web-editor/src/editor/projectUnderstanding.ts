/**
 * What a project already KNOWS, assembled once per run: whether its footage is indexed, the
 * cached footage map, and the session digest (bin summary, the last session note, and the
 * corrections/decisions tiers — where an answer the editor gave an earlier run lives).
 *
 * ## Why this exists as its own module
 *
 * The desktop hub has read these three for a while (`ai-stream.ts`'s `readOptionalContext`).
 * The browser session read none of them, so the two surfaces disagreed about what the agent
 * knows about the project it is editing. In a captured browser run the editor said "choose
 * from footage map", the agent had no map in context, never called for one, and narrated
 * chapter titles it had invented instead.
 *
 * The reads are injected rather than constructed here so the composition — three independent
 * best-effort reads, each degrading to an absent block, none able to fail the run — is
 * testable without a sidecar or an environment variable.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('web-editor:project-understanding');

/** The three context blocks, each absent when its read could not answer. */
export interface ProjectUnderstanding {
  readonly visualStatus?: string;
  readonly footageMap?: string;
  readonly sessionContext?: string;
}

/** One best-effort read of a single block. */
export type UnderstandingRead = () => Promise<string | undefined>;

/** The reads to attempt, by the block each fills. */
export interface UnderstandingReads {
  readonly visualStatus: UnderstandingRead;
  readonly footageMap: UnderstandingRead;
  readonly sessionContext: UnderstandingRead;
}

/**
 * Attempt all three reads concurrently and keep whatever answered.
 *
 * Independent and fail-soft by contract: they overlap rather than queueing at the head of
 * every run, a rejection or a timeout becomes an absent block rather than a failed run, and an
 * empty string is treated as nothing to say. A slow or unreachable sidecar must cost the run
 * nothing but the blocks themselves.
 */
export async function readProjectUnderstanding(
  reads: UnderstandingReads,
): Promise<ProjectUnderstanding> {
  const attempt = async (read: UnderstandingRead, label: string): Promise<string | undefined> => {
    try {
      const value = await read();
      return value && value.trim() !== '' ? value : undefined;
    } catch (error) {
      log.debug(`${label} unavailable for this run`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
  const [visualStatus, footageMap, sessionContext] = await Promise.all([
    attempt(reads.visualStatus, 'visual status'),
    attempt(reads.footageMap, 'footage map'),
    attempt(reads.sessionContext, 'session context'),
  ]);
  return {
    ...(visualStatus === undefined ? {} : { visualStatus }),
    ...(footageMap === undefined ? {} : { footageMap }),
    ...(sessionContext === undefined ? {} : { sessionContext }),
  };
}
