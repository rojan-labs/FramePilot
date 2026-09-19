/**
 * A registered-but-unavailable tool for tests.
 *
 * The registry used to carry one for real (`generate_mask`), and six suites leaned on it to
 * exercise the refusal PRD §23 requires: a tool whose engine does not exist is refused at
 * invocation, never faked. `create_mask` replaced it (plan 11, AM1.2), so the registry now has
 * no unavailable tool — and the refusal path still has to be proven. A suite mocks
 * `tool-registry.js`'s `getTool` with {@link getToolWithUnbuilt} to put this one back.
 */
import { unavailableTool } from '../domain-tools/tool-factories.js';
import type { ToolSpec } from '../tool-registry.js';

export const UNBUILT_TOOL_NAME = 'unbuilt_tool';

export const UNBUILT_TOOL: ToolSpec = unavailableTool(
  { name: UNBUILT_TOOL_NAME, description: 'A capability whose engine does not exist (test only).' },
  true,
);

/** `getTool`, with the unbuilt tool added to whatever the real registry resolves. */
export const getToolWithUnbuilt =
  (actual: (name: string) => ToolSpec | undefined) =>
  (name: string): ToolSpec | undefined =>
    name === UNBUILT_TOOL_NAME ? UNBUILT_TOOL : actual(name);
