/**
 * Tests for the MediaBin import flow's engine-media attachment (plan Phase 8 —
 * real thumbnail previews). The DOM media probe and the disk copy are impure
 * (jsdom has no media pipeline), so the import module is mocked: the bin's job is
 * to thread the *derived* `AssetMedia` from `deriveEngineMedia` onto the asset it
 * adds (so the timeline filmstrip can draw real frames) and to keep importing when
 * derivation fails (engine down → skeleton, never a blocked import).
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { Asset, AssetMedia, Clip, Folder, Project } from '@framepilot/timeline-schema';
import { parseProject } from '@framepilot/timeline-schema';
import { MediaBin } from './MediaBin.js';
import { TimelineView } from './TimelineView.js';
import { useEditor } from '../editor/useEditor.js';
import { newProject } from '../editor/project.js';

const clipCount = (container: HTMLElement): number =>
  container.querySelectorAll('.clip-block').length;

// Mock the impure import helpers; `buildAsset` stays real so the test exercises
// the actual attach logic (engineMedia → asset.media).
const deriveEngineMedia = vi.fn<(path: string) => Promise<AssetMedia | undefined>>();
vi.mock('../editor/import.js', async () => {
  const actual = await vi.importActual<typeof import('../editor/import.js')>('../editor/import.js');
  return {
    ...actual,
    probeMediaFile: vi.fn(async (file: File) => ({
      path: 'blob:probe',
      fileName: file.name,
      durationSeconds: 10,
      kind: 'video' as const,
    })),
    materializeImportedMedia: vi.fn(async () => ({
      path: 'media/p/clip.mp4',
      fileName: 'clip.mp4',
      durationSeconds: 10,
      kind: 'video' as const,
    })),
    deriveEngineMedia: (path: string) => deriveEngineMedia(path),
  };
});

const project = newProject('Bin Test');

/** Render the MediaBin against a live editor store and return the store handle. */
function renderBin() {
  const { result } = renderHook(() => useEditor(project.timeline, { assets: [], folders: [] }));
  const view = render(<MediaBin editor={result.current} project={project} />);
  return { result, view };
}

/** Upload one fake file through the bin's file input. */
async function uploadFile(view: ReturnType<typeof render>): Promise<void> {
  const input = view.getByLabelText('import media') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], 'clip.mp4', { type: 'video/mp4' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Let the async importFiles loop (probe → materialize → derive → patch) settle.
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('MediaBin import → engine media attach', () => {
  beforeEach(() => {
    deriveEngineMedia.mockReset();
  });

  it('attaches engine-derived media onto the imported asset', async () => {
    deriveEngineMedia.mockResolvedValue({
      peaks: [0.1, 0.2],
      peaksPerSecond: 10,
      thumbnailPaths: ['media/p/t0.jpg', 'media/p/t1.jpg'],
    });
    const { result, view } = renderBin();
    await uploadFile(view);

    expect(deriveEngineMedia).toHaveBeenCalledWith('media/p/clip.mp4');
    const asset: Asset | undefined = result.current.state.assets[0];
    expect(asset?.media).toEqual({
      peaks: [0.1, 0.2],
      peaksPerSecond: 10,
      thumbnailPaths: ['media/p/t0.jpg', 'media/p/t1.jpg'],
    });
  });

  it('still imports the asset (without media) when derivation fails', async () => {
    deriveEngineMedia.mockResolvedValue(undefined);
    const { result, view } = renderBin();
    await uploadFile(view);

    const asset: Asset | undefined = result.current.state.assets[0];
    expect(asset).toBeDefined();
    expect(asset?.path).toBe('media/p/clip.mp4');
    expect(asset?.media).toBeUndefined();
  });
});

describe('MediaBin unified search (footage search v1, H1.5/J4)', () => {
  const asset: Asset = { id: 'asset_1', path: 'media/interview.mp4', kind: 'video' };
  const clip: Clip = {
    id: 'clip_1',
    assetId: asset.id,
    trackId: 'track_1',
    start: 0,
    end: 10,
    sourceStart: 0,
    sourceEnd: 10,
    effects: [],
    keyframes: [],
  };
  const timeline = { tracks: [{ id: 'track_1', type: 'video' as const, clips: [clip] }] };

  /** A project with a real transcript, mapped onto `clip` on the timeline. */
  function transcribedProject(): Project {
    return parseProject({
      ...newProject('Search Test'),
      assets: [asset],
      timeline,
      transcript: [
        { word: 'Thanks', start: 0, end: 1 },
        { word: 'for', start: 1, end: 2 },
        { word: 'watching', start: 2, end: 3 },
        { word: 'the', start: 3, end: 4 },
        { word: 'category', start: 4, end: 5 },
      ],
    });
  }

  /** Render the bin against a store already seeded with `project`'s asset/timeline. */
  function renderSearchBin(project: Project) {
    const { result } = renderHook(() =>
      useEditor(project.timeline, { assets: project.assets, folders: [] }),
    );
    const view = render(<MediaBin editor={result.current} project={project} />);
    return { result, view };
  }

  it('shows an honest empty state when there is no transcript yet', () => {
    const project = parseProject({ ...newProject('No Transcript'), assets: [asset] });
    const { view } = renderSearchBin(project);
    fireEvent.change(view.getByLabelText('search media and transcript'), {
      target: { value: 'watching' },
    });
    expect(view.getByText('Transcribe your footage to search what is said.')).toBeTruthy();
  });

  it('finds a whole-word transcript match and not a substring false-positive', () => {
    const project = transcribedProject();
    const { view } = renderSearchBin(project);
    const input = view.getByLabelText('search media and transcript');

    // "cat" must not match inside "category" (whole-word matching).
    fireEvent.change(input, { target: { value: 'cat' } });
    expect(view.queryByLabelText('transcript matches')).toBeNull();
    expect(view.getByText(/No spoken matches/)).toBeTruthy();

    // The whole word matches.
    fireEvent.change(input, { target: { value: 'category' } });
    expect(view.getByLabelText('transcript matches')).toBeTruthy();
    expect(view.getByText(/Thanks for watching the category/)).toBeTruthy();
  });

  it('seeks the playhead to the matched word on click', () => {
    const project = transcribedProject();
    const { result, view } = renderSearchBin(project);
    fireEvent.change(view.getByLabelText('search media and transcript'), {
      target: { value: 'watching' },
    });
    expect(result.current.getPlayhead()).toBe(0);

    const snippet = view.getByText('Thanks for watching the category');
    const resultButton = snippet.closest('button');
    expect(resultButton).toBeTruthy();
    act(() => {
      fireEvent.click(resultButton!);
    });
    // "watching" is the transcript's 3rd word, starting at t=2.
    expect(result.current.getPlayhead()).toBe(2);
  });

  it('also surfaces filename matches alongside transcript matches', () => {
    const project = transcribedProject();
    const { view } = renderSearchBin(project);
    fireEvent.change(view.getByLabelText('search media and transcript'), {
      target: { value: 'interview' },
    });
    expect(view.getByLabelText(`asset ${asset.id}`)).toBeTruthy();
  });
});

describe('MediaBin → Source monitor wiring (H1.7, J3)', () => {
  const asset: Asset = { id: 'asset_1', path: 'media/interview.mp4', kind: 'video' };
  const project = parseProject({ ...newProject('Source Test'), assets: [asset] });

  /** A card click/dblclick plus a sibling TimelineView to observe real clip placement. */
  function renderBinWithTimeline(onOpenInSource?: (a: Asset) => void) {
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, { assets: project.assets, folders: [] });
      return (
        <>
          <MediaBin
            editor={editor}
            project={project}
            {...(onOpenInSource ? { onOpenInSource } : {})}
          />
          <TimelineView editor={editor} assets={project.assets} />
        </>
      );
    }
    return render(<Host />);
  }

  it('clicking a card calls onOpenInSource with that asset (does not add to timeline)', () => {
    const onOpenInSource = vi.fn();
    const view = renderBinWithTimeline(onOpenInSource);
    fireEvent.click(view.getByLabelText(`asset ${asset.id}`));
    expect(onOpenInSource).toHaveBeenCalledWith(asset);
    expect(clipCount(view.container)).toBe(0);
  });

  it('double-clicking a card still adds it to the timeline (existing behavior preserved)', () => {
    const onOpenInSource = vi.fn();
    const view = renderBinWithTimeline(onOpenInSource);
    fireEvent.doubleClick(view.getByLabelText(`asset ${asset.id}`));
    expect(clipCount(view.container)).toBe(1);
  });

  it('clicking the "add to timeline" icon button does not also fire onOpenInSource', () => {
    const onOpenInSource = vi.fn();
    const view = renderBinWithTimeline(onOpenInSource);
    fireEvent.click(view.getByLabelText(`add ${asset.id} to timeline`));
    expect(onOpenInSource).not.toHaveBeenCalled();
    expect(clipCount(view.container)).toBe(1);
  });

  it('rendering without onOpenInSource does not throw when a card is clicked', () => {
    const view = renderBinWithTimeline();
    expect(() => fireEvent.click(view.getByLabelText(`asset ${asset.id}`))).not.toThrow();
  });
});

describe('MediaBin card affordances by kind', () => {
  const card = (view: ReturnType<typeof render>, id: string): HTMLElement =>
    view.getByLabelText(`asset ${id}`);

  function renderBinWith(assets: readonly Asset[]): ReturnType<typeof render> {
    const project = parseProject({ ...newProject('Kind Test'), assets: [...assets] });
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, { assets: project.assets, folders: [] });
      return <MediaBin editor={editor} project={project} />;
    }
    return render(<Host />);
  }

  it('a still image shows neither a play overlay nor a duration badge', () => {
    const image: Asset = {
      id: 'img_1',
      path: 'media/photo.jpeg',
      kind: 'image',
      durationSeconds: 5, // default timeline length, NOT a media duration
    };
    const view = renderBinWith([image]);
    const el = card(view, 'img_1');
    expect(el.querySelector('.bin-card-play')).toBeNull();
    expect(el.querySelector('.bin-card-dur')).toBeNull();
  });

  it('a video keeps the play overlay and duration badge', () => {
    const video: Asset = {
      id: 'vid_1',
      path: 'media/clip.mp4',
      kind: 'video',
      durationSeconds: 5,
    };
    const view = renderBinWith([video]);
    const el = card(view, 'vid_1');
    expect(el.querySelector('.bin-card-play')).not.toBeNull();
    expect(el.querySelector('.bin-card-dur')?.textContent).toBe('0:05');
  });

  it('a video of unknown duration shows no badge rather than a dash placeholder', () => {
    const video: Asset = { id: 'vid_2', path: 'media/clip.mp4', kind: 'video' };
    const view = renderBinWith([video]);
    expect(card(view, 'vid_2').querySelector('.bin-card-dur')).toBeNull();
  });
});

/**
 * Keyboard operability. Every card action used to be mouse-only — the card was a
 * plain `<div>` with click handlers — so a keyboard user could reach the bin and
 * then do nothing in it. The grid is now one tab stop with arrow navigation.
 */
describe('MediaBin keyboard grid', () => {
  const assets: readonly Asset[] = Array.from({ length: 5 }, (_, i) => ({
    id: `v_${i}`,
    path: `media/clip${i}.mp4`,
    kind: 'video' as const,
  }));

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  /** The bin plus a sibling timeline, so placement is observable. */
  function renderGrid(onOpenInSource?: (a: Asset) => void) {
    const project = parseProject({ ...newProject('Keyboard Test'), assets: [...assets] });
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, { assets: project.assets, folders: [] });
      return (
        <>
          <MediaBin
            editor={editor}
            project={project}
            {...(onOpenInSource ? { onOpenInSource } : {})}
          />
          <TimelineView editor={editor} assets={project.assets} />
        </>
      );
    }
    return render(<Host />);
  }

  /** The tile's focusable open button for `id`. */
  const opener = (view: ReturnType<typeof render>, id: string): HTMLElement => {
    const el = view
      .getByLabelText(`asset ${id}`)
      .querySelector<HTMLButtonElement>('.bin-card-open');
    expect(el).not.toBeNull();
    return el!;
  };

  it('exposes exactly one tab stop for the whole grid (roving tabindex)', () => {
    const view = renderGrid();
    const tabbable = Array.from(view.container.querySelectorAll('.bin-card-open')).filter(
      (el) => el.getAttribute('tabindex') === '0',
    );
    expect(tabbable.length).toBe(1);
    // …and it is the FIRST card, so one Tab reaches the top of the grid.
    expect(tabbable[0]).toBe(opener(view, 'v_0'));
  });

  it('ArrowRight moves the tab stop (and focus) to the next card', () => {
    const view = renderGrid();
    act(() => opener(view, 'v_0').focus());
    fireEvent.keyDown(opener(view, 'v_0'), { key: 'ArrowRight' });
    expect(opener(view, 'v_1').getAttribute('tabindex')).toBe('0');
    expect(opener(view, 'v_0').getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(opener(view, 'v_1'));
  });

  it('ArrowDown moves by a whole row and ArrowLeft steps back', () => {
    const view = renderGrid();
    act(() => opener(view, 'v_0').focus());
    // Default density is 'L' (2 columns), so one row down is two cards on.
    fireEvent.keyDown(opener(view, 'v_0'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(opener(view, 'v_2'));
    fireEvent.keyDown(opener(view, 'v_2'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(opener(view, 'v_1'));
  });

  it('clamps at the grid edges instead of wrapping around', () => {
    const view = renderGrid();
    act(() => opener(view, 'v_0').focus());
    fireEvent.keyDown(opener(view, 'v_0'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(opener(view, 'v_0'));

    fireEvent.keyDown(opener(view, 'v_0'), { key: 'End' });
    expect(document.activeElement).toBe(opener(view, 'v_4'));
    fireEvent.keyDown(opener(view, 'v_4'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(opener(view, 'v_4'));

    fireEvent.keyDown(opener(view, 'v_4'), { key: 'Home' });
    expect(document.activeElement).toBe(opener(view, 'v_0'));
  });

  it('Enter opens the focused card in the Source monitor without placing it', () => {
    const onOpenInSource = vi.fn();
    const view = renderGrid(onOpenInSource);
    // Enter on a <button> is a click in a real browser; jsdom does not synthesize
    // it, so the click is what the keyboard path ultimately dispatches.
    fireEvent.click(opener(view, 'v_1'));
    expect(onOpenInSource).toHaveBeenCalledWith(assets[1]);
    expect(clipCount(view.container)).toBe(0);
  });

  it('Cmd+Enter places the focused card on the timeline', () => {
    const view = renderGrid();
    fireEvent.keyDown(opener(view, 'v_1'), { key: 'Enter', metaKey: true });
    expect(clipCount(view.container)).toBe(1);
  });

  it('Delete removes the focused card from the project', () => {
    const view = renderGrid();
    expect(view.getAllByLabelText(/^asset /).length).toBe(5);
    fireEvent.keyDown(opener(view, 'v_2'), { key: 'Delete' });
    expect(view.queryByLabelText('asset v_2')).toBeNull();
    expect(view.getAllByLabelText(/^asset /).length).toBe(4);
  });

  it('names the tile for assistive tech, including whether it is on the timeline', () => {
    const view = renderGrid();
    expect(opener(view, 'v_0').getAttribute('aria-label')).toBe('Open clip0.mp4');
    fireEvent.keyDown(opener(view, 'v_0'), { key: 'Enter', metaKey: true });
    expect(opener(view, 'v_0').getAttribute('aria-label')).toBe('Open clip0.mp4 (on the timeline)');
  });

  it('gives the windowed grid real list semantics', () => {
    const view = renderGrid();
    const list = view.getByRole('list', { name: 'assets' });
    // The positioned windowing wrappers are presentational, so the cards are the
    // list's items rather than being buried under generic divs.
    expect(list.querySelectorAll('[role="listitem"]').length).toBe(5);
  });
});

/**
 * Tests for the redesign brief's Media-sidebar features: the header count,
 * filter chips, sort, the used-on-timeline indicator, and density. Each spec's
 * view state is `localStorage`-persisted (`useMediaBinView`), so it must be
 * cleared between tests or a later test would inherit an earlier one's choice.
 */
describe('MediaBin redesign: header, filter, sort, used-indicator, density', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  function renderBinWith(
    assets: readonly Asset[],
    folders: readonly Folder[] = [],
  ): ReturnType<typeof render> {
    const project = newProject('Redesign Test');
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, { assets: [...assets], folders: [...folders] });
      return <MediaBin editor={editor} project={project} />;
    }
    return render(<Host />);
  }

  const video: Asset = { id: 'vid_1', path: 'media/clip.mp4', kind: 'video' };
  const audio: Asset = { id: 'aud_1', path: 'media/song.mp3', kind: 'audio' };
  const image: Asset = { id: 'img_1', path: 'media/photo.jpg', kind: 'image' };

  it('shows the asset count beside the panel title', () => {
    const view = renderBinWith([video, audio, image]);
    expect(view.getByText('· 3')).toBeTruthy();
  });

  it('filter chips narrow the grid to the selected kind', () => {
    const view = renderBinWith([video, audio, image]);
    expect(view.getByLabelText(`asset ${audio.id}`)).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Audio' }));

    expect(view.queryByLabelText(`asset ${video.id}`)).toBeNull();
    expect(view.getByLabelText(`asset ${audio.id}`)).toBeTruthy();
    expect(view.queryByLabelText(`asset ${image.id}`)).toBeNull();

    fireEvent.click(view.getByRole('button', { name: 'All' }));
    expect(view.getByLabelText(`asset ${video.id}`)).toBeTruthy();
  });

  it('a filter flattens across folders, same as unified search', () => {
    const folder: Folder = { id: 'f1', name: 'Interviews', parentId: null };
    const foldered: Asset = { ...video, folderId: folder.id };
    const view = renderBinWith([foldered], [folder]);
    expect(view.getByLabelText('folder Interviews')).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Video' }));

    expect(view.queryByLabelText('folder Interviews')).toBeNull();
    expect(view.getByLabelText(`asset ${foldered.id}`)).toBeTruthy();
  });

  it('shows a kind-specific empty state when a filter matches nothing', () => {
    const view = renderBinWith([video]);
    fireEvent.click(view.getByRole('button', { name: 'Audio' }));
    expect(view.getByText('No audio assets.')).toBeTruthy();
  });

  it('empty-by-filter offers a way back out; empty-by-nothing offers import', () => {
    const view = renderBinWith([video]);
    fireEvent.click(view.getByRole('button', { name: 'Audio' }));
    // The way out of an over-narrow filter is to widen it, not to import.
    const filtered = view.getByRole('note');
    expect(filtered.textContent).toContain('No audio assets.');
    expect(filtered.querySelector('button')?.textContent).toBe('Show all media');
    fireEvent.click(view.getByRole('button', { name: 'Show all media' }));
    expect(view.getByLabelText(`asset ${video.id}`)).toBeTruthy();

    // With nothing in the bin at all, the state names the gap and carries the action.
    const empty = renderBinWith([]);
    const firstRun = empty.getByRole('note');
    expect(firstRun.textContent).toContain('No media yet');
    expect(firstRun.querySelector('button')?.textContent).toBe('Import media');
  });

  it('clears the search from the keyboard (Esc) and from the field control', () => {
    const view = renderBinWith([video]);
    const input = view.getByLabelText('search media and transcript');
    fireEvent.change(input, { target: { value: 'clip' } });
    expect(view.getByLabelText('search results')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(view.queryByLabelText('search results')).toBeNull();

    fireEvent.change(input, { target: { value: 'clip' } });
    fireEvent.click(view.getByLabelText('clear search'));
    expect(view.queryByLabelText('search results')).toBeNull();
  });

  it('sorts by name across the flattened bin', () => {
    const assets: Asset[] = [
      { id: 'v_b', path: 'media/b.mp4', kind: 'video' },
      { id: 'v_a', path: 'media/a.mp4', kind: 'video' },
      { id: 'v_c', path: 'media/c.mp4', kind: 'video' },
    ];
    const view = renderBinWith(assets);
    fireEvent.click(screen.getByRole('combobox', { name: 'Sort media' }));
    fireEvent.click(screen.getByRole('option', { name: 'Name' }));

    const ids = Array.from(view.container.querySelectorAll('[aria-label^="asset "]')).map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(ids).toEqual(['asset v_a', 'asset v_b', 'asset v_c']);
  });

  it('shows a dot once an asset has a clip on the timeline, not before', () => {
    const project = newProject('Used Test');
    function Host(): JSX.Element {
      const editor = useEditor(project.timeline, { assets: [video], folders: [] });
      return <MediaBin editor={editor} project={project} />;
    }
    const view = render(<Host />);
    const getCard = () => view.getByLabelText(`asset ${video.id}`);
    expect(getCard().querySelector('.bin-card-used')).toBeNull();

    fireEvent.doubleClick(getCard());

    expect(getCard().querySelector('.bin-card-used')).not.toBeNull();
  });

  it('density re-flows the grid column count and persists the choice', () => {
    const assets = Array.from({ length: 5 }, (_, i) => ({
      id: `v_${i}`,
      path: `media/clip${i}.mp4`,
      kind: 'video' as const,
    }));
    const view = renderBinWith(assets);
    // Default density is 'L' — 2 columns, matching the bin's original layout.
    expect(
      view.container.querySelectorAll('.bin-grid-row')[0]?.querySelectorAll('.bin-card').length,
    ).toBe(2);

    fireEvent.click(view.getByRole('button', { name: 'S' }));
    expect(
      view.container.querySelectorAll('.bin-grid-row')[0]?.querySelectorAll('.bin-card').length,
    ).toBe(4);
    expect(view.getByLabelText('media bin').getAttribute('data-density')).toBe('S');
  });
});

/**
 * Import progress: probing, copying, and deriving media all take real time on
 * camera-scale files. Until the asset lands, the bin must SHOW the wait — a
 * placeholder card per file — instead of looking idle or empty.
 */
describe('MediaBin import skeleton', () => {
  beforeEach(() => {
    deriveEngineMedia.mockReset();
  });

  it('shows a placeholder card per in-flight file and clears it when the import lands', async () => {
    // Hold derivation open so the import is observably mid-flight.
    let release: (value: AssetMedia | undefined) => void = () => {};
    deriveEngineMedia.mockImplementation(
      () => new Promise<AssetMedia | undefined>((resolve) => (release = resolve)),
    );
    const emptyProject = newProject('Skeleton Test');
    function Host(): JSX.Element {
      const editor = useEditor(emptyProject.timeline, { assets: [], folders: [] });
      return <MediaBin editor={editor} project={emptyProject} />;
    }
    const view = render(<Host />);
    const input = view.getByLabelText('import media') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Mid-import: a shimmering placeholder card, and NOT the "no media yet" copy.
    expect(view.getByLabelText('importing clip.mp4')).toBeTruthy();
    expect(view.container.querySelector('.skeleton')).not.toBeNull();
    expect(view.queryByText(/No media yet/)).toBeNull();

    await act(async () => {
      release(undefined);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.queryByLabelText('importing clip.mp4')).toBeNull();
    expect(view.getAllByLabelText(/^asset /).length).toBe(1);
  });
});

describe('MediaBin — reveal in bin (UX-08)', () => {
  const assets: readonly Asset[] = [
    { id: 'v_0', path: 'media/intro.mp4', kind: 'video' as const },
    { id: 'v_1', path: 'media/broll.mp4', kind: 'video' as const },
  ];

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  /** One mounted bin whose reveal request can be flipped, as the real host does. */
  function renderRevealable() {
    const project = parseProject({ ...newProject('Reveal Test'), assets: [...assets] });
    function Host({ reveal }: { reveal?: { assetId: string; seq: number } }): JSX.Element {
      const editor = useEditor(project.timeline, { assets: project.assets, folders: [] });
      return (
        <MediaBin
          editor={editor}
          project={project}
          {...(reveal ? { revealRequest: reveal } : {})}
        />
      );
    }
    const view = render(<Host />);
    return {
      view,
      reveal: async (assetId: string, seq: number) => {
        view.rerender(<Host reveal={{ assetId, seq }} />);
        await act(async () => {});
      },
    };
  }

  const opener = (id: string): Element | null =>
    screen.getByLabelText(`asset ${id}`).querySelector('.bin-card-open');

  it('gives the revealed card the grid’s focus', async () => {
    const { reveal } = renderRevealable();
    await reveal('v_1', 1);
    expect(document.activeElement).toBe(opener('v_1'));
  });

  // The card the user asked for may be filtered out of the list entirely. A reveal
  // that leaves the search box alone reveals nothing and looks broken — and the
  // caller (the timeline) has no way to know the bin is filtered.
  it('clears a search filter that is hiding the card', async () => {
    const { reveal } = renderRevealable();
    fireEvent.change(screen.getByLabelText('search media and transcript'), {
      target: { value: 'nothing-matches-this' },
    });
    expect(screen.queryByLabelText('asset v_1')).toBeNull();

    await reveal('v_1', 1);
    expect(screen.getByLabelText('asset v_1')).toBeTruthy();
    expect(document.activeElement).toBe(opener('v_1'));
  });

  // The second right-click on the same clip is exactly the case where the user has
  // scrolled away since the first, so the id alone cannot be the trigger.
  it('reveals the same asset again when the request repeats', async () => {
    const { reveal } = renderRevealable();
    await reveal('v_1', 1);
    (document.activeElement as HTMLElement | null)?.blur();
    await reveal('v_1', 2);
    expect(document.activeElement).toBe(opener('v_1'));
  });
});
