# ADR 0138 — Asset provenance is persisted

**Status:** accepted
**Date:** 2026-08-23
**Schema:** `SCHEMA_VERSION` 19 → 20, migration `{from: 19, to: 20}`
**Implements:** decision D2 in `plan/3rd-party-sourcing/README.md`, maintainer 2026-08-23
**Related:** ADR 0114 (capability packs — the shape this optional field copies)

## Context

FramePilot is about to fetch music from a third-party provider. Some of that music is
usable only if the person publishing the video credits its creator.

The obvious answer is a badge in the search results: show the licence, let the user
choose. That solves the wrong moment.

A badge at search time helps someone **choose** a track. The obligation lands weeks
later, when they publish, and the question then is not "what is this licence" but
"**which** of the four beds in this project needed crediting, **to whom**, and under
**which** licence." If the only record of that was a chip in a panel they closed on a
Tuesday, the product has quietly walked them into a licence violation — and it will
have done so while displaying, at the moment of choosing, a badge that looked like
diligence.

This is not a hypothetical failure mode. It is the _default_ one: the search panel is
transient by construction, and the project file is what survives.

We also considered restricting the feature to attribution-free (CC0-equivalent)
content, which would have avoided the schema change entirely. The maintainer rejected
that scope on 2026-08-23: it discards most of the catalogue to dodge a migration.

## Decision

**The project file records where a provider-sourced asset came from and what crediting
it obliges, and the app reads that record back at export.**

`Asset.source` (`AssetSourceSchema`, `packages/timeline-schema/src/index.ts`) carries
provider, remote id, licence identifier and URL, `attributionRequired`, the
ready-to-paste `attribution` line, creator, creator URL, landing page, and `fetchedAt`.

Three properties of that shape are load-bearing:

**Optional, not defaulted.** Absent is the correct reading of every pre-v20 project and
of every file the user dragged in themselves — those have no provenance and never will.
Defaulting would force every in-memory `Project` literal to materialize a value that
means nothing. Same call as `capabilityPacks` in v19.

**`attributionRequired` is stored, not derived from `license`.** Licence vocabularies
differ per provider and change over time. A project written today must still know what
it agreed to then, not what today's lookup table says about a string.

**`attribution` is carried verbatim.** Openverse composes a correct credit line per
licence; re-deriving one risks producing a credit that does not satisfy the terms.

The migration is a no-op carry-over. There is nothing to backfill, because no pre-v20
asset came from a provider. It is written and tested anyway: the migration list is the
contract, and a gap in it is worse than a trivial entry.

**The field is only half of the decision.** A persisted licence nobody can read is a
backend-only completion. So this ADR also covers the **Credits** surface in the export
dialog: every asset in the project that obliges a credit, its line, its licence, and one
click that puts them all on the clipboard. Export is where the obligation stops being
theoretical, so that is where the answer lives.

## Consequences

**The engine models `AssetSource` but reads none of it.** Provenance cannot affect a
render. It is mirrored in Pydantic (`engine/python/framepilot_engine/timeline/models.py`)
purely so a project round-tripped through the engine keeps it — a model that dropped
unknown fields would silently erase the one durable record of an obligation, and the
loss would only surface at publish time.

**The model view collapses it.** `list_assets` and `get_project_state` return
`attributionRequired: true` and nothing else from the record (`model-view.ts`,
`ai_tools/handlers.py`). Eight fields of licence and creator URLs are not reasoning
material — the model never opens a licence page — but "this track obliges a credit" is,
because the agent can say it out loud in a summary. Absent means nothing owed, never
unknown.

**Credits are not burned into the rendered video.** That is a compositing decision with
layout, duration and style implications, and most creators credit in a description
instead. Recorded here so its absence reads as a decision.

**Provenance is per-asset, not per-clip.** A track used three times is one obligation,
not three. Splitting a clip must not multiply a credit.

`sources.json` in the project media folder (Phase 3) is a **download ledger**, not a
second provenance record. It answers "have I already downloaded this?" without loading
the project. The project file remains the single source of truth for what must be
credited.

## Alternatives rejected

**A badge only, no persistence.** The failure mode is silent user harm, weeks after the
UI that would have prevented it was closed.

**CC0-only content.** Avoids the migration by discarding most of the catalogue.
Maintainer-rejected 2026-08-23.

**A free-form metadata bag on `Project`.** `ProjectSchema` is strict on purpose. An
untyped bag would make the credit unreadable by anything but the code that wrote it,
and would not survive the engine round-trip with a checked shape.

**Deriving `attributionRequired` from the licence id at read time.** Turns a recorded
agreement into a live lookup against a table that changes.

## Which licences are offered at all (amended 2026-08-25)

Persisting the licence answers "what did I use?"; it does not answer "should this have
been offered?". That second filter is an **allow-list** in the Openverse adapter, and it
is deliberately narrower than the provider's own.

Openverse exposes `license_type=commercial`, which includes **CC BY-ND**. FramePilot does
not. ND permits commercial _use_ while restricting **derivatives** — and the first thing
this feature does to a fetched bed is duck it under narration and automate its level,
which is exactly the case ND exists to govern. Whether that counts as a derivative is
genuinely unsettled, and an unsettled licence question is not something to resolve with a
sentence in a guide the user has to read to stay safe.

So `by-nd` is **refused before it is ever shown** (maintainer decision 2026-08-25), along
with every `by-nc*` code, `sampling+`, and anything unrecognised. What remains — `cc0`,
`pdm`, `by`, `by-sa` — carries no derivative restriction, so every track the user can see
is one they can duck, trim, fade and publish.

The cost is catalogue breadth. The failure modes are not symmetric: a track wrongly hidden
costs one search result, a track wrongly offered costs a licence violation in a published,
monetized video — which is the harm this whole feature was built to prevent.
