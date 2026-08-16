/**
 * Composer power data (Phase 11 M8, ADR 0033): the slash-command palette, quick
 * actions, and the included-context derivation. Pure + deterministic so the palette
 * filter, the prefill prompts, and the context list are all unit-testable.
 *
 * Slash commands mirror the FramePilot task command set (`.agents/commands/`); quick
 * actions pre-fill a natural-language prompt. Context items are derived from the
 * project + selection and feed the orchestrator's `context-builder` inputs.
 *
 * NB: voice/mic is intentionally absent (Approval A5 — dropped).
 */
import type { PinnedEntity } from '@framepilot/ai-sdk';
import type { Project } from '@framepilot/timeline-schema';
import type { SelectionRange } from '../editor/selectors.js';
import type { ContextItem } from './conversation.js';

export type { PinnedEntity };

/** A slash command surfaced in the composer palette. */
export interface SlashCommand {
  /** The `/name` typed in the composer. */
  readonly name: string;
  readonly description: string;
}

/** The FramePilot task commands the composer exposes (mirrors `.agents/commands/`). */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'create-short', description: 'Turn a recording into a short-form video' },
  { name: 'remove-silence', description: 'Detect and remove silent gaps' },
  { name: 'add-captions', description: 'Generate and add a styled caption track' },
  { name: 'improve-pacing', description: 'Tighten slow parts and add punch-ins' },
  { name: 'add-hook', description: 'Restructure the opening as a stronger hook' },
  { name: 'export-reels', description: 'Export for Reels (9:16) through the engine' },
  { name: 'plan-edit', description: 'Produce a structured edit plan (no mutation)' },
];

/** A one-tap quick action that pre-fills a prompt. */
export interface QuickAction {
  readonly label: string;
  readonly prompt: string;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { label: 'Improve Edit', prompt: 'Improve this edit: tighten pacing and fix obvious issues.' },
  { label: 'Create B-roll', prompt: 'Suggest and place B-roll over the talking-head sections.' },
  { label: 'Fix Audio', prompt: 'Clean up the audio: normalize levels and remove noise.' },
  { label: 'Generate Titles', prompt: 'Generate title-card text for the key sections.' },
  { label: 'Make Viral', prompt: 'Restructure for retention: strong hook, fast pacing, captions.' },
  { label: 'Trim Silence', prompt: 'Remove the silent gaps to tighten the cut.' },
  { label: 'Animate Captions', prompt: 'Add animated word-by-word captions.' },
];

/** True when `text` is an active slash query (starts with `/`, no whitespace yet). */
export function isSlashQuery(text: string): boolean {
  return text.startsWith('/') && !/\s/.test(text);
}

/** Filter the slash commands by the `/query` typed so far (empty `/` returns all). */
export function filterSlashCommands(text: string): readonly SlashCommand[] {
  if (!isSlashQuery(text)) return [];
  const query = text.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.includes(query));
}

/** Round to 1 decimal for a compact chip label (matches context-builder's rounding style). */
const round1 = (n: number): number => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// "@" pin-context picker (H1.5, P8.7 narrow slice): pin additional timeline
// clips/`project.assets` as extra context chips, independent of the auto-derived
// selection chip. Deferred, NOT built here: `@range`/`@marker`/`@track` entity
// kinds (P8.7's full Cursor/Windsurf-style scope stays open — see plan docs).
// ---------------------------------------------------------------------------

/** The last path segment of a file path, for a compact entity label. */
function basename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * Every clip in the timeline plus every `project.assets` entry, as pinnable
 * entities for the "@" picker (P8.7). Clip labels combine the source asset's
 * filename with the clip's timeline range (mirrors the selection chip's
 * rounding); asset labels are just the filename. Pure + deterministic — same
 * project always yields the same list in the same order (tracks, then clips
 * within a track, then assets).
 */
export function pinnableEntities(project: Project): readonly PinnedEntity[] {
  const assetPathById = new Map(project.assets.map((asset) => [asset.id, asset.path]));
  const clips: PinnedEntity[] = project.timeline.tracks.flatMap((track) =>
    track.clips.map((clip) => {
      const assetPath = assetPathById.get(clip.assetId);
      const assetLabel = assetPath ? basename(assetPath) : clip.assetId;
      return {
        kind: 'clip' as const,
        id: clip.id,
        label: `${assetLabel} ${round1(clip.start)}–${round1(clip.end)}s`,
      };
    }),
  );
  const assets: PinnedEntity[] = project.assets.map((asset) => ({
    kind: 'asset' as const,
    id: asset.id,
    label: basename(asset.path),
  }));
  return [...clips, ...assets];
}

/** Matches the trailing `@query` token being typed (an "@" at the start or after whitespace, not yet followed by whitespace). */
const AT_QUERY_RE = /(?:^|\s)@([^\s@]*)$/;

/** True when `text` ends with an active "@" entity query. */
export function isAtQuery(text: string): boolean {
  return AT_QUERY_RE.test(text);
}

/** Filter `entities` by the trailing `@query` typed so far (bare `@` returns all). */
export function filterAtEntities(
  text: string,
  entities: readonly PinnedEntity[],
): readonly PinnedEntity[] {
  const match = text.match(AT_QUERY_RE);
  if (!match) return [];
  const query = (match[1] ?? '').toLowerCase();
  if (query.length === 0) return entities;
  return entities.filter((entity) => entity.label.toLowerCase().includes(query));
}

/** Remove the trailing `@query` token from `text` (called when an entity is picked). */
export function removeAtQuery(text: string): string {
  return text.replace(AT_QUERY_RE, '');
}

/**
 * The current timeline selection, as the composer needs it to render a chip:
 * the bounding range plus how many clips are selected (a single clip vs a
 * multi-select reads differently — "Selected: 2 clips, 12–18s" vs one clip).
 */
export interface ComposerSelection {
  readonly range: SelectionRange;
  readonly clipCount: number;
}

/**
 * Derive the included-context chips that the orchestrator's `context-builder`
 * genuinely receives — it always builds from the `project` (timeline + transcript +
 * assets), so these chips are accurate, not decorative. When `selection` is given (a
 * live timeline selection resolved to a range, P8.4/P12.7), a removable "Selected"
 * chip is prepended so the composer visibly reflects the same selection threaded
 * into `AiSessionInput.selection` — closing the selection↔context loop. Omitted
 * entirely with no selection, so the panel never claims context the AI doesn't
 * actually get (build-order rule).
 *
 * `pinned` (P8.7 narrow slice) adds one removable chip per user-pinned clip/asset,
 * right after the selection chip — N independently-removable chips, architecturally
 * free since `ContextItem` is already a flat array (no special-casing beyond a
 * unique `pin:<kind>:<id>` chip id per entity, so two pins never collide and each
 * removes independently of the selection chip and of each other).
 */
export function buildContextItems(
  project: Project,
  selection?: ComposerSelection,
  pinned: readonly PinnedEntity[] = [],
): ContextItem[] {
  const items: ContextItem[] = [];
  if (selection) {
    const { range, clipCount } = selection;
    const clipsLabel = clipCount === 1 ? '1 clip' : `${clipCount} clips`;
    items.push({
      id: 'selection',
      kind: 'selection',
      label: `Selected: ${clipsLabel}, ${round1(range.start)}–${round1(range.end)}s`,
    });
  }
  for (const entity of pinned) {
    items.push({
      id: `pin:${entity.kind}:${entity.id}`,
      kind: `pinned-${entity.kind}`,
      label: entity.label,
    });
  }
  items.push(
    { id: 'timeline', kind: 'timeline', label: 'Current Timeline' },
    { id: 'project', kind: 'project', label: `Project: ${project.name}` },
  );
  if (project.transcript.length > 0) {
    items.push({ id: 'transcript', kind: 'transcript', label: 'Transcript' });
  }
  if (project.assets.length > 0) {
    items.push({ id: 'assets', kind: 'assets', label: `Open Assets (${project.assets.length})` });
  }
  return items;
}
