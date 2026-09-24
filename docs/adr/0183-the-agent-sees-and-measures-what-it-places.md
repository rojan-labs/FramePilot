# ADR 0183 — The agent sees what it edits, and measures what it places

- **Status:** Accepted. The maintainer asked, on 2026-09-24, to "investigate why [the edit is worse
  than ever] … and fix everything end to end", naming visual understanding and placement detail.
- **Date:** 2026-09-24
- **Relates to:** ADR 0069/0071 (caption templates, cues), ADR 0088 (effect layers), ADR 0169
  (picture coverage), ADR 0178 (mask stack), plan `EQ1–EQ12` in [`plan/PLAN.md`](../../plan/PLAN.md).

## Context

The evidence was the maintainer's own project (`project_test_new_project`): 22 runs in
`framepilot.runs.jsonl`, the seven desktop conversations behind them, the project file and its undo
history, its brain, and its exported MP4 read frame by frame. What made the edit look unedited was
mostly the platform, not the model's taste:

- **The agent was blind at the moments it looked.** After _Remove background_, every engine request
  built from the model's projection of the project dropped `asset.media`, which a v22 cut-out needs:
  all seven reviews, every `get_frame` and every colour measurement on 09-23 failed. The desktop's
  default provider (Claude Agent SDK) carried no images at all, so `get_frame` was not even offered.
- **Placement was guessed.** A "MOTION" title was set behind the speaker at 20 % of the frame
  height — wider than a 9:16 frame — with no idea where the head was. Its title width estimate was
  off by −24 %…+33 % against the rasterizer. The sandwich was then nested (a copy of a copy), and
  its front cut-out was later switched to _Subtract_, which draws nothing: the title sat on the face
  while every tool said "behind".
- **Captions were built and then lost.** The export dialog defaulted to not burning them (0 of 45
  cues in the file); two cues were moved onto an overlay track where nothing renders them; off-white,
  un-outlined captions sat on a cream shirt at 1.1–2.0 : 1 contrast; the export burned them _before_
  a radial blur and a vignette, which the monitor (a DOM overlay) never showed.
- **"Only one real cut."** A b-roll-heavy short has no same-layer cuts; the edges that matter are
  where inserts enter and leave, and no tool could see or treat them.

## Decision

1. **Engine requests use the engine's projection** (`ai-sdk/engine-view.ts`): the working document
   with `asset.media` kept and only waveform peaks and thumbnail lists dropped. The model's compact
   projection is for the model, never for a renderer.
2. **The Claude Agent SDK provider carries images** as content blocks, so every provider that can see
   is offered `get_frame` and the look-at-your-work contract.
3. **Placement is measured, not guessed.** `measure_subject` (`POST /analyze/subject-layout`) reads
   the cut-out on the delivered frame and answers where a given word, at a given size and font, reads
   as behind the person — centred on the person, within the title-safe width, resized in the
   direction that works, or an honest "no position works" with the advice that fits the shot.
4. **Title widths come from the font files.** A generated table
   (`title_metrics.py` → `title-metrics.generated.ts`) holds each bundled face's glyph advances and
   ink edges; the agent's fit and the engine's fit land on the same size. A drift test fails when
   the fonts change and the table does not.
5. **A text-behind sandwich is one per shot and its cut-out must draw the subject.** Titles reuse
   the shot's layers with their own time range; a cut-out that draws nothing from an empty stack
   (Subtract/Intersect/Darken, inverted, zero opacity) refuses the title with the remedy, in both
   editor-core and the measurement.
6. **Captions are delivery text.** They burn above effect layers; the export burns them whenever
   the timeline has them (dialog and MCP); cues can only live on caption tracks; and
   `check_caption_legibility` measures contrast against the actual picture with a keyed frame (the
   caption layers alone, text in a key colour), which finds the letters exactly at a fraction of
   the cost of a second picture render.
7. **Cutaway edges are edit points.** `list_edit_boundaries` lists them; `add_layer_transition`
   treats one (entrance on the insert, end-aligned exit); `add_transitions includeCutaways` plans
   them by reason, keeps them hard on `auto`, and only lets dissolves and wipes exit.

## Consequences

- Every measurement above is checked against the maintainer's real project, not only fixtures:
  a live Agent SDK image call; frames rendered after a cut-out; the Subtract matte rendering a black
  front copy and the Add matte occluding the word; caption legibility 1.1–2.0 : 1 before and ≥ 9.4 : 1
  with an outline; the opening caption crisp over the radial blur.
- Three new model-facing tools (`measure_subject`, `check_caption_legibility`, plus
  `includeCutaways` on `add_transitions`) cost +435 input tokens per turn in the golden manifests,
  most of it `measure_subject` and the title font enum; `check_caption_legibility` loads only with
  the captions domain.
- Existing projects are not migrated: a nested sandwich, a Subtract cut-out or a cue on an overlay
  track stays until someone edits it — the tools now refuse to build on the broken state and name
  the fix.
- The preview's optional burn-captions mode still draws captions before its effect post-process;
  its default (the DOM overlay) already matches the export.
