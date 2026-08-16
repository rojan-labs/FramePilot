/* global process */
import { createInterface } from 'node:readline';

const scenario = process.argv[2] ?? 'success';
const lines = createInterface({ input: process.stdin });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'cancel') {
    process.stdout.write(`${JSON.stringify({
      type: 'failure',
      protocolVersion: 1,
      requestId: message.requestId,
      code: 'cancelled',
      detail: 'Cancelled by the host.',
      retryable: true,
    })}\n`);
    process.exit(0);
  }
  if (scenario === 'hang') return;
  if (scenario === 'malformed') {
    process.stdout.write('not-json\n');
    process.exit(0);
  }
  if (scenario === 'mismatch') message.projectRevision += 1;
  process.stdout.write(`${JSON.stringify({
    type: 'progress',
    protocolVersion: 1,
    requestId: message.requestId,
    phase: 'track',
    completed: 1,
    total: 1,
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    protocolVersion: 1,
    requestId: message.requestId,
    projectRevision: message.projectRevision,
    capability: message.capability,
    backend: 'fixture-tracker',
    modelDigests: {},
    samples: [{
      frame: message.media.firstFrame,
      box: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
      confidence: 0.95,
      occluded: false,
    }],
  })}\n`);
  process.exit(0);
});
