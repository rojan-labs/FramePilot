/**
 * @framepilot/mcp-server — public surface.
 *
 * Exposes FramePilot's registered editing tools to external AI agents over the
 * Model Context Protocol. The legacy surface remains derived from TOOL_REGISTRY;
 * the optional autonomous surface is derived from the compact canonical manifest.
 */
export { resolveWithin, PathTraversalError } from './safety.js';
export {
  EditorSession,
  SessionError,
  sessionFromEnv,
  type SessionErrorCode,
  type RunToolResult,
  type SessionState,
} from './session.js';
export {
  RenderClient,
  RenderError,
  renderClientFromEnv,
  type RenderRequest,
} from './render-client.js';
export {
  AnalysisClient,
  AnalysisError,
  analysisClientFromEnv,
  type AnalysisArgs,
  type AnalysisToolName,
} from './analysis-client.js';
export {
  buildMcpTools,
  SESSION_TOOLS,
  getSessionTool,
  type McpToolDescriptor,
  type SessionToolDef,
} from './tools.js';
export {
  AUTONOMOUS_MCP_TOOL_NAMES,
  buildAutonomousMcpTools,
  callAutonomousTool,
} from './autonomous-tools.js';
export { callTool, type CallToolResult } from './dispatch.js';
export { createServer, type ServerDeps } from './server.js';
export { resolveHttpConfig, startHttpServer, type HttpConfig } from './http.js';
