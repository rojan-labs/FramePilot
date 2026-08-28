# Media Intelligence — the orchestrator can see your footage

FramePilot's AI used to be **blind**. It reasoned over transcripts, silence maps,
scene cuts, and loudness — all _signal-derived_ facts — but it had no idea what
was actually **on screen**. "Cut to the product shot", "find where the whiteboard
appears", "make a short from the demo part" all degraded to transcript keyword
luck or plain heuristics: if nobody happened to _say_ "product", the moment was
invisible.

Media Intelligence gives every project a **visual memory**. Footage is sampled,
embedded, and captioned into the [Project Brain](./project-brain.md); the
orchestrator gets tools that retrieve _ranked visual evidence_ on demand. So an
edit like "cut to the product shot" is grounded in retrieved frames and their
captions — evidence, not vibes.

**WHY it is safe to have:** like everything else in the brain, the visual index
is a _derived, rebuildable cache with provenance_, never a second source of
truth. `project.fp.json` stays canonical; deleting the derived directory loses
time, never work. See [ADR 0058](../adr/0058-project-brain-derived-sqlite-substrate.md)
for the substrate and [ADR 0066](../adr/0066-nvidia-cloud-visual-embeddings.md)
for the one thing that is genuinely new here — frames leaving the machine.

This is the **Media Intelligence** plan (`plan/MEDIA-INTELLIGENCE.md`, phases
MI0–MI7), built on the [Project Brain](./project-brain.md).

## Architecture

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
   POST /brain/visual/describe → local ordered span/caption enumeration (no query/key)
   GET  /brain/visual/status   → coverage, model, vec backend, key health
        │                                    │
   analysis/scenes.py + frames.py       brain.sqlite
   (keyframes, phash dedupe)            ├─ visual_vectors (vec0 / BLOB fallback)
   captioner (provider registry VLM)    ├─ visual_spans   (asset, t0, t1, scene, phash, hash…)
                                        └─ visual_captions (span → text, source='model')
```

Four stages turn raw footage into readable evidence:

### 1. Adaptive scene-aware sampling

A static talking-head must not cost 60 near-identical API calls per minute.
Per video asset the sampler (`analysis/visual_sampler.py`) reuses the brain's
scene detection, samples candidate frames at 1 fps _within_ each scene, computes
a **dHash** per candidate, and collapses frames within a Hamming-distance
threshold of the last _embedded_ frame into that vector's span instead of
producing a new vector.

The result is an ordered, **contiguous, non-overlapping** set of spans
`[t0, t1)` per asset: every second is covered by exactly one vector, scene
boundaries always start a new span, and a query hit maps deterministically back
to timeline time. Vectors cover time _spans_, so full temporal coverage costs a
fraction of strict 1 fps. Images are a single span `[0, 0)`. The idempotency key
`(asset content_hash, model_id, sampler_version, t0)` means nothing is ever
embedded twice and interrupted jobs resume mid-asset.

### 2. Cross-modal embeddings (NVIDIA)

Sampled frames are embedded by NVIDIA `llama-nemotron-embed-vl-1b-v2` — a
**cross-modal** model where image _passages_ and text _queries_ land in the same
vector space, so "the product shot" (text) can rank frames (image) it never has
words for. The engine JPEG-encodes each frame (bounded long edge — the model
doesn't need 4K), POSTs batches as passages (`input_type:"passage"`), and stores
the `dim` reported by the first response — **never hardcoded**. Query text is
embedded with the same model as `input_type:"query"`; query vectors are never
stored. See [ADR 0066](../adr/0066-nvidia-cloud-visual-embeddings.md).

### 3. Per-scene VLM captions

Vectors only _rank_; the LLM needs readable descriptions to _reason_. Each scene
gets a short, factual "what is on screen" caption (`brain/captioner.py`) via your
**existing** vision-capable provider from the registry — no new vendor. Captions
are written to `visual_captions` with `source='model'` provenance, ingested into
FTS5, and text-embedded with the existing ONNX embedder when available. Because
captions live in the text space too, a well-captioned moment already surfaces in
`find_similar` and `search_media` — see [ADR 0064](../adr/0064-visual-recall-in-find-similar.md)
for why that made a separate visual tool the right call.

### 4. Vector store + RRF fusion

Vectors live in `sqlite-vec` tables **inside** `brain.sqlite` (indexed KNN at
desktop scale — tens of thousands of vectors per project) with an honest
brute-force `cosine_top_k` fallback when the extension can't load. One search
seam (`brain/vector_store.py`) covers both backends identically. See
[ADR 0065](../adr/0065-sqlite-vec-adoption.md).

A search runs three recall lanes in parallel — image-vector KNN, FTS over
captions + transcript, and text-vector search over captions/utterances — and
fuses them by **reciprocal-rank fusion** (`RRF_K = 60`, in `brain/visual_search.py`).
Each hit returns an evidence packet the LLM reads directly:
`{assetId, t0, t1, sceneId, score, caption, transcriptOverlap, sources[]}`.

## The three orchestrator tools

Media Intelligence adds three tools to the canonical registry (mirrored to MCP
like the rest). **None of them edit the timeline** — they are read/analysis
tools. To act on what they find, the model follows up with the normal reversible
timeline operations (e.g. `add_marker`, trims, cuts), each still validated
before apply.

| Tool                                              | What it does                                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_visual(query, k?, assetIds?, timeRange?)` | The primary grounding tool: fused, ranked evidence packets across all footage. "Where does the app appear?" → spans + captions + transcript overlap. |
| `describe_footage(assetId, timeRange?)`           | Walks **one** asset in time order — its captions and scene structure. The "what am I looking at" primer.                                             |
| `index_media(assetId?\|projectId, wait?)`         | Builds/finishes the visual index. Also what auto-index calls.                                                                                        |

`describe_footage` is an enumeration, not a disguised semantic search: the
sidecar reads every indexed span for that asset in time order and does not need
to embed a generic query. `search_visual` remains the relevance-ranked surface;
its RRF `score` measures retriever agreement, not probability or confidence.

Agent-triggered `index_media` uses the same host-resolved embedding keys and
caption-provider configuration as the Settings flow. Captioning is independently
resumable: if an earlier run stored vectors without captions, a later configured
run backfills the missing scene descriptions without re-embedding those frames.
Provider status/moderation strings are rejected as non-visual metadata and are
not returned as evidence.

The prompts are steered (MI6.3) to **retrieve-before-assume** for any
content-dependent edit, and to **cite** the captions and timecodes it acted on,
so a visual decision is traceable rather than an unfalsifiable claim. The context
builder injects one compact line — the `/brain/visual/status` coverage summary
(`visual index: 3/4 assets, 2,841 vectors`) or the honest reason it's unavailable
— so the model knows _when to look and when it can't_.

## Configuration

Everything is opt-in behind a key.

- **Settings → AI → Embeddings.** A plain-text input (`type="text"`, value always
  visible — an explicit user requirement, [ADR 0067](../adr/0067-plaintext-key-storage-multi-key-failover.md))
  labeled "NVIDIA API key(s), comma-separated", stored plaintext alongside the
  other `cfg.keys.*` in the AI config file. It uses its own `nvidiaEmbeddings`
  slot — **not** the chat `nvidia` key (different product, different rotation
  semantics).
- **Caption provider.** Select the configured, vision-capable provider and model
  that should produce the short scene descriptions. On desktop its key remains in
  the main process and is forwarded to the Python sidecar only for captioning; it
  is never returned to the Settings UI.
- **Multi-key failover _and_ throughput.** Give several comma-separated keys and the
  engine's key ring rotates automatically: mark a key dead for the session on 401/403,
  cool it down (exponential backoff) on 429/5xx and move to the next. All keys
  exhausted → a typed `{available:false, reason:"all_keys_failing"}`, never a
  fake result. Per-key health is surfaced in `/brain/visual/status` and the
  settings UI. Concurrent embedding requests now draw **different** keys rather than
  queueing behind the first healthy one, so extra keys buy speed as well as resilience.
- **Concurrent preparation.** `FRAMEPILOT_VISUAL_INDEX_CONCURRENCY` (default 4) sets how
  many assets one index slice prepares at once. Preparation is dominated by waiting on
  the provider, not by local work — 60 photos measured 92.7 s of wall clock against about
  1.5 s of local CPU — so this is the main lever on how quickly a freshly imported
  project becomes searchable: 60 photos go from ~110 s to ~30 s at the default, and to
  ~17 s at the maximum. Raise it if you have several keys; set it to `1` to restore
  strictly serial preparation. Results are identical at any setting — the cursor still
  advances over a prefix of the worklist, so resume stays exact.
- **Batch contract.** NVIDIA requires `modality` to be a list with exactly one
  encoder-tower value per `input`. The client constructs both arrays together
  (`["image", ...]` for stored frames, `["text"]` for a query), so a batch can
  never rely on unsupported single-value broadcasting.
- **Auto-index on import.** When a key is set, importing an asset triggers a
  low-priority background index job (journaled, resumable, cancellable) — zero
  friction. It never blocks import or preview.
- **Status line.** `GET /brain/visual/status` reports coverage per asset, vector
  count, the active vector backend (sqlite-vec vs brute-force fallback), key
  health, and the last error. Settings → AI → Media intelligence renders live job
  progress and the job's own terminal state off it. **There is no "Index now"
  button** — preparation is automatic on import or first semantic need, and an
  e2e test (`tests/e2e/specs/visual-embeddings-settings.spec.ts`) holds that line.

## Which backend handles which asset

When a TwelveLabs key is configured it owns understanding for **video and audio**.
It does **not** own still photos: its index is a video/audio index, so an image
uploads (its `POST /assets` accepts one, for entity search) and then cannot be
attached — the attach step answers `404 resource_not_exists`.

Routing is therefore a **per-asset capability gate**, not only a per-project policy
([ADR 0152](../adr/0152-a-backend-that-cannot-index-a-photo-must-not-be-given-one.md)):

| Asset                      | Backend                                       | What happens                                                                      |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| video, audio               | TwelveLabs when its key is set, else built-in | upload → index → Pegasus footage map                                              |
| **still photo**            | **always the built-in on-device path**        | one keyframe → NVIDIA embedding → optional VLM caption → span/caption footage map |
| still photo, no NVIDIA key | none                                          | reported honestly per asset; the cursor still advances                            |

Both keys are forwarded to the engine together, so the photo route is reachable for a
user who configured TwelveLabs. The consequence, stated in the Settings panel: image
embedding requests reach NVIDIA even when TwelveLabs is your chosen backend.

Two rules follow from the same ADR and apply to any future backend:

- **A provider's refusal of one asset advances the job cursor.** Previously it did not,
  and one un-indexable file left every asset behind it permanently unprepared.
- **A job that has stopped reports `failed`, not `running`** — with the provider's own
  reason, so the panel can show it.

## Honest-unavailable everywhere

Media Intelligence follows the brain's cardinal rule: a capability that can't run
says so with a typed reason and never fabricates a result.

- **No key configured** → `available:false` with the reason; no indexing, no
  visual search.
- **Not indexed yet** → the status line says so; the model is told, and reaches
  for `index_media` or falls back to transcript/heuristic recall honestly.
- **All keys failing** → `reason:"all_keys_failing"` with the last error, not a
  silent empty list.
- **No sqlite-vec** (packaging miss) → search degrades to brute-force
  `cosine_top_k`, logged, identical top-k on the fixture set.

**Desktop-first (per `CLAUDE.md`).** The visual index requires the Python
sidecar: the sampler, NVIDIA client, captioner, and vector tables all live in the
engine (single-writer brain invariant). The plain **browser build has no engine**,
so the visual tools honestly report unavailable there — there is no
browser-without-sidecar visual indexing (a stated non-goal). Design and test the
desktop path first.

## Privacy boundary — frames leave the machine

Be clear-eyed about this: **indexing uploads sampled JPEG frames of your footage
to NVIDIA's cloud API** (`integrate.api.nvidia.com`). Everything else in the
brain is computed locally; visual embeddings are not. The frames are down-scaled
and deduped, but content still leaves the machine.

**Configuring a key IS the consent.** With no key, no frame is ever sent —
indexing simply doesn't run. The engine never logs, echoes, or persists the key
itself; captioning reuses whichever provider you already configured. See
[ADR 0066](../adr/0066-nvidia-cloud-visual-embeddings.md) for the full data-flow
and consent model, and [ADR 0067](../adr/0067-plaintext-key-storage-multi-key-failover.md)
for the at-rest key-storage trade-off (plaintext, user-mandated) and its exact
scope.

## Testing & performance

Performance budgets for the visual path live in
[performance-budgets.md](./performance-budgets.md): `VisualVectorStore.search`
p95 **< 100 ms at 50k vectors** (sqlite-vec) and an index-write throughput floor,
both guarded by `engine/python/tests/test_visual_perf.py` against a seeded
synthetic corpus. The tight search assertion is opt-in behind `FRAMEPILOT_PERF=1`
so it never flakes on CI runners. The budget is **met**: an early measurement
flagged a ~1–3 s p95 dominated by two per-search O(n) materializations, since
fixed — resolving span metadata and rowid→key for only the top-k hits (O(k))
brought p95 to ~62 ms at 50k, and the strict gate passes.

Tests are layered by boundary, so each seam is proven where it lives:

| Boundary                                     | Where                                             |
| -------------------------------------------- | ------------------------------------------------- |
| Engine visual routes (index/search/status)   | `engine/python/tests/test_service_visual_*.py`    |
| Retrieval + RRF fusion + span math           | `engine/python/tests/test_brain_visual_search.py` |
| Orchestrator search → cite → edit round-trip | `packages/ai-sdk` `orchestrator-stream.test.ts`   |
| Settings + status UI                         | browser e2e                                       |

Per the plan's Definition of Done: **no live NVIDIA calls in any test tier** —
the client is mocked (respx) everywhere, with a hand-run smoke script for manual
key verification only. The deterministic core (sampler, keyring, vector-store
seam, fusion, span math) holds 100% coverage, and every capability gate — no key,
no sidecar, no sqlite-vec, no vision provider — has an honest-degradation test.

## Related

- [The Project Brain](./project-brain.md) — the derived SQLite substrate this
  builds on (analysis cache, FTS search, embeddings, jobs, memory tiers).
- [Performance budgets](./performance-budgets.md) — the visual-search and
  index-write budgets.
- ADRs: [0058](../adr/0058-project-brain-derived-sqlite-substrate.md) (substrate),
  [0064](../adr/0064-visual-recall-in-find-similar.md) (tools stay separate),
  [0065](../adr/0065-sqlite-vec-adoption.md) (vector store),
  [0066](../adr/0066-nvidia-cloud-visual-embeddings.md) (cloud embeddings),
  [0067](../adr/0067-plaintext-key-storage-multi-key-failover.md) (key storage).
  </content>
  </invoke>
