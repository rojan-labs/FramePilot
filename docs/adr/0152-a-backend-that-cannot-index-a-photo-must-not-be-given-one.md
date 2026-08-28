# ADR 0152 — A backend that cannot index a photo must not be given one

**Status:** accepted
**Date:** 2026-08-28
**Related:** ADR 0070 (TwelveLabs optional understanding backend), ADR 0071 (TwelveLabs
official SDK adoption), ADR 0114 (ML goes through Capability Packs)

## Context

A user added 61 photos to a project. Settings → AI → Media intelligence reported
`0/61 assets prepared · 0%` with a blue "running" badge, both keys configured, and no
footage map was ever produced.

Read out of that project's own brain
(`.framepilot-derived/project_beat_sync_champadevi_mtbws6ztmw6v/brain.sqlite`):

- all 61 assets probe as `format_name = image2` — still photos;
- a TwelveLabs index was created and photo #1 was uploaded (`POST /assets` succeeded,
  an asset id was minted, a `tl:video` mapping row was written with `status: indexing`);
- three `visual-index` jobs, six minutes apart, all `state='running'`, `progress=0.0`,
  `payload.cursor=0`, each carrying
  `error: TwelveLabs API error (HTTP 404) (resource_not_exists).`

Two independent facts combined into a dead project.

**First:** TwelveLabs' index is a video/audio index. Its `POST /assets` accepts images
(the vendored SDK documents them for _entity search_), but an image cannot be attached
to a Marengo index, so the attach step 404s. FramePilot's worklist was built from
`MediaInfo.has_video`, which is `True` for a still — the `is_image` distinction existed
in the probe and was never consulted at the routing hop.

**Second:** the hosted slice treated any `TwelveLabsError` as a reason to `break`
**without advancing the job cursor**. Every retry rebuilt the same worklist in the same
order and hit photo #1 again. One un-indexable asset therefore became a permanently
unprepared project. The built-in NVIDIA path had already learned this lesson — its
source carries the comment _"one bad file in a project permanently blocks indexing every
other asset, since a re-run always hits the same asset first (cursor order)"_ — but the
hosted path, added later, never inherited it.

The failure was invisible on every surface: the job journalled `running` while holding a
terminal error, the Settings badge was derived from coverage rather than from the job,
and per-asset outcomes were returned once over HTTP and dropped.

## Decision

**1. Backend selection is a per-asset capability gate, not only a per-project policy.**
TwelveLabs keeps priority for video and audio when its key is configured. Still photos
are routed to the built-in on-device embedder, which already understood `is_image`.
Both keys are now forwarded to the engine together; previously the renderer withheld the
on-device key whenever a TwelveLabs key existed, so the fallback could not have been
taken even if the engine had wanted it. This is the maintainer's explicit decision
(2026-08-28) and its cost is stated in the UI: image embedding requests reach NVIDIA even
for hosted-backend users.

**2. A provider's refusal of one asset advances the cursor.** The asset is recorded as
failed with the provider's own message and the slice continues. Only an auth failure —
which fails every asset identically — stops the run.

**3. A run of refusals is systemic, and stops.** Three consecutive refusals
(`TL_CONSECUTIVE_FAILURE_LIMIT`) stop the slice with that reason. The counter is
journalled on the job, not held per slice: a slice is one asset by default, so a
per-slice counter could never reach the bound and a deleted index would upload — and
bill for — every asset in the project one call at a time.

**4. A job that has stopped is `failed`, never `running`.** Both arms journal
`JobState.FAILED` when a slice stops on a provider error or an exhausted key ring, and
the Settings panel derives its badge from the job's own state.

**5. Coverage and the footage map are the union of both backends.** A project prepared
partly by each is counted once and mapped once; counting only the hosted mappings
under-reported a fully prepared photo project as `0/61` forever.

## Consequences

- A photo project works with no hosted dependency at all, which _reduces_ exposure to
  the unlicensed-SDK risk accepted in ADR 0071.
- Photo embedding costs move to NVIDIA for users who configured both keys. The panel
  says so.
- Nothing stored changed shape. `payload.consecutiveFailures` is additive on a derived
  job record and reads 0 when absent, so no migration and no backfill are required;
  projects stuck by this defect self-heal on their next preparation run.
- The general rule this sets: **a capability precondition is checked per asset, before
  the provider is called, and a per-asset failure never advances into a project-level
  stop.** Any future understanding backend inherits it.

## Alternatives rejected

- **Skip stills entirely on the hosted path.** Unjams the project but leaves a photo
  project with no intelligence and no map at all — which is the user's actual complaint,
  not a side effect of it.
- **Fall back to on-device for the whole project when it contains a still.** Withdraws
  hosted understanding from the video in a mixed project; the wrong granularity.
- **Ask TwelveLabs to index photos as a synthetic video.** Fabricates footage that does
  not exist and bills for it.
