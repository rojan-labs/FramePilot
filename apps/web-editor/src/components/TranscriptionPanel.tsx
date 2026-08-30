/**
 * TranscriptionPanel — the spoken counterpart to {@link FootageUnderstandingPanel}.
 *
 * Footage understanding answers "what is IN my footage"; this answers "what is SAID in
 * it". Same shape on purpose (a right-side drawer off the topbar, a teaching deck, honest
 * empty states) so the two read as one family, and same posture: it never fabricates.
 *
 * WHY grouped per clip: the project transcript is one flat, timeline-time word list —
 * the shape captions/search/preview need — but an editor thinks per take. Each word's
 * time is projected back through the LIVE timeline (`groupTranscriptByAsset`) and cut
 * into contiguous runs, so you see the words under each piece of footage, in the order
 * the edit plays them. Words sitting in a gap are shown as such rather than pinned to a
 * clip they were never spoken over (AGENTS.md invariant 6 — no invented data).
 *
 * Everything here is a **read** of project state plus two explicit actions: seek (click a
 * line or a word) and transcribe a clip (desktop only — hosted/local ASR runs in the
 * trusted host, and the project must be on disk). Transcription applies the same
 * reversible `set_transcript` patch the Transcript rail uses, so undo covers it; because
 * that operation is project-wide, the panel says so before replacing existing words.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import type { Asset, TranscriptWord } from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';
import { Button } from '@framepilot/ui';
import {
  AudioLines,
  Captions,
  Copy,
  FileText,
  ICON_SIZE,
  Info,
  Lightbulb,
  Search,
  Sparkles,
  X,
} from './icons.js';
import type { LucideIcon } from './icons.js';
import { Tooltip } from './Tooltip.js';
import { TranscribeError, TranscribeProgress } from './TranscribeProgress.js';
import type { UseEditor } from '../editor/useEditor.js';
import {
  activeWordIndex,
  formatClock,
  groupTranscriptIntoReadableLines,
} from '../editor/captions.js';
import { assetDisplayName } from '../editor/selectors.js';
import {
  groupTranscriptByAsset,
  transcriptText,
  type IndexedTranscriptWord,
  type TranscriptGroup,
} from '../editor/transcriptGrouping.js';
import { transcribeAsset } from '../editor/bridge.js';
import { setTranscriptPatch } from '../editor/patch-builders.js';
import {
  beginTranscriptionJob,
  failTranscriptionJob,
  finishTranscriptionJob,
  getTranscriptionJobsSnapshot,
  subscribeTranscriptionJobs,
} from '../editor/transcriptionJobs.js';
import { useSettings } from '../editor/useSettings.js';
import { useModalFocusTrap } from './ai/useModalFocusTrap.js';

const log = createLogger('web-editor:transcription-panel');

export interface TranscriptionPanelProps {
  readonly editor: UseEditor;
  readonly open: boolean;
  readonly onClose: () => void;
  /** Save the project and return its on-disk path (desktop only) before ASR runs. */
  readonly ensureSavedForTranscription?: () => Promise<string | null>;
}

/** Words per displayed transcript line — long enough to read, short enough to scan. */
const WORDS_PER_LINE = 8;
const LOADER_DELAY_MS = 250;
const LOADER_MINIMUM_MS = 400;

/** Keep a loader that became visible on screen stable long enough to read. */
async function settleTranscriptionWait(startedAt: number): Promise<void> {
  const elapsed = performance.now() - startedAt;
  if (elapsed < LOADER_DELAY_MS || elapsed >= LOADER_DELAY_MS + LOADER_MINIMUM_MS) return;
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, LOADER_DELAY_MS + LOADER_MINIMUM_MS - elapsed);
  });
}

/** Shared reveal choreography (mirrors the understanding panel's stagger). */
function useRevealVariants(): { container: Variants; item: Variants } {
  const reduce = useReducedMotion();
  return useMemo(() => {
    if (reduce) {
      const still: Variants = { hidden: { opacity: 1 }, show: { opacity: 1 } };
      return { container: still, item: still };
    }
    return {
      container: {
        hidden: {},
        show: { transition: { staggerChildren: 0.04, delayChildren: 0.03 } },
      },
      item: {
        hidden: { opacity: 0, y: 8 },
        show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 460, damping: 34 } },
      },
    };
  }, [reduce]);
}

interface LearnCard {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
}

/** Written for editors, not engineers: what the panel is, and what to do with it. */
const LEARN_CARDS: readonly LearnCard[] = [
  {
    id: 'per-clip',
    icon: AudioLines,
    title: 'Grouped by clip',
    body: 'The words are split by the footage they play over, in timeline order — so you can read one take at a time instead of one long wall of text.',
  },
  {
    id: 'seek',
    icon: Sparkles,
    title: 'Click to jump',
    body: 'Click any timecode or word to move the playhead there. The word being spoken lights up while you play.',
  },
  {
    id: 'how',
    icon: FileText,
    title: 'One transcript',
    body: 'Your project keeps a single transcript — the one captions and search read. Transcribing a clip replaces it, and undo brings the old one back.',
  },
];

const LEARN_DISMISSED_KEY = 'fp:transcription:learn-dismissed';

/** Read the persisted "I've seen the guide" flag (SSR/test safe). */
function readLearnDismissed(): boolean {
  try {
    return window.localStorage.getItem(LEARN_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** The dismissible teaching deck. Same component shape as the understanding panel's. */
function LearnCards({ onDismiss }: { readonly onDismiss: () => void }): JSX.Element {
  const reduce = useReducedMotion();
  const deckVariants: Variants = reduce ? {} : { show: { transition: { staggerChildren: 0.07 } } };
  const cardVariants: Variants = reduce
    ? { hidden: { opacity: 1 }, show: { opacity: 1 } }
    : {
        hidden: { opacity: 0, y: 14, scale: 0.96 },
        show: {
          opacity: 1,
          y: 0,
          scale: 1,
          transition: { type: 'spring', stiffness: 500, damping: 30 },
        },
      };
  return (
    <motion.section
      className="understanding-learn"
      aria-label="How the transcript works"
      initial={reduce ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 40 }}
    >
      <div className="understanding-learn-head">
        <span className="understanding-learn-eyebrow">
          <Lightbulb size={13} aria-hidden="true" /> How to read this
        </span>
        <button
          type="button"
          className="understanding-learn-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss the guide"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <motion.div
        className="understanding-learn-deck"
        initial="hidden"
        animate="show"
        variants={deckVariants}
      >
        {LEARN_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <motion.article
              key={card.id}
              className="understanding-learn-card"
              variants={cardVariants}
              whileHover={reduce ? {} : { y: -3 }}
            >
              <span className="understanding-learn-icon" aria-hidden="true">
                <Icon size={15} />
              </span>
              <h4 className="understanding-learn-title">{card.title}</h4>
              <p className="understanding-learn-body">{card.body}</p>
            </motion.article>
          );
        })}
      </motion.div>
    </motion.section>
  );
}

/** A display line: a run of words plus the flat index of its first word. */
interface DisplayLine {
  readonly text: string;
  readonly start: number;
  readonly words: readonly IndexedTranscriptWord[];
}

/**
 * Chunk one group's words into readable lines. The group's words are contiguous in the
 * flat transcript, so each word keeps its own flat index for the active highlight.
 */
function linesFor(group: TranscriptGroup): readonly DisplayLine[] {
  const plain: readonly TranscriptWord[] = group.words.map((entry) => entry.word);
  const grouped = groupTranscriptIntoReadableLines(plain, WORDS_PER_LINE);
  const lines: DisplayLine[] = [];
  let offset = 0;
  for (const line of grouped) {
    lines.push({
      text: line.text,
      start: line.start,
      words: group.words.slice(offset, offset + line.words.length),
    });
    offset += line.words.length;
  }
  return lines;
}

/**
 * The transcript lines for one clip. Its own playhead subscription keeps the active-word
 * highlight from re-rendering the whole panel: the snapshot is a primitive index, so
 * React bails out on every tick that doesn't change which word is spoken.
 */
function TranscriptLines({
  editor,
  group,
  query,
}: {
  readonly editor: UseEditor;
  readonly group: TranscriptGroup;
  readonly query: string;
}): JSX.Element {
  const transcript = editor.state.transcript;
  const getActive = useCallback(
    () => activeWordIndex(transcript, editor.getPlayhead()),
    [transcript, editor],
  );
  const active = useSyncExternalStore(editor.subscribePlayhead, getActive, getActive);
  const activeRef = useRef<HTMLLIElement | null>(null);
  const reveal = useRevealVariants();

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const lines = useMemo(() => linesFor(group), [group]);
  const needle = query.trim().toLowerCase();
  const visible =
    needle === '' ? lines : lines.filter((line) => line.text.toLowerCase().includes(needle));

  if (visible.length === 0) {
    return <p className="transcription-no-match">No lines match “{query.trim()}”.</p>;
  }

  return (
    <motion.ol
      className="transcription-lines"
      initial="hidden"
      animate="show"
      variants={reveal.container}
    >
      {visible.map((line) => {
        const lineActive = line.words.some((entry) => entry.index === active);
        return (
          <motion.li
            key={line.words[0]?.index ?? line.start}
            className="transcription-line"
            data-active={lineActive ? 'true' : undefined}
            ref={lineActive ? activeRef : null}
            variants={reveal.item}
          >
            <button
              type="button"
              className="transcription-time tabular"
              aria-label={`seek to ${formatClock(line.start)}`}
              onClick={() => editor.seek(line.start)}
            >
              {formatClock(line.start)}
            </button>
            <p className="transcription-line-words">
              {line.words.map((entry) => (
                <button
                  key={entry.index}
                  type="button"
                  className="transcription-word"
                  aria-current={entry.index === active}
                  data-active={entry.index === active ? 'true' : undefined}
                  onClick={() => editor.seek(entry.word.start)}
                >
                  {entry.word.word}
                </button>
              ))}
            </p>
          </motion.li>
        );
      })}
    </motion.ol>
  );
}

export function TranscriptionPanel({
  editor,
  open,
  onClose,
  ensureSavedForTranscription,
}: TranscriptionPanelProps): JSX.Element | null {
  const { settings } = useSettings();
  const reveal = useRevealVariants();
  const [query, setQuery] = useState('');
  const [showLearn, setShowLearn] = useState(() => !readLearnDismissed());
  const [copiedAssetId, setCopiedAssetId] = useState<string | null>(null);
  const transcriptionJobs = useSyncExternalStore(
    subscribeTranscriptionJobs,
    getTranscriptionJobsSnapshot,
    getTranscriptionJobsSnapshot,
  );

  const dismissLearn = useCallback(() => {
    setShowLearn(false);
    try {
      window.localStorage.setItem(LEARN_DISMISSED_KEY, '1');
    } catch {
      /* private mode / no storage — dismissal is best-effort, not load-bearing */
    }
  }, []);

  // The panel dims and blocks the app behind it, so it is modal in fact — it just
  // never said so. Without the trap, Tab walks out under the backdrop onto controls
  // the user cannot see; without `aria-modal`, a screen reader never learns the rest
  // of the page is out of play.
  const panelRef = useModalFocusTrap<HTMLElement>(open);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const transcript = editor.state.transcript;
  const assets = editor.state.assets as readonly Asset[];
  const timeline = editor.state.timeline;

  const groups = useMemo(
    () => groupTranscriptByAsset(transcript, timeline),
    [transcript, timeline],
  );

  const assetLabel = useCallback(
    (assetId: string | null): string => {
      if (!assetId) return 'Not on the timeline';
      return assetDisplayName(
        assets.find((candidate) => candidate.id === assetId),
        assetId,
      );
    },
    [assets],
  );

  /** Audio/video assets — the only ones speech-to-text can read. */
  const transcribableAssets = useMemo(
    () => assets.filter((asset) => asset.kind === 'audio' || asset.kind === 'video'),
    [assets],
  );

  /**
   * Transcribable footage with no words attributed to it. Kept visible (rather than
   * omitted) so the panel accounts for ALL the footage: every clip either shows its
   * words or says plainly that it has none yet, with the action to fix that.
   */
  const untranscribedAssets = useMemo(() => {
    const covered = new Set(groups.map((group) => group.assetId));
    return transcribableAssets.filter((asset) => !covered.has(asset.id));
  }, [groups, transcribableAssets]);

  const copyGroup = useCallback(async (group: TranscriptGroup): Promise<void> => {
    const text = transcriptText(group.words);
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedAssetId(group.assetId ?? '—');
      window.setTimeout(() => setCopiedAssetId(null), 1500);
    } catch (error) {
      log.warn('copy transcript failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const transcribe = useCallback(
    async (asset: Asset): Promise<void> => {
      if (getTranscriptionJobsSnapshot().get(asset.id)?.kind === 'running') return;
      beginTranscriptionJob(asset.id, settings.asrProvider);
      if (!ensureSavedForTranscription) {
        failTranscriptionJob(asset.id, 'Transcription needs the FramePilot desktop app.');
        return;
      }
      const startedAt = performance.now();
      const projectPath = await ensureSavedForTranscription();
      if (!projectPath) {
        await settleTranscriptionWait(startedAt);
        failTranscriptionJob(asset.id, 'Save the project before transcribing.');
        return;
      }
      const result = await transcribeAsset({
        projectPath,
        assetId: asset.id,
        provider: settings.asrProvider,
      });
      if (!result.ok) {
        await settleTranscriptionWait(startedAt);
        failTranscriptionJob(asset.id, result.error);
        return;
      }
      const issues = editor.applyPatchChecked(setTranscriptPatch(result.assetId, result.words));
      if (issues.length > 0) {
        await settleTranscriptionWait(startedAt);
        failTranscriptionJob(asset.id, issues.map((issue) => issue.message).join(' '));
        return;
      }
      log.action('transcribed clip', { assetId: asset.id, words: result.words.length });
      await settleTranscriptionWait(startedAt);
      finishTranscriptionJob(asset.id);
    },
    [editor, ensureSavedForTranscription, settings.asrProvider],
  );

  const anyRunning = [...transcriptionJobs.values()].some((job) => job.kind === 'running');
  const spokenClips = groups.filter((group) => group.assetId !== null).length;

  if (!open) return null;

  return (
    <>
      <div className="understanding-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        className="understanding-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Transcription"
        tabIndex={-1}
      >
        <header className="understanding-head">
          <div className="understanding-title-group">
            <h2 className="understanding-title">
              <Captions size={ICON_SIZE.sm} aria-hidden="true" /> Transcription
            </h2>
            {transcript.length > 0 && (
              <p className="understanding-subtitle">
                {transcript.length.toLocaleString()} word{transcript.length === 1 ? '' : 's'}
                {spokenClips > 0 && ` · ${spokenClips} clip${spokenClips === 1 ? '' : 's'}`}
              </p>
            )}
          </div>
          <div className="understanding-head-actions">
            {transcript.length > 0 && (
              <Tooltip label={showLearn ? 'Hide the guide' : 'What is this?'} placement="bottom">
                <Button
                  variant="ghost"
                  className="icon-btn"
                  type="button"
                  aria-label={showLearn ? 'Hide the guide' : 'Show the guide'}
                  aria-pressed={showLearn}
                  data-active={showLearn ? 'true' : undefined}
                  onClick={() => (showLearn ? dismissLearn() : setShowLearn(true))}
                >
                  <Info size={ICON_SIZE.sm} aria-hidden="true" />
                </Button>
              </Tooltip>
            )}
            <Tooltip label="Close" shortcut="Esc" placement="bottom">
              <Button
                variant="ghost"
                className="icon-btn"
                type="button"
                aria-label="Close transcription"
                onClick={onClose}
              >
                <X size={ICON_SIZE.sm} aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        </header>

        <div className="understanding-body">
          {transcript.length > 0 && (
            <AnimatePresence initial={false}>
              {showLearn && <LearnCards key="learn" onDismiss={dismissLearn} />}
            </AnimatePresence>
          )}

          {transcript.length > 0 && (
            <div className="transcription-search">
              <Search size={ICON_SIZE.sm} aria-hidden="true" />
              <input
                type="search"
                aria-label="search transcription"
                placeholder="Search what was said…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          )}

          {/* Honest empty states, in the order an editor hits them: no media at all,
              then media but no words yet. Neither pretends a transcript exists. */}
          {transcript.length === 0 && transcribableAssets.length === 0 && (
            <div className="understanding-empty" role="status">
              <Captions size={20} aria-hidden="true" className="understanding-empty-icon" />
              <p className="understanding-empty-text">
                No audio or video in this project yet. Import a clip and its spoken words will show
                up here.
              </p>
            </div>
          )}
          {transcript.length === 0 && transcribableAssets.length > 0 && (
            <div className="understanding-empty" role="status">
              <Captions size={20} aria-hidden="true" className="understanding-empty-icon" />
              <p className="understanding-empty-text">
                Nothing transcribed yet. Run speech-to-text on a clip below to read — and search —
                everything that is said in it.
              </p>
            </div>
          )}

          {groups.length > 0 && (
            <motion.div
              className="understanding-groups"
              initial="hidden"
              animate="show"
              variants={reveal.container}
            >
              {groups.map((group, index) => {
                const key = `${group.assetId ?? '—'}:${group.words[0]?.index ?? index}`;
                const label = assetLabel(group.assetId);
                const copied = copiedAssetId === (group.assetId ?? '—');
                return (
                  <motion.section
                    key={key}
                    className="transcription-group"
                    data-orphan={group.assetId === null ? 'true' : undefined}
                    variants={reveal.item}
                  >
                    <div className="transcription-group-head">
                      <h3 className="transcription-group-title" title={label}>
                        {label}
                      </h3>
                      <span className="transcription-group-meta tabular">
                        {formatClock(group.start)}–{formatClock(group.end)} ·{' '}
                        {group.words.length.toLocaleString()} words
                      </span>
                      <Tooltip label={copied ? 'Copied' : 'Copy this text'} placement="bottom">
                        <button
                          type="button"
                          className="transcription-copy"
                          aria-label={`Copy the transcript for ${label}`}
                          onClick={() => void copyGroup(group)}
                        >
                          <Copy size={ICON_SIZE.sm} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    </div>
                    {group.assetId === null && (
                      <p className="transcription-group-note">
                        These words don’t sit over any clip right now — the footage they came from
                        was trimmed away or moved.
                      </p>
                    )}
                    <TranscriptLines editor={editor} group={group} query={query} />
                  </motion.section>
                );
              })}
            </motion.div>
          )}

          {untranscribedAssets.length > 0 && (
            <>
              <h3 className="understanding-subhead">
                <AudioLines size={ICON_SIZE.sm} aria-hidden="true" /> Not transcribed yet
              </h3>
              {transcript.length > 0 && (
                <p className="transcription-replace-note">
                  Your project keeps one transcript, so transcribing a clip here replaces the words
                  above. Undo puts them back.
                </p>
              )}
              <ul className="transcription-pending" aria-label="clips without a transcript">
                {untranscribedAssets.map((asset) => {
                  const phase = transcriptionJobs.get(asset.id);
                  const label = assetDisplayName(asset, asset.id);
                  return (
                    <li key={asset.id} className="transcription-pending-row">
                      <span className="transcription-pending-name" title={asset.path || label}>
                        {label}
                      </span>
                      {/* While running, the row becomes the waiting experience
                          rather than a disabled button: this is a minutes-long
                          wait, and a frozen label is indistinguishable from a
                          hang. */}
                      {phase?.kind === 'running' ? (
                        <TranscribeProgress
                          label={label}
                          provider={phase.provider}
                          startedAt={phase.startedAt}
                        />
                      ) : (
                        <Button
                          variant="secondary"
                          type="button"
                          disabled={anyRunning}
                          onClick={() => void transcribe(asset)}
                        >
                          Transcribe
                        </Button>
                      )}
                      {phase?.kind === 'error' && (
                        <TranscribeError
                          message={phase.message}
                          onRetry={() => void transcribe(asset)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
