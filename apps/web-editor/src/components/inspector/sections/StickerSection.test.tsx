/**
 * The Inspector's Sticker section (plan/elements EL6a.5, EL6b.3, 02 §4.1): its name, its credit,
 * Replace…, an Outline and a Shadow drawn around the sticker's own alpha (each one undoable
 * `set_clip_edge_style` edit), and a note when it is drawn beyond its sharp size.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { applyProjectPatch } from '@framepilot/editor-core';
import type { ElementAssetWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { addStickerPatch } from '../../../editor/sticker-builders.js';
import { useEditor, type UseEditor } from '../../../editor/useEditor.js';
import { StickerInspector, stickerName } from './StickerSection.js';

const wire: ElementAssetWire = {
  id: 'element_fluent3d_thumbs_up',
  path: 'media/p/elements/fluent3d/thumbs_up.webp',
  kind: 'image',
  media: { width: 318, height: 318 },
  sharpSize: 256,
  source: {
    provider: 'fluent-emoji',
    remoteId: 'thumbs_up',
    license: 'mit',
    licenseUrl: 'https://example.test/LICENSE',
    attributionRequired: false,
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    sourceUrl: 'https://example.test/thumbs_up.png',
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
  deduped: false,
};

/** A project at `width`×`height` holding one thumbs-up sticker, added as the Stickers tab adds it. */
function stickerProject(width: number, height: number): { project: Project; clipId: string } {
  const empty = {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width, height },
    assets: [],
    folders: [],
    timeline: { tracks: [{ id: 'v', type: 'video', clips: [] }] },
  } as unknown as Project;
  const added = addStickerPatch(empty, wire, 'Thumbs up', 0, 3)!;
  return { project: applyProjectPatch(empty, added.patch), clipId: added.clipId };
}

let editor: UseEditor;

function Host({
  project,
  clipId,
  onReplace,
}: {
  readonly project: Project;
  readonly clipId: string;
  readonly onReplace?: (clipId: string, name: string) => void;
}): JSX.Element {
  editor = useEditor(project.timeline, { assets: project.assets, folders: project.folders });
  const clip = editor.state.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
  return (
    <StickerInspector
      editor={editor}
      clip={clip}
      asset={editor.state.assets.find((asset) => asset.id === clip.assetId)}
      resolution={project.resolution}
      {...(onReplace ? { onReplace } : {})}
    />
  );
}

const edgeStyles = (clipId: string) =>
  editor.state.timeline.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === clipId)!
    .effects.filter((effect) => effect.type === 'edge_style')
    .map((effect) => effect.params.kind);

describe('StickerInspector', () => {
  it('names the sticker, credits it, and opens Replace for this clip', () => {
    const { project, clipId } = stickerProject(1920, 1080);
    const onReplace = vi.fn();
    render(<Host project={project} clipId={clipId} onReplace={onReplace} />);
    expect(screen.getByText('Thumbs up')).toBeDefined();
    expect(screen.getByText('Fluent Emoji by Microsoft (MIT)')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
    expect(onReplace).toHaveBeenCalledWith(clipId, 'Thumbs up');
  });

  it('offers no Replace where there is no panel to replace from', () => {
    const { project, clipId } = stickerProject(1920, 1080);
    render(<Host project={project} clipId={clipId} />);
    expect(screen.queryByRole('button', { name: 'Replace…' })).toBeNull();
    expect(stickerName(undefined)).toBe('Sticker');
  });

  it('shows the project’s own copy of the sticker, packaged or curated alike', () => {
    const { project, clipId } = stickerProject(1920, 1080);
    const { container } = render(<Host project={project} clipId={clipId} />);
    expect(container.querySelector('img.sticker-section-thumb')?.getAttribute('src')).toBe(
      `fp-media://local/${encodeURIComponent(wire.path)}`,
    );
  });

  it('draws an outline and a shadow around the sticker, each one undoable edit', () => {
    const { project, clipId } = stickerProject(1920, 1080);
    render(<Host project={project} clipId={clipId} />);
    const look = screen.getByRole('group', { name: 'Sticker look' });
    act(() => {
      fireEvent.click(within(look).getByRole('switch', { name: 'Outline around the sticker' }));
    });
    expect(edgeStyles(clipId)).toEqual(['stroke']);
    // Once on, the outline's colour and width are right there; nothing else of the Mask tab's.
    expect(within(look).getByLabelText('Outline colour')).toBeDefined();
    expect(within(look).getByLabelText('Outline width')).toBeDefined();
    expect(within(look).queryByLabelText('Outline preset')).toBeNull();
    act(() => {
      fireEvent.click(within(look).getByRole('switch', { name: 'Shadow around the sticker' }));
    });
    expect(edgeStyles(clipId).sort()).toEqual(['shadow', 'stroke']);
    act(() => editor.undo());
    expect(edgeStyles(clipId)).toEqual(['stroke']);
    act(() => editor.undo());
    expect(edgeStyles(clipId)).toEqual([]);
  });

  it('says when the sticker is drawn beyond its sharp size at the export resolution', () => {
    const sharp = stickerProject(1920, 1080);
    const { unmount } = render(<Host project={sharp.project} clipId={sharp.clipId} />);
    expect(screen.queryByText(/Enlarged beyond its sharp size/)).toBeNull();
    unmount();
    const soft = stickerProject(3840, 2160);
    render(<Host project={soft.project} clipId={soft.clipId} />);
    expect(screen.getByRole('note').textContent).toContain('Enlarged beyond its sharp size');
  });
});
