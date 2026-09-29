/**
 * `measure_loudness`: the window a call measures, the engine request it sends, and the reading
 * the model gets back — every figure off the engine, every gap with the move that closes it.
 */
import { describe, expect, it } from 'vitest';
import {
  MeasureLoudnessArgsSchema,
  interpretLoudness,
  loudnessRefusal,
  loudnessRequest,
  loudnessWindow,
} from './loudness-measurement.js';
import { createSidecarExecutor } from './sidecar-executor.js';
import { makeProject } from './__fixtures__/project.js';
import { getTool } from './tool-registry.js';
import { toolDomain } from './tool-domains.js';

/** 0–10 s at 30 fps: 300 frames, revision 0. */
const project = makeProject();

const SETTINGS = {
  identity: 'temporal-evidence:1920x1080@30:captions=true',
  presetId: 'temporal-evidence',
  width: 1920,
  height: 1080,
  fps: 30,
  burnCaptions: true,
};

/** An engine batch holding one loudness result, exactly as `/review/temporal-evidence` answers. */
function batch(
  sample: Record<string, number | null>,
  requestId = 'measure_loudness__mix',
): Record<string, unknown> {
  return {
    renderSettings: SETTINGS,
    results: [
      {
        schemaVersion: 1,
        requestId,
        projectRevision: 0,
        kind: 'loudness',
        renderSettings: SETTINGS,
        sample,
      },
    ],
  };
}

function window(args: Record<string, unknown> = {}) {
  const resolved = loudnessWindow(project, MeasureLoudnessArgsSchema.parse(args));
  if ('refusal' in resolved) throw new Error(resolved.refusal);
  return resolved;
}

function read(sample: Record<string, number | null>, args: Record<string, unknown> = {}) {
  const parsed = MeasureLoudnessArgsSchema.parse(args);
  const outcome = interpretLoudness(batch(sample), 'measure_loudness__mix', window(args), parsed);
  expect(outcome.status).toBe('completed');
  return outcome.data as Record<string, unknown> & { reading: string };
}

describe('the window a call measures', () => {
  it('is the whole timeline by default, as the mix', () => {
    expect(window()).toEqual({
      role: 'mix',
      startFrame: 0,
      endFrame: 300,
      fps: 30,
      projectRevision: 0,
    });
  });

  it('rounds a range outwards and holds its end to the last frame', () => {
    expect(window({ startSeconds: 2.01, endSeconds: 99, role: 'music' })).toMatchObject({
      role: 'music',
      startFrame: 60,
      endFrame: 300,
    });
  });

  it('sends one loudness request on that window, with no judgement attached', () => {
    expect(loudnessRequest(window({ role: 'dialogue' }), 'id')).toEqual({
      schemaVersion: 1,
      requestId: 'id',
      projectRevision: 0,
      kind: 'loudness',
      startFrame: 0,
      endFrame: 300,
      channels: 'dialogue',
      reason: 'Measure the dialogue loudness',
    });
  });

  it('refuses an empty timeline and a range past its end, with the remedy', () => {
    const empty = makeProject({
      timeline: { ...project.timeline, tracks: [{ id: 'v', type: 'video', clips: [] }] },
    } as never);
    expect(loudnessRefusal(empty, {})).toMatch(/timeline is empty/);
    expect(loudnessRefusal(project, { startSeconds: 12 })).toMatch(
      /ends at 10s\. Leave startSeconds and endSeconds out/,
    );
    expect(loudnessRefusal(project, { targetLufs: 3 })).toMatch(
      /Cannot measure loudness: targetLufs/,
    );
    expect(loudnessRefusal(project, {})).toBeUndefined();
  });
});

describe('the reading', () => {
  it('reports every figure the engine measured, true peak and sample peak apart', () => {
    const data = read({
      integratedLufs: -17.24,
      loudnessRangeLu: 6.1,
      truePeakDbfs: -3.42,
      samplePeakDbfs: -3.9,
    });
    expect(data).toMatchObject({
      role: 'mix',
      startSeconds: 0,
      endSeconds: 10,
      integratedLufs: -17.24,
      loudnessRangeLu: 6.1,
      truePeakDbtp: -3.42,
      samplePeakDbfs: -3.9,
    });
    expect(data.reading).toContain(
      'integrated -17.2 LUFS, loudness range 6.1 LU, true peak -3.4 dBTP, sample peak -3.9 dBFS',
    );
    expect(data.reading).toContain('4× oversampled');
    // No target was stated, so nothing is judged.
    expect(data.reading).not.toMatch(/target|ceiling/);
    expect(data).not.toHaveProperty('gapLu');
  });

  it('names the gain move that closes a gap under the target, and what it does to the peak', () => {
    const data = read(
      { integratedLufs: -17.2, loudnessRangeLu: 6, truePeakDbfs: -3.4, samplePeakDbfs: -3.9 },
      { targetLufs: -14, maxTruePeakDbtp: -1 },
    );
    expect(data.gapLu).toBe(3.2);
    expect(data.reading).toContain('3.2 LU under the -14 LUFS target');
    expect(data.reading).toContain('its current gain +3.2 dB');
    expect(data.reading).toMatch(/adjust_audio gainDb is absolute/);
    // Normalize is the move a model reaches for, and it does not do this.
    expect(data.reading).toMatch(/level normalize sets a clip's PEAK/);
    // -3.4 + 3.2 = -0.2 dBTP, over the -1 ceiling: compress before raising.
    expect(data.reading).toContain('about -0.2 dBTP, over the -1 dBTP ceiling');
    expect(data.reading).toMatch(/professional_audio compress/);
    expect(data.reading).toContain('True peak is within the -1 dBTP ceiling (2.4 dB under)');
  });

  it('says a mix inside the tolerance is on target, and lowers one that is over', () => {
    expect(read({ integratedLufs: -14.6 }, { targetLufs: -14 }).reading).toContain(
      'On target: -0.6 LU from -14 LUFS',
    );
    const hot = read({ integratedLufs: -11, truePeakDbfs: -0.2 }, { targetLufs: -14 }).reading;
    expect(hot).toContain('3 LU over the -14 LUFS target');
    expect(hot).toContain('lower every sounding track by 3 dB');
    expect(hot).toContain('its current gain -3 dB');
  });

  it('flags a true peak over the ceiling, and a mix that goes over full scale', () => {
    const reading = read(
      { integratedLufs: -14, truePeakDbfs: 0.1, samplePeakDbfs: 3.5 },
      { maxTruePeakDbtp: -1 },
    ).reading;
    expect(reading).toContain('True peak 0.1 dBTP is 1.1 dB over the -1 dBTP ceiling');
    expect(reading).toContain('The mix goes 3.5 dB over full scale before the export clips it');
  });

  it('calls a silent range silent rather than asking for +56 dB of gain', () => {
    const reading = read({ integratedLufs: -70 }, { targetLufs: -14 }).reading;
    expect(reading).toMatch(/silent — nothing above the -70 LUFS gate/);
    expect(reading).not.toMatch(/adjust_audio|LU under/);
  });

  it('fails honestly on an answer that is not a loudness result', () => {
    const args = MeasureLoudnessArgsSchema.parse({});
    expect(interpretLoudness({}, 'measure_loudness__mix', window(), args).status).toBe('failed');
    expect(
      interpretLoudness(
        batch({ integratedLufs: -20 }, 'someone_else'),
        'measure_loudness__mix',
        window(),
        args,
      ),
    ).toMatchObject({ status: 'failed', summary: expect.stringContaining('no loudness result') });
  });
});

describe('measure_loudness on the sidecar executor', () => {
  it('posts the working project to the temporal-evidence route and settles the reading', async () => {
    let seen: { url: string; body: Record<string, unknown> } = { url: '', body: {} };
    const executor = createSidecarExecutor({
      baseUrl: 'http://x',
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        seen = {
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        return {
          ok: true,
          status: 200,
          json: async () =>
            batch({ integratedLufs: -20, truePeakDbfs: -18, samplePeakDbfs: -18.5 }),
          text: async () => '',
        } as Response;
      }) as typeof fetch,
    });
    const outcome = await executor.run(
      { id: 'c1', name: 'measure_loudness', arguments: { targetLufs: -14 } },
      { project },
    );
    expect(seen.url).toBe('http://x/review/temporal-evidence');
    expect(seen.body.requests).toEqual([
      expect.objectContaining({ kind: 'loudness', channels: 'mix', startFrame: 0, endFrame: 300 }),
    ]);
    expect(outcome).toMatchObject({
      status: 'completed',
      summary: 'Measured mix loudness: -20 LUFS, true peak -18 dBTP',
      data: { integratedLufs: -20, gapLu: 6 },
    });
  });

  it('answers a range past the end without reaching the engine', async () => {
    let called = false;
    const executor = createSidecarExecutor({
      baseUrl: 'http://x',
      fetchFn: (async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }) as typeof fetch,
    });
    const outcome = await executor.run(
      { id: 'c1', name: 'measure_loudness', arguments: { startSeconds: 40 } },
      { project },
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('ends at 10s'),
    });
    expect(called).toBe(false);
  });
});

describe('measure_loudness in the registry', () => {
  it('is a host-run read in the audio domain', () => {
    const tool = getTool('measure_loudness');
    expect(tool).toMatchObject({ kind: 'analysis', mutates: false, hostUiOnly: true });
    expect(toolDomain('measure_loudness')).toBe('audio');
  });
});
