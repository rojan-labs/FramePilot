# 00 — Diagnosis and subsystem audit

Every claim here cites a file, a line, or a row read out of the user's own brain
databases under `~/Documents/FramePilot Projects/.framepilot-derived/`. Nothing is
estimated or inferred where a measurement was available.

---

## 1. The reported defect

**Symptom.** Settings → AI → Media intelligence showed
`Project coverage: 0/61 assets prepared · 0%` with a blue **running** badge, both keys
configured, "TwelveLabs ready". No footage map was ever produced.

**Live state, read from the project's own brain**
(`.framepilot-derived/project_beat_sync_champadevi_mtbws6ztmw6v/brain.sqlite`):

| Fact                                      | Value                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| assets                                    | 61, **all `format_name = image2`** — WhatsApp photos, one video stream, no audio, bogus `0.04s` duration                                 |
| `fields` row `twelvelabs/index/id`        | `6a908e5ff20f9b17742803d4` — the TL index was created                                                                                    |
| `analysis_results` `kind='tl:video'` rows | **1** — asset `…19_47_01`, `status: "indexing"`, `videoId: null`, `taskId: "asset-v1:6a908e5ff20f9b17742803d4:6a908e61f20f9b17742803d9"` |
| `visual-index` jobs                       | **3**, all `state='running'`, `progress=0.0`, `payload.cursor=0`, `payload.assetIds` length 61                                           |
| every job's `error`                       | `TwelveLabs API error (HTTP 404) (resource_not_exists).`                                                                                 |
| job timestamps                            | 19:22:13, 19:25:32, 19:28:47 — three attempts, six minutes, identical outcome                                                            |

**Assumption A was wrong.** The 61 assets are not a mix. They are photos only. A
mixed project fails differently — see §1.4.

**Assumption B was right, and stronger than stated.** The state was not a transient
snapshot. The pipeline could not leave `running` at `0%`; it was a permanent terminal
state that merely reported itself as progress.

### 1.1 The chain, hop by hop

1. **Import → classification.** `engine/python/framepilot_engine/media/probe.py:107`
   classifies these files correctly: `MediaInfo.is_image` is `True` for `image2`. The
   codebase's known still-image hazard (classify on `format_name`, never on the bogus
   `0.04s` duration) is present and correct.
2. **Worklist.** `service.py:_resolve_visual_job` builds the worklist from
   `_asset_is_visual`, which tests `MediaInfo.has_video` — **`True` for a photo**. All
   61 photos were enqueued. The `is_image` distinction existed but was never consulted
   at this hop.
3. **Backend selection.** `service.py:brain_visual_index_route` resolves TwelveLabs
   **before** the on-device embedder, per project, for the whole worklist. The UI copy
   ("TwelveLabs takes priority") describes the code accurately.
4. **Provider request.** `_tl_index_slice` uploaded photo #1 via
   `TwelveLabsClient.create_index_task` → `POST /assets`, which **succeeded** (the
   mapping row proves an asset id was minted). The next step,
   `_advance_uploaded_asset` (`brain/twelvelabs.py:488`), then raised
   `404 resource_not_exists` — either on `assets.retrieve` or on
   `indexes.indexed_assets.create`. The persisted mapping still carries the
   `asset-v1:` token, which is only replaced _after_ a successful advance, so the
   failure is at that step and not later.
   The vendored SDK documents `POST /assets` as accepting "Video, audio, and images",
   with images supported for **entity search** only
   (`.venv/.../twelvelabs/assets/raw_client.py:148,164`). FramePilot uses a Marengo
   _video_ index. A still uploads and then has nowhere to go.
5. **Head-of-line block.** The old `_tl_index_slice` caught `TwelveLabsError` and
   `break`, leaving the cursor at 0. Every retry rebuilt the same worklist in the same
   order and hit photo #1 again. **This is why one bad asset became a dead project.**
6. **Coverage accounting.** `brain_visual_status_route` computed
   `indexed = len(video_to_asset_map(store))` — TwelveLabs mappings only — against
   `total_assets` counted from `_asset_is_visual`. `0/61`.
7. **Footage map.** `_tl_footage_map` walks `video_to_asset_map(store).values()`,
   which was empty, so `served_assets == 0` → `reason: "not_indexed"`. **The map was
   never created because nothing upstream ever completed.**
8. **Job honesty.** Phase 3 of the slice wrote
   `state=DONE if done else RUNNING` with `error=stop_reason`. A job that had given up
   was journaled as `running` **with its error attached** — and the panel derived its
   badge from coverage, not from the job, so it rendered blue progress forever.

### 1.2 Symptom, trigger, root cause

- **Root cause:** still photos were dispatched to a hosted backend that structurally
  cannot index them, and the hosted slice treated a single asset's provider error as
  a reason to stop without advancing the cursor.
- **Trigger:** a project whose first asset is a still. Any project. The 61-photo case
  is the maximal version; a mixed project loses everything after the first photo.
- **Symptoms (two, one cause):** `0/61 prepared` _and_ `map not created` are the same
  bug observed at two hops. The map is downstream of the mapping rows the index never
  wrote.
- **Which of (a)–(e) from the brief:** **(e) blocked by a provider/capability
  precondition** — and, because of the `break`, it escalated into (a) for every asset
  behind the first one.

### 1.3 Why this was invisible

Three independent surfaces each hid it:

- the job journal recorded `running` for a job holding a terminal error;
- the panel's badge was `indexed < total ? 'running' : 'completed'` — it never read
  the job at all (`SettingsDialog.tsx`, pre-fix);
- per-asset outcomes (`VisualIndexItem[]`) are returned in the HTTP response and then
  dropped. Nothing persists them. The only trace of _why_ is a `_log.warning` in a
  sidecar process the user never sees.

### 1.4 Behaviour of the other paths, verified

| Path                                   | Behaviour with a still                                                                | Behaviour with one bad file                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Built-in / NVIDIA (`_index_one_asset`) | **Correct.** Explicit `is_image` branch, `sample_asset(is_image=True)`, one keyframe. | **Correct, and commented as a lesson learned:** per-asset `FrameExtractionError`/`FFmpegError` returns a failed _item_ and advances. |
| TwelveLabs (`_tl_index_slice`)         | **Broken** (pre-fix): no `is_image` awareness at all.                                 | **Broken** (pre-fix): `break` without advancing.                                                                                     |

The built-in path had already learned exactly this lesson — its source carries the
comment _"one bad file in a project permanently blocks indexing every other asset,
since a re-run always hits the same asset first (cursor order)"_. The hosted path,
added later, never inherited it.

---

## 2. Subsystem audit

### 2.1 Preparation lifecycle and ownership

- **Journal.** One `visual-index` job per run, `payload = {assetIds, cursor}`, in the
  per-project `brain.sqlite`. `service.py:_resolve_visual_job`.
- **Pacing.** `DEFAULT_VISUAL_SLICE = 1` asset per HTTP call, capped at
  `MAX_VISUAL_SLICE = 10`. The host re-POSTs until `done`
  (`visual-index-client.ts:runVisualIndexLoop`).
- **Mutual exclusion.** `_visual_index_lock(project_id)` serializes every index call
  for a project.
- **Dedup/join.** `media-understanding-runtime.ts:preparationFlights` joins concurrent
  `ensureMediaUnderstanding` calls by `projectId|backend|assets|refresh`.
- **Restart.** `sweep_interrupted_jobs_once` flags non-terminal jobs `interrupted` on
  first touch after a sidecar restart. Working — 12 such rows exist across the user's
  projects.
- **Entry points that start preparation:** renderer import
  (`visualIndex.ts:autoIndexImportedAssets`), first semantic need
  (`ensureProjectMediaUnderstanding`), the agent's `index_media` tool
  (`sidecar-executor.ts`), agent stock enrolment (`main.ts:enrolStockAsset`), and
  TwelveLabs ASR (`main.ts:transcribeTwelveLabs`). Five entry points, one journal.

### 2.2 Backend routing — what the code actually does

`resolve_twelvelabs(...)` is tried before `resolve_visual_embedder(...)` per project.
The Settings copy is truthful about that. Two consequences the copy did **not** say:

- pre-fix, the on-device key was _withheld_ from the request whenever a TwelveLabs key
  existed (`media-understanding-runtime.ts`, `visualIndex.ts`: `!tlKey && nvidiaKeys`),
  so the engine had no fallback available even if it had wanted one;
- `visualIndexCredentials()` in `apps/desktop/electron/main.ts:1688` already forwarded
  **both** keys, so the desktop agent and stock paths behaved differently from the
  renderer import path. Two paths, two policies, silently.

### 2.3 Footage map — inputs, cache, identity

- **TL arm:** per asset, `tl:map` cache keyed on `analysis_results.params_hash =
content_hash`; a miss with a ready mapping calls Pegasus; `cachedOnly` withdraws
  permission to fetch. Cache-first and index-independent — a reopened project keeps
  its map and is not re-billed. This part is sound.
- **Built-in arm:** derived live from `visual_spans` + `visual_captions`. No cache
  needed; nothing is billed.
- **Identity:** project id from the file name, asset content SHA-256. Deterministic.
- **Survives reopen:** yes for TL (`tl:map` rows), yes for built-in (spans persist).

### 2.4 The time-base defect (independent of the reported bug)

`map_footage`'s tool description promises times "in timeline seconds". The map is
projected onto timeline time by `project_span_to_timeline` using `clips_by_asset`,
built from the project document in the request body.

`apps/desktop/electron/main.ts:2294` reads the per-run map with
`{ projectId, cachedOnly: true, ...credentials }` — **no `project`**. So
`clips_by_asset` is empty, `project_span_to_timeline` returns `[]`, and every chapter
falls back to `(span.t0, span.t1)` — **asset seconds**. The block injected into every
agent run is therefore labelled timeline time and carries asset time.

On a single-asset project starting at 0 they coincide, which is why this survived. On
any multi-asset project the model reads chapter boundaries that do not exist on the
timeline. `search_visual`/`describe_footage` return asset seconds _and say so_; the
map says the opposite of what it does. → Phase 2.

### 2.5 What the AI actually receives

| Surface                              | Shape                                                                                  | Granularity                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Auto-injected context block          | `summarizeFootageMap()` text, ≤24 chapters + ≤8 highlights, `+N more`                  | **`m:ss`, whole seconds** (`footage-map.ts:clock`) |
| `map_footage`                        | `{chapters, highlights, summary, durationSec}`                                         | float seconds                                      |
| `search_visual` / `describe_footage` | `EvidencePacket{assetId, t0, t1, sceneId, score, caption, transcriptOverlap, sources}` | float **asset** seconds                            |

Gaps against what an editing agent needs to choose an in/out point:

- **Rounded time in the prompt.** The always-present digest quantizes to one second.
  A cut planned from it can be half a second off before any tool is called.
- **Mixed frames of reference** across the three surfaces (§2.4).
- **No `assetId` in the rendered digest lines.** The data carries it; the text drops
  it. On a 61-photo project every line would read `0:00–0:00 Scene 1` — indistinguishable.
- **Nothing about shot quality.** No focus, exposure, shake, or camera-motion signal;
  no subject/person presence; no duplicate/similar-take detection (the `phash` column
  exists on `visual_spans` and is never used for this); no b-roll suitability.
- **`transcriptOverlap` is text only** — no word times, so speech-aligned cutting has
  to re-derive alignment from the transcript.

### 2.6 Performance — measured, not estimated

Read from job `created_at`/`updated_at` in the user's own brains:

| Project                    | Work                                       | Wall clock  | Per asset                      |
| -------------------------- | ------------------------------------------ | ----------- | ------------------------------ |
| `project_landspace_nature` | TwelveLabs, 11 videos, 6.3 min of footage  | **544 s**   | 49 s/asset ≈ **1.4× realtime** |
| `project_champadevi_hike`  | built-in, 60 photos + 1 video, no captions | **92.7 s**  | **1.55 s/asset**               |
| `project_check_indexing`   | built-in, 56 assets, 50 captions           | **318.5 s** | **5.7 s/asset**                |

Local cost of the same work, measured directly on those files with `ffprobe`/`ffmpeg`
on this machine:

| Operation                  | Cost      |
| -------------------------- | --------- |
| probe a photo              | 24–25 ms  |
| extract one photo keyframe | 24–25 ms  |
| extract one video keyframe | 57–134 ms |

60 photos therefore cost **≈1.5 s of local CPU** against **92.7 s measured**.
**≈98% of preparation wall clock is serialized network wait.**

Where the serialization is:

1. one asset per HTTP slice (`DEFAULT_VISUAL_SLICE = 1`) and a strictly sequential
   host loop (`runVisualIndexLoop` awaits each slice);
2. `_visual_index_lock(project_id)` — one in-flight slice per project by construction;
3. `VisualEmbedClient.embed_passages` iterates batches of 8 **sequentially**
   (`visual_embed.py:195`);
4. **multiple NVIDIA keys are failover, not throughput.** `KeyRing.acquire` returns
   "the first alive key", always. The Settings hint invites comma-separated keys; the
   user reasonably reads that as parallelism. It is not.
5. the TL arm polls one asset up to `TL_SLICE_POLL_BUDGET_SECONDS = 30` before
   yielding, and uploads are strictly one at a time.

### 2.7 Reliability, security, observability

- **Idempotency/resume:** solid. `existing_visual_span_keys` and the content-hash
  mapping mean re-running costs nothing for unchanged bytes.
- **Cancellation:** journaled flag, checked at the top of each slice. Works.
- **Secrets:** keys travel in request bodies, host-owned, never read from disk by the
  engine, never logged. `visual-index-client.ts` and the engine both hold this line.
  The renderer _can_ read the TL and NVIDIA keys (they are forwarded); the Pexels key
  is main-only. That asymmetry is deliberate and documented.
- **Privacy claims vs. code:** the panel says on-device embeddings send "only the
  embedding request… never the media". A JPEG keyframe is base64'd into the request
  body (`visual_embed.py:_to_data_uri`). **Pixels do leave the machine** — a downscaled
  keyframe, not the source file. The claim as worded is false. → Phase 4.
- **Observability:** a `_log.info("ACT visual index: …")` per slice, `_log.warning`
  per failure. Nothing per-asset is persisted, so a failure is undiagnosable once the
  process ends. Proof: `project_new_proj_mtbeyu802xjq` holds **55 assets, ~100
  `visual-index` jobs all `state='done'`, and zero `visual_spans` and zero `tl:video`
  rows.** Every job completed having indexed nothing, and the reason is gone.

---

## 3. Missing / remove / defer — summary

### Missing (detailed per phase)

1. Truthful time base on the auto-injected map (Phase 2).
2. `assetId` and sub-second precision in the model-facing digest (Phase 2).
3. Concurrent preparation and real multi-key throughput (Phase 3).
4. Persisted per-asset outcomes (Phase 4).
5. An honest panel state matrix with recovery (Phase 4, partially shipped in Phase 1).
6. Truthful privacy copy for the on-device path (Phase 4).

### Remove

Listed with blast radius in `05-REMOVE-AND-DEFER.md`. Headline candidates: the
`index_media` agent tool (a manual index step the product says does not exist), the
legacy `/tasks` compatibility arm in `TwelveLabsClient.get_task`, and the unused
`phash` column consumers.

### Defer

No new understanding provider. No shot-quality ML. No re-opening of backend selection
beyond the per-asset capability routing already shipped.
