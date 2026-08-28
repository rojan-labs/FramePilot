import { describe, expect, it } from 'vitest';
import { applyDotEnv, parseDotEnv } from './env.js';

describe('parseDotEnv', () => {
  it('parses KEY=value, skips comments/blanks, strips matching outer quotes', () => {
    expect(parseDotEnv('# c\n\nA=1\nB="two"\nC=\'3\'\nD=\nnoeq\n =x\n')).toEqual({ A: '1', B: 'two', C: '3', D: '' });
  });
});

describe('applyDotEnv', () => {
  it('fills missing keys and never overrides a value the process already carries', () => {
    const env: NodeJS.ProcessEnv = { FRAMEPILOT_LICENSE_DEV_BYPASS: '1', KEEP: 'shell' };
    const applied = applyDotEnv({ FRAMEPILOT_LICENSE_DEV_BYPASS: '', KEEP: 'file', NEW: 'from-file' }, env);
    expect(env).toEqual({ FRAMEPILOT_LICENSE_DEV_BYPASS: '1', KEEP: 'shell', NEW: 'from-file' });
    expect(applied).toEqual(['NEW']);
  });

  it('treats an empty process value as set (explicitly blanked stays blank)', () => {
    const env: NodeJS.ProcessEnv = { A: '' };
    applyDotEnv({ A: 'file' }, env);
    expect(env.A).toBe('');
  });
});
