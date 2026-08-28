# Phase 2 — Prompt audit and parity — `[~]`

> **Ships:** every model-facing text audited against a checklist, shortened where it
> can be, moved into code where it should be; one source of truth per prompt, tool
> definition, and schema across desktop / web / sidecar / CLI / MCP / tests.
> **Does not ship:** new capabilities. **Depends on:** Phase 0 map (P0.1 parity
> candidates). **Schema/deps:** none.
> **Owner agent:** `lead-prompt-engineer` for wording, `mcp-engineer` for MCP parity.

Golden manifests track prompt text (`packages/ai-sdk/src/__snapshots__`, three regen
commands — see `AGENTS.md`). Every change here regenerates them, and **the golden diff
is the measured token delta** that goes in the report.

## P2.1 — Inventory — `[x]`

List every model-facing string: `prompts.ts`, context-builder blocks, tool `description`
fields in `domain-tools/*`, `autonomous-tools.manifest.json`, skill descriptions and
bodies in `packages/ai-sdk/skills/*.md`, orchestrator mode instructions, Python
`ai_tools` descriptions, MCP tool descriptions, and any string the sidebar shows that
came from the model layer. Table: location, tokens, consumer surfaces, last changed.
**Done when:** `docs/reports/system-mission/02-prompt-inventory.md` exists.

## P2.2 — Audit each prompt against the checklist — `[ ]`

Per entry: redundant instruction (already enforced in code or stated elsewhere) ·
contradiction with another entry · verbosity · ambiguity in a tool contract · repeated
context (P1.3 block now carries it) · weak output schema (prose where JSON is parsed) ·
missing constraint the Critic then catches late · injection surface (user or media text
concatenated into an instruction position) · a rule that should be a code guarantee.
Fix in place. Prefer deleting to rewriting. Never lengthen a prompt to fix a behaviour
that a validator can enforce.
**Done when:** each inventory row has an audit outcome and the goldens are regenerated
with the delta recorded.

## P2.3 — Tool description parity (TS ↔ Python ↔ MCP) — `[x]`

**Reuses:** `scripts/generate-tool-parity-fixture.mjs` and the parity tests. Extend the
fixture to compare `description`, argument schema, and enum values, not only names.
Where the Python mirror or MCP surface carries its own wording, make it derive from the
TS registry at generate time (there is already a generator; extend it) so drift is
impossible rather than tested-for.
**Done when:** the parity test fails on any description/schema difference and the
generator is the only writer of the mirrored files.

Landed 2026-08-29: `scripts/generate-tool-descriptions.mjs` writes
`ai_tools/tool_descriptions_generated.py` (in the ai-sdk build); the Python registry's
`_spec` reads the TS text for every tool; `test_tool_registry_ts_parity.py` asserts every
Python tool's description is the generated text and that no Python-only tool exists;
`tool-descriptions-generated.test.ts` fails on a stale file. Before: 38 of 73 shared
descriptions matched. Found and removed a workaround stack on the way: the TS
`add_transition` text still said `list_transitions`, and both the TS contract layer and
the Python overrides patched it at runtime — fixed at the source, both patches deleted.

## P2.4 — Host prompt parity (desktop vs web vs CLI) — `[ ]`

Compare the system context assembled for the same project and request through
`apps/desktop/electron/ai/ai-stream.ts`, the web-editor path, and any CLI/eval path.
Differences must be either removed or listed in `docs/architecture/system-map.md` under
"Intentional host differences" with the reason (e.g. desktop has the sidecar, so
`transcribe` is local-only there — see ASR two-path note).
**Done when:** a golden-per-host test exists and the only differences are documented ones.

## P2.5 — Skill discovery surface — `[ ]`

Skill descriptions are the only thing the model sees when choosing a skill and are
capped at 300 chars (over-cap silently skips). Check every skill's description is within
cap, names the situation it fits, and does not overlap another's; run the skill-selection
eval to confirm selection rate did not drop.
**Done when:** all descriptions within cap; selection eval green.

## P2.6 — Close — `[ ]`

`docs/reports/system-mission/02-after.md`: token delta per prompt from the golden diff,
parity defects closed, host differences documented. README/PLAN snapshot.

## Discovered

