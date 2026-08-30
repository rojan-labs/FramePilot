/**
 * The attachment ownership lifecycle (PROMPT.md §6).
 *
 * The defect these pin: an attachment lived ONLY in composer state. A sent message
 * carried nothing but text, so the attachment could not appear in its bubble, was never
 * cleared from the composer, and was therefore re-sent as a reference on every later
 * turn of the conversation. Composer state and message state were one mutable thing.
 *
 * The contract now: on submit the composer's attachments are frozen onto the message,
 * the composer is emptied, and every later reader — the bubble, the model's references,
 * a Retry — reads the MESSAGE, never the composer.
 */
import { describe, expect, it } from 'vitest';
import { createTurnEmitter, reduceEvents, type ReferenceProfile } from '@framepilot/ai-sdk';
import { activeReferences, toMessageAttachments, type Attachment } from './conversation.js';

const emitter = (turnId = 'turn_1') =>
  createTurnEmitter({ conversationId: 'c1', turnId, now: () => 1000 });

const profile = (id: string): ReferenceProfile => ({
  id,
  role: 'pacing',
  kind: 'video',
  fileName: `${id}.mp4`,
  contentHash: 'a'.repeat(16),
  analyzedAt: '2026-08-30T00:00:00.000Z',
  constraints: ['Cuts land about every 1.2s.'],
});

const ready = (id: string): Attachment => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  role: 'pacing',
  status: 'ready',
  path: `media/${id}.mp4`,
  profile: profile(id),
});

describe('toMessageAttachments — the composer→message boundary', () => {
  it('carries the identity, the file and the analysis onto the message', () => {
    expect(toMessageAttachments([ready('ref_1')])).toEqual([
      {
        id: 'ref_1',
        kind: 'video',
        name: 'ref_1.mp4',
        role: 'pacing',
        path: 'media/ref_1.mp4',
        profile: profile('ref_1'),
      },
    ]);
  });

  it('drops the composer-only fields', () => {
    // `status` and `error` describe work that is over the moment the message is sent.
    // A message that kept them would re-render whenever a spinner elsewhere moved.
    const [frozen] = toMessageAttachments([
      { ...ready('ref_1'), status: 'failed', error: 'analysis timed out' },
    ]);
    expect(frozen).not.toHaveProperty('status');
    expect(frozen).not.toHaveProperty('error');
  });

  it('takes an attachment whose analysis never finished, without a profile', () => {
    // Leaving it behind would empty the composer only partly — the half-state this
    // whole change exists to remove. It travels, and it travels honestly.
    const [frozen] = toMessageAttachments([
      { id: 'ref_2', kind: 'image', name: 'look.png', status: 'analyzing' },
    ]);
    expect(frozen).toMatchObject({ id: 'ref_2', name: 'look.png' });
    expect(frozen?.profile).toBeUndefined();
  });

  it('preserves order and keeps multiple attachments distinct', () => {
    const frozen = toMessageAttachments([ready('a'), ready('b'), ready('c')]);
    expect(frozen.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(new Set(frozen.map((a) => a.id)).size).toBe(3);
  });

  it('never shares a mutable reference with the composer object', () => {
    // §6: composerAttachments and messageAttachments "must never share mutable
    // references". Editing the chip after sending must not rewrite the sent message.
    const composer = ready('ref_1');
    const [frozen] = toMessageAttachments([composer]);
    expect(frozen).not.toBe(composer);
  });
});

describe('a sent message owns what was attached to it', () => {
  it('carries the attachments on the event and into the rendered bubble', () => {
    const event = emitter().userMessage(
      'make it feel like this',
      toMessageAttachments([ready('r')]),
    );
    expect(event.attachments).toHaveLength(1);
    const [node] = reduceEvents([event]).nodes;
    expect(node).toMatchObject({ kind: 'user', text: 'make it feel like this' });
    expect(node?.kind === 'user' ? node.attachments?.[0]?.name : undefined).toBe('r.mp4');
  });

  it('omits the field entirely when nothing was attached', () => {
    // An absent array and an empty one must mean the same thing to every reader, so
    // only one of them is ever written.
    expect(emitter().userMessage('just text').attachments).toBeUndefined();
    expect(emitter().userMessage('just text', []).attachments).toBeUndefined();
  });

  it('survives the JSON round trip persistence performs', () => {
    const event = emitter().userMessage('x', toMessageAttachments([ready('r')]));
    const restored = JSON.parse(JSON.stringify(event)) as typeof event;
    expect(restored.attachments?.[0]?.profile).toEqual(profile('r'));
  });

  it('reads back the references a turn was sent with, from the message alone', () => {
    // This is what stops an attachment riding along on every later turn: the run's
    // references are derived from the message, so a message with none sends none.
    const withRef = emitter('t1').userMessage('like this', toMessageAttachments([ready('r')]));
    const without = emitter('t2').userMessage('now shorter');
    const referencesOf = (e: { attachments?: readonly { profile?: ReferenceProfile }[] }) =>
      (e.attachments ?? []).flatMap((a) => (a.profile ? [a.profile] : []));
    expect(referencesOf(withRef)).toHaveLength(1);
    expect(referencesOf(without)).toHaveLength(0);
  });

  it('sends no reference for an attachment that was never analyzed', () => {
    const event = emitter().userMessage(
      'and this one',
      toMessageAttachments([
        { id: 'd', kind: 'document', name: 'brief.pdf', status: 'unsupported' },
      ]),
    );
    // Still ON the message — the user attached it and the bubble must say so — but it
    // contributes nothing to the model, because nothing was measured from it.
    expect(event.attachments).toHaveLength(1);
    expect(event.attachments?.[0]?.profile).toBeUndefined();
  });
});

/**
 * The other half of the ownership split, and the one that is easy to get wrong.
 *
 * Message ownership answers "what did the user attach to THIS message?". The SDK asks a
 * different question every turn: "which references are in force RIGHT NOW?" — and it is
 * explicit that an id missing from that set means the editor removed the tile, so the
 * decision it was binding must stop applying (kernel/conductor.ts, P3.5).
 *
 * Sending only the current message's attachments answers the first question in place of
 * the second, which silently retires every reference on the turn after it was attached.
 * These pin the derivation that keeps both answers true at once.
 */
describe('activeReferences — the live set the run is given', () => {
  const message = (turnId: string, ids: readonly string[]) =>
    emitter(turnId).userMessage('go', toMessageAttachments(ids.map(ready)));

  it('keeps a reference in force on turns that attach nothing', () => {
    const log = [message('t1', ['a']), emitter('t2').userMessage('now tighten the middle')];
    expect(activeReferences(log).map((p) => p.id)).toEqual(['a']);
  });

  it('accumulates references across turns, in the order they were attached', () => {
    const log = [message('t1', ['a']), message('t2', ['b', 'c'])];
    expect(activeReferences(log).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a dismissed reference, which is how a removal reaches the run', () => {
    const log = [message('t1', ['a']), message('t2', ['b'])];
    expect(activeReferences(log, ['a']).map((p) => p.id)).toEqual(['b']);
  });

  it('reports an empty set once every reference is dismissed', () => {
    // Not the same as "never had any": [] is what tells the SDK the tiles are gone.
    expect(activeReferences([message('t1', ['a'])], ['a'])).toEqual([]);
  });

  it('counts the same file attached to two messages once', () => {
    const log = [message('t1', ['a']), message('t2', ['a'])];
    expect(activeReferences(log)).toHaveLength(1);
  });

  it('ignores attachments that were never analyzed', () => {
    const log = [
      emitter('t1').userMessage(
        'and this',
        toMessageAttachments([
          { id: 'd', kind: 'document', name: 'brief.pdf', status: 'unsupported' },
        ]),
      ),
    ];
    expect(activeReferences(log)).toEqual([]);
  });

  it('is empty for a conversation that never attached anything', () => {
    expect(activeReferences([emitter('t1').userMessage('just text')])).toEqual([]);
  });
});
