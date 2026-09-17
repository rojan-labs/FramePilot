import { describe, expect, it, vi } from 'vitest';
import { ExportHub } from './export-hub.js';

describe('ExportHub active-export count (BR4.9: pack inference pauses while exporting)', () => {
  it('reports 1 when an export starts and 0 when it settles', async () => {
    const counts: number[] = [];
    const hub = new ExportHub({
      progressChannel: 'framepilot:render:export-progress',
      baseUrl: () => 'http://127.0.0.1:1',
      fetchFn: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      onActiveCountChange: (active) => counts.push(active),
    });
    const sender = {
      id: 1,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    hub.start(sender as never, { projectPath: '/p/edit.fp.json' } as never, 'export-1');
    expect(counts).toEqual([1]);
    await vi.waitFor(() => expect(counts).toEqual([1, 0]));
  });
});
