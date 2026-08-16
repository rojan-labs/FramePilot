/**
 * The drag payload for a transition, and nothing else.
 *
 * This module used to hold a seven-entry list of transition kinds too. That list
 * is now `TRANSITION_CATALOG` in `@framepilot/timeline-schema/transition-catalog`
 * (ADR 0091) — pure data shared by the panel, the on-cut popover, the inspector,
 * the AI tool layer and both renderers, rather than a UI constant one component
 * happened to own.
 *
 * What is left is the DnD type, which genuinely is a UI fact: it is the handshake
 * between the panel's drag and the timeline's drop, and it belongs with neither.
 */

/**
 * DnD payload type for dragging a transition onto a cut in the timeline. The
 * dragged string is a transition catalog id, so the timeline resolves it through
 * the same builder every other route uses rather than receiving a built effect —
 * one source of truth for how a transition gets applied. Mirrors `ASSET_DND_TYPE`
 * from the media bin and `EFFECT_DND_TYPE` from the effects library.
 */
export const TRANSITION_DND_TYPE = 'application/x-framepilot-transition';
