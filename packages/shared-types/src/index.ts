/**
 * @framepilot/shared-types — common primitive types shared across all FramePilot packages.
 */
export * from './ipc.js';
export * from './project-snapshot-ipc.js';
export * from './media-import-stream.js';
export * from './active-transcription-ipc.js';
export * from './project-patch-transport.js';
export * from './logger.js';

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ProjectId = Brand<string, 'ProjectId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type TrackId = Brand<string, 'TrackId'>;
export type ClipId = Brand<string, 'ClipId'>;
export type EffectId = Brand<string, 'EffectId'>;
export type KeyframeId = Brand<string, 'KeyframeId'>;
export type PatchId = Brand<string, 'PatchId'>;

export const asId = <B extends string>(value: string): Brand<string, B> => value as Brand<string, B>;

export type Result<T, E = Error> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: E };
export const ok = <T>(data: T): Result<T, never> => ({ success: true, data });
export const err = <E>(error: E): Result<never, E> => ({ success: false, error });

export type Seconds = number;
export type Fps = number;
export interface Resolution {
  readonly width: number;
  readonly height: number;
}
export interface TimeRange {
  readonly start: Seconds;
  readonly end: Seconds;
}
