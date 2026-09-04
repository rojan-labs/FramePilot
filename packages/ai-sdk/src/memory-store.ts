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
 * Longest a single remembered reason may run in the prompt, in characters.
 *
 * Sized off what the first sentence of a real narration costs: ~90–110 characters. The
 * cap is the backstop for a reason that never punctuates, not the normal path.
 */
const REASON_CHARS = 120;

/**
 * How many remembered decisions of each kind reach the prompt.
 *
 * Rejections outrank acceptances because they are explicit negative instructions — "do
 * not do that again" — and losing one lets the agent redo something the editor actively
 * refused. An acceptance is a weaker signal (the editor may simply not have objected), and
 * beyond a handful of examples the marginal taste information in another one is ~zero:
 * the block is read to infer a preference, not to replay a history.
 */
const MAX_REMEMBERED_REJECTED = 8;
const MAX_REMEMBERED_ACCEPTED = 5;

/**
 * The first sentence of a remembered reason, on one line, bounded.
 *
 * A `reason` used to be a short label ("tighten intro"). It is now whatever the model
 * narrated for the turn — `assemble.ts#assembleEdit` is handed `turn.text`, which runs to
 * several sentences. The taste signal an editor's decision carries lives in the opening
 * statement of what the edit *did*; the sentences after it are justification addressed to
 * a reader who is no longer present. Keeping the first sentence keeps the signal and drops
 * the essay.
 *
 * The sentence terminator is kept, so a reason that was already one short sentence renders
 * byte-identically to before this cap existed.
 */
function firstClause(reason: string): string {
  // Collapsed first: a multi-line reason would otherwise break the block's one-entry-per-
  // line shape and silently misattribute its tail to the next entry.
  const collapsed = reason.replace(/\s+/g, ' ').trim();
  // Whitespace-or-end lookahead so "trimmed to 3.5s" is not cut at the decimal point.
  const boundary = /[.!?](?=\s|$)/.exec(collapsed);
  const sentence = boundary ? collapsed.slice(0, boundary.index + 1) : collapsed;
  if (sentence.length <= REASON_CHARS) return sentence;
  // No punctuation anywhere, or an opening sentence longer than the cap: cut on a word
  // boundary and say so, rather than ending mid-word as if the reason stopped there.
  const cut = sentence.slice(0, REASON_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The newest distinct reasons, oldest-first, capped at `limit`.
 *
 * Newest rather than a spread across the project's history because this module already
 * treats a later decision as *superseding* an earlier one (see {@link setPreference}):
 * offering both would resurrect a superseded taste as a rival for the model to choose
 * between, which is exactly the failure that rule exists to prevent.
 *
 * Distinct because a run that accepts the same kind of edit repeatedly writes the same
 * first sentence repeatedly, and a preference stated five times is not five preferences.
 */
function recentReasons(edits: readonly MemoryEdit[], limit: number): readonly string[] {
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let i = edits.length - 1; i >= 0 && newestFirst.length < limit; i -= 1) {
    const clause = firstClause(edits[i]?.reason ?? '');
    if (clause === '' || seen.has(clause)) continue;
    seen.add(clause);
    newestFirst.push(clause);
  }
  return newestFirst.reverse();
}

/**
 * One "previously …" line, or `undefined` when nothing survives the filter.
 *
 * The `[newest n of m]` qualifier is rendered only when entries were actually left out, so
 * a project with a handful of remembered decisions reads exactly as it always did. When it
 * IS rendered it is load-bearing: without it the model reads five acceptances as the whole
 * history of the project and infers a taste from a sample it does not know is a sample.
 */
function renderEdits(label: string, edits: readonly MemoryEdit[], limit: number): string | null {
  const reasons = recentReasons(edits, limit);
  if (reasons.length === 0) return null;
  const qualifier =
    reasons.length < edits.length ? ` [newest ${reasons.length} of ${edits.length}]` : '';
  return `${label}${qualifier}: ${reasons.join('; ')}`;
}

/**
 * Render memory as a compact prompt block the context builder injects so the
 * model honours learned preferences. Returns '' when nothing is remembered.
 *
 * Bounded on purpose. Every accepted and rejected edit used to be joined in full into a
 * block that is injected on EVERY request and persisted in `project.fp.json`, so a project
 * paid for its whole edit history on every turn of every future run, forever. The cap and
 * the per-reason truncation above are what make this block flat in the project's age.
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
  const rejected = renderEdits(
    'Previously rejected edits (avoid repeating)',
    memory.rejectedEdits,
    MAX_REMEMBERED_REJECTED,
  );
  if (rejected) lines.push(rejected);
  const accepted = renderEdits(
    'Previously accepted edits',
    memory.acceptedEdits,
    MAX_REMEMBERED_ACCEPTED,
  );
  if (accepted) lines.push(accepted);
  return lines.join('\n');
}
