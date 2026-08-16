import type { Logger } from '@framepilot/shared-types';

export interface ConsoleLike {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

function asLogEntry(args: readonly unknown[]): { message: string; data?: unknown } {
  const [first, ...rest] = args;
  if (typeof first === 'string') {
    if (rest.length === 0) return { message: first };
    return { message: first, data: rest.length === 1 ? rest[0] : rest };
  }
  return {
    message: 'legacy console output',
    ...(args.length === 0 ? {} : { data: args.length === 1 ? first : args }),
  };
}

/**
 * Temporary migration boundary for legacy desktop-main console calls. The shared logger
 * owns captured platform sinks, so routing the process console through it cannot recurse.
 * Newly-authored host modules still import/create scoped loggers directly.
 */
export function installScopedConsoleRouter(target: ConsoleLike, logger: Logger): () => void {
  const original = {
    log: target.log,
    info: target.info,
    warn: target.warn,
    error: target.error,
    debug: target.debug,
  };
  const route = (level: 'debug' | 'info' | 'warn' | 'error', args: readonly unknown[]): void => {
    const entry = asLogEntry(args);
    logger[level](entry.message, entry.data);
  };
  target.log = (...args) => route('info', args);
  target.info = (...args) => route('info', args);
  target.warn = (...args) => route('warn', args);
  target.error = (...args) => route('error', args);
  target.debug = (...args) => route('debug', args);
  return () => {
    target.log = original.log;
    target.info = original.info;
    target.warn = original.warn;
    target.error = original.error;
    target.debug = original.debug;
  };
}
