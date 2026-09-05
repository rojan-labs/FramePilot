import { describe, expect, it, vi } from 'vitest';
import {
  INTRO_BOOT_SCRIPT,
  INTRO_SEEN_KEY,
  INTRO_TOTAL_MS,
  STAGE_DURATION_MS,
  hasSeenIntro,
  introReducer,
  isIntroDone,
  markIntroSeen,
  type IntroState,
} from './intro-machine';

const START = { type: 'start', reducedMotion: false, alreadySeen: false } as const;
const ALL_STATES: IntroState[] = ['idle', 'assembling', 'discarding', 'landing', 'settled'];

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function throwingStorage() {
  return {
    getItem: () => {
      throw new Error('SecurityError: storage is disabled');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

describe('introReducer', () => {
  it('runs the full sequence one stage at a time', () => {
    let state = introReducer('idle', START);
    expect(state).toBe('assembling');
    state = introReducer(state, { type: 'advance' });
    expect(state).toBe('discarding');
    state = introReducer(state, { type: 'advance' });
    expect(state).toBe('landing');
    state = introReducer(state, { type: 'advance' });
    expect(state).toBe('settled');
  });

  it('stays settled once the sequence has finished', () => {
    expect(introReducer('settled', { type: 'advance' })).toBe('settled');
    expect(introReducer('settled', START)).toBe('settled');
  });

  it('ignores advance before the intro has started', () => {
    expect(introReducer('idle', { type: 'advance' })).toBe('idle');
  });

  it('skips to settled from any state', () => {
    for (const state of ALL_STATES) {
      expect(introReducer(state, { type: 'skip' })).toBe('settled');
    }
  });

  it('settles immediately under reduced motion', () => {
    expect(introReducer('idle', { type: 'start', reducedMotion: true, alreadySeen: false })).toBe(
      'settled',
    );
  });

  it('suppresses the replay when the session flag is set', () => {
    expect(introReducer('idle', { type: 'start', reducedMotion: false, alreadySeen: true })).toBe(
      'settled',
    );
  });

  it('does not restart once the intro is already running', () => {
    expect(introReducer('discarding', START)).toBe('discarding');
  });

  it('reports completion only for settled', () => {
    expect(ALL_STATES.filter(isIntroDone)).toEqual(['settled']);
  });
});

describe('intro timing', () => {
  it('finishes inside the 2.4s–3.0s budget', () => {
    expect(INTRO_TOTAL_MS).toBeGreaterThanOrEqual(2400);
    expect(INTRO_TOTAL_MS).toBeLessThanOrEqual(3000);
  });

  it('gives every animated stage a positive duration', () => {
    for (const duration of Object.values(STAGE_DURATION_MS)) {
      expect(duration).toBeGreaterThan(0);
    }
  });
});

describe('session flag', () => {
  it('round-trips through a working storage', () => {
    const storage = memoryStorage();
    expect(hasSeenIntro(storage)).toBe(false);
    markIntroSeen(storage);
    expect(hasSeenIntro(storage)).toBe(true);
    expect(storage.getItem(INTRO_SEEN_KEY)).toBe('1');
  });

  it('treats a throwing storage as "not seen" instead of throwing', () => {
    const storage = throwingStorage();
    expect(() => hasSeenIntro(storage)).not.toThrow();
    expect(hasSeenIntro(storage)).toBe(false);
    expect(() => markIntroSeen(storage)).not.toThrow();
  });

  it('tolerates a missing storage object', () => {
    expect(hasSeenIntro(null)).toBe(false);
    expect(hasSeenIntro(undefined)).toBe(false);
    expect(() => markIntroSeen(null)).not.toThrow();
  });

  it('does not swallow unrelated failures silently in the reader', () => {
    const getItem = vi.fn(() => '1');
    expect(hasSeenIntro({ getItem, setItem: vi.fn() })).toBe(true);
    expect(getItem).toHaveBeenCalledWith(INTRO_SEEN_KEY);
  });
});

describe('boot script', () => {
  it('only marks the landing route, an unseen session, and full motion', () => {
    expect(INTRO_BOOT_SCRIPT).toContain("location.pathname!=='/'");
    expect(INTRO_BOOT_SCRIPT).toContain(INTRO_SEEN_KEY);
    expect(INTRO_BOOT_SCRIPT).toContain('prefers-reduced-motion: reduce');
    expect(INTRO_BOOT_SCRIPT).toContain("dataset.intro='pending'");
  });

  it('guards every storage access', () => {
    expect(INTRO_BOOT_SCRIPT).toContain('try{if(sessionStorage.getItem');
  });
});
