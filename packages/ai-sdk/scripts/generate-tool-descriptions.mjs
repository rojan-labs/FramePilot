#!/usr/bin/env node
/**
 * generate-tool-descriptions.mjs — mirror every TS tool description into a generated
 * Python module the sidecar registry reads at import time.
 *
 * WHY: `engine/python/.../ai_tools/registry.py` carried hand-copied descriptions. On
 * 2026-08-29 only 38 of the 73 shared tools still matched the TS text (plan/system-mission
 * P2.3) — `add_clip` had lost its sourceStart sentence, `add_keyframes` its "for a simple
 * …" guidance. The model reads whichever surface it is on, so the two must be one text.
 * Skills already follow this pattern (`skills_generated.py`); this does the same for
 * tool descriptions. Python keeps its own literal only for a tool TS does not define.
 *
 * Output: `engine/python/framepilot_engine/ai_tools/tool_descriptions_generated.py`.
 * Runs as part of `pnpm --filter @framepilot/ai-sdk build`. Requires a built `dist/`.
 * `src/tool-descriptions-generated.test.ts` fails if the committed file goes stale.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const OUT_PATH = join(
  pkgRoot,
  '..',
  '..',
  'engine',
  'python',
  'framepilot_engine',
  'ai_tools',
  'tool_descriptions_generated.py',
);

/** Python string literal (double-quoted, escaped) — no f-strings, no implicit concatenation. */
function pyString(text) {
  return JSON.stringify(text);
}

export function renderModule(registry) {
  const entries = [...registry]
    .filter((tool) => typeof tool.description === 'string')
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((tool) => `    ${pyString(tool.name)}: ${pyString(tool.description.trim())},`);
  return [
    '# ruff: noqa — generated file; long description strings trip line-length rules',
    '"""GENERATED FILE — DO NOT EDIT. Source: ``packages/ai-sdk/src/tool-registry.ts``.',
    '',
    'Tool descriptions the model reads, mirrored from the TS registry so the sidecar,',
    'the MCP server and the desktop agent describe every tool in one voice.',
    'Regenerate with ``pnpm --filter @framepilot/ai-sdk build``.',
    '"""',
    '',
    'from __future__ import annotations',
    '',
    'TOOL_DESCRIPTIONS: dict[str, str] = {',
    ...entries,
    '}',
    '',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { TOOL_REGISTRY } = await import(join(pkgRoot, 'dist', 'tool-registry.js'));
  writeFileSync(OUT_PATH, renderModule(TOOL_REGISTRY));
  process.stdout.write(
    `generate-tool-descriptions: mirrored ${String(TOOL_REGISTRY.length)} description(s) → ${OUT_PATH}\n`,
  );
}
