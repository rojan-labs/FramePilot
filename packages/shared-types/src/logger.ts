/**
 * @framepilot/shared-types/logger — one tiny, dependency-free logger shared by every
 * TypeScript surface.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * Capture the real platform sinks once. Desktop's legacy-console migration can safely
 * route later global console calls through createLogger without making logger output
 * recurse back into that router.
 */
const PLATFORM_CONSOLE = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
} as const;

function resolveLevel(): LogLevel {
  const fromNode =
    typeof process !== 'undefined' ? process.env?.['FRAMEPILOT_LOG_LEVEL'] : undefined;
  const fromBrowser =
    typeof globalThis !== 'undefined'
      ? (globalThis as Record<string, unknown>)['__FRAMEPILOT_LOG_LEVEL__']
      : undefined;
  const candidate = (fromNode ?? fromBrowser) as string | undefined;
  const level = candidate?.toLowerCase();
  return level && level in LEVEL_ORDER ? (level as LogLevel) : 'debug';
}

let activeLevel: LogLevel = resolveLevel();

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

export function getLogLevel(): LogLevel {
  return activeLevel;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  action(message: string, data?: unknown): void;
  child(subScope: string): Logger;
}

function emit(level: LogLevel, tag: string, scope: string, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;
  const line = `${new Date().toISOString()} ${tag} [${scope}] ${message}`;
  const sink =
    level === 'error'
      ? PLATFORM_CONSOLE.error
      : level === 'warn'
        ? PLATFORM_CONSOLE.warn
        : PLATFORM_CONSOLE.log;
  if (data !== undefined) sink(line, data);
  else sink(line);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, data) => emit('debug', 'DBG', scope, message, data),
    info: (message, data) => emit('info', 'INF', scope, message, data),
    warn: (message, data) => emit('warn', 'WRN', scope, message, data),
    error: (message, data) => emit('error', 'ERR', scope, message, data),
    action: (message, data) => emit('info', 'ACT', scope, message, data),
    child: (subScope) => createLogger(`${scope}:${subScope}`),
  };
}
