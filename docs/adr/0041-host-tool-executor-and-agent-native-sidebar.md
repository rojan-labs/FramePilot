# ADR 0041 — Host Tool Executor Seam and the Agent-Native Sidebar

- **Status:** Accepted
- **Date:** 2026-07-06
- **Plan:** `plan/AGENT-NATIVE-UX.md` (Phases T, U, P, B) · `plan/PLAN.md` Phase 16

## Context

The agent-mode transcript in `references/d634b706…md` showed a systemic
truthfulness failure: `analysis`/`action` tool calls (analyze_silence,
detect_scenes, render_preview) were reported **completed instantly with no
data** — the orchestrator fabricated success for tools it had no way to run
("runs on the host", with no host attached). Consequences cascaded: the model
looped re-requesting analysis it never received, tool cards showed checkmarks
for work that never ran, the loop did not wait on prerequisites, and mid-run
assistant text was folded into the reasoning panel instead of the chat.
Separately, thumbnails-on zoom lagged the whole app: each clip rendered up to
16 `background-image` divs whose JPEGs/data-URLs re-rasterized on **every zoom
tick × every clip**.

## Decision

1. **HostToolExecutor seam (`packages/ai-sdk/src/tool-executor.ts`).** The
   orchestrator takes an optional `executor` in its constructor options. The
   agent loop **awaits** `executor.run(call, { project }, signal)` between a
   tool card's `running` and terminal events, feeds the returned `data` back
   into the model's next-turn context (bounded preview), and memoizes
   identical requests per run. **No executor ⇒ the call fails honestly** with
   an actionable note — success is never fabricated. Abort settles the card as
   the new `cancelled` status, never a checkmark.
2. **Sidecar executor (`sidecar-executor.ts`).** One implementation for every
   JS surface (desktop main via `net.fetch`, browser via an explicit
   `VITE_FRAMEPILOT_PYTHON_API_URL`, MCP via its analysis client) that POSTs
   the agent's **in-memory working project inline** to the FastAPI analysis
   routes — the sidecar still sandbox-checks every media path (an inline
   project cannot widen what the engine may read). Render/export remain
   engine-side (render-vs-preview rule) and report "not runnable from the AI
   panel yet" rather than pretending.
3. **`detect_beats` analysis capability.** numpy-only energy-flux onset
   detection + median-interval BPM in `engine/python/framepilot_engine/analysis/beats.py`
   (no librosa; ffmpeg decodes to PCM), exposed as `/detect-beats` and a
   registry analysis tool on both schema mirrors.
4. **Event-model additions (all additive).** `ToolStatus` gains `cancelled`;
   `ToolCallEvent`/`ToolNode` gain `argsSummary`; `ReasoningNode` derives
   `thoughtMs` from event timestamps; tool nodes keep their *running*
   timestamp across transitions so the UI can show live elapsed time.
5. **Agent-native sidebar semantics.** Mid-run model text streams into a NEW
   assistant segment per turn (interleaved with tool cards, Cursor-style);
   reasoning holds only real thinking and settles into "Thought for Ns" at
   first output; `planFirst` plans emit immediately as a pending todo ledger
   whose steps flip pending → running (turn intent as `detail`) →
   completed/failed; runs that applied edits close with a markdown completion
   report (what changed, what was skipped and why).
6. **Filmstrip performance root fix.** One decoded-`ImageBitmap` LRU per
   source URL (`bitmapCache.ts`, evictions `close()` bitmaps); ONE canvas per
   clip blitted from cached bitmaps (backing store clamped per ADR 0040);
   during a zoom gesture the canvas content is frozen (CSS-stretched) and
   redrawn once ~120 ms after the last resize.

## Consequences

- Tool cards, plan steps, and the run status now report only what actually
  happened — the "instant checkmark" class of bugs is structurally gone, and
  a stopped run shows `cancelled`, never success.
- Any host can wire real analysis by injecting one object; hosts without an
  engine degrade to honest failure instead of silent lies (one policy across
  browser/desktop/MCP, invariant 6).
- Zoom cost is now bounded by slot-bucket crossings + one settle redraw
  instead of per-tick re-rasterization per clip (guarded by
  `ClipFilmstrip.perf.test.tsx`).
- The event log remains append-only and replayable; all additions are
  backward-compatible (old logs render unchanged).
