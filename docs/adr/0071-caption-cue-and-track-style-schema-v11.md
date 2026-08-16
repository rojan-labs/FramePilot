# ADR 0071 — Caption cues own their text; tracks own the caption look (schema v11)

- **Status:** Accepted (2026-07-25)
- **Extends:** ADR 0069 (template-based caption styling, schema v10) — the
  template catalog and its closed enum vocabulary are unchanged and remain the
  styling source of truth. ADR 0045's `captionStyle` field and ADR 0011's
  burn-in wiring are likewise unchanged.

## Context

Through v10 a caption clip stored **only a time range plus a style**. It had no
text. Every consumer independently re-derived the words it should display from
`Project.transcript`, matching by time. That single decision produced five
distinct defects:

1. **Caption text was not editable.** There was nowhere to put an edit. Fixing
   one ASR error, rewording a line for the frame, or redacting a word required
   rewriting the project transcript — which is shared by search, the transcript
   rail, and every other cue over the same words. In practice the editor could
   generate captions and delete captions, and nothing in between.

2. **The derivations had already drifted.** `CaptionEditor.tsx` matched words by
   **start containment** (`w.start >= start && w.start < end`), while
   `PreviewPlayer.tsx` and `render/captions.py` matched by **overlap**
   (`w.start < end && w.end > start`). For any word straddling a cue boundary —
   common, since cue boundaries were placed by word count, not by pauses — the
   caption list showed one thing and the export produced another.

3. **Segmentation had two independent implementations** that disagreed. The
   Captions panel chunked every N words (`groupWordsIntoLines`); the AI recipe
   path broke on pauses over 0.8s (`recipe-leaves.ts#transcriptToCues`).
   Captioning the same project two ways gave two different cue sets.

4. **Trimming footage silently rewrote captions,** because cue content was a
   function of the live transcript rather than of the cue. An editor who
   tightened a clip found their caption text had changed.

5. **Line breaks were unexpressible.** Wrapping was whatever each renderer's
   greedy fill produced at that frame size, so the editor could not control
   where a line broke.

Separately, **style lived only on the clip.** Restyling a finished caption set
meant one `set_caption_style` operation per cue — a 400-operation patch to change
a colour — and there was no way to express "this project's captions look like
*this*", which is how every comparable tool (Premiere, Resolve, CapCut, AutoCut)
models it.

Finally, `CaptionStyleSchema.accent.mode` shipped `'keywords'` in v10 with **no
keyword source anywhere in the schema**. Both renderers documented it as a no-op
(`captionPreview.ts`: "has no engine-side keyword source yet and selects
nothing"). The editor's keyword chips were therefore preview-only and never
reached an export.

## Decision

**Schema v11.** Three additive changes; no field is removed or renamed.

1. **`Clip.captionCue: { text, words[] }`** — the cue's own displayed text and
   its own copy of the word timings that drive emphasis.

   - `text` is authoritative for what is **drawn**, and may legitimately differ
     from `words.map(w => w.word).join(' ')`: an edited line, an explicit `\n`,
     a redaction. Renderers draw `text` and use `words` only to *time* emphasis,
     matching by position.
   - `words` is a **copy**, not a pointer into `Project.transcript`. A cue must
     keep animating correctly after the transcript is re-run, re-timed, or
     replaced by a different ASR provider.
   - `words: []` is valid — a hand-typed cue has no word timing, and renderers
     fall back to showing the whole line for the clip's duration.
   - `text: ''` is meaningfully distinct from an absent cue: an empty cue draws
     nothing, whereas an absent cue falls back to the transcript.

2. **`Track.captionStyle`** — the caption look for every cue on the track: "the
   project's caption style". Resolution order becomes **clip override → track
   default → template catalog**. A per-clip `captionStyle` still wins, so
   hand-tuned single cues survive a track-wide restyle.

3. **`CaptionStyle.accent.keywords: string[]`** — the list `accent.mode:
   'keywords'` was always meant to read, matched case- and
   punctuation-insensitively. This makes an already-shipped enum value actually
   render, and makes emphasis a property of the caption rather than of whichever
   panel happens to be open.

**Backward compatibility is the load-bearing property.** The v10 → v11 migration
transforms **no data** — it only stamps the envelope version — because for each
new field, *absent* already means exactly the v10 behavior:

| Field | Absent means | Which is the v10 behavior |
|---|---|---|
| `Clip.captionCue` | derive text from `Project.transcript` by **overlap** | yes — what the preview and engine already did |
| `Track.captionStyle` | each cue resolves against the template catalog alone | yes |
| `accent.keywords` | `mode: 'keywords'` selects nothing | yes — the documented no-op |

So a v10 project renders byte-identically until it is re-captioned or a cue is
edited. This is asserted directly in `migrations.test.ts` ("stamps the envelope
version without transforming any data").

**Overlap is the one true text-derivation rule** for the fallback path. It was
already what two of the three implementations used, and it is the correct
semantics: a word audible during a cue belongs to that cue.

## Consequences

- Caption text becomes editable, splittable, mergeable, and line-breakable —
  the operations a professional caption workflow is built from — because there
  is finally a place to store the result of an edit.
- The three-way derivation drift is closed by construction: once a cue carries
  its own text, there is nothing left to re-derive and disagree about. The
  fallback path that remains has one definition (overlap), shared by all
  consumers.
- Segmentation becomes a *generation-time* concern rather than a render-time
  one. One shared segmenter produces cues; the panel and the AI recipe path both
  call it, so they cannot disagree.
- Cue `words` duplicate transcript data. This is deliberate: the duplication is
  what makes a cue survive a transcript re-run, and cue words are small (a cue
  is a handful of words). The project transcript remains the single source for
  search and the transcript rail.
- The engine keeps both paths: cue-present (draw `captionCue.text`) and
  cue-absent (derive from transcript). The second path is what keeps the v10
  goldens valid.
- `accent.mode: 'keywords'` stops being dead; both renderers must now implement
  keyword selection, and the parity test covers `accent` field-for-field so the
  two cannot drift again.

## Alternatives considered

- **Keep deriving text from the transcript; only unify the three
  implementations.** Cheaper, and it would have closed defect 2 and 3. But
  defects 1, 4, and 5 are unfixable without somewhere to put an edit, and they
  are the ones that block professional use. Rejected as insufficient.
- **Store `text` only; keep deriving word timings.** Makes text editable at half
  the cost. But 24 of the 45 catalog templates (the karaoke, one-word, and build
  families) need per-word timing, so they would break the moment text was
  edited — the animation would time against words the cue no longer displays.
  Rejected.
- **Store cues in a separate top-level `captions` array rather than on clips.**
  Closer to how a subtitle file is shaped. Rejected: it would fork caption
  timing away from the timeline, so trim/ripple/split would need a parallel
  implementation for captions, and the existing reversible clip operations
  (which already handle caption clips correctly) would not apply.
- **Per-cue style plus a bulk "apply to all" action** instead of a track
  default. No schema change. Rejected: a 400-cue project means a 400-operation
  patch on every style tweak, and there is still no representation of "the
  project's caption look" for a template switch to target.
