# The Project Brain — persisted media intelligence

FramePilot's engine sidecar keeps a **project brain**: a per-project, derived
SQLite database that remembers everything analysis learns about your media —
probes, content hashes, silence/scene/beat/loudness results, and full-text
searchable transcripts/markers. It exists so the AI never has to re-run ffmpeg
to re-learn something it already knew, across sessions and across runs.

**WHY it is safe to have:** the brain is a *cache with provenance*, never a
second source of truth. `project.fp.json` stays the single canonical document
(invariant 1); deleting `.framepilot-derived/` loses time, never work. See
[ADR 0058](../adr/0058-project-brain-derived-sqlite-substrate.md) for the
design decision and invariants.

## On-disk layout

```
<projects root>/.framepilot-derived/<projectId>/
├── brain.sqlite                      # the store (WAL; written ONLY by the Python sidecar)
├── sidecars/<assetId>/analysis.json  # portable, human-diffable export (kept in lockstep)
└── memory/                           # the markdown tiers a model reads as prose
    ├── bin_summary.md                #   media-bin digest, regenerated per pass (B1.5)
    ├── corrections.md                #   edits the user rejected, and why (B6.1)
    ├── decisions.md                  #   edits the user accepted (B6.1)
    └── session_notes/<date>.md       #   per-day run summaries (B6.1)

~/.framepilot/soul/                   # cross-project, outside any project (B6.2)
├── working_style.md
├── learned_from_corrections.md
├── perspective.md
└── corrections_index.json            # bookkeeping for the promotion heuristic
```

Every project path is sandbox-checked (`resolve_within`); asset/project ids
arriving over IPC are treated as untrusted path segments. The soul lives outside
the sandbox by design (it belongs to the user, not a project); its location is
overridable with `FRAMEPILOT_SOUL_ROOT`, and its filenames come from a closed
enum, never from input.

## The analysis substrate (plan B1)

### Depth-tiered unified analysis — `POST /analyze`

One route runs a whole pass over an asset:

| depth      | analyzers                                             |
| ---------- | ----------------------------------------------------- |
| `quick`    | probe + silence                                       |
| `standard` | quick + scenes + loudness + black                     |
| `deep`     | standard + beats + freeze + transcription             |

An explicit `kinds: [...]` list overrides the tier. Each analyzer settles to a
typed entry — `ok | skipped | unavailable | failed` — and one failing analyzer
never aborts the rest. Incompatibilities are honest skips (scene detection on
an audio file), missing capabilities are honest `unavailable` (no whisper
model), never fabricated results.

The pre-existing single routes (`/analyze-silence`, `/detect-scenes`,
`/detect-beats`) remain for custom parameters; they run fresh and uncached.

### Persist + cache (B1.3)

When the request carries a `projectId` (and the engine has a sandbox root),
every `ok` result is recorded in the brain keyed by
`(asset, kind, params_hash)` where `params_hash` folds in the analyzer
version, its effective parameters, and the source file's `content_sha256`.
Re-running the same pass is a cache hit (`cached: true`, no ffmpeg);
re-exporting the source file changes its hash and honestly invalidates.
`analyzer_effective_params()` in `service.py` must stay in lockstep with
`run_analyzer` — the cache key has to describe what actually ran.

Every brain failure (missing root, locked DB, traversal id) degrades to a
fresh, unpersisted pass with a warning — never a request error.

### Feeding the TS loop (B1.4)

- **`GET /brain/analysis?projectId=&assetId=&kind=`** returns the persisted
  rows (`available: false` + reason when there is no brain to read).
- **`packages/ai-sdk/src/brain-client.ts`** mirrors the wire shapes as Zod
  schemas (pinned by `engine/python/tests/test_brain_client_ts_parity.py`),
  and `createAnalysisBagWarmer({ baseUrl })` composes that reader + mapper into a
  run-start warm hook. **It currently has no consumer:** its only caller was
  `streamPlannedEdit`, retired with the `planned_edit` route (ADR 0126), and the
  orchestrator's `warmAnalysis` option went with it. The read primitives
  (`createBrainAnalysisReader`, `analysisBagFromRows`) are kept as Phase-5
  Project Brain material rather than deleted; wiring them to the agent runtime is
  open work, not shipped behavior. Every failure path returns `undefined`.
- **`sidecar-executor.ts`** routes a default-parameter `analyze_silence` /
  `detect_scenes` / `detect_beats` call **with an explicit `assetId`** through
  `POST /analyze` so its result persists and repeat calls across runs hit the
  brain (the tool card says "(from project brain)"). Id-less or
  custom-parameter calls keep the legacy routes: the unified route's
  default-asset pick ("first audio/video asset") differs from
  `detect-scenes`'s "first video asset", and custom parameters are not part of
  the cached contract.

One deliberate narrowing: the `AnalysisResultsBag` holds one asset's payload
per field, so the warmer picks the newest row per kind. The brain still holds
every row; the loop's analysis tools cover the other assets.

### `bin_summary.md` (B1.5)

After every brain-backed `/analyze` pass the engine regenerates
`memory/bin_summary.md` — per asset: duration, resolution, loudness (LUFS),
scene count, silence percentage, and the transcript's opening words. Missing
analyses render as `not analyzed`; malformed rows never fabricate numbers. The
file is derived and rebuildable (do not edit), written atomically, and exists
so a model (or you) can answer "what media do I have and what do we know about
it?" from one small markdown file.

## Indexing & search (plan B2)

### FTS ingest — `POST /brain/index` (B2.1)

The brain's `transcript_fts` / `markers_fts` FTS5 tables are **indexes over
the canonical project document**, rebuilt (drop-and-reinsert) from it on every
ingest so a deleted word can never linger as a stale hit. The transcript is
segmented into per-utterance rows with the exact `DIALOGUE_GAP_SECONDS` (0.6s)
rule the TS `SemanticTimelineIndex` uses — a search hit corresponds one-to-one
with a dialogue segment the proposers reason about. The desktop shell fires
`/brain/index` (fire-and-forget) after every successful project save.

### Search — `POST /brain/search` and the `search_media` tool (B2.2)

`search_media` is a host-run analysis tool ("find where I said X"):

- The agent loop posts its **live working project inline**; the route
  re-indexes from it before matching, so hits are never stale. The MCP path
  posts the saved `project_path` instead (the route derives the brain's
  project id from the loaded document).
- Untrusted queries are reduced to quoted FTS5 terms
  (`brain/fts.py::fts_match_expression`) — MATCH-grammar injection is
  structurally impossible, and hostile strings match literally.
- Hits are typed `{ type: transcript|marker|asset, assetId?, markerId?,
  start, end, snippet, score }`, merged best-bm25-first; transcript/marker
  times are timeline seconds. Asset-name matches are tokenized substring
  matches (no FTS needed) ranked below any FTS hit; the TS executor enriches
  them with the clip placements of that asset (`clipsOfAsset`).
- The orchestrator's action log keeps an **id-preserving hit digest**
  (`summarizeReadResult`), and the agent/planner prompts steer phrase-finding
  to `search_media` instead of full-transcript reads.

Without FTS5 in the runtime's SQLite build, `/brain/index` reports a typed
`available: false` and search degrades honestly to asset-name matches with the
reason attached.

### Semantic-index enrichment (B2.4)

The `AnalysisResultsBag` warmed from the brain now also carries `loudness` and
`black` rows: `SemanticTimelineIndex` exposes `loudness` (per-asset EBU R128
scalars, `null` unless the asset is actually placed on the timeline) and
`black` (source→timeline-translated black-frame ranges), with the same
honest gated-empty behavior as the other analysis-fed slices.

## Embeddings & similarity (plan B3)

Semantic search — "find moments **like** X" where the exact words differ —
rides on top of the same brain, and is **opt-in**: no embeddings model is
bundled.

### The embedder seam (B3.1)

`brain/embeddings.py` puts every model behind an injectable `Embedder`
protocol. `resolve_embedder()` returns an honest **unavailable** resolution
unless `FRAMEPILOT_EMBEDDINGS_MODEL_DIR` points at an ONNX text-embedder model
dir; when set, `OnnxTextEmbedder` mean-pools + L2-normalizes token embeddings.
Vectors are packed as float32 little-endian BLOBs (`pack_vector` /
`unpack_vector`) in the `embeddings` table (brain schema v2 adds a `payload`
column carrying each row's start/end/text or asset path), and `cosine_top_k`
does brute-force cosine ranking in numpy with deterministic tie-breaking —
thousands of rows, no vector-DB dependency.

The `onnxruntime` + `tokenizers` deps live in an **opt-in `embeddings` extra**
(`engine/python/pyproject.toml`); they are not installed by default. Install
them and set `FRAMEPILOT_EMBEDDINGS_MODEL_DIR` to enable semantic ranking —
otherwise everything below degrades honestly to keyword-only.

### Ingest (B3.2)

`/brain/index` rebuilds embeddings alongside FTS: `build_embedding_rows`
(`brain/similar.py`) embeds transcript **utterances** and per-asset
`bin_summary` **digests** in one batch (owner ids `utt:00000…` / the asset id;
payloads carry the row's span/text or path). The response reports `embedded`
plus an `embeddingsReason` when it could not. Embeddings are dropped and
rebuilt per model, so switching models never mixes vector spaces (invariant 1).

### `find_similar` — `POST /brain/similar` (B3.3)

`find_similar` is a host-run analysis tool that mirrors `search_media`'s body
and hit shape:

- **Blended mode** (an embedder is configured): `semantic_hits` cosine-ranks
  the embeddings (score shifted to `[0,1]`), then `blend_hits` normalizes the
  semantic and keyword lists each by its own best score and sums them with
  weights **0.6 semantic / 0.4 keyword** where a hit's merge key agrees, the
  semantic snippet winning on merge. The result carries `mode: "blended"`.
- **Keyword-only degrade** (no model): the route returns the FTS hits with
  `mode: "keyword"` and a `reason` — the tool's summary says which ranking ran,
  so a similarity result is never silently faked.

As with search, the agent loop posts its live working project inline (MCP posts
the saved `project_path`); the route re-indexes FTS + embeddings before ranking
so hits are never stale.

## Orchestration: durable jobs, runs, caps, recovery (plan B5)

### Durable job journal (B5.1)

Analysis jobs are journaled in the brain `jobs` table (`queued → running →
done/failed`, progress, and a resumable cursor in the payload). `GET
/brain/jobs?projectId=&state=` lists them. On the **first** time a process
touches a project's jobs, any job left non-terminal by a prior run is flagged
`interrupted` — so work cut off by a sidecar crash/restart is visible instead
of silently stuck. The sweep is idempotent per process (a job created after it
is untouched).

### Chunked batch analysis — `POST /analyze/batch` (B5.2)

Analysing a whole bin in one call risks the per-request timeout. The batch
route processes a **bounded slice** per call (`maxAssets`, capped 25) starting
at the job's persisted cursor and returns `{jobId, cursor, total, done}`; the
agent loop re-posts with the returned `jobId` until `done`, pacing the work
across turns. The worklist is fixed when the job is created (explicit
`assetIds` or every video/audio asset) and stored in the journal payload, so
pacing is stable even if the working copy changes. A per-asset failure is
reported (`item.ok=false` + reason) and the cursor still advances — no silent
loss, no infinite retry. Each slice reuses the same per-asset cache-through
semantics as `/analyze` (`run_analyze_pass`).

### Per-run analysis caps (B5.4)

`packages/ai-sdk/src/kernel/cost/analysis-caps.ts` is the analysis-side sibling
of the token cost meter: a per-run budget for frames extracted, ffmpeg seconds,
and transcription minutes. The host executor (`sidecar-executor.ts`) pre-checks
a capped call before dispatch (over-budget → honest `failed`, engine never
called) and records the real consumption after, so a runaway run hits an honest
ceiling. `AgentOptions.analysisCaps` overrides `DEFAULT_ANALYSIS_CAPS`.

### Run grouping & recovery (B5.3 / B5.5)

- Every per-turn diff of one agent run (ADR 0056) now carries a shared `runId`,
  so a host can collapse the burst into a single review/undo step while the
  per-turn diffs still stream individually.
- The saga recovery table (`recoveryFor`) classified a failed `host_tool` task as
  `route_around` (nothing downstream depended on it, so the run continued) or
  `fail_subgraph` (stop and name the node), never routing a cancellation around.
  Its caller was the planned-edit graph driver, retired with that route (ADR 0126);
  in the agent runtime a failed analysis call is an observation the model reacts to
  on the next turn, and cancellation settles the run.

### Session-start warmup (B5.6)

On project open the desktop main process fires `runSessionWarmup`
(`session-warmup.ts`), which paces `/analyze/batch` at the `quick` tier over
the bin in the background so the brain is warm before the first AI request. It
is desktop-only, cancellable (a new open aborts the previous run), never
awaited (never blocks the open), and cheap on re-open (cache hits). No sidecar
(browser) → it simply never runs.

## Memory tiers & session context (plan B6)

The brain remembers the *media*. These tiers remember the *user* — what they
turned down, what they kept, and how they like to work.

### Two tiers, one authority

`memory-store.ts` (typed, in `project.fp.json#aiMemory`) stays **authoritative**
for preferences and the accept/reject signal. The markdown tiers are the
**narrative** layer: prose a model reads, written from the same patch, so there
is no second source of truth to drift.

| File | Fed by | Holds |
|---|---|---|
| `corrections.md` | `recordRejected` → `POST /brain/memory` | Rejected edits + the patch id |
| `decisions.md` | `recordAccepted` (only when the patch actually landed) | Kept edits |
| `session_notes/<date>.md` | Run summaries | What happened, per day |

Every entry names the patch it refers to, so prose always traces back to real
history rather than being an unfalsifiable claim. Entries are never edited or
reordered — that is the append-only *contract*; the file itself is rewritten
wholesale on each append, which is what lets the cap drop old entries.

**Hygiene (B6.4):** each file is capped (64KB) and truncated **oldest-first**,
and says so in its header when it has been. The newest entry is always kept even
if it alone exceeds the cap — the thing the user just told us is the last thing
to forget.

### The cross-project soul (B6.2)

One project disliking something is a project preference and stays in that
project's `corrections.md`. The **same** correction in **two different projects**
is a pattern about the person, and gets promoted to
`~/.framepilot/soul/learned_from_corrections.md`. This is why
`corrections_index.json` tracks distinct project ids rather than a count: ten
corrections in one project still say nothing cross-project. Promotion fires only
on the transition across the threshold, so later projects never re-append it.
Matching is deliberately crude (case/punctuation/whitespace-folded) — a missed
match costs a promotion, a false match would put words in the user's mouth.

`working_style.md` and `perspective.md` are written only on an explicit "remember
this across projects" (`soulDoc` on `POST /brain/memory`). The soul **complements**
`user-memory.ts` rather than replacing it: this is the on-disk narrative tier, so
it exists on desktop and honestly does not in a browser-only build.

### `session_context` — what the model reads first

`POST /brain/session-context` assembles the whole picture: the bin digest, the
last session's note, the tails of corrections/decisions, and the soul digest.
`available: false` only when we genuinely cannot look (no sandbox root, a
traversal-rejected id) — **a project with no brain yet is available with empty
sections**, because a first run is not an error.

It reaches the model two ways:

- **The `session_context` tool**, on every surface (agent loop, and MCP, where
  the sidecar derives the project id from the saved document). Prompts steer the
  model to call it when its context does not already say what the user has told
  us before.
- **Context injection**: hosts render a bounded digest with
  `summarizeSessionContext` (brain-client.ts) and pass it as
  `ContextInput.sessionContext`. It lands in the **droppable `memory` tier**, not
  as a mandatory block — under budget pressure the narrative yields to the
  timeline/transcript the request is actually about.

The digest is a **prefix** of the sections in priority order (rejections first),
stopping at the first that would bust the bound. A lower-priority section never
jumps ahead of a dropped higher-priority one: showing "what they accepted" while
silently dropping "what they rejected" would actively mislead.

## Rebuild & degradation

- `POST /brain/rebuild` drops the database and re-derives it from the
  per-asset `analysis.json` sidecars, byte-identically (`GET /brain/status`
  reports schema version, FTS availability, and row counts).
- No sidecar (browser build), no projects root, or no brain → every consumer
  degrades honestly: analysis runs fresh, the warm hook returns nothing, and
  the run behaves exactly as it did before the brain shipped.

Where that is proven, so the invariant is not just an assertion:

| Claim | Test |
|---|---|
| Rebuild is byte-identical | `test_brain_sidecars.py::test_rebuild_roundtrip_is_byte_identical` |
| Deleting the derived dir breaks nothing | `test_service_brain.py` (derived-dir deletion, traversal ids, missing root, FTS5-less builds) |
| The app opens/edits/undoes with **no brain at all** | `tests/e2e/specs/brain-absent-degradation.spec.ts` — the browser build can never have a brain, so it is the invariant's strongest case |
| Analyzers measure rather than fabricate | `test_analysis_golden.py` — real ffmpeg against deterministic `lavfi` sources |

## Security notes (plan B7.2)

A review of the whole substrate found the FTS path structurally injection-proof
(the MATCH expression keeps only alphanumeric tokens, so quoting cannot be
escaped), and no secrets in the brain. One issue it found is now fixed and
regression-tested:

- **`memory/` lacked a sandbox backstop.** A `MemoryEntry.ts` becomes a path
  segment (`session_notes/<date>.md`), and an absolute one would have escaped.
  `tier_path()` now resolves through `resolve_within`, like every other brain
  tree. The routes always generated `ts` server-side, so this was never
  reachable — but the module's public API accepted it, which is exactly the kind
  of thing that stops being true later.

One trust assumption is deliberate and worth knowing: `restore_field()` bypasses
the human-wins provenance rule so a rebuild reproduces exported rows exactly.
That is safe only because `sidecars/` is engine-written and inside the sandbox.
If sidecars ever become importable from an untrusted source, that becomes a
provenance-laundering path and needs a guard.
