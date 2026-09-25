# 13 — Production readiness

"Done" for a phase is its Definition of Done (09). "Production ready" is stricter: the feature can
ship to paying users on macOS and Windows, survive upgrade and failure, and be supported. Every
phase PR meets §1; the programme meets §10 before release.

---

## 1. The checklist every phase PR meets

- [ ] **Behaviour:** the phase's DoD holds end to end (entry → placement → validation → preview →
      export → undo → failure → tests), by hand **and** through the agent tool where the phase has
      one.
- [ ] **Parity:** its oracle rows pass in CI; frame-plan vectors equal; no existing row regresses.
- [ ] **Reversibility:** every new op has apply + invert tests; one undo removes each add.
- [ ] **Validation:** every new validator rule has a test of its message; messages carry a remedy and
      no varying numbers.
- [ ] **Errors:** every failure the user can hit has a sentence (02 §8) and a test; nothing
      fails silently; model-facing sentences pass `model-facing-failure.gate.test.ts`.
- [ ] **Performance:** its budgets (02 §9, 05 §7) measured with non-flaky guards.
- [ ] **Accessibility:** new UI is keyboard-complete, labelled, reduced-motion aware, and axe-clean
      in both themes (`accessibility.spec.ts`) — in the phase that adds it, not deferred.
- [ ] **Security:** no path from the renderer or the model reaches the disk; no new origin in the
      CSP; `security-reviewer` pass for phases that add IPC, file writes or network (EL6a, EL6b,
      EL10).
- [ ] **Licences:** bundled content ships with its licence file (test); `pnpm license:scan` when a
      manifest changes.
- [ ] **Compatibility:** v24 projects open unchanged except the listed fixes; the schema bump
      follows the CT7 checklist (04 §3).
- [ ] **Docs:** guide, API/ADR as applicable, `CHANGELOG.md`; `plan/PLAN.md` and this plan's ledger.
- [ ] **CI:** green on a SHA that contains the change — checked asynchronously, never waited on
      (push and move on; a push cancels the in-flight run; a red check jumps the queue). A draft PR
      does not run CI — dispatch it.

---

## 2. Rollout and rollback

- **No feature flags.** Each phase ships complete or not at all; the repository's only flag pattern
  (one build-time variable for a renderer swap, RD2.1) is not needed for additive surfaces.
- **Schema v25 is a one-way door.** A build that writes v25 makes those projects unopenable in older
  builds (by design — they would otherwise lose their shapes). So **no release contains the v25
  bump without the complete EL4a** (its evidence included). Before a release, a problem is fixed by
  reverting the PR stack; after one, by a forward fix.
- **EL2a changes existing renders** (photos fade and crop, titles animate). It ships with a
  changelog "Fixed" entry that says so, evidence run E, and regenerated goldens; there is no
  "old behaviour" switch, because the old behaviour was a control that did nothing.
- **The legacy monitor** (`VITE_FRAMEPILOT_PREVIEW_COMPOSITOR=legacy`, removed at RD3) does not
  draw elements; it says so rather than showing the wrong picture (12 §C).

---

## 3. Cross-platform (macOS arm64, Windows x64)

| Concern                                                 | Check                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Packaged set location (`extraResources`) and asar reads | `elementsRoot()` tests for both layouts; desktop-build CI on both runners                                                     |
| File names and paths when materialising                 | ids are ASCII `[a-z0-9_]`; writes through `resolveWithin` + `safeFileName`; tested with Windows reserved names and long paths |
| WebP decode in the **frozen** engine                    | a CI smoke render of a sticker frame with the packaged engine on each OS                                                      |
| `ImageDecoder` (EL10) in the shipped Electron           | feature-detected; the first-frame fallback is tested                                                                          |
| HiDPI                                                   | tiles use 144 px thumbnails (2× for 72 px tiles, ≈ 4.4 KB each, measured)                                                     |
| Modifiers                                               | Cmd on macOS, Ctrl on Windows, for every panel and canvas shortcut                                                            |
| Fonts in numbered badges                                | bundled title fonts only (no system-font dependency)                                                                          |

---

## 4. Data safety

- Element files are written temp → atomic rename inside the project media folder; a failed or
  cancelled write leaves nothing reachable.
- Bundled bytes are hash-verified before every copy; a damaged install is a stated error, not a
  broken project.
- Originals are never modified or deleted (AGENTS.md invariant 1); undo removes the clip and the
  asset row, the file stays.
- A project copied or archived elsewhere carries its element files (they live in its media folder);
  if one is missing on open, it is **re-materialised from the library** by id before the
  missing-media prompt (12 §D).
- Autosave, crash recovery and history persistence are unchanged and cover element edits (one patch
  each).

---

## 5. Security and privacy

- The renderer and the model send **ids**, never paths; ids are checked against the bundled
  catalogue (06 §1).
- No provider origin is added to `connect-src`; tiles are same-origin files or `blob:` URLs of IPC
  bytes, the pattern the Pexels grid already uses.
- Shape params are bounded and strictly validated before any raster is drawn; raster size is capped
  (05 §2.2), so a crafted project cannot exhaust memory.
- EL10 downloads: https only, host allowlist, 2 MB cap, SHA-256 pin required before rename, stall
  timeout, cancellable.
- Privacy page accurate at every release (12 §K); search text is never logged or recorded.

---

## 6. Support runbook (`docs/runbooks/elements.md`, EL12)

| Symptom                                                  | Cause                                         | Fix                                                    |
| -------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| "This sticker's file is missing from this install"       | damaged or partial install                    | reinstall; the packaged set is hash-checked            |
| A sticker shows as missing media in an old project       | file deleted outside the app                  | auto-heal re-materialises it on open; otherwise relink |
| "Preview approximate" on shapes                          | browser build without the engine (after EL11) | expected; export is exact                              |
| Photos/Videos say "Add your Pexels key" / quota messages | unchanged Pexels behaviour                    | Settings → AI → Photos & videos                        |
| "Update FramePilot to open this project"                 | a v25+ project opened in an older build       | update                                                 |
| Animated sticker will not download (EL10)                | offline or blocked host                       | retry online; stickers already downloaded keep working |
| Export slower with many elements                         | per-frame compositing                         | budget 1.3× with 20 elements; flatten or trim elements |

Log scopes to ask for: `desktop:elements`, `web-editor:elements`, the engine's `render.shape_raster`
and `render.compiler` loggers; render-validation messages name the element.

---

## 7. Agent quality bar

An agent capability is production ready when its evaluation case (07 §8) meets its bar over **at
least 10 recorded runs**:

- placement cases (1, 4): the element covers the fixture's target in **≥ 8 of 10** runs;
- timing cases (1, 2): starts within ±0.3 s of the named word in ≥ 9 of 10;
- no-damage cases (5, 6): **10 of 10** (nothing else changed).

Below the bar, iterate the tool description, the skill and the digest; if it stays below, the
shortfall and its failure analysis go to the maintainer before the phase is checked off — never a
silent `[x]`.

---

## 8. Observability

Scoped loggers (06 §8); opt-in local telemetry counts adds and failures by code (never content);
render validation names elements; perf guards in CI catch regressions.

---

## 9. Quality passes before release

`ui-ux-critic` and `accessibility-responsive-auditor` on every Elements surface; `ux-copy` review
of all new strings; `editing-skills-expert` on the skill; `security-reviewer` on 06 §5;
`performance-monitor` on the budgets; the macOS **and** Windows manual script in `MANUAL_TESTING.md`.

---

## 10. Release gate (the programme)

- [ ] Every shipped phase meets §1; the ledger (README §6) and `plan/PLAN.md` agree with the code.
- [ ] CI fully green on the release commit, including `elements-e2e`, the oracle, perf, visual,
      licence and desktop-build jobs; installer within budget.
- [ ] Desktop evidence runs A–E (10 §4) committed with the commit they ran on.
- [ ] Agent bars (§7) met or explicitly waived by the maintainer in writing.
- [ ] Manual script passed on macOS arm64 and Windows x64.
- [ ] Docs, runbook, both changelogs and the website updated (12 §J–K).
- [ ] Open maintainer decisions answered; deferred items listed (11 §2).

**Last updated:** 2026-09-26
