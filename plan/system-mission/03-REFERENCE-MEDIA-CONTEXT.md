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
path threads them on both browser and desktop routes. Remaining: the plan citing the
constraints it applies (proposer prompt), controllers reading the numeric profile,
role-specific ops (logo overlay, grade target, b-roll enrolment), and the UC-06/07 evidence.

## P3.5 — "Same as the reference" across turns — `[ ]`

**Touches:** P1.5 decision memory. A reference used in a plan is recorded as a decision
with `source: reference`, `until: superseded`. Removing the tile supersedes it.
**Done when:** UC-06 turn 3 without the attachment still applies the profile; removing the
tile then asking again does not.

## P3.6 — Sidebar shows what the AI knows about the reference — `[ ]`

**Touches:** `AiSidebar.tsx` tile detail popover: role, the `constraints` lines, analyzed
timestamp, "re-analyze" and "change role". Errors (unsupported codec, analysis failed)
show on the tile, not as a toast.
**Done when:** the popover renders the fixture profile; a failed analysis shows its reason
and retries.

## P3.7 — Tests, docs, close — `[ ]`

Unit: role table, profile builder, cache behaviour, context block. Sidecar: route test
with the fixture. E2E hook for Phase 9 (UC-06/07). `docs/guides/reference-media.md`,
CHANGELOG, ADR for the profile contract. Report `03-after.md`.

## Discovered

- 2026-08-29: the desktop `referencesAnalyze` IPC channel was declared (contract, preload,
  renderer bridge) but never handled in `main.ts`; found by the P6.3 registration test,
  fixed there. Every desktop reference attachment before that fix would have failed.

