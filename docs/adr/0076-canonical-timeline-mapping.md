# ADR 0076 — One canonical source↔sequence mapping; captions derive from the edit (schema v12)

- **Status:** Accepted (2026-07-26)
- **Extends:** [ADR 0071](./0071-caption-cue-and-track-style-schema-v11.md) (caption cues own
  their text, schema v11) — cue text, per-cue styling, and the single shared
  segmenter are unchanged. This ADR changes only *which timebase* a cue lands in
  and *how anyone can tell* whether it is still valid.
- **Packages:** `packages/timeline-schema`, `packages/editor-core`,
  `packages/ai-sdk`, `apps/web-editor`, `engine/python/framepilot_engine`

## Context

A transcript's timestamps belong to the **source asset**: word 42 sounds at 19.2s
of the camera file. A timeline clip's timestamps belong to the **sequence**: it
plays from 6.4s to 19.0s of the edit, showing source 6.86s–19.5s.

Through schema v11 nothing in the codebase held that distinction.
`Project.transcript` was a flat `{word, start, end}[]` with no asset attribution,
and every consumer read its timestamps as if they were sequence timestamps. That
is true for exactly one timeline shape — a single untrimmed clip starting at
t=0 — which is the state a project is in *before anybody edits it*. So the defect
was invisible in every simple case and wrong in every real one:

- `apps/web-editor/src/editor/captions.ts` segmented the raw transcript and wrote
  the resulting times straight onto the caption track. It received the timeline
  and used it only to find existing clips to clear.
- `packages/ai-sdk/src/kernel/recipe-leaves.ts` did the same in the AI recipe
  path. Since `add_captions` runs *after* the structural edit in every recipe
  that has one, the broken case was the common case.
- `captions/cue.ts`'s pre-v11 fallback compared transcript time against
  `clip.start`/`clip.end` — two different timebases, silently.

The observed failure: an agent rippled six non-contiguous source ranges
(6.86–19.5, 28.5–53.45, 110–119.5, 132–142, 155–170, 197–208) into a ~92s
timeline, then captioned it. Every caption carried a source timestamp. The last
range's speech was captioned at ~197s on a 92s sequence. **Every operation
returned `applied`, and the agent reported captions and transitions as complete.**

Three separate things had to be wrong at once for that to ship:

1. **No mapping existed.** A grep for `sourceToSequence|timelineMap|sequenceTime`
   across `packages/ engine/ apps/` returned nothing. The only way to relate the
   two timebases was arithmetic at the call site — and in the agent's case, in
   *prose*: "source time minus segment source start, plus segment timeline
   start, with separate offsets per retained segment."
2. **Nothing could detect staleness.** Cues carried no record of the timing they
   were computed against, so a caption invalidated by a later trim was
   indistinguishable from a correct one.
3. **Nothing could contradict a completion claim.** There was no `verify_*` tool
   in the 59-tool registry. "The operation returned applied" was the only
   evidence available, and it is not evidence of anything the user cares about.

`add_transition` had the same shape of bug in its own domain: it stamped a
transition effect onto whatever `toClipId` named, checking neither adjacency nor
track nor order. A transition requested at a narrative pivot *inside a continuous
clip* applied cleanly and rendered nothing.

## Decision

### 1. The transcript is source-relative, and says so (schema v12)

`TranscriptWord` gains `assetId` (plus optional `confidence`/`speaker`).
`Project.transcript` is documented as source time. The timestamps do not change —
they were always source-relative; only the *contract* was missing.

The v11→v12 migration stamps `assetId` when the project has exactly one asset,
where the attribution is provable. Multi-asset v11 transcripts are genuinely
ambiguous and are left unattributed rather than guessed at; the mapper treats an
unattributed word permissively, which is the v11 behaviour.

The fields are `.nullish()`, not `.optional()` — the same cross-language contract
`AssetMedia` already documents. Pydantic serializes an absent optional as JSON
`null`, and a bare `.optional()` would reject a live engine transcript and fail
the whole project parse.

### 2. `editor-core/timeline-map.ts` is the only place that converts

`buildTimelineMap(timeline)` resolves every media clip into a `ClipSpan`
(`assetId`, source in/out, sequence in/out, `speed`, track). `mapSourceTime` and
`mapSequenceTime` convert between the timebases.

`mapSourceTime` returns a **list**. The relationship is genuinely one-to-many: a
source instant can appear zero times (it was cut) or several (the range was
reused). A shape that returns a single number invites the "one obvious answer"
assumption, which is the assumption that was wrong.

Caption and overlay tracks are excluded from the map: they carry no real source
range, and including them would let the thing being derived feed back into the
derivation.

### 3. Captions derive from the edit, in a fixed order

`captions/derive.ts`: map words through the timeline → drop what the edit deleted
→ group survivors into runs that never cross a cut → segment each run
independently → clamp each cue to its run.

Segmentation itself is untouched. `segmentCaptions` remains the single authority
on where a cue breaks linguistically (ADR 0071); this layer decides only *which
words exist and when they happen*.

Two decisions inside that are worth recording:

- **Runs break on a change of clip, even when the clips abut.** After a ripple
  delete two non-contiguous source ranges are visually continuous, but the words
  either side were never spoken together and a cue must not bridge them.
- **A word straddling a cut follows a majority rule**: kept where most of it was
  heard, dropped if less than half survived anywhere. "Any overlap keeps it" was
  the alternative and puts 5%-retained words on screen in full — deleted speech
  appearing in captions, which is the failure this exists to prevent.

  **Amended (2026-08-05): the majority is measured against the shorter of the
  word and the clip.** As first written, the half was always half the *word*,
  which has no useful answer when the clip is shorter than the word being spoken
  over it — a 0.1s stinger, a silence-removal sliver, a rapid-fire b-roll cut can
  never retain half of a 0.4s word, so every such clip was captioned as silent.
  Short clips came out with no captions at all, however much speech played over
  them. Judged against the clip, the question becomes the one that matters on
  screen: *is this word what the viewer hears for most of this shot?* The two
  readings coincide wherever the clip is the longer of the pair, so every normal
  cut keeps exactly the behaviour above and the amendment engages only where the
  original rule had nothing to say. A word can now clear the bar on two adjacent
  slivers at once, so the winner remains the largest overlap — the word is still
  captioned once, on the clip carrying most of it.

The clamp matters more than it looks: `segmentCaptions` legitimately extends a
cue past its last word to enforce a minimum on-screen duration and to bridge
flicker gaps, and without a clamp that extension spills across the very cut the
pipeline is respecting.

### 4. `timeline.revision` makes staleness detectable

A monotonic counter, bumped by `applyOperation` when — and only when — the
source↔sequence mapping actually changed. Cues record `derivedFromRevision` and
their `source` range, so a stale caption is a comparison rather than an
assumption.

**The gate is a comparison of the mapping, not a list of "structural" op types.**
Classifying ops gets it wrong in both directions, and one of those directions is
fatal: caption *generation* clears the old cues with `delete_range` on the
caption track, so an allowlist containing `delete_range` would mark every caption
stale the instant it was written, and the pipeline would never once report a
synchronized result.

**The counter moves forward through undo rather than rewinding.** Rewinding is
the dangerous direction — a caption derived *after* an edit would look current
again while matching neither state. Over-reporting staleness costs a remap;
under-reporting costs a wrong caption in the export.

### 5. Transitions must prove a cut exists

`listEditBoundaries` finds the real cuts; `transitionEligibility` judges a
request against them and explains any refusal in terms the caller can act on;
`applyOperation` refuses rather than pretending; `readTransitionAt` reads the
committed effect back so the claim can be checked.

**Deliberately not gated on source handles.** The first cut of this module was,
copying conforming NLEs, and it was wrong for this engine.
`render/transitions.py` ramps the **incoming clip's own** first
`durationSeconds`, which the top-down compositor renders as a true cross-dissolve
where clips overlap and a fade-from-black where they are sequential — "one
primitive, both cases". Nothing is borrowed from beyond the cut. A handle gate
would have refused transitions the renderer produces perfectly well, including
the default cross-dissolve the timeline UI drops onto a cut. Handles are still
measured and reported, because they are the difference between blending two shots
and fading through black.

**A duration the cut cannot carry is clamped, not refused — and the clamp is what
gets applied.** `transitionEligibility` has always returned the fitting duration
(plus `clampedFrom`) rather than a refusal, on the reasoning that "a half-second
dissolve at a 0.4s cut" means *dissolve here*, not *fail*. Until 2026-08-05
`applyAddTransition` computed that verdict and then wrote the **requested**
duration onto the effect, so the post-apply `transition_overlap` check rejected
the patch — and every cut between clips shorter than twice the UI's 0.5s default
(silence-removal output, stingers, quick b-roll) could take no transition at all,
from the UI, the AI and MCP alike. The op now stores `eligibility.durationSeconds`
for both halves of the ramp. Only a boundary with no usable room at all is still
refused, and the `transition_overlap` check remains as the guard on effects that
did not come through the op — hand-edited files, imports, projects from a newer
build.

### 6. Completion must be verified, not asserted

`verify_captions` and `verify_transitions` (in `packages/ai-sdk/src/verify.ts`,
exposed as read tools) check committed state and report concrete issues: cues
past the end, over gaps, across cuts, over deleted speech, out of sync beyond a
stated tolerance, stale, or of unknown provenance; transitions with no cut
beneath them, naming the wrong outgoing clip, or overrunning the shot.

The agent contract now names the two timebases, bans the conversion arithmetic
outright, states the order of work (cuts → captions → styling → transitions and
motion) with the dependency reason attached, and separates "applied" from "done":
if verification did not run, the honest report is "applied but not verified".

`get_transcript`'s description previously said its window was in "timeline
seconds". That was itself teaching the offset math, and is corrected.

## Consequences

**Good.**

- Offset arithmetic exists in exactly one tested module. The AI reads the answer.
- Deleted speech cannot be captioned; a cue cannot span a cut.
- A caption invalidated by a later edit is detectable, including after a reload.
- A transition that cannot render can no longer be reported as added.
- The same source transcript is reusable across edits, because it is never
  rewritten into sequence time.
- Multi-asset transcripts are unambiguous, and the ASR routes now establish the
  attribution where it is actually known.

**Costs and limits.**

- Schema v12 and a migration. Existing projects open unchanged; their captions
  report `caption_provenance_unknown` until regenerated, which is honest rather
  than free.
- Captioning a timeline with no media now correctly produces nothing. Test
  fixtures carrying a caption track and no footage were testing a state no real
  project is in, and were given the footage.
- Verification checks timeline state, not rendered frames. It catches everything
  in the observed failure, but "the transition is visible in playback" is still
  proven only by a render. Frame-level verification is deliberately out of scope
  here.
- Nested/compound sequences are not modelled by the schema, so the mapping does
  not address them. When they arrive, `buildTimelineMap` is the one place that
  has to learn to flatten them.
- `resolveCaptionCue`'s pre-v11 fallback still derives a cue's words by comparing
  transcript time against clip time, and its call sites still pass the raw source
  transcript. Every cue generated since v11 carries its own text and never reaches
  that path, so it fires only for projects captioned before v11 — but for those,
  on an edited timeline, it shows the wrong words. Its contract is now documented
  at the definition; the fix belongs at the call sites that hold the timeline, and
  is deliberately not bundled here.

## Alternatives considered

**Fix the offsets at the call site.** Rejected: it is the same arithmetic in a
new place, and it breaks identically on speed, reuse, straddling words, and later
edits.

**Rewrite the transcript into sequence time when captions are generated.**
Rejected: it destroys the transcript's reusability across edits and makes the
project file lossy — the source timing is what allows a *remap* after the next
trim instead of a regeneration.

**Make `revision` a content hash instead of a counter.** Rejected: a hash returns
to a previous value after an undo, which is precisely the false-negative
("these captions look current again") that the monotonic counter avoids.

**Teach the model to do the mapping more carefully.** Rejected outright, and it
is the crux of this ADR. The arithmetic is not hard; it is *unverifiable in
reasoning text* and silently wrong under six different edit shapes. Determinism
belongs in the engine.
