import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginTranscriptionJob,
  failTranscriptionJob,
  finishTranscriptionJob,
  getTranscriptionJobsSnapshot,
  resetTranscriptionJobs,
  subscribeTranscriptionJobs,
} from './transcriptionJobs.js';

describe('transcription job state', () => {
  beforeEach(() => resetTranscriptionJobs());

  it('publishes running, recoverable error, and completion states', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTranscriptionJobs(listener);

    beginTranscriptionJob('clip-1', 'groq');
    expect(getTranscriptionJobsSnapshot().get('clip-1')).toMatchObject({
      kind: 'running',
      provider: 'groq',
    });

    failTranscriptionJob('clip-1', 'Network unavailable.');
    expect(getTranscriptionJobsSnapshot().get('clip-1')).toMatchObject({
      kind: 'error',
      message: 'Network unavailable.',
    });

    finishTranscriptionJob('clip-1');
    expect(getTranscriptionJobsSnapshot().has('clip-1')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
