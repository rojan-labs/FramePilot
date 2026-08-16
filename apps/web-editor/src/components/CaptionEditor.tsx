/**
 * Compatibility entry point for the caption authoring surface.
 *
 * CaptionWorkspace owns the implementation. This wrapper preserves the existing
 * keyboard contract while presenting Review, Style, and Generate as focused
 * sidebar tabs rather than one long scrolling document.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import {
  CaptionWorkspace,
  activeCaptionIdAt,
  type CaptionEditorProps,
} from './CaptionWorkspace.js';
import './caption-sidebar.css';

export { CaptionWorkspace, activeCaptionIdAt };
export type { CaptionEditorProps };

type CaptionTab = 'review' | 'style' | 'generate';

const CAPTION_TABS: readonly { id: CaptionTab; label: string; description: string }[] = [
  {
    id: 'review',
    label: 'Review',
    description: 'Search, correct, and time your captions.',
  },
  {
    id: 'style',
    label: 'Style',
    description: 'Choose a template and refine its appearance.',
  },
  {
    id: 'generate',
    label: 'Generate',
    description: 'Create or replace captions from the current transcript.',
  },
];

export function CaptionEditor(props: CaptionEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<CaptionTab>('review');

  const captionCount =
    props.editor.state.timeline.tracks.find((track) => track.type === 'caption')?.clips.length ?? 0;
  const activeTabCopy =
    CAPTION_TABS.find((tab) => tab.id === activeTab)?.description ??
    'Search, correct, and time your captions.';

  const preserveStyleSearchShortcut = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    const editingText = target.matches('input, textarea, [contenteditable="true"]');
    if (event.key !== '/' || editingText) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveTab('style');
    hostRef.current
      ?.querySelector<HTMLInputElement>('input[aria-label="Search caption styles"]')
      ?.focus();
  };

  return (
    <div
      ref={hostRef}
      className="caption-workspace-host"
      data-caption-tab={activeTab}
      onKeyDownCapture={preserveStyleSearchShortcut}
    >
      <header className="caption-sidebar-header">
        <div className="caption-sidebar-heading">
          <div className="caption-sidebar-title-row">
            <h2>Captions</h2>
            <span
              className="caption-sidebar-count"
              aria-label={`${captionCount} ${captionCount === 1 ? 'caption' : 'captions'}`}
            >
              {captionCount}
            </span>
          </div>
          <p className="caption-sidebar-description">{activeTabCopy}</p>
        </div>
      </header>

      <nav className="caption-sidebar-tabs" role="tablist" aria-label="Caption workflow">
        {CAPTION_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="caption-sidebar-tab"
            aria-selected={activeTab === tab.id}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <CaptionWorkspace {...props} />
    </div>
  );
}
