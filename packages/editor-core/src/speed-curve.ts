/**
 * Speed curves (schema v15, ADR 0090) — re-exported from `@framepilot/timeline-schema`.
 *
 * The arithmetic moved beside the schema in v22 so the v21 → v22 migration can map
 * legacy mask keyframes through a clip's speed ramp (ADR 0178). This module keeps every
 * existing `editor-core` import path working; the implementation and its parity
 * contract with `engine/python/framepilot_engine/effects/speed_curve.py` are unchanged.
 */
export * from '@framepilot/timeline-schema/speed-curve';
