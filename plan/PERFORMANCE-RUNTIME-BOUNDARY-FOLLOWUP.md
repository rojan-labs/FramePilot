# Runtime Boundary Performance Follow-up

Status: **[~] Implementation complete. Full PR/CI verification intentionally deferred.**
Date: 2026-08-10

This follow-up closes the runtime-boundary and lifetime findings that remained after the
2026-08-08 end-to-end performance audit. It preserves the existing FramePilot invariants:
typed/validated/reversible edits, browser-side preview, engine-side render truth, sandboxed
IPC, bounded long-running work, and deterministic tests.

The implementation for every finding below is present on the branch. The user explicitly
deferred full CI until the pull request is open, and this execution surface has no local
checkout/test runner. Items therefore remain `[~]` rather than `[x]`. They may become `[x]`
only after the repository's required broader verification is completed.

## Findings

- [~] **RB1 AI configuration hot-path IO.** One host snapshot serves provider reads;
  model/base-URL typing settles to one persistence write per burst, immediate config changes
  still persist synchronously, and a process-exit guard flushes a pending settled edit.
- [~] **RB2 Renderer authoritative project cache lifetime.** Full renderer Projects are
  bounded to a two-entry LRU while preserving authoritative recovery fallback.
- [~] **RB3 RenderQueue terminal payload lifetime.** Completed requests/cancellation handles
  are released; only a bounded retry window retains failed/cancelled request payloads.
- [~] **RB4 Manual edit IPC payloads.** Routine user edits use their existing validated,
  reversible Patch through the host revision lane instead of cloning the whole Project.
- [~] **RB5 Durable history shaping.** Live history remains in the editor representation;
  bounded restart-history shaping happens at persistence/checkpoint boundaries.
- [~] **RB6 Preload channel drift.** The sandboxed CommonJS preload remains inlined, but a
  deterministic parity guard now makes any drift from the canonical IPC registry fail.
- [~] **RB7 Side-effect-free project recovery snapshot.** Compact-delta recovery uses a
  read-only `projectSnapshot` channel and no longer replays recents/watch/warmup open flows.
- [~] **RB8 Save acknowledgement lane.** Review proved same-path watcher reaffirmation already
  performs zero native watch/read work. A focused guard pins that invariant; recovery and the
  active-project pointer remain awaited because they are intentional durability state.
- [~] **RB9 Browser restore double parse.** One validated boot-state load derives both the
  browser Project and path.
- [~] **RB10 Renderer AI bundle boundary.** Concrete hosted SDKs remain provider-specific
  dynamic imports and `@framepilot/ai-sdk` is explicitly side-effect-free for tree shaking.
- [~] **RB11 Media-import transport throughput.** Production chunks use a shared hard 16 MiB
  ceiling, reducing a 20 GiB import to at most 1,280 sequential IPC calls without O(file) RAM.
- [~] **RB12 Explicit media chunk IPC typing.** Production import uses a first-class typed
  chunk request/channel; historical framed/whole-file transport is compatibility-only.
- [~] **RB13 Render worker project transport.** Multiprocessing receives a render-only Project
  projection, excluding waveform/thumbnail/proxy metadata, folders, markers, AI memory and
  restart history; transcript is included only when burned captions require it.
- [~] **RB14 ASR whole-media host reads.** Active renderer transcription requests are limited
  to Local/TwelveLabs. Retired Groq/NVIDIA values remain migration inputs and resolve to Local,
  so current manual/agent product routing cannot enter the dormant raw hosted-upload branch.
- [~] **RB15 Electron feature initialization.** Desktop starts through a small bootstrap that
  registers lightweight IPC stubs; project-snapshot/media-import implementation graphs load on
  first feature use rather than ordinary startup.
- [~] **RB16 Scoped desktop logging.** The shared logger owns captured platform sinks and the
  bootstrap routes the legacy main composition root's remaining bare console output through a
  scoped logger without recursion.
- [~] **RB17 Caption update-domain isolation.** The existing caption workspace keeps long cue
  lists virtualized, template search deferred, template preview leaves memoized, and preview
  animation limited to active on-screen tiles. Structural regression guards now pin those
  boundaries against future caption changes.

## Verification-found correctness fixes

- [~] **VF1 Settled AI-config shutdown durability.** Self-review found `flush()` existed but
  was not automatically armed. The first settled text burst now registers one synchronous
  process-exit flush, closing the sub-300 ms quit window without adding keystroke IO.
- [~] **VF2 Manual disjoint-rebase synchronization.** A successful host rebase can contain
  concurrent authoritative edits. The renderer now retains a validated rebased Project,
  refreshes it through any later already-queued local commits, and adopts the final authority
  only after the manual commit lane drains. Normal non-rebased commits do not parse a full
  Project.

## Verification policy for this branch

Focused deterministic regression tests were added beside the affected packages. The current
execution surface is GitHub-connector-only and does not expose a local checkout, so no local
commands were executed and no claim is made that those tests/typechecks/lint passed here.
Full monorepo verification, E2E, coverage, desktop build matrix, and GitHub Actions are
explicitly deferred to the PR/CI stage and were not inspected during implementation.
