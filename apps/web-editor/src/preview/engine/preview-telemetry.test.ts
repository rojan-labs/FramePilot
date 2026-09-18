import { describe, expect, it } from 'vitest';
import { PreviewTelemetry, percentile } from './preview-telemetry.js';

const FPS = 30;
const at = (frame: number, phase = 0.5): number => (frame + phase) / FPS;

describe('percentile', () => {
  it('is nearest-rank and 0 without samples', () => {
    expect(percentile([], 0.95)).toBe(0);
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 0.95)).toBe(95);
    expect(percentile(samples, 0.99)).toBe(99);
    expect(percentile([7], 0.99)).toBe(7);
  });
});

describe('PreviewTelemetry dropped-frame accounting', () => {
  it('counts nothing dropped when every due frame is presented', () => {
    const telemetry = new PreviewTelemetry();
    telemetry.playbackStarted(FPS);
    for (let frame = 10; frame < 40; frame++) telemetry.tick(at(frame), true);
    telemetry.playbackStopped();
    const { playback } = telemetry.snapshot();
    expect(playback).toMatchObject({ expectedFrames: 30, presentedFrames: 30, droppedFrames: 0 });
    expect(playback.droppedShare).toBe(0);
  });

  it('does not count a 60 Hz display showing each 30 fps frame twice as new frames', () => {
    const telemetry = new PreviewTelemetry();
    telemetry.playbackStarted(FPS);
    for (let frame = 0; frame < 20; frame++) {
      telemetry.tick(at(frame, 0.1), true);
      telemetry.tick(at(frame, 0.6), true);
    }
    telemetry.playbackStopped();
    expect(telemetry.snapshot().playback).toMatchObject({
      expectedFrames: 20,
      presentedFrames: 20,
      droppedFrames: 0,
    });
  });

  it('counts an index the clock skipped as dropped', () => {
    const telemetry = new PreviewTelemetry();
    telemetry.playbackStarted(FPS);
    for (const frame of [0, 1, 2, 5, 6]) telemetry.tick(at(frame), true);
    telemetry.playbackStopped();
    expect(telemetry.snapshot().playback).toMatchObject({
      expectedFrames: 7,
      presentedFrames: 5,
      droppedFrames: 2,
    });
  });

  it('counts a frame that was never decoded in time as dropped, once the next one shows', () => {
    const telemetry = new PreviewTelemetry();
    telemetry.playbackStarted(FPS);
    telemetry.tick(at(0), true);
    telemetry.tick(at(1), false);
    telemetry.tick(at(2), false);
    telemetry.tick(at(3), true);
    telemetry.playbackStopped();
    const { playback } = telemetry.snapshot();
    expect(playback).toMatchObject({ expectedFrames: 4, presentedFrames: 2, droppedFrames: 2 });
    expect(playback.missingTicks).toBe(2);
    expect(playback.droppedShare).toBe(0.5);
  });

  it('a late decode that lands inside the same frame is not a drop', () => {
    const telemetry = new PreviewTelemetry();
    telemetry.playbackStarted(FPS);
    telemetry.tick(at(0, 0.1), false);
    telemetry.tick(at(0, 0.6), true);
    telemetry.playbackStopped();
    expect(telemetry.snapshot().playback).toMatchObject({
      expectedFrames: 1,
      droppedFrames: 0,
      missingTicks: 1,
    });
  });

  it('counts frames still missing when playback stops, and reports them mid-run too', () => {
    const telemetry = new PreviewTelemetry();
    telemetry.playbackStarted(FPS);
    telemetry.tick(at(0), true);
    telemetry.tick(at(1), false);
    telemetry.tick(at(2), false);
    expect(telemetry.snapshot().playback.droppedFrames).toBe(2);
    telemetry.playbackStopped();
    expect(telemetry.snapshot().playback).toMatchObject({ expectedFrames: 3, droppedFrames: 2 });
  });

  it('accumulates across plays and forgets on reset', () => {
    const telemetry = new PreviewTelemetry();
    for (let run = 0; run < 2; run++) {
      telemetry.playbackStarted(FPS);
      for (const frame of [100, 102]) telemetry.tick(at(frame), true);
      telemetry.playbackStopped();
    }
    expect(telemetry.snapshot().playback).toMatchObject({ expectedFrames: 6, droppedFrames: 2 });
    telemetry.reset();
    expect(telemetry.snapshot().playback).toMatchObject({ expectedFrames: 0, droppedFrames: 0 });
  });

  it('ignores ticks outside playback', () => {
    const telemetry = new PreviewTelemetry();
    telemetry.tick(at(3), true);
    expect(telemetry.snapshot().playback.expectedFrames).toBe(0);
  });
});

describe('PreviewTelemetry channels and gauges', () => {
  it('summarises a channel and ignores values that are not durations', () => {
    const telemetry = new PreviewTelemetry();
    for (let ms = 1; ms <= 100; ms++) telemetry.record('composite', ms);
    telemetry.record('composite', Number.NaN);
    telemetry.record('composite', -1);
    expect(telemetry.snapshot().channels.composite).toEqual({
      count: 100,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });
  });

  it('keeps only the latest samples', () => {
    const telemetry = new PreviewTelemetry();
    for (let i = 0; i < 5000; i++) telemetry.record('frameInterval', i);
    const samples = telemetry.samples('frameInterval');
    expect(samples.length).toBe(4096);
    expect(samples[0]).toBe(5000 - 4096);
  });

  it('tracks a gauge peak, and a reset restarts the peak from the current value', () => {
    const telemetry = new PreviewTelemetry();
    telemetry.gauge('glPoolBytes', 100);
    telemetry.gauge('glPoolBytes', 400);
    telemetry.gauge('glPoolBytes', 250);
    expect(telemetry.snapshot().gauges.glPoolBytes).toEqual({ current: 250, peak: 400 });
    telemetry.reset();
    expect(telemetry.snapshot().gauges.glPoolBytes).toEqual({ current: 250, peak: 250 });
  });

  it('records load shedding', () => {
    const telemetry = new PreviewTelemetry();
    telemetry.renderScaleChanged(0.75);
    telemetry.renderScaleChanged(0.5);
    telemetry.renderScaleChanged(0.75);
    expect(telemetry.snapshot().playback).toMatchObject({
      renderScaleChanges: 3,
      lowestRenderScale: 0.5,
    });
  });
});
