/**
 * Candidate ids that mean the same thing for the whole run — and after a restart (AM2.2).
 *
 * The agent log keeps only the two freshest tool payloads (memory: agent-log-payload-window),
 * so an id the model passes to `create_mask` ten turns after `find_mask_targets` has to
 * resolve WITHOUT the payload that minted it. The id is therefore a pure function of what was
 * measured: the asset, the frame, the label, and the box quantised to a thousandth of the
 * picture. Detection is deterministic, so re-detecting that one frame reproduces the id exactly
 * and the host can resolve it from nothing but the id itself.
 *
 * An id minted by an AMBIGUOUS result carries the `pick.` prefix. `create_mask` accepts such an
 * id only when it appears in the editor's own message — the sidebar picker writes it there — so
 * "resolve the target or ask, never guess" (plan 11 rule 2) is enforced by the tool, not left to
 * the model's restraint. A confident wrong pick is the worst failure this domain has.
 */
import type { NormalizedBox } from './shape-fit.js';

export type MaskCandidateLabel = 'face' | 'person' | 'object';

const LABEL_PREFIX: Readonly<Record<MaskCandidateLabel, string>> = {
  face: 'f',
  person: 'p',
  object: 'o',
};
const PREFIX_LABEL: Readonly<Record<string, MaskCandidateLabel>> = {
  f: 'face',
  p: 'person',
  o: 'object',
};

/** Marks an id the editor has to confirm before it can be masked. */
export const PICK_REQUIRED_PREFIX = 'pick.';

/** Box coordinates are compared at this resolution: a thousandth of the picture. */
const BOX_QUANTUM = 1000;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a, 32-bit: small, dependency-free, and stable across runtimes. Not a security hash. */
function fnv1a(text: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const quantise = (value: number): number => Math.round(value * BOX_QUANTUM);

export interface CandidateIdentity {
  readonly assetId: string;
  readonly frame: number;
  readonly label: MaskCandidateLabel;
  readonly box: NormalizedBox;
}

/** The stable id of one measured thing on one frame. */
export function candidateIdFor(identity: CandidateIdentity): string {
  const { assetId, frame, label, box } = identity;
  const key = [
    assetId,
    frame,
    label,
    quantise(box.x),
    quantise(box.y),
    quantise(box.width),
    quantise(box.height),
  ].join('|');
  return `${LABEL_PREFIX[label]}${String(frame)}_${fnv1a(key)}`;
}

/** Mark an id as needing the editor's confirmation. Idempotent. */
export function requirePick(candidateId: string): string {
  return candidateId.startsWith(PICK_REQUIRED_PREFIX)
    ? candidateId
    : `${PICK_REQUIRED_PREFIX}${candidateId}`;
}

export interface ParsedCandidateId {
  readonly label: MaskCandidateLabel;
  /** The frame the candidate was measured on; re-detecting it reproduces the id. */
  readonly frame: number;
  readonly pickRequired: boolean;
  /** The id without the pick marker: what {@link candidateIdFor} returns. */
  readonly measuredId: string;
}

/** Read what an id says about itself, or `null` when it is not one of ours. */
export function parseCandidateId(candidateId: string): ParsedCandidateId | null {
  const pickRequired = candidateId.startsWith(PICK_REQUIRED_PREFIX);
  const measuredId = pickRequired ? candidateId.slice(PICK_REQUIRED_PREFIX.length) : candidateId;
  const match = /^([fpo])(\d{1,9})_[0-9a-f]{8}$/u.exec(measuredId);
  if (match === null) return null;
  return { label: PREFIX_LABEL[match[1]!]!, frame: Number(match[2]), pickRequired, measuredId };
}

/** Every candidate id written in a piece of text — the editor's pick, as the picker sent it. */
export function candidateIdsIn(text: string): string[] {
  return [...text.matchAll(/(?:pick\.)?[fpo]\d{1,9}_[0-9a-f]{8}/gu)].map((match) => match[0]);
}
