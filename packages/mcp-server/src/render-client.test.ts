import { describe, expect, it, vi } from 'vitest';
import { RenderClient, RenderError, renderClientFromEnv } from './render-client.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('RenderClient', () => {
  it('posts a preview render to /render/preview with defaults', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ jobId: 'job_1' }));
    const client = new RenderClient('http://sidecar', fetchFn as unknown as typeof fetch);

    const result = await client.render({ projectPath: '/p/project.fp.json', preview: true });

    expect(result).toEqual({ jobId: 'job_1' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/render/preview');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      preset: null,
      burn_captions: false,
    });
  });

  it('posts a final export to /render with preset + burn captions', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ jobId: 'job_2' }));
    const client = new RenderClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await client.render({
      projectPath: '/p/project.fp.json',
      preview: false,
      preset: 'reels_9x16',
      burnCaptions: true,
    });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://sidecar/render');
    expect(JSON.parse(init!.body as string)).toEqual({
      project_path: '/p/project.fp.json',
      preset: 'reels_9x16',
      burn_captions: true,
    });
  });

  it('throws a RenderError on a non-2xx response', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 400 }));
    const client = new RenderClient('http://sidecar', fetchFn as unknown as typeof fetch);

    await expect(client.render({ projectPath: '/p', preview: true })).rejects.toMatchObject({
      name: 'RenderError',
      status: 400,
    });
    await expect(client.render({ projectPath: '/p', preview: true })).rejects.toBeInstanceOf(
      RenderError,
    );
  });
});

describe('renderClientFromEnv', () => {
  it('builds a client when the sidecar URL is set, else null', () => {
    expect(renderClientFromEnv({ FRAMEPILOT_PYTHON_API_URL: 'http://x' })).toBeInstanceOf(
      RenderClient,
    );
    expect(renderClientFromEnv({})).toBeNull();
  });
});
