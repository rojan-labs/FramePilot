# ADR 0160 — Export is quality-driven, not platform-driven

**Status:** accepted
**Date:** 2026-08-29
**Schema:** unchanged (`ExportSettings` is a render-request field, not project state)
**Related:** plan/system-mission Phase 7, ADR 0157 (the beat grid), `docs/guides/export.md`

## Context

Export was a list of **platform presets** — "Instagram Reels (9:16)", "TikTok", "YouTube
Shorts" — with resolution, fps and codec read-only underneath. Three things were wrong
with that, and only the first is obvious:

1. **It ages badly.** Platform frame requirements change on someone else's schedule, and a
   preset that was right last year silently exports the wrong thing this year.
2. **It answers a question the user did not ask.** Someone exporting a 4K master for a
   client is not publishing to a platform at all, and had no way to say so.
3. **It hid the only decision that actually matters** — how much quality, at what file
   size — behind a brand name that implies it.

## Decision

The dialog offers **resolution · frame rate · quality · codec · format**, and the aspect
ratio comes from the project itself, not from the export. No platform names remain
anywhere in the export path.

Two properties make this honest rather than merely different:

- **The source caps the tier.** A 360p source asked to export at 2160p produces 360p —
  measured, both tiers, same wall time. The dialog states the exact frame it will produce
  and warns before an upscale, so the tier is a request and the media gives the answer.
- **The summary is computed, not promised.** The dialog shows the real output frame and a
  size estimate derived from the bitrate ladder, before the user commits.

`ExportSettings` travels with the render request. It is deliberately **not** project state:
two exports of one project at different tiers are two requests, not two projects, and
persisting the last choice per project is a UI preference (`useViewPreference`), not a
schema field.

## Consequences

- `/export-reels` is gone; `/export` takes settings. `render/presets.py` holds encode
  _targets_, not platform identities. The only platform names left in the tree are
  content-style targets (`targetPlatform` for what the edit is _for_), orientation hints
  and catalog tags — none of them an export preset.
- Anything that assumed a preset id had to be re-expressed as the setting it actually
  cared about; the render golden fixtures now state their aspect explicitly, which they
  should always have done.
- The measurement this unlocked is in `docs/reports/system-mission/07-after.md`: with the
  platform indirection gone it was possible to ask what an export actually spends its time
  on, and the answer — 69 % in one PIL resize — was not visible while the dialog was a list
  of brand names.
