# BR4.12 — Security review of the background-removal host

**Reviewed:** commits `f2551123..91076959` by the `security-reviewer` specialist, 2026-09-17. Read-only.
**Verdict:** not approved for RD3. There are no critical findings; H1, H2, M1, M2 and M3 must be fixed first.

| # | Severity | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| H1 | High | Write sandbox is a protocol convention; worker descendants can outlive the job, race the verify → rename window, or hold stdout so the job never settles (`worker-client.ts:77-82, 242-246, 346`) | Process group / Job Object kill, settle on `exit` + grace, assert group gone before verify, re-`lstat` + `nlink == 1` before commit; correct P17 / `03` wording | open |
| H2 | High | No memory limit; timeout effectively 24 h; byte ceiling only checked after the job (`matte.ts:79-81`, `matte-verify.ts:212-222`) | Host watchdog: footprint ≤ min(pack max, 0.6 × RAM), stalled-progress 5 min, staging-size poll vs ceiling and free space; `resource_exhausted`; fake-worker tests | open |
| M1 | Medium | Clean and the orphan sweep follow a symlinked `.framepilot-derived` or `mattes` parent (`matte-storage.ts:89,138,167,211`; `matte-staging.ts:231-254`) | Real-directory chain assertion with realpath equality; only real dirs / regular files counted; tests per level | open |
| M2 | Medium | Clean ignores other projects and pre-migration backups in the same folder; `.inputs/` corrections are unrecoverable user work (`matte-ipc.ts:254,270`) | References from every `*.fp.json` in the folder (bounded), or never clean `.inputs/` while referenced | open |
| M3 | Medium | `/mattes/*` routes: no total deadline, no concurrency limit, no cancellation, unhardened ffmpeg for untrusted input, unbounded `pts` (`frame_hashes.py:128-164`, `service.py:6144,6157`) | Route semaphore (503 when busy), total deadline, `-protocol_whitelist file`, `-max_pixels`, forced demuxer for `matte.mkv`, bounded threads, int64 field bounds | open |
| L1 | Low | Absolute paths in error text (`service.py:6155,6179`; `main.ts:1290`) | Re-raise typed errors with basenames; log error names | open |
| L2 | Low | Correction PNG: no CRC, ancillary chunks and trailing data accepted; large decode on the main thread before the size check | Expected size checked at IHDR; store the canonical re-encode | open |
| L3 | Low | Unmeasured display size skips the artifact dimension check (`matte.ts:411-429`) | Probe with rotation/SAR, or refuse `media_unreadable` | open |
| L4 | Low | `frames.json` up to 64 MiB parsed on the main thread at project open | Byte bound from the frame count; skip in quick mode with a valid record | open |
| L5 | Low | MCP asset-path check covers `add_asset` only; `isValidAssetPath` accepts relative/`..` paths | Check every path-carrying op; test that no ai-sdk tool emits `relink_asset`; absolute paths only | open |
| L6 | Low | Restored jobs skip the licence check and the open-project check (`main.ts:1290-1305`) | Run restored jobs only once their project is open; check the licence at run time | open |
| L7 | Low | Pre-existing: no `senderFrame` checks; `mediaRoot = dirname(asset.path)` | Recorded; do not widen the sidecar sandbox | recorded |

Verdicts per scope item: sandbox, verification, sidecar routes and job limits need fixes. The IPC surface, `relink_asset` consent (not reachable by AI or MCP today), the diagnostic bundle and log redaction are OK.

**Fuzzed-media corpus (required):** generated at test time (no committed binaries, ≤ 256 KB each) under
`engine/python/tests/fixtures/fuzz_media/`:
- truncated MP4 and MKV
- huge declared dimensions
- corrupt FFV1 slices
- negative or duplicate pts
- zero frames
- a huge packet count
- HLS or ffconcat files renamed to video extensions
- external data references
- a PNG set: bad CRC, IDAT bomb, trailing data, ancillary chunks, oversize, duplicate IHDR
- a `frames.json` set: 64 MB, deep nesting, `1e400`, non-integer values, BOM

Harnesses:
- Python (`test_matte_fuzz_media.py`): typed refusals, bounded time and memory, no paths in error text.
- Desktop (`matte-fuzz.test.ts`): typed errors, event-loop delay ≤ 250 ms.
- Fake-worker adversarial variants: lingering child, memory growth, ceiling overrun, silence, symlink swap after the result.

Deferred with a documented limit: L1–L7; no OS-level sandbox (seatbelt/AppContainer) for pack workers, recorded as an accepted risk in ADR 0114 until a hardening task.

## Re-review

**Verdict (2026-09-17):** approved with deferrals. Findings, conditions and follow-ups, with status:

| # | Item | Status | Commit(s) |
| --- | --- | --- | --- |
| H1 | Worker process group, settle on `exit` + grace, group checked before verify, re-`lstat` + `nlink == 1` before rename | fixed | `9ba7df01` |
| H2 | Host watchdog (footprint, stall, staging size) → `resource_exhausted` | fixed | `8ba05ccc` |
| M1 | Real-directory chain for every matte store reader and deleter | fixed | `ff6545f4` |
| M2 | Clean references from every project file in the folder | fixed | `f4ac70ee` |
| M3 | `/mattes/*` semaphore, deadline, bounds; hardened ffmpeg (protocol + demuxer whitelists, `-max_pixels`, threads, forced Matroska) | fixed | `a7442484` |
| L1 | No paths in logs and errors | fixed | `f8ac7ee7` |
| L2 | Strict correction PNGs, size at IHDR, canonical storage | fixed | `9ec0f84f`, `51058f24` |
| L3 | Unmeasured media refused `media_unreadable` | fixed | `c575eaf1` |
| L4 | `frames.json` bounded by frame count; not re-parsed at open with a valid record | fixed | `c54f212f` |
| L5 | MCP checks every path-carrying op; absolute relink paths; no AI tool emits `relink_asset` | fixed | `0c40984f` |
| L6 | Restored jobs wait for their project; licence checked at run time | fixed | `2bdccfea` |
| L7 | No `senderFrame` checks; `mediaRoot = dirname(asset.path)` | deferred (pre-existing; do not widen the sidecar sandbox) | — |
| Corpus | Fuzzed-media corpus and harnesses | done | `4b80aa8e` |
| ADR | ADR 0114 amendment: no OS-level sandbox is an accepted risk | done | `47d572c1` |
| C1 | Docs say a malicious pack can escape on every OS (POSIX `setsid()`; Windows no Job Object, worker pid only) | fixed | `b8aa5615` |
| C2 | Health-check spawn path uses the process group and kill | fixed | `78e349fc`, `32b819fd` |
| C3 | `ino` and `mtimeMs` recorded at verification and compared before the rename | fixed | `5122e038` |
| C4 | Clean scan covers plain `.json` projects, refuses a symlinked project file, includes `userData/recovery-snapshot.json` | fixed | `3f4c2029` |
| C5 | `pts_reader.video_timing` uses the protocol and demuxer whitelists | fixed | `c23ae830` |
| C6 | Desktop retries 503 busy with bounded backoff; deadlines sized from pts count and highest locked frame | fixed | `fa54d4d2` |
| C7 | Missing record on a relinked asset → STALE (desktop and engine) | fixed | `cc663c5a` |
| D1 | **OS-level sandbox for pack workers** (seatbelt / AppContainer + Job Object) | **deferred**, accepted risk in ADR 0114 | — |
| D2 | Windows Job Object kill-on-close and memory limit (descendants that leave the tree, children after completion) | deferred with D1 | — |
| D3 | POSIX descendants that call `setsid()` escape the group kill and memory sampling | deferred with D1 | — |
| D4 | `/mattes/*` requests are not cancelled when the client disconnects (deadline only) | deferred | — |
| D5 | Pack memory limit declared in host code, not in the signed release | deferred until the release schema gains a field | — |

The operational version of the deferred list lives in `docs/runbooks/capability-pack-security.md`.

## Follow-up review (ae8ef8a5, 4c227ec1)

**Reviewed:** `ae8ef8a5` (the watchdog stops counting the worker's own scratch against the output
ceiling) and `4c227ec1` (resume adopts a leftover staging folder), by the `security-reviewer`
specialist, 2026-09-19. **Verdict:** approved with follow-ups. All fixed, one commit each; E2E.6
(`masking-e2e-resume.spec.ts`) passes locally after the last one (darwin-arm64, 3.8 min).

| # | Severity | Finding | Fix | Commit |
| --- | --- | --- | --- | --- |
| F1 | Medium (regression) | `statfs` failing fell back to `Number.MAX_SAFE_INTEGER`, and the whole-folder limit was only `free − 1 GB`: nothing bounded scratch on network/FUSE/cloud volumes; the preflight was skipped | Whole staging folder ≤ min(staging budget, free − 1 GB when known). Budget (`matteStagingBudgetBytes`) = 3 × byte ceiling + one window of scratch (360 frames × 16 B/px) + 8 GiB embedding spill + 1 GiB slack. Unknown free space is logged and the job runs under the budget | `f7b67b06` |
| F2 | Medium | Resume reused finished windows made from different media: the worker's `fingerprint()` had no content fingerprint | Host writes `inputs/staging.json` (0400: cache key, pipeline version) and adopts `windows/` only when that record is a regular, single-link file matching the current key; the request carries `contentFingerprint`, which the worker folds into `fingerprint()` | `1d324af9` (worker), `4cafea0b` (host) |
| F3 | Low-Medium | TMPDIR/TEMP/TMP passed through, so temp files escaped the staging guard | `runCapabilityPackWorker({ temporaryDirectory })` points all three at a host-made real directory inside the staging root (`<staging>/scratch/tmp`), removed after the worker; runbook row corrected to "bytes under staging are bounded", 2 s polling window listed as a limit | `aad4762d` |
| F4 | Low | Unreadable subfolders counted as 0 bytes | A non-ENOENT/ENOTDIR `readdir`/`lstat` failure under staging is a `disk` breach (fail closed) | `46dbb0b3` |
| F5 | Low | `adoptOrphan: true` for fresh runs; with two app instances, B's adoption deleted A's live staging | `adoptOrphan` only from `resumeMatteJobs`; every staging creation takes `<stagingRoot>/<jobId>.lock` (`wx`, pid): another running pid refuses, a dead pid or this process's own pid is stale and taken over; the startup sweep respects another process's lock | `5755c8b8` |
| F6 | Low | No realpath re-check after adoption clean-up; `linkFree` accepted `nlink > 1`; unbounded walk | Realpath of the job folder checked before and after clean-up; hard-linked files refused; walk bounded to depth 6 and 50 000 entries | `7e5fde34` |
| X1 | (extra) | Tracking jobs stage like mattes but ran with no `WorkerWatchdog` | Every pack job run by `CapabilityPackTrackingService` (tracking, detection, segmentation, embedding) gets the H2 watchdog and a private temp folder (TMPDIR) bounded by min(4 GiB, free − 1 GB) → `resource_exhausted` | `d7fb4229` |

Not done, with the reason:
- **`app.requestSingleInstanceLock()`.** `main.ts` has none today. Adding it changes launch
  behaviour (a second launch must focus the first window) and would stop a dev build running
  beside an installed app. The per-job staging lock covers F5 without it.
- **Lock takeover race.** Two instances that find the same stale lock at the same moment can
  both take it over (unlink, then `wx`). It needs a dead app, two live ones and the same job id
  within one call; recorded rather than fixed with a rename protocol.
- **A reused pid** makes a stale lock look live: the resume then fails `job_running` (fail
  closed) and the job can be run again.
- **Worker `tempfile.tempdir`.** Not set in the worker: the host's environment already points
  TMPDIR/TEMP/TMP at the staging folder, and the change was kept out of `pipeline.py` (BR7.5).

