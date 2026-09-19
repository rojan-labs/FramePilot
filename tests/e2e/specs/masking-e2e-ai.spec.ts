/**
 * E2E.4 — AI masking through the sidebar (plan/background-removal-ai/07, E2E.4).
 *
 *   "blur the faces except the host" → the face picker (WHO is the editor's call) → turn face
 *   recognition on for the project → pick the guest → a blur limited to the guest's face →
 *   "put the title behind her" → ambiguous (two people): the sidebar asks → pick her → the
 *   background removed on her and the title put behind her → the review card → preview ==
 *   export → export.
 *
 * What is real: the sidebar and its picker, consent control and review card; the desktop AI
 * host path (`parseAiStreamRequest`, `runAiStream`, the event transport); the ai-sdk
 * orchestrator's agent loop with the real masking tools, the pick rule (a `pick.` id is usable
 * only from the editor's own message), the op builders and validation; the desktop masking
 * executor (detection windows, target resolution, candidate re-resolution, the matte job
 * through the matte IPC's scheduler path); face-recognition consent through the engine
 * sidecar's `/brain/identity` routes; the engine export.
 *
 * SIMULATED, and why (for RD3):
 *  - **The model.** A scripted policy, not an LLM (no live model calls in CI, and the point is
 *    the tool path, not the model's phrasing — the AM5 eval measures the resolution gates). It
 *    reads only the editor's message and what the tools returned: find, then stop and let the
 *    editor pick; on a pick message, mask exactly the ids the editor sent.
 *  - **Subject Intelligence.** No signed pack exists (MO-1..MO-5): detections are scripted boxes
 *    for a host (left) and a guest (right), the "recorded or synthetic pack output" the plan
 *    allows. The Smart Mask worker is the synthetic matte of `fake-desktop.ts`.
 *  - The sidecar's port: the renderer asks the engine at the desktop's default port; the page
 *    routes those `/brain/identity` calls to the CI sidecar. Electron and `fp-media://`.
 *
 * CI ONLY (`masking-e2e` job).
 */
import { expect, test, type Page } from '@playwright/test';
import { IdentityClient, Orchestrator } from '../../../packages/ai-sdk/dist/index.js';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  HostExecutionContext,
  HostToolExecutor,
} from '../../../packages/ai-sdk/dist/index.js';
import { masksOf, type Project } from '../../../packages/timeline-schema/dist/index.js';
import {
  parseAiStreamRequest,
  prepareAiEventForTransport,
  runAiStream,
} from '../../../apps/desktop/dist/ai/ai-stream.js';
import { createMaskingExecutor } from '../../../apps/desktop/dist/ai/masking-executor.js';
import type { FakeDesktop } from './masking/fake-desktop.js';
import { expectPreviewMatchesExport } from './masking/parity.js';
import {
  COLOURS,
  HEIGHT,
  WIDTH,
  attachDiagnostics,
  clip,
  clipsById,
  expectValidExport,
  openInDesktop,
  project,
  savedProject,
  sidecarUrl,
  video,
  type OpenedEditor,
} from './masking/session.js';
import { Workspace } from './masking/workspace.js';

const SECONDS = 2;
const NAME = 'E2E.4 AI masking';
const CLIP = 'clip_talk';
/** The engine port the renderer talks to on the desktop (`DEFAULT_ENGINE_BASE_URL`). */
const DESKTOP_ENGINE = 'http://127.0.0.1:8765';

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};
/** Who is in the shot, as the detector reports them (normalised boxes, still on every frame). */
const SCENE: readonly { readonly label: 'face' | 'person'; readonly box: Box }[] = [
  { label: 'face', box: { x: 0.2, y: 0.3, width: 0.12, height: 0.24 } }, // the host
  { label: 'person', box: { x: 0.12, y: 0.22, width: 0.3, height: 0.78 } },
  // The guest straddles the sentinel's top-right edge, so a blur on her face is visible.
  { label: 'face', box: { x: 0.6, y: 0.4, width: 0.12, height: 0.24 } },
  { label: 'person', box: { x: 0.52, y: 0.3, width: 0.3, height: 0.66 } },
];
const HOST_FACE = SCENE[0]!.box;
const GUEST_FACE = SCENE[2]!.box;

/** Subject Intelligence, stood in: the scene's boxes on every frame it is asked about. */
function scenePack() {
  const run = async (request: {
    capability: string;
    media?: { firstFrame: number; lastFrameExclusive: number };
  }) => {
    if (request.capability !== 'subject.detect') {
      return {
        status: 'failed',
        code: 'worker_failed',
        detail: 'Detection only.',
        retryable: false,
      };
    }
    const detections = [];
    for (
      let frame = request.media!.firstFrame;
      frame < request.media!.lastFrameExclusive;
      frame++
    ) {
      for (const thing of SCENE) {
        detections.push({ frame, label: thing.label, box: thing.box, confidence: 0.93 });
      }
    }
    return {
      status: 'completed',
      identity: {
        id: 'framepilot.subject-intelligence',
        version: '1.0.0',
        releaseDigest: 'e'.repeat(64),
      },
      result: { backend: 'e2e-scene', modelDigests: [], detections },
    };
  };
  return async () => ({ run }) as never;
}

interface Observed {
  /** The last `find_mask_targets` result of the run. */
  find?: Record<string, unknown>;
}

/** Keep what the tools returned, for the scripted model to read (as the AM5 harness does). */
function observing(executor: HostToolExecutor, observed: Observed): HostToolExecutor {
  return {
    run: async (call, ctx: HostExecutionContext, signal?: AbortSignal) => {
      const outcome = await executor.run(call, ctx, signal);
      if (call.name === 'find_mask_targets' && outcome.data !== undefined) {
        observed.find = outcome.data as Record<string, unknown>;
      }
      return outcome;
    },
  };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args,
});

/**
 * The scripted model. One instance per run; it reads the editor's message and the tool results.
 *
 * - A request: `find_mask_targets` with the editor's own words, then stop (the picker asks).
 * - A pick message ("… use pick.x (…)"): mask exactly the ids the editor sent — a blur for the
 *   faces request, a cut-out and the title for the "her" request.
 */
class ScriptedMaskingModel implements AiProvider {
  public readonly name = 'mock' as const;
  private step = 0;

  public constructor(
    private readonly prompt: string,
    private readonly observed: Observed,
  ) {}

  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    // A call with no tools on offer is the router asking what kind of turn this is (ADR 0055):
    // it is an edit.
    if ((request.tools?.length ?? 0) === 0) return { text: '{"route":"edit"}', toolCalls: [] };
    const step = this.step;
    this.step += 1;
    const picks = [...this.prompt.matchAll(/pick\.[A-Za-z0-9_]+/gu)].map((match) => match[0]);
    if (picks.length === 0) return this.request(step);
    return this.picked(step, picks);
  }

  private request(step: number): AiResponse {
    const description = /faces/u.test(this.prompt) ? 'the faces except the host' : 'her';
    if (step === 0) {
      return {
        text: '',
        toolCalls: [call('find', 'find_mask_targets', { clipId: CLIP, description })],
      };
    }
    const status = String(this.observed.find?.status ?? 'none');
    return {
      text: `The picker is showing the candidates (${status}). Pick who you mean.`,
      toolCalls: [],
    };
  }

  private picked(step: number, picks: readonly string[]): AiResponse {
    const blur = /faces/u.test(this.prompt);
    if (step === 0 && blur) {
      return {
        text: '',
        toolCalls: picks.map((candidateId, index) =>
          call(`blur_${String(index)}`, 'create_mask', {
            clipId: CLIP,
            candidateId,
            precision: 'shape',
            purpose: 'effect',
            effect: 'blur_to_hide',
            edge: 'soft',
            track: false,
          }),
        ),
      };
    }
    if (step === 0) {
      return {
        text: '',
        toolCalls: [call('cutout', 'remove_background', { clipId: CLIP, candidateId: picks[0] })],
      };
    }
    if (step === 1 && !blur) {
      return {
        text: '',
        toolCalls: [call('title', 'put_text_behind_subject', { clipId: CLIP, text: 'THE GUEST' })],
      };
    }
    return { text: 'Done. The review list says what needs a look.', toolCalls: [] };
  }
}

async function send(page: Page, message: string): Promise<void> {
  await page.getByLabel('Message FramePilot').fill(message);
  await page.getByLabel('Send').click();
}

const effectMasks = (document: Project) =>
  masksOf(clipsById(document).get(CLIP)!).filter((mask) => mask.target.kind === 'effect');
/** A mask's centre as a fraction of the picture (its geometry is in source pixels). */
const centreOf = (mask: Record<string, unknown>) => ({
  x: Number(mask.cx) / WIDTH,
  y: Number(mask.cy) / HEIGHT,
});
const inside = (point: { x: number; y: number }, box: Box) =>
  point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;

let opened: OpenedEditor | null = null;
test.afterEach(async ({}, testInfo) => {
  await attachDiagnostics(testInfo, opened);
  opened = null;
});

test('E2E.4 blur the faces except the host, put the title behind her, through the sidebar', async ({
  page,
}, testInfo) => {
  test.setTimeout(8 * 60_000);
  const workspace = await Workspace.create('e2e4-ai');
  await workspace.media([video('talk', 'green', SECONDS), video('bg', 'blue', SECONDS)]);
  await workspace.writeProject(
    project({
      id: 'e2e4_ai',
      name: NAME,
      videos: [
        { id: 'talk', seconds: SECONDS },
        { id: 'bg', seconds: SECONDS },
      ],
      tracks: [
        {
          id: 'video_2',
          type: 'video',
          clips: [clip('video_2', { id: CLIP, assetId: 'talk', start: 0, end: SECONDS })],
        },
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
        },
      ],
    }),
  );
  // Consent starts off, as it does for every project.
  const identity = new IdentityClient({ baseUrl: sidecarUrl() });
  await identity.deleteAll('e2e4_ai');
  expect((await identity.state('e2e4_ai')).consent).toBe(false);
  // The renderer's engine calls, answered by the CI sidecar (see the header).
  await page.route(`${DESKTOP_ENGINE}/brain/identity**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${sidecarUrl()}${url.pathname}${url.search}` });
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'access-control-allow-origin': '*' },
    });
  });

  const consentReads: boolean[] = [];
  let host: FakeDesktop | undefined;
  const executor = createMaskingExecutor({
    tracking: scenePack(),
    // The Smart Mask worker, stood in by the synthetic matte (see the header).
    matte: async () =>
      ({
        run: async (
          intent: Record<string, unknown>,
          context: { project: Project; projectRevision: number },
        ) =>
          host!.synthesiseMatte(intent, context.project, {
            shape: 'disc',
            foreground: COLOURS.green[0],
            projectRevision: context.projectRevision,
          }),
        cancel: () => undefined,
        activeJobIds: () => new Set<string>(),
        busyArtifactKeys: () => new Set<string>(),
      }) as never,
    activeProjectPath: async () => workspace.projectPath,
    evidence: {
      faceRecognitionConsent: async (live: Project) => {
        const consent = (await identity.state(live.id)).consent;
        consentReads.push(consent);
        return consent;
      },
    },
  });
  const prompts: string[] = [];
  opened = await openInDesktop(
    page,
    testInfo,
    {
      workspace,
      sidecarUrl: sidecarUrl(),
      // `main.ts`'s aiStreamStart, minus Electron: the host's working copy of the live project,
      // the real request parser, the real run and the real transport shaping.
      aiStream: async (request, emit, desktop) => {
        const parsed = parseAiStreamRequest({
          ...request,
          project: desktop.diskProject(request.project),
        });
        prompts.push(parsed.userPrompt ?? '');
        const observed: Observed = {};
        const orchestrator = new Orchestrator(
          new ScriptedMaskingModel(parsed.userPrompt ?? '', observed),
          { executor: observing(executor, observed) },
        );
        await runAiStream(
          orchestrator,
          parsed,
          async (event) => emit(prepareAiEventForTransport(event)),
          new AbortController().signal,
        );
      },
    },
    NAME,
  );
  host = opened.desktop;
  const { desktop } = opened;

  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  // Agent mode, the sidebar's default. "Plan first" drafts a plan before any tool runs; a
  // masking request goes straight to the tools, so the editor switches it off.
  await expect(page.getByRole('button', { name: 'AI mode' })).toContainText('Agent');
  const planFirst = page.getByRole('switch', { name: /^Plan first/ });
  if ((await planFirst.getAttribute('aria-checked')) === 'true') await planFirst.click();
  await expect(planFirst).toHaveAttribute('aria-checked', 'false');

  // ---- 1. "blur the faces except the host": WHO is the editor's call -------------------------
  await send(page, 'blur the faces except the host');
  const picker = page.getByRole('group', { name: 'choose the mask target', exact: true }).last();
  await expect(picker.getByText('Who should this apply to?')).toBeVisible({ timeout: 60_000 });
  const guestFace = picker.getByRole('button', { name: 'Pick the face at the right', exact: true });
  const hostFace = picker.getByRole('button', { name: 'Pick the face at the left', exact: true });
  await expect(hostFace).toBeVisible();
  await expect(guestFace).toBeEnabled({ timeout: 30_000 });
  // Nothing was masked on a guess.
  expect(effectMasks(desktop.saves.at(-1) ?? (await workspace.readProject()))).toHaveLength(0);

  // Face recognition: off until the editor turns it on, here, for this project.
  const consent = picker.getByRole('group', { name: 'face recognition for this project' });
  await consent.getByRole('button', { name: 'Turn on for this project', exact: true }).click();
  await expect(consent.getByText('Face recognition is on for this project.').first()).toBeVisible();
  expect((await identity.state('e2e4_ai')).consent).toBe(true);

  await guestFace.click();
  await expect(guestFace).toHaveAttribute('aria-pressed', 'true');
  await expect(hostFace).toHaveAttribute('aria-pressed', 'false');
  await picker.getByRole('button', { name: 'Use selected', exact: true }).click();

  const blurred = await savedProject(
    desktop,
    (document) => effectMasks(document).length === 1,
    'the face blur',
    60_000,
  );
  const [faceMask] = effectMasks(blurred);
  const talk = clipsById(blurred).get(CLIP)!;
  expect(talk.effects.filter((effect) => effect.type === 'blur')).toEqual([
    { id: `${CLIP}__blur`, type: 'blur', params: { amount: 0.04 }, keyframes: [] },
  ]);
  expect(faceMask!.target).toEqual({ kind: 'effect', effectId: `${CLIP}__blur` });
  // On the guest's face, not the host's.
  const centre = centreOf(faceMask as unknown as Record<string, unknown>);
  expect(inside(centre, GUEST_FACE)).toBe(true);
  expect(inside(centre, HOST_FACE)).toBe(false);
  // The pick reached the model only as the editor's own words. The resolution that asked read
  // consent from the engine while it was still off.
  expect(prompts[1]).toMatch(/use pick\.[A-Za-z0-9_]+ \(the face at the right\)/u);
  expect(consentReads).toEqual([false]);

  // ---- 2. "put the title behind her": two people, so it asks --------------------------------------
  await send(page, 'put the title behind her');
  const which = page.getByRole('group', { name: 'choose the mask target', exact: true }).last();
  await expect(which.getByText('Which one did you mean?')).toBeVisible({ timeout: 60_000 });
  // The next resolution reads the consent the editor gave, from the project brain.
  expect(consentReads.at(-1)).toBe(true);
  const her = which.getByRole('button', { name: 'Pick the person at the right', exact: true });
  await expect(her).toBeEnabled({ timeout: 30_000 });
  await expect(
    which.getByRole('button', { name: 'Pick the person at the left', exact: true }),
  ).toBeVisible();
  // Asking changed nothing.
  expect(desktop.saves.at(-1)!.timeline.tracks).toHaveLength(2);
  await her.click();

  const behind = await savedProject(
    desktop,
    (document) =>
      document.timeline.tracks.some((track) =>
        track.clips.some((entry) => entry.effects.some((effect) => effect.type === 'text')),
      ),
    'the title behind her',
    90_000,
  );
  const title = behind.timeline.tracks
    .flatMap((track) => track.clips)
    .find((entry) => entry.effects.some((effect) => effect.type === 'text'))!;
  expect(title.effects.find((effect) => effect.type === 'text')!.params).toMatchObject({
    text: 'THE GUEST',
  });
  const mattes = behind.timeline.tracks
    .flatMap((track) => track.clips)
    .flatMap((entry) => masksOf(entry))
    .filter((mask) => mask.kind === 'matte');
  expect(mattes.length).toBeGreaterThanOrEqual(1);
  // The cut-out was measured from the person the editor picked.
  expect(mattes[0]).toMatchObject({ prompts: [{ kind: 'candidate' }] });
  // The face blur is still there.
  expect(effectMasks(behind)).toHaveLength(1);

  // ---- 3. reviewed: the card says what needs a look and never claims "verified" ---------------------
  const review = page.getByRole('group', { name: 'mask review', exact: true }).last();
  await expect(review).toBeVisible();
  await expect(review).not.toContainText(/verified/i);

  // ---- 4. the monitor matches the export, and the export is valid ------------------------------------
  await expectPreviewMatchesExport(page, workspace, [0.5, 1.5], 'e2e4-ai', testInfo);
  expectValidExport(await workspace.export('ai-masking.mp4'), SECONDS);
});
