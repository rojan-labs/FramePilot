# Phase 1 — Preparation correctness `[x]` shipped 2026-08-28

**User outcome.** A project containing photos gets prepared and gets a footage map.
One asset a provider refuses no longer freezes every asset behind it. A preparation
run that has stopped says so.

**Evidence required, and delivered:** six engine tests that fail on the pre-fix tree
and pass after (`engine/python/tests/test_service_twelvelabs_stills.py`), plus TS
tests for key forwarding and the panel state matrix.

---

## What changed and why

### 1. Stills are routed off the hosted backend

`service.py:_asset_is_still_image` (new) classifies a brain asset from its stored
probe via `MediaInfo.is_image`. In `_tl_index_slice`, a still is handed to
`_tl_still_image_item`, which drives the **existing** `_index_one_asset` — the
built-in sample → embed → caption path that already understood `is_image`. The
hosted client is never offered a photo.

Why here and not at the worklist: the job's worklist stays "every visual asset", so
coverage still counts photos and the cursor still walks them. Routing is a per-asset
dispatch inside the slice, which keeps one job, one cursor, and one journal.

Without an on-device key the item reports
`"still images are not indexable by TwelveLabs and need an on-device embedding key: …"`
and **the cursor still advances**. An unpreparable asset must never block the ones
behind it — that is the whole lesson of this defect.

### 2. Both keys reach the engine

`media-understanding-runtime.ts` and `apps/web-editor/src/editor/visualIndex.ts` sent
`nvidiaKeys` only when no TwelveLabs key existed. They now always send it. Without
this the routing above would resolve to "no on-device key" for exactly the users who
hit the bug. `apps/desktop/electron/main.ts:visualIndexCredentials` already did this;
the two policies are now one.

### 3. A per-asset provider failure advances the cursor

`_tl_index_slice` now records a `failed` mapping for a refused asset, emits a
`VisualIndexItem` carrying the provider's own message, advances, and continues.

`TwelveLabsAuthError` still stops the run — a bad key fails every asset identically,
so continuing would be pointless and expensive.

A **run** of failures is treated as systemic rather than per-file:
`TL_CONSECUTIVE_FAILURE_LIMIT = 3` consecutive refusals stop the slice with that
reason. The counter is journaled in the job payload (`consecutiveFailures`), not held
per slice — a slice is one asset by default, so a per-slice counter could never reach
the bound and a deleted index would have uploaded every asset in the project, one
billed call at a time. This is a cost guard as much as a correctness one.

### 4. A stopped job is `failed`, not `running`

Both arms now journal `JobState.FAILED` when the slice stops on a provider error or an
exhausted key ring. Previously the state stayed `RUNNING` **with the error attached**,
which is what produced a blue progress badge for work that had given up six minutes
earlier.

### 5. Coverage is the union of both backends

`brain_visual_status_route` now counts `hosted ∪ builtin` prepared assets, using the
new `BrainStore.visual_indexed_asset_ids()`. A TwelveLabs project containing stills is
prepared by both paths at once; counting one of them under-reported forever.

### 6. The footage map merges both arms

`_tl_footage_map` now appends chapters derived from the built-in index for assets the
hosted arm did not serve, via the extracted `_builtin_chapters_for` helper (shared with
`_builtin_footage_map`, so there is one derivation and not two). Without this a photo
project would have been fully prepared and still answered `not_indexed`.

### 7. Stills are captioned

`_tl_still_image_item` passes the request's caption provider through. A photo's caption
**is** its chapter title in the map; without one, a 61-photo map is sixty identical
`Scene 1` rows the model cannot tell apart. The provider already rides on the request
(`captionProvider`) and `visualIndexCredentials()` already populates it.

### 8. The panel stops lying

`SettingsDialog.tsx:describeCoverage` derives the badge from the **job's own state**:
`failed`/`interrupted` reads as a warning with the provider's reason; a user
cancellation reads as idle, not a fault; an empty project reads idle rather than
perpetually mid-run; `running` shows real progress. The on-device and both-keys hints
now describe the routing that actually happens.

---

## Files changed

| File                                                     | Why                                                                                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/python/framepilot_engine/service.py`             | still classification + routing, per-asset failure isolation, journaled failure counter, failed-job state, union coverage, merged map, shared chapter derivation |
| `engine/python/framepilot_engine/brain/store.py`         | `visual_indexed_asset_ids()`                                                                                                                                    |
| `engine/python/tests/test_service_twelvelabs_stills.py`  | new — six regression tests                                                                                                                                      |
| `packages/ai-sdk/src/media-understanding-runtime.ts`     | forward both keys                                                                                                                                               |
| `apps/web-editor/src/editor/visualIndex.ts`              | forward both keys (import + ensure paths)                                                                                                                       |
| `apps/web-editor/src/editor/visualIndex.test.ts`         | both-keys regression                                                                                                                                            |
| `apps/web-editor/src/components/SettingsDialog.tsx`      | honest coverage state matrix, corrected copy                                                                                                                    |
| `apps/web-editor/src/components/SettingsDialog.test.tsx` | failed / cancelled / empty states                                                                                                                               |

---

## What Phase 1 deliberately did **not** do

- **It did not re-open backend selection.** TwelveLabs still owns video and audio when
  configured. Only the capability gate — "this backend cannot index a still" — was
  corrected.
- **It did not fix the time base.** A photo project's chapters are still `0:00–0:00`
  when the photos are unplaced, and the auto-injected map still carries asset seconds
  under a timeline label. → Phase 2. **This is the largest remaining correctness gap
  and it outranks any speed work.**
- **It did not parallelize anything.** → Phase 3.
- **It did not persist per-asset outcomes.** The reasons this phase now produces are
  still returned once and dropped. → Phase 4.
- **It did not backfill.** Existing jammed projects self-heal on their next
  preparation run (a new job, a new worklist, the corrected routing). No migration is
  required because nothing stored changed shape — only `payload.consecutiveFailures`
  was added, and a job without it reads 0.

---

## Verification actually run

- `uv run pytest engine/python/tests` → **2635 passed, 1 skipped, 0 failed**.
- The six new tests, run against a tree with `engine/python/framepilot_engine/`
  stashed → **6 failed**; with the fix → **6 passed**.
- `pnpm engine:lint` → clean. `pnpm engine:typecheck` → 202 files, no issues.
- `pnpm typecheck` → 17/17 tasks pass.
- `@framepilot/web-editor test` → 2603 passed. `@framepilot/ai-sdk test` → 3577 passed.
- `@framepilot/desktop test` → 1 failure, `run-coordinator.test.ts >
latestWorkingStateFor`. **Pre-existing on `main`** (verified by stashing every local
  change and re-running); unrelated to media intelligence.
