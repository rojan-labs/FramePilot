/**
 * Tests for the edit-mode + ripple-on-delete view state (TIMELINE-REVAMP M2b-1):
 * defaults, toggles, and localStorage round-trip. View/session state only — never
 * part of the patch history or the saved project (invariant 5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_EDIT_MODE, loadEditMode, useEditMode } from './useEditMode.js';

const STORAGE_KEY = 'framepilot.editMode';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('loadEditMode', () => {
  it('returns defaults (overwrite + ripple off) when storage is empty', () => {
    expect(loadEditMode()).toEqual(DEFAULT_EDIT_MODE);
    expect(DEFAULT_EDIT_MODE).toEqual({ editMode: 'overwrite', rippleOnDelete: false });
  });

  it('tolerates corrupt or partial data', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    expect(loadEditMode()).toEqual(DEFAULT_EDIT_MODE);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ editMode: 'bogus' }));
    expect(loadEditMode()).toEqual({ editMode: 'overwrite', rippleOnDelete: false });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rippleOnDelete: true }));
    expect(loadEditMode()).toEqual({ editMode: 'overwrite', rippleOnDelete: true });
  });
});

describe('useEditMode', () => {
  it('starts from defaults and persists a mode switch', () => {
    const { result } = renderHook(() => useEditMode());
    expect(result.current.editMode).toBe('overwrite');

    act(() => result.current.setEditMode('insert'));
    expect(result.current.editMode).toBe('insert');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).editMode).toBe('insert');
  });

  it('toggles ripple-on-delete and persists it', () => {
    const { result } = renderHook(() => useEditMode());
    expect(result.current.rippleOnDelete).toBe(false);

    act(() => result.current.toggleRippleOnDelete());
    expect(result.current.rippleOnDelete).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).rippleOnDelete).toBe(true);

    act(() => result.current.toggleRippleOnDelete());
    expect(result.current.rippleOnDelete).toBe(false);
  });

  it('keeps the two flags independent across changes', () => {
    const { result } = renderHook(() => useEditMode());
    act(() => result.current.setEditMode('insert'));
    act(() => result.current.toggleRippleOnDelete());
    expect(result.current.editMode).toBe('insert');
    expect(result.current.rippleOnDelete).toBe(true);
    // Switching mode back to overwrite must not clear the ripple flag.
    act(() => result.current.setEditMode('overwrite'));
    expect(result.current.rippleOnDelete).toBe(true);
  });

  it('restores persisted state on mount', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ editMode: 'insert', rippleOnDelete: true }));
    const { result } = renderHook(() => useEditMode());
    expect(result.current.editMode).toBe('insert');
    expect(result.current.rippleOnDelete).toBe(true);
  });
});
