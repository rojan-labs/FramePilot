# Runtime Boundary Performance Follow-up

**Date:** 2026-08-10  
**Scope:** Electron main/preload/IPC, web-editor persistence and lifetime, Python render queue/process transport, AI configuration and bundle boundaries, media import/ASR, captions.

This report accompanies `plan/PERFORMANCE-RUNTIME-BOUNDARY-FOLLOWUP.md`. Implementation is complete, but status remains `[~]` until broader PR/CI verification is completed.

## Boundary budgets

| Boundary | Required work bound |
| --- | --- |
| AI config reads after first hydration | **0 filesystem reads per getter/projection** |
| Model/base-URL typing burst | **1 disk persistence after 300 ms settle; pending burst flushed on process exit** |
| Renderer authoritative full-project cache | **≤ 2 complete Projects** |
| Terminal render queue heavy request retention | **0 completed + ≤ 8 retryable requests** |
| Routine manual authoritative edit IPC | **O(patch), not O(project)** |
| Manual disjoint rebase synchronization | **adopt final validated host authority after queued local commits drain** |
| Restart-history shaping | **persistence/checkpoint boundary only** |
| Autosave watcher re-registration | **0 native watch/read operations for the same path** |
| Preload/main IPC channel drift | **0 unguarded channel differences** |
| Compact-project recovery | **snapshot read only, no open side effects** |
| Browser boot restore | **1 full parse/schema validation** |
| Hosted provider SDKs evaluated at renderer startup | **0** |
| Auxiliary desktop implementation modules loaded at startup | **0** |
| Media import resident IPC payload | **≤ 16 MiB** |
| 20 GiB media import IPC calls | **≤ 1,280 sequential calls** |
| Render spawn payload | **independent of waveform/history/session bytes** |
| Active ASR request providers | **Local/TwelveLabs only** |
| Unscoped legacy desktop console output | **0 at runtime** |
| Caption cue DOM | **virtualized; template previews memoized and animated only while active/on-screen** |

## Implemented findings

- **RB1. AI configuration hot-path IO.** Memory-backed host config with settled text persistence and process-exit durability.
- **RB2. Renderer authoritative cache lifetime.** Two-Project LRU.
- **RB3. RenderQueue terminal payload lifetime.** Completed payload release and bounded retry payloads.
- **RB4. Routine manual edit IPC.** Existing validated forward/inverse patches use the host revision lane.
- **RB5. Durable history shaping.** Restart history is shaped only at persistence boundaries.
- **RB6. Sandbox preload channel drift.** Deterministic preload/canonical channel parity guard.
- **RB7. Side-effect-free recovery.** `projectSnapshot` reads the active project without open-project side effects.
- **RB8. Save acknowledgement lane.** Same-path watcher calls already perform zero native watch/read work; the regression guard now pins that behavior. Crash-recovery and active-pointer durability remain awaited intentionally.
- **RB9. Browser boot restore.** One restore parse/validation derives both project and path.
- **RB10. Renderer AI bundle boundary.** Concrete hosted SDKs remain provider-specific dynamic imports and the AI SDK barrel is explicitly side-effect-free for renderer tree shaking.
- **RB11. Media import throughput.** Production frames are 16 MiB with a shared hard ceiling; a 20 GiB source is 1,280 calls instead of 5,120.
- **RB12. Explicit media chunk IPC typing.** Production media materialization uses `MediaImportChunkRequest`; historical framed/whole-file transport is compatibility-only.
- **RB13. Render worker process transport.** The spawned process receives render-only Project state, excluding derived media/history/session bytes and excluding transcript unless captions are burned.
- **RB14. ASR whole-media host reads.** Active renderer requests accept only Local/TwelveLabs; retired hosted names migrate to Local before provider construction, keeping current product routing out of the dormant raw hosted-upload branch.
- **RB15. Electron feature initialization.** The desktop bootstrap registers lightweight deferred channels and loads auxiliary implementation graphs only on first use.
- **RB16. Scoped desktop logging.** Captured platform sinks make logger output recursion-safe while the bootstrap routes legacy main-process console calls through `desktop:console`.
- **RB17. Caption update-domain isolation.** Existing cue virtualization, deferred template search, memoized preview leaves, and on-screen/active animation boundaries are now protected by a focused regression guard.

## Correctness issues found during self-review

- **Settled AI config at shutdown.** The original follow-up added an explicit `flush()` seam but did not automatically invoke it. A text burst now arms exactly one synchronous process-exit flush so the last model/base-URL edit is not lost if the app exits inside the settle window.
- **Manual disjoint rebase adoption.** The host can return a rebased Project containing concurrent authoritative changes. The renderer now validates and retains that authority, refreshes it through later already-queued manual commits, and reconciles the final Project only after the lane drains. The common non-rebased path keeps the compact fast path.

## Verification status

Focused regression tests were authored for the changed boundaries and the final source/diff was reviewed through the connected repository. This execution environment does not expose a local FramePilot checkout, so no local test, typecheck, lint, build, E2E, coverage, or Python command was run here. GitHub Actions, check status, workflow runs, and CI logs were intentionally not inspected. Full PR/CI verification remains deferred exactly as requested.
