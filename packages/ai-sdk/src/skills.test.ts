import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUNDLED_SKILLS,
  MAX_SKILLS,
  MAX_SKILL_BODY_CHARS,
  loadSkills,
  parseSkillFile,
  skillsByName,
  summarizeSkillsManifest,
  validateSkillTools,
} from './skills.js';
import { selectTools } from './tool-scope.js';
import { RAW_SKILLS } from './skills/generated.js';

const VALID = `---
name: test-skill
description: A test playbook.
tools: [get_timeline, add_keyframes]
---

# Body

Do the thing.
`;

describe('parseSkillFile', () => {
  it('parses strict frontmatter into a skill', () => {
    const result = parseSkillFile('test-skill.md', VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill).toMatchObject({
      name: 'test-skill',
      description: 'A test playbook.',
      tools: ['get_timeline', 'add_keyframes'],
    });
    expect(result.skill.body).toContain('Do the thing.');
  });

  it('accepts a skill without a tools list (defaults to empty)', () => {
    const result = parseSkillFile('t.md', '---\nname: t\ndescription: d\n---\nbody');
    expect(result.ok && result.skill.tools).toEqual([]);
  });

  it('ignores blank lines inside the frontmatter block', () => {
    const result = parseSkillFile('t.md', '---\nname: t\n\ndescription: d\n---\nbody');
    expect(result.ok && result.skill.name).toBe('t');
  });

  it('rejects a file without frontmatter fences', () => {
    const result = parseSkillFile('bad.md', '# just markdown');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('fences') });
  });

  it('rejects a non-kebab-case name', () => {
    const result = parseSkillFile('bad.md', '---\nname: Not_Kebab\ndescription: d\n---\nbody');
    expect(result.ok).toBe(false);
  });

  it('rejects a missing description and an empty body', () => {
    expect(parseSkillFile('a.md', '---\nname: a\n---\nbody').ok).toBe(false);
    expect(parseSkillFile('b.md', '---\nname: b\ndescription: d\n---\n').ok).toBe(false);
  });

  it('rejects an unparseable frontmatter line', () => {
    const result = parseSkillFile('bad.md', '---\nname: a\n???\n---\nbody');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('bad frontmatter') });
  });

  it('rejects a body over the size cap', () => {
    const huge = `---\nname: big\ndescription: d\n---\n${'x'.repeat(MAX_SKILL_BODY_CHARS + 1)}`;
    expect(parseSkillFile('big.md', huge).ok).toBe(false);
  });
});

describe('validateSkillTools', () => {
  it('keeps registered tool names and drops unknown ones', () => {
    const parsed = parseSkillFile(
      't.md',
      '---\nname: t\ndescription: d\ntools: [get_timeline, not_a_tool]\n---\nbody',
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const { skill, unknown } = validateSkillTools(parsed.skill);
    expect(skill.tools).toEqual(['get_timeline']);
    expect(unknown).toEqual(['not_a_tool']);
  });
});

describe('loadSkills', () => {
  it('skips malformed files and keeps the first of a duplicate name', () => {
    const skills = loadSkills([
      { file: 'a.md', raw: '---\nname: dup\ndescription: first\n---\nbody' },
      { file: 'broken.md', raw: 'no fences' },
      { file: 'b.md', raw: '---\nname: dup\ndescription: second\n---\nbody' },
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'dup', description: 'first' });
  });

  it('drops unknown tool names with a warning but keeps the skill', () => {
    const skills = loadSkills([
      {
        file: 't.md',
        raw: '---\nname: t\ndescription: d\ntools: [get_timeline, bogus]\n---\nbody',
      },
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.tools).toEqual(['get_timeline']);
  });

  it('caps the number of loaded skills', () => {
    const many = Array.from({ length: MAX_SKILLS + 4 }, (_, i) => ({
      file: `s${i}.md`,
      raw: `---\nname: skill-${i}\ndescription: d\n---\nbody`,
    }));
    expect(loadSkills(many)).toHaveLength(MAX_SKILLS);
  });
});

describe('bundled skills', () => {
  it('every bundled skill description is within the discovery cap and names its own situation (P2.5)', () => {
    // The description is the ONLY thing the model sees when choosing a skill; over the cap
    // the file is skipped silently, and two skills describing the same situation split the
    // selection between them.
    const descriptions = BUNDLED_SKILLS.map((skill) => skill.description);
    for (const description of descriptions) {
      expect(description.length).toBeLessThanOrEqual(300);
      expect(description.length).toBeGreaterThanOrEqual(60);
    }
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('every bundled skill parses cleanly with only real tool names (nothing was skipped)', () => {
    // loadSkills skips malformed entries defensively; this asserts none IS malformed,
    // so a bad skill file can never silently ship.
    expect(BUNDLED_SKILLS.length).toBe(RAW_SKILLS.length);
    for (const { file, raw } of RAW_SKILLS) {
      const parsed = parseSkillFile(file, raw);
      expect(parsed.ok, `bundled skill failed to parse: ${file}`).toBe(true);
      if (parsed.ok) {
        expect(validateSkillTools(parsed.skill).unknown, `unknown tools in ${file}`).toEqual([]);
      }
    }
  });

  it('never advertises a tool the model cannot actually select', () => {
    // "Registered" is not the invariant — SELECTABLE is. `index_media` is registered and
    // withheld from every model-facing scope (`IMPLICIT_ONLY_TOOL_NAMES`), and two
    // playbooks listed it: the manifest line the model reads before loading anything named
    // a tool that is not in and never will be in its tool list. A tool whose engine does
    // not exist yet (`available: false`) is the same failure with a different cause.
    const selectable = new Set(selectTools({}).map((tool) => tool.name));
    for (const skill of BUNDLED_SKILLS) {
      for (const tool of skill.tools) {
        expect(selectable.has(tool), `${skill.name} advertises unselectable ${tool}`).toBe(true);
      }
    }
  });

  it('every knowledge module exposes the professional decision contract', () => {
    const requiredSections = [
      'Purpose',
      'When to use',
      'When not to use',
      'Required inputs',
      'Expected outputs',
      'Core philosophy',
      'Professional heuristics',
      'Decision framework',
      'Common mistakes',
      'Verification checklist',
      'Recovery advice',
      'Related skills',
    ];
    for (const skill of BUNDLED_SKILLS) {
      for (const section of requiredSections) {
        expect(skill.body, `${skill.name} is missing ${section}`).toContain(`## ${section}\n\n`);
      }
    }
  });

  it('keeps pinned skill bodies compact enough for long-running sessions', () => {
    for (const skill of BUNDLED_SKILLS) {
      expect(skill.body.length, `${skill.name} is too large`).toBeLessThan(8_000);
    }
  });

  it('generated.ts is in sync with skills/*.md (run pnpm generate:skills after editing)', () => {
    const skillsDir = join(__dirname, '..', 'skills');
    const files = readdirSync(skillsDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    const fromDisk = files.map((file) => ({
      file,
      raw: readFileSync(join(skillsDir, file), 'utf8'),
    }));
    expect(RAW_SKILLS.map((s) => ({ file: s.file, raw: s.raw }))).toEqual(fromDisk);
  });
});

describe('skillsByName + summarizeSkillsManifest', () => {
  it('builds a lookup map and a manifest with one line per skill plus the load_skill instruction', () => {
    const map = skillsByName(BUNDLED_SKILLS);
    expect(map.size).toBe(BUNDLED_SKILLS.length);
    const manifest = summarizeSkillsManifest(BUNDLED_SKILLS);
    expect(manifest).toContain('load_skill');
    for (const skill of BUNDLED_SKILLS) {
      expect(manifest).toContain(`- ${skill.name} — ${skill.description}`);
    }
  });

  it('returns an empty manifest for no skills (tier omitted)', () => {
    expect(summarizeSkillsManifest([])).toBe('');
  });
});

describe('bundled skill descriptions are the discovery surface (plan/system-mission P2.5)', () => {
  it('every bundled description fits the cap the manifest shows the model, and no two collide', () => {
    const CAP = 300;
    const seen = new Set<string>();
    for (const skill of BUNDLED_SKILLS) {
      expect(skill.description.length, `${skill.name} description length`).toBeLessThanOrEqual(CAP);
      expect(skill.description.length, `${skill.name} description is empty`).toBeGreaterThan(40);
      const key = skill.description.trim().toLowerCase();
      expect(seen.has(key), `${skill.name} duplicates another skill's description`).toBe(false);
      seen.add(key);
    }
  });
});
