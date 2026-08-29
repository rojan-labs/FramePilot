/**
 * @framepilot/ai-sdk/tool-context — the read-only context a tool runs against.
 *
 * Tools never reach outside this object: read tools read from it, mutating tools
 * resolve clip/track ids against `project.timeline` to build operations. Keeping
 * it small and explicit is part of the agent sandbox (PRD §18.2) — a tool cannot
 * touch the filesystem, the network, or any state not handed to it here.
 */
import type { Seconds } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';

import type { Skill } from './skills.js';
import type { EditorInteractionContext } from './editor-context/interaction-context.js';
import type { ColorEvidenceReader } from './color-evidence.js';

export interface ToolContext {
  readonly project: Project;
  /** Current host authority revision used to reject project-only stale interaction snapshots. */
  readonly projectRevision?: number;
  /**
   * Which turn of this conversation is running, counting the user's messages.
   *
   * Memory writes date themselves with it, so a preference can be given a TTL in
   * turns rather than in wall-clock time — "punchier than that" should not outlive
   * the cut it was said about, and turns are the only clock a conversation has.
   */
  readonly turn?: number;
  /** The user's current time selection, if any. */
  readonly selection?: { readonly start: Seconds; readonly end: Seconds };
  /** Authoritative live editor state captured for this turn; tools must not infer around it. */
  readonly interaction?: EditorInteractionContext;
  /** Run-scoped host evidence; exposed only to host-only domain tools, never serialized. */
  readonly evidence?: ColorEvidenceReader;
  /**
   * The skills available to `load_skill` (ADR 0057) — the only sanctioned way a
   * tool sees skill bodies. Still in-memory data handed to the tool: the sandbox
   * contract (no filesystem, no network) is unchanged.
   */
  readonly skills?: ReadonlyMap<string, Skill>;
}
