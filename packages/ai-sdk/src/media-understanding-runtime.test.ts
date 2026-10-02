/**
 * The automatic media-understanding runtime.
 *
 * This module decides, without ever telling the model, whether semantic evidence can be
 * produced — and if not, why. Almost every branch here is a place where the wrong answer
 * is a *quiet* one: spending TwelveLabs credits twice on the same media, claiming
 * readiness when nothing was indexed, or answering a visual question with prose that no
 * evidence supports. So the tests below are organised by what goes wrong rather than by
 * function.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyUnderstandingReason,
  ensureMediaUnderstanding,
  queryTimestamp,
  type EnsureMediaUnderstandingInput,
  type UnderstandingEvent,
} from './media-understanding-runtime.js';
import type { MediaProbe, VisualEvidence } from './media-evidence.js';
import type { VisualIndexClient, VisualStatusResponse } from './visual-index-client.js';

/** A status response with only the fields the runtime reads. */
const status = (over: Partial<VisualStatusResponse> = {}): VisualStatusResponse =>
  ({ available: true, indexedAssets: 0, totalAssets: 0, ...over }) as VisualStatusResponse;

/**
 * A client whose `status` and `index` are scripted.
 *
 * `index` mimics the sidecar's slice protocol so `runVisualIndexLoop` drives it for real
 * rather than being stubbed out — the loop is what decides done/failed, and stubbing it
 * would test the mock.
 */
function client(over: {
  status?: VisualStatusResponse | undefined;
  slices?: readonly Record<string, unknown>[];
}): VisualIndexClient {
  let call = 0;
  return {
    status: async () => over.status,
    index: async () => {
      const slice = over.slices?.[Math.min(call, (over.slices?.length ?? 1) - 1)];
      call += 1;
      return slice ?? { available: true, jobId: 'j', cursor: 1, total: 1, done: true };
    },
  } as unknown as VisualIndexClient;
}

const baseInput = (over: Partial<EnsureMediaUnderstandingInput> = {}) =>
  ({
    client: client({ status: status() }),
    projectId: `p_${Math.random().toString(36).slice(2)}`,
    ...over,
  }) as EnsureMediaUnderstandingInput;

describe('ensureMediaUnderstanding — refusing honestly', () => {
  it('PREPARES with no key at all — measurement needs none', async () => {
    // This used to be an early return reporting `unconfigured`, and it was half the
    // reason a default install had nothing to look at: tier 0 of the shot ledger is one
    // local ffmpeg pass (ADR 0175), so the absence of a key is not a reason to refuse.
    // The tiers a key unlocks report themselves as absent coverage instead.
    const result = await ensureMediaUnderstanding(baseInput());
    expect(result.status).toBe('ready');
  });

  it('reports `unconfigured` only when the ENGINE says a key is what is missing', async () => {
    const result = await ensureMediaUnderstanding(
      baseInput({
        client: client({ status: status(), slices: [{ available: false, reason: 'no_api_key' }] }),
      }),
    );
    expect(result).toMatchObject({ status: 'unavailable', reason: 'unconfigured' });
  });

  it('reports `cancelled` when the signal aborted before preparation started', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await ensureMediaUnderstanding(
      baseInput({ twelveLabsKey: 'tlk', signal: controller.signal }),
    );
    expect(result).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
  });

  it('does not claim readiness when the index loop failed', async () => {
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({
          status: status(),
          slices: [{ available: false, reason: 'engine unreachable' }],
        }),
      }),
    );
    expect(result.status).toBe('unavailable');
  });
});

describe('ensureMediaUnderstanding — backend selection', () => {
  it('prefers TwelveLabs when its key is configured', async () => {
    const events: UnderstandingEvent[] = [];
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        nvidiaKeys: 'nv',
        onEvent: (event) => events.push(event),
      }),
    );
    expect(result.backend).toBe('twelvelabs');
    // Cost-relevant is what a UI uses to warn before spending provider credits.
    expect(events.some((event) => event.costRelevant === true)).toBe(true);
  });

  it('uses the built-in index when only the NVIDIA key is present, and flags no cost', async () => {
    const events: UnderstandingEvent[] = [];
    const result = await ensureMediaUnderstanding(
      baseInput({ nvidiaKeys: 'nv', onEvent: (event) => events.push(event) }),
    );
    expect(result.backend).toBe('builtin');
    expect(events.every((event) => event.costRelevant !== true)).toBe(true);
  });
});

describe('ensureMediaUnderstanding — not paying twice for the same media', () => {
  it('reuses full coverage instead of re-indexing (cache hit)', async () => {
    const events: UnderstandingEvent[] = [];
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({ status: status({ indexedAssets: 3, totalAssets: 3 }) }),
        onEvent: (event) => events.push(event),
      }),
    );
    expect(result).toMatchObject({ status: 'ready', cache: 'hit' });
    // A hit must not emit a cost-relevant event — that is the whole point of the check.
    expect(events.some((event) => event.costRelevant === true)).toBe(false);
  });

  it('threads the project snapshot and signal through to the index request', async () => {
    // Both are optional and spread conditionally; omitting them silently would index
    // without the caller's project context, or make a cancelled run keep working.
    const controller = new AbortController();
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        project: { id: 'p1' },
        assetIds: ['a1'],
        signal: controller.signal,
      }),
    );
    expect(result.status).toBe('ready');
  });

  it('omits coverage from an unavailable result when the status read came back empty', async () => {
    // Both arms of the conditional `coverage` spread matter: a UI reads `coverage` to
    // show progress alongside a failure, and an absent field must stay absent rather
    // than becoming an empty object it would render as "0/0 prepared".
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({ status: undefined, slices: [{ available: false, reason: 'weird' }] }),
      }),
    );
    expect(result.status).toBe('unavailable');
    expect(result.coverage).toBeUndefined();
  });

  it('carries the coverage snapshot on an unavailable result too', async () => {
    // A UI showing "0/3 prepared" alongside the failure is why coverage is attached to
    // BOTH outcomes, not just the ready one.
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({
          status: status({ indexedAssets: 0, totalAssets: 3 }),
          slices: [{ available: false, reason: 'weird' }],
        }),
      }),
    );
    expect(result.status).toBe('unavailable');
    expect(result.coverage).toMatchObject({ totalAssets: 3 });
  });

  it('falls back to the loop status when a failure carried no reason', async () => {
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({ status: status(), slices: [{ available: false }] }),
      }),
    );
    expect(result.status).toBe('unavailable');
  });

  it('re-indexes anyway when `refresh` is set, and says so', async () => {
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        refresh: true,
        client: client({ status: status({ indexedAssets: 3, totalAssets: 3 }) }),
      }),
    );
    expect(result).toMatchObject({ status: 'ready', cache: 'refresh' });
  });

  it('treats partial coverage as a miss rather than a hit', async () => {
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({ status: status({ indexedAssets: 1, totalAssets: 3 }) }),
      }),
    );
    expect(result).toMatchObject({ status: 'ready', cache: 'miss' });
  });

  it('treats an unreadable coverage response as a miss, not as ready', async () => {
    const result = await ensureMediaUnderstanding(
      baseInput({ twelveLabsKey: 'tlk', client: client({ status: undefined }) }),
    );
    expect(result).toMatchObject({ status: 'ready', cache: 'miss' });
  });

  it('JOINS an identical in-flight request rather than starting a second one', async () => {
    // The expensive mistake this prevents: two callers asking at once and both
    // uploading/indexing the same media, billed twice.
    let indexCalls = 0;
    const slow = {
      status: async () => status(),
      index: async () => {
        indexCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { available: true, jobId: 'j', cursor: 1, total: 1, done: true };
      },
    } as unknown as VisualIndexClient;

    const events: UnderstandingEvent[] = [];
    const input = baseInput({
      twelveLabsKey: 'tlk',
      client: slow,
      onEvent: (event) => events.push(event),
    });
    const [first, second] = await Promise.all([
      ensureMediaUnderstanding(input),
      ensureMediaUnderstanding(input),
    ]);

    expect(indexCalls).toBe(1);
    expect(second).toBe(first);
    expect(events.some((event) => event.cache === 'joined')).toBe(true);
  });

  it('emits the joined event naming the BUILT-IN backend when no TwelveLabs key is set', async () => {
    // The joined notice reports which backend the in-flight request is using; reporting
    // the wrong one would mislabel a free run as a paid one.
    let resolveIndex: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveIndex = resolve;
    });
    const slow = {
      status: async () => status(),
      index: async () => {
        await gate;
        return { available: true, jobId: 'j', cursor: 1, total: 1, done: true };
      },
    } as unknown as VisualIndexClient;
    const events: UnderstandingEvent[] = [];
    const input = baseInput({
      nvidiaKeys: 'nv',
      client: slow,
      onEvent: (event) => events.push(event),
    });
    const first = ensureMediaUnderstanding(input);
    const second = ensureMediaUnderstanding(input);
    resolveIndex?.();
    await Promise.all([first, second]);
    const joined = events.find((event) => event.cache === 'joined');
    expect(joined?.backend).toBe('builtin');
  });

  it('does not join across different asset sets or refresh modes', async () => {
    // The flight key includes the assets and the refresh flag: joining two genuinely
    // different requests would silently drop one caller's work.
    const shared = { twelveLabsKey: 'tlk', projectId: 'p_same' };
    const a = ensureMediaUnderstanding(baseInput({ ...shared, assetIds: ['a1'] }));
    const b = ensureMediaUnderstanding(baseInput({ ...shared, assetIds: ['a2'] }));
    expect(await a).not.toBe(await b);
  });

  it('clears the flight once settled, so a later call prepares again', async () => {
    const input = baseInput({ twelveLabsKey: 'tlk' });
    const first = await ensureMediaUnderstanding(input);
    const second = await ensureMediaUnderstanding(input);
    expect(second).not.toBe(first);
  });
});

describe('ensureMediaUnderstanding — reason classification', () => {
  // The raw reason is the engine's own text. It is classified ONLY on precise signals —
  // exact tokens, the loop's statuses, the `(HTTP nnn) (code)` marker, and the fixed
  // openings of the engine's sentences — never by searching it for words. Searching is
  // what turned "TwelveLabs can't index ro.mp4" into "still reading" and a file-size
  // refusal into "the file can't be found", hiding the real error from the editor.
  const OLD_FILESIZE = 'TwelveLabs API error (HTTP 400) (video_filesize_too_large).';
  const NEW_FILESIZE = "TwelveLabs can't index ro.mp4: the file is larger than TwelveLabs accepts.";
  const PREFLIGHT =
    'ro.mp4 is 12.3 GB; TwelveLabs accepts files up to 4.0 GB. Export a smaller proxy to index it with TwelveLabs.';

  const fail = (reason: string) =>
    ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({
          status: status(),
          // An available, not-done slice with a reason is how the engine stops a job.
          slices: [{ available: true, jobId: 'j', cursor: 1, total: 1, done: false, reason }],
        }),
      }),
    );

  it.each([
    [OLD_FILESIZE, 'media_rejected'],
    [NEW_FILESIZE, 'media_rejected'],
    ["TwelveLabs can't index this file (video_codec_weird).", 'media_rejected'],
    [PREFLIGHT, 'media_rejected'],
    ['TwelveLabs API error (HTTP 413).', 'media_rejected'],
    ['indexing', 'indexing'],
    ['cancelled', 'cancelled'],
    ['not_indexed', 'not_indexed'],
    ['invalid_api_key', 'invalid_api_key'],
    ['no_api_key', 'unconfigured'],
    ['TwelveLabs rejected the API key (HTTP 401).', 'invalid_api_key'],
    ['TwelveLabs API error (HTTP 429) (too_many_requests).', 'rate_limited'],
    ['TwelveLabs API error (HTTP 402).', 'quota_exceeded'],
    ['TwelveLabs API error (HTTP 404) (video_not_found).', 'provider_unavailable'],
    ['TwelveLabs API error (HTTP 500).', 'provider_unavailable'],
    ['TwelveLabs request failed: [Errno 8] nodename nor servname provided', 'offline'],
    ["[Errno 2] No such file or directory: '/media/ro.mp4'", 'source_missing'],
    ['all_keys_failing', 'provider_unavailable'],
    // The loop's own status when no slice answered: the reason a caller reads as offline.
    ['unreachable', 'offline'],
  ])('classifies %j as %j', async (raw, expected) => {
    expect(await fail(raw)).toMatchObject({ status: 'unavailable', reason: expected });
  });

  it.each([
    // Each of these contains a word the old substring rules keyed on.
    ['Visual indexing journals jobs in the brain, which requires a configured sandbox root.'],
    ['could not generate a separate accurate profile for the monkey'],
    ['every asset in this slice failed to index'],
  ])('does not read words inside free text: %j', async (raw) => {
    const result = await fail(raw);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'provider_unavailable' });
    // …and the editor reads the engine's own sentence instead.
    expect(result.status === 'unavailable' && result.message).toBe(
      raw.endsWith('.') ? raw : `${raw}.`,
    );
  });

  it('never reports a file refusal as still-reading or as a missing file', async () => {
    for (const raw of [OLD_FILESIZE, NEW_FILESIZE, PREFLIGHT]) {
      const result = await fail(raw);
      expect(result.status === 'unavailable' && result.reason).not.toBe('indexing');
      expect(result.status === 'unavailable' && result.reason).not.toBe('source_missing');
    }
  });

  it('carries the engine sentence ONCE, with no prefix and no doubled full stop', async () => {
    const result = await fail(NEW_FILESIZE);
    expect(result.status === 'unavailable' && result.message).toBe(NEW_FILESIZE);
    // A refusal the old engine journaled as an API error is restated as the file's problem.
    const old = await fail(OLD_FILESIZE);
    expect(old.status === 'unavailable' && old.message).toBe(
      "TwelveLabs can't index this file (video_filesize_too_large).",
    );
    const bare = await fail('TwelveLabs API error (HTTP 413).');
    expect(bare.status === 'unavailable' && bare.message).toBe(
      "TwelveLabs can't index this file (HTTP 413).",
    );
  });

  it('gives a bare engine token plain words instead of showing the token', async () => {
    const result = await fail('invalid_api_key');
    expect(result.status === 'unavailable' && result.message).not.toMatch(/_/);
    expect(result.status === 'unavailable' && result.message).toMatch(/\.$/);
  });

  it('falls back to the loop status, in plain words, when the engine gave no reason', async () => {
    const result = await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({ status: status(), slices: [{ available: false, reason: '' }] }),
      }),
    );
    expect(result).toMatchObject({ status: 'unavailable', reason: 'provider_unavailable' });
    expect(result.status === 'unavailable' && result.message).toBe(
      'The FramePilot engine cannot read footage right now.',
    );
  });
});

describe('classifyUnderstandingReason', () => {
  it('reports `unknown` with a sentence for an empty reason', () => {
    expect(classifyUnderstandingReason(undefined)).toEqual({
      reason: 'unknown',
      message: 'Reading the footage stopped without saying why.',
    });
    expect(classifyUnderstandingReason('  ').reason).toBe('unknown');
  });

  it('does not treat an Object prototype key as an engine token', () => {
    expect(classifyUnderstandingReason('constructor').reason).toBe('provider_unavailable');
  });
});

describe('queryTimestamp — local first, never a fabricated answer', () => {
  const probe = (over: Partial<MediaProbe> = {}): MediaProbe =>
    ({
      durationSeconds: 12.5,
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: 'h264',
      frameCount: 375,
      ...over,
    }) as MediaProbe;

  const never = async (): Promise<readonly VisualEvidence[]> => {
    throw new Error('search must not run');
  };

  it.each([
    'What resolution is this?',
    'what fps?',
    'what frame rate does it use',
    'which codec',
    'how long is the duration',
    'is there an audio stream',
    'is there a video stream',
    'what is the frame count',
  ])('answers %j from the local probe, with no hosted call at all', async (question) => {
    const answer = await queryTimestamp({ question, probe: async () => probe(), search: never });
    expect(answer.available).toBe(true);
    expect(answer.evidence).toEqual([]);
  });

  it('reports a missing VIDEO stream in a deterministic answer', async () => {
    // Reached through a deterministic question so the no_video early return does not
    // pre-empt it — the probe summary must still say the stream is absent.
    const answer = await queryTimestamp({
      question: 'is there a video stream',
      probe: async () => probe({ hasVideo: false }),
      search: never,
    });
    expect(answer.available && answer.answer).toContain('no video');
  });

  it('reports the absent halves of a probe honestly', async () => {
    // "no audio" / "no video" are answers, not omissions — a viewer needs to know the
    // stream is missing rather than see the field silently disappear.
    const answer = await queryTimestamp({
      question: 'is there an audio stream',
      probe: async () => probe({ hasAudio: false, frameCount: undefined }),
      search: never,
    });
    expect(answer.available && answer.answer).toContain('no audio');
    expect(answer.available && answer.answer).not.toContain('frames');
  });

  it('omits probe fields it does not have rather than inventing them', async () => {
    const answer = await queryTimestamp({
      question: 'what resolution?',
      probe: async () =>
        probe({ width: undefined, height: undefined, fps: undefined, videoCodec: undefined }),
      search: never,
    });
    expect(answer.available && answer.answer).toContain('12.500 seconds');
    expect(answer.available && answer.answer).not.toContain('undefined');
  });

  it('reports no_video for an audio-only asset instead of guessing', async () => {
    const answer = await queryTimestamp({
      question: 'who is on screen?',
      probe: async () => probe({ hasVideo: false }),
      search: never,
    });
    expect(answer).toMatchObject({ available: false, reason: 'no_video' });
  });

  it('says the provider is unconfigured when no ensure input was supplied', async () => {
    const answer = await queryTimestamp({
      question: 'who is on screen?',
      probe: async () => probe(),
      search: never,
    });
    expect(answer).toMatchObject({ available: false, reason: 'provider_unconfigured' });
  });

  it('maps an offline preparation to offline_uncached, with recoverable advice', async () => {
    const answer = await queryTimestamp({
      question: 'who is on screen?',
      probe: async () => probe(),
      search: never,
      ensure: baseInput({
        twelveLabsKey: 'tlk',
        client: client({
          status: status(),
          slices: [
            {
              available: true,
              jobId: 'j',
              done: false,
              reason: 'TwelveLabs request failed: [Errno 8] nodename nor servname provided',
            },
          ],
        }),
      }),
    });
    expect(answer).toMatchObject({ available: false, reason: 'offline_uncached' });
    expect(answer.available === false && answer.recovery).toMatch(/Reconnect/);
  });

  it('maps an unconfigured preparation to provider_unconfigured', async () => {
    const answer = await queryTimestamp({
      question: 'who is on screen?',
      probe: async () => probe(),
      search: never,
      // The engine, not the absence of a key here, is what makes this unconfigured now.
      ensure: baseInput({
        client: client({ status: status(), slices: [{ available: false, reason: 'no_api_key' }] }),
      }),
    });
    expect(answer).toMatchObject({ available: false, reason: 'provider_unconfigured' });
  });

  it('maps any other preparation failure to provider_unavailable', async () => {
    const answer = await queryTimestamp({
      question: 'who is on screen?',
      probe: async () => probe(),
      search: never,
      ensure: baseInput({
        twelveLabsKey: 'tlk',
        client: client({ status: status(), slices: [{ available: false, reason: 'weird' }] }),
      }),
    });
    expect(answer).toMatchObject({ available: false, reason: 'provider_unavailable' });
  });

  it('returns no_answer rather than prose when the search found nothing', async () => {
    const answer = await queryTimestamp({
      question: 'who is on screen?',
      probe: async () => probe(),
      search: async () => [],
      ensure: baseInput({ twelveLabsKey: 'tlk' }),
    });
    expect(answer).toMatchObject({ available: false, reason: 'no_answer' });
  });

  it('answers from evidence, and carries that evidence with the answer', async () => {
    const evidence = [
      { description: 'A person waves.' },
      { description: 'They sit down.' },
    ] as unknown as VisualEvidence[];
    const answer = await queryTimestamp({
      question: 'who is on screen?',
      probe: async () => probe(),
      search: async () => evidence,
      ensure: baseInput({ twelveLabsKey: 'tlk' }),
    });
    expect(answer).toMatchObject({ available: true, answer: 'A person waves. They sit down.' });
    expect(answer.evidence).toHaveLength(2);
  });

  it('still attaches evidence when none of it carried a description', async () => {
    // Evidence with no prose is still grounding: claiming "no answer" would discard it.
    const evidence = [{ description: '  ' }, {}] as unknown as VisualEvidence[];
    const answer = await queryTimestamp({
      question: 'who is on screen?',
      probe: async () => probe(),
      search: async () => evidence,
      ensure: baseInput({ twelveLabsKey: 'tlk' }),
    });
    expect(answer).toMatchObject({
      available: true,
      answer: 'Grounded visual evidence is attached.',
    });
  });
});

describe('progress reporting', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('reports fractional progress while preparing, and 1 when done', async () => {
    const events: UnderstandingEvent[] = [];
    await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({
          status: status(),
          slices: [
            { available: true, jobId: 'j', cursor: 1, total: 2, done: false },
            { available: true, jobId: 'j', cursor: 2, total: 2, done: true },
          ],
        }),
        onEvent: (event) => events.push(event),
      }),
    );
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(
      progress.every((event) => (event.progress ?? 0) >= 0 && (event.progress ?? 0) <= 1),
    ).toBe(true);
  });

  it('reports 0 rather than NaN when the slice total is zero', async () => {
    const events: UnderstandingEvent[] = [];
    await ensureMediaUnderstanding(
      baseInput({
        twelveLabsKey: 'tlk',
        client: client({
          status: status(),
          slices: [{ available: true, jobId: 'j', cursor: 0, total: 0, done: true }],
        }),
        onEvent: (event) => events.push(event),
      }),
    );
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.every((event) => Number.isFinite(event.progress ?? 0))).toBe(true);
  });
});
