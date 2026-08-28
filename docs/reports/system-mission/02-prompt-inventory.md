# Prompt inventory (P2.1)

Measured 2026-08-29 with `estimateTokens` over the built `@framepilot/ai-sdk` dist (≈4 chars/token).
Consumers: **D** desktop agent, **W** web-editor agent, **M** MCP server, **Py** Python `ai_tools`
mirror (generated from the TS registry by `generate-autonomous-tools.mjs`), **E** eval harnesses.

## 1. Fixed prompt strings (`packages/ai-sdk/src/prompts.ts`) — 551 tokens total

| String | Tokens | Consumers | Note |
| --- | --- | --- | --- |
| `SYSTEM_PROMPT` (authority contract) | 135 | D W M E | every request |
| `CRITIC_JUDGMENT_SYSTEM_PROMPT` | 140 | critic proposer | advisory judgment call only |
| `QUESTION_MODE_INSTRUCTION` | 124 | question route | |
| `AGENT_PLAN_DRAFT_INSTRUCTION` | 84 | plan-first runs | |
| `PLAN_MODE_INSTRUCTION` | 68 | plan mode | |

The fixed strings are not where the tokens go.

## 2. Context-builder blocks (`context-builder.ts`, `kernel/briefing.ts`) — 2.2k → 5.8k per request, growing

Observed on the montage ledger: the `system` section starts at 2,258 tokens (contract +
project header + timeline + media bin + skills manifest) and grows to 5,752 by request #44 as
the run briefing (`WHAT DONE LOOKS LIKE`, `STAGE`, objectives, decisions, action log)
accumulates. On the podcast fixture the transcript retrieval alone is ~17k tokens
(`system: 19,222` at request #3). Blocks: system contract · project header · timeline
summary · media bin · **source media (new, P1.3a)** · visual index status · footage map ·
session context ("What we have learned…") · scoped memory · skills manifest · pinned ·
selection · run briefing · action log · user request.

## 3. Skills (`packages/ai-sdk/skills/*.md`) — 21 skills

Manifest (name + description, always in context): **1,645 tokens**. Bodies (loaded on
demand by `load_skill`, pinned for the run): 13,571 tokens total, 384–1,386 each. All 21
descriptions are within the 300-char cap (122–260 chars). The manifest is the discovery
surface (memory note); the largest bodies are `cut-and-transition-grammar` 1,386,
`broll-and-layering` 1,342, `caption-design` 1,110, `beat-synced-editing` 1,093,
`audio-polish` 1,007.

## 4. Tool definitions (`domain-tools/*`, 86 tools) — 18,639 tokens on every request

Descriptions 8,719 + parameter schemas 8,743 (+ names). Per stage the list only loses the
`analysis` role in execution stages (12,939–15,448 observed), so ≥ 70% of it rides every call.
Top 20 by cost:

| tool | description | parameters | total |
| --- | --- | --- | --- |
| set_caption_style | 321 | 810 | 1,145 |
| auto_emphasize_captions | 145 | 864 | 1,025 |
| set_track_caption_style | 138 | 811 | 964 |
| professional_audio | 181 | 698 | 894 |
| read_edit_signals | 223 | 197 | 434 |
| professional_color | 189 | 216 | 420 |
| professional_edit | 182 | 178 | 375 |
| search_music | 293 | 48 | 355 |
| ask_user | 240 | 98 | 351 |
| add_text_layer | 150 | 177 | 340 |
| add_clip | 206 | 114 | 332 |
| add_clips | 173 | 124 | 309 |
| map_time | 110 | 181 | 303 |
| map_footage | 249 | 30 | 292 |
| add_transition | 187 | 76 | 277 |
| add_track | 194 | 66 | 273 |
| search_stock | 173 | 80 | 268 |
| track_subject_automatically | 164 | 83 | 267 |
| search_visual | 166 | 83 | 263 |
| get_mapped_transcript | 174 | 64 | 254 |

Three caption-style tools share the same 800-token style schema (3,134 tokens together —
more than everything the prompt says about the user's video). The Python mirror
(`ai_tools/autonomous_contract.py`) and the MCP surface are generated from this registry,
so their wording is this wording (P2.3 extends the parity fixture to descriptions).

## 5. Model-layer copy shown in the UI

`describe.ts` (tool card labels such as "Reframing", "Browsing the media bin"),
`narration.ts`, `agentCompletionReport`. Not sent to the model; audited in Phase 8 P8.2.

## 6. Where the audit should spend its effort (input to P2.2)

1. Tool schemas — 18.6k per request. Two levers: (a) a **stage/intent-scoped tool set**
   (the autonomous stage mapping exists at 471–1,321 tokens); (b) collapse the three
   caption-style tools onto one shared `$ref`-style style schema or one tool with a
   `scope` argument.
2. Long descriptions that restate the parameters (`search_music` 293, `map_footage` 249,
   `ask_user` 240, `read_edit_signals` 223).
3. The action log's growth inside `system` (2.2k → 5.8k) — `compactAgentLog` exists; check
   its window.
4. Skills manifest 1.6k — fine; bodies are on demand.
