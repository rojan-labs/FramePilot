/**
 * Tests for conversation export (Phase 11 M7): the FULL Markdown transcript + JSON
 * round-trip. The Markdown export is a debugging artefact people paste into a bug
 * report, so its contract is "nothing in the log is missing" — every test here pins
 * a class of detail that used to be silently dropped.
 */
import { describe, expect, it } from 'vitest';
import { type AiEvent, createTurnEmitter } from '@framepilot/ai-sdk';
import { appendEvent, createConversation } from './conversation.js';
import { toJson, toMarkdown } from './conversationExport.js';

const emitter = (turnId = 't') => createTurnEmitter({ conversationId: 'c', turnId, now: () => 1 });

/** A conversation built from `events`, all in one turn. */
const conversationOf = (events: readonly AiEvent[]) =>
  events.reduce(
    (conv, event) => appendEvent(conv, event),
    createConversation({ projectId: 'project-1', id: 'c1', model: 'mock', now: 0 }),
  );

const build = () => {
  const em = emitter();
  return conversationOf([
    em.userMessage('Trim the intro'),
    em.assistant('a', 'Done — trimmed 3s.'),
  ]);
};

/** A minimal valid {@link EditResult}-shaped value for diff rendering. */
const editResult = (operations: readonly unknown[] = [{ type: 'delete_clip', clipId: 'clip-1' }]) =>
  ({
    text: 'Trimmed the intro',
    patch: {
      patchId: 'patch_1',
      createdBy: 'agent',
      reason: 'User asked to trim',
      operations,
    },
    validation: {
      valid: false,
      issues: [{ code: 'overlap', severity: 'error', message: 'Clips overlap' }],
    },
    diff: { before: {}, after: {}, summary: ['Removed clip-1'] },
  }) as never;

describe('toMarkdown', () => {
  it('renders a header with the conversation metadata', () => {
    const md = toMarkdown(build());
    expect(md).toContain('# Trim the intro');
    expect(md).toContain('- **Conversation:** c1');
    expect(md).toContain('- **Project:** project-1');
    expect(md).toContain('- **Model:** mock');
    expect(md).toContain('- **Mode:** agent');
    expect(md).toContain('- **Events:** 2');
  });

  it('renders user and assistant messages', () => {
    const md = toMarkdown(build());
    expect(md).toContain('### 👤 You');
    expect(md).toContain('Trim the intro');
    expect(md).toContain('### 💬 FramePilot');
    expect(md).toContain('Done — trimmed 3s.');
  });

  it('folds streamed deltas into a single message instead of replaying chunks', () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([
        em.delta('a', 'Trim'),
        em.delta('a', 'med it.'),
        em.assistant('a', 'Trimmed it.'),
      ]),
    );
    expect(md).toContain('Trimmed it.');
    expect(md.match(/### 💬 FramePilot/g)).toHaveLength(1);
  });

  it('includes thinking summaries', () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([
        em.reasoning(['Looking at the first clip'], false),
        em.reasoning(['Looking at the first clip'], true),
      ]),
    );
    expect(md).toContain('### 🧠 Thinking');
    expect(md).toContain('> Looking at the first clip');
    expect(md.match(/### 🧠 Thinking/g)).toHaveLength(1);
  });

  it('includes the plan checklist with per-step status', () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([
        em.plan([
          { id: 's1', label: 'Trim intro', status: 'completed' },
          { id: 's2', label: 'Add captions', status: 'failed', detail: 'no transcript' },
        ]),
      ]),
    );
    expect(md).toContain('- [x] Trim intro — completed');
    expect(md).toContain('- [!] Add captions — failed · no transcript');
  });

  it('includes tool calls with arguments, raw input/result, logs and warnings', () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([
        em.toolCall('tc1', 'analyze_silence', 'running', { argsSummary: 'threshold=-40dB' }),
        em.toolCall('tc1', 'analyze_silence', 'completed', { runtimeMs: 2400 }),
        em.toolResult('tc1', {
          summary: 'Found 3 gaps',
          input: { threshold: -40 },
          result: { gaps: [{ start: 1, end: 2 }] },
          files: ['/media/a.mp4'],
          clips: ['clip-1'],
          tracks: ['track-1'],
          logs: ['ffmpeg: ok'],
          warnings: ['low sample rate'],
        }),
      ]),
    );
    expect(md).toContain('### 🛠 Tool · analyze_silence — completed · 2.4s');
    expect(md).toContain('- **Arguments:** `threshold=-40dB`');
    expect(md).toContain('> Found 3 gaps');
    expect(md).toContain('"threshold": -40');
    expect(md).toContain('"gaps"');
    expect(md).toContain('- /media/a.mp4');
    expect(md).toContain('- clip-1');
    expect(md).toContain('- track-1');
    expect(md).toContain('- ffmpeg: ok');
    expect(md).toContain('- low sample rate');
    // The call is rendered once, in its final state — not once per status update.
    expect(md.match(/### 🛠 Tool/g)).toHaveLength(1);
  });

  it("includes the model's question and its options", () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([
        em.toolCall('tc1', 'ask_user', 'running'),
        em.ask('tc1', 'Which take should I keep?', [
          { label: 'Take 2', description: 'cleaner audio' },
        ]),
      ]),
    );
    expect(md).toContain('#### Question to you');
    expect(md).toContain('> Which take should I keep?');
    expect(md).toContain('- **Take 2** — cleaner audio');
  });

  it('includes a proposed edit with its operations and validation issues', () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([em.diff(editResult(), undefined, { scope: 'turn', turnIndex: 0 })]),
    );
    expect(md).toContain('### 📝 Proposed edit · 1 operation(s)');
    expect(md).toContain('- **Patch id:** patch_1');
    expect(md).toContain('- **Reason:** User asked to trim');
    expect(md).toContain('- **Scope:** turn');
    expect(md).toContain('- **Valid:** false');
    expect(md).toContain('`error` `overlap` — Clips overlap');
    expect(md).toContain('"type": "delete_clip"');
    expect(md).toContain('- Removed clip-1');
  });

  it('still records an edit the sidebar drops (zero operations)', () => {
    const em = emitter();
    const md = toMarkdown(conversationOf([em.diff(editResult([]))]));
    expect(md).toContain('### ❔ diff');
    expect(md).toContain('"patchId": "patch_1"');
  });

  it('includes timeline actions, references, progress and notices', () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([
        em.timelineAction('Trimmed', 'Removed 3s from the intro', [
          { kind: 'clip', id: 'clip-1', label: 'Intro' },
        ]),
        em.reference([{ kind: 'file', id: '/a.mp4', label: 'a.mp4' }]),
        em.progress('Rendering', 0.5),
        em.notification('Using the local model', { reason: 'no_api_key', detail: 'offline' }),
        em.warning('Audio is clipping'),
        em.error('Render failed', { detail: 'ffmpeg exit 1', retryable: true }),
      ]),
    );
    expect(md).toContain('### ✏️ Trimmed');
    expect(md).toContain('Removed 3s from the intro');
    expect(md).toContain('References: `clip:clip-1` Intro');
    expect(md).toContain('🔗 References: `file:/a.mp4` a.mp4');
    expect(md).toContain('⏳ Rendering — 50%');
    expect(md).toContain('> Using the local model');
    expect(md).toContain('- **Reason:** no_api_key');
    expect(md).toContain('⚠️ Warning');
    expect(md).toContain('> Audio is clipping');
    expect(md).toContain('⚠️ Error');
    expect(md).toContain('- **Detail:** ffmpeg exit 1');
    expect(md).toContain('- **Retryable:** true');
  });

  it('includes review findings', () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([
        {
          ...em.notification('x'),
          type: 'review_finding',
          turnIndex: 1,
          detail: 'The cut lands mid-word',
          atSeconds: 12.5,
          resolved: false,
          lineage: ['temporal:asr'],
        } as unknown as AiEvent,
      ]),
    );
    expect(md).toContain('### 🔍 Review finding (turn 1)');
    expect(md).toContain('> The cut lands mid-word');
    expect(md).toContain('- **At:** 12.5s');
    expect(md).toContain('- **Lineage:** temporal:asr');
  });

  it('includes run status transitions, usage and context occupancy', () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([
        em.status('thinking'),
        em.usage({ tokens: 1200, usd: 0.03, modelCalls: 2 }),
        em.contextUsage({ usedTokens: 8000, contextWindow: 200_000, estimated: true }),
        em.status('completed'),
      ]),
    );
    expect(md).toContain('_Run status: **thinking**');
    expect(md).toContain('_Run status: **completed**');
    expect(md).toContain('- **Tokens:** 1200');
    expect(md).toContain('- **Cost (USD):** 0.03');
    expect(md).toContain('- **Model calls:** 2');
    expect(md).toContain('- **Used tokens:** 8000');
    expect(md).toContain('- **Context window:** 200000');
    expect(md).toContain('- **Final status:** completed');
  });

  it('includes DAG task lifecycle, checkpoint and run state', () => {
    const em = emitter();
    const md = toMarkdown(
      conversationOf([
        em.taskStarted('task-1', 'Analyze silence', 'ffmpeg'),
        em.effectProgress('task-1', 'Analyzing', 0.25),
        em.taskFinished('task-1', 'completed', 900),
        em.checkpoint({
          goal: 'Make a 45s short',
          ops: [{ type: 'delete_clip' }],
          log: ['Trimmed intro'],
          stepsCompleted: 2,
          working: { stage: 'editing' },
        }),
        em.runState({ stage: 'editing' }),
      ]),
    );
    expect(md).toContain('▶️ Task started: Analyze silence (`task-1`, ffmpeg)');
    expect(md).toContain('⏳ Analyzing — 25% (`task-1`)');
    expect(md).toContain('⏹ Task completed: `task-1` · 900ms');
    expect(md).toContain('### 🚩 Checkpoint');
    expect(md).toContain('- **Goal:** Make a 45s short');
    expect(md).toContain('- **Steps completed:** 2');
    expect(md).toContain('- Trimmed intro');
    expect(md).toContain('"stage": "editing"');
    expect(md).toContain('### 🧾 Run state');
  });

  it('separates turns with a numbered heading', () => {
    const first = emitter('t1');
    const second = emitter('t2');
    const md = toMarkdown(
      conversationOf([
        first.userMessage('Trim the intro'),
        first.assistant('a1', 'Done.'),
        second.userMessage('Now add captions'),
      ]),
    );
    expect(md).toContain('## Turn 1 ·');
    expect(md).toContain('## Turn 2 ·');
  });
});

describe('toJson', () => {
  it('round-trips the exact conversation record', () => {
    const conv = build();
    expect(JSON.parse(toJson(conv))).toEqual(conv);
  });
});
