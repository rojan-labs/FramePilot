# Professional tracking and mask commands

FramePilot's first professional tracking contract is deliberately narrower than the legacy
`track_object` primitive:

```text
live clip selection
  → canonical existing mask geometry + correction keyframes
  → track_existing_mask TrackingCommand
  → validated track_object patch + exact inverse
  → bounded tracker motion evidence
```

## Manual existing-mask tracking

`professional_tracking_mask` resolves `this` or the playhead through the revision-bound
`EditorInteractionContext`. The selected clip must already contain its canonical
`<clip-id>__mask` rectangle or ellipse with valid normalized bounds. Those bounds—not coordinates
invented by the model—become the track's initial region. Existing mask `x`, `y`, `width`, and
`height` keyframes are treated as editor corrections; missing axes hold their initial bounds.

The compiler rejects stale revisions, missing/duplicated masks, locked or non-visual tracks,
polygon masks, out-of-clip keyframes, and any interpolated box that leaves the normalized frame.
It emits one canonical `<clip-id>__track` effect using the deterministic `manual` engine and proves
apply/invert before returning the patch. Re-running either mask or tracking primitives replaces the
same canonical effect rather than stacking duplicate IDs; TypeScript and Python operations share
that behavior.

## Verification

The unified temporal planner detects changed `mask` and `object_track` effects in the validated
before/after diff. It requests normalized bounds and motion samples with inside-frame,
acceleration, and jitter checks. A long clip is reviewed through bounded beginning/middle/end
windows instead of an unbounded all-frame analysis.

## Deliberate unsupported boundary

Automatic face/object tracking, point tracking, planar tracking, segmentation, tracked reframing,
graphics attachment, and tracked local color remain unavailable. The bundled engine has a real
manual tracker seam but no approved CV model. The capability registry therefore advertises manual
existing-mask tracking as executable and automatic subject tracking as unavailable with a reason;
the professional tool schema cannot request `auto` or `face` and will not fake a result.
