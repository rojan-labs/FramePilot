/**
 * Tests for the left-rail authoring panels: the Media bin (import + place +
 * drag), the Effects palette (color grades + transitions), and the Overlays
 * panel — all driven through the real {@link useEditor} store so every action is
 * a validated patch. The DOM media probe is mocked (jsdom has no media
 * pipeline); the rest is exercised end-to-end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { parseProject } from '@framepilot/timeline-schema';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { addAsset, assetIdsOf, newProject } from '../editor/project.js';
import { demoProject } from '../editor/demo.js';
import { MediaBin, ASSET_DND_TYPE } from './MediaBin.js';
import { EffectsPanel, EFFECT_DND_TYPE } from './EffectsPanel.js';
import { EFFECT_LIBRARY_STORAGE_KEYS } from './useEffectLibrary.js';
import { OverlaysPanel } from './OverlaysPanel.js';
import { CAPTION_FONT_CATALOG } from '@framepilot/timeline-schema/caption-fonts';
import { Inspector } from './Inspector.js';
import { TimelineView } from './TimelineView.js';
import { addTransitionPatch } from '../editor/patch-builders.js';

vi.mock('../editor/import.js', async (importActual) => {
  const actual = await importActual<typeof import('../editor/import.js')>();
  return { ...actual, probeMediaFile: vi.fn() };
});
import { probeMediaFile } from '../editor/import.js';

const clipCount = (container: HTMLElement): number =>
  container.querySelectorAll('.clip-block').length;

/**
 * Store options that seed the bin from a project. The MediaBin reads assets and
 * folders from the store (the source of truth) and applies foldering/asset edits
 * as undoable project-scoped patches, so the editor must be created with the bin.
 */
const binOpts = (project: Project) => ({
  assets: project.assets,
  folders: project.folders,
  assetIds: assetIdsOf(project),
});

describe('MediaBin', () => {
  it('lists assets and places one on the timeline as a patch', () => {
    function Host(): JSX.Element {
      const editor = useEditor(demoProject.timeline, binOpts(demoProject));
      return (
        <>
          <MediaBin editor={editor} project={demoProject} />
          <TimelineView editor={editor} assets={demoProject.assets} />
        </>
      );
    }
    const { container } = render(<Host />);
    expect(within(screen.getByLabelText('media bin')).getByText('intro.mp4')).toBeDefined();
    expect(clipCount(container)).toBe(3); // demo: 2 video + 1 audio

    fireEvent.click(screen.getByRole('button', { name: 'add intro.mp4 to timeline' }));
    expect(clipCount(container)).toBe(4); // appended to the video lane

    // An audio asset lands on the audio lane (a different target track type).
    fireEvent.click(screen.getByRole('button', { name: 'add voiceover.wav to timeline' }));
    expect(clipCount(container)).toBe(5);
  });

  it('ignores an empty file pick and omits the badge for an unknown duration', () => {
    const project = addAsset(newProject('Bin'), {
      id: 'asset_unknown',
      path: 'blob:u',
      kind: 'video',
    });
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    // No duration on the asset → NO duration badge. It used to render a dash,
    // which cost a badge's worth of attention over the frame to say nothing.
    const card = screen.getByLabelText('asset asset_unknown');
    expect(card.querySelector('.bin-card-dur')).toBeNull();
    // Cancelling the file dialog yields no files: no status, no change.
    fireEvent.change(screen.getByLabelText('import media'), { target: { files: null } });
    expect(screen.queryByLabelText('import status')).toBeNull();
  });

  it('uses singular wording when a single file is imported', async () => {
    vi.mocked(probeMediaFile).mockResolvedValueOnce({
      path: 'blob:a',
      fileName: 'a.mp4',
      durationSeconds: 4,
      kind: 'video',
    });
    function Host(): JSX.Element {
      const project = newProject('Empty');
      const editor = useEditor(project.timeline);
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    fireEvent.change(screen.getByLabelText('import media'), {
      target: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })] },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('import status').textContent).toContain('Imported 1 file.'),
    );
  });

  it('stringifies a non-Error probe rejection', async () => {
    vi.mocked(probeMediaFile).mockRejectedValueOnce('disk gone');
    function Host(): JSX.Element {
      const project = newProject('Empty');
      const editor = useEditor(project.timeline);
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    fireEvent.change(screen.getByLabelText('import media'), {
      target: { files: [new File(['x'], 'x.mp4', { type: 'video/mp4' })] },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('import status').textContent).toContain('disk gone'),
    );
  });

  it('shows an empty state for a project with no media', () => {
    function Host(): JSX.Element {
      const project = newProject('Empty');
      const editor = useEditor(project.timeline);
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    expect(screen.getByText(/No media yet/)).toBeDefined();
  });

  it('carries the asset id on drag start', () => {
    function Host(): JSX.Element {
      const editor = useEditor(demoProject.timeline, binOpts(demoProject));
      return <MediaBin editor={editor} project={demoProject} />;
    }
    render(<Host />);
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByLabelText('asset asset_intro'), {
      dataTransfer: { setData, effectAllowed: '' },
    });
    expect(setData).toHaveBeenCalledWith(ASSET_DND_TYPE, 'asset_intro');
  });

  it('imports picked files as undoable add_asset patches and reports status', async () => {
    vi.mocked(probeMediaFile)
      .mockResolvedValueOnce({
        path: 'blob:a',
        fileName: 'a.mp4',
        durationSeconds: 4,
        kind: 'video',
      })
      .mockResolvedValueOnce({
        path: 'blob:b',
        fileName: 'b.wav',
        durationSeconds: 6,
        kind: 'audio',
      });
    function Host(): JSX.Element {
      const project = newProject('Empty');
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    const file = (name: string, type: string): File => new File(['x'], name, { type });
    fireEvent.change(screen.getByLabelText('import media'), {
      target: { files: [file('a.mp4', 'video/mp4'), file('b.wav', 'audio/wav')] },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('import status').textContent).toContain('Imported 2 files'),
    );
    // The store (source of truth) now lists both imported assets in the bin.
    expect(screen.getByLabelText('asset asset_a')).toBeDefined();
    expect(screen.getByLabelText('asset asset_b')).toBeDefined();
  });

  it('removes an asset: drops its timeline clips and updates the bin', () => {
    function Host(): JSX.Element {
      const editor = useEditor(demoProject.timeline, binOpts(demoProject));
      return (
        <>
          <MediaBin editor={editor} project={demoProject} />
          <TimelineView editor={editor} assets={demoProject.assets} />
        </>
      );
    }
    const { container } = render(<Host />);
    // asset_intro backs both video clips; removing it lifts them off the timeline.
    expect(clipCount(container)).toBe(3);
    // Named by the file, as the card shows it; an id means nothing to a listener.
    fireEvent.click(screen.getByRole('button', { name: 'remove intro.mp4' }));
    expect(clipCount(container)).toBe(1); // only the audio clip remains
    expect(screen.queryByLabelText('asset asset_intro')).toBeNull(); // gone from the bin
    expect(screen.getByLabelText('asset asset_voiceover')).toBeDefined();
    expect(screen.getByLabelText('import status').textContent).toContain('Removed intro.mp4');
  });

  it('removing an unused asset leaves the timeline untouched', () => {
    const project = addAsset(newProject('Bin'), {
      id: 'asset_solo',
      path: 'blob:s',
      kind: 'video',
    });
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, binOpts(project));
      return (
        <>
          <MediaBin editor={editor} project={project} />
          <TimelineView editor={editor} assets={project.assets} />
        </>
      );
    }
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'remove blob:s' }));
    expect(clipCount(container)).toBe(0); // no clips existed to remove
    expect(screen.queryByLabelText('asset asset_solo')).toBeNull();
  });

  it('creates a folder, moves an asset into it via drag, and folds it', () => {
    const project = addAsset(newProject('Bin'), { id: 'asset_x', path: 'x.mp4', kind: 'video' });
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);

    // Naming is an inline field (Electron's renderer has no window.prompt).
    fireEvent.click(screen.getByRole('button', { name: 'new folder' }));
    fireEvent.change(screen.getByLabelText('folder name'), { target: { value: 'B-roll' } });
    fireEvent.keyDown(screen.getByLabelText('folder name'), { key: 'Enter' });
    const folder = screen.getByLabelText('folder B-roll');
    expect(folder).toBeDefined();
    // Empty folder shows its placeholder until something is dropped in.
    expect(screen.getByText(/Empty folder/)).toBeDefined();

    // Drag the root asset onto the folder → it moves in (and the empty state clears).
    const data = new Map<string, string>();
    const dataTransfer = {
      getData: (t: string) => data.get(t) ?? '',
      setData: (t: string, v: string) => void data.set(t, v),
      types: [ASSET_DND_TYPE],
      effectAllowed: '',
    };
    fireEvent.dragStart(screen.getByLabelText('asset asset_x'), { dataTransfer });
    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });
    expect(screen.queryByText(/Empty folder/)).toBeNull();

    // Collapsing hides the folder body.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse B-roll' }));
    expect(screen.getByRole('button', { name: 'Expand B-roll' })).toBeDefined();
  });

  it('renames and deletes a folder', () => {
    const project: Project = {
      ...newProject('Bin'),
      folders: [{ id: 'f1', name: 'Old', parentId: null }],
    };
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'rename Old' }));
    fireEvent.change(screen.getByLabelText('rename folder Old'), { target: { value: 'Renamed' } });
    fireEvent.keyDown(screen.getByLabelText('rename folder Old'), { key: 'Enter' });
    expect(screen.getByLabelText('folder Renamed')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'delete Renamed' }));
    expect(screen.queryByLabelText('folder Renamed')).toBeNull();
  });

  it('renames a folder by double-clicking its name (inline rename)', () => {
    const project: Project = {
      ...newProject('Bin'),
      folders: [{ id: 'f1', name: 'Old', parentId: null }],
    };
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    fireEvent.doubleClick(screen.getByText('Old'));
    fireEvent.change(screen.getByLabelText('rename folder Old'), { target: { value: 'Fresh' } });
    fireEvent.keyDown(screen.getByLabelText('rename folder Old'), { key: 'Enter' });
    expect(screen.getByLabelText('folder Fresh')).toBeDefined();
  });

  it('creates a nested subfolder inline', () => {
    const project: Project = {
      ...newProject('Bin'),
      folders: [{ id: 'f1', name: 'Parent', parentId: null }],
    };
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'new subfolder in Parent' }));
    fireEvent.change(screen.getByLabelText('folder name'), { target: { value: 'Child' } });
    fireEvent.keyDown(screen.getByLabelText('folder name'), { key: 'Enter' });
    expect(screen.getByLabelText('folder Child')).toBeDefined();
  });

  it('cancels a folder name edit on Escape', () => {
    function Host(): JSX.Element {
      const project = newProject('Bin');
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'new folder' }));
    fireEvent.change(screen.getByLabelText('folder name'), { target: { value: 'Scratch' } });
    fireEvent.keyDown(screen.getByLabelText('folder name'), { key: 'Escape' });
    expect(screen.queryByLabelText('folder Scratch')).toBeNull();
    expect(screen.queryByLabelText('folder name')).toBeNull();
  });

  it('imports OS files dropped onto the bin root', async () => {
    vi.mocked(probeMediaFile).mockResolvedValueOnce({
      path: 'blob:dropped',
      fileName: 'dropped.mp4',
      durationSeconds: 6,
      kind: 'video',
    });
    function Host(): JSX.Element {
      const project = newProject('Empty');
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    const file = new File(['x'], 'dropped.mp4', { type: 'video/mp4' });
    const dataTransfer = { files: [file], types: ['Files'], getData: () => '' };
    const root = screen.getByLabelText('bin root');
    fireEvent.dragOver(root, { dataTransfer });
    fireEvent.drop(root, { dataTransfer });
    await waitFor(() =>
      expect(screen.getByLabelText('import status').textContent).toContain('Imported 1 file.'),
    );
  });

  it('renders a large asset list through the virtualized bin', () => {
    // A bin with many clips must still surface every asset (the windowed list
    // mounts all rows when the viewport is unmeasured, e.g. in jsdom) — the fix
    // for the sluggish bin once dozens of videos/images are imported.
    let project = newProject('Big bin');
    for (let i = 0; i < 60; i += 1) {
      project = addAsset(project, { id: `asset_${i}`, path: `clip_${i}.mp4`, kind: 'video' });
    }
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    // First, middle, and last assets are all present (none silently dropped).
    expect(screen.getByLabelText('asset asset_0')).toBeDefined();
    expect(screen.getByLabelText('asset asset_30')).toBeDefined();
    expect(screen.getByLabelText('asset asset_59')).toBeDefined();
    // The list is the virtualized container (windowing is active).
    expect(screen.getByLabelText('assets').classList.contains('bin-vlist')).toBe(true);
  });

  it('surfaces a probe error as status', async () => {
    vi.mocked(probeMediaFile).mockRejectedValueOnce(new Error('Could not read media: bad.mp4'));
    function Host(): JSX.Element {
      const project = newProject('Empty');
      const editor = useEditor(project.timeline, binOpts(project));
      return <MediaBin editor={editor} project={project} />;
    }
    render(<Host />);
    fireEvent.change(screen.getByLabelText('import media'), {
      target: { files: [new File(['x'], 'bad.mp4', { type: 'video/mp4' })] },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('import status').textContent).toContain('Could not read media'),
    );
  });
});

describe('EffectsPanel — effect-layer library (schema v13, ADR 0088)', () => {
  // Favourites/recents persist to localStorage on purpose (they follow the user
  // across projects), which means they also persist across tests in a shared
  // jsdom environment. Clearing them keeps this suite order-independent.
  beforeEach(() => {
    for (const key of EFFECT_LIBRARY_STORAGE_KEYS) globalThis.localStorage.removeItem(key);
  });

  function Host(): JSX.Element {
    const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
    return (
      <>
        <span data-testid="fx-count">
          {editor.state.timeline.tracks.reduce(
            (total, track) => total + (track.effectLayers?.length ?? 0),
            0,
          )}
        </span>
        <EffectsPanel editor={editor} />
      </>
    );
  }

  it('needs NO clip selection — an effect applies to whatever is beneath it', () => {
    // The old panel gated every tile behind a clip selection. That is wrong for a
    // layer: it is not attached to a clip, so gating would block the normal case.
    render(<Host />);
    expect(screen.queryByText('Select a clip to apply effects.')).toBeNull();
    expect(screen.getByRole('button', { name: /^Halo Bloom\./ })).not.toHaveProperty(
      'disabled',
      true,
    );
  });

  it('applies an effect as a new layer at the playhead', () => {
    render(<Host />);
    expect(screen.getByTestId('fx-count').textContent).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: /^Halo Bloom\./ }));
    // One layer, and it landed on a newly created effect lane in ONE patch.
    expect(screen.getByTestId('fx-count').textContent).toBe('1');
  });

  it('marks an applied effect as in use', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /^Halo Bloom\./ }));
    expect(screen.getByText('In use')).toBeDefined();
  });

  it('filters by search across labels, tags and descriptions', () => {
    render(<Host />);
    const search = screen.getByLabelText('search effects');
    fireEvent.change(search, { target: { value: 'kaleido' } });
    expect(screen.getByRole('button', { name: /^Kaleidoscope\./ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Halo Bloom\./ })).toBeNull();

    // A tag synonym the label does not contain — the point of tags.
    fireEvent.change(search, { target: { value: 'teal orange' } });
    expect(screen.getByRole('button', { name: /^Teal & Amber\./ })).toBeDefined();
  });

  it('reports a miss with an actionable empty state', () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText('search effects'), {
      target: { value: 'zzzznotathing' },
    });
    expect(screen.getByText(/No effects match/)).toBeDefined();
  });

  it('filters by category from the rail', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /Glitch & Digital/ }));
    expect(screen.getByRole('button', { name: /^Block Shift\./ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Halo Bloom\./ })).toBeNull();
  });

  it('toggles a favourite and surfaces it on the Favourites shelf', () => {
    render(<Host />);
    // Favourites starts empty, and its empty state says how to fill it rather
    // than being a dead end.
    fireEvent.click(screen.getByRole('button', { name: /Favourites/ }));
    expect(screen.getByText(/No favourites yet/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /All effects/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Halo Bloom to favourites' }));
    fireEvent.click(screen.getByRole('button', { name: /Favourites/ }));
    expect(screen.getByRole('button', { name: /^Halo Bloom\./ })).toBeDefined();
  });

  it('records an applied effect on the Recently used shelf', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /Recently used/ }));
    expect(screen.getByText(/Nothing used yet/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /All effects/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Halo Bloom\./ }));
    fireEvent.click(screen.getByRole('button', { name: /Recently used/ }));
    expect(screen.getByRole('button', { name: /^Halo Bloom\./ })).toBeDefined();
  });

  it('offers Popular and Recommended shelves that are not empty', () => {
    render(<Host />);
    for (const shelf of [/Recommended/, /Popular/]) {
      fireEvent.click(screen.getByRole('button', { name: shelf }));
      expect(screen.queryByText(/No effects match/)).toBeNull();
    }
  });

  it('makes every tile draggable onto the timeline', () => {
    render(<Host />);
    const tile = screen.getByRole('button', { name: /^Halo Bloom\./ });
    expect(tile.getAttribute('draggable')).toBe('true');
    const setData = vi.fn();
    fireEvent.dragStart(tile, { dataTransfer: { setData, types: [] } });
    expect(setData).toHaveBeenCalledWith(EFFECT_DND_TYPE, 'halo-bloom');
  });
});

describe('Inspector transition section (M3b)', () => {
  // The effect lives on the *incoming* clip, so it's added with the earlier clip
  // (clip_intro) selected and inspected on the later clip (clip_body) — the same
  // hop the on-cut pill makes when clicked.
  function Host(): JSX.Element {
    const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
    return (
      <>
        <button type="button" onClick={() => editor.select('clip_intro')}>
          pick-from
        </button>
        <button type="button" onClick={() => editor.select('clip_body')}>
          pick-into
        </button>
        {/* Transitions are per-CLIP operations at a cut, not effect layers, so
            this drives the patch builder directly instead of going through the
            effects panel (which is now exclusively the effect-layer library). */}
        <button
          type="button"
          onClick={() => {
            const patch = addTransitionPatch(editor.state.timeline, 'clip_intro', 'fade', 0.5);
            if (patch) editor.applyPatch(patch);
          }}
        >
          add-fade
        </button>
        <Inspector editor={editor} />
      </>
    );
  }

  it('appears only once a transition exists, then swaps kind and removes it', () => {
    render(<Host />);
    // Inspecting the incoming clip with no transition → no Transition section.
    fireEvent.click(screen.getByRole('button', { name: 'pick-into' }));
    expect(screen.queryByLabelText('transition settings')).toBeNull();
    // Add a fade entering clip_body via the browser (from clip_intro).
    fireEvent.click(screen.getByRole('button', { name: 'pick-from' }));
    fireEvent.click(screen.getByRole('button', { name: 'add-fade' }));
    // Select the incoming clip (as the pill click does) → controls appear.
    fireEvent.click(screen.getByRole('button', { name: 'pick-into' }));
    // The Transition section lives under its own category tab now.
    fireEvent.click(screen.getByRole('tab', { name: 'Transition' }));
    expect(screen.getByLabelText('transition settings')).toBeDefined();
    // Swap the kind to zoom (a discrete, immediately-committed patch).
    fireEvent.change(screen.getByLabelText('transition kind'), { target: { value: 'zoom' } });
    // Remove it → the section disappears again.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByLabelText('transition settings')).toBeNull();
  });
});

describe('Inspector text overlay (#5)', () => {
  const textTimeline: Timeline = {
    tracks: [
      {
        id: 'overlay_1',
        type: 'overlay',
        clips: [
          {
            id: 'txt1',
            assetId: '__text__',
            trackId: 'overlay_1',
            start: 0,
            end: 3,
            sourceStart: 0,
            sourceEnd: 3,
            effects: [{ id: 'txt1__text', type: 'text', params: { text: 'Hello' }, keyframes: [] }],
            keyframes: [],
          },
        ],
      },
    ],
  };

  function Host(): JSX.Element {
    const editor = useEditor(textTimeline);
    return (
      <>
        <button type="button" onClick={() => editor.select('txt1')}>
          pick-text
        </button>
        <Inspector editor={editor} />
      </>
    );
  }

  it('shows the Text section only for a text overlay and edits its params reversibly', () => {
    render(<Host />);
    // No Text section until a text overlay is selected.
    expect(screen.queryByLabelText('text')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'pick-text' }));
    expect(screen.getByLabelText('text')).toBeDefined();

    // Editing the content commits and round-trips through the store.
    const content = screen.getByLabelText('text content') as HTMLTextAreaElement;
    expect(content.value).toBe('Hello');
    fireEvent.change(content, { target: { value: 'Updated' } });
    expect((screen.getByLabelText('text content') as HTMLTextAreaElement).value).toBe('Updated');

    // The colour control commits a styling change without error.
    const color = screen.getByLabelText('text color') as HTMLInputElement;
    fireEvent.change(color, { target: { value: '#ff0000' } });
    expect((screen.getByLabelText('text color') as HTMLInputElement).value).toBe('#ff0000');
  });
});

describe('Inspector keyframes', () => {
  function Host(): JSX.Element {
    const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
    return (
      <>
        <button type="button" onClick={() => editor.select('clip_intro')}>
          pick
        </button>
        <Inspector editor={editor} />
      </>
    );
  }

  it('adds a punch-in to the selected clip', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add punch-in' }));
    // The read-out is no longer a dump of every keyframe (revamp Phase 5 replaced it
    // with real property rows): a punch-in shows up as scale being animated, and as
    // the scale field reading the curve at the playhead.
    expect(screen.getByLabelText('animated properties').textContent).toContain('scale');
    expect((screen.getByLabelText('scale') as HTMLInputElement).value).toBe('1');
  });

  it('animates a property from its own row, not a separate form', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    // Revamp Phase 5, F5: the affordance is the diamond next to the value, and the
    // standalone property/value/easing form is gone.
    expect(screen.queryByLabelText('keyframe property')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /animate opacity/i }));
    expect(screen.getByLabelText('animated properties').textContent).toContain('opacity');
  });

  it('shows the empty state until a clip is selected', () => {
    render(<Host />);
    expect(screen.getByLabelText('inspector').textContent).toContain('Nothing selected');
  });

  it("opens the mask panel on the selected clip's mask stack", () => {
    // Schema v22 (ADR 0178): a mask is a layer on `clip.masks` in source pixels, so the
    // clip's media must carry a probed size. Shapes are drawn on the monitor (MK4.1); the
    // Inspector lists the stack and picks the drawing tool.
    const measured = demoProject.assets.map((asset) =>
      asset.id === 'asset_intro' ? { ...asset, media: { width: 1920, height: 1080 } } : asset,
    );
    function MeasuredHost(): JSX.Element {
      const editor = useEditor(demoProject.timeline, { assets: measured });
      return (
        <>
          <button type="button" onClick={() => editor.select('clip_intro')}>
            pick
          </button>
          <Inspector editor={editor} />
        </>
      );
    }
    render(<MeasuredHost />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    // Mask lives under its own category tab (industry inspector panel revamp).
    fireEvent.click(screen.getByRole('tab', { name: 'Mask' }));
    expect(screen.getByText('No masks yet. Draw one on the monitor.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Draw rectangle mask' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says to measure the media instead of silently not adding a mask', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Mask' }));
    expect(screen.getByRole('alert').textContent).toContain('Measure this media first');
  });

  it('sets audio fade + mute on the selected clip', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Audio' }));
    fireEvent.change(screen.getByLabelText('fade in'), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText('mute'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply audio' }));
    expect(screen.getByLabelText('effects').textContent).toContain('audio_gain');
  });

  it('applies a color grade and then resets it to identity', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Color' }));
    // Editing an axis enables Apply; applying attaches one color_grade effect.
    fireEvent.change(screen.getByLabelText('saturation'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply adjustments' }));
    expect(screen.getByLabelText('effects').textContent).toContain('color_grade');
    // Reset writes an identity grade and disables itself.
    const reset = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement;
    fireEvent.click(reset);
    expect(reset.disabled).toBe(true);
  });
});

describe('Inspector speed/crop/blend mode (H1.2h)', () => {
  function Host(): JSX.Element {
    const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
    return (
      <>
        <button type="button" onClick={() => editor.select('clip_intro')}>
          pick
        </button>
        <Inspector editor={editor} />
      </>
    );
  }

  it('disables the speed/crop/blend controls until a clip is selected', () => {
    render(<Host />);
    expect(screen.queryByLabelText('speed')).toBeNull();
    expect(screen.queryByLabelText('crop')).toBeNull();
    expect(screen.queryByLabelText('blend mode')).toBeNull();
  });

  it('sets a clip speed preset and applies it as one reversible patch', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    const speed = within(screen.getByLabelText('speed'));
    // At the default 1x there is nothing to apply, so the button is not offered.
    expect(speed.queryByRole('button', { name: 'Apply speed' })).toBeNull();
    // Revamp Phase 10c: a preset is a discrete choice, so it COMMITS on click —
    // matching the reverse/freeze toggles beside it. "Apply speed" exists for the
    // scrub field, which is a drag and would otherwise emit a patch per tick.
    fireEvent.click(speed.getByRole('button', { name: '2x' }));
    expect(speed.getByRole('button', { name: '2x' }).getAttribute('aria-pressed')).toBe('true');
    expect(speed.queryByRole('button', { name: 'Apply speed' })).toBeNull(); // already committed
  });

  it('resets speed back to 1x', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    const speed = within(screen.getByLabelText('speed'));
    expect(speed.queryByRole('button', { name: 'Reset speed' })).toBeNull(); // already 1x
    fireEvent.click(speed.getByRole('button', { name: '2x' }));
    fireEvent.click(speed.getByRole('button', { name: 'Reset speed' }));
    expect(speed.queryByRole('button', { name: 'Reset speed' })).toBeNull();
    expect(speed.getByRole('button', { name: '1x' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('sets a clip crop rect and applies it as one reversible patch', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    const crop = within(screen.getByLabelText('crop'));
    const apply = crop.getByRole('button', { name: 'Apply crop' });
    expect(apply).toHaveProperty('disabled', true); // no-op at the default full frame
    fireEvent.change(crop.getByLabelText('crop width'), { target: { value: '0.5' } });
    expect(apply).toHaveProperty('disabled', false);
    fireEvent.click(apply);
    expect(apply).toHaveProperty('disabled', true); // committed now matches
  });

  it('sets a clip blend mode instantly on change (no Apply button)', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'blend mode' }));
    fireEvent.click(screen.getByRole('option', { name: 'multiply' }));
    // Committed immediately: the trigger now shows the applied value, and no
    // Apply button exists for this control (unlike speed/crop).
    expect(screen.getByRole('combobox', { name: 'blend mode' }).textContent).toContain('multiply');
    expect(screen.queryByRole('button', { name: 'Apply blend mode' })).toBeNull();
  });
});

describe('TimelineView drag-and-drop', () => {
  const dnd = (assetId: string) => ({
    dataTransfer: {
      types: [ASSET_DND_TYPE],
      dropEffect: '',
      getData: (type: string) => (type === ASSET_DND_TYPE ? assetId : ''),
    },
  });
  const videoLane = (): Element =>
    screen.getByLabelText('track video_1').querySelector('.track-lane')!;

  it('places an asset dropped from the bin onto a lane', () => {
    function Host(): JSX.Element {
      const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
      return <TimelineView editor={editor} assets={demoProject.assets} />;
    }
    const { container } = render(<Host />);
    expect(clipCount(container)).toBe(3);
    const lane = videoLane();
    fireEvent.dragOver(lane, dnd('asset_intro'));
    fireEvent.drop(lane, dnd('asset_intro'));
    expect(clipCount(container)).toBe(4);
  });

  it('ignores a drop carrying an unknown asset id', () => {
    function Host(): JSX.Element {
      const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
      return <TimelineView editor={editor} assets={demoProject.assets} />;
    }
    const { container } = render(<Host />);
    fireEvent.drop(videoLane(), dnd('asset_ghost'));
    expect(clipCount(container)).toBe(3);
  });

  it('ignores a drop with no asset payload', () => {
    function Host(): JSX.Element {
      const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
      return <TimelineView editor={editor} assets={demoProject.assets} />;
    }
    const { container } = render(<Host />);
    fireEvent.drop(videoLane(), dnd(''));
    expect(clipCount(container)).toBe(3);
  });

  it('uses a coarser ruler step, labelled only as finely as that step resolves', () => {
    function Host(): JSX.Element {
      const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
      return (
        <>
          <button type="button" onClick={() => editor.setZoom(10)}>
            set zoom to 10px/s
          </button>
          <TimelineView editor={editor} assets={demoProject.assets} fps={30} />
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'set zoom to 10px/s' }));
    // At 10 px/s the ruler steps every 10s, so the label carries minutes and
    // seconds and nothing else: the hour field is constant across a 14s sequence
    // and the frame field is constant across a 10s step, so both are dropped
    // (`compactTimeLabel`). The full `00:00:10:00` needs ~78px of tabular digits
    // against the ~72px `rulerTicks` leaves between labels, which is why every
    // label used to collide with its neighbour and the first was clipped.
    expect(screen.getByText('0:10')).toBeDefined();
    expect(screen.queryByText('00:00:10:00')).toBeNull();
  });

  it('adds the frame field only once the ruler resolves finer than a second', () => {
    function Host(): JSX.Element {
      const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
      return (
        <>
          <button type="button" onClick={() => editor.setZoom(240)}>
            zoom in
          </button>
          <TimelineView editor={editor} assets={demoProject.assets} fps={30} />
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'zoom in' }));
    // 240 px/s is MAX_PX_PER_SECOND, and it puts the ~72px major step at 10
    // frames — under a second. Frames are then the field that distinguishes one
    // tick from the next, so the label grows a third group rather than repeating
    // an identical `0:00` at every tick.
    expect(screen.getByText('0:00:10')).toBeDefined();
  });
});

describe('TimelineView layers', () => {
  it('labels overlay clips by text and renders keyframe + transition markers', () => {
    const timeline: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_0',
              assetId: 'asset_x',
              trackId: 'video_1',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              keyframes: [],
              effects: [],
            },
            {
              id: 'clip_a',
              assetId: 'asset_x',
              trackId: 'video_1',
              start: 4,
              end: 8,
              sourceStart: 0,
              sourceEnd: 4,
              keyframes: [{ id: 'k1', property: 'scale', value: 1.2, time: 1, easing: 'linear' }],
              // Transition entering clip_a from the adjacent earlier clip_0 — the
              // on-cut pill (M3b) renders only for a validator-legal adjacency.
              effects: [
                {
                  id: 'clip_a__transition',
                  type: 'transition',
                  params: { kind: 'fade', durationSeconds: 0.5, fromClipId: 'clip_0' },
                  keyframes: [],
                },
              ],
            },
          ],
        },
        {
          id: 'overlay_1',
          type: 'overlay',
          clips: [
            {
              id: 'clip_ov',
              assetId: '__text__',
              trackId: 'overlay_1',
              start: 1,
              end: 3,
              sourceStart: 0,
              sourceEnd: 2,
              keyframes: [],
              effects: [
                { id: 'clip_ov__text', type: 'text', params: { text: 'Hello' }, keyframes: [] },
              ],
            },
          ],
        },
      ],
    };
    function Host(): JSX.Element {
      const editor = useEditor(timeline);
      return <TimelineView editor={editor} />;
    }
    const { container } = render(<Host />);
    // Overlay clip reads its text, not a raw id.
    expect(within(container).getByText('Hello')).toBeDefined();
    // Keyframe markers on the clip; the transition renders as an on-cut pill.
    expect(container.querySelector('.clip-keyframe')).not.toBeNull();
    expect(container.querySelector('.clip-transition-pill')).not.toBeNull();
  });

  it('renders persisted markers/chapters with a label tooltip + color (schema v9)', () => {
    const timeline: Timeline = { tracks: [] };
    function Host(): JSX.Element {
      const editor = useEditor(timeline, {
        markers: [
          { id: 'm_plain', time: 2 },
          { id: 'm_chapter', time: 6, label: 'Chapter 2', color: '#ff8800' },
        ],
      });
      return <TimelineView editor={editor} />;
    }
    const { container } = render(<Host />);
    expect(screen.getByLabelText('marker at 2s')).toBeDefined();
    const chapterTick = screen.getByLabelText('marker "Chapter 2" at 6s');
    expect(chapterTick.title).toBe('Chapter 2');
    expect(chapterTick.style.background).toBe('rgb(255, 136, 0)');
    expect(container.querySelectorAll('.marker-tick')).toHaveLength(2);
  });
});

/** Build a project that has an empty overlay track, needed by OverlaysPanel. */
function projectWithOverlayTrack(): Project {
  const base = newProject('Overlay Test');
  return parseProject({
    ...base,
    timeline: {
      tracks: [{ id: 'overlay_1', type: 'overlay', clips: [] }],
    },
  });
}

describe('OverlaysPanel (Text panel)', () => {
  beforeEach(() => {
    // The chip and the recent styles are view preferences; each test starts from none.
    for (const key of [
      'framepilot.view.textCategory',
      'framepilot.view.textRecentTemplates',
      'framepilot.view.textPanelTab',
      'framepilot.view.textFontCategory',
    ]) {
      globalThis.localStorage.removeItem(key);
    }
  });

  /** The panel beside a timeline, and the live editor so a test can read what was built. */
  function renderTextPanel(onOpenElements?: () => void) {
    const live: { editor: ReturnType<typeof useEditor> | null } = { editor: null };
    function Host(): JSX.Element {
      const project = projectWithOverlayTrack();
      const editor = useEditor(project.timeline);
      live.editor = editor;
      return (
        <>
          <OverlaysPanel editor={editor} {...(onOpenElements ? { onOpenElements } : {})} />
          <TimelineView editor={editor} />
        </>
      );
    }
    const view = render(<Host />);
    const titles = () =>
      live
        .editor!.state.timeline.tracks.flatMap((t) => t.clips)
        .filter((c) => c.effects.some((e) => e.type === 'text'));
    return { ...view, live, titles };
  }

  it('adds a title to a project with no overlay lane by making one on top', () => {
    const live: { editor: ReturnType<typeof useEditor> | null } = { editor: null };
    function Host(): JSX.Element {
      const editor = useEditor(demoProject.timeline);
      live.editor = editor;
      return <OverlaysPanel editor={editor} />;
    }
    render(<Host />);
    expect(live.editor!.state.timeline.tracks.some((t) => t.type === 'overlay')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add a heading' }));
    const [top] = live.editor!.state.timeline.tracks;
    expect(top!.type).toBe('overlay');
    expect(top!.clips[0]!.effects[0]!.params).toMatchObject({ templateId: 'heading' });
  });

  it('adds a heading at the playhead in its whole look and selects it', () => {
    const { container, live, titles } = renderTextPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add a heading' }));
    expect(clipCount(container)).toBe(1);
    const [title] = titles();
    expect(title!.effects[0]!.params).toMatchObject({
      text: 'Add a heading',
      fontFamily: 'Inter',
      fontWeight: 800,
      templateId: 'heading',
    });
    expect(title!.effects[0]!.params.typography).toBeDefined();
    expect(live.editor!.state.selectedIds).toEqual([title!.id]);
  });

  it('adds a template from its tile, drawn in its own font', () => {
    const { titles } = renderTextPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Titles' }));
    const tile = screen.getByRole('button', { name: 'Add Retro pop title' });
    expect((tile.querySelector('.text-tile-sample') as HTMLElement).style.fontFamily).toContain(
      'Luckiest Guy',
    );
    fireEvent.click(tile);
    expect(titles()[0]!.effects[0]!.params).toMatchObject({
      text: 'Game on',
      fontFamily: 'Luckiest Guy',
      templateId: 'retro-pop',
    });
  });

  it('filters by name, category and font, and says when nothing matches', () => {
    renderTextPanel();
    const search = screen.getByRole('searchbox', { name: 'Search text styles' });
    fireEvent.change(search, { target: { value: 'neon' } });
    const results = screen.getByRole('list', { name: 'Matching text styles' });
    expect(
      within(results)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Add Neon sign title']);
    fireEvent.change(search, { target: { value: 'lower thirds' } });
    expect(
      within(screen.getByRole('list', { name: 'Matching text styles' })).getAllByRole('button')
        .length,
    ).toBe(8);
    fireEvent.change(search, { target: { value: 'zzzz' } });
    expect(screen.getByText(/Nothing matched/)).toBeDefined();
  });

  it('shows every style category under All, including Script and Retro', () => {
    renderTextPanel();
    for (const name of [
      'Basic',
      'Titles',
      'Lower thirds',
      'Callouts',
      'Social',
      'Quotes',
      'Script',
      'Retro & fun',
    ]) {
      expect(screen.getByRole('list', { name: `${name} text styles` })).toBeDefined();
    }
    expect(screen.queryByRole('button', { name: 'Caption looks' })).toBeNull();
  });

  it('lists every caption font in the Fonts tab and adds a heading in the one picked', () => {
    const { titles, live } = renderTextPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Fonts' }));
    const fonts = screen.getByRole('list', { name: 'Fonts' });
    expect(within(fonts).getAllByRole('button')).toHaveLength(CAPTION_FONT_CATALOG.length);
    const row = within(fonts).getByRole('button', { name: 'Add a heading in Bebas Neue' });
    expect((row.querySelector('.text-font-name') as HTMLElement).style.fontFamily).toContain(
      'Bebas Neue',
    );
    fireEvent.click(row);
    const [title] = titles();
    // Bebas Neue ships one weight: the heading takes it rather than asking for 800.
    expect(title!.effects[0]!.params).toMatchObject({
      fontFamily: 'Bebas Neue',
      fontWeight: 400,
      templateId: 'heading',
    });
    expect(live.editor!.state.selectedIds).toEqual([title!.id]);
  });

  it('sets the selected title in the font picked, and marks it', () => {
    const { titles } = renderTextPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add a heading' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Fonts' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search fonts' }), {
      target: { value: 'playfair' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Use Playfair Display for the selected title' }),
    );
    expect(titles()).toHaveLength(1);
    expect(titles()[0]!.effects[0]!.params).toMatchObject({
      fontFamily: 'Playfair Display',
      fontWeight: 800,
      text: 'Add a heading',
    });
    expect(
      screen
        .getByRole('button', { name: 'Use Playfair Display for the selected title' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('filters fonts by category', () => {
    renderTextPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Fonts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Monospace' }));
    const names = within(screen.getByRole('list', { name: 'Fonts' }))
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toContain('Add a heading in JetBrains Mono');
    expect(names).not.toContain('Add a heading in Inter');
  });

  it('remembers what was used in a Recent row', () => {
    renderTextPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add a subheading' }));
    const recent = screen.getByRole('list', { name: 'Recent text styles' });
    expect(within(recent).getByRole('button', { name: 'Add Subheading title' })).toBeDefined();
  });

  it('restyles the selected title with Apply, keeping its words and place', () => {
    const { titles } = renderTextPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add a heading' }));
    const before = titles()[0]!.effects[0]!.params;
    fireEvent.click(screen.getByRole('button', { name: 'Titles' }));
    fireEvent.click(screen.getByRole('button', { name: 'apply Retro pop to the selected title' }));
    expect(titles()).toHaveLength(1);
    expect(titles()[0]!.effects[0]!.params).toMatchObject({
      text: before.text,
      xPercent: before.xPercent,
      yPercent: before.yPercent,
      fontFamily: 'Luckiest Guy',
      templateId: 'retro-pop',
    });
    // The applied template is marked on its tile.
    expect(
      screen.getByRole('button', { name: 'Add Retro pop title' }).closest('.text-tile')?.className,
    ).toContain('is-applied');
  });

  it('offers Apply only while a title is selected', () => {
    renderTextPanel();
    expect(screen.queryByRole('button', { name: /^apply / })).toBeNull();
  });

  it('lists titles, edits one in place and deletes it', () => {
    const { titles } = renderTextPanel();
    expect(screen.getByText('No titles yet.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Add a heading' }));
    const list = screen.getByRole('list', { name: 'overlay list' });
    fireEvent.doubleClick(within(list).getByText('Add a heading'));
    const input = within(list).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Launch day' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(titles()[0]!.effects[0]!.params).toMatchObject({ text: 'Launch day', fontWeight: 800 });
    fireEvent.click(within(list).getByLabelText(/delete overlay/));
    expect(screen.getByText('No titles yet.')).toBeDefined();
  });

  it('points shapes and stickers at Elements', () => {
    const onOpenElements = vi.fn();
    renderTextPanel(onOpenElements);
    fireEvent.click(screen.getByRole('button', { name: 'Elements' }));
    expect(onOpenElements).toHaveBeenCalledTimes(1);
  });
});
