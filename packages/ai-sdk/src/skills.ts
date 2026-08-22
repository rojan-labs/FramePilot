/**
 * @framepilot/ai-sdk/skills — bundled, on-demand agent skills (ADR 0057).
 *
 * A skill is a developer-authored markdown playbook (`packages/ai-sdk/skills/*.md`)
 * with strict frontmatter (`name`, `description`, optional `tools`). Skills load
 * Claude-Code-style: only the compact manifest (name + description + tools) enters
 * the agent's context; the full body is fetched on demand via the `load_skill`
 * read tool when the model decides a skill is relevant. Markdown is embedded at
 * build time (`scripts/generate-skills.mjs` → `src/skills/generated.ts`) so the
 * SDK stays filesystem-agnostic — no runtime fs, works in the browser.
 *
 * Parsing is defensive (memory-store precedent): a malformed file is skipped with
 * a warning, never crashing a run — but a unit test asserts every bundled skill
 * parses cleanly, so a bad skill cannot actually ship.
 */
import { createLogger } from '@framepilot/shared-types';
import { z } from 'zod/v4';

import { RAW_SKILLS } from './skills/generated.js';
import { getTool } from './tool-registry.js';
import { IMPLICIT_ONLY_TOOL_NAMES } from './tool-scope.js';

const log = createLogger('ai-sdk:skills');

/** Bodies beyond this are rejected — a skill must never blow the context budget. */
export const MAX_SKILL_BODY_CHARS = 32_768;
/** Advertising more than this stops being a manifest and starts being noise. */
export const MAX_SKILLS = 32;

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const SkillSchema = z
  .object({
    name: z.string().regex(KEBAB_CASE, 'skill name must be kebab-case'),
    description: z.string().min(1).max(300),
    tools: z.array(z.string()).default([]),
    body: z.string().min(1).max(MAX_SKILL_BODY_CHARS),
  })
  .strict();

export type Skill = z.infer<typeof SkillSchema>;

export type SkillParseResult =
  | { readonly ok: true; readonly skill: Skill }
  | { readonly ok: false; readonly error: string };

/**
 * Parse one skill file: strict `---` frontmatter fences at the very start, then
 * `key: value` lines (`tools` as an inline `[a, b]` list), then the markdown body.
 * Never throws — malformed input returns `{ ok: false, error }` with the reason.
 */
export function parseSkillFile(file: string, raw: string): SkillParseResult {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return { ok: false, error: `${file}: missing --- frontmatter fences` };
  // Both groups always exist once the regex matches (they may be empty strings).
  const header = match[1] as string;
  const body = match[2] as string;

  const fields: Record<string, string> = {};
  for (const line of header.split('\n')) {
    if (line.trim() === '') continue;
    const kv = /^([a-z]+):\s*(.+)$/.exec(line.trim());
    if (!kv) return { ok: false, error: `${file}: bad frontmatter line: "${line.trim()}"` };
    fields[kv[1] as string] = (kv[2] as string).trim();
  }

  const tools =
    fields['tools'] !== undefined
      ? fields['tools']
          .replace(/^\[/, '')
          .replace(/\]$/, '')
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : [];

  const parsed = SkillSchema.safeParse({
    name: fields['name'],
    description: fields['description'],
    tools,
    body: body.trim(),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${file}: ${issue?.path.join('.')} — ${issue?.message}` };
  }
  return { ok: true, skill: parsed.data };
}

/**
 * Drop any `tools:` entry the model cannot actually select (ADR 0055 discipline: never
 * advertise a capability that does not exist). Returns the cleaned skill and the names
 * that were dropped so the caller can warn.
 *
 * "Registered" was too weak a test. `index_media` is registered — and withheld from every
 * model-facing scope (`IMPLICIT_ONLY_TOOL_NAMES`), because indexing is lifecycle work the
 * app drives. Two bundled playbooks listed it, so the manifest line the model reads
 * before loading anything named a tool that is not in and never will be in its tool list.
 * Same for a tool whose engine does not exist (`available: false`): a run told a playbook
 * uses it either calls it and fails or reasons about why it is missing. Both cost the run
 * a detour and neither is recoverable from inside the model.
 */
export function validateSkillTools(skill: Skill): { skill: Skill; unknown: readonly string[] } {
  const unknown = skill.tools.filter((name) => {
    const tool = getTool(name);
    return (
      tool === undefined ||
      !tool.available ||
      (IMPLICIT_ONLY_TOOL_NAMES as readonly string[]).includes(name)
    );
  });
  if (unknown.length === 0) return { skill, unknown };
  return { skill: { ...skill, tools: skill.tools.filter((n) => !unknown.includes(n)) }, unknown };
}

/**
 * Parse + validate every bundled skill. Malformed files and duplicate names are
 * skipped with a warning (defensive — a bad skill must never break a run); the
 * bundled-skills unit test separately asserts none actually IS malformed.
 */
export function loadSkills(
  rawFiles: readonly { readonly file: string; readonly raw: string }[],
): Skill[] {
  const byName = new Map<string, Skill>();
  for (const { file, raw } of rawFiles) {
    if (byName.size >= MAX_SKILLS) {
      log.warn('skill cap reached — skipping remaining files', { cap: MAX_SKILLS, file });
      break;
    }
    const result = parseSkillFile(file, raw);
    if (!result.ok) {
      log.warn('skipping malformed skill file', { error: result.error });
      continue;
    }
    const { skill, unknown } = validateSkillTools(result.skill);
    if (unknown.length > 0) {
      log.warn('skill references unknown tools — dropped', { skill: skill.name, unknown });
    }
    if (byName.has(skill.name)) {
      log.warn('duplicate skill name — keeping the first', { skill: skill.name, file });
      continue;
    }
    byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

/** The skills bundled with this SDK build, parsed once at module init. */
export const BUNDLED_SKILLS: readonly Skill[] = Object.freeze(loadSkills(RAW_SKILLS));

/** Name → skill lookup for the `load_skill` tool. */
export function skillsByName(skills: readonly Skill[]): ReadonlyMap<string, Skill> {
  return new Map(skills.map((s) => [s.name, s]));
}

/**
 * The compact context block advertising the available skills (the manifest tier):
 * one line per skill plus the instruction to load a body on demand. Empty string
 * when there are no skills, so the tier is simply omitted.
 */
export function summarizeSkillsManifest(skills: readonly Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map(
    (s) =>
      `- ${s.name} — ${s.description}${s.tools.length > 0 ? ` (tools: ${s.tools.join(', ')})` : ''}`,
  );
  return [
    'Skills (expert playbooks). Before starting work that matches one, call load_skill',
    'with its name and follow the returned instructions:',
    ...lines,
  ].join('\n');
}
