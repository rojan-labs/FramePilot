/* global process, Buffer */
// A stub warm Smart Mask worker for host tests and the hover-latency measurement (BR6.11):
// answers every subject.segment_frame line with a real 8-bit gray PNG of argv's preview size
// (a filled disc under the hover point), the shape the real worker returns.
import { deflateSync } from 'node:zlib';
import { createInterface } from 'node:readline';

const width = Number(process.argv[2] ?? 640);
const height = Number(process.argv[3] ?? 360);
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, body) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(typed));
  return Buffer.concat([length, typed, sum]);
};
const png = (cx, cy) => {
  const raw = Buffer.alloc((width + 1) * height);
  const r2 = (height / 4) ** 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) raw[y * (width + 1) + 1 + x] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'cancel') {
    process.stdout.write(`${JSON.stringify({ type: 'failure', protocolVersion: 1, requestId: message.requestId, code: 'cancelled', detail: 'Cancelled.', retryable: true })}\n`);
    return;
  }
  const point = message.parameters.hoverPoint ?? message.parameters.points?.[0] ?? { x: 0.5, y: 0.5 };
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    protocolVersion: 1,
    requestId: message.requestId,
    projectRevision: message.projectRevision,
    capability: 'subject.segment_frame',
    backend: 'stub',
    modelDigests: {},
    pts: message.parameters.pts,
    width,
    height,
    maskPng: png(point.x * width, point.y * height),
    score: 0.93,
  })}\n`);
});
