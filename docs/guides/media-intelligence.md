# Media Intelligence — what the agent knows about your footage

The agent used to be blind, and the measurement was not close: across ten recorded runs
(318 scored turns) it called `get_frame` **zero** times and every footage surface **zero**
times, then invented every colour and transition value it applied. It edited a spreadsheet
of clip ids.

The fix is not to show it more pictures. It is to **compile what the footage contains, once
per asset, into text the agent already has** — the shot ledger (ADR 0175). Perception costs
scale with footage minutes, paid once at import; a run reads words. A frame per model call
would scale with _decisions_, getting more expensive exactly as the agent gets more capable.

## The three tiers

Each tier fails independently, is useful independently, and records its own coverage. A tier
that has not run is **absent**, never a default — "not measured yet" and "normal" must never
render the same, or an unindexed project reads as uniformly average footage.

| Tier              | Needs                                                    | Produces                                                                                 | Runs                    |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------- |
| **0 · measured**  | nothing — ffmpeg only                                    | shot boundaries, brightness, warmth, contrast, motion, sharpness, black/freeze, loudness | always, on every import |
| **1 · labelled**  | `framepilot.visual-embed` pack (or an NVIDIA key)        | shot size, subject, setting, screen content, face identity, duplicate takes              | when installed          |
| **2 · described** | `framepilot.visual-describe` pack (or a vision provider) | one structured description per shot: subject, action, setting, camera, on-screen text    | when installed          |

**Tier 0 needs no key, no network and no model**, which is the single most important
property here. On a clean install with nothing configured, the agent still knows which clips
are dark, warm, soft, static or duplicated, and where every shot starts and ends.

What that looks like in a prompt — a clip row goes from

    c12[0–4.2s]

to

    c12[61–66.4s] · MS man at desk · static · bright warm

Words, never numbers. A model handed `0.47` compares it badly and confidently, then invents
a third number to put in a grade. Numbers go to the solvers (`match_color`,
`normalize_exposure`, `apply_look`, the transition policy), which can do arithmetic.

**Cost, measured:** tier 0 runs at ~29× real-time (a ten-hour library in ~20 minutes) and
stores ~643 bytes per shot (~6.3 MB for ten hours). An unindexed project's prompt is
byte-identical to before — zero extra tokens. A fully covered twelve-clip layer costs about
one eighth of a single `get_frame`.

**Why it is safe to have:** like everything in the brain, the ledger is a derived,
rebuildable cache with provenance, never a second source of truth. `project.fp.json` stays
canonical; deleting the derived directory loses time, never work. See
[ADR 0058](../adr/0058-project-brain-derived-sqlite-substrate.md) for the substrate,
[ADR 0175](../adr/0175-perception-is-a-compiled-shot-ledger.md) for the ledger, and
[ADR 0176](../adr/0176-local-perception-ships-as-packs.md) for the packs.

> **Status:** tiers 1 and 2 are implemented but their packs have **no weights yet** — every
> model digest is a placeholder the loader refuses by name, so a pack cannot half-work. No
> accuracy has been measured for either. Tier 0 is complete and measured.

## Architecture

```
  apps/web-editor + apps/desktop
   every acquired asset (import · stock · agent download) → ONE enroller
   Settings → AI → Media intelligence: per-tier coverage, no toggle
        │
  packages/ai-sdk ──────────────────────────────────────────────────
   ledger-client:   GET /brain/shots (paged, cached per content hash)   │ orchestrator
   semantic-index:  picture slice — clip → shots, cut-pair deltas       │ reads only
   context-builder: clip-row words + PICTURE digest (≤600 tokens)       ▼
   solvers (editor-core): match_color · apply_look · transition policy
        │ sidecar-executor (HTTP)
  engine/python sidecar ────────────────────────────────────────────
   POST /brain/visual/index  → tier 0 ALWAYS, then 1 and 2 if available
   GET  /brain/shots         → the ledger a run reads
   POST /brain/visual/search → query embed → KNN → fuse → evidence packets
   GET  /brain/visual/status → per-tier coverage
        │                              │
   analysis/shot_stats.py          brain.sqlite (schema v4)
   (ONE ffmpeg pass, two chains)   ├─ shots      (measured │ labelled │ described)
   brain/governor.py               ├─ entities   (person_NN clusters)
   (yields to render/export/frame) ├─ asset_digest
                                   └─ visual_vectors / visual_spans / visual_captions
        │
   capability packs (ADR 0114/0176), optional, local:
   framepilot.visual-embed → tier 1        framepilot.visual-describe → tier 2
```

The sections below describe the tier-1 sampling and vector machinery, which is unchanged
from the original Media Intelligence design. Tier 0 is described in
`plan/visual-understanding/02-TIER0-SHOT-LEDGER.md`; it needs none of it.

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

**Measurement is not opt-in and needs no key.** Every imported or acquired asset is
measured locally by one ffmpeg pass — shot boundaries, exposure, warmth, motion,
sharpness ([ADR 0175](../adr/0175-perception-is-a-compiled-shot-ledger.md)). The keys
below buy the tiers ABOVE that floor: labelled (embeddings) and described (captions).
The Settings panel reports the three separately, e.g.
`measured 61/61 · labelled 0/61 · described 0/61 — labelled needs an embedding key ·
described needs a vision provider`.

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
- **Enrolment on acquisition.** Every acquired asset — a human import, an agent
  `add_stock` download, a Stock-panel download — is queued by ONE batching enroller in
  the desktop main process (`apps/desktop/electron/ai/asset-enrolment.ts`), which runs at
  most one journaled, resumable, cancellable index job per project at a time. No key is
  required and no setting turns it off; it never blocks import or preview. It is keyed on
  the asset id the sidecar wrote into the brain during derivation, so an asset the brain
  does not know is never enrolled. There is no browser-build equivalent: no sidecar, no
  main process, honest `unavailable`.
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

### What the status line says for a Settings-keyed TwelveLabs project

`GET /brain/visual/status` carries no request body, so the TwelveLabs key — which the
desktop forwards only on the index and search POSTs — is invisible to it. It therefore
reads `keyConfigured` from what is _persisted_: the engine env key, **or** the project's
stored TwelveLabs index id, which only exists because a key was accepted on an index run.
Before that, a project fully indexed on TwelveLabs reported `keyConfigured:false`, and the
one-line status the model reads said "no embeddings key configured, so `search_visual` and
`describe_footage` return nothing" over footage that was ready to search (run a53b7c1f,
2026-09-09). The model quoted it and asked the editor questions instead of looking.

The status line itself also no longer requires a vector count to call a project indexed.
The built-in arm reports `counts.vectors`; the TwelveLabs arm reports `counts.videos` and
`counts.images` and has no vectors of its own, because they live on the hosted index. Any
indexed asset with either kind of count now yields the "use `search_visual` … and
`describe_footage`" line; the "no key" line is reserved for a project with nothing indexed
_and_ no key, and the `0/N — indexing runs in the background` line is unchanged.

**Desktop-first (per `CLAUDE.md`).** The visual index requires the Python
sidecar: the sampler, NVIDIA client, captioner, and vector tables all live in the
engine (single-writer brain invariant). The plain **browser build has no engine**,
so the visual tools honestly report unavailable there — there is no
browser-without-sidecar visual indexing (a stated non-goal). Design and test the
desktop path first.

## Privacy boundary — what leaves the machine

**Nothing, by default.** Tier 0 decodes locally through ffmpeg and always has. Both local
packs run on your machine. A frame leaves only on a **hosted arm**, and only because you
configured its key — which is what configuring it means (ADR 0066).

| Path                                                           | Frames leave?                               |
| -------------------------------------------------------------- | ------------------------------------------- |
| Tier 0 (always)                                                | no                                          |
| `framepilot.visual-embed` / `framepilot.visual-describe` packs | no                                          |
| NVIDIA embeddings (key configured)                             | yes — sampled keyframes, bounded resolution |
| Hosted vision provider for descriptions (key configured)       | yes — 1–3 keyframes per shot                |
| TwelveLabs (key configured)                                    | yes — the asset is uploaded                 |

Keys are never logged, never written to the brain, and never echoed back in a response.

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
