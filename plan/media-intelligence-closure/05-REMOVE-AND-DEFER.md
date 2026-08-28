# 05 — Removals, deferrals, and risk `[x]` closed 2026-08-28

---

## 1. Remove

Each entry names the blast radius. Nothing here is removed on the strength of this
document alone — each is its own reviewable change with its own tests.

### 1.1 The `index_media` agent tool — **NOT removed; the audit was wrong**

The audit recommended removing it on the grounds that it "costs prompt tokens in every
run's tool list, invites the model to spend a turn on plumbing, and can start an
expensive hosted run the user never asked for".

**That premise is false.** `index_media` is in `IMPLICIT_ONLY_TOOL_NAMES`
(`packages/ai-sdk/src/tool-scope.ts:44`) and is withheld from every model-facing scope by
`Orchestrator#agentTools`. It is not in the model's tool list, it costs no prompt tokens,
and no model can call it. It is the app's own lifecycle driver — `sidecar-executor`,
`autoIndexImportedAssets`, and the MCP surface external agents drive
(`packages/mcp-server/src/analysis-client.ts`) all depend on it. Removing it would break
the MCP surface and the indexing path itself.

The audit read the tool's _registration_ and its description text and inferred
visibility. That is precisely the trap **ADR 0127** documents, about this exact tool:
_"`validateSkillTools` tested for registration, which `index_media` passes."_ Recorded
here rather than quietly dropped, because the next reader deserves to know the claim was
checked and found wrong.

**What is real, and was left alone:** its _description_ is written as if a model would
read it ("Call it when a visual search reports the footage is not indexed yet"). Nothing
reads it. Not worth a change on its own; fold it into the next prompt-surface pass.

### 1.2 The legacy `/tasks` arm in `TwelveLabsClient.get_task` — **deferred, still load-bearing**

`brain/twelvelabs.py:get_task` falls back to `self._sdk.tasks.retrieve(task_id)` for
mappings persisted before FramePilot adopted the asset workflow. It is a second polling
protocol kept alive for old rows.

**Blast radius.** Any `tl:video` row whose `taskId` lacks an `asset-v1:`/`indexed-v1:`
prefix. Across the user's 43 projects the only surviving hosted mappings
(`project_landspace_nature`) carry **bare ids** — so the legacy arm is still load-bearing
there. **Do not remove yet.** Remove once a re-index has rewritten them, or add a
one-time rewrite that re-resolves those ids and drops the arm in the same change.

### 1.3 The unused `phash` consumer gap — **completed in Phase 2**

`visual_spans.phash` is computed and stored on every span and read by nothing. Either
it earns its column via the near-duplicate signal in Phase 2 §2.4, or it is dropped.
Storing a signal nobody reads is the same maintenance cost as a dead path.
**Completed, not removed:** `FootageChapter.similarGroup` (Phase 2 §2.4) reads it to tell
the model which of its candidates are the same picture twice. The column earns its keep.

### 1.4 Two implementations of "which keys do we send" — **done**

Phase 1 collapsed the renderer's `!tlKey && nvidiaKeys` rule into the desktop's "send
both". Four call sites still assembled the credential object by hand, and one of them was
the bug. `understandingCredentials(config)` in `apps/web-editor/src/editor/visualIndex.ts`
is now the single policy, used by the import warm-up, the ensure gate, and the panel's
retry. `apps/desktop/electron/main.ts:visualIndexCredentials` stays separate — it also
resolves the caption provider from main-process-only config, so folding it in would drag
renderer code across the process boundary for no gain.

### 1.5 An unclosed `httpx.Client` per resolution — **done**

`resolve_visual_embedder` constructs `httpx.Client()` and never closes it; the same
holds for the captioner resolution. Both are called per request on the built-in route,
so a long preparation run leaks one client per slice. Phase 1 made the hosted route's
still-image resolution **lazy** so a video-only project does not pay for one, but the
underlying pattern is unchanged. Not a removal — a lifecycle fix: resolve once per
process and reuse, or close in a `finally`. **Do it with Phase 3**, where concurrency
multiplies the leak by the concurrency limit.

**Shipped.** Both `visual_embed` and `captioner` now hold one lazily-created
process-wide `httpx.Client` behind a lock, used whenever a caller does not inject its
own. This also earns back most of the point of issuing embedding requests together:
a shared client is what makes connection reuse possible.

### 1.6 Not a removal candidate, despite appearances

`_builtin_footage_map` and `_tl_footage_map` look like parallel implementations. They
are not: they are two genuinely different derivations (Pegasus generative vs. span/caption)
over one shared chapter builder (`_builtin_chapters_for`, extracted in Phase 1). Keep both.

---

## 2. Deferred, with reasons

| Deferred                                 | Reason                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any third understanding backend          | Two is already more than the product has proven it needs. `.agents/rules/product-discipline.mdc` §5.                                                                        |
| Shot-quality ML (focus, exposure, shake) | Real editing value, but it is a detector — i.e. a Capability Pack, whose boundary `ADR 0114` already owns. Measure the montage-quality gain before paying for the boundary. |
| Subject/person presence and tracking     | Same boundary. Automatic CV tracking already shipped separately; do not fork a second path here.                                                                            |
| Re-opening backend selection             | The maintainer's 2026-08-28 decision (per-asset capability routing, hosted keeps video/audio) stands. Do not silently reverse it.                                           |
| Cross-project concurrency                | One project at a time is the actual workflow.                                                                                                                               |
| Sampling-rate and proxy tuning           | Measured at 1.6% of wall clock. Optimizing it is optimizing the part that does not matter.                                                                                  |
| Browser-build parity for any of this     | Desktop is the priority path (`CLAUDE.md`). Browser gaps here are acceptable.                                                                                               |

---

## 3. Risk register

| Risk                             | Exposure                                                                                                                                            | Mitigation                                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider licensing**           | The `twelvelabs` SDK is UNLICENSED and adopted as an accepted risk (`ADR 0071`). Every hosted feature inherits it.                                  | Unchanged by this plan. The per-asset routing shipped in Phase 1 _reduces_ exposure: photo projects now work with no hosted dependency at all.                                                                   |
| **Cost per project**             | Measured: 11 videos ≈ 11 uploads + 11 Pegasus map calls. Phase 3 raises the _rate_, not the count — but a systemic failure now burns assets faster. | `TL_CONSECUTIVE_FAILURE_LIMIT` (shipped) bounds it; Phase 3 must evaluate the bound against completed assets in worklist order so concurrency cannot outrun it. A cost test asserts N assets ⇒ N provider calls. |
| **Privacy posture divergence**   | Hosted: source media leaves the device. On-device: **sampled JPEG frames leave the device** (the panel currently denies this).                      | Phase 4 §4.4 corrects the copy and documents per-backend transmission in `docs/guides/`.                                                                                                                         |
| **Re-billing on reopen**         | The `tl:map` content-hash cache is index-independent and already prevents it.                                                                       | Regression cover exists; keep `cachedOnly` on the per-run read.                                                                                                                                                  |
| **Silent unsearchable projects** | Demonstrated: 55 assets, 100 `done` jobs, zero index.                                                                                               | Phase 4 §4.1 — persist outcomes and stop letting `done` mean "we stopped".                                                                                                                                       |
| **Schema drift Zod ↔ Pydantic**  | Phase 2 adds `timeBase`, Phase 3 adds `coverage` to `FootageMapResponse`.                                                                           | Both are additive on a derived, rebuildable artifact; both sides change in one commit; an absent field reads as the conservative default. No `project.fp.json` migration.                                        |
| **Rollback**                     | Every phase is independently revertable. Phase 1 stores nothing new except an integer in a job payload that reads 0 when absent.                    | No backfill or reprocessing is required for any phase; existing projects self-heal on their next preparation run.                                                                                                |

---

## 4. Migration and rollout

**Nothing stored changes shape in a way that requires a migration.** The artifacts this
plan touches — `visual_spans`, `visual_vectors`, `visual_captions`, `analysis_results`
rows (`tl:video`, `tl:map`, and the proposed `visual:outcome`), and the `visual-index`
job payload — are all **derived and rebuildable from the media**. They are not part of
`project.fp.json`.

**Backfill.** None required. A project prepares on its next semantic need or import,
using whatever routing is then current. The 61-photo project that triggered this work
recovers on its next run with no user action.

**Avoiding re-billing during rollout.** Two rules, both already in the code and both to
be preserved by every phase: the `tl:map` cache is keyed on content hash and served
before any live fetch, and the per-run context read passes `cachedOnly: true` so a cold
project never turns a background context assembly into a billed Pegasus call.

---

## 5. Outcome

| Candidate                            | Outcome                                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `index_media` agent tool             | **Not removed.** The audit's premise was wrong — it is already model-invisible and is the app's own lifecycle driver. Corrected above.    |
| Legacy `/tasks` polling arm          | **Deferred.** Still load-bearing: the only surviving hosted mappings on this machine carry bare task ids. Needs a one-time rewrite first. |
| Unused `phash`                       | **Completed, not removed** — Phase 2's `similarGroup`.                                                                                    |
| Duplicated credential assembly       | **Removed** — one `understandingCredentials` helper.                                                                                      |
| Leaked `httpx.Client` per resolution | **Fixed** — one shared client per process, in both the embedder and the captioner.                                                        |

Two of five were real removals, one was a completion, one was correctly deferred, and one
was a bad call caught before it broke the MCP surface. Writing the wrong one down and then
checking it is the process working, not a failure of it.
