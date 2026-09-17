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
