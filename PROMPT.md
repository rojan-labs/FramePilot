# PROMPT — FramePilot Full-System Mission: Orchestration, Context, Editing Quality, UX, Performance

> Hand this entire file to the coding agent as the task. It supersedes the earlier
> UI-only brief that lived here. It is deliberately long: it is the whole mission,
> not one ticket. Read it once fully, then work it in the order given in §3.

You are the **principal engineer responsible for FramePilot becoming a serious,
professional-grade AI video editor**: AI systems architect, agent-orchestration
engineer, video-editing systems engineer, performance engineer, and product UX
engineer in one. You are operating autonomously. Do not ask what to do next.

---

## 0. Ground rules (non-negotiable)

1. **Read `AGENTS.md`, then `CLAUDE.md`, then `plan/PLAN.md`, then
   `.agents/rules/*.mdc` before touching code.** They are the canonical working
   rules; this file adds the mission on top of them, it does not replace them.
2. **Desktop is the product.** `apps/desktop` (Electron, `fp-media://`, the Python
   sidecar, on-disk media) is the primary target. Design, test, and measure against
   it with real camera files minutes long, not tiny fixtures. Browser-only gaps may
   be deferred; desktop regressions may not.
3. **Every edit is a typed timeline operation** in `packages/editor-core` with
   `apply` + `invert`, validated before apply. The AI layer emits patches, never raw
   `project.fp.json` mutations. MoviePy/FFmpeg in `engine/python` render; the UI
   previews with HTML video / canvas / proxies. Do not blur these lines.
4. **Schema changes require a migration**, `timeline-schema` (Zod) and the Pydantic
   models must stay in sync, and env vars have one source of truth
   (`.env.example` + `turbo.json` `globalEnv`).
5. **Pause and ask only at these five gates** (from `CLAUDE.md` §5): adding or
   upgrading a dependency; changing the timeline/project schema; destructive or
   irreversible file/git operations; broadening the path sandbox, IPC surface, or
   agent tool permissions; introducing a new subsystem/runtime/store/protocol that
   the product-scope gate cannot tie to a measured gap. Everything else: decide and
   proceed.
6. **Measure before and after.** No optimization claim without a number. No
   editing-quality claim without the actual timeline outcome (and render-backed or
   deterministic evidence for visual/audio claims).
7. **Lower token usage is not a success if editing quality decreases.** Editing
   quality is the product; efficiency serves it.

## 1. Core principle: correct system over preserved system

Do not keep the current architecture because it exists. When the architecture
blocks the desired behavior, change the architecture — orchestration, context
management, worker execution model, prompts, state management, UI interaction,
export pipeline. Use this decision process on every problem:

```text
Can the current architecture solve it correctly?
  YES → implement cleanly.
  NO  → name the constraint → design the correct structure → migrate the
        affected components → delete the obsolete path → test the whole system.
```

Never stack workarounds on a broken structure. But "structural change" is not
"big-bang rewrite": deliver structure as an ordered sequence of reviewable
commits, each leaving the tree green and the product working. `packages/ai-sdk`
alone is ~34k LOC with ~2.4k tests and a 100% coverage gate; earn a rewrite there
with measurements, and replace pieces behind stable contracts, not all at once.

## 2. Build the system model first

Inspect, in this order, and write the resulting map to
`docs/architecture/system-map.md` (create or update):

- Rules and plans: `AGENTS.md`, `CLAUDE.md`, `PRD.md`, `plan/PLAN.md`,
  `.agents/`, `.claude/`, `.codex/`, `docs/adr/`, `docs/architecture/`.
- AI layer: `packages/ai-sdk` — `kernel/` (the Conductor reducer), `controllers/`,
  `proposers/`, `domain-tools/`, `editor-context/` (context builder), `skills/`,
  `providers/`, `reliability/`, `eval/`, the autonomous tool contract/router,
  the acceptance and run-quality gates, and the golden token manifests.
- Editing engine: `packages/editor-core`, `packages/timeline-schema`.
- Render/analysis: `engine/python` (MoviePy, FFmpeg, ASR, silence/beat analysis,
  captions, sidecar HTTP surface).
- Shells: `apps/desktop` (main process, IPC, `fp-media://`, sidecar lifecycle,
  proxies), `apps/web-editor` (React editor, AI sidebar, timeline, preview,
  inspector, media bin, state stores, persistence), `packages/ui`.
- Peripheral surfaces: `packages/mcp-server`, `packages/capability-packs`,
  `packages/shared-types` (logger), CLI entry points.
- Tests and CI: unit, `tests/`, Playwright e2e, golden media, `.github/`,
  `turbo.json` pipelines.
- Existing evidence: `framepilot.runs.jsonl`, `reports/`, `docs/performance/`,
  `docs/quality/`, `TOOL_REPORT.md`, `UI_AUDIT.md`.

Model the flow end to end and mark every boundary where data changes shape:

```text
User → Chat/UI → context ingestion → context assembly → orchestrator →
planning → tools/workers → editor-core patches → timeline → preview → export
```

## 3. Order of work

**The executable plan for this brief is `plan/system-mission/`** — start at its
`README.md`, then `00-BASELINE.md`. The sections below are the intent; the plan files carry
the tasks, file paths, gates, and evidence per phase. Keep both in sync.

Work phases in this order. Each phase ends with a measured checkpoint committed
to `docs/reports/` and reflected in `plan/PLAN.md`.

1. **Baseline** (§4) — measure everything before changing anything.
2. **Orchestration + context** (§5–§8) — the highest-leverage system.
3. **Prompt audit and parity** (§9).
4. **Reference video and image context via the AI sidebar** (§10) — the
   first user-visible capability; it exercises the new context system.
5. **Editing quality and verification loop** (§11).
6. **Memory/resource and worker lifecycle** (§12).
7. **Export pipeline** (§13).
8. **UI/UX audit and fixes** (§14).
9. **E2E, regression, and efficiency tests** (§15).
10. **Final verification and report** (§16–§17).

Reorder only if a baseline measurement shows a different bottleneck dominates,
and record why in the checkpoint.

## 4. Baseline — measure, do not guess

Produce `docs/reports/baseline-<date>.md` with numbers for:

**AI/orchestration** — model calls per turn, orchestration rounds per task,
prompt/context/output token sizes, repeated-context share across calls, repeated
tool calls, repeated media analysis, calls that could be deterministic, cached, or
parallel; what context is passed into workers and back into the main agent.
Instrument through the existing eval harness and run logs where possible.

**Editing** — success rate on the scenario set in §15, incorrect edits, invalid
operations, timeline inconsistencies, repeated corrections, unnecessary
operations, tool and runtime failures.

**Application** — memory, CPU, GPU where relevant, process count, worker
lifecycle, file handles, media buffers, caches, subscriptions, timers, listeners,
large React state, IPC traffic — at idle, during a long timeline session, during
an AI turn, during export.

**Export** — startup latency, encode time, CPU/GPU utilization, intermediate
renders, repeated media processing, disk I/O, memory, failure rate, progress
accuracy.

**UI/UX** — a walkthrough of navigation, timeline, preview, chat, media bin,
upload, drag/drop, selection, undo/redo, loading/error/empty states, shortcuts,
progress, accessibility, information hierarchy. Screenshots where useful.

## 5. Orchestration redesign

Identify where the current loop is
`think → tool → think → tool → recall context → tool …` when planning plus
deterministic execution would do. Separate the concerns explicitly:

```text
Intent (what the user wants)
→ Context assembly (what the system already knows)
→ Plan (what must happen)
→ Specialized / parallel execution (which operations)
→ Deterministic execution through editor-core
→ Verification (did it actually happen, is it good)
→ Bounded refinement
→ Result
```

For every model call in the flow, answer in writing: why does it exist; could it
be deterministic, cached, parallelized, given less context, delegated to a
worker, or replaced by structured state; does it produce information another
call already has. Remove duplicate calls, duplicate context, repeated media
analysis, repeated tool discovery, repeated state reconstruction, and planning
loops that do not change the plan. Target: **maximum editing intelligence per
token and per call.**

## 6. Context as a first-class system

Design context in scoped layers and decide what lives in each:

```text
Persistent project context · Session context · Turn context ·
Relevant media context · Timeline context · User preferences ·
Prior decisions (approved / rejected) · Worker results · Active task state
```

Implement deduplication, summarization/compaction, relevance-ranked retrieval,
prioritization, caching, invalidation, and versioning where needed. Represent
facts as **structured state, not prose**, so the model never rediscovers them
from history:

```text
project:  { aspectRatio: "9:16", duration: 32.4, fps: 30 }
timeline: { selectedClip: "clip_42", currentTime: 14.3 }
task:     { goal: "fast_paced_montage", status: "planning" }
```

Persist across turns so users never repeat "same style", "same pacing", "the
reference I uploaded". Track style decisions, editing preferences, reference
assets, selected media, timeline decisions, approved and rejected approaches,
current objective, known constraints. Give context TTL, relevance scoring,
invalidation, and scoping — old, irrelevant context must disappear. Reuse the
existing Memory Store in `packages/ai-sdk` (PRD §8.7); do not create a parallel
store.

## 7. Specialized workers — only where they earn it

Candidate roles: director/intent, media analysis, editing planner, timeline,
motion graphics (text, keyframes, effects, transitions), audio (music, beats,
SFX, voice), visual style (color, composition, reference matching), critic,
runtime executor, export. For each, decide from the baseline whether
specialization measurably improves accuracy, context relevance, parallelism,
token efficiency, reliability, or editing quality. Introduce a worker only when
it does. No worker explosion.

Workers get **small, purposeful context windows** — never the whole
conversation. Communication is through typed contracts, not transcripts:

```text
WorkerInput { task, context, constraints, inputs }
WorkerOutput { outputs, artifacts, confidence, errors }
```

The orchestrator keeps only what later decisions need. Define lifecycle
semantics — created → ready → running → idle → failed → recovering →
terminated — with timeouts, cancellation, restart, cleanup, backpressure,
resource limits, duplicate-work suppression, and orphan detection.

## 8. Verification / critic loop

AI plans do not become final edits unverified. Where it adds value:
`plan → execute → inspect → critic → fix → verify`, checking user intent,
timeline validity, timing, pacing, continuity, visual quality, audio sync,
transitions, captions, composition, overlaps, invalid references, missing
assets, runtime errors. Bound the loop. Prefer deterministic checks in code
(editor-core validation, acceptance gates) over model self-reflection wherever a
check can be expressed deterministically.

## 9. Prompt audit and parity

Audit every prompt the model reads: system contract, context-builder blocks,
tool names/descriptions, mode instructions, skill descriptions. Remove
redundancy, contradictions, verbosity, ambiguity, weak output schemas, missing
constraints, injection surfaces, and instructions that should be code
guarantees. Optimize for precision, shorter context, structured output,
deterministic behavior, fewer rounds, better tool selection. Do not make prompts
longer. Move deterministic logic out of prompts into code. Remember skill
descriptions are the discovery surface and golden manifests track prompt text —
regenerate goldens and treat the diff as the measured token delta.

Audit parity across desktop, web editor, runtime, sidecar, workers, CLI, MCP
server, and tests: same operation, same prompt, same tool definition, same
schema, same system instructions. Create one source of truth; where two must
differ, document why next to the code.

## 10. Reference videos and images in the AI sidebar

Ship a first-class attachment flow: upload one or more reference videos and
images, preview them, remove them, see them listed, and reference them
naturally ("make mine feel like this"). Analyze each attachment **once**, store
structured results, reuse them; never dump raw image data or bulk metadata into
every call.

From video references extract editing rhythm, shot duration, transition style,
color characteristics, caption style, camera movement, framing, motion
graphics, music character, pacing, visual hierarchy — and convert them into
editing constraints and style context, not copied content. From images
understand the role (brand, logo, design, thumbnail, style, B-roll, character,
color reference) and store that role with the analysis. Follow the full path:
entry → analysis → context → plan → patch → validate → preview → undo → error
state → tests.

## 11. Editing quality

The AI must reason about the media and the timeline, not blindly move clips.
Evaluate cut decisions, clip selection, timing, pacing, beat sync, B-roll,
captions, transitions, motion graphics, audio, color, composition, story
structure, continuity, instruction following, reference-style application.
Prefer semantic operations (`cut_to_beat`, `create_hook`, `tighten_pacing`,
`insert_broll`, `emphasize_word`, `match_reference_style`,
`create_transition`, `add_motion_graphic`) over exposing only low-level ops —
built on top of existing editor-core operations, not beside them.

## 12. Memory, resources, and lifecycle

Do a real end-to-end leak investigation. Frontend: React state/effects,
listeners, timers, subscriptions, web workers, object URLs, video elements,
canvases, image buffers, large arrays, media and query caches. Desktop main
process: IPC listeners, child/worker processes, FFmpeg/ffprobe processes, file
handles, temp files, native resources. Sidecar/backend: long-lived processes,
emitters, caches, streams, queues, pools. Media: frames, audio/image buffers,
encoders, temp files. Find leaks, retained references, unbounded caches,
orphaned processes/workers, missing cleanup, duplicate subscriptions, object-URL
leaks. Fix ownership and lifecycle at the source; never raise a memory limit as
the fix.

## 13. Export pipeline

**Export UX is quality-driven, like CapCut — not platform-driven.** There are no
"Export for Instagram / Reels / TikTok / YouTube" destinations. Remove any
platform-named export preset, button, command, or copy that exists today
(including the `/export-reels` command surface, which becomes plain export with
the project's aspect ratio). The export dialog offers:

- **Resolution:** 480p, 720p, 1080p, 2K (1440p), 4K (2160p) — capped at the
  source's maximum with a clear note when a choice would upscale.
- **Frame rate:** 24, 25, 30, 50, 60 — defaulting to the project/source rate.
- **Quality / bitrate:** Low / Recommended / High, plus a custom bitrate field;
  show the estimated file size live.
- **Codec:** H.264 (default), HEVC; **format:** MP4 (default), MOV.
- **Aspect ratio** comes from the project; the dialog shows it, it does not
  offer platform crops.
- Output location and filename, a "Reveal in Finder / open folder" action on
  completion.

Defaults must produce a good result with zero changes; advanced options stay
one click away, not in the way. Persist the last-used choices per project.

Profile FFmpeg invocation, encoder settings, codec choice, hardware
acceleration, parallelism, intermediates, re-encoding, timeline flattening,
asset preparation, disk I/O, memory. Target
`timeline → dependency analysis → only required assets → efficient composition
→ single optimized encode`. Add accurate progress, ETA where reliable,
cancellation, error reporting, recovery, export history/status, clear output
location, and background export where the architecture supports it. Report
before/after on real desktop-scale media.

## 14. UI/UX audit against professional creative tools

Compare interactions with Premiere, Resolve, CapCut, and modern tools like
Linear/Figma. Cover timeline, preview, inspector, AI sidebar, chat, media
browser, upload, drag/drop, selection and multi-selection, context menus,
shortcuts, undo/redo, loading, progress, errors, empty states, tooltips,
modals, panels, resizing, focus management, responsiveness, accessibility. Fix
the root interaction problem, not colors or spacing. Respect `DESIGN_SYSTEM.md`
and the token-driven styles.

The AI sidebar must make clear **what the AI knows, is doing, changed, needs,
and what failed** — attachments with previews, current selection and timeline
awareness, progress, tool activity, result summaries, errors, undo/revert.
Hide internal reasoning and raw tool output.

## 15. Tests and metrics

- **E2E journeys** (Playwright, desktop-first): open project → import media →
  attach reference video and image → ask for an edit → analysis → plan →
  execution → timeline updates → refine → AI remembers context → second change
  modifies the existing edit → preview → export → verify output.
- **Failure paths**: model, tool, worker, runtime, invalid media, large media,
  cancellation, network, export failure, restart, recovery.
- **Editing regression scenarios**: 30-second social montage, podcast
  highlight, remove dead air, add captions, sync cuts to music, apply reference
  style, add B-roll, animated captions, motion graphics, refine an existing
  edit. Each asserts the actual timeline outcome.
- **Efficiency metrics** tracked in the eval harness: tokens per turn, calls per
  task, context size, repeated-context %, worker tokens, planning rounds, tool
  calls, edits per call — with before/after comparison.
- Keep unit/integration coverage meaningful; the ai-sdk coverage gate stays
  green. Remember Playwright's substring role matching versus RTL's exact
  matching when adding labels.

## 16. Working loop and git

Run this loop until further investigation stops producing actionable issues:
observe → measure → understand → trace → root cause → design → implement →
test → try to break it → discover → fix → measure again → reassess. Issues you
discover that touch the affected systems (leaks, races, wrong state, broken
error handling, context/prompt/tool/worker bugs, UI inconsistencies, export
problems, parity gaps) are in scope — fix them to the root.

Git: work on a dedicated branch off `main`; conventional, meaningful commits
(`feat(orchestration): …`, `refactor(context): …`, `fix(prompts): …`,
`feat(ai-sidebar): …`, `fix(runtime): …`, `perf(export): …`); push regularly;
one coherent goal per commit; never one giant final commit. Keep `plan/PLAN.md`
current (`[~]` on start, `[x]` only at Definition of Done), and update `docs/`,
ADRs, and `CHANGELOG.md` for every user-facing or architectural change,
documenting **why**.

## 17. Definition of done

Not "it builds". Done means all of the following are true and evidenced:

- Orchestration reviewed and restructured where measurement justified it;
  model calls and rounds per task down, editing quality held or up.
- Context is layered, structured, deduplicated, persisted, invalidated, and
  retrieved by relevance; users do not repeat themselves.
- Prompts audited and optimized; prompt/tool/schema parity resolved or
  documented.
- Workers exist only where they earned it, with typed contracts and full
  lifecycle handling; no orphans.
- Reference videos and images work end to end through the AI sidebar.
- Verification loop in place and bounded; deterministic checks preferred.
- UI/UX audited against professional tools; root interaction problems fixed.
- Memory/resource behavior investigated end to end; leaks fixed at the source.
- Export is a CapCut-style resolution/quality dialog (no platform presets
  remain anywhere), measured and improved on desktop-scale media; reliable,
  cancellable, accurate progress.
- E2E, failure/recovery, editing-regression, and efficiency tests pass;
  `pnpm verify` green.
- No workaround remains where a structural fix was required; obsolete paths
  deleted.
- Plan, docs, ADRs, changelog updated.

## 18. Final engineering report

Write `docs/reports/full-system-mission-<date>.md` with: architecture before
(the real problems) · architecture after · root causes found · structural
changes · orchestration improvements (calls, tokens, context, workers,
parallelism, before/after) · editing quality improvements (concrete) · UI/UX
improvements · memory fixes · export improvements (numbers) · all validation
performed · remaining issues (genuinely unresolved only; otherwise write
"No known actionable issues remain within the investigated scope.").

---

**Optimize for:** editing quality × context quality × reliability × speed ×
token efficiency × UX × architectural integrity.
**Do not optimize for:** small diffs for their own sake, preserving the current
implementation, tests passing superficially, avoiding refactors.

Start by reading the repository instructions and mapping the current
architecture. Do not ask what to do next.
