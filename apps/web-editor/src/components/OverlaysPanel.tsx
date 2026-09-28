/**
 * Text panel (the left rail's "Text" tab): add titles from templates, in the caption typography.
 *
 * Shaped by what creators already know from CapCut, Clipchamp, Canva and VEED (the 2026-09-28
 * survey in plan/PLAN.md "Text panel"): quick Heading / Subheading / Body buttons, a search,
 * category chips, and a grid of templates each drawn in its real font and look. A click adds
 * the title at the playhead and selects it, so the Inspector and the on-canvas box are ready to
 * edit it; a tile dragged onto a lane adds it there. With a title selected, every tile also
 * offers Apply, which restyles that title and leaves its text and place alone.
 *
 * Everything a tile shows is what the title will be: a template is a complete look written into
 * the title's params (`title-templates.ts`), drawn by the caption rasterizer in the export and
 * the desktop monitor, and by the same caption CSS here (`titleTypographyCss`).
 *
 * The list at the bottom holds the titles already on the timeline: click to go to one and select
 * it, double-click to edit its words, or delete it.
 */
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import {
  DEFAULT_TITLE_TEMPLATE_ID,
  TITLE_TEMPLATE_CATALOG,
  TITLE_TEMPLATE_CATEGORIES,
  getTitleTemplate,
  type TitleTemplate,
  type TitleTemplateCategory,
} from '@framepilot/timeline-schema/title-templates';
import type { UseEditor } from '../editor/useEditor.js';
import {
  DEFAULT_TEXT_PARAMS,
  addTitleFromTemplatePatch,
  applyTitleTemplatePatch,
  deleteClipPatch,
  readTextParams,
  setTextParamsPatch,
  textEffectOf,
  titleLookParams,
  type TextOverlayParams,
} from '../editor/patch-builders.js';
import { titleTypographyCss } from '../editor/textOverlay.js';
import { useSettings } from '../editor/useSettings.js';
import { useViewPreference } from '../editor/useViewPreference.js';
import { useTileGrid } from './elements/useTileGrid.js';
import { Check, ICON_SIZE, Trash2 } from './icons.js';

export interface OverlaysPanelProps {
  readonly editor: UseEditor;
  /** Opens the Elements tab, where shapes and stickers are; absent where it is not offered. */
  readonly onOpenElements?: () => void;
}

/**
 * DnD payload type for dragging a title template from this panel onto a timeline lane. The
 * payload is a title template id; anything else (older builds sent `text` / `title`) adds the
 * default template. Mirrors `ASSET_DND_TYPE` / `TRANSITION_DND_TYPE`.
 */
export const TEXT_OVERLAY_DND_TYPE = 'application/x-framepilot-text-overlay';

/** The template a dropped payload names, or the default one for a payload from an older build. */
export function titleTemplateForDrop(payload: string): string {
  return getTitleTemplate(payload) ? payload : DEFAULT_TITLE_TEMPLATE_ID;
}

type CategoryChip = 'all' | TitleTemplateCategory;

const CHIPS: readonly { readonly id: CategoryChip; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  ...TITLE_TEMPLATE_CATEGORIES,
];

/** Quick-add buttons, largest first (the Canva / VN hierarchy). */
const QUICK_ADD: readonly { readonly templateId: string; readonly label: string }[] = [
  { templateId: 'heading', label: 'Add a heading' },
  { templateId: 'subheading', label: 'Add a subheading' },
  { templateId: 'body', label: 'Add body text' },
];

/** How many caption looks "All" shows before offering the whole category. */
const CAPTION_LOOK_PREVIEW = 6;
/** How many recently used templates the Recent row keeps. */
const RECENT_LIMIT = 6;

const coerceChip = (raw: unknown): CategoryChip | undefined =>
  CHIPS.some((chip) => chip.id === raw) ? (raw as CategoryChip) : undefined;
const coerceRecent = (raw: unknown): readonly string[] | undefined =>
  Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === 'string' && getTitleTemplate(id) !== undefined)
    : undefined;

/**
 * A tile's sample text, drawn by the same caption CSS the title will be, scaled to the tile. The
 * size keeps the template's proportion (a big number reads bigger than a lower third) inside a
 * legible range. Built once per template: the catalog is static.
 */
const TILE_STYLES: ReadonlyMap<string, CSSProperties> = new Map(
  TITLE_TEMPLATE_CATALOG.map((template) => {
    const params: TextOverlayParams = {
      ...DEFAULT_TEXT_PARAMS,
      ...titleLookParams(template.look, template.id),
      text: template.sampleText,
    };
    const css = titleTypographyCss(params) ?? {};
    return [
      template.id,
      {
        ...css,
        textAlign: 'center',
        maxWidth: '92%',
        fontSize: `clamp(10px, ${(template.look.fontSizePercent * 1.9).toFixed(2)}cqh, 30px)`,
        overflowWrap: 'break-word',
      } satisfies CSSProperties,
    ];
  }),
);

const CATEGORY_LABEL: ReadonlyMap<string, string> = new Map(
  TITLE_TEMPLATE_CATEGORIES.map((category) => [category.id, category.label]),
);

/** Whether `template` answers `query` by its name, sample text, category or font. */
function matchesQuery(template: TitleTemplate, query: string): boolean {
  const haystack = [
    template.label,
    template.sampleText,
    CATEGORY_LABEL.get(template.category) ?? '',
    template.look.fontFamily,
  ]
    .join(' ')
    .toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Every title on the timeline (every lane a title can be on), in time order. */
function titlesOnTimeline(timeline: Timeline): readonly Clip[] {
  return timeline.tracks
    .filter((track) => track.type !== 'caption')
    .flatMap((track) => track.clips)
    .filter((clip) => textEffectOf(clip) !== undefined)
    .sort((a, b) => a.start - b.start);
}

export function OverlaysPanel({ editor, onOpenElements }: OverlaysPanelProps): JSX.Element {
  const { settings } = useSettings();
  const { timeline, selectedIds } = editor.state;
  const overlayTrack = timeline.tracks.find((track) => track.type === 'overlay');

  const [query, setQuery] = useState('');
  const [chip, setChip] = useViewPreference<CategoryChip>('textCategory', 'all', coerceChip);
  const [recent, setRecent] = useViewPreference<readonly string[]>(
    'textRecentTemplates',
    [],
    coerceRecent,
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const titles = useMemo(() => titlesOnTimeline(timeline), [timeline]);
  const selectedTitle = useMemo(
    () => titles.find((clip) => selectedIds.includes(clip.id)),
    [titles, selectedIds],
  );
  const appliedTemplateId = selectedTitle ? readTextParams(selectedTitle).templateId : undefined;

  const remember = (templateId: string): void =>
    setRecent((current) =>
      [templateId, ...current.filter((id) => id !== templateId)].slice(0, RECENT_LIMIT),
    );

  const add = (templateId: string): void => {
    if (!overlayTrack) return;
    const start = editor.getPlayhead();
    const built = addTitleFromTemplatePatch(
      timeline,
      overlayTrack.id,
      templateId,
      start,
      start + settings.defaultOverlaySeconds,
    );
    if (!built) return;
    editor.applyPatch(built.patch);
    editor.select(built.clipId);
    remember(templateId);
    setNotice(`${getTitleTemplate(templateId)?.label ?? 'Title'} added at the playhead.`);
  };

  const apply = (templateId: string): void => {
    if (!selectedTitle) return;
    const patch = applyTitleTemplatePatch(timeline, selectedTitle.id, templateId);
    if (!patch) return;
    editor.applyPatch(patch);
    remember(templateId);
    setNotice(`Selected title restyled as ${getTitleTemplate(templateId)?.label ?? 'a template'}.`);
  };

  const remove = (clip: Clip): void => {
    const patch = deleteClipPatch(timeline, clip.id);
    if (patch) editor.applyPatch(patch);
  };

  /** Inline text edit: one reversible `set_effect_params`, keeping the title's look and place. */
  const commitEdit = (clip: Clip, nextText: string): void => {
    setEditing(null);
    if (nextText.trim() === '' || nextText === readTextParams(clip).text) return;
    const patch = setTextParamsPatch(timeline, clip.id, { text: nextText });
    if (patch) editor.applyPatch(patch);
  };

  // Stable identities for the memoised tiles: the handlers read the latest timeline through a
  // ref, so a tile re-renders only when what it draws changes, never on every edit.
  const handlers = useRef({ add, apply });
  handlers.current = { add, apply };
  const onAdd = useCallback((templateId: string) => handlers.current.add(templateId), []);
  const onApply = useCallback((templateId: string) => handlers.current.apply(templateId), []);

  const trimmed = query.trim().toLowerCase();
  const tileProps: TileProps = {
    disabled: !overlayTrack,
    canApply: selectedTitle !== undefined,
    appliedTemplateId,
    onAdd,
    onApply,
  };

  return (
    <section className="text-panel" aria-label="overlays panel">
      <header className="panel-head">
        <h2>Text</h2>
      </header>

      {!overlayTrack && <p className="panel-empty">No overlay track in this project.</p>}

      <div className="text-quick" role="group" aria-label="add text">
        {QUICK_ADD.map(({ templateId, label }) => (
          <button
            key={templateId}
            type="button"
            className={`text-quick-add text-quick-add--${templateId}`}
            disabled={!overlayTrack}
            title="Add at the playhead, or drag onto the timeline"
            draggable={Boolean(overlayTrack)}
            onDragStart={(event) => {
              event.dataTransfer.setData(TEXT_OVERLAY_DND_TYPE, templateId);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => add(templateId)}
          >
            {label}
          </button>
        ))}
      </div>

      <input
        ref={searchRef}
        type="search"
        className="elements-search"
        data-ui="input"
        data-size="sm"
        aria-label="Search text styles"
        placeholder="Search text styles"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query !== '') {
            event.stopPropagation();
            setQuery('');
          }
        }}
      />
      {trimmed === '' && (
        <div className="shapes-chips" role="group" aria-label="Text style categories">
          {CHIPS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className="shapes-chip"
              aria-pressed={chip === id}
              onClick={() => setChip(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {selectedTitle && (
        <p className="text-panel-hint">
          <strong>Apply</strong> restyles the selected title; a click on a style adds a new one.
        </p>
      )}

      <div className="text-panel-scroll">
        <TemplateSections
          query={trimmed}
          chip={chip}
          recent={recent}
          onShowCategory={setChip}
          tileProps={tileProps}
        />

        <section className="text-panel-section" aria-label="titles on the timeline">
          <h3 className="text-panel-heading">
            On the timeline{titles.length > 0 ? ` · ${String(titles.length)}` : ''}
          </h3>
          {titles.length === 0 ? (
            <p className="panel-empty">No titles yet.</p>
          ) : (
            <ul className="ov-list" aria-label="overlay list">
              {titles.map((clip) => (
                <OverlayRow
                  key={clip.id}
                  clip={clip}
                  selected={selectedIds.includes(clip.id)}
                  editing={editing === clip.id}
                  onSeek={() => {
                    editor.seek(clip.start);
                    editor.select(clip.id);
                  }}
                  onEdit={() => setEditing(clip.id)}
                  onCommit={(value) => commitEdit(clip, value)}
                  onCancel={() => setEditing(null)}
                  onDelete={() => remove(clip)}
                />
              ))}
            </ul>
          )}
        </section>

        {onOpenElements && (
          <p className="ov-elements-link">
            Stickers and shapes are in{' '}
            <button type="button" className="link-button" onClick={onOpenElements}>
              Elements
            </button>
            .
          </p>
        )}
      </div>
      {/* Mounted empty, so the region exists before it has anything to say. */}
      <p className="sr-only" role="status">
        {notice}
      </p>
    </section>
  );
}

interface TileProps {
  readonly disabled: boolean;
  readonly canApply: boolean;
  readonly appliedTemplateId: string | undefined;
  readonly onAdd: (templateId: string) => void;
  readonly onApply: (templateId: string) => void;
}

function TemplateSections({
  query,
  chip,
  recent,
  onShowCategory,
  tileProps,
}: {
  readonly query: string;
  readonly chip: CategoryChip;
  readonly recent: readonly string[];
  readonly onShowCategory: (chip: CategoryChip) => void;
  readonly tileProps: TileProps;
}): JSX.Element {
  if (query !== '') {
    const matches = TITLE_TEMPLATE_CATALOG.filter((template) => matchesQuery(template, query));
    return matches.length === 0 ? (
      <p className="stock-note">
        Nothing matched “{query}”. Try a style or a font — “neon”, “lower third”, “serif”.
      </p>
    ) : (
      <TemplateGrid label="Matching text styles" templates={matches} {...tileProps} />
    );
  }
  if (chip !== 'all') {
    return (
      <TemplateGrid
        label={`${CATEGORY_LABEL.get(chip) ?? ''} text styles`}
        templates={TITLE_TEMPLATE_CATALOG.filter((template) => template.category === chip)}
        {...tileProps}
      />
    );
  }
  const recentTemplates = recent
    .map((id) => getTitleTemplate(id))
    .filter((template): template is TitleTemplate => template !== undefined);
  return (
    <>
      {recentTemplates.length > 0 && (
        <TemplateSection title="Recent" templates={recentTemplates} tileProps={tileProps} />
      )}
      {TITLE_TEMPLATE_CATEGORIES.map((category) => {
        const all = TITLE_TEMPLATE_CATALOG.filter((template) => template.category === category.id);
        const capped = category.id === 'caption-looks';
        return (
          <TemplateSection
            key={category.id}
            title={category.label}
            templates={capped ? all.slice(0, CAPTION_LOOK_PREVIEW) : all}
            tileProps={tileProps}
            {...(capped && all.length > CAPTION_LOOK_PREVIEW
              ? { more: { count: all.length, onShow: () => onShowCategory(category.id) } }
              : {})}
          />
        );
      })}
    </>
  );
}

function TemplateSection({
  title,
  templates,
  tileProps,
  more,
}: {
  readonly title: string;
  readonly templates: readonly TitleTemplate[];
  readonly tileProps: TileProps;
  readonly more?: { readonly count: number; readonly onShow: () => void };
}): JSX.Element {
  return (
    <section className="text-panel-section" aria-label={`${title} text styles`}>
      <div className="text-panel-heading-row">
        <h3 className="text-panel-heading">{title}</h3>
        {more && (
          <button type="button" className="link-button text-panel-more" onClick={more.onShow}>
            See all {more.count}
          </button>
        )}
      </div>
      <TemplateGrid label={`${title} text styles`} templates={templates} {...tileProps} />
    </section>
  );
}

/** One grid of tiles: one Tab stop, arrows move between tiles (the Elements grids' keyboard). */
function TemplateGrid({
  label,
  templates,
  ...tileProps
}: TileProps & {
  readonly label: string;
  readonly templates: readonly TitleTemplate[];
}): JSX.Element {
  const { gridRef, focusIndex, setActive, onGridKey } = useTileGrid(
    templates.length,
    '.text-tile-add',
  );
  return (
    <ul ref={gridRef} className="text-tile-grid" aria-label={label} onKeyDown={onGridKey}>
      {templates.map((template, index) => (
        <TemplateTile
          key={template.id}
          template={template}
          index={index}
          tabbable={index === focusIndex}
          onFocus={setActive}
          applied={tileProps.appliedTemplateId === template.id}
          disabled={tileProps.disabled}
          canApply={tileProps.canApply}
          onAdd={tileProps.onAdd}
          onApply={tileProps.onApply}
        />
      ))}
    </ul>
  );
}

const TemplateTile = memo(function TemplateTile({
  template,
  index,
  tabbable,
  applied,
  disabled,
  canApply,
  onFocus,
  onAdd,
  onApply,
}: {
  readonly template: TitleTemplate;
  readonly index: number;
  readonly tabbable: boolean;
  readonly applied: boolean;
  readonly disabled: boolean;
  readonly canApply: boolean;
  readonly onFocus: (index: number) => void;
  readonly onAdd: (templateId: string) => void;
  readonly onApply: (templateId: string) => void;
}): JSX.Element {
  return (
    <li className={`text-tile${applied ? ' is-applied' : ''}`}>
      <button
        type="button"
        className="text-tile-add"
        tabIndex={tabbable ? 0 : -1}
        disabled={disabled}
        aria-label={`${template.label} text style`}
        title={`Add ${template.label} at the playhead, or drag it onto the timeline`}
        draggable={!disabled}
        onDragStart={(event) => {
          event.dataTransfer.setData(TEXT_OVERLAY_DND_TYPE, template.id);
          event.dataTransfer.effectAllowed = 'copy';
        }}
        onFocus={() => onFocus(index)}
        onClick={() => onAdd(template.id)}
      >
        <span className="text-tile-preview" aria-hidden="true">
          <span className="text-tile-sample" style={TILE_STYLES.get(template.id)}>
            {template.sampleText}
          </span>
        </span>
        <span className="text-tile-name">
          {applied && <Check size={ICON_SIZE.sm} aria-hidden="true" />}
          {template.label}
        </span>
      </button>
      {canApply && (
        <button
          type="button"
          className="text-tile-apply"
          tabIndex={tabbable ? 0 : -1}
          aria-label={`apply ${template.label} to the selected title`}
          onClick={() => onApply(template.id)}
        >
          Apply
        </button>
      )}
    </li>
  );
});

interface OverlayRowProps {
  readonly clip: Clip;
  readonly selected: boolean;
  readonly editing: boolean;
  readonly onSeek: () => void;
  readonly onEdit: () => void;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}

function OverlayRow({
  clip,
  selected,
  editing,
  onSeek,
  onEdit,
  onCommit,
  onCancel,
  onDelete,
}: OverlayRowProps): JSX.Element {
  const params = readTextParams(clip);
  const settled = useRef(false);
  return (
    <li className={`ov-row${selected ? ' is-selected' : ''}`}>
      <span className="ov-row-time tabular">
        {clip.start.toFixed(1)}–{clip.end.toFixed(1)}s
      </span>
      {editing ? (
        <input
          className="ov-row-input"
          type="text"
          defaultValue={params.text}
          autoFocus
          aria-label={`edit overlay ${clip.id}`}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              settled.current = true;
              onCommit((event.target as HTMLInputElement).value);
            } else if (event.key === 'Escape') {
              settled.current = true;
              onCancel();
            }
          }}
          onBlur={(event) => {
            if (!settled.current) onCommit(event.target.value);
          }}
        />
      ) : (
        <button
          type="button"
          className="ov-row-text"
          title="Click to go to it and select it · double-click to edit"
          style={{ fontFamily: `'${params.fontFamily}', var(--font-sans, sans-serif)` }}
          onClick={onSeek}
          onDoubleClick={onEdit}
        >
          {params.text}
        </button>
      )}
      <button
        type="button"
        className="ov-row-del"
        aria-label={`delete overlay ${clip.id}`}
        title="Delete title"
        onClick={onDelete}
      >
        <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
      </button>
    </li>
  );
}
