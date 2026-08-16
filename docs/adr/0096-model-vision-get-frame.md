# ADR 0096 — The model looks at the edit (`get_frame`)

- **Status:** Accepted (amended 2026-08-16)
- **Date:** 2026-08-04
- **Supersedes / relates to:** ADR 0070 (TwelveLabs understanding), ADR 0076 (canonical
  timeline mapping), ADR 0088 (effect layers)

## Context

Every verification surface the agent had read **state**: `verify_captions` checks cue
timing against the transcript, `verify_transitions` checks that a transition sits at a real
cut, the validator checks that a patch is well-formed. All of them answer questions about
numbers.

None of them can answer the question an editor asks first: _does it look right?_

A caption can be perfectly synchronized and still be unreadable against the shot behind it,
clipped at the frame edge, or sitting on someone's face. A punch-in can be arithmetically
correct and crop a head off. A grade can apply cleanly and read as muddy. The agent had no
way to know any of that, and — worse — nothing stopped it from _sounding_ certain about it,
because from its point of view every check it could run had passed.

The agent contract already forbade claiming visual quality on state checks alone, and told
the model to say "visually unreviewed" instead. That was honest but not useful: the model
was being asked to disclose a blindness we had given it no way to cure.

## Decision

Add a `get_frame` tool that renders **one composited frame of the timeline** and gives it to
the model as a real image.

Four things make it trustworthy rather than merely available:

1. **It renders through the export compiler.** `render/frame_grab.py` calls
   `compile_timeline` — the same function `/render` uses — and reads one frame off the
   composition. A frame drawn any other way would be a second renderer, and the moment the
   two disagreed the model would be checking its work against something no viewer will ever
   see. Captions are burned in by default, because soft captions are invisible in a still
   and "do the captions look right?" is the most common reason to look.

2. **It renders the run's WORKING copy.** `POST /render/frame` takes an inline project
   document (the same either/or contract the analysis routes use), not only a saved path.
   The agent asks for a frame to check work it has _just done_, and that work has not been
   saved — a path-only route would return the one picture guaranteed not to answer the
   question.

3. **The image travels on its own channel.** `HostToolOutcome.images` is separate from
   `data`, because `data` is rendered into the run's **text** action log, where a base64
   blob is unreadable to the model and ruinous to the prompt budget. The picture is attached
   to the next request as real image content (Anthropic image blocks, OpenAI `image_url`
   data URIs, Gemini `inlineData`); the log gets the facts — when the frame is from, how big
   it is — which is what a log should say and what a text-only path still learns.

4. **It is offered only to models that can see.** `supportsVision()` is a conservative
   allowlist of multimodal families, defaulting to **no**. A vision model missing from the
   list loses a capability; a text model wrongly included produces confident, fabricated
   descriptions of footage it never received, billed as input tokens. The contract paragraph
   teaching the model to look is spliced in on the same condition — telling a blind model to
   call `get_frame` instructs it to invent a tool call or apologise.

## Consequences

### What changes

- The caption-design skill's "custom placement requires preview evidence" rule is now
  actionable rather than aspirational, and its verification checklist requires looking at
  cues over at least two different backgrounds.
- The agent contract gains a bounded "LOOK AT YOUR WORK" protocol for sighted runs. It is
  deliberately stingy — one frame per call, pick the few moments that settle the question —
  because an unbudgeted "look at everything" turns a run into a slideshow and each frame
  costs real context.

### Costs accepted

- **A frame is not free.** It is billed as input tokens in proportion to its pixels, which
  is why the default longest edge is 512px JPEG and the ceiling is 1280px.
- **Frames are shown once.** A frame is evidence about the timeline _as it was when it was
  taken_; re-sending every frame a run has looked at would both re-bill each of them every
  turn and place stale pictures beside current ones with nothing telling them apart. The
  run buffers only the last turn's frames and clears them once sent.
- **A cached tool replay carries no image**, for the same reason: the runtime memo still
  holds the outcome, but re-showing a pre-edit frame under a post-edit question is exactly
  the failure the tool exists to prevent.

  **Amended (2026-08-16): a replay must also stop SAYING an image is attached.** Dropping
  the picture was implemented; withdrawing the claim was not. `unwrapFrame`'s payload
  carries `note: "The frame itself is attached to this turn as an image."`, and the memo
  forwarded that note verbatim with no image behind it — so the model was instructed to
  read a picture it had never received. It did the two things this ADR exists to prevent:
  refused questions it had the evidence to answer ("I don't have usable visual access to
  the attached frame"), and, elsewhere, described a frame it had not seen. The replay
  payload now states plainly that the image was rendered earlier and is not attached, keeps
  the facts, and — deliberately — does **not** invite a retry of the same moment, which the
  memo would answer from the same record until the turn budget ran out.

### Amendment (2026-08-16): looking is not only for checking your own work

This ADR was written for agent mode, and only agent mode was wired. `streamChat` — the
read-only **question** route, which is where a creator asks "how many people are on screen
at 13.3s?" — advertised `get_frame`, rendered the frame for real, and then threw the image
away: it threaded the tool _notes_ into the next turn and never `executed.frames`. Every
Q&A frame was a full composited render (up to ~40s on a cold composition) billed for
nothing, and the model answered from a payload that claimed an attachment it never got.

Three things follow, and they are the same three properties decision 3 and the costs above
already state — they simply now hold on **both** routes:

1. The question route attaches its frames as real image content on the next request, with
   the same `framesBlock` labelling, because image content carries no caption on any wire
   format here.
2. They are attached **once**. Agent mode buffers one turn of frames; the question route
   appends to a growing transcript, so a frame left on it is re-sent and re-billed on every
   later turn. The previous turn's frame message is stripped back to its words before the
   next one lands — unconditionally, including on turns where the memo answered, or a
   picture from two questions ago stays in front of the model.
3. The route's contract gains its own looking paragraph, gated on `supportsVision` exactly
   as decision 4 requires. It could not reuse agent mode's: "LOOK AT YOUR WORK" is about
   checking work the run just did, and a question run has done none. The base question
   contract's otherwise-good instruction to "say when the evidence is insufficient" was
   actively harmful here — a timeline summary genuinely cannot see, so the model concluded
   the evidence was insufficient and said so with `get_frame` and `search_visual` sitting
   unused in its tool list. Admitting you cannot see is honest only **after** looking.

Two related dishonesties in the same surface were removed at the same time, both instances
of telling the model to do something it cannot:

- The visual-search, footage-map and visual-status messages told the model to call
  `index_media`. That tool is implicit lifecycle work (`IMPLICIT_ONLY_TOOL_NAMES`), driven
  by the app on import, and is withheld from every model-facing scope. They now say that
  indexing is automatic and name what the model _can_ do.
- The visual-status line said the model "cannot see" when no embeddings key is configured.
  `get_frame` renders any moment of the timeline independently of the visual **index**, so
  the accurate claim is that it cannot _search by content_ — and a model told it is blind
  stops looking.

Finally, `ContextInput.visualStatus` — the one line telling a run whether it can search
this footage — had existed since the visual index landed with **no host filling it**. The
desktop hub now reads it once per run and injects it; it fails soft to no block.

### Rejected alternatives

- **Reuse `/render/preview`.** A preview encodes a whole video file to disk for a human to
  scrub. Encoding a video to answer "what does 12.4s look like?" is the wrong shape.
- **Hand the model a file path or URL.** The frames are rendered from the user's own local
  media. There is no public URL for them, and creating one would mean uploading a creator's
  footage to show the model a single frame.
- **Draw the frame with a cheaper, non-MoviePy path.** Faster, and wrong: see decision 1.
