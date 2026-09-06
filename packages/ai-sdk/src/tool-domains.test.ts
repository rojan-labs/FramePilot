/**
 * Progressive tool disclosure (`tool-domains.ts`).
 *
 * The measurement that made this necessary is recorded in that file's header: captured
 * run `35746d4c` spent 62.6% of its whole context on tool schemas and 4.6% on evidence
 * about the video it was editing. These tests pin the two things that make cutting the
 * tool block safe — that every registered tool has a home, and that a withheld tool is
 * never an unreachable one.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, getTool, toolDescriptors } from './tool-registry.js';
import { MAX_CLIPS_PER_BATCH } from './domain-tools/timeline.js';
import { MAX_ASSET_PLAN_ENTRIES } from './domain-tools/project.js';
import {
  DOMAIN_SUMMARY,
  LOADABLE_DOMAINS,
  domainMembers,
  toolDomain,
  toolIsAdvertised,
  type ToolDomain,
} from './tool-domains.js';
import { toolSchemaCost } from './kernel/context/manifest.js';
import { AGENT_MAX_OPS_PER_TURN } from './kernel/conductor.js';
import {
  PRECONDITION_TOOL_NAMES,
  EXECUTION_MEASUREMENT_TOOL_NAMES,
  VERIFICATION_LOOK_TOOL_NAMES,
} from './kernel/stage-policy.js';

const NONE = new Set<ToolDomain>();

describe('every registered tool has a domain', () => {
  it('leaves nothing unmapped', () => {
    // A tool missing from the map falls through `toolIsAdvertised`'s open default and is
    // advertised on every turn — the exact cost this file exists to remove, and silent.
    expect(TOOL_REGISTRY.filter((tool) => toolDomain(tool.name) === undefined)).toEqual([]);
  });

  it('maps nothing that is not registered', () => {
    const registered = new Set(TOOL_REGISTRY.map((tool) => tool.name));
    const stale = LOADABLE_DOMAINS.flatMap((domain) => domainMembers(domain)).filter(
      (name) => !registered.has(name),
    );
    // A name here that the registry does not hold is a domain advertising a tool that
    // cannot be called — `load_tools` would report it as loaded and nothing would exist.
    expect(stale).toEqual([]);
  });

  it('gives every loadable domain a description the model can choose by', () => {
    for (const domain of LOADABLE_DOMAINS) {
      expect(DOMAIN_SUMMARY[domain].length).toBeGreaterThan(20);
      expect(domainMembers(domain).length).toBeGreaterThan(0);
    }
  });
});

describe('what a run is advertised', () => {
  it('cuts the tool block by more than half before anything is loaded', () => {
    const all = toolDescriptors();
    const core = toolDescriptors((tool) => toolIsAdvertised(tool.name, NONE));
    expect(toolSchemaCost(core)).toBeLessThan(toolSchemaCost(all) / 2);
    // The floor matters as much as the cut: a core set that cannot read the timeline or
    // make a cut would force a `load_tools` round trip before any run could start.
    const names = new Set(core.map((tool) => tool.name));
    for (const essential of [
      'get_timeline_summary',
      'get_mapped_transcript',
      'add_clip',
      'trim_clip',
      'delete_range',
      'ripple_delete',
      'recall_evidence',
      'load_skill',
      'load_tools',
      'ask_user',
      'export_video',
    ]) {
      expect(names, `core is missing ${essential}`).toContain(essential);
    }
  });

  it('adds exactly the domain that was loaded, and nothing else', () => {
    const core = new Set(toolDescriptors((t) => toolIsAdvertised(t.name, NONE)).map((t) => t.name));
    for (const domain of LOADABLE_DOMAINS) {
      const loaded = new Set<ToolDomain>([domain]);
      const after = new Set(
        toolDescriptors((t) => toolIsAdvertised(t.name, loaded)).map((t) => t.name),
      );
      const added = [...after].filter((name) => !core.has(name)).sort();
      // `available: false` tools are never advertised, so compare against what the
      // registry would actually offer rather than the raw membership list.
      const offerable = domainMembers(domain)
        .filter((name) => TOOL_REGISTRY.find((tool) => tool.name === name)?.available === true)
        .slice()
        .sort();
      expect(added, domain).toEqual(offerable);
    }
  });

  it('never separates a tool from the discovery tool its arguments need', () => {
    // The GAP-008 hazard, as a property rather than an exemption list: a run offered a
    // tool that takes a catalogue id must also be offered the tool that mints one.
    const pairs: readonly (readonly [string, string])[] = [
      ['add_transition', 'discover_transitions'],
      ['apply_effect', 'discover_effects'],
      ['set_track_caption_style', 'discover_caption_styles'],
      ['add_stock', 'search_stock'],
      ['add_music', 'search_music'],
    ];
    for (const [needs, mints] of pairs) {
      expect(toolDomain(needs), `${needs} / ${mints}`).toBe(toolDomain(mints));
    }
  });
});

/**
 * Which tools may exceed the blast-radius bound, and why each one is allowed to.
 *
 * `ToolSpec.derivedFanOut` is the only way past a rail that exists to stop a runaway
 * model, so the set is asserted exactly rather than by predicate: a tool added to it
 * quietly is a tool that can rewrite a timeline without the bound noticing.
 */
describe('derived fan-out is a short, justified list', () => {
  it('names exactly the tools whose op count the project dictates', () => {
    const derived = TOOL_REGISTRY.filter((tool) => tool.derivedFanOut === true)
      .map((tool) => tool.name)
      .sort();
    expect(derived).toEqual([
      // One `delete_range` per existing cue plus two per new one. A 50-second talking
      // head re-captions in ~110 operations, a three-minute one in ~400, and the cue
      // count is a fact about the transcript.
      'caption_the_edit',
      // One `move_asset` per asset in the bin on the by-kind path — 301 for a 300-photo
      // montage. Its EXPLICIT plan is model-composed and bounded at the schema instead.
      'manage_assets',
      // One `ripple_delete` per measured silence — ~250 on a twenty-minute interview,
      // and the count is a fact about the recording.
      'remove_silences',
    ]);
  });

  it('holds every other batch tool to a bound it can state in its own schema', () => {
    // `add_clips` is the contrast that makes the rule legible: its fan-out IS the model's
    // choice, so it is capped at the schema (`MAX_CLIPS_PER_BATCH`) where the description
    // can name the limit and the fix, rather than exempted from the turn bound.
    const addClips = TOOL_REGISTRY.find((tool) => tool.name === 'add_clips');
    expect(addClips?.derivedFanOut).toBeUndefined();
    expect(addClips?.description).toMatch(/\d+/);
    // And the schema bound sits under the turn bound, so a legal batch always fits.
    expect(MAX_CLIPS_PER_BATCH).toBeLessThan(AGENT_MAX_OPS_PER_TURN);
  });

  it('bounds the model-composed half of a tool that is exempt on its derived half', () => {
    // `manage_assets` is the one tool with both shapes. The exemption is for `by-kind`,
    // whose op count is the bin's; the explicit plan is the model's and must not ride in
    // on the same ticket. A schema bound is what keeps the two apart.
    const tool = getTool('manage_assets');
    expect(tool?.derivedFanOut).toBe(true);
    expect(tool?.description).toContain(String(MAX_ASSET_PLAN_ENTRIES));
    const overLong = Array.from({ length: MAX_ASSET_PLAN_ENTRIES + 1 }, (_, i) => ({
      assetId: `a${String(i)}`,
      folderId: 'f',
    }));
    expect(() => tool?.parse({ strategy: 'plan', assignments: overLong })).toThrow();
  });
});

/**
 * The invariant that connects this file to `kernel/stage-policy.ts`.
 *
 * That file exempts three tools from every stage narrowing, and each exemption was
 * written after a run died without it: `get_frame` is how the agent looks at its own
 * edit; `detect_beats` is the payload the beat grid VALIDATES a cut against (run
 * `ea8e46ec` was told "detect_beats is unavailable this turn" twice and died); and
 * `transcribe` is what a caption mutation's own precondition tells the model to run.
 *
 * A tool the runtime has decided must ALWAYS be reachable must not then have to be asked
 * for. Progressive disclosure got this wrong on its first pass — all three landed in
 * domains — and `admitCall` hid the damage, because naming one still admits it. That is
 * not good enough for `get_frame` in particular: an agent checks its own work only if the
 * means to is in front of it, so hiding it turns the self-check into an opt-in.
 */
describe('a tool the stage policy always allows is always advertised', () => {
  const alwaysReachable = [
    ...VERIFICATION_LOOK_TOOL_NAMES,
    ...EXECUTION_MEASUREMENT_TOOL_NAMES,
    ...PRECONDITION_TOOL_NAMES,
  ];

  it('keeps every stage-policy exemption in the core set', () => {
    expect(alwaysReachable.length).toBeGreaterThan(0);
    for (const name of alwaysReachable) {
      expect(toolDomain(name), `${name} is exempt from stage narrowing but not core`).toBe('core');
    }
  });

  it('offers them to a run that has loaded nothing', () => {
    const core = new Set(toolDescriptors((t) => toolIsAdvertised(t.name, NONE)).map((t) => t.name));
    for (const name of alwaysReachable) {
      // `get_frame` carries the `vision` capability, so a text-only model is still
      // withheld it by `agentTools` — that gate is about what the model can USE, and is
      // orthogonal to this one.
      expect(core, `${name} must not need load_tools`).toContain(name);
    }
  });
});
