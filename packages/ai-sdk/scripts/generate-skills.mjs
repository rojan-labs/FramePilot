#!/usr/bin/env node
/**
 * generate-skills.mjs — bundle `skills/*.md` into committed source modules.
 *
 * WHY: the SDK builds with plain `tsc` (no bundler) and must stay
 * filesystem-agnostic at runtime (browser + Electron + MCP), so skill markdown
 * cannot be read from disk when the orchestrator runs. This script embeds each
 * file's raw text into:
 *
 *   - `src/skills/generated.ts` (TS, parsed/validated by `src/skills.ts`)
 *   - `engine/python/framepilot_engine/ai_tools/skills_generated.py` (Python
 *     mirror, pre-parsed, so the Python `load_skill` handler serves the same
 *     bodies — keeping the TS↔Python tool parity honest)
 *
 * Both outputs are committed. Run via `pnpm generate:skills` (also part of
 * `pnpm build`); a unit test re-reads `skills/*.md` and fails if the generated
 * modules are stale.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const skillsDir = join(pkgRoot, 'skills');
const tsOut = join(pkgRoot, 'src', 'skills', 'generated.ts');
const pyOut = join(
  repoRoot,
  'engine',
  'python',
  'framepilot_engine',
  'ai_tools',
  'skills_generated.py',
);

const files = readdirSync(skillsDir)
  .filter((f) => f.endsWith('.md'))
  .sort();

const entries = files.map((file) => ({
  file,
  raw: readFileSync(join(skillsDir, file), 'utf8'),
}));

// --- TS output: raw text, parsed at module init by src/skills.ts -----------
const tsEntries = entries
  .map(
    (e) =>
      `  {\n    file: ${JSON.stringify(e.file)},\n    raw: ${JSON.stringify(e.raw)},\n  },`,
  )
  .join('\n');
const tsModule = `/**
 * GENERATED FILE — DO NOT EDIT. Source of truth: \`packages/ai-sdk/skills/*.md\`.
 * Regenerate with \`pnpm generate:skills\` (runs automatically in \`pnpm build\`).
 */
export interface RawSkillFile {
  readonly file: string;
  readonly raw: string;
}

export const RAW_SKILLS: readonly RawSkillFile[] = [
${tsEntries}
];
`;
writeFileSync(tsOut, tsModule);

// --- Python output: pre-parsed (name/description/tools/body) ---------------
// The Python side has no frontmatter parser; parse once here with the same
// strict rules as src/skills.ts so both registries serve identical content.
function parseFrontmatter(file, raw) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${file}: missing --- frontmatter fences`);
  const [, header, body] = match;
  const fields = {};
  for (const line of header.split('\n')) {
    const kv = /^([a-z]+):\s*(.+)$/.exec(line.trim());
    if (!kv) throw new Error(`${file}: bad frontmatter line: ${line}`);
    fields[kv[1]] = kv[2].trim();
  }
  const tools = fields.tools
    ? fields.tools
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  if (!fields.name || !fields.description) {
    throw new Error(`${file}: frontmatter needs name and description`);
  }
  return { name: fields.name, description: fields.description, tools, body: body.trim() };
}

const parsed = entries.map((e) => parseFrontmatter(e.file, e.raw));
const pyEntries = parsed
  .map((s) => {
    const tools = s.tools.map((t) => JSON.stringify(t)).join(', ');
    return `    {\n        "name": ${JSON.stringify(s.name)},\n        "description": ${JSON.stringify(s.description)},\n        "tools": [${tools}],\n        "body": ${JSON.stringify(s.body)},\n    },`;
  })
  .join('\n');
const pyModule = `# ruff: noqa — generated file; embedded markdown bodies trip line-length/unicode rules
"""GENERATED FILE — DO NOT EDIT. Source: \`\`packages/ai-sdk/skills/*.md\`\`.

Regenerate with \`\`pnpm --filter @framepilot/ai-sdk generate:skills\`\`.
"""

from __future__ import annotations

from typing import Any

SKILLS: list[dict[str, Any]] = [
${pyEntries}
]
`;
writeFileSync(pyOut, pyModule);

process.stdout.write(
  `generate-skills: wrote ${files.length} skill(s) → generated.ts + skills_generated.py\n`,
);
