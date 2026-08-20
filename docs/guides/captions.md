# Captions

How FramePilot turns speech into captions, and how to shape the result.

Captions are a first-class part of the editor rather than a one-shot generator: a
generated caption set is a starting point you edit, not an artefact you accept or
throw away. This guide covers the workflow, then the architecture behind it.

---

## The workflow

### 1. Get a transcript

Captions read the **project transcript** — one word-level list, shared with
transcript search and the Transcription panel. Transcribe a clip from the
Transcription panel (header → **Transcription**) or the Transcript rail, or turn
on Settings → AI → Speech-to-text → _Automatically on import_.

Accuracy depends on the source and provider. Local `whisper-cli` needs no key and
no network; TwelveLabs can reuse the Media intelligence key and its indexed
word-level transcript. See [transcription.md](./transcription.md).

### 2. Choose a look and a cue length

Open the **Captions** tab in the left rail.

- **Style** is a searchable gallery of caption templates across eight categories.
  **All** shows the complete catalog; category chips carry counts, and search
  understands both names and behavior such as “word by word”. The first 12
  results render immediately; **Load 8 more** expands the current filter without
  turning the rail into one long list. Every tile holds a representative visible
  frame at rest and animates while hovered or keyboard-focused, using the real
  caption overlay without continuously rendering every card.
  Choosing one applies it to **every caption on the track** — one action, one undo.
- Press `/` from the panel to focus style search. `Cmd`/`Ctrl`+`Enter` generates
  captions when focus is not inside a text field.
- **Timing and emphasis** keeps less-used controls behind one compact disclosure.
  **Cue length** decides how the speech is cut up:

  | Choice             | What it produces                                                         |
  | ------------------ | ------------------------------------------------------------------------ |
  | Match the template | Follows whatever the chosen template implies. Right almost always.       |
  | Short & punchy     | Up to 6 words / 24 characters a line — the Reels/TikTok register.        |
  | Full subtitles     | Up to 42 characters a line at 17 characters/second — the broadcast norm. |
  | One word at a time | Every word its own caption.                                              |

- **Auto emphasis** asks the AI provider selected under Settings → AI to analyze meaning and spoken
  delivery—pauses, stretched words, sentence position, contrast, numbers, confidence, and emotional
  weight—then picks a deliberately sparse set of anchor words. The response is validated and cannot
  invent or rewrite transcript words. If the provider is unavailable, the panel says so and applies
  its deterministic local delivery analysis instead. Those anchors also influence segmentation: the
  segmenter budgets for their larger visual width and balances cue pages around them instead of
  isolating a large word at an arbitrary boundary.
- **Emphasise words** remains editable. Replace the suggested comma-separated list, then press Enter
  or leave the field to apply one reversible track-style change. Matching words keep the template's
  accent personality in the cue list, live preview, and final export.

The template wall and Program monitor are the visual previews. Per-cue size, color, width, line
height, rotation, alignment, safe-area behavior, and anchor position are available under
**Selected cue style** after selecting a caption. In the Program monitor, select the active caption
and drag it directly; the side handle changes its wrap width, the top handle rotates it, and a
double-click edits its text in place.

The **Typography** section applies a font to the whole caption track. **Font for selected cue** can
override one caption when the composition needs a deliberate exception. Both pickers contain the
same 22 bundled families, grouped by purpose:

| Group       | Families                                                                               |
| ----------- | -------------------------------------------------------------------------------------- |
| Sans serif  | Inter, Montserrat, Roboto, Open Sans, Lato, Raleway, Figtree, Manrope, Poppins, Nunito |
| Display     | Archivo Black, Oswald, Bebas Neue, Anton, Bangers                                      |
| Serif       | DM Serif Display, Playfair Display, Merriweather                                       |
| Monospace   | Space Mono                                                                             |
| Handwritten | Caveat, Pacifico, Shadows Into Light                                                   |

The fonts are bundled for both live preview and final export, so a project keeps the same typography
on another machine. Templates now draw from this wider catalog.

### 3. Generate

**Generate captions** first runs AI emphasis when Auto emphasis is enabled, then lays the cues onto
the caption track as one reversible patch. This lets model-selected anchors influence the first
segmentation pass rather than being painted on afterward. A single undo removes the whole set.

Generating again **replaces** the existing captions rather than adding to them,
so it is safe to re-run after re-transcribing or changing the cue length. The
panel says so before you do it.

### 4. Edit

This is where a generated set becomes a finished one.

| Action              | How                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------- |
| Edit the text       | Click the caption and type. Blur or `Ctrl`/`Cmd`+`Enter` commits; `Esc` reverts.    |
| Add a line break    | Press `Enter` while editing. It renders exactly where you put it.                   |
| Split               | The scissors icon cuts at the playhead; each half keeps the words spoken during it. |
| Merge               | The combine icon joins a caption with the one after it.                             |
| Delete              | The bin icon.                                                                       |
| Seek                | Click the timecode.                                                                 |
| Restyle one caption | Select it, then use Size / colour / position under "This cue only".                 |
| Place in preview    | Drag the selected caption; side handle resizes, top handle rotates.                 |
| Edit in preview     | Double-click the caption, edit, then blur or `Cmd`/`Ctrl`+`Enter`.                  |

Editing a caption's text does **not** change the transcript, and re-running
transcription does **not** change captions you have edited — they are
independent once written.

### 5. Export

Captions are **soft** by default: they preview in the editor but are not part of
the video file. Tick **Burn captions** in the Export dialog to render them into
the picture.

What exports is exactly what the panel shows — same text, same line breaks, same
emphasis.

---

## How it works

### Where a caption's text lives

A caption clip carries its own `captionCue` — the text it displays plus the word
timings that drive karaoke/build animation (schema v11,
[ADR 0071](../adr/0071-caption-cue-and-track-style-schema-v11.md)).

The cue's `words` are a **copy**, not a pointer into the transcript, which is why
a caption survives a transcript re-run. And `text` is authoritative for what is
drawn: it may legitimately differ from the words (an edit, a `\n`, a redaction),
so renderers draw `text` and use `words` only to _time_ emphasis, matching by
position.

A clip with no cue falls back to deriving its words from the transcript by
**overlap** — the pre-v11 behavior, which is what keeps older projects rendering
unchanged. `resolveCaptionCue` in `@framepilot/editor-core` is the only place
either path is implemented; the Python engine mirrors it exactly.

### Where a caption's look lives

Three layers, highest priority first:

```
clip.captionStyle      →  this caption only (size, colour, position…)
track.captionStyle     →  the whole set (what choosing a template writes)
template catalog       →  the named look's own definition
```

`resolveCaptionStyle(clipStyle, trackStyle)` folds them, and
`resolve_caption_style` in the engine mirrors it. Renderers interpret only the
closed enum vocabulary — never a template id — so adding a template is pure
catalog data ([ADR 0069](../adr/0069-caption-template-schema-v10.md)).

### Which timeline the cues land on

Captions are derived from **the edit, not the recording**. A transcript's
timestamps belong to the source asset — word 42 sounds at 19.2s of the camera
file. A clip's belong to the sequence. The two coincide only until something is
cut.

So generation runs in this order (`captions/derive.ts`, ADR 0076):

1. **Map** every transcript word through `buildTimelineMap`, the one place in the
   product that converts between the two timebases.
2. **Drop** the words in footage the edit removed. A word cut in half belongs to
   whichever side kept most of it, and is dropped if neither kept half — deleted
   speech never reaches the screen.
3. **Group** the survivors into runs of continuous sequence time. A run never
   crosses a cut, _including_ where a ripple delete left two unrelated source
   ranges visually adjacent: those words were never spoken together.
4. **Segment** each run independently and clamp each cue to it, so a cue cannot
   begin before its footage or outlive it.

This is why **generating captions before the cuts are settled is the wrong
order**: cues describe where footage plays, and moving the footage invalidates
them. Each cue records the timeline revision it was built against, so a stale
caption is detectable rather than assumed — regenerate rather than nudging.

Captioning a timeline with no media correctly produces nothing: there is no
footage for the words to sit on.

### How speech is cut into cues

`segmentCaptions` in `@framepilot/editor-core` is the single segmenter, shared by
the Captions panel and the AI `add_captions` recipe so the two cannot disagree.
It runs five pure stages:

1. **Split into utterances** at hard boundaries: a real silence, or a sentence
   end. One sentence per cue is a rule, not a preference — as a preference, two
   sentences that both fit tie on quality and cue fullness silently decides.
2. **Pack** each utterance by choosing the best-scoring legal break. Sentence end
   beats clause boundary beats pause; ending a line on an article, preposition,
   or auxiliary is penalised. Auto-emphasized anchors contribute their expected visual width and
   prefer a balanced phrase ending, but never overrule a genuine sentence seam. Cue fullness is
   only a tie-breaker, which is why a cue may come out shorter than the limits allow.
3. **Enforce reading speed** — split anything arriving faster than the
   characters-per-second ceiling.
4. **Lay out lines** — place the `\n`, preferring a syntactic seam and a shorter
   first line.
5. **Enforce timing** — hold short cues for a minimum, and absorb gaps too small
   to be worth blinking for.

Everything is deterministic: the same words and config always give the same cues.

### Operations

Every change is a reversible timeline operation:

| Operation                 | Effect                                           |
| ------------------------- | ------------------------------------------------ |
| `add_caption_layer`       | Creates one short mapped, revision-stamped cue.  |
| `set_caption_cue`         | Sets (or clears) the clip's text + word timings. |
| `set_caption_style`       | Sets (or clears) the per-cue style override.     |
| `set_track_caption_style` | Sets (or clears) the track's style default.      |

Split composes `split_clip` with two `set_caption_cue`s; merge composes
`delete_range`, `trim_clip`, and one `set_caption_cue`. Both are one patch, so
both are one undo.

### Agent-driven emphasis and composition

The agent has the same design surface as the Captions panel; it does not mutate project data or
use a second styling representation:

1. `get_mapped_transcript` supplies edit-aware speech evidence.
   A whole recording is always divided into separate readable phrase cues; one full-duration
   `add_caption_layer` is rejected. Each accepted cue persists its mapped words and current
   timeline revision so verification can prove what it represents.
2. `discover_caption_styles` supplies real bundled fonts and template ids. It returns the whole
   matching catalog by default — `set_track_caption_style` rejects an id that never appeared in
   a result, so a partial list is a list the agent cannot act on (see
   [ADR 0128](../adr/0128-retrieval-the-run-can-actually-use.md)). `get_timeline` reports the
   style a caption track already carries, so "use a different style" is answerable without
   guessing at what the current one is.
3. The AI selects a sparse set of exact spoken anchors and calls `auto_emphasize_captions`. The
   tool rejects invented words and may set the track's template, font, x/y position, size,
   rotation, width, alignment, spacing, background, animation and safe-area behavior in the same
   reversible operation.
4. `set_track_caption_style` refines the shared composition; `set_caption_style` is reserved for
   intentional per-cue exceptions.
5. `verify_captions` checks the committed result — the TIMING half.
6. `get_frame` renders cues over the real footage and shows the image to the model — the
   LEGIBILITY half. The caption playbook requires at least two frames over different
   backgrounds (the busiest shot and a typical one) before captions may be called finished.
   Only offered to vision-capable models (see [ADR 0096](../adr/0096-model-vision-get-frame.md));
   on a text-only model the AI keeps saying plainly that the look is visually unreviewed.

The manual Auto Emphasis button still uses the configured provider with a clearly reported local
fallback. Agent invocation is AI-backed by the calling model's transcript reasoning; the tool
itself remains deterministic and schema-validated, so retries are inspectable and it never hides a
nested provider call.

---

## Notes and limits

- **Segmentation is tuned for English.** Break scoring reads English punctuation
  and a list of English function words. Other languages still segment on
  punctuation, pauses, and reading speed — the parts that are language-neutral —
  but will not get the "don't strand an article" treatment.
- **Caption text is not spell-checked** and is never rewritten automatically.
  What you type is what renders.
- **The preview is an approximation.** The engine's pixels are authoritative
  (the render-vs-preview rule); the DOM overlay is the live approximation built
  from the same resolved style.
- **Editing the cuts after captioning makes the captions stale.** They are not
  silently repaired: they keep the timing they were generated with and report as
  stale against the new timeline revision. Regenerate to bring them back in sync.
- **Captions generated before schema v12** carry no record of what they were
  built from, so they report unknown provenance — they are shown, but never
  claimed to be verified. Regenerating establishes it.
- **Timing and legibility are checked separately, because they fail separately.**
  `verify_captions` reads timeline state: it catches cues that are out of sync, over
  deleted speech, across a cut, or stale, and refuses paragraph-sized transcript
  fallback blocks, empty caption sets over retained speech, and title/lower-third
  overlays masquerading in the cue count. What it cannot see is a cue that is
  perfectly synchronized and still unreadable — clipped at the frame edge, sitting on
  a face, or lost against a bright shot. That is what `get_frame` is for: it renders
  a frame through the export compiler with captions burned in, so the AI judges the
  look from the actual picture. A cue that verifies clean and reads badly is still a
  broken caption.
- **Splitting a dense caption does not create reading time.** It makes each half
  shorter and lets each be held for the minimum, which is the honest best a
  segmenter can do when speech is genuinely too fast.

## See also

- [transcription.md](./transcription.md) — getting a transcript, providers, keys
- [ADR 0076](../adr/0076-canonical-timeline-mapping.md) — source↔sequence mapping,
  caption derivation, staleness (schema v12)
- [ADR 0071](../adr/0071-caption-cue-and-track-style-schema-v11.md) — cue + track style
- [ADR 0069](../adr/0069-caption-template-schema-v10.md) — the template catalog
- [ADR 0011](../adr/0011-caption-burn-in-render-wiring.md) — burn-in wiring
- [ADR 0093](../adr/0093-intelligent-caption-emphasis-and-layout-schema-v16.md) — automatic
  emphasis and direct caption layout
