# Phase 4 — Per-asset outcomes and the panel state matrix `[ ]`

**User outcome.** When preparation does not finish, the user can see which assets
failed and why, and recover — without a manual "index" button reappearing.

**Current gap.** The definitive evidence is in the user's own data:
`project_new_proj_mtbeyu802xjq` holds **55 assets, ~100 `visual-index` jobs all
`state='done'`, zero `visual_spans`, zero `tl:video` rows.** Every job completed
having prepared nothing, and the reason no longer exists anywhere. That project is
silently unsearchable and nothing in the product says so.

---

## 4.1 Persist per-asset outcomes `[ ]`

`VisualIndexItem{assetId, ok, indexed, captioned, reason}` is computed, returned once
over HTTP, and dropped. The `_log.warning` that survives is in a sidecar process the
user never sees, and is gone at restart.

**Fix.** Write each terminal item to the brain as an `analysis_results` row
(`kind='visual:outcome'`, `params_hash=content_hash`) — the same table, key discipline,
and invalidation the `tl:video` and `tl:map` rows already use. A changed asset
invalidates its own outcome; nothing accumulates.

This is deliberately **not** a new store. Reuse over infrastructure.

**Then `done` stops meaning "we stopped".** A job whose items are all `ok: false` is
not a success. Add `preparedAssets`/`failedAssets` to `VisualStatusResponse`, sourced
from those rows, so a project that indexed nothing reports it.

**Evidence.** A test where every asset fails: the job must not report a clean `done`,
and `GET /brain/visual/status` must name the failures.

## 4.2 The panel state matrix `[ ]`

Phase 1 fixed the four states that made the reported bug invisible. The full matrix
the brief asks for is:

| State       | Condition                                                        | Badge     | Copy                                              | Recovery offered                 |
| ----------- | ---------------------------------------------------------------- | --------- | ------------------------------------------------- | -------------------------------- |
| no-key      | neither key set                                                  | idle      | "Local facts only" + what still works             | — (shipped)                      |
| key-invalid | `lastJob.error` = `invalid_api_key`                              | warning   | "That key was rejected."                          | focus the key field              |
| idle        | `totalAssets == 0`                                               | idle      | "No media to prepare yet."                        | — (shipped)                      |
| queued      | assets present, no job yet                                       | idle      | "Prepares on import or first semantic need."      | — (shipped)                      |
| running     | `lastJob.state == 'running'`                                     | running   | `n/N · p%` + **what it is waiting on**            | cancel                           |
| partial     | run finished, `failedAssets > 0`                                 | warning   | "N assets could not be prepared."                 | **view failures**, retry those N |
| complete    | `indexed >= total > 0`                                           | completed | `N/N`                                             | re-prepare                       |
| stalled     | `state == 'running'`, `updatedAt` older than 2× the slice budget | warning   | "Preparation has not advanced since HH:MM."       | retry                            |
| failed      | `state == 'failed'` with an error                                | warning   | the provider's reason (shipped)                   | retry                            |
| cancelled   | `state == 'failed'`, error `cancelled by user`                   | idle      | "Resumes on the next semantic request." (shipped) | resume                           |
| offline     | client returned `undefined`                                      | warning   | "The media engine is unreachable." (shipped)      | —                                |

**Recovery without a manual index step.** The product's stated contract is "there is no
manual indexing step" and an e2e test enforces it
(`tests/e2e/specs/visual-embeddings-settings.spec.ts`). Retry must therefore be framed
as _recovery from a named failure_, never as a general "Index now" button: it appears
only in the `partial`, `stalled`, `failed`, and `key-invalid` rows, it is labelled for
what it retries ("Retry 3 failed assets"), and it disappears when there is nothing to
retry. **The existing e2e assertion stays and must keep passing.**

**Reuse the design system.** All of this is `SettingGroup`/`setting-row`/`ai-tone` and
existing `styles.css` tokens. No new component language.

**Evidence.** One RTL test per row; the existing "offers no manual indexing controls"
e2e spec still green.

## 4.3 Say what waiting means `[ ]`

`running` currently shows a percentage and nothing else. On the hosted path the wait is
someone else's queue; on the on-device path it is embedding round-trips. The row should
name it — "uploading to TwelveLabs (3 of 11)" vs "embedding frames (18 of 61)" —
sourced from the backend already on the status response. A progress bar that explains
itself is the difference between "slow" and "broken".

## 4.4 Correct the privacy claim `[ ]`

The panel states that with on-device embeddings "only the embedding request leaves it,
never the media". `visual_embed.py:_to_data_uri` base64-encodes a **JPEG keyframe** into
the request body. Pixels do leave the machine — sampled, downscaled frames rather than
the source file, which is a meaningful distinction, but the current wording is false.

**Fix.** Say what is true: _"Sampled frames are sent to NVIDIA for embedding; the source
files never leave this machine, and search runs locally."_ Same change reviews the
TwelveLabs row, which is already accurate ("Media may leave this device").

This is a copy change, but it is a **security/privacy correctness** item and is treated
as such: it goes in the same commit as a `docs/guides/` note on what each backend
transmits, per AGENTS.md §11.

## 4.5 Structured logging pass `[ ]`

The engine logs slices, not decisions. Add scoped `log.action`/`debug` at the hops the
diagnosis had to reconstruct by hand: routing choice per asset, backend resolution per
project, cursor advance with the reason it advanced, and cache hit/miss on `tl:map`.
The bar: _the next instance of this class of failure is diagnosable from logs alone,
without reading the source._ Python `logging.getLogger`, TS `createLogger` — never
`print`/`console.log` (AGENTS.md §7).
