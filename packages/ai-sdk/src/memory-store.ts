/**
 * @framepilot/ai-sdk/memory-store — project AI memory (PRD §8.7).
 *
 * The agent learns from the user *inside the project*: brand/caption style,
 * preferred pacing, target audience, export platforms, and a log of accepted and
 * rejected edits. This store reads and writes the existing `Project.aiMemory`
 * field (a free-form record) — **no schema change is needed**, so there is no
 * migration. All functions are pure: they return a new `Project`; the caller
 * persists it through the normal project-file writer.
 *
 * `aiMemory` is untrusted (it round-trips through `project.fp.json`), so it is
 * parsed defensively: unknown/garbage shapes fall back to safe defaults rather
 * than throwing, which keeps a hand-edited project file from breaking the editor.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { Patch } from '@framepilot/editor-core';

const log = createLogger('ai-sdk:memory-store');

/** A single remembered edit decision (no timestamp — kept deterministic). */
export interface MemoryEdit {
  readonly patchId: string;
  readonly reason: string;
}

const MemoryEditSchema = z.object({ patchId: z.string(), reason: z.string() });

/**
 * Where a remembered preference came from, and how long it is allowed to last.
 *
 * A preference the user *said* outranks one the agent *inferred* from the footage,
 * and neither should outlive its usefulness — "punchier than that" is about the cut
 * on screen, not about this project forever. Provenance is stored beside the values
 * rather than replacing them so that every project file written before this existed
 * still parses: an entry with no provenance is treated as a user statement that never
 * expires, which is exactly what it was when it was written.
 */
export interface MemoryProvenance {
  /** `user` — stated outright. `inferred` — the agent concluded it. `reference` — read off attached reference media. */
  readonly source: 'user' | 'inferred' | 'reference';
  /** The turn that wrote it; the clock TTL counts from. */
  readonly turn: number;
  /** Drop the entry once `turn + expiresAfterTurns` is behind us. Absent means it never expires. */
  readonly expiresAfterTurns?: number;
}

const MemoryProvenanceSchema = z.object({
  source: z.enum(['user', 'inferred', 'reference']),
  turn: z.number().int().nonnegative(),
  expiresAfterTurns: z.number().int().positive().optional(),
});

const ProjectMemorySchema = z.object({
  targetAudience: z.string().optional(),
  brandStyle: z.string().optional(),
  captionStyle: z.string().optional(),
  preferredPacing: z.string().optional(),
  exportPlatforms: z.array(z.string()).default([]),
  acceptedEdits: z.array(MemoryEditSchema).default([]),
  rejectedEdits: z.array(MemoryEditSchema).default([]),
  /** Per-preference-key provenance. Keys with no entry are un-provenanced and permanent. */
  provenance: z.record(z.string(), MemoryProvenanceSchema).default({}),
});

/** Typed view of `Project.aiMemory` (PRD §8.7). */
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;

/** Free-text preference keys the user can teach the agent. */
export type MemoryPreferenceKey =
  | 'targetAudience'
  | 'brandStyle'
  | 'captionStyle'
  | 'preferredPacing';

const EMPTY: ProjectMemory = {
  exportPlatforms: [],
  acceptedEdits: [],
  rejectedEdits: [],
  provenance: {},
};

const PREFERENCE_KEYS = [
  'targetAudience',
  'brandStyle',
  'captionStyle',
  'preferredPacing',
] as const satisfies readonly MemoryPreferenceKey[];

/**
 * Drop every preference whose TTL has run out as of `atTurn`.
 *
 * Expiry is applied on READ, never by rewriting the file. A stale entry is
 * cheap to ignore and expensive to lose: if the turn counter is wrong, or the
 * user reopens a project months later at turn 0, a read-side filter shows the
 * memory again rather than having silently deleted it on some earlier turn.
 */
function withoutExpired(memory: ProjectMemory, atTurn: number): ProjectMemory {
  const live: ProjectMemory = { ...memory, provenance: { ...memory.provenance } };
  let dropped = false;
  for (const key of PREFERENCE_KEYS) {
    const entry = memory.provenance[key];
    if (entry?.expiresAfterTurns === undefined) continue;
    if (atTurn <= entry.turn + entry.expiresAfterTurns) continue;
    delete live[key];
    delete live.provenance[key];
    dropped = true;
  }
  if (dropped) log.debug('memory read dropped expired preferences', { atTurn });
  return live;
}

/**
 * Parse a project's `aiMemory` into a typed {@link ProjectMemory} (never throws).
 *
 * @param atTurn - When given, preferences whose TTL has run out by this turn are
 *   filtered out of the result. Omit it to read everything the file holds.
 */
export function readMemory(project: Project, atTurn?: number): ProjectMemory {
  const parsed = ProjectMemorySchema.safeParse(project.aiMemory);
  const memory = parsed.success ? parsed.data : { ...EMPTY };
  return atTurn === undefined ? memory : withoutExpired(memory, atTurn);
}

/** Return a new project with `aiMemory` replaced by `memory`. */
export function writeMemory(project: Project, memory: ProjectMemory): Project {
  // Store as a plain record so it serialises cleanly into project.fp.json.
  return { ...project, aiMemory: { ...memory } as Record<string, unknown> };
}

/**
 * Set one free-text preference (e.g. "User prefers bold yellow captions").
 *
 * Writing a key REPLACES what was there, provenance included. That is what
 * supersession means here: a contradicting instruction does not merge with the
 * decision it contradicts, and the superseded entry is not kept as a rival the
 * context builder might still surface.
 */
export function setPreference(
  project: Project,
  key: MemoryPreferenceKey,
  value: string,
  provenance?: MemoryProvenance,
): Project {
  const memory = readMemory(project);
  const nextProvenance = { ...memory.provenance };
  if (provenance === undefined) delete nextProvenance[key];
  else nextProvenance[key] = provenance;
  return writeMemory(project, { ...memory, [key]: value, provenance: nextProvenance });
}

/** Replace the list of target export platforms. */
export function setExportPlatforms(project: Project, platforms: readonly string[]): Project {
  return writeMemory(project, { ...readMemory(project), exportPlatforms: [...platforms] });
}

const toEdit = (patch: Patch): MemoryEdit => ({ patchId: patch.patchId, reason: patch.reason });

/** Record that the user accepted a proposed patch (learning signal). */
export function recordAccepted(project: Project, patch: Patch): Project {
  const memory = readMemory(project);
  log.action('recordAccepted → memory write', { patchId: patch.patchId, reason: patch.reason });
  return writeMemory(project, {
    ...memory,
    acceptedEdits: [...memory.acceptedEdits, toEdit(patch)],
  });
}

/** Record that the user rejected a proposed patch (learning signal). */
export function recordRejected(project: Project, patch: Patch): Project {
  const memory = readMemory(project);
  log.action('recordRejected → memory write', { patchId: patch.patchId, reason: patch.reason });
  return writeMemory(project, {
    ...memory,
    rejectedEdits: [...memory.rejectedEdits, toEdit(patch)],
  });
}

/**
 * Render memory as a compact prompt block the context builder injects so the
 * model honours learned preferences. Returns '' when nothing is remembered.
 */
export function summarizeMemory(memory: ProjectMemory): string {
  const lines: string[] = [];
  // The source is shown only when it is NOT the user, because "the user said so" is
  // the default reading of a remembered preference and spending tokens to say it on
  // every turn would tell the model nothing it did not already assume.
  const note = (key: MemoryPreferenceKey): string => {
    // Optional-chained because `summarizeMemory` renders whatever it is handed —
    // including memory objects assembled in the host rather than parsed from a file.
    const source = memory.provenance?.[key]?.source;
    return source === undefined || source === 'user' ? '' : ` (${source})`;
  };
  if (memory.targetAudience) {
    lines.push(`Target audience: ${memory.targetAudience}${note('targetAudience')}`);
  }
  if (memory.brandStyle) lines.push(`Brand style: ${memory.brandStyle}${note('brandStyle')}`);
  if (memory.captionStyle) {
    lines.push(`Caption style: ${memory.captionStyle}${note('captionStyle')}`);
  }
  if (memory.preferredPacing) {
    lines.push(`Preferred pacing: ${memory.preferredPacing}${note('preferredPacing')}`);
  }
  if (memory.exportPlatforms.length > 0) {
    lines.push(`Export platforms: ${memory.exportPlatforms.join(', ')}`);
  }
  if (memory.rejectedEdits.length > 0) {
    const reasons = memory.rejectedEdits.map((e) => e.reason).join('; ');
    lines.push(`Previously rejected edits (avoid repeating): ${reasons}`);
  }
  if (memory.acceptedEdits.length > 0) {
    const reasons = memory.acceptedEdits.map((e) => e.reason).join('; ');
    lines.push(`Previously accepted edits: ${reasons}`);
  }
  return lines.join('\n');
}
