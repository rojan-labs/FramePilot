# Phase 3 — Reference videos and images as first-class AI context — `[~]`

> **Ships:** a user attaches reference videos and images in the AI sidebar; each is
> analyzed **once** into a structured profile; the profile enters the P1.3 `memory`
> block and the plan; "make it feel like this" and "use our logo" work; a later turn can
> say "same as the reference" without re-attaching.
> **Does not ship:** copying content from a reference; a generic asset-management
> subsystem; video generation.
> **Depends on:** Phase 1 (P1.3 structured state, P1.5 decision memory).
> **Schema/deps:** **YES — `[!]` on P3.3.** Persisting reference profiles in the project
> file is a `timeline-schema` change (Zod + Pydantic + migration + ADR). Everything else
> in this phase can proceed with profiles held in the session store until the gate clears.

## Current state (verified 2026-08-29)

- `Composer.tsx` creates `image` / `document` attachment chips from paste or file; the
  `Attachment` type in `apps/web-editor/src/ai/conversation.ts` already has `'video'` in
  its `kind` union but nothing creates one.
- Chips live in `AiSidebar.tsx` state and in the persisted `ConversationUiState`; **they
  are not put on the `AiStreamRequest`**. The only image path into the model is
  `HostToolOutcome.images` from `get_frame` (`orchestrator.ts`), and those are dropped
  from history the next turn on purpose.
- Media analysis that already exists and must be reused: `map_footage`, `index_media`,
  `detect_beats`, `measure_color`, `get_frame`, transcript, the visual-embedding brain
  (`engine/python/framepilot_engine/brain`, optional TwelveLabs backend), and the
  `MediaProbe`/`VisualEvidence` contracts in `media-evidence.ts`.

## P3.1 — Attach video and image files, with previews — `[~]`

**Touches:** `Composer.tsx`, `AiSidebar.tsx`, `apps/desktop/electron/preload.cts` +
`ipc/` (a `references:pick` dialog channel restricted to media types), `fp-media://`
resolution for the preview thumbnail. Chips become tiles: thumbnail (first frame or the
image), name, duration for video, a role badge (P3.2), remove button; drag-and-drop onto
the composer; multiple attachments. Files are copied under the project's sandboxed
`references/` folder through the existing asset enrolment (`asset-enrolment.ts`) so the
sandbox does not widen.
**Done when:** attach three videos and two images, see tiles, remove one, reload — tiles
persist (session store).

Landed 2026-08-29: composer attach control (`video/*,image/*`), chunked import into the
project's media dir (same path as the bin), `framepilot:references:analyze` IPC →
sidecar `/references/analyze` (sandboxed, content-hash cached), role + analysis state on
the chip, ready profiles sent as `references`. Remaining here: thumbnail tiles instead of
chips, drag-and-drop onto the composer, and chip persistence across reload (P3.6/P3.7).

## P3.2 — Role classification — `[x]`

**Touches:** new `packages/ai-sdk/src/references/role.ts` (pure). A reference has a
`role`: `style` | `pacing` | `caption-style` | `color` | `brand-logo` | `thumbnail` |
`b-roll` | `character` | `design`. Determine it from (a) the user's words in the same
turn ("our logo", "grade like this"), (b) cheap deterministic signals (PNG with alpha and
small dimensions → likely logo; a video → style/pacing by default), (c) if still
ambiguous, one small-tier model call **once**, never per turn. The user can change the
role from the tile.
**Done when:** the six fixture images and three videos get the expected roles from (a)/(b)
alone in the table test; the model fallback is exercised by one test.

Landed 2026-08-29: `references/role.ts` (`decideReferenceRole`, 13 table tests). Decision:
no model fallback — an undecidable attachment is returned `ambiguous: true` with the
`style` default, and the tile lets the editor change the role (P3.6). A per-turn model call
to guess a purpose is exactly the kind of request this mission removes.

## P3.3 — Reference profiles: analyze once, store, reuse — `[~]` (types + constraints landed; analysis route and cache next)

**Touches:** new `packages/ai-sdk/src/references/profile.ts` (types + builder),
sidecar route `POST /references/analyze` in `service.py` (reuses scene detection, beat
detection, color measurement, caption OCR if present, shot-length statistics, motion
magnitude from existing analysis modules), evidence store keyed by content hash.

```text
ReferenceProfile {
  id, role, contentHash, analyzedAt, backend,
  video?: { durationS, shotCount, medianShotS, shotLengthP10P90, cutsPerMinute,
            transitionKinds[], motionLevel, cameraMovement, aspect, fps,
            captionStyle?: { position, casing, emphasis, wordsPerCard },
            music?: { bpm, energy }, colorSummary: { temperature, contrast, saturation, palette[] } }
  image?: { role-specific: { dominantColors[], hasAlpha, aspect, subjectBox?, textDetected? } }
  constraints: string[]          ← derived, editor-vocabulary lines the planner cites
}
```

The `constraints` are what the model reads (≤ 12 lines); the raw numbers are for
controllers. A profile is computed once per content hash and reused across turns and
sessions. **Persistence:** session store first; the project-file field needs the schema
gate — write ADR + migration draft, mark `[!]`, continue.
**Done when:** attaching `ref/fast-cut.mp4` twice runs analysis once (cache hit logged);
the profile JSON snapshot matches for the fixture; `constraints` reads as editor language.

## P3.4 — Profiles enter context and the plan — `[~]`

**Touches:** `context-builder.ts` (P1.3 `memory.references[]`), `kernel/briefing.ts`,
`kernel/proposers/*` plan prompt, `prompts.ts`. The plan must cite which reference
constraints it applies; the controllers (audio for bpm/energy, color for grade target,
timeline for shot-length target, motion for caption style) read the numeric profile
directly — not via the model. Images with role `brand-logo` become an overlay op with
the asset id; `color` becomes a grade target for the color controller; `b-roll` enrols
the image as a project asset.
**Done when:** UC-06 and UC-07 pass their Phase 4 rubric rows; the model call count for a
turn with a reference attached is ≤ the same turn without one + 0 (analysis is a sidecar
job, not a model turn).

Landed 2026-08-29: `ContextInput.references` → fixed "References the editor attached"
block (`summarizeReferences`), desktop request validation (`parseReferences`, ≤ 8), web
path threads them on both browser and desktop routes.

Landed 2026-08-29 (the numeric half — ADR 0162): `references/directives.ts` reduces the
attached profiles to targets the deterministic side consumes, so the shot-length target
enters the run's **acceptance criteria** — the briefing states what the run is graded on —
and a `shot_length_target` Critic check in `wholeCutChecks`, which tells a run it is off the
reference pace *while it can still re-trim*. Tolerance is the reference's own p10–p90
spread. What a reference cannot drive is stated by name under its own heading rather than
silently dropped, which is P4.2's "which it is ignoring, with a reason" rendered
deterministically.

Remaining: role-specific operations beyond pacing (a `brand-logo` is measured and then
explicitly ignored — nothing places an overlay from a reference file yet; likewise the
grade target and b-roll enrolment), and the UC-06/07 rubric evidence, which needs a
provider and the maintainer's media.

## P3.5 — "Same as the reference" across turns — `[x]`

**Touches:** P1.5 decision memory. A reference used in a plan is recorded as a decision
with `source: reference`, `until: superseded`. Removing the tile supersedes it.
**Done when:** UC-06 turn 3 without the attachment still applies the profile; removing the
tile then asking again does not.

Landed 2026-08-29: a reference the run plans against becomes a committed decision with
`source: reference`, `until: superseded` and the measured line carried verbatim in its
text, so it crosses the run boundary like any other committed decision and lands in the
briefing's DECIDED section holding its own numbers — a later turn applies the profile
without re-reading, re-measuring or asking.

The contract it rests on: `subject` is the profile id, and the conductor hands the
carry-forward the **complete live set** of attached profiles. The sidebar keeps a tile
until it is removed, so a turn that says nothing about the reference still carries it, and
a subject missing from the set means the editor took the tile away — so a constraint they
deleted stops binding. Three tests drive the real conductor and cover exactly the two
done-when clauses: a later turn that never mentions the reference still reads its 1.1s
target out of DECIDED, and the turn after the tile is gone reads neither.

## P3.6 — Sidebar shows what the AI knows about the reference — `[x]`

**Touches:** `AiSidebar.tsx` tile detail popover: role, the `constraints` lines, analyzed
timestamp, "re-analyze" and "change role". Errors (unsupported codec, analysis failed)
show on the tile, not as a toast.
**Done when:** the popover renders the fixture profile; a failed analysis shows its reason
and retries.

Landed 2026-08-29: the attachment chip is a disclosure. Open it and it shows the profile's
`constraints` verbatim — the exact lines the planner reads, not a summary of them — the
analysis timestamp, a role selector (the classifier's guess is a guess), and Re-analyze.
A failed analysis states its reason there with the retry beside it, instead of a toast
that is gone by the time anyone reads it. Re-analysis goes through the imported copy under
the projects root with `refresh: true`, so it bypasses the content-hash cache rather than
handing back the same stale answer; changing the role re-measures under the new role.
4 tests. Also fixed on the way: `remove_silences` had no `toolMeta` entry, so its tool card
would have rendered unnamed.

## P3.7 — Tests, docs, close — `[~]` (everything but the two e2e runs, which need a provider and the maintainer's media)

Unit: role table, profile builder, cache behaviour, context block. Sidecar: route test
with the fixture. E2E hook for Phase 9 (UC-06/07). `docs/guides/reference-media.md`,
CHANGELOG, ADR for the profile contract. Report `03-after.md`.

ADR **0162** records the profile contract: a reference is measurements the run is graded
on, not a mood — `constraints` for the model, `directives.ts` for the deterministic side,
tolerance taken from the reference's own p10–p90 spread, and a reference that cannot drive
anything saying so by name. CHANGELOG entry landed with P8.7's pass.

What remains is not writing: `references-analyze.spec.ts` and the UC-06/07 journey are
written and wired into the nightly lane but have **never been run green**, because they
need a billed provider and the maintainer's media. A spec that compiles is not evidence.

Landed 2026-08-29: `docs/guides/reference-media.md` — attaching, what the measurement
produces (the actual constraint lines, since those are what the model reads), roles and
correcting them, failure and re-analysis, and an explicit Limits section naming what is
read but not yet acted on (P3.4) and what is per-turn only (P3.5). Unit tests for the role
table, profile builder and context block exist.

Landed 2026-08-29 (second pass): the **route test on real media** and the **UC-06/07 e2e
hook**, plus the phase report.

- `tests/e2e-desktop/specs/references-analyze.spec.ts` drives `POST /references/analyze`
  through the sidecar the desktop app itself spawned, against the real `ref/` fixtures. It
  lives here and not in `engine/python/tests` on purpose: the engine's own test
  (`test_service_references.py`) proves the *contract* with a synthetic PNG, and only real
  footage through a real ffmpeg proves that scene, beat, silence and colour analysis produce
  numbers an editor would recognise. The fixture is copied into the projects sandbox first —
  the route correctly refuses anything outside it, and the last row re-proves that refusal.
  The cache is asserted by **cost**, not just by the `cached` flag: the second answer must
  come back in under half the first call's time, because a flag can be right while the work
  is done twice. `refresh: true` (the sidebar's Re-analyze) must bypass it.
- The UC-06/07 hook is `tests/e2e-desktop/specs/ai-journey.spec.ts`: it attaches
  `ref/fast-cut-vertical.mp4` and `ref/logo.png`, waits out the analysis, then asks for
  reference pacing and the logo in one turn — inside the same session that already built and
  refined a montage, which is the only place "make it feel like this" means anything.
- `docs/reports/system-mission/03-after.md`: what ships, the evidence table, and an explicit
  account of the P3.4 gap.

Still `[~]`, and the reason is worth stating plainly: **the ADR for the profile contract and
the CHANGELOG entry are not written** (outside this task's scope), and **neither e2e spec has
been run green** — both need the desktop host, and the journey needs a billed provider. A
spec that compiles is not evidence.

## Discovered

- 2026-08-29: the desktop `referencesAnalyze` IPC channel was declared (contract, preload,
  renderer bridge) but never handled in `main.ts`; found by the P6.3 registration test,
  fixed there. Every desktop reference attachment before that fix would have failed.

