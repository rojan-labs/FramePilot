# Media Intelligence — Execution Handoff

> Working doc for whoever continues executing `plan/MEDIA-INTELLIGENCE.md`.
> Branch: **`feat/media-intelligence`**. Created 2026-07-18.
> The plan file itself is the source of truth for *what*; this file is *where we are*.

---

## TL;DR — where we are

Phases **MI0 (config/keys/UI) and MI1 (adaptive sampler) are DONE and committed.**
Phase **MI2.1 (NVIDIA embed client) is written and passing but NOT yet committed** —
it sits in the working tree from an earlier session. MI2.2–MI2.4 and MI3–MI7 are
**not started**.

Do **not** re-plan or rewrite finished work. Pick up at "Next action" below.

---

## Branch & commit state

Branch `feat/media-intelligence`, built on `main` at merge commit `d7af9b4` (PR #95, desktop packaging).

Commits already landed (oldest → newest):

| SHA | Phase | What |
|-----|-------|------|
| `acae9f8` | — | docs(plan): media-intelligence sub-plan authored, marked `[~]` in progress |
| `8467457` | **MI0.3** | `brain/keyring.py` — multi-key failover state machine (100% branch cov) |
| `65d50ac` | **MI1.1, MI1.3** | `analysis/visual_sampler.py` — scene-aware spans + dHash dedupe (100% branch cov) |
| `8f8752d` | **MI0.1** | `nvidiaEmbeddings` key slot + `embeddingsAutoIndex` flag; host→sidecar config plumbing |
| `25b17ab` | **MI0.2** | Settings → AI → Embeddings subtab (plaintext visible key, auto-index toggle) |
| `e389a34` | chore | untrack `.coverage` artifacts + gitignore them |

**Every commit trailer:** `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
Keep committing per-step (user's explicit instruction: "commit every step").

### Uncommitted working-tree state (MI2.1 — verified passing, just needs a commit)

```
 M engine/python/framepilot_engine/brain/__init__.py   # exports for visual_embed symbols
 M engine/python/pyproject.toml                          # httpx main dep, respx dev dep
 M pyproject.toml                                         # respx dev dep (root mirror)
 M uv.lock                                                # resolved (respx)
?? engine/python/framepilot_engine/brain/visual_embed.py       # 355 lines, the client
?? engine/python/tests/test_visual_embed.py                    # 364 lines, 25 tests
```

Verified 2026-07-18: `uv run pytest engine/python/tests/test_visual_embed.py -q` → **25 passed**;
`visual_embed.py` reports **100% branch coverage** from its own test file.

---

## NEXT ACTION (do this first)

**Commit the MI2.1 work that's already in the tree**, then continue with MI2.2.

1. Review `visual_embed.py` against plan §3.2 (it looked complete: `VisualEmbedClient`,
   `resolve_visual_embedder`, `EmbedResult`, `VisualEmbedError`, keyring integration,
   `MODEL_ID = nvidia/llama-nemotron-embed-vl-1b-v2`, `EMBEDDINGS_URL`, `NO_API_KEY_REASON`).
   Confirm it covers: passage/query modality split, batching, split-on-413/400,
   401/403 dead + 429/5xx cooldown rotation via `KeyRing`, `dim` captured from first
   response (never hardcoded), exhaustion → typed `{available:false, reason:"all_keys_failing"}`,
   keys never logged.
2. Run `pnpm engine:test && pnpm engine:lint && pnpm engine:typecheck` — all must be green.
3. Commit **everything in the list above together** (the deps + lock belong with the client that needs them):
   ```
   feat(engine): NVIDIA visual embedding client — batching, split-on-413, keyring failover (MI2.1)
   ```
4. Then proceed to MI2.2.

---

## Remaining phases (task list mirrors these — TaskList IDs #1–#9)

The in-session task tracker has: #1 MI2.1 (in_progress → close after the commit above),
#2 MI2.2, #3 MI2.3, #4 MI2.4, #5 MI3, #6 MI4, #7 MI5, #8 MI6, #9 MI7.

### MI2.2 — brain migration v3 + store API  *(task #2)*
Add `_migrate_v3` to `brain/migrations.py` (append to `MIGRATIONS` tuple; `SCHEMA_VERSION`
auto-derives). **Plain tables only — NOT vec0** (virtual-table loadability varies; the vec0
index is owned by the MI2.3 seam):
- `visual_spans` — PK `(asset_id, model, sampler_version, t0)`, cols incl. `t1, scene_index,
  keyframe_t, phash TEXT, content_hash, frame_count, created_at`. Matches the plan idempotency
  key `(content_hash, model_id, sampler_version, t0)`.
- `visual_vectors` — PK `(asset_id, model, sampler_version, t0)`, `dim INT, vector BLOB`
  (pack with existing `pack_vector` from `brain/embeddings.py`), FK → `visual_spans`.
- `visual_captions` — PK `(asset_id, scene_index, t0)`, `text, source DEFAULT 'model', model,
  created_at` (provenance column per §3.3).
- `BrainStore` methods mirroring `replace_embeddings`/`list_embeddings`: `upsert_visual_spans`,
  `list_visual_spans`, `existing_visual_span_keys(...)→set[float]` (resume-skip),
  `upsert_visual_vectors`, `list_visual_vectors`, `upsert_visual_captions`,
  `list_visual_captions`, `delete_visual_asset` (re-index), `visual_index_counts()` (status).
- Pydantic row models in `brain/models.py` (camelCase aliases): `VisualSpanRow`, `VisualVectorRow`, `VisualCaptionRow`.
- Check `sidecars.py`: if it enumerates tables generically, include the new ones; if hand-picked,
  leave alone with a comment — visual data is derived and rebuilt by **re-indexing**, not restore (per MI7.2).
- Tests: fresh create, v2→v3 upgrade preserves data, store round-trips, idempotent upsert.
- Commit: `feat(engine): brain migration v3 — visual_spans/visual_vectors/visual_captions + store API (MI2.2)`

### MI2.3 — vector store seam  *(task #3)*
New `brain/vector_store.py`, one search API over two backends (plan D4):
- **sqlite-vec** (`vec0`) when loadable. Add `sqlite-vec>=0.1.6` (Apache-2.0) to
  `engine/python/pyproject.toml` main deps with a license comment; run `pnpm license:scan`.
  Load guarded: `import sqlite_vec; conn.enable_load_extension(True); sqlite_vec.load(conn)` —
  catch `AttributeError`/`ImportError`/`sqlite3.OperationalError` → log reason + fall back,
  **never raise**. Mirror the `fts5_available` probe-and-degrade shape in `migrations.py`.
  Probe: `vec_available(conn) -> tuple[bool, str|None]`.
- **Brute-force fallback**: existing `cosine_top_k` (`brain/embeddings.py`) over `visual_vectors`.
- API: `ensure_index(conn, dim)`, `upsert(...)` (writes durable BLOB rows AND the vec0 index
  when available; vec0 is derived + rebuildable), `search(conn, q, k, asset_ids?, time_range?)
  -> list[VisualHit]`, `backend() -> 'sqlite-vec'|'brute-force'` for status.
- Tests: **parity test** — identical top-k ordering both backends (monkeypatch loader to force
  fallback); load-failure degrade; filters; empty index. 100% branch cov (exception branches via monkeypatch).
- Commit: `feat(engine): sqlite-vec vector store seam with honest brute-force fallback (MI2.3)`

### MI2.4 — desktop packaging  *(task #4)*
Bundle the sqlite-vec native lib per-OS into the PyInstaller sidecar.
- Spec: `engine/python/framepilot-engine.spec` — add the `.so`/`.dylib`/`.dll` to `binaries`
  (likely `collect_dynamic_libs('sqlite_vec')` + `copy_metadata('sqlite_vec')`).
- Build script: `apps/desktop/scripts/package-engine.mjs` (PyInstaller onedir).
- Smoke-test that the packaged sidecar loads vec0 (or degrades honestly).
- Add a release-checklist entry in `docs/guides/release-checklist-v1.md`.
- **This is an ask-before item** per plan §4 (new dependency + packaging). The user has already
  greenlit executing the whole plan, but flag license-scan results and any packaging risk in the commit body.
- Commit: `feat(desktop): bundle sqlite-vec into packaged sidecar (MI2.4)`

### MI3 — caption pipeline  *(task #5)*
`brain/captioner.py` — per-scene VLM captions via the configured vision-capable provider.
**Known blocker (surfaced during mapping):** the TS provider registry (`packages/ai-sdk/src/providers/`)
has **no multimodal/image message support** today — `AiMessage.content` is a bare `string`, and captions
run engine-side (D6), so the provider key must reach Python. Two sub-decisions to make:
1. Where the VLM call runs. Cleanest with the current architecture: the **host** resolves the vision
   provider + key and the sidecar receives them in the `/brain/visual/index` request body (same channel
   as the NVIDIA keys per MI0.1's request-payload decision), OR the engine calls the provider HTTP API
   directly (Anthropic/OpenAI-compatible) with a key passed in the request body. Recommend engine-side
   direct HTTP (keeps D6 "work runs in sidecar" true) — add a small vision client, don't try to reuse
   the TS providers from Python.
2. Multimodal message shape. If you route through TS instead, you must add image-content support to
   `providers/types.ts` + each adapter first — larger scope; avoid unless necessary.
- Write captions with `source='model'` provenance via the store; keep prompt factual/terse (≤2 sentences).
- MI3.2: ingest captions → FTS5 (`reindex_*`-style) + text embeddings (existing ONNX `Embedder`) when available.
- Mocked tests incl. provider-unavailable honesty. Commit: `feat(engine): per-scene VLM caption pipeline (MI3.1, MI3.2)`

### MI4 — index orchestration & jobs  *(task #6)*
- `POST /brain/visual/index` in `service.py` (FastAPI, routes are nested fns in `create_app`).
  **Use the paced-slice journaled-job pattern** — copy `/analyze/batch` (`service.py:~1958`),
  NOT a thread/asyncio task. Each call does a bounded slice (sample→embed→caption→store), advances
  the cursor in the `jobs` journal payload, returns `{jobId, cursor, total, done}`; caller re-POSTs
  until done. Resumable (idempotency via `existing_visual_span_keys`), cancellable, progress-reporting.
- MI1.2 frame extraction lands here: reuse `extract_frames_route` pattern (`service.py:~2091`) —
  ffmpeg via `extract_frame`, bounded resolution, `resolve_within` sandbox, temp handling. Feed decoded
  9×8 grayscale grids into `analysis/visual_sampler.dhash` (the sampler is pure; decode happens here).
- MI4.2: auto-trigger on asset import when a key is configured (`embeddingsAutoIndex`), low priority,
  never blocking import/preview.
- MI4.3: `GET /brain/visual/status` — coverage/counts (`visual_index_counts`), backend (`vector_store.backend()`),
  key health (`KeyRing.health()`), last error. Then wire the web-editor Embeddings subtab placeholder
  (already structured for this in `SettingsDialog.tsx` `EmbeddingsSettings`) to real status + progress + cancel + "Index now".
- Commits: split sensibly (`MI4.1` route/job, `MI4.2` auto-trigger, `MI4.3` status + UI wiring).

### MI5 — retrieval & fusion  *(task #7)*
- `POST /brain/visual/search {projectId, query, k, assetIds?, timeRange?}`: embed query (nemotron
  `input_type:"query"`) → `vector_store.search` KNN → in parallel FTS5 (captions+transcript) + text-vector
  search → **reciprocal-rank fusion** → evidence packets `{assetId, t0, t1, sceneId, score, caption,
  transcriptOverlap, sources[]}`.
- Span→timeline-time mapping tests; asset/time-range filters.
- **Golden retrieval tests with pinned vectors, no live API** (§6).
- Commit: `feat(engine): visual search with RRF fusion over vectors+captions+transcript (MI5.1, MI5.2)`

### MI6 — orchestrator grounding (ai-sdk)  *(task #8)*
- Tools in `packages/ai-sdk/src/tool-registry.ts` (register as `analysisTool`s, mirror the
  `search_media`/`find_similar` pattern at ~`:1282`): `search_visual`, `describe_footage`, `index_media`.
  Add route arms in `sidecar-executor.ts` (`planSidecarCall` + route maps + `unwrapVisualSearch`
  interpreter mirroring `unwrapSearch`). MCP parity is **automatic** via `buildMcpTools` — but a
  `tools.test.ts` guard enforces it, so update expectations. Declare `capabilities: ['analysis','visual']`
  for tool-scope. Wipe-guard review = confirm they emit no ops (they're non-mutating).
- Context-builder (`context-builder.ts`) visual-status line + honest-unavailable string; add a
  `visualStatus` reader in `brain-client.ts` (Zod mirror; parity-tested by
  `test_brain_client_ts_parity.py` — keep TS↔Python shapes in sync).
- MI6.3: prompt guidance pass (delegate to `lead-prompt-engineer` agent) — retrieve-before-assume
  for content-dependent edits; golden orchestrator-stream test showing a visual query round-trip.
- Commits: `MI6.1` tools, `MI6.2` context line, `MI6.3` prompts + golden test.

### MI7 — hardening, eval, docs  *(task #9)*
- MI7.1 perf budgets (search p95 <100ms @ 50k vectors; indexing throughput on real desktop-scale media —
  delegate to `performance-monitor`).
- MI7.2 failure drills: mid-job kill/resume, key exhaustion mid-batch, brain rebuild = re-index reproduces the index.
- MI7.3 **evaluate** blending visual hits into `find_similar`; ship only if golden-set quality improves
  (honest: may defer with a documented reason).
- MI7.4 docs: `docs/guides/media-intelligence.md`, the **three ADRs** (§4: sqlite-vec adoption amending
  B3's "no vector DB"; NVIDIA cloud visual embeddings + data-leaves-machine consent; plaintext key storage +
  multi-key failover), `CHANGELOG.md`; e2e settings→index→orchestrator-uses-`search_visual`.
- Reconcile `plan/MEDIA-INTELLIGENCE.md` checkboxes (`[ ]`→`[x]`) and `plan/PLAN.md` snapshot. Delegate
  docs to `docs-maintainer` / `changelog-maintainer`, plan to `plan-keeper`.

---

## Hard-won context (don't rediscover these)

- **Keys reach Python via request payload** on `/brain/visual/*` routes (host reads plaintext config,
  puts keys in POST body), with env fallback `FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS` in `config.py`
  (`Settings.nvidia_embeddings_keys`). There was **no per-request key channel before** — MI0.1 established it.
  Env var is already in `.env.example` + `turbo.json globalEnv`.
- **`.env.example` is permission-denied** to direct Read/Write on this machine. Read via
  `git show HEAD:.env.example`; write via a scratchpad file + `cp`. (Already handled for MI0.1.)
- **`nvidiaEmbeddings` config slot is READABLE back** by the renderer (unlike write-only chat keys) —
  explicit user requirement D5 (plaintext, visible). It is NOT a chat provider; not in `AiProviderName`/`REAL_PROVIDERS`.
- **Job model has NO background worker** — jobs are paced across HTTP calls (`/analyze/batch` is the template).
- **No `enable_load_extension` precedent** anywhere — MI2.3 is net-new; mirror `fts5_available`'s probe-and-degrade.
- **respx + httpx are new to the engine** (added in the MI2.1 WIP) — first HTTP client engine-side. No live NVIDIA calls in any test tier (§6).
- **Coverage invocation gotcha:** the dotted-module form `--cov=framepilot_engine.brain.x` crashes on this
  machine with a numpy "cannot load module more than once" error. Use the repo-native `--cov --cov-branch --cov-report=term-missing` form.
- **Provider registry has no multimodal support** — the MI3 caption blocker (see MI3 above).
- **Electron renderer:** never `window.prompt/confirm/alert` (use inline inputs). Logging: `createLogger`
  (TS) / `logging.getLogger` (Python), never log key values.
- **Rebuild shared-types composite before downstream typecheck** if you edit shared-types (stale `.d.ts`).
- DoD gates: `pnpm verify` + `pnpm engine:test`/`engine:lint`/`engine:typecheck` green; 100% branch coverage
  on the deterministic core (sampler ✓, keyring ✓, still owed: vector-store seam, fusion, span math).
  CI is stricter than local `verify` (runs `test:coverage`; apt ffmpeg differs from local 8.1) — run touched
  packages' coverage before push.

## Verified-green baseline (as of this handoff)
Full engine suite was **1084 passing** after MI0/MI1; MI2.1 WIP adds 25 more (all passing). Web-editor
1152 passing, desktop 222 passing after MI0.2.
