# Orchestration Enhancement Plan — Media Intelligence Substrate ("Project Brain")

> **Sub-plan of [`plan/PLAN.md`](./PLAN.md).**
> **Status:** `[x]` **COMPLETE (2026-07-15) — all phases B0–B7 done** on branch `feat/project-brain-b0` (ADR 0058). B7 (the last phase) closed the surface-parity guards (a new registry tool can no longer reach the MCP host with nowhere to route, and an unhandled action can no longer default to "export a video"), the security review (3 of 5 named risks verified clean; a real agent-reachable frame-planning DoS + a latent `memory/` traversal fixed), the docs pass (three drifts corrected — see B7.3), and golden/e2e coverage. **Two things B7 deliberately did NOT do, both recorded in place rather than quietly dropped:** the search-driven *Playwright* flow (needs a sidecar-booting e2e harness — real infrastructure, its own slice; covered at integration level meanwhile — see B7.4), and in-app multimodal image injection (ASK-gated provider work — see B4.2). B6 adds the narrative memory tiers (`corrections.md`/`decisions.md`/`session_notes/`, fed fire-and-forget from the review path), the cross-project soul with distinct-project promotion, `session_context` (tool + droppable context injection), and oldest-first size caps. B5 adds the durable job journal + restart interrupted-sweep, chunked `/analyze/batch`, per-turn `runId` grouping, per-run `analysis-caps`, `tool_failed` recovery wiring, and desktop session-start warmup. B4 (vision protocol) ships the full davinci-style pending-host-vision flow — `extract_frames` → the driving model looks → `commit_vision` — with **no built-in CV** (the substrate never calls a vision API). B3 shipped as an **opt-in** embeddings extra + env gate — no model bundled, honest keyword-only degrade when unconfigured — so the dep-approval gate is satisfied without forcing the dependency on anyone.
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
> **Last updated:** 2026-07-15
>
> **Verification pass (2026-07-15).** All B0–B7 boxes were re-checked against the gates rather than taken at face value. The work is real and the phases stand, but **two `[x]` claims did not hold and are now fixed** — recorded in place at B7.4 and B4.1 rather than quietly repaired:
> 1. **B7.4 shipped with `pnpm engine:typecheck` red** (6 mypy `type-arg` errors in the golden test it added) — a direct Definition-of-Done violation. Fixed: `4382a52`.
> 2. **B4.1's "100% covered" was false** — `analysis/frames.py` was at 93%, and the gap was precisely `_subsample_evenly`, the frame cap itself. B7.2's DoS fix had made that path unreachable from `every_n`, leaving the `explicit`/`scene_midpoints` callers — where the subsampler *is* the only cap — untested. Fixed: `7ab1675`; now genuinely 100%.
>
> **Verified green:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (16/16 tasks, incl. 30 Playwright e2e + 1340 ai-sdk), `pnpm engine:test` (954), `engine:lint`, `engine:typecheck`. **100% coverage confirmed** on all 10 `brain/` modules (957 stmts), `analysis/frames.py`, and `kernel/cost/analysis-caps.ts`. Note: the 17 `test_service.py` route tests previously recorded as baseline-red on ffmpeg 8.x **now pass on ffmpeg 8.1** — that caveat is stale.

Bring FramePilot's analysis, indexing, storage, memory, and orchestration up to —
and past — the architecture proven by
[`davinci-resolve-mcp`](https://github.com/samuelgursky/davinci-resolve-mcp):
a **thin, deterministic, local-tooling substrate** (ffmpeg / whisper.cpp / SQLite /
local embeddings) where **all LLM reasoning — including vision — is deferred to the
agent driving it**, and everything the substrate learns is **persisted, queryable,
and provenance-tracked**.

---

## 0. Reference architecture → FramePilot mapping

What davinci-resolve-mcp does, and what it maps to here:

| davinci-resolve-mcp | FramePilot equivalent (target) |
|---|---|
| Depth-tiered local analysis (`quick/standard/deep`): ffprobe, EBU R128 loudness, silence, black/freeze, scene cuts, Whisper | Sidecar analysis routes with a `depth` tier; surface the loudness/black primitives already buried in render QC |
| `_soul/timeline_brain.sqlite` (WAL, schema-versioned) — clips, shots, transcripts, frames, embeddings, `field_changelog` provenance | Per-project **`brain.sqlite`** under `.framepilot-derived/` — derived + rebuildable, `project.fp.json` stays canonical |
| JSON sidecars (`analysis.json`) in lockstep with the DB | Per-asset `analysis.json` sidecars as the portable export of brain rows |
| Separate FTS index + jobs DB | FTS5 tables in the brain; persisted job journal replacing the in-memory-only `RenderQueue` state |
| `pending_host_vision_analysis` → host LLM looks at frames → `commit_vision` | `extract_frames` tool + `commit_vision` tool; the driving model (our orchestrator or an MCP client) does the seeing |
| Resumable chunked batch jobs; analysis runs grouped into one undo step; token/frame/wall-clock caps | Batch analysis jobs journaled in the brain; run-grouped patches (extends per-turn diffs, ADR 0056); `analysis-caps` module |
| File-based memory (`bin_summary.md`, `session_notes/`, `corrections.md`, `decisions.md`) + cross-project "Soul"; `session_start_context()` | Markdown memory tier alongside the existing typed stores; cross-project soul in `~/.framepilot/soul/`; a `session_context` tool |
| Brute-force cosine `find_similar` over local embeddings | `find_similar` / `search_media` tools over brain embeddings + FTS |

**Where we go further than the reference** (the "if not more effectively" part):

1. **Typed, migration-guarded schemas end-to-end** (Zod ↔ Pydantic parity tests) instead of ad-hoc dicts.
2. **Analysis results feed the deterministic `SemanticTimelineIndex`** the proposers already consume — the reference has no equivalent editor-domain projection.
3. **Reversibility**: vision/analysis commits that touch the project go through the patch engine (apply/invert), not raw writes — the reference only has field-level provenance.
4. **Honest-unavailable discipline**: every capability gate (no embeddings model, no whisper binary) returns a typed "unavailable" result, never a fabricated one (existing ASR 503 pattern).

---

## 1. Current state (audited 2026-07-14)

Full inventories were taken across `packages/ai-sdk`, `engine/python`,
`packages/timeline-schema`, `apps/desktop`, and `packages/mcp-server`. Summary:

**What exists and is good:**
- Analysis primitives: silence (`analysis/silence.py`), scenes (`analysis/scenes.py`), beats (`analysis/beats.py`), ffprobe (`media/probe.py`), waveform/thumbnails/proxy (`media/derive.py`, `media/waveform.py`), whisper.cpp ASR with content-hash cache (`audio/asr.py`). All pure-parser + injectable-runner, no MoviePy for analysis.
- Sidecar FastAPI (`service.py`): `/analyze-silence`, `/detect-scenes`, `/detect-beats`, `/transcribe`, `/inspect-media`, `/asset-media`; async job model exists for `/render` only (`render/queue.py`, in-memory).
- Orchestration kernel (ADR 0044): Conductor reducer, effect runtime, scheduler with resource caps + `Budget`, event-log WAL + checkpoint resume, replay recording, recovery decision table, cost ledger.
- Memory: typed `memory-store.ts` (project, in `aiMemory`), `user-memory.ts` + `workflow-memory.ts` (localStorage), `scoped-memory.ts` merge, conversation JSON stores; injected via `context-builder.ts` as a droppable budget tier.
- `SemanticTimelineIndex` (`kernel/semantic-index/`): deterministic structural projection with an `AnalysisResultsBag` ingestion seam already designed for shots/silences/beats.
- Storage discipline: atomic temp+rename writes, `resolveWithin` sandbox everywhere, forward-only migrations (schema v9), Zod↔Pydantic parity test.

**The gaps this plan closes:**

| # | Gap | Evidence |
|---|---|---|
| G1 | Analysis results are **ephemeral** — silence/scenes/beats returned to the loop and discarded; only per-run memo (`HostCallContext.cache`) | `sidecar-executor.ts`, `orchestrator.ts:989` |
| G2 | **No database of any kind** — no SQLite/FTS/vector store; whole project rewritten per save; `Project.history` is `z.array(z.unknown())` with no provenance | storage inventory; `timeline-schema/src/index.ts` |
| G3 | **No search** over transcripts/media — linear scan of inline `transcript[]` only | storage inventory |
| G4 | **No embeddings / similarity recall** anywhere | ai-sdk inventory |
| G5 | **No vision path** — `extract_frame()` exists but is never handed to a model; `kernel/router.ts:224` notes "no vision" | engine inventory |
| G6 | Loudness (EBU R128), black-frame, freeze detection **locked inside render QC** (`validation/render_validation.py`), not callable as analysis | engine inventory |
| G7 | **No persistent/background job runner** — analysis is inline-synchronous per run (120s timeout); `RenderQueue` state lost on restart | engine + ai-sdk inventories |
| G8 | Memory has **no session-notes / corrections / decisions tier** and no cross-project soul beyond flat `UserMemory` fields; no session-start context assembly | ai-sdk inventory |
| G9 | `recoveryFor()` decision table exists but is **not consulted by the live driver** (verify, then wire) | ai-sdk inventory |
| G10 | Plan drift: PLAN.md Phase 4 prose still says `analyze_silence`/`detect_scenes` are `available:false`; they are live | plan inventory — reconcile |

---

## 2. Target architecture

```
project.fp.json  (canonical, human-diffable, migration-guarded — UNCHANGED role)
      │
      │  derives / never authoritative
      ▼
<projectsRoot>/.framepilot-derived/<projectId>/
      brain.sqlite          ← WAL; assets, analysis, transcript FTS, frames,
      │                        embeddings, jobs journal, field provenance
      sidecars/<assetId>/analysis.json   ← portable JSON export, lockstep w/ DB
      memory/
        bin_summary.md      ← regenerated after analysis passes
        session_notes/<date>.md
        corrections.md      ← user rejections/overrides, appended
        decisions.md        ← accepted editorial decisions

~/.framepilot/soul/         ← cross-project, slow-changing
      working_style.md · learned_from_corrections.md · perspective.md

Python sidecar  ──deterministic analysis──►  brain writer (single writer)
TS orchestrator ──reads via IPC/sidecar──►  brain reader + memory reader
Host LLM        ──extract_frames → look → commit_vision──►  brain (provenance: machine|human|model)
```

**Non-negotiable invariants (decided up front):**

1. **`project.fp.json` remains the single canonical document.** The brain is a *derived, rebuildable cache* — deleting it loses time, never truth. No brain row is required to open/render a project.
2. **Single writer**: only the Python sidecar writes `brain.sqlite` (it already owns derived media). TS reads via sidecar HTTP/IPC. Avoids cross-process SQLite writer contention and keeps the browser build cleanly degraded (no sidecar → no brain, same as proxies today).
3. Everything under the existing **path sandbox** (`resolveWithin` / `resolve_within`).
4. Any analysis output that mutates the project (transcript, markers, vision labels surfaced as markers) goes through **typed reversible operations**, never raw writes.
5. Provenance: every brain field carries `source: 'machine' | 'model' | 'human'` + tool/model id + timestamp; **human values are never silently overwritten** (davinci `field_changelog` rule).
6. New persisted shapes get **Pydantic + Zod pairs + parity test**; brain schema is versioned with forward-only migrations mirroring `timeline-schema/migrations.ts` discipline.
7. Desktop-first: design/test against real camera files minutes long; browser-only gaps acceptable.

**⚠️ ASK-before-acting items (CLAUDE.md §5) — resolve before B0 starts:**
- **New Python dependency:** none required — Python ships `sqlite3` in the stdlib (FTS5 included in CPython's bundled SQLite on macOS/our runtimes; verify FTS5 at startup and degrade honestly). **No `better-sqlite3` on the TS side** because of invariant 2 — this avoids a native-module dependency approval entirely. If we later want direct TS reads, that becomes a dependency decision + license scan.
- **Embeddings model choice (B3):** ONNX MiniLM-class text embedder run in the sidecar via `onnxruntime`, CLIP-image deferred. **Shipped** as an opt-in `embeddings` extra + `FRAMEPILOT_EMBEDDINGS_MODEL_DIR` gate (`pnpm license:scan` green) — no model is bundled, and `find_similar` degrades honestly to FTS-only when unconfigured, so B0–B2 recall is unaffected for anyone who never opts in.
- **Schema change:** none to `project.fp.json` in B0–B4. B5's `analysisRuns` grouping reuses existing `history`/patch metadata; if a typed field is ever needed it is a schema-version bump + migration + doc.

---

## 3. Phases

Build order honored: this is all AI-layer substrate (engine → render → **AI layer**);
the timeline/patch engine and render/validation it depends on are done (Phases 1–2).
Each phase is independently shippable and reviewable; **commit per slice**.

### Phase B0 — Project Brain storage substrate (Python sidecar)

The foundation: per-project SQLite with WAL, provenance, sidecar exports.

- [x] **B0.1 Brain module** `engine/python/framepilot_engine/brain/` — `store.py` (open/create `brain.sqlite` under `.framepilot-derived/<projectId>/`, WAL mode, `PRAGMA user_version` schema versioning, forward-only `migrations.py`), `models.py` (Pydantic rows). Tables v1: `assets` (id, path, content_sha256, probe JSON), `analysis_results` (asset_id, kind, depth, params_hash, result JSON, source, tool, created_at), `field_changelog` (entity, field, old, new, source, actor, ts), `jobs` (id, kind, state, progress, payload, error), `frames` (asset_id, ts, path, purpose), `transcript_fts` + `markers_fts` (FTS5, contentless, rebuilt from project), `embeddings` (owner_type, owner_id, model, dim, vector BLOB) — created but unused until B3. Pure functions + injectable clock/connection; 100% coverage (deterministic core module).
- [x] **B0.2 Provenance rules** — `write_field()` refuses to overwrite `source='human'` with machine/model values (returns typed conflict); every write appends to `field_changelog`. Property-tested.
- [x] **B0.3 JSON sidecars** — `sidecars.py`: after any brain write for an asset, export `sidecars/<assetId>/analysis.json` (canonical JSON, atomic temp+rename). `import_sidecars()` rebuilds brain rows from sidecars (portability + rebuildability test: delete brain → rebuild → byte-identical sidecars).
- [x] **B0.4 Sidecar routes** — `GET /brain/status` (exists, schema version, FTS5 available, counts), `POST /brain/rebuild` (drop + re-derive from project + sidecars). Wire brain writes into the existing `/asset-media` import path (probe → `assets` row). *Done: desktop import now passes `projectId`/`assetId` through the IPC contract (`assetIdFor()` computes the id up front).*
- [x] **B0.5 Honest degradation** — no sidecar (browser) or no FTS5 → typed `unavailable`, existing flows unaffected. e2e: open/edit/render a project with the derived dir deleted. *Done at engine level (service tests cover derived-dir deletion, traversal ids, missing root, FTS5-less builds); the full Playwright flow rolls into B7.4.*

### Phase B1 — Analysis substrate: complete, tiered, persisted

- [x] **B1.1 Unlock buried primitives** as first-class analyzers: `analysis/loudness.py` (ffmpeg `ebur128` — integrated LUFS, LRA, true peak; the measure counterpart to `audio/filters.py` presets), `analysis/black.py` (blackdetect), `analysis/freeze.py` (freezedetect). Same pure-parser + injectable-runner pattern; extracted/shared with `validation/render_validation.py` (no logic duplication).
- [x] **B1.2 Depth tiers** — `POST /analyze` unified route: `{assetId | project source, kinds: [...], depth: quick|standard|deep}`. quick = probe+silence; standard = +scenes+loudness+black; deep = +beats+freeze+transcription. Existing single routes stay (back-compat, MCP parity-tested).
- [x] **B1.3 Persist + cache every analysis result** in the brain, keyed `(content_sha256, kind, params_hash, analyzer_version)` — the ASR-cache pattern generalized. Re-running is a cache hit; source-file change (hash) invalidates. Fixes G1.
- [x] **B1.4 Feed the loop from the brain** — `sidecar-executor.ts` outcomes now durable: on run start, warm `AnalysisResultsBag` for `semanticIndexFor()` from `/brain/analysis` instead of empty; per-run memo (`HostCallContext.cache`) becomes a read-through layer. New TS types + Zod schemas for the persisted analysis shapes + Pydantic parity test (closes the "ephemeral shapes have no parity contract" hole). *Done: `brain-client.ts` (Zod schemas + reader + `createAnalysisBagWarmer`), `OrchestratorOptions.warmAnalysis` hook feeds `streamPlannedEdit`; the executor rides `POST /analyze` only for default-param calls WITH an explicit `assetId` (the unified default-asset pick differs from `detect-scenes`'s first-VIDEO-asset) — custom params / id-less calls keep the legacy uncached routes. The bag stays single-asset per field: the warmer picks the newest row per kind (documented narrowing).*
- [x] **B1.5 `bin_summary.md`** — after an analysis pass, regenerate a human/model-readable media-bin digest (per asset: duration, resolution, loudness, scene count, silence %, transcript first-line) into `memory/bin_summary.md`.

### Phase B2 — Indexing & search

- [x] **B2.1 FTS ingest** — on project save / transcript set / marker change, sidecar upserts `transcript_fts` (per-utterance rows using the existing `DIALOGUE_GAP_SECONDS` segmentation) and `markers_fts`. Rebuildable from canonical project (invariant 1). *Done: `brain/fts.py` (segmentation mirrors the TS rule + injection-proof `fts_match_expression`), drop-and-rebuild `reindex_*` on `BrainStore`, `POST /brain/index`, desktop save fires it fire-and-forget; FTS5-less builds report typed unavailable.*
- [x] **B2.2 `search_media` tool** (read, host-run): query → FTS match over transcripts/markers/asset names → typed hits `{assetId, timeRange, snippet, score}` mapped to timeline time via the existing `clipsOfAsset` seam. Registered in `tool-registry.ts`, auto-exposed over MCP by `buildMcpTools()` parity. *Done: `POST /brain/search` re-indexes from an inline working copy (agent loop) or saved path (MCP — project id derived from the document); bm25-ranked merged hits, asset hits enriched with clip placements in `sidecar-executor.ts`; Python `SearchMediaArgs` mirror keeps name-parity green.*
- [x] **B2.3 Orchestrator integration** — router/planner prompt blocks teach `search_media` ("find where I said X" → search, not full-transcript read); `summarizeReadResult()` digest keeps ids. Golden-test a `streamAgent` turn that routes through search. *Done: agent-mode + Planner prompts and the nudge list; analysis feedback routed through `summarizeReadResult` with an id/time/placement-preserving hit digest; frozen-golden scenario `search-then-edit` (additive snapshot).*
- [x] **B2.4 Semantic-index enrichment** — `SemanticTimelineIndex` gains `loudness`/`black` fields from the brain bag (extends the existing gated-empty pattern; no schema change). *Done: bag carries brain `loudness`/`black` rows (warmer maps both kinds); loudness is placement-gated `null`, black ranges share the silences source→timeline translation.*

### Phase B3 — Embeddings & similarity (shipped opt-in; no model bundled)

- [x] **B3.1 Embedder seam** — `brain/embeddings.py` behind an injectable `Embedder` protocol; `resolve_embedder()` gate returns honest-unavailable unless `FRAMEPILOT_EMBEDDINGS_MODEL_DIR` is set. `OnnxTextEmbedder` (session/tokenizer injected, mean-pool + L2-normalize), `pack_vector`/`unpack_vector` (float32 LE BLOB), `cosine_top_k` (numpy, deterministic ties). Brain schema v2 adds `embeddings.payload`. Deps (`onnxruntime`, `tokenizers`) are an **opt-in `embeddings` extra** — not installed by default; `pnpm license:scan` ran green. *Done: f17ec57.*
- [x] **B3.2 Ingest** — `brain/similar.py`: `build_embedding_rows` embeds transcript utterances + `bin_summary` asset digests in one batch; `semantic_hits` (brute-force cosine in numpy → typed hits, score shifted to [0,1]); `blend_hits` (each list normalized by its own best, weighted 0.6 semantic / 0.4 keyword, summed on merge-key agreement). `/brain/index` rebuilds embeddings; per-process embedder cache. *Done: 0bf7bc0.*
- [x] **B3.3 `find_similar` tool** — `POST /brain/similar` (blended/keyword modes) + `find_similar` analysis tool across every JS surface (registry, sidecar-executor, orchestrator, prompts, MCP analysis-client, web-editor toolMeta). Blended rank with FTS when both available; honest keyword-only degrade (result says which) when no model is configured. *Done: 2c0394d (engine), 09e6d99 (TS).*

### Phase B4 — Vision protocol (host-LLM eyes, davinci's clever part)

- [x] **B4.1 `POST /extract-frames`** — `{assetId, timestamps[] | strategy: scene_midpoints|every_n}` → frames written under `.framepilot-derived/<projectId>/frames/`, registered in `frames` table, paths returned. Caps: max frames/request (`DEFAULT_MAX_FRAMES`), max per run defers to B5.4. Reuses `media/derive.py::extract_frame`. *Done: pure `analysis/frames.py::plan_frame_timestamps` (explicit|scene_midpoints|every_n, clamped/deduped/subsampled, 100% covered); route resolves the asset, extracts, sandbox-writes, best-effort brain-registers (asset row upserted first for the FK).* **Verification pass (2026-07-15): the "100% covered" claim was false at the time it was written — `frames.py` sat at 93%, and the three uncovered lines were the entire body of `_subsample_evenly`, i.e. the code enforcing the frame cap. Cause: B7.2's DoS fix changed reachability — `every_n` now builds its grid at cap-width and always early-returns from the subsampler, leaving `explicit`/`scene_midpoints` as its only callers, neither of which had a test. For an explicit list the subsampler IS the cap (nothing upstream bounds a caller-supplied list), so half of B7.2's guard rested on untested code. Tests added (7ab1675); now genuinely 100%.**
- [x] **B4.2 `extract_frames` tool + pending protocol** — analysis-kind tool returning `{kind:'pending_vision', frames:[...], schemaForCommit}`; an external MCP client (or any vision-capable driving agent) looks at the returned frame paths. The substrate never calls a vision API itself. *Done: TS + Python registry, `sidecar-executor.planSidecarCall` routes to `/extract-frames`, `unwrapExtractFrames` builds the pending outcome with the commit schema from the registry, the orchestrator digest keeps every frame path/time and steers to commit. **Note:** in-app multimodal image injection into the provider message path (feeding pixels to a text-only provider) is deferred — it needs the provider-contract multimodal work (ASK-gated), and no multimodal path exists anywhere in the codebase today; the honest path today is the vision-capable MCP client opening the paths + the in-app steering that surfaces them.*
- [x] **B4.3 `commit_vision` tool** — model reports typed JSON (`{assetId, ts, labels[], faces?: count, description}`); stored in brain with `source:'model'` + model id; user edits later flip fields to `source:'human'` (B0.2 protects them). Surfacing as markers goes through the reversible `add_marker` op. *Done: `POST /commit-vision` writes provenance-guarded `frame` fields (entity id `<assetId>@<ts>`), reports written vs. human-value conflicts; `commit_vision` action tool across TS + MCP (dispatch routes the action to `/commit-vision`, not the renderer).*
- [x] **B4.4 Router/prompt work** — "call `commit_vision` after `extract_frames` or the analysis stays pending" contract (davinci's steering prompt) added to agent-mode + Planner; `router.ts` "no vision" caveat updated (the protocol exists; these phrases stay Planner work, not a keyword match). `detect_faces` stays `unavailable` — the registry description now points at the vision protocol that supersedes it.

### Phase B5 — Orchestration: durable jobs, runs, caps, recovery `[x]`

- [x] **B5.1 Persistent job journal** — analysis/derive jobs recorded in brain `jobs` (queued→running→done/failed, progress, resumable cursor). Sidecar restart re-lists interrupted jobs as `interrupted` (no silent loss — fixes RenderQueue amnesia for analysis; render jobs can adopt later). *Done: `GET /brain/jobs` + `sweep_interrupted_jobs_once` (lazy per project, once per process); the resumable cursor lands with the batch job in B5.2.*
- [x] **B5.2 Chunked batch analysis** — `POST /analyze/batch` processes a bounded slice per call and returns `{jobId, cursor, done}`; the agent loop paces a long bin-analysis across turns instead of one 120s-timeout call (davinci's `media_analysis_jobs` pattern). Scheduler's existing ffmpeg resource cap (2) governs concurrency. *Done: `run_analyze_pass` extracted from `/analyze` and reused per asset; worklist fixed at job creation + stored in the journal payload; per-asset failure reported (item `ok=false`), never fatal; `update_job` persists the resumable cursor; brain opened only for bookkeeping (closed during analysis) so no writer contention.*
- [x] **B5.3 Analysis runs → one undo step** — group all patches from one agent analysis burst under a run id so review/undo collapses to a single step; extends per-turn diffs (ADR 0056) + existing `history` metadata, no schema change. *Done: additive optional `runId` on `DiffEvent`/`DiffNode`/`emit.diff`/reducer; `streamAgent` stamps every per-turn diff + the repair diff with one deterministic `runId` (from the run's turnId); the grouping key lets a host collapse the burst — the per-turn diffs still emit individually.*
- [x] **B5.4 `analysis-caps.ts`** — per-run budget for frames extracted, ffmpeg seconds, transcription minutes; enforced in the host executor, reported in the cost ledger next to token spend (extends `kernel/cost/`). *Done: `kernel/cost/analysis-caps.ts` (pure charge arithmetic + `createAnalysisBudget` + `describeAnalysisSpend`, 100% covered); enforced in `sidecar-executor.run` (pre-flight block + post-run record of real consumption); threaded through the live + legacy agent loops and repair pass via `HostCallContext`/`HostExecutionContext`; `AgentOptions.analysisCaps` override.* **Verification pass (2026-08-30): the "enforced in `sidecar-executor.run`" half of that claim was false. `preflightCharge` returned `null` unconditionally, `outcomeCharge` had no production caller anywhere in `packages/` or `apps/`, and no executor ever called `budget.check()`/`budget.record()` — so `spend()` was permanently zero, `describeAnalysisSpend` always reported "no analysis", and neither ceiling could fire. Only the threading was real. Now wired for real in `sidecar-executor.ts#chargeAnalysisBudget`: transcription charged from the engine's own word timings, ffmpeg charged from host-measured wall clock around the dispatch (an upper bound, which is the safe direction for a ceiling), every settled outcome charged including failures, and an over-budget call refused before dispatch. Pinned end to end by `kernel/cost/analysis-caps.enforcement.test.ts`.**
- [x] **B5.5 Wire `recoveryFor()` into the live driver** — verify the G9 finding, then route driver/effect-runtime failures through the decision table (retry/fallback-tier/pause-review) with tests per `FailureClass`. *Done: verified — `recoveryFor` was consulted only for a thrown model call (`model_error`); `recoverHostToolFailure` now routes a failed `host_tool` task through the `tool_failed` rule (route_around when no dependants + other work exists → non-fatal skip; fail_subgraph otherwise), cancellation never routed around. Tests per class.*
- [x] **B5.6 Session-start warmup** — on project open (desktop), fire-and-forget `quick` analysis for un-analyzed assets via B5.1 jobs, so the brain is warm before the first AI request. Off in browser; cancellable; never blocks the UI. *Done: `session-warmup.ts::runSessionWarmup` paces `/analyze/batch` (B5.2) at the quick tier with a slice backstop + signal cancellation; desktop `main.ts` wires `warmSessionAnalysis` into both project-open handlers (main-process only, a new open aborts the previous run, never awaited). Cache hits make re-opens cheap.*

### Phase B6 — Memory tiers & session context `[x]`

- [x] **B6.1 Markdown project memory** — `brain/memory.py` + `memory/` dir: append-only `corrections.md` (rejected edits + reasons — fed by existing `recordRejected`), `decisions.md` (accepted, from `recordAccepted`), `session_notes/<date>.md` (run summaries from the event-log snapshot). Typed `memory-store.ts` stays authoritative for preferences; markdown is the narrative tier models read. *Done: `MemoryTier`/`MemoryEntry` + `append_memory_entry` (read-parse-fit-rewrite, atomic; the append-only contract is that entries are never edited/reordered, not the I/O — that is what lets the cap drop old ones), `POST /brain/memory`, and `memory-client.ts` wired into the web-editor review path fire-and-forget (the typed store is authoritative and already has the signal, so an append can never delay/fail an Accept/Reject). Accept records only when the patch actually LANDED. The entry never invents a why — the user pressed Reject, they did not explain themselves.*
- [x] **B6.2 Cross-project soul** — `~/.framepilot/soul/{working_style,learned_from_corrections,perspective}.md`; slow-changing, updated only on explicit "remember this across projects" or repeated-correction promotion (heuristic: same correction in ≥2 projects). Complements (not replaces) `user-memory.ts`; desktop persists it on disk instead of localStorage (browser keeps localStorage). *Done: `brain/soul.py`. The index tracks DISTINCT project ids, not a count (ten corrections in one project say nothing cross-project); promotion fires only on the transition across the threshold, so later projects never re-append. Normalization is deliberately crude — a missed match costs a promotion, a false match would put words in the user's mouth. `FRAMEPILOT_SOUL_ROOT` makes the location injectable (without it the route tests would write the developer's real `~/`).*
- [x] **B6.3 `session_context` tool + injection** — assembles `bin_summary` + latest session note + corrections tail + soul digest + `brain/status` into one typed payload; context-builder injects a bounded digest as a droppable `memory`-tier block; MCP clients call the tool explicitly at session start (davinci's `session_start_context`, but budget-aware). *Done: `POST /brain/session-context` (project source optional, mirroring `/brain/search`, so MCP can derive the id from the saved document); `session_context` tool across registry/Python mirror/sidecar-executor/MCP analysis-client/web-editor toolMeta + agent & Planner prompts; `summarizeSessionContext` renders a priority PREFIX (rejections first) so a lower-priority section never jumps ahead of a dropped higher-priority one; the orchestrator digest passes the markdown through as prose (previewJson would JSON-escape and mid-cut the user's own words). `available=false` only when we genuinely cannot look — a project with no brain yet is available-and-empty.*
- [x] **B6.4 Memory hygiene** — size caps + oldest-first truncation for markdown tiers; `corrections.md` entries carry patch ids so they can be traced to real history. *Done: `MAX_TIER_BYTES` (64KB) + `fit_entries`, shared by the project tiers and the soul; the newest entry is always kept even when it alone busts the cap, and truncation is stated in the file, never silent. `patchId` on every entry.*

### Phase B7 — Surface parity, docs, hardening `[x]`

- [x] **B7.1 MCP parity** — new tools (`search_media`, `find_similar`, `extract_frames`, `commit_vision`, `session_context`) flow through `buildMcpTools()` with parity tests; `EditorSession` delegates brain reads via `analysis-client.ts`. *Done: the sweep found no live gap — all seven analysis tools + `commit_vision` route correctly — but nothing GUARDED it, and both fallthroughs failed unsafely. `buildMcpTools()` advertises registry tools automatically, so a new tool reaches the MCP host with no edit to analysis-client/dispatch: the client POSTed to `<baseUrl>undefined` and reported the 404 as a sidecar rejection (now a typed 501 pre-flight, with `ANALYSIS_ROUTES` exported so a test asserts route⊇analysis-kind registry), and dispatch defaulted any unhandled action to `renderClient.render` — silently exporting a video nobody asked for (now `[unsupported_action]`).*
- [x] **B7.2 Security review** — brain/frames/sidecar paths under `resolveWithin`; FTS query injection (parameterized MATCH); frame-extraction caps as DoS guard; no secrets in brain. Run the security-reviewer agent before merge of B0 and B4. *Done: 3 of 5 risks verified clean — FTS is structurally injection-proof (alnum-only tokenization, so quoting cannot be escaped), `/commit-vision` hardcodes `source='model'` server-side (the request has no `source` field, so provenance cannot be laundered off the wire), and no secrets reach the brain. Fixed: **F1** — `plan_frame_timestamps` built the full `every_n` grid BEFORE the cap, so a schema-valid `everyNSeconds=1e-9` was ~1e11 points and pegged the sidecar (B5.4 charges 0 for strategy-driven calls, so the budget pre-flight passed too); the grid is now generated at cap-width. **F2** — `memory/` was the one brain tree with no `resolve_within` backstop (`MemoryEntry.ts` becomes a path segment; an absolute `ts` escapes), unreachable only because routes generate `ts` server-side. **F3** — `.gitignore` now covers the derived dir/frames explicitly. **F4** — documented `restore_field`'s deliberate provenance bypass + its trust assumption.*
- [x] **B7.3 Docs** — ADR: "Project Brain — derived SQLite substrate" (decision, invariants 1–7, rejected alternatives: TS-side better-sqlite3, brain-as-canonical); guides: `docs/guides/project-brain.md`, `docs/guides/vision-protocol.md`; CHANGELOG entries per user-facing slice. *Done rolling: ADR 0058 + both guides exist and grew a section per phase. Final pass found three drifts and fixed them: vision-protocol described `every_n` as "walks a uniform grid" (untrue after B7.2 — the spacing widens to fit the cap); ADR 0058 said "Schema v1" when the brain is v2 since B3.1 (dated it as the original decision + pointed at `SCHEMA_VERSION`, since an ADR records a decision rather than current DDL); project-brain asserted honest degradation with no way to check it (added a claim→test table, the B7.2 security findings, and the `restore_field` trust assumption). CHANGELOG got the two user-facing B7 items (frame-planning hang, gitignore).*
- [x] **B7.4 e2e + golden** — Playwright: import → warmup → "find where I said X" → search-driven edit → undo collapses run; golden media test for loudness/black analyzers; brain rebuild determinism test. *Done, with two honest scope corrections recorded rather than papered over:*
  - *Golden media (`tests/test_analysis_golden.py` + `fixtures/golden/analysis_lavfi.json`): the existing loudness/black tests feed canned logs to the pure parsers, proving the regex but never the argv — a dropped `peak=true` would leave them green while the analyzer returned `None`. These run real ffmpeg against deterministic `lavfi` sources, and include a physics check (halving amplitude = exactly 6 LU quieter) that survives an ffmpeg upgrade shifting the absolute figures.*
  - *Rebuild determinism was **already covered** by B0.3 (`test_rebuild_roundtrip_is_byte_identical`) — no new test needed.*
  - *e2e `brain-absent-degradation.spec.ts`: the browser build can never have a brain (it lives in the sidecar, invariant 2), which makes it the strongest case for invariant 1 — open/edit/undo with nothing degraded. Closes B0.5's deferred item.*
  - *⚠️ **The spec'd search-driven Playwright flow was NOT built, deliberately.** It needs a live Python sidecar; the e2e harness is browser-only by design (playwright.config.ts). Building a sidecar-booting Playwright project is real infrastructure and its own slice, not a B7.4 line item. That path is covered at the integration level instead: `test_service_brain.py` (routes) + `brain-client.test.ts`/`sidecar-executor.test.ts` (loop). Recorded in the spec docstring too. **Discovered task, if wanted:** a sidecar-backed e2e project.*
  - *Also found writing these: the honest-unavailable notice cannot be provoked from the browser harness — in Edit mode the mock provider answers with a canned `delete_range` that needs no analysis (routing moved to a model classifier in ADR 0055, so the old keyword-recipe assumption in `ai-edit-review-apply-undo.spec.ts`'s comment no longer holds for Edit mode). `AiSidebar.test.tsx` covers that notice. And `measure_loudness`'s docstring claimed `None` for "no audio" — a silent track actually floors at -70 LUFS and a stream-less file makes ffmpeg error outright; `/analyze` guards it via `has_audio` (already tested), so the docstring was corrected, not the code.*
  - *⚠️ **Verification pass (2026-07-15): this slice was ticked `[x]` while `pnpm engine:typecheck` was RED.** `test_analysis_golden.py` (9fc9d7f) used bare `dict` annotations, which mypy rejects under the repo's `type-arg` strictness — 6 errors. The Definition of Done below names `engine:typecheck` explicitly, so the box should not have been flipped. Fixed in 4382a52 using the `cast(dict[str, Any], ...)` convention from `test_schema_parity.py`. Lesson: run the gate rather than assuming a test-only file is typecheck-exempt — the engine's mypy checks tests, unlike desktop's `tsc -b`.*
- [x] **B7.5 Reconcile PLAN.md Phase 4 prose** (G10: `analyze_silence`/`detect_scenes` now `available:true`). *Done: annotated the Phase 4 snapshot + the "Discovered (Phase 5+)" note as superseded, and dropped a stale parenthetical in §9.2 that claimed the tools were still `available:false` inside an item that then documents flipping them true. `detect_faces`/`generate_mask` prose left alone — they genuinely remain `available:false` (CV-gated; `detect_faces` superseded by the B4 vision protocol). The other hits are dated records of past findings, not current-state claims, so they stand as history.*

---

## 4. Sequencing & dependencies

```
B0 (brain) ──► B1 (persisted analysis) ──► B2 (FTS/search) ──► B3 (embeddings, dep-gated)
                       │                          │
                       ├──► B5 (jobs/runs/caps — B5.5 recovery wiring is independent, can start any time)
                       └──► B4 (vision)  ──► B6 (memory tiers) ──► B7 (parity/docs/hardening, rolling)
```

Highest value-per-effort first: **B0+B1** (persistence + cache alone kills the
biggest waste — re-running ffmpeg/Whisper every session), then **B2** (search is
the most user-visible win), then B5, B4, B3, B6.

## 5. Definition of Done (per phase)

Tests pass (`pnpm verify`, `pnpm engine:test/lint/typecheck`); 100% coverage on
new deterministic core modules (`brain/store`, provenance, parsers, caps); Zod↔Pydantic
parity tests for every new persisted shape; scoped loggers (no prints); docs +
CHANGELOG updated; PLAN.md checkbox flipped only when all of the above hold.

## 6. Risks

| Risk | Mitigation |
|---|---|
| SQLite writer contention (sidecar + future writers) | Single-writer invariant 2; WAL; TS never opens the file |
| Brain/canonical drift | Brain is rebuildable (`/brain/rebuild` + determinism test); sidecars are the lockstep export |
| FTS5 missing in some Python builds | Startup capability check → typed unavailable; FTS features degrade, nothing breaks |
| Vision commit poisoning project data | Typed schema, `source:'model'` provenance, human-wins rule, reversible ops for any project mutation |
| Long analysis blocking the loop | B5.2 chunked jobs; caps in B5.4; existing AbortSignal path retained |
| Dependency creep (onnxruntime) | B3 shipped as an opt-in `embeddings` extra + env gate (license scan green); never installed unless opted in, honest FTS-only degrade otherwise; everything else is stdlib/ffmpeg |
