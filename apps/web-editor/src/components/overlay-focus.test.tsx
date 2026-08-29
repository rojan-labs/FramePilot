/**
 * Focus contract for the app's non-dialog overlays (P8.5) — the menus and
 * popovers `dialog-focus.test.tsx` does not cover.
 *
 * They divide into two kinds, and the distinction is deliberate rather than
 * incidental: a MENU or MODAL GATE takes focus and keeps it; a POPOVER that
 * dismisses on an outside press only has to give focus back, because trapping
 * Tab inside something a click outside is meant to close would fight its own
 * dismissal contract.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { FramePilotBridge } from '@framepilot/shared-types';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor, type UseEditor } from '../editor/useEditor.js';
import { CapabilityPackDependencyDialog } from './CapabilityPackDependencyDialog.js';
import { ClipContextMenu } from './ClipContextMenu.js';
import { TrackContextMenu } from './TrackContextMenu.js';
import { TransitionPicker } from './TransitionPicker.js';

const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

let ed: UseEditor;

function EditorProbe(): null {
  ed = useEditor(timeline, ['a']);
  return null;
}

/**
 * Mount a trigger, focus it, then mount the overlay beside it — the overlay
 * captures whatever was focused at ITS mount, which is what the restore proves.
 */
function withTrigger(overlay: () => JSX.Element): {
  trigger: HTMLElement;
  close: () => void;
} {
  const view = render(
    <>
      <button type="button">Open</button>
      <EditorProbe />
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'Open' });
  trigger.focus();
  view.rerender(
    <>
      <button type="button">Open</button>
      <EditorProbe />
      {overlay()}
    </>,
  );
  return {
    trigger,
    close: () =>
      view.rerender(
        <>
          <button type="button">Open</button>
          <EditorProbe />
        </>,
      ),
  };
}

describe('context menus are keyboard-reachable', () => {
  it('ClipContextMenu takes focus on open and gives it back on close', () => {
    const { trigger, close } = withTrigger(() => (
      <ClipContextMenu
        editor={ed}
        target={{ clipId: 'c1', x: 0, y: 0 }}
        onClose={vi.fn()}
      />
    ));
    const menu = screen.getByRole('menu', { name: 'clip actions' });
    expect(menu.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(menu);
    close();
    expect(document.activeElement).toBe(trigger);
  });

  it('TrackContextMenu takes focus on open and gives it back on close', () => {
    const { trigger, close } = withTrigger(() => (
      <TrackContextMenu editor={ed} target={{ trackId: 'v', x: 0, y: 0 }} onClose={vi.fn()} />
    ));
    const menu = screen.getByRole('menu', { name: 'track actions' });
    expect(menu.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(menu);
    close();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('TransitionPicker', () => {
  it('returns focus to its opener without trapping Tab inside itself', () => {
    const { trigger, close } = withTrigger(() => (
      <TransitionPicker
        target={{ fromClipId: 'c1', x: 0, y: 0 }}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    // Its own search field autofocuses; the gap was the way back.
    expect(screen.getByRole('dialog', { name: 'Choose a transition' })).toBeDefined();
    close();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('CapabilityPackDependencyDialog', () => {
  const pin = {
    id: 'framepilot.subject-intelligence',
    version: '1.2.0',
    releaseDigest: 'a'.repeat(64),
    capabilities: ['tracking.face'],
    requiredFor: 'analysis' as const,
  };

  it('traps focus inside the gate it puts in front of the project', () => {
    window.framepilot = {} as FramePilotBridge;
    render(
      <>
        <button type="button">behind the gate</button>
        <CapabilityPackDependencyDialog
          projectId="project-1"
          resolution={{
            dependencies: [{ pin, status: 'missing' }],
            renderBlocked: false,
            editBlocked: false,
          }}
          onResolutionChange={vi.fn()}
          onOpenDegraded={vi.fn()}
        />
      </>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Project capabilities required' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Shift+Tab from the first control wraps to the last one INSIDE the gate,
    // rather than landing on the editor the gate exists to withhold.
    const inside = [...dialog.querySelectorAll('button')];
    const first = inside[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(inside.at(-1));

    delete window.framepilot;
  });
});
