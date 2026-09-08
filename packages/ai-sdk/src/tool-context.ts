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

import type { LedgerSnapshot } from './ledger.js';
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
   * The run's shot ledger (ADR 0175) — the same snapshot the context builder renders clip
   * rows from, handed to the tools so a result can carry the facts the row summarised.
   *
   * Optional and nullable throughout: perception is an optimization, so a tool must answer
   * from geometry alone when no ledger reached the run (no brain, no coverage yet, a host
   * that does not fetch one). Absent is "not measured", never "measured as normal".
   */
  readonly ledger?: LedgerSnapshot | null;
  /**
   * The skills available to `load_skill` (ADR 0057) — the only sanctioned way a
   * tool sees skill bodies. Still in-memory data handed to the tool: the sandbox
   * contract (no filesystem, no network) is unchanged.
   */
  readonly skills?: ReadonlyMap<string, Skill>;
  /**
   * The most stock cutaways the request asked for, when it named a number
   * (`acceptance.ts#explicitCutawayCount`). The placement tools refuse the placement past it
   * — run `4a8e` asked for two and got eight, burying the editor's own footage.
   */
  readonly stockCutawayCap?: number;
}
