# Phase 2 — Time base and the LLM-consumption contract `[x]` shipped 2026-08-28

> **This phase outranks Phase 3.** A fast index the model reads in the wrong time
> base produces fast wrong cuts. Correctness before speed.

**User outcome.** When the agent says "cut at 1:14", the cut lands at 1:14. When it
picks between two photos, it can tell them apart.

**Current gap.** Three defects in what the model actually reads, all cited in
`00-DIAGNOSIS.md` §2.4–2.5.

---

## 2.1 The auto-injected map carries asset seconds under a timeline label `[x]`

`apps/desktop/electron/main.ts:2294` reads the per-run footage map with no `project`
in the body. `_clips_by_asset` is therefore empty, `project_span_to_timeline` returns
`[]`, and every chapter silently falls back to source seconds — while
`map_footage`'s tool description promises "timeline seconds" and the digest header
says "the structure of what is IN the footage, in order".

On a single-asset project starting at 0 the two coincide. On every multi-asset project
the model is reading boundaries that do not exist on the timeline.

**Fix.** Send the live working project with the per-run read, exactly as
`fetchFootageMap` already does from the renderer. The projection is pure arithmetic
over clips already in memory — no provider call, so `cachedOnly` still holds and
nothing new is billed.

**Then make the frame of reference explicit rather than assumed.** `FootageMapResponse`
gains a `timeBase: 'timeline' | 'asset'` field echoing what the request asked for, and
`summarizeFootageMap` labels the block accordingly. A response that cannot project
(no project document supplied) must answer `timeBase: 'asset'` and be rendered as such
— never silently relabelled.

**Schema obligation.** `timeBase` is additive on a derived, brain-only, rebuildable
artifact. `footageMapSchema` (Zod) and `FootageMapResponse` (Pydantic) change together
in one commit; an older engine omitting the field reads as `'asset'`, which is the
conservative truth. No `project.fp.json` migration — the map is not part of the
project document.

**Evidence.** A test with two assets where asset B starts at t=30 on the timeline:
the run-injected digest must place B's chapters at 30+, and must place them at 0+ when
`assetTime` is requested. Plus a golden-manifest regeneration for the context block
(the digest text is token-counted — see `plan/…` golden manifests).

## 2.2 The digest quantizes to whole seconds and drops the asset `[x]`

`footage-map.ts:clock()` renders `m:ss`. The always-present block is the model's
default reading of the footage, and it is rounded to ±0.5 s before any tool is called.
The rendered lines also omit `assetId`, which the data carries.

**Fix.**

- render `m:ss.d` (tenths) — one extra character per row, ~2% of the block's tokens,
  in exchange for placing cuts inside a frame at 24–30 fps rather than half a second
  out;
- group rows by asset with a short asset header when the map spans more than one
  asset, so the model can address footage by name;
- when `t0 == t1` (a still), render the asset header and the caption and omit the
  meaningless range instead of printing `0:00–0:00`.

**Why each field earns its tokens.** The digest budget is `MAX_DIGEST_CHAPTERS = 24`
rows. A row that cannot be acted on — no asset, no usable time — costs tokens and
buys nothing; a tenth of a second costs one character and is the difference between a
usable and an unusable in-point.

**Evidence.** A rendering test over a two-asset map and a photo-only map; the token
delta measured against the existing golden manifests and recorded in the commit.

## 2.3 One documented frame of reference across all three surfaces `[x]`

Today: `map_footage` says timeline, `search_visual`/`describe_footage` return asset
seconds and say so, and the injected block says neither. The model is expected to
reconcile them.

**Fix.** Every model-facing time carries its base explicitly, in the payload and in
the tool description. `EvidencePacket` gains nothing — it is already honest — but the
`map_footage` description and the digest header are rewritten to match §2.1, and the
editing skills that consume them (`packages/ai-sdk/skills/edit-prep.md`) are updated in
the same change.

**Evidence.** A skill-level test that a run reading the map and then calling
`describe_footage` on a chapter gets overlapping spans back, on a project whose second
asset does not start at 0.

## 2.4 What the index does not store that an editing agent needs `[x]` (duplicate signal only)

Ordered by value per unit of cost, from the audit's gap list. **Only the first item is
proposed for this phase**; the rest are recorded so the next agent sees the shape and
does not re-derive it.

| Signal                                 | Why an editor needs it                                                                                                                                                              | Cost                                                          | Proposal                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Near-duplicate / similar take**      | Photo dumps and multi-take footage are the two cases where a montage repeats itself. `visual_spans.phash` **already exists and is already computed** and nothing reads it for this. | ~zero — a Hamming distance over stored ints                   | **Shipped** as `FootageChapter.similarGroup` — union-find over the sampler's own threshold, singletons unmarked, rendered `[~n]`. |
| Shot quality (focus, exposure, shake)  | "Do not cut to the blurry one"                                                                                                                                                      | one extra ffmpeg pass per keyframe                            | Defer — measure the montage-quality gain first                                                                                    |
| Subject/person presence                | "cut to the wide of both of them"                                                                                                                                                   | a detector, i.e. a Capability Pack                            | Defer — `ADR 0114` already owns this boundary                                                                                     |
| Word-level speech alignment in packets | speech-aligned cutting                                                                                                                                                              | transcript already has word times; it is a join, not new data | Defer to a follow-up; cheap but not blocking                                                                                      |
| Camera motion (pan/tilt/static)        | b-roll suitability, punch-in choice                                                                                                                                                 | optical flow per span                                         | Defer                                                                                                                             |

**Evidence for the duplicate signal.** The user's own `project_champadevi_hike`
(60 photos of one hike) is the fixture: consecutive frames of the same scene must
group, and visibly different scenes must not.

---

## Deferred from this phase, with reasons

- **No new understanding provider.** Two are already more than the product has proven
  it needs.
- **No re-ranking or learned retrieval.** RRF over three retrievers is working; there
  is no measured recall complaint.
- **No change to `EvidencePacket`'s shape** beyond the duplicate hint. It is the one
  contract in this subsystem that is already honest about its units.

---

## What shipped, and what it cost

- **2.1** Both per-run reads (desktop hub, browser session) send the live edit.
  `FootageMapResponse` carries `timeBase` (defaulting to `asset` on both sides, so an
  older engine is never read as having answered in timeline time) and `unplacedAssets`.
- **2.2** `m:ss.d`, grouped by asset, stills rendered as `at 0:12.5`, clock stated.
- **2.3** `map_footage`'s description and the `footage-intelligence` skill tell the model
  to read `timeBase` and `unplacedAssets` before acting on a time.
- **2.4** `similarGroup` only. The other four signals in the table above stay deferred
  for the reasons given there.

**Measured token cost:** the tool-schema block grew 17,648 to 17,740 (+92) for the
`map_footage` description. The three frozen golden sets were regenerated and that diff
is the measurement.

**Still open, deliberately:** `describe_footage`/`search_visual` do not carry
`similarGroup`. The map is where shot selection happens; adding it to every evidence
packet would cost tokens on the retrieval path with no demonstrated consumer.
