/**
 * @framepilot/ai-sdk/kernel/beat-grid/beat-tool — the one name the beat guard, the payload
 * capture site, and the stage policy must all agree on.
 *
 * A leaf with no imports on purpose. The stage policy has to know which tool feeds the
 * beat-grid validator (see `kernel/stage-policy.ts#VALIDATOR_INPUT_TOOL_NAMES`), and the
 * guard has to know which payloads to file. Naming it in three string literals is how the
 * three drift; naming it here is how they cannot.
 */
export const BEAT_ANALYSIS_TOOL = 'detect_beats';
