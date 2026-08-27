---
name: broll-and-layering
description: Source footage the user never filmed (stock clips and photos, via search_stock/add_stock — explained here and nowhere else) and place it as b-roll, overlays, or a whole montage that clarifies narration and preserves visual hierarchy without decorative clutter.
tools: [list_assets, get_timeline, get_mapped_transcript, search_visual, search_stock, add_stock, add_clip, trim_clip, set_clip_blend_mode, add_mask, add_keyframes, set_track_flags]
---

# B-roll and layering

## Purpose

Turn narration into visual proof while keeping the speaker, graphics, and textures legible as one composition.

## When to use

Cutaways, jump-cut coverage, product/process illustration, textures, picture-in-picture,
or masked overlays — and any sequence assembled from stock, including a montage with no
footage of the user's own. `search_stock` / `add_stock` are explained here and nowhere
else.

## When not to use

Do not add unrelated movement, cover an emotional performance, or use blend modes as a substitute for shot selection.

## Sourcing a shot the user never filmed

`search_stock` reaches a stock library; `add_stock` downloads one. Give it
`atSeconds` and the clip also lands on the timeline there; leave `atSeconds` off
and it just arrives in the media bin. Reach for them **last**, not first.

- Exhaust the user's own footage first. On a screen recording or a product demo,
  a punch-in or a reframe of their own frame is almost always the better cut, and
  a generic stock shot makes the edit look cheaper than the material.
- Use stock when the script names something that was never filmed — a city
  exterior, an establishing shot, a texture — and say in your summary that the
  shot is stock, so the user is never surprised by footage they do not recognise.
- Search by subject, not by mood: "city skyline at dusk", not "inspiring".
- **Stock cannot sit on top of existing footage yet.** `add_stock` fails with a
  reason when that moment already has picture on it. That is a real constraint,
  not a retry: find an empty stretch, or cut a hole first. Do not respond by
  trying adjacent seconds until one sticks.
- A photo has no duration; it lands at the project's default still length and can
  be trimmed like any other clip afterwards.
- The provider is metered. `search_stock` tells you how many requests remain when
  it knows — if the number is small, commit to a candidate rather than browsing.
- **Building a sequence out of stock? Download first, arrange second.** Call
  `add_stock` without `atSeconds` for each clip you want so it lands in the media
  bin, then lay them out with `add_clip` once you know the order. "Gather" here
  means downloading into the bin — not collecting search results to choose from
  later. Downloading straight onto the timeline
  forces you to commit to a running order before you have seen the second shot,
  and the occupancy rule above then refuses it.
- A search result is only a `remoteId` until you download it. There is no path to
  guess and no URL to paste: `add_stock` is the only thing that turns a candidate
  into media this project owns.
- **Download from a search while its results are still in front of you.** Only the
  last couple of tool results keep their full text; older ones are replaced by a
  handle, and a `remoteId` lives nowhere else. So `add_stock` the shots you want
  from a search before you run the next one. Running twenty searches first and
  then trying to collect the ids means recalling twenty handles one at a time,
  which is slow, costs a great deal of context, and is how a montage run reaches
  its limit having downloaded nothing.
- **A long sequence is built in passes, not in one gulp.** Search, take the three
  or four shots that search gave you, then search again. Each download is real
  progress you keep; a plan to choose all fifty first is a plan you will not
  finish.

## Required inputs

Mapped narration timing, indexed visual evidence, available assets, free overlay ranges, and the story function of each cutaway.

## Expected outputs

Short evidence-backed overlay placements with a WHY that names what each shot clarifies or conceals.

## Core philosophy

B-roll is evidence, not wallpaper. Show concrete nouns and actions; return to faces for emotion, trust, and punchlines.

## Professional heuristics

- Enter slightly before the referenced word so recognition and language land together.
- Typical cutaways last 2–4 seconds; vary duration with information density.
- Keep A-roll audio continuous beneath b-roll.
- Use `normal` for footage; reserve `screen`, `multiply`, or `soft-light` for suitable graphic textures.
- Fade designed overlays; hard pop-ons should be intentional.

## Decision framework

Find a narrative cue → retrieve matching real footage → judge relevance and best source span → confirm a free upper track → place → inspect the return to A-roll.

## Common mistakes

Starting every asset at frame zero, covering the payoff, repeating one shot scale, stacking too many layers, or guessing what an asset shows.

## Verification checklist

- Every cutaway matches the spoken idea.
- No overlay collision or unintended occlusion exists.
- The speaker returns for emotional beats.
- Source selection avoids camera-settle or unusable frames.
- Layer flags, masks, and fades behave as intended.

## Recovery advice

If no matching asset exists, consider `search_stock` when the script genuinely
calls for a shot that was never filmed — otherwise omit the cutaway and say what
is missing, which is more useful than a generic substitute. If a seam remains distracting, adjust the cut point or framing before adding another layer.

## Related skills

`footage-intelligence`, `titles-and-text`, `cut-and-transition-grammar`, `cinematic-storytelling`.
