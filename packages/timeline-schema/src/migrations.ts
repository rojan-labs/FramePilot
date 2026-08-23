/**
 * @framepilot/timeline-schema/migrations — schema versioning + migration framework
 * (PLAN §1.1: "Schema versioning + migration framework — no breaking change
 * without a migration").
 *
 * A `project.fp.json` file carries the {@link SCHEMA_VERSION} it was written with
 * (the `schemaVersion` envelope field). When an older file is opened, the
 * registered {@link Migration}s are applied in sequence to bring its raw shape up
 * to the current version *before* it is validated by {@link ProjectSchema}.
 *
 * `schemaVersion` is an envelope field, distinct from `Project.version` (the
 * user-facing project revision in PRD §11.1). `ProjectSchema` strips the
 * envelope field on parse, so adding it never changes the validated shape.
 */
import { SCHEMA_VERSION } from './index.js';

/** A raw, unvalidated project object as read from disk. */
export type RawProject = Record<string, unknown>;

/**
 * A single forward migration step. `migrate` receives the raw project at version
 * `from` and must return it shaped for version `to` (= `from + 1`).
 */
export interface Migration {
  readonly from: number;
  readonly to: number;
  /** Human-readable note for logs/ADRs explaining the breaking change. */
  readonly describe: string;
  migrate(raw: RawProject): RawProject;
}

/**
a * Registered migrations, ordered by `from`. Every schema change appends a
 * `from: N → to: N+1` entry.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    describe:
      'Asset gains an optional `media` handle (engine-derived waveform peaks, ' +
      'thumbnails, proxy). Purely additive — a v1 asset without it is valid ' +
      'unchanged, so the data needs no transformation; the step exists to stamp ' +
      'the new envelope version (plan Phase 8, ADR 0024).',
    migrate: (raw) => raw,
  },
  {
    from: 2,
    to: 3,
    describe:
      'Project gains a media-bin `folders` tree and assets gain an optional ' +
      '`folderId`. Purely additive — a v2 project has no folders and its assets ' +
      'live at the bin root, which is exactly the default shape, so the data needs ' +
      'no transformation; the step stamps the new envelope version (ADR 0026).',
    migrate: (raw) => raw,
  },
  {
    from: 3,
    to: 4,
    describe:
      'Tracks gain `locked`/`hidden`/`muted` boolean flags (default false). Purely ' +
      'additive — a v3 track has none of them, which is exactly the unlocked / ' +
      'visible / unmuted default, so the data needs no transformation; the step ' +
      'stamps the new envelope version (ADR 0031).',
    migrate: (raw) => raw,
  },
  {
    from: 4,
    to: 5,
    describe:
      'Clips gain an optional, structured `captionStyle` (font/color/outline/' +
      'position/word-highlight/presetId), persisting what was previously a ' +
      'preview-only caption style. Purely additive — a v4 clip has no ' +
      '`captionStyle`, which is exactly "unstyled" (the caption UI\'s default ' +
      'rendering), so the data needs no transformation; the step stamps the new ' +
      'envelope version (ADR 0045).',
    migrate: (raw) => raw,
  },
  {
    from: 5,
    to: 6,
    describe:
      'Clips gain an optional constant `speed` (playback rate) enabling speed/' +
      'time-remap. Purely additive — a v5 clip has no `speed`, which is exactly ' +
      "1x (today's implicit 1:1 timeline/source duration behavior), so the data " +
      'needs no transformation; the step stamps the new envelope version (ADR 0046).',
    migrate: (raw) => raw,
  },
  {
    from: 6,
    to: 7,
    describe:
      'Clips gain an optional `crop` rect (x/y/width/height, fractions of the ' +
      'source frame). Purely additive — a v6 clip has no `crop`, which is exactly ' +
      '"uncropped" (the full source frame, today\'s implicit behavior), so the ' +
      'data needs no transformation; the step stamps the new envelope version ' +
      '(ADR 0047).',
    migrate: (raw) => raw,
  },
  {
    from: 7,
    to: 8,
    describe:
      'Clips gain an optional `blendMode` compositing mode. Purely additive — a ' +
      "v7 clip has no `blendMode`, which is exactly `'normal'` (today's implicit " +
      'compositing behavior), so the data needs no transformation; the step stamps ' +
      'the new envelope version (ADR 0048).',
    migrate: (raw) => raw,
  },
  {
    from: 8,
    to: 9,
    describe:
      'Project gains `markers` — project-level markers/chapters (id/time/optional ' +
      'label/color). Purely additive — a v8 project has no `markers`, which is ' +
      'exactly the empty array (no markers placed), so the data needs no ' +
      'transformation; the step stamps the new envelope version (ADR 0049).',
    migrate: (raw) => raw,
  },
  {
    from: 9,
    to: 10,
    describe:
      'Caption styling becomes template-based: `captionStyle.presetId` is ' +
      'replaced by `templateId` referencing the caption template catalog, and ' +
      'the style gains display/typography/background/shadow/animation/accent ' +
      'fields. The FIRST data-transforming migration: each known v9 preset id ' +
      'is mapped to its nearest catalog template; unknown preset ids are ' +
      'dropped (explicit style fields, a v10 subset, carry over unchanged). ' +
      'Unstyled clips are untouched and keep the baseline render (ADR 0069).',
    migrate: migrateCaptionPresetsToTemplates,
  },
  {
    from: 10,
    to: 11,
    describe:
      'Captions gain an editable identity: a clip gains `captionCue` (its own ' +
      '`text` + `words` timings), a track gains a `captionStyle` default for the ' +
      'whole caption set, and `captionStyle.accent` gains `keywords` (the list ' +
      'the already-shipped `accent.mode: "keywords"` needs to render). Purely ' +
      'additive — a v10 caption clip has no `captionCue`, which is exactly the ' +
      '"derive my text from the project transcript by overlap" fallback it ' +
      'already relied on, and a v10 track has no caption default, which is ' +
      'exactly "every cue keeps its own style". So a v10 project renders ' +
      'byte-identically and the data needs no transformation; the step stamps ' +
      'the new envelope version (ADR 0071).',
    migrate: (raw) => raw,
  },
  {
    from: 11,
    to: 12,
    describe:
      'The transcript becomes explicitly SOURCE-relative and the timeline gains a ' +
      'structural `revision`. Transcript words gain `assetId` (plus optional ' +
      '`confidence`/`speaker`), `timeline.revision` starts at 0, and caption cues ' +
      'gain `derivedFromRevision` + `source` provenance. The bytes barely change, ' +
      'but the CONTRACT does: through v11 every consumer read transcript ' +
      'timestamps as if they were sequence times, which is true only for an ' +
      'unedited single-clip timeline — after a ripple delete it placed every ' +
      'caption at the wrong moment. The timestamps were always source-relative; ' +
      'v12 says so, and adds the attribution needed to map them. The one data ' +
      'transformation is stamping `assetId` on transcript words in ' +
      'single-asset projects, where the attribution is unambiguous; multi-asset ' +
      'v11 transcripts are genuinely ambiguous and are left unattributed for the ' +
      'mapper to treat permissively (ADR 0076).',
    migrate: migrateTranscriptToSourceRelative,
  },
  {
    from: 12,
    to: 13,
    describe:
      'Effects become first-class timeline LAYERS. `TrackType` gains `effect` and ' +
      'every track gains `effectLayers` (default `[]`), each layer a time-ranged ' +
      'instance of a closed-enum render `kind` that restyles whatever is ' +
      'composited beneath it. Purely additive: a v12 project has no effect tracks ' +
      'and no effect layers, which is exactly the empty default, so the data needs ' +
      'no transformation. Per-clip `clip.effects` (color_grade / lut / transform / ' +
      'transition) is UNCHANGED and still honoured — v13 adds a second, ' +
      'complementary place for effects to live rather than moving the old one, ' +
      'which is what keeps every existing project and every existing patch valid ' +
      '(ADR 0088).',
    migrate: (raw) => raw,
  },
  {
    from: 13,
    to: 14,
    describe:
      'Keyframes gain optional bezier `handles` — an `out` control point shaping ' +
      'the segment into the next keyframe and an `in` point shaping the segment ' +
      'from the previous one, the same two-sided convention CSS cubic-bezier() ' +
      'uses. Purely additive, and additive in the strong sense: `handles` ABSENT ' +
      'keeps the hardcoded smoothstep (3t² − 2t³) that `bezier` has always meant, ' +
      'so every v13 project evaluates identically and renders byte-identically. ' +
      'Had absent meant "linear" or "some default curve" instead, this migration ' +
      'would have silently rewritten every existing animation (ADR 0089).',
    migrate: (raw) => raw,
  },
  {
    from: 14,
    to: 15,
    describe:
      "A clip's `speed` widens from strictly-positive to any finite number, so 0 " +
      'now means a held frame (freeze) and a negative value means the source range ' +
      'is consumed backwards (reverse); and a clip gains an optional `speedRamp`, a ' +
      'curve of playback rate against SOURCE time that overrides the constant rate. ' +
      'Purely additive, and additive in the strong sense: a v14 clip has no ' +
      '`speedRamp` and a `speed` that was already positive, which is exactly the ' +
      'constant-rate case, so every v14 project renders byte-identically. Anchoring ' +
      'ramp points in source rather than timeline time is what keeps editing one ' +
      'point from moving every later one, since timeline time is the INTEGRAL of the ' +
      'rate over source time (ADR 0090).',
    migrate: (raw) => raw,
  },
  {
    from: 15,
    to: 16,
    describe:
      'Caption styles gain optional direct-layout geometry: free x/y placement, rotation, ' +
      'maximum width, text alignment, line height and safe-area behavior. Purely additive — ' +
      'a v15 caption has none of these fields and therefore keeps its existing top/middle/' +
      'bottom centered layout byte-for-byte (ADR 0093).',
    migrate: (raw) => raw,
  },
  {
    from: 16,
    to: 17,
    describe:
      'Tracks gain an optional audio `role` (dialogue | music | sfx) so the mix can be reasoned ' +
      'about by what a track IS rather than by its name. Purely additive, and deliberately not ' +
      'back-filled: guessing a role from a track or file name would silently mix the wrong ' +
      'thing, so every v16 track stays role-less (unknown) until an editor authors one.',
    migrate: (raw) => raw,
  },
  {
    from: 17,
    to: 18,
    describe:
      'Projects gain optional `angleGroups`: sets of cameras that recorded the same moment, ' +
      'each angle carrying the source offset that lines it up with the others, so the agent ' +
      'can cut between angles and land on the same instant. Purely additive — a v17 project ' +
      'has no groups and behaves identically. Nothing is back-filled: grouping assets by ' +
      'folder, file name, or creation time would invent a sync relationship that was never ' +
      'authored, and a wrong offset cuts confidently to the wrong moment (ADR 0112).',
    migrate: (raw) => raw,
  },
  {
    from: 18,
    to: 19,
    describe:
      'Projects gain optional `capabilityPacks`: immutable logical release pins for on-demand ' +
      'professional runtimes and models. Purely additive — a v18 project consumed no pack through ' +
      'the new authority, so absence is the truthful empty state. Nothing is inferred from existing ' +
      'effects, tracks, masks, transcripts, or local files (ADR 0114).',
    migrate: (raw) => raw,
  },
  {
    from: 19,
    to: 20,
    describe:
      'Assets gain an optional `source`: where a provider-sourced asset came from and what ' +
      'crediting it obliges (provider, remote id, licence, credit line, creator, fetchedAt). ' +
      'Purely additive and nothing to backfill — no pre-v20 asset was fetched from a provider, ' +
      'so absent is the truthful reading of every existing file, including every user-imported ' +
      'one. The step exists to stamp the envelope version (ADR 0138).',
    migrate: (raw) => raw,
  },
];

/**
 * v9 preset id → v10 catalog template id (see
 * `src/caption-templates.ts`). Exported so migration tests and the catalog
 * test can assert every target id exists in the catalog.
 */
export const LEGACY_PRESET_TO_TEMPLATE_ID: Readonly<Record<string, string>> = {
  clean: 'minimal',
  'bold-pop': 'boxed',
  subtle: 'whisper',
};

/**
 * Walk every clip's `captionStyle` and rewrite `presetId` → `templateId` via
 * {@link LEGACY_PRESET_TO_TEMPLATE_ID}. Defensive about shape (raw JSON may be
 * arbitrarily malformed — validation happens *after* migration): anything that
 * isn't the expected object/array shape is passed through untouched.
 */
function migrateCaptionPresetsToTemplates(raw: RawProject): RawProject {
  const timeline = raw.timeline;
  if (typeof timeline !== 'object' || timeline === null) return raw;
  const tracks = (timeline as Record<string, unknown>).tracks;
  if (!Array.isArray(tracks)) return raw;

  const migratedTracks = tracks.map((track) => {
    if (typeof track !== 'object' || track === null) return track;
    const clips = (track as Record<string, unknown>).clips;
    if (!Array.isArray(clips)) return track;

    const migratedClips = clips.map((clip) => {
      if (typeof clip !== 'object' || clip === null) return clip;
      const style = (clip as Record<string, unknown>).captionStyle;
      if (typeof style !== 'object' || style === null) return clip;
      const { presetId, ...rest } = style as Record<string, unknown>;
      if (typeof presetId !== 'string') return clip;
      const templateId = LEGACY_PRESET_TO_TEMPLATE_ID[presetId];
      const migratedStyle = templateId === undefined ? rest : { ...rest, templateId };
      return { ...clip, captionStyle: migratedStyle };
    });
    return { ...track, clips: migratedClips };
  });

  return { ...raw, timeline: { ...timeline, tracks: migratedTracks } };
}

/**
 * Attribute a v11 transcript to its asset, and seed `timeline.revision`.
 *
 * `assetId` is stamped ONLY when the project has exactly one asset. That is the
 * overwhelming majority of existing projects and the only case where the
 * attribution is provably correct — a two-asset v11 transcript has no record of
 * which file each word came from, and guessing (say, by whichever clip covers
 * the timestamp) would bake today's timeline into data that is supposed to
 * outlive it. Unattributed words stay legal and the mapper matches them against
 * any asset, which is exactly the v11 behavior.
 *
 * Defensive about shape throughout: raw JSON is unvalidated at this point, so
 * anything not matching the expected object/array shape passes through untouched.
 */
function migrateTranscriptToSourceRelative(raw: RawProject): RawProject {
  // `timeline.revision` needs no seeding: absent ≡ 0 ("never structurally
  // edited"), which is exactly the right reading of a v11 project.
  const next: RawProject = { ...raw };
  const assets = raw.assets;
  const transcript = raw.transcript;
  if (!Array.isArray(assets) || assets.length !== 1 || !Array.isArray(transcript)) return next;

  const only = assets[0];
  if (typeof only !== 'object' || only === null) return next;
  const assetId = (only as Record<string, unknown>).id;
  if (typeof assetId !== 'string') return next;

  next.transcript = transcript.map((word) => {
    if (typeof word !== 'object' || word === null) return word;
    const existing = (word as Record<string, unknown>).assetId;
    // Never overwrite an attribution that is somehow already present.
    return existing === undefined ? { ...word, assetId } : word;
  });
  return next;
}

/** Read the envelope schema version from a raw project (defaults to 1). */
export const readSchemaVersion = (raw: RawProject): number => {
  const v = raw.schemaVersion;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 1;
};

export interface MigrateOptions {
  /** Migration set to apply (defaults to {@link MIGRATIONS}); injectable for tests. */
  readonly migrations?: readonly Migration[];
  /** Target version to migrate to (defaults to {@link SCHEMA_VERSION}). */
  readonly targetVersion?: number;
}

export interface MigrationOutcome {
  readonly raw: RawProject;
  /** Versions traversed, e.g. `[2, 3]` when migrating from v1 to v3. */
  readonly appliedTo: readonly number[];
}

/**
 * Bring a raw project up to the target schema version by applying each
 * registered migration in order.
 *
 * @throws {RangeError} if the file is newer than the target version, or if a
 *   migration step is missing (a gap in the chain).
 */
export function migrateToCurrent(raw: RawProject, options: MigrateOptions = {}): MigrationOutcome {
  const migrations = options.migrations ?? MIGRATIONS;
  const target = options.targetVersion ?? SCHEMA_VERSION;
  let version = readSchemaVersion(raw);

  if (version > target) {
    throw new RangeError(
      `Project schema version ${version} is newer than this build supports (${target}). Update FramePilot.`,
    );
  }

  let current = raw;
  const appliedTo: number[] = [];
  while (version < target) {
    const step = migrations.find((m) => m.from === version);
    if (!step) {
      throw new RangeError(
        `No migration registered from schema version ${version} to ${version + 1}.`,
      );
    }
    current = { ...step.migrate(current), schemaVersion: step.to };
    version = step.to;
    appliedTo.push(step.to);
  }
  return { raw: current, appliedTo };
}
