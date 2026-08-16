# Media Intelligence — Visual Embeddings, Vector Search & Grounded Orchestration

> **Status:** `[x]` complete · Created 2026-07-18 · Completed 2026-07-18
> **Open desktop follow-up (not hermetically testable):** end-to-end indexing
> throughput on minutes-long camera files (ffmpeg decode + NVIDIA embed latency)
> is a desktop spot-check per CLAUDE.md, not a CI gate — see MI7.1.
> **Owner surfaces:** `engine/python/framepilot_engine/brain/` + `analysis/`,
> `packages/ai-sdk` (tool registry, context builder, sidecar executor),
> `apps/web-editor` (Settings → AI → Embeddings), `apps/desktop` (packaging).
> **Builds on:** `plan/ORCHESTRATION_ENHANCEMENT_PLAN.md` (B0–B7, complete) —
> the Project Brain (`brain.sqlite`), FTS5 transcript search, the text
> `Embedder` seam, provenance rules, the job journal, and the analysis tiers.

---

## 1. Mission

Today the orchestrator is **blind**. It reasons over transcripts, silence maps,
scene cuts, and loudness — all *signal-derived* facts — but it has no idea what
is actually **on screen**. "Cut to the product shot", "find where the whiteboard
appears", "pick the best frame for the thumbnail" all degrade to transcript
keyword luck or plain heuristics.

This plan gives every project a **visual memory**:

1. **Visual embeddings** — every video is sampled adaptively (scene-aware,
   ≤1 vector/second), every image embedded as-is, via NVIDIA
   `llama-nemotron-embed-vl-1b-v2` (cross-modal: text queries ↔ image passages).
2. **VLM scene captions** — every scene gets a short natural-language
   description via the user's existing vision-capable provider, so retrieval
   hits resolve into text the LLM can actually read.
3. **Vector search** — `sqlite-vec` inside the existing `brain.sqlite`, fused
   with FTS keyword hits and text-embedding hits into one ranked recall surface.
4. **Orchestrator grounding** — new tools + context so the model *knows what it
   can see*, retrieves visual evidence on demand, and makes informed decisions
   instead of guessing from dialogue alone.

**End state:** the user says "make a short from the demo part" and the
orchestrator retrieves the scenes where the app is on screen, reads their
captions, cross-references the transcript, and cuts with evidence — not vibes.

---

## 2. Decisions (locked with the user, 2026-07-18)

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Understanding depth | **Embeddings + VLM captions** | Vectors alone only rank; the LLM needs readable scene descriptions to reason. Captions are also FTS-ingested and text-embedded → one unified recall space with the transcript. |
| D2 | Frame sampling | **Adaptive: scene keyframes + ≤1s cap + perceptual-hash dedupe** | A static talking-head must not cost 60 near-identical API calls/minute. Vectors cover time *spans*, guaranteeing full temporal coverage at a fraction of the cost of strict 1 fps. |
| D3 | Indexing trigger | **Auto, in background, on import** — when a key is configured | Zero-friction intelligence. Journaled (B5 job journal), resumable, cancellable, content-hash cached so nothing is ever embedded twice. |
| D4 | Vector store | **`sqlite-vec` extension inside `brain.sqlite`** | Indexed KNN at desktop scale (tens of thousands of vectors/project). Single-file brain preserved. **Must** degrade honestly to the existing brute-force `cosine_top_k` path if the extension fails to load (browser, packaging miss). |
| D5 | API key UX | **Plain text, visible, stored as plain text** (explicit user requirement) | Shown as `type="text"`, persisted in the same plaintext AI config file that already holds `cfg.keys.*`. Comma-separated **multiple keys with automatic failover** (rotate on 401/403/429/5xx, per-key cooldown). |
| D6 | Where the work runs | **Python sidecar only** | Brain invariant #2: single writer. NVIDIA client, sampler, captioner, vec tables all live in the engine. Browser build without sidecar = honest `available:false`, never a fake result. |
| D7 | Caption provider | **Reuse the existing provider registry** (vision-capable configured model) | No new vendor for captions; the user already configures Anthropic/Google/etc. Batched per scene (keyframe strip), written with `source='model'` provenance. |

**Invariants carried forward (non-negotiable, from B0):**
`project.fp.json` stays canonical — the visual index is derived and rebuildable;
single sidecar writer; every path through `resolve_within`; provenance on every
write; honest-unavailable everywhere (no key → typed reason, never a stub).

---

## 3. Architecture

```
                        apps/web-editor
  Settings → AI → Embeddings (plain-text keys, status, index-now)
        │ persists cfg.keys.nvidiaEmbeddings (plaintext AI config file)
        ▼
  packages/ai-sdk ────────────────────────────────────────────────
   context-builder: "visual index: 3/4 assets, 2,841 vectors"      │ orchestrator
   tool-registry:  search_visual · describe_footage · index_media  │ reads only
        │ sidecar-executor (HTTP)                                  ▼
  engine/python sidecar ──────────────────────────────────────────
   POST /brain/visual/index    → sampler → NVIDIA embed client → brain
   POST /brain/visual/search   → query embed → sqlite-vec KNN → fuse → spans+captions
   GET  /brain/visual/status   → coverage, model, vec backend, key health
        │                                    │
   analysis/scenes.py + frames.py       brain.sqlite
   (keyframes, phash dedupe)            ├─ visual_vectors (vec0 / BLOB fallback)
   captioner (provider registry VLM)    ├─ visual_spans   (asset, t0, t1, scene, phash, hash…)
                                        └─ visual_captions (span → text, source='model')
```

### 3.1 Sampling model (the "overlap handling")

Per video asset:

1. Run/reuse scene detection (`analysis/scenes.py`, already cached in the brain).
2. Within each scene, sample candidate frames at 1 fps (`analysis/frames.py`).
3. Compute a dHash per candidate; a frame within Hamming distance ≤ threshold of
   the previously *embedded* frame extends that vector's span instead of
   producing a new one.
4. Result: an ordered, **contiguous, non-overlapping** set of spans
   `[t0, t1)` per asset — every second of the video is covered by exactly one
   vector, scene boundaries always start a new span, and a query hit maps
   deterministically back to timeline time. Images are a single span `[0, 0)`.

Idempotency key: `(asset content_hash, model_id, sampler_version, t0)` — re-runs
skip everything already stored; interrupted jobs resume mid-asset.

### 3.2 NVIDIA embedding client (engine)

- `httpx` POST `https://integrate.api.nvidia.com/v1/embeddings`, model
  `nvidia/llama-nemotron-embed-vl-1b-v2`.
- **Passages:** `modality:["image"]`, `input_type:"passage"`, frames JPEG-encoded
  (bounded long edge — the model doesn't need 4K) as base64 data URIs, batched
  (batch size configurable, start conservative, honor 413/400 by splitting).
- **Queries:** same model, text modality, `input_type:"query"` — this is the
  cross-modal contract; query vectors are never stored.
- Store `dim` from the first response in the schema — never hardcode it.
- **Key ring:** ordered keys from the comma-separated setting. On 401/403 mark
  key dead for the session; on 429/5xx cool the key down (exponential backoff)
  and rotate to the next; all keys exhausted → typed
  `{available:false, reason:"all_keys_failing", lastError}` up the stack.
  Key health surfaced in `/brain/visual/status` and the settings UI.
- Keys reach the sidecar the same way other runtime config does (request/config
  payload from the host app) — **never** logged, echoed, or written by the engine.

### 3.3 Captions

- One VLM call per scene: keyframe (or small multi-frame strip for long scenes)
  → ≤2-sentence factual caption ("what is on screen"), via the configured
  vision-capable provider from the existing registry.
- Written to `visual_captions` with `source='model'`, model id, and span link;
  ingested into FTS5; text-embedded with the existing ONNX embedder when
  available. Captions are *derived data* — rebuildable, never truth.

### 3.4 Retrieval & fusion

`POST /brain/visual/search {projectId, query, k, assetIds?, timeRange?}`:

1. Embed query text (nemotron, `input_type:"query"`).
2. sqlite-vec KNN over `visual_vectors` (fallback: `cosine_top_k` brute force).
3. In parallel: FTS5 over captions + transcript; text-vector search over
   captions/utterances (existing B3 path).
4. **Reciprocal-rank fusion** into one list; each hit returns
   `{assetId, t0, t1, sceneId, score, caption, transcriptOverlap, sources[]}` —
   an evidence packet the LLM can read directly.

### 3.5 Orchestrator integration (ai-sdk)

- **Tools** (canonical registry, mirrored to MCP like the rest):
  - `search_visual(query, k?, assetIds?, timeRange?)` — fused evidence packets.
  - `describe_footage(assetId, timeRange?)` — time-ordered captions + scene
    structure, the "what am I looking at" primer.
  - `index_media(assetId?|projectId, wait?)` — trigger/await indexing (also
    what auto-index calls).
- **Context builder:** one compact line in the system context — visual index
  coverage, vector count, backend, or the honest reason it's unavailable — so
  the model knows when to look and when it can't.
- **Prompts:** decision guidance (lead-prompt-engineer pass): prefer retrieved
  visual evidence over assumption for any content-dependent edit; cite spans.
- Existing `find_similar` keeps its contract; visual fusion lands behind the new
  tool first, blend into `find_similar` only after evaluation (MI7).

### 3.6 Settings UI (web-editor)

New **Embeddings** subtab in Settings → AI:

- Plain-text input (`type="text"`, value always visible — explicit requirement)
  labeled "NVIDIA API key(s), comma-separated"; stored plaintext alongside the
  existing `cfg.keys.*` (own slot `nvidiaEmbeddings`; do **not** overload the
  chat `nvidia` key — different product, different rotation semantics).
- Auto-index toggle (default on when a key exists), per-key health chips,
  coverage per asset, live job progress + cancel, "Index now", and a clear
  "stored as plain text on this machine" hint (matches the existing AI-tab copy).

---

## 4. Ask-before-acting items (CLAUDE.md §5) — resolve before MI2

- [x] **New dependency `sqlite-vec`** (Apache-2.0) in the engine — adopted and
      in use (`brain/vector_store.py`); bundled into the desktop sidecar per-OS
      (MI2.4, ADR 0062) with the brute-force `cosine_top_k` fallback as the
      safety net when the extension cannot load. Decision recorded in ADR 0065.
- [x] **Brain schema migration** — `visual_spans` / `visual_vectors` /
      `visual_captions` tables via `brain/migrations.py` (v3, brain-internal,
      rebuildable; **no** `project.fp.json` schema change). Guarded by
      `test_migration_v3_tables_present`.
- [x] **ADR trio:** [ADR 0065](../docs/adr/0065-sqlite-vec-adoption.md)
      sqlite-vec adoption (amends "no vector DB" with the honest-fallback
      condition) · [ADR 0066](../docs/adr/0066-nvidia-cloud-visual-embeddings.md)
      NVIDIA cloud visual embeddings (data leaves the machine; consent =
      configuring a key) · [ADR 0067](../docs/adr/0067-plaintext-key-storage-multi-key-failover.md)
      plaintext key storage + multi-key failover (user-mandated; risk scoped).

---

## 5. Phases

Order honors the build rule: engine substrate first, AI layer last.

### Phase MI0 — Config & key plumbing `[x]`
- [x] **MI0.1** `nvidiaEmbeddings` key slot (comma-separated string) in the AI
      config store; plumb host → sidecar config payload. Update `.env.example`
      + `turbo.json` `globalEnv` for any new env var in the same change.
- [x] **MI0.2** Settings → AI → **Embeddings** subtab per §3.6 (plain text,
      visible, stored plain), including the persisted caption-provider selection;
      desktop forwards that provider's key directly to the sidecar without exposing it
      to the renderer; status exposes zero and nonzero caption coverage when the
      provider is configured; the visible Embeddings tab polls the status endpoint
      every two seconds. Tests: render, persistence, deep-link.
- [x] **MI0.3** Key-ring parser + failover state machine as a pure, fully
      covered engine module (`brain/keyring.py`): rotation, cooldown,
      dead-marking, typed exhaustion.

### Phase MI1 — Adaptive sampler (engine, deterministic) `[x]`
- [x] **MI1.1** `analysis/visual_sampler.py`: scenes → 1 fps candidates → dHash
      dedupe → contiguous spans (§3.1). Pure given frames; 100% coverage;
      golden tests on fixture media (static shot collapses, cuts split).
- [x] **MI1.2** Frame extraction path reusing `analysis/frames.py` + ffmpeg,
      bounded resolution, sandbox-safe temp handling.
- [x] **MI1.3** `sampler_version` constant + idempotency key discipline.

### Phase MI2 — Embedding client + vector store `[x]`
- [x] **MI2.1** `brain/visual_embed.py`: NVIDIA client per §3.2 (batching,
      split-on-413, keyring integration). Tests fully mocked (respx) — success,
      each failover branch, exhaustion, dim capture. No live-API tests in CI.
- [x] **MI2.2** Brain migration: `visual_spans`, `visual_vectors`
      (sqlite-vec `vec0` when loadable), `visual_captions`; provenance columns.
- [x] **MI2.3** `brain/vector_store.py`: one search seam over both backends
      (vec0 KNN ↔ brute-force fallback); parity test proves identical top-k on
      a fixture set. Load-failure → logged reason + fallback, never an error.
- [x] **MI2.4** Desktop packaging: bundle the extension per-OS; smoke test in
      the packaged sidecar; release-checklist entry.

### Phase MI3 — Caption pipeline `[x]`
- [x] **MI3.1** `brain/captioner.py`: per-scene VLM captions via provider
      registry (§3.3); prompt kept factual/terse; mocked tests incl. provider-
      unavailable honesty.
- [x] **MI3.2** Ingest captions → FTS5 + text embeddings (existing seams).

### Phase MI4 — Index orchestration & background jobs `[x]`
- [x] **MI4.1** `POST /brain/visual/index` — journaled job (B5): sample → embed
      → caption → store, resumable, cancellable, progress-reporting.
- [x] **MI4.2** Auto-trigger on asset import when key configured (D3), low
      priority, never blocking import/preview.
- [x] **MI4.3** `GET /brain/visual/status` — coverage, counts, backend, key
      health, last error. UI wires progress + cancel + "Index now" (MI0.2 slots).

### Phase MI5 — Retrieval & fusion `[x]`
- [x] **MI5.1** `POST /brain/visual/search` per §3.4 (query embed → KNN → RRF
      fusion → evidence packets). Golden retrieval tests on fixture media with
      pinned vectors (no live API).
- [x] **MI5.2** Time-range and asset filters; span→timeline-time mapping tests.

### Phase MI6 — Orchestrator grounding (ai-sdk) `[x]`
- [x] **MI6.1** Tools `search_visual`, `describe_footage`, `index_media` in the
      canonical registry (+ MCP parity, tool-scope, wipe-guard review).
- [x] **MI6.2** Context-builder visual-status line; honest-unavailable string.
- [x] **MI6.3** Prompt guidance pass (lead-prompt-engineer): retrieve-before-
      assume for content-dependent decisions; golden orchestrator-stream tests
      showing a visual query round-trip.

### Phase MI7 — Hardening, evaluation & docs `[x]`
- [x] **MI7.1** Perf budgets: search p95 < 100 ms at 50k vectors (desktop);
      indexing throughput measured on real desktop-scale media (minutes-long
      camera files, per CLAUDE.md), not fixtures.
      - Guard: `engine/python/tests/test_visual_perf.py` (env-gated
        `FRAMEPILOT_PERF=1` for the strict 50k assertion; default run
        measures+logs+generous regression ceiling — non-flaky). Budgets
        documented in `docs/guides/performance-budgets.md`.
      - **FIXED (2026-07-18, `performance-optimizer`):** search budget now met —
        p95 **~64 ms** at 50k (was ~1–3 s), strict gate green. The two per-search
        O(n) materializations (`_span_meta()` Pydantic rebuild ~259 ms + `_MAP_TABLE`
        full scan ~64 ms) were replaced by O(k) indexed point lookups for only the
        top-k hit rowids: `_rowid_keys` (integer PK on `_MAP_TABLE`) + `_span_meta_for`
        (row-value `IN` on `visual_spans`' composite PK). No schema/index/migration
        change. What remains is the raw vec0 KNN (~52 ms). Behavior/ordering identical
        (all vector-store parity + edge tests green); filtered path still fetches all
        ranked candidates before filtering (O(n) by construction, unchanged). New
        regression guard: `test_vec_path_resolves_metadata_only_for_top_k`.
      - Index-write throughput floor (≥ 500 rows/s) met (~2–4k rows/s ref).
      - Still open (desktop-only): end-to-end indexing throughput on minutes-long
        camera files (ffmpeg decode + NVIDIA embed) — not hermetically testable.
- [x] **MI7.2** Failure drills: mid-job kill/resume, key exhaustion mid-batch,
      brain rebuild from sidecars reproduces the index decision (re-index, not
      restore — vectors are derived). Three proof drills in
      `tests/test_service_visual_index.py`; no production change (the properties
      already held — the asset's batch embeds before any DB write, the cursor
      never skips a failed asset, and sidecars exclude the derived visual_*
      tables so rebuild re-derives rather than restores).
- [x] **MI7.3** Evaluate blending visual hits into `find_similar`; ship only if
      retrieval quality improves on the golden set. **Verdict: NO-SHIP — keep the
      tools separate.** Deterministic two-space eval
      (`tests/test_brain_similar_visual_eval.py`) shows the only lift (MRR 0.6→1.0)
      is confined to the caption-failure tail already served by `search_visual`;
      well-captioned/dialogue footage sees +0.000 (captions already feed the text
      space, MI3.2). See ADR 0064. `similar.py` unchanged; eval committed as a guard.
- [x] **MI7.4** Docs: guide (`docs/guides/media-intelligence.md`), the three
      ADRs (§4 → 0065/0066/0067), `CHANGELOG.md`; e2e: settings → index →
      orchestrator uses `search_visual` in an edit flow.
  - e2e portion delivered: `tests/e2e/specs/visual-embeddings-settings.spec.ts`
    covers the browser-reachable slice — Settings → AI → Embeddings surface
    (key input, auto-index switch, Index-now) + honest-unavailable (no key ⇒
    guidance shown, Index-now disabled) + D5 plaintext key field. The real
    index/search round-trip is NOT browser-reachable (harness boots no sidecar,
    like `brain-absent-degradation.spec.ts`); it stays covered at the
    integration level — engine pytest (`test_service_brain.py`, vector-store /
    visual-index tests) + ai-sdk `orchestrator-stream.test.ts` (MI6.3 golden).
    Runs in the default `pnpm test:e2e` smoke (untagged, not `@visual`).

---

## 6. Testing & Definition of Done

- **No live NVIDIA calls in any test tier** — mocked client everywhere; a
  hand-run smoke script (`scripts/`) for manual key verification only.
- 100% coverage on the deterministic core: sampler, keyring, vector-store seam,
  fusion, span math.
- TS↔Python parity where both sides see a shape (evidence packet, status).
- Honest-degradation tests for every capability gate: no key, no sidecar, no
  sqlite-vec, no vision provider.
- `pnpm verify` + `pnpm engine:*` green; plan + docs updated per task.

## 7. Explicit non-goals (this plan)

- No local visual-embedding model (cloud-only for now; the `Embedder`-style seam
  keeps a local ONNX backend possible later).
- No audio-event embeddings, no face recognition/identity, no object tracking
  changes (tracker already exists).
- No project-schema change; no browser-without-sidecar visual indexing.
