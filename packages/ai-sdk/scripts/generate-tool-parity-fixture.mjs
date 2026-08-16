#!/usr/bin/env node
/**
 * generate-tool-parity-fixture.mjs — emit the canonical TS tool surface as a
 * committed fixture the Python test suite checks itself against.
 *
 * WHY: `packages/ai-sdk/src/tool-registry.ts` is the single source of truth for
 * what the AI may call, but `engine/python/.../ai_tools/registry.py` is a
 * HAND-MAINTAINED mirror of it (unlike skills, which are generator-enforced).
 * `test_tool_registry_ts_parity.py` already pins the tool *name* set by regexing
 * the TS source. Nothing pinned the part that actually decides whether a call
 * succeeds: each tool's **kind**, **availability**, and **argument schema**.
 *
 * That gap is not cosmetic. Python's dispatcher validates with Pydantic
 * `ConfigDict(extra="forbid")`, so a property TS advertises to the model but
 * Python's model omits is a hard rejection at dispatch — the model emits a call
 * that looks valid, and the sidecar 4xxs it. The inverse (Python accepting a
 * property TS never declared) is a silent widening of the security boundary.
 *
 * WHY a normalized fixture rather than byte-identical schemas: Zod's
 * `z.toJSONSchema` and Pydantic's `model_json_schema` are both correct and
 * structurally different — Pydantic stamps a `title` on every field and emits
 * `0.0` where Zod emits `0`, and it factors nested models into `$defs`/`$ref`
 * while Zod inlines them. Demanding byte-identity would fail on all 73 shared
 * tools for reasons that have nothing to do with drift. So both sides reduce a
 * schema to the same canonical core (see NORMALIZATION below) and compare that.
 *
 * Output: `engine/python/tests/fixtures/ts_tool_registry.json` (committed).
 * Regenerate with `pnpm --filter @framepilot/ai-sdk generate:tool-parity`.
 * Requires a built `dist/` — the registry is TS and must be executed, not parsed.
 * `src/tool-parity-fixture.test.ts` fails if the committed fixture goes stale.
 *
 * NORMALIZATION (must stay identical to `_normalize` in
 * `engine/python/tests/test_tool_registry_schema_parity.py`):
 *   - `$ref` is resolved against `$defs`, recursively.
 *   - Kept: type, enum, required, properties, items, `additionalProperties: false`,
 *     and the numeric bounds (minimum/maximum/exclusiveMinimum/exclusiveMaximum).
 *   - Dropped: title, description, default, $schema, examples, format — these
 *     are documentation or generator idiom, not the validation contract.
 *   - `type` becomes a SORTED LIST, so a multi-type node compares stably
 *     regardless of the order each generator happened to emit.
 *   - `enum` and `required` are sorted; numbers are coerced to float so `0` and
 *     `0.0` compare equal.
 *   - The JS safe-integer sentinels Zod stamps on `z.int()` are dropped (see the
 *     `MAX_SAFE_INTEGER` comment below); every real bound is still compared.
 *
 * OPTIONALITY — a deliberate narrowing. The two generators spell "you may omit
 * this argument" differently, systematically, for every optional field in the
 * registry: Zod omits the key from `required`, while Pydantic ALSO widens the
 * type to `X | None` (`anyOf: [{type: X}, {type: 'null'}]`). Comparing that
 * literally flags every tool with an optional argument — ~40 of them — for an
 * idiom difference rather than drift, which would make this fixture useless as
 * a drift detector. So `null` arms and `null` members of a type list are
 * stripped on both sides, and optionality is compared through `required` alone.
 *
 * REQUIRED — "the caller must supply this", on both sides. Zod lists a `.default(x)`
 * field in `required` even though `parse({})` succeeds and fills the default in;
 * Pydantic leaves a defaulted field out of `required` entirely. Comparing the raw
 * lists forces a false choice: either Python rejects calls TS accepts (`add_clip`
 * without `sourceStart`, `add_track` without `type`, `add_asset` without `kind` —
 * all legal TS calls), or the mismatch is allowlisted and real drift hides behind it.
 * So a property that declares a `default` is dropped from `required` on both sides.
 *
 * ADDITIONAL PROPERTIES — only `false` is compared. Zod's `.strict()` and Pydantic's
 * `extra="forbid"` both emit `false`, so the closed-object security boundary is still
 * checked exactly; a Pydantic model that forgot `extra="forbid"` omits the keyword and
 * mismatches TS's `false`. An open record's value schema is `{}` in Zod and `true` in
 * Pydantic — identical in JSON Schema, and not a boundary difference.
 *
 * What that trades away, stated plainly: an explicit `{"assetId": null}` is
 * accepted by Python and rejected by Zod, and this check will not catch it.
 * That is a pre-existing, uniform property of the two schema generators, not
 * something this fixture introduces — and the argument *contract* (which
 * properties exist, which are mandatory, their types, bounds and enums) is
 * compared exactly.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..', '..');
export const FIXTURE_PATH = join(
  repoRoot,
  'engine',
  'python',
  'tests',
  'fixtures',
  'ts_tool_registry.json',
);

/** Resolve a local `#/$defs/Name` pointer against the root schema's `$defs`. */
function resolveRef(node, defs) {
  const ref = node.$ref;
  if (typeof ref !== 'string') return node;
  const name = ref.replace(/^#\/\$defs\//, '');
  const target = defs[name];
  if (target === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  // Merge sibling keywords (JSON Schema 2020-12 allows them alongside $ref).
  const { $ref: _dropped, ...siblings } = node;
  return { ...target, ...siblings };
}

/**
 * Collapse a node's declared type(s) into a sorted, de-duplicated list, with
 * `null` removed — see OPTIONALITY in the module header for why.
 */
function typeList(node) {
  const out = new Set();
  if (typeof node.type === 'string') out.add(node.type);
  else if (Array.isArray(node.type)) for (const t of node.type) out.add(t);
  out.delete('null');
  return [...out].sort();
}

/** True for the `{type: 'null'}` arm Pydantic emits for an optional field. */
function isNullArm(node) {
  const types = typeList(node);
  return (
    types.length === 0 &&
    (node.type === 'null' || (Array.isArray(node.type) && node.type.includes('null')))
  );
}

/**
 * True when a property supplies its own value if the caller omits it — see REQUIRED
 * in the module header for why that must be excluded from `required`.
 */
function hasDefault(properties, name, defs) {
  if (!properties || typeof properties !== 'object') return false;
  const prop = properties[name];
  if (!prop || typeof prop !== 'object') return false;
  return 'default' in resolveRef(prop, defs);
}

function normalize(node, defs) {
  if (node === null || typeof node !== 'object') return node;
  const schema = resolveRef(node, defs);

  // A union (anyOf/oneOf) of pure-type members is really a multi-type node —
  // that is how Pydantic spells `X | None`. Fold it so it matches Zod's form.
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    // Drop the `null` arm first: `X | None` is Pydantic's spelling of optional,
    // and TS spells the same thing by omitting the key from `required`.
    const arms = union.filter((m) => !isNullArm(m));
    const members = arms.map((m) => normalize(m, defs));
    if (members.length === 1) return members[0];
    const typeOnly = members.every((m) => Object.keys(m).length === 1 && Array.isArray(m.type));
    if (typeOnly) {
      const types = [...new Set(members.flatMap((m) => m.type))].sort();
      return { type: types };
    }
    return { anyOf: members.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) };
  }

  const out = {};
  const types = typeList(schema);
  if (types.length > 0) out.type = types;

  if (Array.isArray(schema.enum)) {
    out.enum = [...schema.enum].sort((a, b) => (String(a) < String(b) ? -1 : 1));
  }
  // Only a closed object is a real restriction, and both generators spell that
  // `additionalProperties: false`. An open record's value schema is `{}` in Zod and
  // `true` in Pydantic — identical in JSON Schema, so comparing them would flag
  // generator idiom as drift. See ADDITIONAL PROPERTIES in the module header.
  if (schema.additionalProperties === false) out.additionalProperties = false;
  if (Array.isArray(schema.required)) {
    // Omit an empty list: Pydantic drops `required` entirely when nothing is
    // mandatory, while Zod can still emit `[]` once defaulted fields are filtered.
    const mandatory = schema.required
      .filter((name) => !hasDefault(schema.properties, name, defs))
      .sort();
    if (mandatory.length > 0) out.required = mandatory;
  }
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const key of Object.keys(schema.properties).sort()) {
      out.properties[key] = normalize(schema.properties[key], defs);
    }
  }
  if (schema.items && typeof schema.items === 'object') {
    out.items = normalize(schema.items, defs);
  }
  for (const bound of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    const value = schema[bound];
    // Zod's `z.int()` stamps the JS safe-integer range on every integer field.
    // That is a property of the JS number type, not a constraint the tool
    // declared, and Python ints have no equivalent ceiling — so comparing it
    // would flag every integer argument. Only the exact sentinels are dropped;
    // every real bound (e.g. `minimum: 0`, `maximum: 80`) is still compared.
    if (typeof value === 'number' && Math.abs(value) !== Number.MAX_SAFE_INTEGER) {
      out[bound] = value;
    }
  }
  return out;
}

/**
 * Build the fixture object from a tool registry. Exported (rather than run at
 * import time) so `src/tool-parity-fixture.test.ts` can rebuild it in-memory and
 * assert the committed file is not stale.
 */
export function buildFixture(registry) {
  const tools = {};
  for (const tool of [...registry].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const defs = tool.parameters?.$defs ?? {};
    tools[tool.name] = {
      kind: tool.kind,
      mutates: tool.mutates,
      available: tool.available,
      // Host-UI tools consume live interaction state or a human response and never
      // reach the sidecar dispatcher, so Python does not mirror them.
      hostUiOnly: tool.hostUiOnly === true,
      schema: normalize(tool.parameters ?? {}, defs),
    };
  }
  return {
    // Bump when the NORMALIZATION rules change, so a stale fixture cannot be
    // silently compared under new rules. Mirrored in the Python test.
    normalizationVersion: 2,
    source: 'packages/ai-sdk/src/tool-registry.ts',
    toolCount: Object.keys(tools).length,
    tools,
  };
}

/** Serialize exactly as the committed file is written (trailing newline included). */
export const serializeFixture = (fixture) => `${JSON.stringify(fixture, null, 2)}\n`;

// Only write when invoked as a script, not when imported by the staleness test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { TOOL_REGISTRY } = await import(join(pkgRoot, 'dist', 'tool-registry.js'));
  const fixture = buildFixture(TOOL_REGISTRY);
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, serializeFixture(fixture));
  process.stdout.write(
    `generate-tool-parity-fixture: wrote ${String(fixture.toolCount)} tool(s) → ${FIXTURE_PATH}\n`,
  );
}
