# Maintainer-only actions

Actions an agent cannot do: they need the maintainer's identity, money, legal standing,
hardware or people. Work continues around each one. Nothing here blocks code that can be
written and tested without it; each row names the task it unblocks.

| #   | Action | Why only the maintainer | Unblocks |
| --- | ------ | ----------------------- | -------- |
| MO-1 | Apple Developer ID certificate + notarisation credentials in CI secrets | Paid account bound to a legal identity | RD1.1, RD1.4 artifact signing, RD3.1 release build |
| MO-2 | Windows Authenticode code-signing certificate in CI secrets | Paid certificate bound to a legal identity | RD1.1, RD1.4, RD3.1 |
| MO-3 | Offline catalog root-key generation ceremony, storage and rotation plan; public keys handed to the build | Keys must never be created or held by an agent | RD1.1, RD1.3 (release channels embed the keys), E2E.1–E2E.7 against the real catalog |
| MO-4 | CDN account for multi-GiB pack artifacts with range requests; bandwidth budget approval | Billing account | RD1.2, RD1.6 |
| MO-5 | Publish Tracking Lite, Subject Intelligence and Smart Mask to a beta channel and install on clean macOS and Windows machines | Needs MO-1..MO-4 and physical clean machines | RD1.6, RD3.1 |
| MO-6 | Legal review of face-recognition consent copy and privacy docs | Legal counsel | RD2.3, RD3 §C.4 |
| MO-7 | Closed beta: ≥ 10 real projects from working editors on macOS and Windows; triage | Recruiting real users | RD2.4, RD3 §C.6 |
| MO-8 | Human-labelled alpha keyframes (every 0.5 s) for the matte eval fixture set, marked human-verified | Ground truth must be labelled by a person, not by the model under test | BR7.1, BR7.3, BR0.4 recall on the labelled pilot set |
| MO-9 | Windows x64 GPU machine (DX12, Windows 11 24H2 for Windows ML) for per-EP parity, throughput and the win32-x64 eval/oracle runs | No Windows hardware in this environment; hosted runners have no GPU | BR0.2 (Windows ML/DirectML rows), BR0.7, BR7.2, PX4/RD3 §C.1–2 on win32-x64, E2E.7 |
| MO-10 | Release build with flags on, rollback rehearsal (flag off + catalog delist) | Needs a signed release and the real catalog | RD1.5, RD3.2 |
| MO-11 | Legal review of BiRefNet_HR-matting's training-data terms. BR0.5 found no DIS5K commercial-use statement at the pinned revisions, and the card names matting sets (e.g. AM-2k, P3M) whose own terms may be research-only. Decide whether the weights may ship commercially | Licence and legal judgement; the model choice itself is a maintainer decision (MD-2), not reopened by an agent | BR0.5 sign-off, BR3.12 licence gate, RD3 §C.5. Engineering continues on the decided model; nothing ships without this |
| MO-12 | Decide the Smart Mask minimum hardware. BR0.7 measured about 6–7 GB peak per job on CPU; BiRefNet_HR-matting at its trained 2048² needs about 12 GB on CPU; the CoreML SAM video path reached 16 GB. "Apple Silicon 16 GB" as planned is not supported by these numbers. Choose between a higher floor (e.g. 32 GB for 2048²) or tiled/lower-resolution matting on 16 GB (measured separately against the same gates) | Product/market judgement on who can run the feature; changes published copy | BR0.7 sign-off, BR3.4/BR3.6 tile size, BR6.8 hardware-minimum state, DOC.1 minimum hardware |
| MO-13 | Hardware to measure the 2048² matting path and the CoreML runs: an Apple Silicon Mac with ≥ 32 GB unified memory (with the MO-9 Windows GPU machine) | This environment is a 16 GB M1 Pro; the runs exceed its 8 GB per-job safety budget | BR0.2 BiRefNet @2048² parity (CPU, CoreML), BR0.7 throughput, BR7.2 darwin-arm64 eval |
