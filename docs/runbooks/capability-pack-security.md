# Runbook: Capability Pack worker security

What protects the user's machine when FramePilot runs a Capability Pack worker (Smart Mask, Subject
Intelligence, Tracking Lite, Visual Embed/Describe, Local Whisper), what does not, and what to check
when something looks wrong. Decisions: [ADR 0114](../adr/0114-on-demand-capability-packs.md) and
its 2026-09-17 amendment. Review record: `plan/background-removal-ai/BR4.12-SECURITY-REVIEW.md`.

## The honest summary

Pack workers are **native code running as the user with no OS sandbox**. Everything below contains a
*faulty* worker (a crash, a runaway decode, a bug that writes the wrong file). It does **not** contain
a *malicious* one: a hostile pack can escape on every OS. Signing, executable trust and explicit
install consent are what keep hostile packs out.

## What is enforced today

| Layer | Where | What it guarantees |
| --- | --- | --- |
| Signed catalog, release digest, executable trust | `packages/capability-packs/src/node` | Only an approved, signed release installs and runs |
| Scrubbed environment, network disabled by protocol | `worker-client.ts`, `worker-env.ts` | No provider keys or desktop env reach the worker |
| Media and output handles | `worker-client.ts` (realpath containment), `matte-staging.ts` | The worker is pointed only at approved media and one host-created staging folder |
| Process group | `process-group.ts`; worker runs and health checks | Timeout, abort, failure and completion kill the group (POSIX) or tree (Windows `taskkill /T`); a job is checked for survivors before verification |
| Watchdog | `worker-watchdog.ts` | Footprint ≤ min(pack limit, 0.6 × RAM); 5 min without progress; staging bytes ≤ min(ceiling, free − 1 GB) → `resource_exhausted` |
| Host verification | `matte-verify.ts` | Only declared regular files; sizes, ceiling, sha256, frames equal to the source's decoded pts, ffprobe facts, locked frames bit-identical |
| Pre-rename re-check | `matte-staging.ts` | Same names, regular files, `nlink == 1`, same size, inode and mtime as verified |
| Matte store access | `existingRealDirectory` | Nothing is listed, read or deleted through a symlinked parent |
| Clean unused mattes | `matte-storage.ts` | Keeps anything referenced by any `.json`/`.fp.json` in the folder or the recovery snapshot; refuses on links or unreadable project files |
| Hardened decodes | `media/untrusted.py`, `frame_hashes.py`, `matte-media-inspector.ts` | `file` protocol only, media demuxers only, `-max_pixels`, bounded threads; routes one at a time with work-sized deadlines |
| Monitor tier writes (PX5.9) | `render/matte_tier_job.py`, `/mattes/monitor-tier` | Masters read with the hardened options (Matroska forced), encodes fed only from a whitelisted `rawvideo` pipe; every `.framepilot-derived` component `lstat`-checked (a link or non-regular master refuses); digests against the pins before and after the pixels; staged in `matte-tiers/.staging/`, probed back, renamed; one at a time, deadline sized by frames |

## Deferred, with the limit it leaves

| Item | Limit today | Where tracked |
| --- | --- | --- |
| **OS-level sandbox** (macOS seatbelt, Windows AppContainer + restricted token) | A worker can read or write anything the user can | ADR 0114 amendment (accepted risk) |
| Windows Job Object (kill-on-close, memory limit) | Children can survive a normal completion undetected; memory is the worker's working set only | ADR 0114 amendment |
| POSIX `setsid()` / `setpgid()` escape | A descendant that leaves the group is neither killed nor memory-sampled | ADR 0114 amendment |
| Client-disconnect cancellation on `/mattes/*` | A decode runs until its deadline after the desktop gives up | BR4.12 re-review D4 |
| Pack-declared memory limit | The limit is a host constant (`PACK_MEMORY_LIMIT_BYTES`), not signed with the release | BR4.12 re-review D5 |
| `senderFrame` checks on IPC; `mediaRoot = dirname(asset.path)` | Pre-existing; the sidecar sandbox must not be widened | BR4.12 L7 |

## When something looks wrong

1. **A job failed with `resource_exhausted`.** `resourceLimit` says which: `memory` (shorter range or
   close apps), `stalled` (retry; if it repeats, reinstall the pack), `disk` (free space). The
   diagnostic bundle (`capabilityPackExportDiagnostics`) holds the phase timings and codes, no paths.
2. **`verification_failed` with `changed_after_verify` or `lingering_process`.** Something wrote into
   staging after verification or a worker process would not stop. Treat the installed pack as
   suspect: reinstall it from Settings › Storage and report the pack version.
3. **Processes still running after a job.** On macOS/Linux check `ps -o pid,pgid,command` for a
   process whose group differs from the worker's (it called `setsid()`): that is the documented
   escape, report the pack. On Windows check for children of the worker in Task Manager.
4. **Clean refuses with `references_incomplete` or `unsafe_path`.** A project file in the folder is
   unreadable, too large or a link, or the matte store contains a link. Fix or move that file; Clean
   never guesses.
5. **Frame checks unavailable.** The sidecar is down or busy past the retries; lock checks and
   relink re-checks fail closed until it is back.
6. **A matte plays slowly in the monitor after background removal.** Its monitor tier was not made
   (`matteMonitorTierFailed` in the log, with a code: `tool_unavailable` = sidecar down, busy past
   ~8 minutes or out of time; `probe_failed` = refused). Nothing is wrong with the matte: the monitor
   decodes the masters. The tier is made again on the next run of the same job (a cache hit), or
   delete `.framepilot-derived/matte-tiers/<key>/` to have it remade. A `.staging` folder left there
   by a crash holds nothing a reader uses and can be deleted.

**Checking the monitor tier's real-folder rule by hand.** With the app closed, replace
`<project>/.framepilot-derived/matte-tiers` with a symlink to another folder and run background
removal on a clip with a proxy: the job completes, the log shows `matteMonitorTierFailed` with
`probe_failed` (the route answered 400), and nothing appears in the link's target. The same holds
for a symlinked `mattes` folder or master (`test_matte_tier_route.py` covers all four).

## Changing any of this

Widening a handle, adding a write surface, relaxing a whitelist or a bound is a security change:
ask first (CLAUDE.md §5), update this runbook and ADR 0114, and get a `security-reviewer` pass.
