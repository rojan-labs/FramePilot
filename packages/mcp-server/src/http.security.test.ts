import { describe, expect, it } from 'vitest';
import { resolveHttpConfig } from './http.js';

describe('MCP HTTP network authentication', () => {
  it('keeps anonymous access available on explicit loopback hosts', () => {
    expect(resolveHttpConfig({ FRAMEPILOT_MCP_HOST: '127.0.0.1' }).token).toBeNull();
    expect(resolveHttpConfig({ FRAMEPILOT_MCP_HOST: 'localhost' }).token).toBeNull();
    expect(resolveHttpConfig({ FRAMEPILOT_MCP_HOST: '::1' }).token).toBeNull();
  });

  it('requires a bearer token before binding to a non-loopback interface', () => {
    expect(() => resolveHttpConfig({ FRAMEPILOT_MCP_HOST: '0.0.0.0' })).toThrow(
      /FRAMEPILOT_MCP_TOKEN/u,
    );
    expect(() => resolveHttpConfig({ FRAMEPILOT_MCP_HOST: '192.168.1.20' })).toThrow(
      /FRAMEPILOT_MCP_TOKEN/u,
    );
  });

  it('allows a non-loopback bind when bearer authentication is configured', () => {
    const config = resolveHttpConfig({
      FRAMEPILOT_MCP_HOST: '0.0.0.0',
      FRAMEPILOT_MCP_TOKEN: '  local-network-secret  ',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.token).toBe('local-network-secret');
  });

  it('treats a blank host override as the secure loopback default', () => {
    const config = resolveHttpConfig({ FRAMEPILOT_MCP_HOST: '   ' });
    expect(config.host).toBe('127.0.0.1');
    expect(config.token).toBeNull();
  });
});
