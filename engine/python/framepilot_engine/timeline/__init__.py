"""Timeline data model and typed operations.

This subpackage is the Python half of the cross-language timeline schema (the TS
half lives in ``packages/timeline-schema``). Both are kept in sync via a shared
JSON Schema so the desktop UI and the render engine agree on the data model
(PRD §11, plan Phase 1).

* :mod:`framepilot_engine.timeline.models` — Project/Timeline/Track/Clip/Effect
  pydantic models + project file IO.
* :mod:`framepilot_engine.timeline.operations` — the typed, reversible edit
  operations that every patch is built from.
"""

from __future__ import annotations
