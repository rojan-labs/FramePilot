// Regenerate the committed cross-language contracts from the Zod source of
// truth (`src/*.ts` → built `dist/*.js`):
//
//   1. `schema/project.schema.json` — the project JSON Schema.
//   2. `schema/caption-templates.json` — the caption template catalog
//      (ADR 0069), ALSO copied into the Python engine package
//      (`engine/python/framepilot_engine/render/caption_templates.json`) so
//      the render side interprets the exact same catalog.
//
// WHY committed artifacts: the Python engine has no TypeScript runtime, so the
// shared contracts are checked in as JSON. `src/json-schema.test.ts` and
// `src/caption-templates.test.ts` guard TS-side drift (generated must equal
// committed); the Python `test_schema_parity.py` / `test_caption_templates.py`
// check the engine against these files. Run after changing the Zod schema or
// the catalog:
//
//   pnpm --filter @framepilot/timeline-schema build && \
//   pnpm --filter @framepilot/timeline-schema schema:generate
//
// `turbo.json`'s `schema:generate` task depends on this package's own
// `build` (not `^build`) for the same reason: this script imports its own
// package's built dist (`../dist/index.js`, `../dist/effect-catalog.js`), so
// a stale dist would write a stale contract straight into
// `engine/python/framepilot_engine/render/`. That task also sets
// `cache: false` because it writes outside the package (the JSON catalogs
// above, the font manifest, `apps/web-editor/src/fonts.css`), which turbo
// cannot track as outputs. This only binds callers who go through turbo —
// `pnpm --filter` bypasses it, so the `build && schema:generate` sequencing
// above is still the protection there.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildProjectJsonSchema } from '../dist/index.js';
import {
  CAPTION_TEMPLATE_CATALOG,
  DEFAULT_CAPTION_TEMPLATE_ID,
} from '../dist/caption-templates.js';
import { CAPTION_FONT_CATALOG, DEFAULT_CAPTION_FONT_FAMILY } from '../dist/caption-fonts.js';
import { EFFECT_CATALOG, EFFECT_CATEGORIES } from '../dist/effect-catalog.js';
import { EFFECT_PARAMS } from '../dist/effect-params.js';
import { EDGE_STYLE_CATALOG, EDGE_STYLE_KINDS, EDGE_STYLE_PARAMS } from '../dist/edge-styles.js';
import { TRANSITION_CATALOG, TRANSITION_CATEGORIES } from '../dist/transition-catalog.js';
import {
  TRANSITION_APPLY_PATH,
  TRANSITION_DIRECTIONS,
  TRANSITION_PARAMS,
} from '../dist/transition-params.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Write pretty JSON with a trailing newline (POSIX-clean, prettier/git happy). */
const writeJson = (outPath, value) => {
  writeFileSync(outPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  process.stdout.write(`Wrote ${outPath}\n`);
};

writeJson(path.join(here, '..', 'schema', 'project.schema.json'), buildProjectJsonSchema());

const catalog = {
  defaultTemplateId: DEFAULT_CAPTION_TEMPLATE_ID,
  templates: CAPTION_TEMPLATE_CATALOG,
};
const catalogPaths = [
  path.join(here, '..', 'schema', 'caption-templates.json'),
  // The copy packaged with the Python engine (kept byte-identical; drift is
  // guarded by engine/python/tests/test_caption_templates.py).
  path.join(
    here,
    '..',
    '..',
    '..',
    'engine',
    'python',
    'framepilot_engine',
    'render',
    'caption_templates.json',
  ),
];
for (const outPath of catalogPaths) writeJson(outPath, catalog);

// Caption fonts are authored once in TypeScript, then projected into the two
// runtime-specific contracts: Pillow's manifest and the browser's @font-face
// declarations. The binary files themselves are mirrored in both font folders.
const fontCatalog = {
  defaultFontFamily: DEFAULT_CAPTION_FONT_FAMILY,
  fonts: CAPTION_FONT_CATALOG,
};
writeJson(path.join(here, '..', 'schema', 'caption-fonts.json'), fontCatalog);

const fontManifest = {
  comment:
    'Generated from packages/timeline-schema/src/caption-fonts.ts. Bundled OFL/Apache-2.0 caption fonts; keep binary assets mirrored with apps/web-editor/public/fonts/.',
  families: Object.fromEntries(
    CAPTION_FONT_CATALOG.map((font) => [
      font.family,
      {
        file: font.file,
        category: font.category,
        minWeight: font.minWeight,
        maxWeight: font.maxWeight,
        ...(font.boldFile ? { boldFile: font.boldFile } : {}),
        ...(font.italicFile ? { italicFile: font.italicFile } : {}),
        variable: font.variable,
      },
    ]),
  ),
};
writeJson(
  path.join(
    here,
    '..',
    '..',
    '..',
    'engine',
    'python',
    'framepilot_engine',
    'render',
    'fonts',
    'manifest.json',
  ),
  fontManifest,
);

const face = (font, file, weight, style = 'normal') =>
  `@font-face {\n  font-family: '${font.family}';\n  src: url('/fonts/${file}') format('${font.variable ? 'truetype-variations' : 'truetype'}');\n  font-weight: ${weight};\n  font-style: ${style};\n  font-display: swap;\n}`;
const fontCss = [
  '/* Generated from @framepilot/timeline-schema/caption-fonts. Do not edit by hand. */',
  ...CAPTION_FONT_CATALOG.flatMap((font) => {
    // A variable file covers its whole weight range; a static file is one weight.
    const baseWeight = font.variable ? `${font.minWeight} ${font.maxWeight}` : font.minWeight;
    const rules = [face(font, font.file, baseWeight)];
    if (font.boldFile) rules.push(face(font, font.boldFile, font.maxWeight));
    // The italic file of a variable family is variable too (the engine sets its
    // weight axis the same way), so it must be declared over the same range or
    // the browser would draw every italic weight from a single instance.
    if (font.italicFile) rules.push(face(font, font.italicFile, baseWeight, 'italic'));
    return rules;
  }),
]
  .join('\n\n')
  .trimEnd()
  .concat('\n');
const fontCssPath = path.join(here, '..', '..', '..', 'apps', 'web-editor', 'src', 'fonts.css');
writeFileSync(fontCssPath, fontCss, 'utf-8');
process.stdout.write(`Wrote ${fontCssPath}\n`);

// 3. `schema/effect-catalog.json` — the effect catalog + per-kind param
//    vocabulary (schema v13, ADR 0088), also copied into the Python engine so
//    the numpy render passes clamp against the SAME ranges the Inspector and
//    the AI tool layer publish. Drift is guarded by `effect-catalog.test.ts`
//    (TS side) and `test_effect_catalog.py` (engine side).
//    `edgeStyles` (MK9.2) are the cut-out edge styles: clip effects that read the clip's
//    alpha mask stack, with their own param vocabulary and entries.
const effects = {
  categories: EFFECT_CATEGORIES,
  params: EFFECT_PARAMS,
  effects: EFFECT_CATALOG,
  edgeStyles: { kinds: EDGE_STYLE_KINDS, params: EDGE_STYLE_PARAMS, styles: EDGE_STYLE_CATALOG },
};
const effectPaths = [
  path.join(here, '..', 'schema', 'effect-catalog.json'),
  path.join(
    here,
    '..',
    '..',
    '..',
    'engine',
    'python',
    'framepilot_engine',
    'render',
    'effect_catalog.json',
  ),
];
for (const outPath of effectPaths) writeJson(outPath, effects);

// 4. `schema/transition-catalog.json` — the transition catalog, its per-kind
//    param vocabulary, the direction vocabulary and each kind's compiler path
//    (plan/ADVANCED-TRANSITION-SYSTEM.md), copied into the Python engine for the
//    same reason as the effect catalog: the numpy passes clamp against the SAME
//    ranges the Inspector and the AI tool layer publish. Drift is guarded by
//    `transition-catalog.test.ts` (TS) and `test_transition_catalog.py` (engine).
const transitions = {
  categories: TRANSITION_CATEGORIES,
  params: TRANSITION_PARAMS,
  directions: TRANSITION_DIRECTIONS,
  applyPath: TRANSITION_APPLY_PATH,
  transitions: TRANSITION_CATALOG,
};
const transitionPaths = [
  path.join(here, '..', 'schema', 'transition-catalog.json'),
  path.join(
    here,
    '..',
    '..',
    '..',
    'engine',
    'python',
    'framepilot_engine',
    'render',
    'transition_catalog.json',
  ),
];
for (const outPath of transitionPaths) writeJson(outPath, transitions);
