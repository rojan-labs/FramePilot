/**
 * Canonical autonomous tool router.
 *
 * The model sees the compact names from autonomous-tools.manifest.json. This
 * router translates them into existing validated registry calls, a typed patch
 * proposal, or deterministic runtime checks. It never executes media work and it
 * never constructs editor-core operations itself.
 */
import type { ToolCall } from './providers/types.js';
import {
  assertAutonomousToolInput,
  getAutonomousTool,
  type AutonomousToolContract,
} from './autonomous-tool-contract.js';
import { getTool } from './tool-registry.js';
import {
  parseAutonomousPatchProposal,
  type AutonomousPatchProposal,
} from './autonomous-patch-proposal.js';

export interface AutonomousToolCall {
  readonly id?: string;
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export type RuntimeVerificationCheck = 'duration' | 'visual' | 'render';

export type AutonomousToolRoute =
  | {
      readonly kind: 'registry';
      readonly calls: readonly ToolCall[];
    }
  | {
      readonly kind: 'proposal';
      readonly proposal: AutonomousPatchProposal;
    }
  | {
      readonly kind: 'verification';
      readonly calls: readonly ToolCall[];
      readonly runtimeChecks: readonly RuntimeVerificationCheck[];
    };

export type AutonomousToolRouteErrorCode =
  | 'unknown_tool'
  | 'tool_not_ready'
  | 'invalid_args'
  | 'unsupported_mode';

export class AutonomousToolRouteError extends Error {
  public constructor(
    public readonly code: AutonomousToolRouteErrorCode,
    public readonly toolName: string,
    message: string,
  ) {
    super(message);
    this.name = 'AutonomousToolRouteError';
  }
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutonomousToolRouteError(
      'invalid_args',
      label,
      `${label} arguments must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  /* v8 ignore next -- the manifest already proved this is a string array. */
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

function registryCall(
  outer: AutonomousToolCall,
  name: string,
  args: Record<string, unknown>,
  suffix?: string,
): ToolCall {
  const target = getTool(name);
  /* v8 ignore start -- every route targets a tool the manifest-drift test proves is
     READY, so this arm is unreachable defence kept for a future route/registry edit. */
  if (!target || !target.available) {
    throw new AutonomousToolRouteError(
      'tool_not_ready',
      outer.name,
      `Autonomous tool "${outer.name}" routes to unavailable registry tool "${name}".`,
    );
  }
  /* v8 ignore stop */
  try {
    target.parse(args);
  } catch (cause) {
    /* v8 ignore next -- zod and the manifest validator always throw Errors. */
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new AutonomousToolRouteError(
      'invalid_args',
      outer.name,
      `Autonomous tool "${outer.name}" produced invalid "${name}" arguments: ${detail}`,
    );
  }
  return {
    id: `${outer.id ?? `autonomous-${outer.name}`}${suffix ? `-${suffix}` : ''}`,
    name,
    arguments: args,
  };
}

function copyDefined(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function requireReady(call: AutonomousToolCall): AutonomousToolContract {
  const tool = getAutonomousTool(call.name);
  if (!tool) {
    throw new AutonomousToolRouteError(
      'unknown_tool',
      call.name,
      `Unknown autonomous tool "${call.name}".`,
    );
  }
  if (tool.status !== 'ready') {
    throw new AutonomousToolRouteError(
      'tool_not_ready',
      call.name,
      `Autonomous tool "${call.name}" is planned but not implemented yet.`,
    );
  }
  return tool;
}

function rejectFields(
  call: AutonomousToolCall,
  args: Record<string, unknown>,
  names: readonly string[],
  mode: string,
): void {
  const used = names.filter((name) => args[name] !== undefined);
  if (used.length === 0) return;
  throw new AutonomousToolRouteError(
    'invalid_args',
    call.name,
    `${call.name} mode "${mode}" does not support ${used.join(', ')}.`,
  );
}

function routeSearch(call: AutonomousToolCall, args: Record<string, unknown>): AutonomousToolRoute {
  const mode = optionalString(args.mode);
  const query = optionalString(args.query);
  const assetIds = optionalStringArray(args.assetIds);
  const timeRange = Array.isArray(args.timeRange) ? args.timeRange : undefined;
  const limit = optionalNumber(args.limit);

  if (mode === 'keyword' || mode === 'semantic') {
    if (!query) {
      throw new AutonomousToolRouteError(
        'invalid_args',
        call.name,
        `${mode} search requires a non-empty query.`,
      );
    }
    rejectFields(call, args, ['assetIds', 'timeRange'], mode);
    return {
      kind: 'registry',
      calls: [
        registryCall(
          call,
          mode === 'keyword' ? 'search_media' : 'find_similar',
          copyDefined([
            ['query', query],
            ['limit', limit],
          ]),
        ),
      ],
    };
  }

  if (mode === 'visual') {
    if (!query) {
      throw new AutonomousToolRouteError(
        'invalid_args',
        call.name,
        'visual search requires a non-empty query.',
      );
    }
    return {
      kind: 'registry',
      calls: [
        registryCall(
          call,
          'search_visual',
          copyDefined([
            ['query', query],
            ['k', limit],
            ['assetIds', assetIds],
            ['timeRange', timeRange],
          ]),
        ),
      ],
    };
  }

  if (mode === 'describe') {
    rejectFields(call, args, ['query', 'limit'], mode);
    const assetId = assetIds?.[0];
    if (!assetId || assetIds?.length !== 1) {
      throw new AutonomousToolRouteError(
        'invalid_args',
        call.name,
        'describe mode requires exactly one asset id in assetIds.',
      );
    }
    return {
      kind: 'registry',
      calls: [
        registryCall(
          call,
          'describe_footage',
          copyDefined([
            ['assetId', assetId],
            ['timeRange', timeRange],
          ]),
        ),
      ],
    };
  }

  // `map` is the only mode left here — the manifest validates the enum before routing.
  // The guard stays as defence against the manifest and this switch drifting apart.
  /* v8 ignore next 8 */
  if (mode !== 'map') {
    throw new AutonomousToolRouteError(
      'unsupported_mode',
      call.name,
      `Unsupported search_media mode "${String(mode)}".`,
    );
  }

  rejectFields(call, args, ['query', 'timeRange', 'limit'], mode);
  if (assetIds !== undefined && assetIds.length > 1) {
    throw new AutonomousToolRouteError(
      'invalid_args',
      call.name,
      'map mode accepts at most one asset id.',
    );
  }
  return {
    kind: 'registry',
    calls: [registryCall(call, 'map_footage', copyDefined([['assetId', assetIds?.[0]]]))],
  };
}

function routeAnalysis(
  call: AutonomousToolCall,
  args: Record<string, unknown>,
): AutonomousToolRoute {
  const kind = optionalString(args.kind);
  const assetId = optionalString(args.assetId);
  const options =
    typeof args.options === 'object' && args.options !== null && !Array.isArray(args.options)
      ? (args.options as Record<string, unknown>)
      : {};
  const names: Record<string, string> = {
    transcription: 'transcribe',
    silence: 'analyze_silence',
    scenes: 'detect_scenes',
    beats: 'detect_beats',
  };
  /* v8 ignore start -- the manifest schema validates this enum before routing, so this arm is unreachable defence that would only fire if the two drifted. */
  const name = kind === undefined ? undefined : names[kind];
  if (!name) {
    throw new AutonomousToolRouteError(
      'unsupported_mode',
      call.name,
      `Unsupported analyze_media kind "${String(kind)}".`,
    );
  }
  /* v8 ignore stop */
  return {
    kind: 'registry',
    calls: [
      registryCall(call, name, {
        ...options,
        ...(assetId === undefined ? {} : { assetId }),
      }),
    ],
  };
}

function routeDiscovery(
  call: AutonomousToolCall,
  args: Record<string, unknown>,
): AutonomousToolRoute {
  const kind = optionalString(args.kind);
  const query = optionalString(args.query);
  const names: Record<string, string> = {
    captions: 'discover_caption_styles',
    effects: 'discover_effects',
    transitions: 'discover_transitions',
  };
  /* v8 ignore start -- the manifest schema validates this enum before routing, so this arm is unreachable defence that would only fire if the two drifted. */
  const name = kind === undefined ? undefined : names[kind];
  if (!name) {
    throw new AutonomousToolRouteError(
      'unsupported_mode',
      call.name,
      `Unsupported discover_styles kind "${String(kind)}".`,
    );
  }
  /* v8 ignore stop */
  return {
    kind: 'registry',
    calls: [registryCall(call, name, query === undefined ? {} : { query })],
  };
}

function routeVerification(
  call: AutonomousToolCall,
  args: Record<string, unknown>,
): AutonomousToolRoute {
  const checks = optionalStringArray(args.checks) ?? [
    'captions',
    'transitions',
    'duration',
    'visual',
    'render',
  ];
  const calls: ToolCall[] = [];
  const runtimeChecks: RuntimeVerificationCheck[] = [];
  for (const check of [...new Set(checks)]) {
    if (check === 'captions') {
      calls.push(registryCall(call, 'verify_captions', {}, 'captions'));
      continue;
    }
    if (check === 'transitions') {
      calls.push(registryCall(call, 'verify_transitions', {}, 'transitions'));
      continue;
    }
    // The manifest validates the checks enum before routing; the guard stays as defence
    // against the manifest and this switch drifting apart.
    /* v8 ignore next 8 */
    if (check !== 'duration' && check !== 'visual' && check !== 'render') {
      throw new AutonomousToolRouteError(
        'unsupported_mode',
        call.name,
        `Unsupported verification check "${check}".`,
      );
    }
    runtimeChecks.push(check);
  }
  return { kind: 'verification', calls, runtimeChecks };
}

/** Translate one compact autonomous call into executable internal work. */
export function routeAutonomousToolCall(call: AutonomousToolCall): AutonomousToolRoute {
  const tool = requireReady(call);
  const args = recordOf(call.arguments ?? {}, call.name);
  try {
    assertAutonomousToolInput(tool, args);
  } catch (cause) {
    /* v8 ignore next -- zod and the manifest validator always throw Errors. */
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new AutonomousToolRouteError('invalid_args', call.name, detail);
  }

  switch (call.name) {
    case 'inspect_project':
      return { kind: 'registry', calls: [registryCall(call, 'get_project_state', {})] };
    case 'inspect_timeline':
      return { kind: 'registry', calls: [registryCall(call, 'get_timeline', {})] };
    case 'inspect_transcript':
      return {
        kind: 'registry',
        calls: [
          registryCall(
            call,
            'get_transcript',
            copyDefined([
              ['start', optionalNumber(args.start)],
              ['end', optionalNumber(args.end)],
            ]),
          ),
        ],
      };
    case 'get_frame': {
      const time = optionalNumber(args.time);
      /* v8 ignore start -- the manifest marks `time` required and numeric. */
      if (time === undefined) {
        throw new AutonomousToolRouteError('invalid_args', call.name, 'get_frame requires time.');
      }
      /* v8 ignore stop */
      return {
        kind: 'registry',
        calls: [registryCall(call, 'get_frame', { timeSeconds: time })],
      };
    }
    case 'search_media':
      return routeSearch(call, args);
    case 'analyze_media':
      return routeAnalysis(call, args);
    case 'plan_edit_candidates':
      return {
        kind: 'registry',
        calls: [
          registryCall(
            call,
            'propose_edits',
            copyDefined([
              ['chapters', args.chapters],
              ['highlights', args.highlights],
              ['silences', args.silences],
              ['sceneCuts', args.sceneCuts],
              ['verticalTarget', args.verticalTarget],
            ]),
          ),
        ],
      };
    case 'propose_timeline_patch':
    case 'propose_project_patch': {
      const scope = call.name === 'propose_timeline_patch' ? 'timeline' : 'project';
      return {
        kind: 'proposal',
        proposal: parseAutonomousPatchProposal({ ...args, scope }),
      };
    }
    case 'render_preview':
      return { kind: 'registry', calls: [registryCall(call, 'render_preview', {})] };
    case 'verify_result':
      return routeVerification(call, args);
    case 'ask_user':
    case 'load_skill':
    case 'recall_evidence':
    case 'manage_assets':
      return { kind: 'registry', calls: [registryCall(call, call.name, { ...args })] };
    case 'discover_styles':
      return routeDiscovery(call, args);
    case 'inspect_session':
      return { kind: 'registry', calls: [registryCall(call, 'session_context', {})] };
    /* v8 ignore start */
    default:
      throw new AutonomousToolRouteError(
        'tool_not_ready',
        call.name,
        `Autonomous tool "${call.name}" has no ready execution route.`,
      );
    /* v8 ignore stop */
  }
}
