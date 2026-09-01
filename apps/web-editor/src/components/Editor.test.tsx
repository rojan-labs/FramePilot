/**
 * Integration tests for the editor workspace: selection, the patch-engine edit
 * buttons, seeking/zoom/markers, the rail tabs, and caption generation — all
 * driven through the real {@link useEditor} store.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { projectForAi } from '../editor/project-for-ai.js';
import { Editor } from './Editor.js';
import { demoProject } from '../editor/demo.js';
import { createEditorState } from '../editor/store.js';

const renderEditor = () => render(<Editor project={demoProject} />);

/** The right rail defaults to AI (H13); tests asserting inspector content open it. */
const showInspector = (): void => {
  fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }));
};

const clipCount = (container: HTMLElement): number =>
  container.querySelectorAll('.clip-block').length;

const seekTo = (seconds: number): void => {
  fireEvent.change(screen.getByLabelText('playhead'), { target: { value: String(seconds) } });
};

describe('Editor workspace', () => {
  it('renders preview, timeline tracks, and an empty inspector', () => {
    renderEditor();
    showInspector();
    expect(screen.getByRole('region', { name: 'preview' })).toBeDefined();
    // Every track in the project is a row, empty ones included (UX-05, 2026-08-29).
    //
    // This REVERSES the earlier "CapCut-style: only tracks with clips are rendered"
    // decision, deliberately. The walkthrough found the cost of hiding them: a project's
    // own empty audio track did not exist as far as the editor was concerned, so there
    // was nowhere to drop music and "Add track" was the only way to discover a lane at
    // all — including a lane the AI had just created with `add_track` and not yet filled.
    // Premiere, Resolve and Final Cut all show empty tracks; effect lanes (ADR 0088)
    // were already an exception to the filter, which was the first sign it was wrong.
    expect(screen.getByLabelText('track video_1')).toBeDefined();
    expect(screen.getByLabelText('track audio_1')).toBeDefined();
    expect(screen.getByLabelText('track caption_1')).toBeDefined();
    expect(
      screen.getByText(
        'Click a clip, transition, text layer or effect on the timeline to edit it here.',
      ),
    ).toBeDefined();
  });

  it('shows functional per-track header controls and timeline tools in the corner', () => {
    renderEditor();
    // Per-track controls (schema v4) are interactive: clicking Hide engages the
    // flag, which flips the button's label/pressed state to Show.
    const hide = screen.getAllByLabelText('Hide track');
    expect(hide.length).toBeGreaterThan(0);
    const firstHide = hide[0]!;
    expect(firstHide).toHaveProperty('disabled', false);
    expect(firstHide.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(firstHide);
    const shown = screen.getAllByLabelText('Show track');
    expect(shown[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByLabelText('Lock track')[0]).toHaveProperty('disabled', false);
    // Tool/zoom controls live in the toolbar now (TIMELINE-TOOLBAR-REORG); the
    // track-header gutter keeps only Add track.
    expect(screen.getByLabelText('Blade tool')).toBeDefined();
    expect(screen.getByLabelText('Zoom to fit')).toBeDefined();
    expect(screen.getByLabelText('Add track')).toBeDefined();
  });

  it('resizes the library rail by dragging the splitter', () => {
    (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
      MouseEvent as unknown as typeof MouseEvent;
    Element.prototype.setPointerCapture = () => {};
    const { container } = renderEditor();
    const body = container.querySelector('.framepilot-body') as HTMLElement;
    const splitter = screen.getByLabelText('Resize left panel');
    fireEvent.pointerDown(splitter, { clientX: 288, pointerId: 1 });
    // jsdom rects are zero-origin, so clientX maps straight to the rail width (clamped).
    fireEvent.pointerMove(splitter, { clientX: 300, buttons: 1, pointerId: 1 });
    expect(body.style.gridTemplateColumns.startsWith('300px')).toBe(true);
  });

  it('resizes the full-width timeline dock by dragging the stage splitter', () => {
    (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
      MouseEvent as unknown as typeof MouseEvent;
    Element.prototype.setPointerCapture = () => {};
    const { container } = renderEditor();
    const dock = container.querySelector('.timeline-dock') as HTMLElement;
    const splitter = screen.getByLabelText('Resize timeline');
    // jsdom rects are zero-origin; clientY maps to `rect.bottom - clientY` height (clamped to min).
    fireEvent.pointerDown(splitter, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientY: 200, buttons: 1, pointerId: 1 });
    expect(dock.style.height).toBe('160px'); // clamped to TIMELINE_MIN in zero-rect jsdom
  });

  it('collapses and re-expands the library rail', () => {
    renderEditor();
    expect(screen.getByRole('tab', { name: 'Assets' })).toBeDefined(); // visible while expanded
    fireEvent.click(screen.getByLabelText('Collapse library panel'));
    expect(screen.queryByRole('tab', { name: 'Assets' })).toBeNull(); // hidden when collapsed
    fireEvent.click(screen.getByLabelText('Expand library panel'));
    expect(screen.getByRole('tab', { name: 'Assets' })).toBeDefined();
  });

  it('collapses and re-expands the inspector rail', () => {
    renderEditor();
    expect(screen.getByRole('tab', { name: 'Inspector' })).toBeDefined();
    fireEvent.click(screen.getByLabelText('Collapse inspector panel'));
    expect(screen.queryByRole('tab', { name: 'Inspector' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand inspector panel'));
    expect(screen.getByRole('tab', { name: 'Inspector' })).toBeDefined();
  });

  it('does not expose a Transcript tab in the right rail', () => {
    renderEditor();
    expect(screen.queryByRole('tab', { name: 'Transcript' })).toBeNull();
  });

  it('duplicates the selected clip via the keyboard registry (⌘D)', () => {
    const { container } = renderEditor();
    // clip_body is last on its track, so the duplicate appends after it (no overlap).
    fireEvent.click(screen.getByLabelText('clip clip_body'));
    const before = clipCount(container);
    fireEvent.keyDown(document.body, { key: 'd', metaKey: true });
    expect(clipCount(container)).toBe(before + 1);
  });

  it('selects a clip and shows it in the inspector', () => {
    renderEditor();
    showInspector();
    fireEvent.click(screen.getByLabelText('clip clip_body'));
    const inspector = screen.getByLabelText('inspector');
    expect(within(inspector).getByText('clip_body')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Split' })).toHaveProperty('disabled', false);
  });

  it('lifts the edited timeline up to the app on every committed edit', () => {
    const onProjectChange = vi.fn();
    render(<Editor project={demoProject} onProjectChange={onProjectChange} />);
    // Mounting must NOT lift (the store seed equals the project timeline).
    expect(onProjectChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('clip clip_intro'));
    seekTo(3);
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));

    expect(onProjectChange).toHaveBeenCalledTimes(1);
    const lifted = onProjectChange.mock.calls[0]![0];
    // The lifted project carries the *edited* timeline, not the seed.
    expect(lifted.timeline).not.toBe(demoProject.timeline);
    expect(lifted.id).toBe(demoProject.id);
  });

  it('builds AI context from the live media bin instead of a stale app project', () => {
    const state = createEditorState(demoProject.timeline, {
      assets: [
        {
          id: 'asset_just_imported',
          path: 'media/just-imported.mp4',
          kind: 'video',
          durationSeconds: 12,
        },
      ],
      folders: [],
      assetIds: ['asset_just_imported'],
    });
    const aiProject = projectForAi({ ...demoProject, assets: [], folders: [] }, state);

    expect(aiProject.assets).toEqual([
      expect.objectContaining({ id: 'asset_just_imported', path: 'media/just-imported.mp4' }),
    ]);
    expect(aiProject.history).toEqual([]);
  });

  it('splits the selected clip at the playhead through the patch engine', () => {
    const { container } = renderEditor();
    expect(clipCount(container)).toBe(3);

    fireEvent.click(screen.getByLabelText('clip clip_intro'));
    seekTo(3);
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));

    expect(clipCount(container)).toBe(4); // clip_intro split into two
    const toolbar = screen.getByRole('toolbar', { name: 'editor tools' });
    expect(within(toolbar).getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', false);
  });

  it('undoes and redoes an edit from the toolbar', () => {
    const { container } = renderEditor();
    const toolbar = screen.getByRole('toolbar', { name: 'editor tools' });
    fireEvent.click(screen.getByLabelText('clip clip_intro'));
    seekTo(3);
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    expect(clipCount(container)).toBe(4);

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Undo' }));
    expect(clipCount(container)).toBe(3);

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(clipCount(container)).toBe(4);
  });

  it('deletes the selected clip and clears the selection', () => {
    const { container } = renderEditor();
    showInspector();
    fireEvent.click(screen.getByLabelText('clip clip_body'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(clipCount(container)).toBe(2);
    expect(
      screen.getByText(
        'Click a clip, transition, text layer or effect on the timeline to edit it here.',
      ),
    ).toBeDefined();
  });

  it('ripple-deletes the selected clip', () => {
    const { container } = renderEditor();
    fireEvent.click(screen.getByLabelText('clip clip_intro'));
    fireEvent.click(screen.getByRole('button', { name: 'Ripple delete' }));
    expect(clipCount(container)).toBe(2);
  });

  it('zooms the timeline, changing clip widths', () => {
    renderEditor();
    const intro = screen.getByLabelText('clip clip_intro');
    expect(intro.style.width).toBe('240px'); // 6s × 40px/s

    fireEvent.click(screen.getByRole('button', { name: 'zoom in' }));
    expect(screen.getByLabelText('clip clip_intro').style.width).toBe('360px'); // ×1.5

    fireEvent.click(screen.getByRole('button', { name: 'zoom out' }));
    expect(screen.getByLabelText('clip clip_intro').style.width).toBe('240px'); // back to ×1
  });
  it('drops a marker at the playhead', () => {
    renderEditor();
    seekTo(4);
    fireEvent.click(screen.getByRole('button', { name: 'Marker' }));
    expect(screen.getByLabelText('marker at 4s')).toBeDefined();
  });

  it('persists the dropped marker into project.markers (schema v9), toggles it off, and undoes/redoes it', () => {
    const onProjectChange = vi.fn();
    render(<Editor project={demoProject} onProjectChange={onProjectChange} />);
    seekTo(4);
    fireEvent.click(screen.getByRole('button', { name: 'Marker' }));
    expect(screen.getByLabelText('marker at 4s')).toBeDefined();

    // Real persistence: the same "M" action produced a validated project.markers
    // entry, lifted up to the app (not local-only view state).
    const lifted = onProjectChange.mock.calls.at(-1)![0];
    expect(lifted.markers).toEqual([{ id: expect.any(String), time: 4 }]);

    // Undo removes it via the real history, not a second local-only toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.queryByLabelText('marker at 4s')).toBeNull();
    expect(onProjectChange.mock.calls.at(-1)![0].markers).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByLabelText('marker at 4s')).toBeDefined();

    // Pressing "M" again at the same spot toggles it back off (same UX as before
    // persistence — see `patch-builders.ts#toggleMarkerPatch`).
    fireEvent.click(screen.getByRole('button', { name: 'Marker' }));
    expect(screen.queryByLabelText('marker at 4s')).toBeNull();
  });

  it('keeps the program monitor mounted past the end of the timeline', () => {
    renderEditor();
    seekTo(100);
    expect(screen.getByRole('region', { name: 'preview' })).toBeDefined();
  });

  it('applies an audio gain change to the selected clip', () => {
    renderEditor();
    showInspector();
    fireEvent.click(screen.getByLabelText('clip clip_vo'));
    fireEvent.click(screen.getByRole('tab', { name: 'Audio' }));
    fireEvent.change(screen.getByLabelText('gain'), { target: { value: '-6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply audio' }));

    const inspector = screen.getByLabelText('inspector');
    expect(within(inspector).getByText('audio_gain')).toBeDefined();
  });

  it('shows the streaming AI sidebar by default in the right rail (H13)', () => {
    renderEditor();
    expect(screen.getByTestId('ai-sidebar')).toBeDefined();
    expect(screen.getByLabelText('Message FramePilot')).toBeDefined();
  });

  it('keeps the same AI sidebar mounted while another right-rail panel is visible', () => {
    renderEditor();
    const sidebar = screen.getByTestId('ai-sidebar');
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'keep this draft and conversation' },
    });

    showInspector();
    expect(sidebar.isConnected).toBe(true);
    expect(sidebar.closest('[hidden]')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));
    expect(screen.getByTestId('ai-sidebar')).toBe(sidebar);
    expect((screen.getByLabelText('Message FramePilot') as HTMLTextAreaElement).value).toBe(
      'keep this draft and conversation',
    );
  });

  it('renders the AI sidebar when a persistence callback is provided', () => {
    render(<Editor project={demoProject} onProjectChange={() => {}} />);
    expect(screen.getByTestId('ai-sidebar')).toBeDefined();
  });

  it('shows the media bin in the left rail by default and switches library tabs', () => {
    renderEditor();
    // Media is the default left-rail tab; the demo's assets are listed.
    expect(screen.getByLabelText('media bin')).toBeDefined();
    expect(within(screen.getByLabelText('media bin')).getByText('intro.mp4')).toBeDefined();

    fireEvent.click(screen.getByRole('tab', { name: 'Effects' }));
    expect(screen.getByLabelText('effects panel')).toBeDefined();

    fireEvent.click(screen.getByRole('tab', { name: 'Text' }));
    expect(screen.getByLabelText('overlays panel')).toBeDefined();
  });

  it('keeps Collapse out of the scrolling tab strip, so a short window cannot hide it', () => {
    // The strip scrolls when the tabs do not fit. Collapse living inside it
    // would scroll away exactly when the window is too short to spare the
    // width — the moment the user most needs it.
    render(<Editor project={demoProject} onOpenSettings={() => {}} />);
    const tablist = screen.getByRole('tablist', { name: 'library tabs' });

    expect(screen.getByRole('button', { name: 'Collapse library panel' })).toBeDefined();
    expect(within(tablist).queryByRole('button', { name: 'Collapse library panel' })).toBeNull();
    // A tablist should contain tabs and nothing else.
    expect(within(tablist).queryAllByRole('button')).toHaveLength(0);
  });

  it('does not repeat Settings in the rail — the Topbar owns it, with the shortcut', () => {
    render(<Editor project={demoProject} onOpenSettings={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Preferences' })).toBeNull();
  });

  it('generates a caption track from the transcript', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: 'Captions' }));
    // No cue list before generating; the panel shows the pre-commit preview.
    expect(screen.queryByLabelText('caption clips')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }));
    // Generation now runs an async auto-emphasis analysis pass before applying,
    // so the cue list only appears once that settles.
    const list = await screen.findByLabelText('caption clips');
    expect(within(list).getAllByTestId('caption-cue-row').length).toBeGreaterThan(0);
  });

  it('shows a synced cue list after generating and deletes a cue', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: 'Captions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }));
    const list = await screen.findByLabelText('caption clips');
    const before = within(list).getAllByTestId('caption-cue-row').length;
    fireEvent.click(within(list).getAllByLabelText(/Delete caption at/)[0]!);
    expect(
      within(screen.getByLabelText('caption clips')).getAllByTestId('caption-cue-row').length,
    ).toBe(before - 1);
  });

  it('edits a generated cue text in place', async () => {
    // The whole point of schema v11: generated captions are editable.
    renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: 'Captions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }));
    const list = await screen.findByLabelText('caption clips');
    fireEvent.click(within(list).getAllByLabelText(/^Edit caption/)[0]!);
    const input = screen.getByRole('textbox', { name: /Caption text at/ });
    fireEvent.change(input, { target: { value: 'my own words' } });
    fireEvent.blur(input);
    expect(screen.getByRole('button', { name: 'Edit caption "my own words"' })).toBeTruthy();
  });

  it('edits caption keyword emphasis by editing the keywords field', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: 'Captions' }));
    fireEvent.click(screen.getByText('Timing and emphasis'));
    const input = screen.getByLabelText('keywords') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alpha, beta' } });
    fireEvent.blur(input);
    expect(input.value).toBe('alpha, beta');
    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.blur(input);
    expect(input.value).toBe('beta');
  });

  it('reports the cue count when regenerating captions', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: 'Captions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }));
    const list = await screen.findByLabelText('caption clips');
    const rows = within(list).getAllByTestId('caption-cue-row');
    expect(
      screen.getByText(new RegExp(`Regenerating replaces all ${rows.length} cues`)),
    ).toBeTruthy();
  });

  it('highlights caption keywords in the cue list', async () => {
    const { container } = renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: 'Captions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }));
    await screen.findByLabelText('caption clips');
    fireEvent.click(screen.getByText('Timing and emphasis'));
    fireEvent.change(screen.getByLabelText('keywords'), { target: { value: 'framepilot' } });
    fireEvent.blur(screen.getByLabelText('keywords'));
    expect(container.querySelector('.kw')?.textContent?.trim()).toBe('FramePilot');

    // Switching template restyles the whole caption set without error.
    // 'Broadcast' sits in the default Karaoke tab.
    fireEvent.click(screen.getByRole('button', { name: /Broadcast/ }));
    expect(screen.getByRole('button', { name: /Broadcast/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  describe('source-vs-program monitor split (H1.7, J3)', () => {
    it('defaults to Program and streams demo media that has no bounded proxy', () => {
      renderEditor();
      expect(screen.getByRole('tab', { name: 'Program' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(screen.getByRole('tab', { name: 'Source' }).getAttribute('aria-selected')).toBe(
        'false',
      );
      expect(screen.getByRole('region', { name: 'preview' }).dataset.previewEngine).toBe(
        'streaming',
      );
      expect(
        screen
          .getByLabelText('monitor view controls')
          .contains(screen.getByLabelText('composition grid')),
      ).toBe(true);
    });

    it('uses the WebCodecs compositor when every picture source has a bounded proxy', () => {
      const proxyProject = {
        ...demoProject,
        assets: demoProject.assets.map((asset) =>
          asset.kind === 'video'
            ? { ...asset, media: { ...asset.media, proxyPath: `derived/${asset.id}/proxy.mp4` } }
            : asset,
        ),
      };
      render(<Editor project={proxyProject} />);
      expect(screen.getByRole('region', { name: 'preview' }).dataset.previewEngine).toBe(
        'webcodecs',
      );
    });

    it('clicking an asset in the Media panel loads it into Source and switches the tab', () => {
      renderEditor();
      fireEvent.click(screen.getByLabelText('asset asset_intro'));
      expect(screen.getByRole('tab', { name: 'Source' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(screen.getByLabelText('source preview asset_intro')).toBeDefined();
      // The Program monitor (and its patch-engine-backed timeline) is unmounted
      // while Source is active, not merely hidden.
      expect(screen.queryByLabelText('preview')).toBeNull();
    });

    it('switching back to Program shows the real timeline-backed preview again', () => {
      renderEditor();
      fireEvent.click(screen.getByLabelText('asset asset_intro'));
      fireEvent.click(screen.getByRole('tab', { name: 'Program' }));
      expect(screen.getByRole('region', { name: 'preview' })).toBeDefined();
      expect(screen.queryByLabelText(/source preview/)).toBeNull();
    });

    it('manually switching to the Source tab before any asset is loaded shows its empty state', () => {
      renderEditor();
      fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
      expect(screen.getByText('Select an asset in the Media panel to load it here.')).toBeDefined();
      expect(
        screen.getByLabelText('monitor view controls').contains(screen.getByLabelText('mark in')),
      ).toBe(true);
    });
  });
});
