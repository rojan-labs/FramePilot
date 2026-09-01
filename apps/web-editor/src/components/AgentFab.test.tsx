import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AgentFab } from './AgentFab.js';
import { clearAgentActivity, publishAgentActivity } from '../editor/agent-activity.js';

afterEach(() => act(() => clearAgentActivity()));

const fab = (): HTMLElement | null =>
  screen.queryByRole('button', { name: /FramePilot is working/ });

describe('AgentFab', () => {
  it('is not rendered at all while nothing is running', () => {
    // Mounted unconditionally by the editor, so "idle" has to cost nothing but a
    // subscription — no element, no layout, no paint.
    render(<AgentFab aiPanelVisible={false} onOpenAi={() => {}} />);
    expect(fab()).toBeNull();
  });

  it('appears when a run starts, without the editor being told', () => {
    render(<AgentFab aiPanelVisible={false} onOpenAi={() => {}} />);
    act(() => publishAgentActivity({ running: true, label: null }));
    expect(fab()).not.toBeNull();
  });

  it('stays out of the way while the agent panel is already on screen', () => {
    // It is a way BACK to a run you cannot see; while you are looking at it, it
    // would be one more thing saying what the screen already says.
    render(<AgentFab aiPanelVisible onOpenAi={() => {}} />);
    act(() => publishAgentActivity({ running: true, label: null }));
    expect(fab()).toBeNull();
  });

  it('says what the agent is doing, in its accessible name', () => {
    render(<AgentFab aiPanelVisible={false} onOpenAi={() => {}} />);
    act(() => publishAgentActivity({ running: true, label: 'Reading the timeline' }));
    expect(
      screen.getByRole('button', {
        name: 'FramePilot is working: Reading the timeline. Open the AI panel',
      }),
    ).toBeDefined();
  });

  it('falls back to a plain working state when there is no step to name', () => {
    render(<AgentFab aiPanelVisible={false} onOpenAi={() => {}} />);
    act(() => publishAgentActivity({ running: true, label: null }));
    expect(
      screen.getByRole('button', { name: 'FramePilot is working. Open the AI panel' }),
    ).toBeDefined();
  });

  it('brings the panel back when clicked', () => {
    const onOpenAi = vi.fn();
    render(<AgentFab aiPanelVisible={false} onOpenAi={onOpenAi} />);
    act(() => publishAgentActivity({ running: true, label: null }));
    fireEvent.click(fab()!);
    expect(onOpenAi).toHaveBeenCalledTimes(1);
  });

  it('disappears the moment the run ends', () => {
    render(<AgentFab aiPanelVisible={false} onOpenAi={() => {}} />);
    act(() => publishAgentActivity({ running: true, label: 'Working' }));
    expect(fab()).not.toBeNull();
    act(() => clearAgentActivity());
    expect(fab()).toBeNull();
  });

  it('announces politely, so it never interrupts typing or a drag', () => {
    render(<AgentFab aiPanelVisible={false} onOpenAi={() => {}} />);
    act(() => publishAgentActivity({ running: true, label: null }));
    expect(fab()!.getAttribute('aria-live')).toBe('polite');
  });
});
