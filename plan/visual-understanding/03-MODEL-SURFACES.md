# 03 — Phase VU2: the agent reads the ledger through the timeline

**User outcome.** Ask "make the dark clips match the rest" or "what is on screen at 0:42" and
the agent answers from facts on the first turn, with no tool call and no frame. After it
edits, it can say what changed on screen.

**Scope gate.** Gap: clip rows are `id[start–end]`; the picture slice does not exist
(`00-DIAGNOSIS.md` §2.2). Minimum slice: ledger snapshot → `picture` slice → clip-row suffix

- digest + `get_clips`/`list_edit_boundaries` facts + briefing PICTURE line. Reuse: semantic
  index, `ProjectIndex.clipsOfAsset`, context-builder tiers, briefing distil, existing tools.
  Deferred: any new tool, any UI.

## VU2.1 Ledger snapshot to the run `[ ]`

- Engine: `GET /brain/shots?projectId=…&assetIds=…` returns shots for the given assets
  (all tiers, bounded to 5,000 rows per call, paged by `(asset_id, shot_index)`), plus
  `asset_digest` rows and a `coverage` block.
- ai-sdk: `ledger-client.ts` fetches once at run start for the assets the timeline references,
  caches by `(assetId, contentHash, tier versions)` on the host for the process lifetime, and
  refetches only for assets added during the run (`add_clip`, `add_stock` outcomes) or when a
  tier completes (the index loop's `done` event for an asset already referenced).
- Desktop main passes the snapshot into the run the same way it passes the footage map today
  (`context-builder` input). The MCP server does the same through its session.

## VU2.2 The `picture` slice `[ ]`

`kernel/semantic-index/picture.ts`: `derivePicture(index, ledger): PictureSlice` per
`01-ARCHITECTURE.md` §6. Pure, memoized per project snapshot via the existing WeakMap scheme.

- Clip → shots by mapping the clip's source range through speed and trim
  (`clipsOfAsset` already does this for `shots`/`silences`).
- Cut pairs: adjacent picture clips on the same layer whose `end`/`start` touch within one
  frame. Deltas from the dominant shot of each side. Flags from fixed thresholds in one
  constants block: `exposure_jump` |Δluma.mean| > 0.15, `wb_jump` |Δwarmth| > 0.25,
  `size_jump` |Δsteps| ≥ 3, `jump_cut` same asset and phash Hamming ≤ 6 with a gap under 2 s,
  `black_in`, `soft_in` (sharpness < 0.35).
- Coverage counts drive an honest line when a tier is missing.

## VU2.3 Clip rows carry facts `[ ]`

`context-builder.ts` `renderTrackClips`: `inFull(c)` appends ` · ${factSuffix(c)}` when the
clip has a dominant shot. `factSuffix` is a pure function in `context/shot-words.ts`:

```
[shotSize?] [subject-or-summary ≤ 40 chars] · [motion word] · [exposure word] [warmth word] [flags?]
c12[61–66.4s] · MS man at desk · static · bright warm
c13[66.4–70s] · WS street, traffic · handheld · dim cool ⚑soft
```

Rules: ≤ 90 chars; `labelled` words only at `p ≥ 0.6`; `described.summary` only when no
label; never a number; one flag glyph max. A clip with only `measured` facts still prints
motion and exposure words. Token delta is measured (VU2.7); the budget is the existing
`maxClipsPerLayer`, unchanged.

## VU2.4 Project digest block `[ ]`

A new tiered block `picture digest` beside `footage map` in `buildContext`, ≤ 600 tokens,
built from `asset_digest` rows only:

```
PICTURE — 14 assets · 212 shots · median shot 4.8s · coverage measured 14/14, labelled 14/14, described 9/14
People: person_01 (86 shots, "host"), person_02 (12 shots)
Settings: indoor-office 61%, street 22%, kitchen 9%
Shot sizes: CU 18% · MS 47% · WS 35%   Motion: static 70% · handheld 22% · fast 8%
Exposure: 3 assets dim (a_7f3, a_812, a_9c0); warmth spread wide (−0.4…+0.5)
Low quality: 7 shots soft, 2 black spans
```

The footage map block stays for chapters; the digest is what "knows everything on any
footage" looks like in 600 tokens.

## VU2.5 Tools return facts `[ ]`

- `get_clips` / `get_clip`: add `picture: { dominant: ShotFacts, shots: [...] }` with
  provenance and confidence intact. Paged as today.
- `list_edit_boundaries`: add the cut's `delta` and `flags`. This is the input the transition
  policy and the verifier read; exposing it also lets the model explain a cut.
- `describe_footage`: packets carry `described.summary` when present, else a words line from
  `measured`/`labelled`. Time base unchanged (asset seconds, stated).
- `search_visual`: unchanged shape; ranking gains a `facts` filter (`shotSize`, `motion`,
  `entities`, `setting`) so "wide shots of the street" is a filter, not a hope.
- Tool descriptions updated by the lead-prompt-engineer pass; the shape test in
  `tool-domains` must pass (a tool needs a domain).

## VU2.6 Briefing PICTURE line `[ ]`

`kernel/briefing.ts` `buildStateBriefing`: after an apply that changed picture clips, render
≤ 3 lines from the diff of `picture.cuts` before/after:

```
PICTURE — cut at 12.0s now MS→WS (+1.1 stops brighter) ⚑exposure_jump · cut at 18.4s unchanged
```

Inherited flags (present before the run) print as advisories, never as shortfalls
(memory: verification judges the delta).

## VU2.7 Evidence `[ ]`

- Unit: `picture.test.ts` (join, speed/trim mapping, flags, memoization), `shot-words.test.ts`
  (budget, thresholds, provenance gating), context-builder snapshot for rows and digest.
- Golden: run the 21 cases on `main` and on this branch with ledgers built for the fixtures.
  Report `frames_seen_per_edit`, target resolution, tokens per accepted edit. Expect tokens up
  by the row suffix and digest, frames unchanged or down, target resolution up on
  `broll-first-20s`, `montage-30s`, `vague-make-better`. Record the tables here.
- New golden cases (from `06`): `which-clips-show-host`, `whats-on-screen-at`, `find-dark-clips`.
  Each must resolve from the digest or rows without `get_frame`.

## VU2.8 Definition of done

`[ ]` VU2.1–VU2.7 · `[ ]` ai-sdk suite green, goldens regenerated with the measured token
delta (memory: golden manifests track prompt text) · `[ ]` desktop and MCP both pass the
snapshot · `[ ]` docs: `docs/guides/media-intelligence.md` "what the model reads" section ·
`[ ]` CHANGELOG · `[ ]` plan reconciled.
