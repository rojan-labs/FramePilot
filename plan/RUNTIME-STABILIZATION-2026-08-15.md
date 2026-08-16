# Runtime Stabilization — 2026-08-15

**Status:** `[~]` implementation complete; focused regression coverage added; local execution and full PR/CI verification deferred.

This work follows the Professional Editor Control Plane stabilization stream in `plan/PLAN.md`. It closes the runtime and data-safety gaps found in the fresh `main` review without bypassing FramePilot validation boundaries.

## Implemented

- Review staleness uses precise clip, whole-track, and timeline-range overlap instead of treating any two edits on one track as the same region.
- Delivered review findings are not marked resolved merely because a later edit touched the region.
- Browser durable runs use IndexedDB v2 append-only event records with metadata-only run enumeration and storage-native paging.
- `RunStore` separates operational I/O failures from corrupt persisted bytes, bounds its parsed-WAL cache by bytes as well as run count, preserves validation authority across native pages, and serializes native-page validation per run so concurrent readers cannot falsely quarantine valid durable state.
- WebCodecs preview admits only projects whose eagerly decoded source audio fits a bounded PCM budget; larger projects use the existing streaming DOM preview.
- Decode worker teardown rejects outstanding requests instead of leaving callers pending indefinitely. Successfully loaded source registrations are retained on the main thread and replayed into a replacement worker before dependent decode/stat requests continue; late errors from stale worker instances cannot reject replacement-worker requests.
- Source-monitor playhead updates remain local rather than driving top-level editor renders at playback cadence.
- Professional clip audio normalization, EQ, and compression stream through the existing ffmpeg audio-filter seam rather than materializing the complete clip as NumPy PCM.
- Long-form gain automation evaluates by vectorized keyframe segments instead of dispatching the keyframe evaluator once per millisecond.
- Professional audio automation points are required to be at least 1 ms apart, matching the renderer's millisecond automation resolution and making millisecond-derived authored IDs collision-safe within the supported contract.
- Temporal technical scopes use a separate captionless full-resolution composition; ordinary perceptual review keeps its bounded review resolution.
- Temporal evidence has a cooperative cancellation primitive checked between expensive work units, and the HTTP route propagates client disconnects into that synchronous predicate so superseded/abandoned work can release the process-wide review gate.
- Temporal evidence provenance is enforced by result kind at the TypeScript contract boundary: frame/range/comparison/scope/audio/loudness evidence requires exact non-null `renderSettings`, while motion requires explicit `null` because it is derived from authored motion state rather than rendered composition.
- Composition-cache eviction retires borrowed entries without blocking unrelated installs, while teardown still waits for the final borrower.
- Capability Pack logical identity includes the signed `releaseDigest`; immutable artifact sharing remains keyed by physical digest.
- Capability Pack downloads keep cancellation/progress independent per subscriber, reserve extraction space, and require strong ETags only for resume.
- Capability Pack install locks heartbeat live owners, release-specific install paths cannot alias one another, archive directory allowlists are precomputed, and persisted cross-process lease counts are preserved fail-closed.

## Focused regression coverage added

- precise review overlap and verified-resolution behavior
- RunStore I/O-versus-corruption handling, cross-page integrity, and concurrent native-page readers
- WebCodecs decoded-audio admission budget
- decode-worker teardown settlement, replacement-worker source rehydration, and stale-worker error isolation
- streaming audio filter ordering and long-form automation endpoints
- production audio path guard against `to_soundarray()` materialization
- temporal cancellation primitive and HTTP disconnect propagation
- strict per-result temporal render provenance, including explicit `null` motion provenance
- Capability Pack release identity, subscriber cancellation, no-ETag fresh download, and extraction-space reservation

## Verification status

The repository is available in this session through the connected GitHub API only, without a local checkout or command runner. The focused tests above are committed but were **not executed in this session**. Full CI is intentionally deferred per task instruction and was not inspected.

Do not mark this work `[x]` in the master plan until focused package checks and the normal PR verification complete.

## Remaining optional follow-ups

1. Native WAL validation currently retains historical `eventId` values in memory for the validation horizon. This is bounded by the existing WAL safety limit, but very long orchestration histories could eventually move uniqueness enforcement into a durable/indexed mechanism instead of an in-memory set.
2. Optional performance work: supervise warm Capability Pack workers for repeated interactive tracking while preserving the current isolated-process security boundary.
