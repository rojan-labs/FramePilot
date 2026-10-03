"""Canonical perceptual gate thresholds, mirrored from the TS side.

FramePilot judges "is this render watchable" twice, on two different signals:

* the **pre-encode composite**, frame by frame, while the agent run can still act on a
  defect (``packages/ai-sdk/src/temporal-review.ts``);
* the **encoded deliverable**, once, to refuse shipping a broken export
  (:mod:`framepilot_engine.validation.render_validation`).

The two legitimately hold different numbers — a PCM sum above 0 dBFS has overflowed, while a
correct AAC decode routinely measures a few tenths over — but they must not hold them
independently, which is how they came to look contradictory in a captured run (a review
failing an audio window the exporter would have passed, with nothing explaining why).

``packages/ai-sdk/src/perceptual-thresholds.ts`` is the source of truth for the whole table;
``tests/test_perceptual_thresholds_parity.py`` reads it and fails if these drift from it.
"""

from __future__ import annotations

#: Peak ceiling for the ENCODED deliverable, in dBFS. Above digital full scale on purpose:
#: ``volumedetect`` reads a lossy decode, where a clean master shows sub-dB inter-sample
#: overshoot, so a 0.0 gate rejects good files while +1.0 still catches real overflow.
EXPORT_MAX_AUDIO_DBFS = 1.0

#: Peak ceiling for the PRE-ENCODE composite, in dBFS (used by the agent-side temporal
#: review, kept here so the pair is visible in one place).
REVIEW_MAX_AUDIO_DBFS = -0.1

#: Fraction of the WHOLE render that may be black before the export fails. The deliverable
#: gate refuses an essentially-black programme; it must not reject a dark scene or a fade.
EXPORT_MAX_BLACK_RATIO = 0.95

#: Black ratio of a SINGLE sampled frame that the temporal review reports as a flash.
REVIEW_BLACK_FRAME_RATIO = 0.98

#: The quietest level an edit-boundary check counts as sound, in dBFS RMS. Each side of a
#: splice is raised to it before the jump is taken, so a fade-in's first frames are not a
#: step up from digital silence. Just under the quietest real background measured (room tone
#: and runway ambience at -58/-57 dBFS RMS); the TS table says why in full.
AUDIBLE_RMS_FLOOR_DBFS = -60.0

#: Seconds of a sound's first (last) moment that an entry from (exit into) silence is judged
#: by: a hard entry is at its level there, any real fade is still near silence.
AUDIO_ONSET_SECONDS = 0.01
