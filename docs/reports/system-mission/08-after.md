# Phase 8 — UI/UX audit and interaction fixes: after

Closed 2026-08-29. The input is `00-ux-findings.md` (P0.6, sixteen findings from the
desktop walkthrough on `mission-montage`); the triage that turned them into tasks is in
`plan/system-mission/08-UI-UX-AUDIT.md` §P8.1.

**On evidence.** The done-when for P8.2 asks for a screenshot per state and for P8.6
before/after shots per finding. **There are none, and this report does not pretend
otherwise.** Every fix in this phase is asserted by RTL tests that fail on the previous
code — which is the stronger evidence for behaviour, and the only kind a jsdom suite can
produce. Screenshots would have to come from `ux-walkthrough.spec.ts` in a real desktop
host, which is the same harness that produced the findings and is where the remaining
browser-only work (axe, the keyboard-only journey, the 1024 px layout) also belongs. The
"before" images already exist in `docs/reports/system-mission/ux/`; the matching "after"
pass is a walkthrough re-run, not a renderer change.

---

## Finding by finding

| ID  | Sev | Where it landed | State |
| --- | --- | --- | --- |
| UX-01 | B | Phase 7 (P7.3 export dialog) | **Closed** |
| UX-02 | S | P8.2 — `ai/starterPrompts.ts` | **Closed** |
| UX-03 | C | deferred (cosmetic) | Deferred |
| UX-04 | B | Phase 3 (composer attach → analyzed profile → context block) | **Closed** |
| UX-05 | S | P8.3 — every track is a row | **Closed** |
| UX-06 | S | P8.3 — `wheelIntent` | **Closed** |
| UX-07 | S | P8.3 — playhead-follow on seek | **Closed** |
| UX-08 | S | P8.3 — clip context menu | **Closed** (except "Disable clip" — see below) |
| UX-09 | C | deferred (cosmetic) | Deferred |
| UX-10 | S | P8.4 — was a capture artifact, fixed in the spec | **Closed** |
| UX-11 | S | P8.4 — `editor/providerHealth.ts` | **Closed** |
| UX-12 | C | deferred (cosmetic); needs a browser | Deferred |
| UX-13 | C | deferred (cosmetic) | Deferred |
| UX-14 | S | P8.3 — `preview/frame-fit.ts` | **Closed** |
| UX-15 | C | deferred (cosmetic) | Deferred |
| UX-16 | S | P8.2 — the "knows" strip | **Closed** |

**Not shipped, and why.** UX-08 asked for "Disable clip". There is no per-clip enabled
flag anywhere in the schema — `set_track_flags` is track-scope, `set_effect_layer_enabled`
is layer-scope, `set_transition_disabled` belongs to a transition. Adding one is a
timeline-schema change with a migration and a render-side meaning, which `CLAUDE.md` §5
says to raise rather than slip into a context-menu task. Copy/Paste, the other half of
UX-08's list, already exist as `pasteClipPatch` on the keyboard path.

---

## The five sidebar states (P8.2)

Each has one RTL test in `AiSidebar.states.test.tsx`, driven through the panel rather than
through its pieces — the claim is that a user in front of the sidebar can read the state
off the screen, which is only true end to end.

| State | What the panel shows | Test |
| --- | --- | --- |
| **Knows** | Included-context strip: selection, pins, project/timeline/transcript/assets, **the playhead**, and every remembered decision as a "Remembers …" chip whose removal *forgets* it. Reference attachments carry their role (Phase 3). | `KNOWS: the context strip accounts for the playhead, the memory and the facts it cannot withhold` |
| **Doing** | The activity rail names the phase ("Thinking…") with elapsed time; the composer holds Stop. Raw tool JSON stays behind a disclosure. | `DOING: a live run says what it is doing and offers the way to stop it` |
| **Changed** | Run footer: "Made N edits", the operations grouped semantically (`Trimmed clip ×2 · Added transition`), the programme-length delta (`−12.5s · now 47.5s`), "Show on timeline", "Undo run". | `CHANGED: the footer says what the run did and what it did to the length` |
| **Needs** | A blocked run renders the model's own question with its options as buttons, plus a free-text answer. | `NEEDS: a question the run is blocked on renders its choices as buttons` |
| **Failed** | One plain sentence naming the action that helps; the provider/FFmpeg text behind "Show details"; inline Retry. | `FAILED: says what to do about it, and keeps the provider body behind "Show details"` |

Three of the five were genuinely broken rather than merely absent, and each failure was of
the same kind — **a control or a claim that was not backed by anything**:

- **Four context chips offered a remove button that removed nothing.** Timeline, Project,
  Transcript and Assets are read off the project snapshot every request is built from;
  only selection, pins and memory were ever filtered out of the request. The strip whose
  whole job is an honest account of what the AI is given ended with four controls that
  quietly did nothing. `ContextItem.removable` now says which is which.
- **The playhead was the one always-sent fact the strip never showed.** It is threaded
  into every request and is what the model leans on for anything positional. It is now a
  leaf component subscribing to the playhead clock alone — routing the value through the
  sidebar's `contextItems` memo would re-render the composer on every tick of playback.
- **The "Show details" disclosure existed and nothing ever fed it.** Both of the sidebar's
  catch blocks put `error.message` in the headline, so a 401 body or an FFmpeg dump became
  the loudest text in the panel at the moment the user most needs to know what to do.
  `ai/runFailure.ts` maps the actionable families to one sentence and moves the raw text
  behind the fold; **an unrecognised failure keeps its own words**, because guessing a
  friendlier phrase for an unknown error trades a true technical sentence for a vague
  false one.

**Not shipped in P8.2:** the P5.4 queue/progress for analysis and export jobs is not in the
activity rail. It is a Phase 5 surface this phase would have to reach across for, and the
five states read correctly without it.

---

## State matrix (P8.4)

The done-when asks for a matrix per panel with each cell implemented. Auditing every panel
found real states almost everywhere; the honest result is a description of what is there,
not a list of new work.

| Panel | Loading | Empty | No match | Error | Progress / cancel |
| --- | --- | --- | --- | --- | --- |
| Media bin | Per-file import skeleton cards at real tile size | "No media yet" + import/drag hint | Distinct no-match state | Import failure keeps the queue moving | Import placeholders per in-flight file |
| Effects | — (local library) | `EmptyState` **by cause** | Query-specific | — | — |
| Transitions | — (local library) | By cause, incl. "nothing to transition between yet" | Query-specific | — | — |
| Sounds | 6 skeleton rows at real row height | Prompt to search | Query-specific | Provider failure stated inline | Per-item download % + cancel |
| Stock | 8 skeleton tiles at real aspect | Prompt to search | Query-specific | Provider failure inline; quota shown | Per-item download % + cancel |
| Overlays | — | "No overlays yet" / "No overlay track in this project" | — | — | — |
| Captions | — | Per-tab copy (Review / Style / Generate) | Style search no-match | — | Generation progress |
| Transcription | Staged copy with anti-flash | Ordered by what the editor hits first (no media → no speech → not run) | — | Typed failure with retry | `TranscribeProgress` with cancel |
| Footage understanding | Staged loading copy, ~250 ms anti-flash | Honest "nothing analysed yet" | — | Reason stated, never fabricated | Phase-named progress |
| History | — | "No edits yet" + what to do | Distinct from empty — a filter matching nothing used to be indistinguishable from a broken panel | — | — |
| Inspector | — | "It's empty here" + what to select | — | — | — |
| AI sidebar | Activity rail + elapsed | Starter prompts **derived from the project** (UX-02) | — | Plain-language notice + details + Retry | Streaming status, Stop |
| Export | — | — | — | Typed failure | Progress with cancel |

**One destructive action was neither confirmed nor undoable.** Every timeline mutation is
a patch, so "destructive" on the timeline means one Cmd+Z away. `conversations.remove` is
not: it drops the whole transcript from state *and* from persistence, nothing brings it
back, and it sat one click deep in a row menu directly below "Copy Markdown". It now
confirms inline on the row — the thing being destroyed is right there and named, which a
modal would cover up, and the row already had an inline mode (rename). Export-overwrite
confirmation is a desktop save-dialog question, not a renderer one.

---

## Focus, keyboard, accessibility (P8.5)

Landed earlier in the phase; recorded here for completeness. Escape was handled wherever
it was convenient rather than where the user is (three dialogs put it on a React
`onKeyDown`, which only sees keys pressed inside the element carrying it); nothing returned
focus to its trigger; three "panels" were modal in fact — `role="dialog"`, dimming
click-to-close backdrop — and declared no `aria-modal` and trapped no focus, so Tab walked
out onto editor controls the user could neither see nor get back from without a mouse. 13
RTL tests, every one failing on the previous code.

**Still open, and it needs a browser, not jsdom:** axe on the main screens, the
keyboard-only montage journey, the five inputs that clear their focus outline with nothing
in its place (`.command-palette-search input`, `.shortcut-search input`,
`.transcript-search input`, `.transcription-search input`, `.topbar-title-input`), and the
1024 px layout check (UX-12). A focus ring cannot be asserted in jsdom, and an untestable
CSS edit is exactly what this phase should not ship.

---

## Tests

`apps/web-editor` went from **2671** to **2726** passing (+55), all green, with typecheck
and lint clean. The new suites: `AiSidebar.states.test.tsx` (5), `ai/runFailure.test.ts`
(9), `ai/runSummary.test.ts` (8), `ai/starterPrompts.test.ts` (6),
`preview/frame-fit.test.ts` (8), plus additions to `ClipContextMenu.test.tsx` (+7),
`MediaBin.test.tsx` (+3), `PreviewPlayer.monitor.test.tsx` (+3),
`HistoryDrawer.test.tsx` (+1), `Composer.test.tsx` (+2) and
`ai/composerActions.test.ts` (+1).

## Visual baselines

The AI sidebar's markup changed: four context chips lost their remove button, a playhead
chip was added, and the run footer gained two spans. `visual.spec.ts-snapshots/ai-sidebar*`
will differ and needs a reviewed regeneration by whoever owns `tests/e2e`. The timeline,
captions, colour, keyframe and mask baselines are untouched — the clip context menu and the
preview fit chip are not in any captured region.
