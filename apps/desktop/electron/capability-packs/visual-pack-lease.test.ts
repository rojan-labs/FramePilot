import { describe, expect, it, vi } from 'vitest';
import type { CapabilityPackInstallIdentity } from '@framepilot/capability-packs';
import type { CapabilityPackLease } from '@framepilot/capability-packs/node';
import { identitiesReferencedByBody, withVisualPackLease } from './visual-pack-lease.js';

function identity(id: string): CapabilityPackInstallIdentity {
  return {
    id,
    version: '1.0.0',
    releaseDigest: 'b'.repeat(64),
    artifactDigest: 'a'.repeat(64),
    os: 'darwin',
    arch: 'arm64',
  };
}

const EMBED = identity('framepilot.visual-embed');
const DESCRIBE = identity('framepilot.visual-describe');

describe('identitiesReferencedByBody', () => {
  it('names the identity for every visual pack field the body carries', () => {
    const body = { query: 'red car', visualEmbedPack: '{"packId":"x"}' };
    expect(
      identitiesReferencedByBody(body, { visualEmbedPack: EMBED, visualDescribePack: DESCRIBE }),
    ).toEqual([EMBED]);
  });

  it('names both when a request carries both handles', () => {
    const body = { visualEmbedPack: '{}', visualDescribePack: '{}' };
    expect(
      identitiesReferencedByBody(body, { visualEmbedPack: EMBED, visualDescribePack: DESCRIBE }),
    ).toEqual([EMBED, DESCRIBE]);
  });

  it('names nothing for a request with no pack handle field, even with current identities', () => {
    const body = { query: 'a search with no local pack' };
    expect(identitiesReferencedByBody(body, { visualEmbedPack: EMBED })).toEqual([]);
  });

  it('names nothing for a field the body has but the current resolution no longer does', () => {
    // The pack store changed between building the request and sending it: the field is
    // present but stale, exactly like a subsequent visualIndexCredentials() read would
    // already have dropped it.
    const body = { visualEmbedPack: '{}' };
    expect(identitiesReferencedByBody(body, {})).toEqual([]);
  });

  it('is safe against a non-object or unparsable body', () => {
    expect(identitiesReferencedByBody(undefined, { visualEmbedPack: EMBED })).toEqual([]);
    expect(identitiesReferencedByBody('not json', { visualEmbedPack: EMBED })).toEqual([]);
    expect(identitiesReferencedByBody(null, { visualEmbedPack: EMBED })).toEqual([]);
  });
});

function fakeLease(): CapabilityPackLease {
  return {
    identity: EMBED,
    installPath: '/packs/framepilot.visual-embed/1.0.0',
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe('withVisualPackLease', () => {
  it('acquires and releases the lease around a call that names a pack', async () => {
    const lease = fakeLease();
    const acquire = vi.fn().mockResolvedValue(lease);
    const inner = vi.fn().mockResolvedValue(new Response('{}'));
    const wrapped = withVisualPackLease(inner, () => ({ visualEmbedPack: EMBED }), acquire);

    await wrapped('http://engine/brain/visual/index', {
      method: 'POST',
      body: JSON.stringify({ visualEmbedPack: '{}' }),
    });

    expect(acquire).toHaveBeenCalledWith(EMBED);
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('releases the lease even when the underlying fetch rejects', async () => {
    const lease = fakeLease();
    const acquire = vi.fn().mockResolvedValue(lease);
    const inner = vi.fn().mockRejectedValue(new Error('network down'));
    const wrapped = withVisualPackLease(inner, () => ({ visualEmbedPack: EMBED }), acquire);

    await expect(
      wrapped('http://engine/brain/visual/index', { body: JSON.stringify({ visualEmbedPack: '{}' }) }),
    ).rejects.toThrow('network down');
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('never acquires a lease for a call with no pack handle in its body', async () => {
    const acquire = vi.fn();
    const inner = vi.fn().mockResolvedValue(new Response('{}'));
    const wrapped = withVisualPackLease(inner, () => ({ visualEmbedPack: EMBED }), acquire);

    await wrapped('http://engine/brain/search', { body: JSON.stringify({ query: 'x' }) });

    expect(acquire).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('proceeds without the lease when acquisition fails, rather than failing the call', async () => {
    const acquire = vi.fn().mockRejectedValue(new Error('pack_leased'));
    const inner = vi.fn().mockResolvedValue(new Response('{}'));
    const wrapped = withVisualPackLease(inner, () => ({ visualEmbedPack: EMBED }), acquire);

    const response = await wrapped('http://engine/brain/visual/index', {
      body: JSON.stringify({ visualEmbedPack: '{}' }),
    });

    expect(response.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
