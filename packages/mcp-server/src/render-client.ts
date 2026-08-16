/**
 * @framepilot/mcp-server/render-client — delegate render/export to the sidecar.
 *
 * WHY: the render engine is Python MoviePy + FFmpeg and MUST stay isolated from
 * any JS process (AGENTS.md "render-vs-preview" hard rule). The MCP host never
 * renders itself; the `render_preview` / `export_video` action tools POST to the
 * existing FastAPI sidecar (`FRAMEPILOT_PYTHON_API_URL`), which loads the saved
 * `project.fp.json` from disk, renders deterministically, and auto-validates the
 * output (PRD §9.4). `fetch` is injectable so this is unit-tested offline.
 */

/** Raised when the sidecar returns a non-2xx response. */
export class RenderError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

export interface RenderRequest {
  /** On-disk path of the saved project the sidecar should render. */
  readonly projectPath: string;
  /** Export preset id (see `render.presets`); omit for the engine default. */
  readonly preset?: string;
  /** Burn caption-track text into the output (PRD §6.2, plan 3.3). */
  readonly burnCaptions?: boolean;
  /** True for a fast low-res preview render; false for the final export. */
  readonly preview: boolean;
}

export class RenderClient {
  private readonly fetchFn: typeof fetch;

  /**
   * @param baseUrl - Sidecar base URL (e.g. `http://127.0.0.1:8765`).
   * @param fetchFn - Injectable `fetch` (defaults to the global) for testing.
   */
  public constructor(
    private readonly baseUrl: string,
    fetchFn: typeof fetch = fetch,
  ) {
    this.fetchFn = fetchFn;
  }

  /** Render a preview or final export; returns the sidecar's render-job JSON. */
  public async render(req: RenderRequest): Promise<unknown> {
    const route = req.preview ? '/render/preview' : '/render';
    const response = await this.fetchFn(`${this.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_path: req.projectPath,
        preset: req.preset ?? null,
        burn_captions: req.burnCaptions ?? false,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new RenderError(
        response.status,
        `Sidecar render request failed (${response.status}): ${detail}`,
      );
    }
    return response.json();
  }
}

/** Construct a {@link RenderClient} from the environment, if configured. */
export const renderClientFromEnv = (env: NodeJS.ProcessEnv = process.env): RenderClient | null => {
  const baseUrl = env.FRAMEPILOT_PYTHON_API_URL;
  return baseUrl ? new RenderClient(baseUrl) : null;
};
