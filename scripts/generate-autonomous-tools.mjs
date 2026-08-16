#!/usr/bin/env node
/** Generate the Python routing mirror from the canonical autonomous manifest. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'packages/ai-sdk/src/autonomous-tools.manifest.json');
const target = path.join(
  root,
  'engine/python/framepilot_engine/ai_tools/autonomous_contract.py',
);

const manifest = JSON.parse(await readFile(source, 'utf8'));
const mirror = {
  version: manifest.version,
  tools: manifest.tools.map(({ name, stages, status, kind, internalRoutes }) => ({
    name,
    stages,
    status,
    kind,
    internalRoutes,
  })),
};
const json = JSON.stringify(mirror, null, 2);
const output = `\"\"\"Generated autonomous tool routing mirror. Do not edit by hand.\n\nSource: packages/ai-sdk/src/autonomous-tools.manifest.json\nGenerator: scripts/generate-autonomous-tools.mjs\n\"\"\"\n\nfrom __future__ import annotations\n\nimport json\nfrom typing import Any\n\nAUTONOMOUS_TOOL_INDEX_JSON = r'''${json}'''\nAUTONOMOUS_TOOL_INDEX: dict[str, Any] = json.loads(AUTONOMOUS_TOOL_INDEX_JSON)\nAUTONOMOUS_TOOL_VERSION: int = int(AUTONOMOUS_TOOL_INDEX[\"version\"])\nAUTONOMOUS_TOOL_NAMES: tuple[str, ...] = tuple(\n    sorted(str(tool[\"name\"]) for tool in AUTONOMOUS_TOOL_INDEX[\"tools\"])\n)\n\n\ndef autonomous_tool(name: str) -> dict[str, Any] | None:\n    \"\"\"Return one mirrored canonical tool or ``None``.\"\"\"\n    return next(\n        (tool for tool in AUTONOMOUS_TOOL_INDEX[\"tools\"] if tool[\"name\"] == name),\n        None,\n    )\n`;
await writeFile(target, output, 'utf8');
console.log(`Generated ${path.relative(root, target)}`);
