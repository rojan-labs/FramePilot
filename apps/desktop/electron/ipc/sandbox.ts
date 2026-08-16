/**
 * Path sandbox for the renderer-facing IPC handlers.
 *
 * WHY: the renderer is a web context (it loads `file://` media and AI-influenced
 * data). Before this, `projectOpen` / `projectSave` / `projectReveal` /
 * `renderExport` passed a renderer-supplied absolute path straight to the
 * filesystem, so a compromised renderer could read or overwrite arbitrary files
 * (Phase 8 security audit finding 1.1, PRD §18.1). Every such path now resolves
 * inside the FramePilot projects folder via the shared `resolveWithin` sandbox
 * (one implementation across desktop + MCP + engine). See ADR 0025.
 *
 * Out of scope: opening/saving a project at a user-chosen location *outside* the
 * projects folder should go through a main-process native dialog (a trusted
 * channel), not by letting the renderer hand us an arbitrary path. Tracked as a
 * follow-up in the security runbook.
 */
import { PathTraversalError, resolveWithin } from '@framepilot/shared-types/safety';

/** A guarded path, or a typed failure the IPC handlers surface as `{ ok: false }`. */
export type SandboxResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Resolve a renderer-supplied path inside the projects sandbox.
 *
 * @param projectsDir - The sandbox root (the default projects folder).
 * @param candidate - The untrusted path from the renderer.
 */
export function sandboxProjectPath(projectsDir: string, candidate: unknown): SandboxResult {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, error: 'Project path must be a non-empty string.' };
  }
  try {
    return { ok: true, path: resolveWithin(projectsDir, candidate) };
  } catch (error) {
    if (error instanceof PathTraversalError) {
      return { ok: false, error: 'Path is outside the FramePilot projects folder.' };
    }
    throw error;
  }
}
