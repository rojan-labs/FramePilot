# Phase 2 — Prompts and tool contracts: after

Closed 2026-08-29. Baseline numbers are from `02-prompt-inventory.md` (P2.1, same
`estimateTokens` method over the built dist).

## Token delta

| Surface | Before | After | Delta |
| --- | --- | --- | --- |
| `auto_emphasize_captions` parameters | 864 | ≈90 | −774 (duplicate `style` schema removed) |
| `set_caption_style` description | 321 | ≈150 | −170 (45-name template list → `discover_caption_styles`) |
| Golden session `usedTokens` per request (same fixture, same request) | 22,592 | 21,633 | **−959 (−4.2 %)** |
| Fixed prompt strings (`prompts.ts`) | 551 | 551 | 0 — every row audited **keep** |
| Skills manifest | 1,645 | 1,645 | 0 — all 21 descriptions inside the 300-char cap, now asserted by test |

Per-row audit outcomes: `02-prompt-inventory.md` §7. The remaining cost is structural
(≈17.5k of tool definitions on every request); the stage-scoped tool set is Phase 5's
lever, and P1.6's after-measurement carries the output-cap fix separately.

## Parity defects closed

- **Descriptions** (P2.3): the Python sidecar mirror was hand-maintained and 38 of 73
  shared tools had drifted. `generate-tool-descriptions.mjs` now writes
  `tool_descriptions_generated.py` from the TS registry; `tool-descriptions-generated.test.ts`
  fails on a stale file; the Python parity suite reads the generated table.
- **Schemas**: `auto_emphasize_captions` trimmed on both sides; `ts_tool_registry.json`
  and `autonomous_contract.py` regenerated; `test_tool_registry_schema_parity` green.
- **Hosts** (P2.4): `pinned` and `variations` were the last two inputs the browser session
  sent to the context builder that the desktop session dropped on the floor. Both now ride
  `aiStreamStart`; desktop parses and bounds them (32 pins per turn) and routes
  `variations` into the edit run exactly as the browser does.

## Host differences that remain (documented, `docs/architecture/system-map.md`)

- `carriedForward` (previous run's working state) is desktop-only: the browser has no run
  ledger reader. Accepted — desktop is the product.
- ASR: manual transcribe is hosted via IPC; the agent's `transcribe` is sidecar-local.

## Evidence

- `packages/ai-sdk`: 3,774 tests green after the caption trim; goldens regenerated
  (`FRAMEPILOT_GOLDEN_UPDATE=1` corpus + session parity, `-u` streamAgent snapshot).
- `engine/python`: parity + `test_ai_tools.py` 266 green; ruff/mypy clean.
- `apps/desktop` `ai-stream.test.ts` 54 green (request parsing incl. pins/variations);
  `apps/web-editor` `ai-session.test.ts` 18 green (host-parity request shape).
