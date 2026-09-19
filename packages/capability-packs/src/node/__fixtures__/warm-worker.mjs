/* global process */
// A fake warm Smart Mask worker (BR6.11): answers subject.segment_frame lines until stdin closes.
import { createInterface } from 'node:readline';

const scenario = process.argv[2] ?? 'success';
const lines = createInterface({ input: process.stdin });
let served = 0;
// A 1x1 gray PNG, base64: the client checks the schema; the desktop host decodes it strictly.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==';
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'cancel') {
    write({ type: 'failure', protocolVersion: 1, requestId: message.requestId, code: 'cancelled', detail: 'Cancelled.', retryable: true });
    return;
  }
  served += 1;
  if (scenario === 'hang') return;
  if (scenario === 'crash-second' && served === 2) process.exit(3);
  if (scenario === 'handshake') {
    write({ type: 'handshake', protocolVersion: 1 });
    return;
  }
  if (scenario === 'foreign') {
    write({ type: 'progress', protocolVersion: 1, requestId: 'somebody-else', phase: 'segment', completed: 0, total: 1 });
    return;
  }
  if (scenario === 'malformed') {
    process.stdout.write('{not json\n');
    return;
  }
  write({
    type: 'result',
    protocolVersion: 1,
    requestId: message.requestId,
    projectRevision: message.projectRevision,
    capability: 'subject.segment_frame',
    backend: 'fixture',
    modelDigests: {},
    pts: scenario === 'wrong-pts' ? message.parameters.pts + 1 : message.parameters.pts,
    width: 1,
    height: 1,
    maskPng: PNG,
    score: 0.9,
    // How many requests this one process has answered: the session reuses it.
    ...(scenario === 'success' ? {} : {}),
  });
  process.stderr.write(`served ${served}\n`);
});
