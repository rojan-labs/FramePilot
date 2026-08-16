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

const ProjectMemorySchema = z.object({
  targetAudience: z.string().optional(),
  brandStyle: z.string().optional(),
  captionStyle: z.string().optional(),
  preferredPacing: z.string().optional(),
  exportPlatforms: z.array(z.string()).default([]),
  acceptedEdits: z.array(MemoryEditSchema).default([]),
  rejectedEdits: z.array(MemoryEditSchema).default([]),
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
};

/** Parse a project's `aiMemory` into a typed {@link ProjectMemory} (never throws). */
export function readMemory(project: Project): ProjectMemory {
  const parsed = ProjectMemorySchema.safeParse(project.aiMemory);
  return parsed.success ? parsed.data : { ...EMPTY };
}

/** Return a new project with `aiMemory` replaced by `memory`. */
export function writeMemory(project: Project, memory: ProjectMemory): Project {
  // Store as a plain record so it serialises cleanly into project.fp.json.
  return { ...project, aiMemory: { ...memory } as Record<string, unknown> };
}

/** Set one free-text preference (e.g. "User prefers bold yellow captions"). */
export function setPreference(project: Project, key: MemoryPreferenceKey, value: string): Project {
  return writeMemory(project, { ...readMemory(project), [key]: value });
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
  if (memory.targetAudience) lines.push(`Target audience: ${memory.targetAudience}`);
  if (memory.brandStyle) lines.push(`Brand style: ${memory.brandStyle}`);
  if (memory.captionStyle) lines.push(`Caption style: ${memory.captionStyle}`);
  if (memory.preferredPacing) lines.push(`Preferred pacing: ${memory.preferredPacing}`);
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
