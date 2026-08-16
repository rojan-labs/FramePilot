import { describe, expect, it } from 'vitest';
import { toolContract } from './tool-contract.js';
import { getTool } from './tool-registry.js';

const contract = (name: string) => {
  const tool = getTool(name);
  if (!tool) throw new Error(`missing test tool ${name}`);
  return toolContract(tool);
};

describe('first-class tool execution contracts', () => {
  it('classifies transcribe as a serial host mutation requiring write permission', () => {
    expect(contract('transcribe')).toEqual({
      executionPlane: 'host',
      effectClass: 'mutation',
      permissions: ['analysis', 'write'],
      concurrency: 'serial',
      stateDependency: 'asset_content',
      cacheScope: 'none',
    });
  });

  it('classifies index_media as a serial host mutation with no cache', () => {
    expect(contract('index_media')).toMatchObject({
      executionPlane: 'host',
      effectClass: 'mutation',
      permissions: ['analysis', 'write'],
      concurrency: 'serial',
      stateDependency: 'asset_content',
      cacheScope: 'none',
    });
  });

  it('scopes get_frame to the current project revision', () => {
    expect(contract('get_frame')).toEqual({
      executionPlane: 'host',
      effectClass: 'pure_read',
      permissions: ['analysis'],
      concurrency: 'parallel',
      stateDependency: 'project_revision',
      cacheScope: 'project_revision',
    });
  });

  it('never caches export actions', () => {
    expect(contract('export_video')).toMatchObject({
      executionPlane: 'host',
      effectClass: 'action',
      permissions: ['render'],
      concurrency: 'serial',
      stateDependency: 'project_revision',
      cacheScope: 'none',
    });
  });

  it('keeps ordinary in-process reads parallel but revision-dependent', () => {
    expect(contract('get_timeline')).toMatchObject({
      executionPlane: 'in_process',
      effectClass: 'pure_read',
      permissions: ['read'],
      concurrency: 'parallel',
      stateDependency: 'project_revision',
      cacheScope: 'none',
    });
  });
});