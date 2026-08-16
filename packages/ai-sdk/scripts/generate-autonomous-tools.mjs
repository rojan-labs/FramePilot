#!/usr/bin/env node
/**
 * generate-autonomous-tools.mjs — mirror the autonomous manifest's ROUTING INDEX
 * into the Python engine.
 *
 * WHY: `src/autonomous-tools.manifest.json` is the single source of truth for the
 * compact capability surface the model sees. The sidecar needs the same routing
 * metadata (which capability is ready, and which registry tools it resolves to) to
 * validate an autonomous call it did not originate. That mirror was hand-maintained
 * and silently went stale — the manifest moved to version 2 while Python still
 * declared version 1, so the two sides disagreed about the advertised contract.
 *
 * Only the routing metadata is mirrored, deliberately: descriptions and input schemas
 * are the model-facing contract and are enforced in TS at the router boundary, so
 * duplicating them here would be a second place to drift.
 *
 * Output: `engine/python/framepilot_engine/ai_tools/autonomous_contract.py` (committed).
 * Regenerate with `pnpm --filter @framepilot/ai-sdk generate:autonomous-tools`.
 * `src/autonomous-tool-mirror.test.ts` fails if the committed mirror goes stale.
 * Requires a built `dist/` — the manifest is loaded through TS, not parsed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const MIRROR_PATH = join(
  repoRoot,
  'engine',
  'python',
  'framepilot_engine',
  'ai_tools',
  'autonomous_contract.py',
);

/**
 * Render one tool with its string arrays inline, matching the committed style — but wrap
 * onto one item per line when that would exceed the Python line-length limit, since the
 * generated block is linted as ordinary source (ruff E501).
 */
const MAX_PYTHON_LINE = 100;

function renderTool(tool) {
  const list = (values, key) => {
    const inline = `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
    if (`      "${key}": ${inline},`.length <= MAX_PYTHON_LINE) return inline;
    const items = values.map((value) => `        ${JSON.stringify(value)}`).join(',\n');
    return `[\n${items}\n      ]`;
  };
  return [
    '    {',
    `      "name": ${JSON.stringify(tool.name)},`,
    `      "stages": ${list(tool.stages, 'stages')},`,
    `      "status": ${JSON.stringify(tool.status)},`,
    `      "kind": ${JSON.stringify(tool.kind)},`,
    `      "internalRoutes": ${list(tool.internalRoutes, 'internalRoutes')}`,
    '    }',
  ].join('\n');
}

export function renderIndex(manifest) {
  const tools = manifest.tools.map(renderTool).join(',\n');
  return `{\n  "version": ${String(manifest.version)},\n  "tools": [\n${tools}\n  ]\n}`;
}

const { AUTONOMOUS_TOOL_MANIFEST } = await import(join(pkgRoot, 'dist', 'autonomous-tool-contract.js'));
const source = readFileSync(MIRROR_PATH, 'utf8');
const marker = /AUTONOMOUS_TOOL_INDEX_JSON = r'''[\s\S]*?'''/;
if (!marker.test(source)) {
  throw new Error(`could not locate AUTONOMOUS_TOOL_INDEX_JSON in ${MIRROR_PATH}`);
}
const rendered = renderIndex(AUTONOMOUS_TOOL_MANIFEST);
// Rewriting unconditionally keeps the generator idempotent: running it on an already
// current mirror is a no-op, not a failure, so it can sit in `build` without tripping it.
writeFileSync(MIRROR_PATH, source.replace(marker, `AUTONOMOUS_TOOL_INDEX_JSON = r'''${rendered}'''`));
process.stdout.write(
  `generate-autonomous-tools: mirrored ${String(AUTONOMOUS_TOOL_MANIFEST.tools.length)} capability(s) at v${String(AUTONOMOUS_TOOL_MANIFEST.version)} → ${MIRROR_PATH}\n`,
);
