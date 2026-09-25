# 07 — The agent and the MCP server

Everything a person can do in Elements, the agent can do through registered, schema-validated
tools that return patches (AGENTS.md invariant 5). The model chooses; deterministic code places,
validates and renders (`product-discipline.mdc` §7). No prompt text substitutes for a missing
capability.

---

## 1. Tools

| Tool                              | Kind                       | Where it runs                                  | What it does                                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`search_elements`**             | analysis                   | anywhere (local catalogue, no network, no key) | `{ query, kind?: 'sticker' \| 'shape', category?, limit? ≤ 30 }` → `{ results: [{ elementId, kind, name, category, tags, aspect, frame: 'box' \| 'segment', knobs?, animated, license, attributionRequired }], total }`                                                                      |
| **`add_shape`**                   | mutate (pure patch)        | anywhere                                       | `{ shape (catalogue id or preset id), start, end, box?: { x, y, width, height } \| ends?: { x1, y1, x2, y2 }, fill?, stroke?, strokeWidth?, strokeStyle?, startCap?, endCap?, knobs?, label? (EL5), rotation?, in?, out?, trackId? }` → `addShapePatch` (+ layer transitions for `in`/`out`) |
| **`set_shape_style`**             | mutate                     | anywhere                                       | typed partial update of one shape's params (colours, stroke, knobs, box/ends, label) → one `set_effect_params`, merged params re-validated                                                                                                                                                   |
| **`add_sticker`**                 | host (materialise) + patch | **desktop** (`hostUiOnly`)                     | `{ elementId, start, end?, xPercent?, yPercent?, sizePercent? (of frame height, default 30), rotation?, in?, out?, trackId? }` → host copies the file (06 §3) → orchestrator builds `addStickerPatch`                                                                                        |
| **`set_element_animation`** (EL7) | mutate                     | anywhere                                       | `{ clipId, in?: { kind, seconds }, out?: …, loop?: { preset, period, amount } \| null }` → `add_layer_transition` ops + the `loop_motion` effect                                                                                                                                             |

**Reused unchanged:** `move_clip`, `trim_clip`, `split_clip`, `delete_clip(s)`, `add_keyframes`,
`remove_keyframes`, `punch_in`, `set_clip_blend_mode`, `style_cutout_edge` (sticker outline and
shadow once EL2 lets edge styles read a still's own alpha), `follow_subject` (EL11), `get_frame`
(the agent looks at what it placed — ADR 0183/0186).

Argument conventions match `add_text_layer` exactly (percent of each axis for position, percent of
frame height for size), so a model that has learned titles has learned elements. Lenient argument
handling (`domain-tools/lenient-args`) accepts the words models reach for: `sticker`/`emoji`,
`box`/`rectangle`, `color`/`colour`, `#fff`/`white` (named colours map to the preset palette).

---

## 2. The `elements` tool domain

Tools are disclosed progressively (`tool-domains.ts`); a new tool without a domain fails the shape
test.

- `ToolDomain` gains `elements`: `search_elements`, `add_sticker`, `add_shape`, `set_shape_style`,
  `set_element_animation`.
- `DOMAIN_SUMMARY.elements`: "stickers, emoji and shapes over the picture — highlight boxes,
  arrows, circles, underlines, callouts, numbered badges; find, place, restyle and animate them".
- `DOMAIN_LABEL.elements`: "Stickers and shapes".
- `DOMAIN_REQUEST_WORDS.elements`:
  `/\b(stickers?|emojis?|shapes?|arrows?|circl(?:e|es|ing)|highlight(?:s|ed| box(?:es)?)?|underlin\w*|callouts?|badges?|speech bubbles?|box(?:es)? around|point(?:ing)? (?:at|to))\b/gi`
  — `callouts?` moves here from `effects`; `effects` keeps `graphics?`, `titles?`, `text layers?`.
- A routing test pins real phrasings: "circle the export button when I mention it", "add a fire
  emoji on the punchline", "put an arrow pointing at the price", "highlight the settings menu".
- `sourcing`'s user-facing label becomes "Photos, videos and music" (08).

The domain adds **no** tokens to a run that never loads it; the golden manifests measure the load
cost when it is loaded (§7).

---

## 3. Orchestration

- **`add_shape`, `set_shape_style`, `set_element_animation`** are ordinary mutate tools: build ops
  with the shared `editor-core` builders, return them, the kernel validates and commits.
- **`add_sticker`** follows `add_stock` exactly: the executor calls the host; the host returns the
  asset (and `atSeconds`); the orchestrator arm turns it into operations via
  `stickerOpsFromPayload` (ai-sdk `element-placement.ts`, wrapping the editor-core builder, so an
  agent-placed sticker and a hand-placed one are deep-equal — pinned by a cross-path test in
  `apps/web-editor/src/editor/element-placement.test.ts`, the one package that can import both).
  Several stickers in one turn **acquire in parallel and commit in series** (ADR 0150).
- **Failure is stated, never fabricated.** A refused placement returns the reason and the remedy
  (`ToolRefusalError`), with no varying magnitudes in the message (the repeated-failure guard keys on
  text). A host failure returns `sourcingFailureNote`-style sentences for the element error codes.

---

## 4. Placement policy for element overlays (MD-E4)

`domain-tools/picture-layers.ts` refuses scaled, positioned, faded or blended picture placements
over picture because "the preview paints ONE picture layer at a time" (ADR 0169/0170). Since the
ADR 0180 amendment that is untrue in every build, and ADR 0180 left the relaxation to the AI layer.

**Decision proposed:** an **element** is an overlay by definition. `picture-layers.ts` does not apply
the coverage refusal to clips whose asset `isElementAsset` (stickers); shapes are not picture kinds
and were never subject to it. New ADR: "An element is an overlay". The refusal for _footage_
(photos/videos from Pexels or the bin) stays as it is until EL9 measures agent picture-in-picture
separately.

What the agent **is** held to, in `critic.ts` / verification (advisories, not refusals, except the
first):

| Check                                                                                     | Severity                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| Element entirely off-frame at every sampled time                                          | refusal ("an edit that renders as nothing") |
| Element covers a detected face for > 50% of its span (`measure_subject` / shot ledger)    | advisory                                    |
| Element sits in the platform's unsafe zone (caption band, UI chrome of the export preset) | advisory                                    |
| More than three elements on screen at once                                                | advisory ("busy frame")                     |
| A sticker enlarged beyond 1.5× its sharp size at the export resolution                    | advisory                                    |

---

## 5. What the agent sees

- `list_assets` labels element assets `element` (library, name) and footage tools
  (`map_footage`, `describe_footage`, `index_media`, `search_visual`, `find_similar`) skip them (G9).
- `get_timeline` / the context digest name element clips as `sticker "Grinning face"` and
  `shape "Highlight box" (yellow outline, 18%×9% at 62%, 40%)` — enough to reason about without
  another call, bounded in tokens.
- `get_frame` renders elements through the engine, so the model's visual check is of the real
  export.

---

## 6. The skill

**New:** `packages/ai-sdk/skills/stickers-and-callouts.md`. The description is the discovery
surface and must stay under the 300-character cap (a longer one is silently skipped):

> "Place stickers, emoji and shapes — highlight boxes, arrows, circles, underlines, callouts,
> numbered steps — at the moment the narration names the thing, sized and placed to be read, never
> covering faces or captions. Explains search_elements, add_shape, add_sticker."

Body (craft, grounded in the real tools — reviewed by `editing-skills-expert`):

- **Screen recordings / SaaS demos:** a highlight box or circle lands on the UI element **when it is
  named** (word timing from `get_mapped_transcript`), animates in over ~0.2 s, holds until the next
  beat, leaves before the next callout. One callout at a time. Arrows point _at_, from empty space.
  Colours contrast with the UI underneath (check with `get_frame`).
- **Short-form / talking head:** at most one reaction sticker per beat, off the face
  (`measure_subject`), clear of the caption band; a loop animation only when the moment is
  celebratory.
- **Consistency:** one callout style per video; reuse the same shape preset.
- **Verify:** `get_frame` at the element's midpoint before finishing.

`broll-and-layering.md` keeps stock; its description gains "photos and videos (Elements)" wording
only where it names the panel.

---

## 7. MCP server and parity fixtures

| Tool                                                                       | MCP                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_elements`, `add_shape`, `set_shape_style`, `set_element_animation` | **exposed** (no host needed; `packages/mcp-server/src/tools.ts` descriptor filter includes them)                                                                                                                                                |
| `add_sticker`                                                              | `hostUiOnly` in EL8. Optional EL8b: an MCP materialiser that copies from `FRAMEPILOT_ELEMENTS_ROOT` inside the MCP project sandbox — a new env var, so `.env.example` **and** `turbo.json` `globalEnv` change in the same commit (CLAUDE.md §2) |

Regenerate and review, each as its own measured diff (the diff _is_ the token delta):

- `pnpm --filter @framepilot/ai-sdk` generators: `generate-tool-descriptions.mjs`,
  `generate-skills.mjs`, `generate-autonomous-tools.mjs`, `generate-tool-parity-fixture.mjs`;
- Python mirrors: `ai_tools/tool_descriptions_generated.py`, `skills_generated.py`,
  `tests/fixtures/ts_tool_registry.json` (`test_tool_registry_ts_parity.py`);
- `autonomous-tools.manifest.json` and the token goldens.

`apps/web-editor/src/components/ai/toolMeta.ts` labels: "Search elements", "Add a sticker",
"Add a shape", "Restyle a shape", "Animate an element"; and `search_stock` / `add_stock` become
"Search photos and videos" / "Add a photo or video".

---

## 8. Evaluation cases (run by the maintainer / CI, not in this plan's local steps)

Added to the golden set with expected **timeline outcomes**, judged on the resulting timeline and
the rendered frame, not on tool-call counts:

1. _Screen recording (SaaS demo):_ "Circle the Export button when I say 'export'." → one ellipse or
   highlight-box shape starting within ±0.3 s of the word, containing the button's pixels in the
   rendered frame, gone within 3 s.
2. _Talking head:_ "Add a fire emoji when I say 'this is fire'." → one sticker, within ±0.3 s of the
   phrase, not overlapping the face box, not in the caption band.
3. _Product still:_ "Underline the headline and put an arrow pointing at the price." → an underline
   shape under the headline's text box and an arrow whose end lies inside the price region.
4. _Restyle:_ "Make all the highlight boxes red and thicker." → `set_shape_style` on each, no clip
   moved.
5. _Undo:_ "Remove the stickers." → every sticker clip deleted; footage untouched.

**Last updated:** 2026-09-26
