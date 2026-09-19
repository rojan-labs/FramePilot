import { describe, expect, it, vi } from 'vitest';
import { IdentityClient } from './identity-client.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (fetchFn: typeof fetch): IdentityClient =>
  new IdentityClient({ baseUrl: 'http://engine', fetchFn });

describe('IdentityClient', () => {
  it('reads consent and how many people the project knows', async () => {
    const fetchFn = vi.fn(async () =>
      json({
        available: true,
        reason: null,
        consent: true,
        people: 3,
        deletedPeople: null,
        deletedShots: null,
      }),
    );
    expect(await client(fetchFn as never).state('p 1')).toEqual({
      available: true,
      consent: true,
      people: 3,
    });
    expect(fetchFn.mock.calls[0]![0]).toBe('http://engine/brain/identity?projectId=p%201');
  });

  it('posts the editor’s choice and the one-action delete', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { consent?: boolean };
      return json({
        available: true,
        consent: body.consent ?? false,
        people: 0,
        deletedPeople: body.consent === undefined ? 2 : null,
      });
    });
    expect((await client(fetchFn as never).setConsent('p1', true)).consent).toBe(true);
    expect(await client(fetchFn as never).deleteAll('p1')).toEqual({
      available: true,
      consent: false,
      people: 0,
      deletedPeople: 2,
    });
    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual([
      'http://engine/brain/identity/consent',
      'http://engine/brain/identity/delete',
    ]);
  });

  it('treats every unreadable answer as NO consent — never as consent it failed to disprove', async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => json({ available: false, reason: 'no sandbox root', consent: true, people: 9 }),
      async () => json({ consent: 'yes' }),
      async () => json({}, 500),
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
    ];
    for (const respond of cases) {
      const state = await client(respond as never).state('p1');
      expect(state.consent).toBe(false);
      expect(state.available).toBe(false);
      expect(state.people).toBe(0);
    }
  });
});
