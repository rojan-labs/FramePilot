/** Tests for the model-facing prompt builders. */
import { describe, expect, it } from 'vitest';
import {
  CRITIC_JUDGMENT_SYSTEM_PROMPT,
  PLAN_MODE_INSTRUCTION,
  QUESTION_MODE_INSTRUCTION,
  questionModeInstruction,
  SYSTEM_PROMPT,
  agentActionRecoveryBlock,
  agentModeInstruction,
  classifierSystemPrompt,
} from './prompts.js';

describe('SYSTEM_PROMPT', () => {
  it('states all five editing invariants in the stable shared contract', () => {
    expect(SYSTEM_PROMPT).toContain('never modify or delete original media');
    expect(SYSTEM_PROMPT).toContain('Every AI edit is a typed timeline operation');
    expect(SYSTEM_PROMPT).toContain('Every operation is validated before it is applied');
    expect(SYSTEM_PROMPT).toContain('Every render is checked automatically after it runs');
    expect(SYSTEM_PROMPT).toContain('ONLY through registered, schema-validated tools');
    expect(SYSTEM_PROMPT).toContain('reversible');
    expect(SYSTEM_PROMPT).toContain('never raw project JSON');
    expect(SYSTEM_PROMPT).toContain('human reviews every patch');
  });

  it('owns authority only, leaving craft and workflow to lower layers', () => {
    expect(SYSTEM_PROMPT).not.toContain('pacing');
    expect(SYSTEM_PROMPT).not.toContain('captions');
    expect(SYSTEM_PROMPT).not.toContain('Prefer the smallest');
  });
});

describe('agentModeInstruction', () => {
  it('continues from task memory instead of unconditionally re-orienting', () => {
    const text = agentModeInstruction();
    expect(text).toContain('AGENT mode');
    expect(text).toContain('RUN STATE');
    expect(text).toContain('DO THIS NOW');
    expect(text).toContain('inspect only evidence missing');
    expect(text).not.toContain('Read the timeline and assets first');
  });

  it('grounds content-dependent decisions in indexed visual search, not guesswork (MI6.3)', () => {
    // Retrieve-before-assume: for what a shot SHOWS / which footage to cut to, the model
    // must call search_visual and cite its evidence rather than infer from the transcript.
    const text = agentModeInstruction();
    expect(text).toContain('Ground every claim about what footage shows');
    expect(text).toContain('never invent content');
    expect(text).toContain('footage-intelligence skill');
  });

  it('tells the model to index first when footage is not indexed, and never guess with no key (MI6.3)', () => {
    // Mirrors MI6.2's "Visual index:" status line and the tools' honest-unavailable
    // strings: index_media when unindexed; with no embedding key, do not fabricate what
    // is on screen — fall back to the transcript or ask.
    const text = agentModeInstruction();
    expect(text).toContain('visual understanding is unavailable');
    expect(text).toContain('transcript/structural evidence');
  });

  it('points a re-read at recall_evidence instead of claiming the data is in context', () => {
    // The contract used to assert "the current timeline and assets are already in your
    // context", which stopped being true the moment compaction cleared the payload — and
    // the memo then refused to re-supply it (ADR 0075 §3.4). The honest instruction names
    // the retrieval path that actually exists.
    const text = agentModeInstruction();
    expect(text).toContain('recall_evidence');
    expect(text).toContain('filed');
    expect(text).not.toContain('already in your context');
  });

  it('classifies rejected calls and permits only one corrected retry', () => {
    const text = agentModeInstruction();
    expect(text).toContain('classify the reason and correct the cause ONCE');
    expect(text).toContain('unknown id');
    expect(text).toContain('overlap');
    expect(text).toContain('duration mismatch');
    expect(text).toContain('sourceStart + (end - start)');
    expect(text).toContain('unavailable capability');
    expect(text).toContain('single corrected retry also fails');
    expect(text).not.toContain('never give up while the goal is still achievable');
  });

  it('makes ask_user the only channel for questions — never plain reply text', () => {
    // The regression this pins: the model wrote its question (options and all) as
    // markdown text, which the UI cannot render as selectable choices and the run
    // cannot collect an answer to. The contract must say the tool is the only way.
    const text = agentModeInstruction();
    expect(text).toContain('ask_user');
    expect(text).toContain('NEVER put a question to the editor in plain reply text');
  });

  it('preserves partial work and the source/sequence timing boundary', () => {
    const text = agentModeInstruction();
    expect(text).toContain('CONTINUE from it');
    // The wipe guard is gone, so the contract no longer claims a full-track clear is
    // rejected — the continuity instruction stays, the refusal promise does not.
    expect(text).not.toMatch(/such a wipe is rejected/);
    expect(text).toContain('TWO TIMEBASES');
    expect(text).toContain('call map_time or get_mapped_transcript');
    expect(text).toContain('Do NOT compute offsets');
  });

  it('separates application from committed-state verification', () => {
    const text = agentModeInstruction();
    expect(text).toContain('DEPENDENCY POLICY');
    expect(text).toContain('list_edit_boundaries');
    expect(text).toContain('call verify_captions');
    expect(text).toContain('visually unreviewed');
    expect(text).toContain('verify_transitions');
    expect(text).toContain('applied but not verified');
  });
});

describe('layer responsibilities', () => {
  it('keeps plan mode non-mutating and outcome-oriented', () => {
    expect(PLAN_MODE_INSTRUCTION).toContain('observable');
    expect(PLAN_MODE_INSTRUCTION).toContain('plan only');
    expect(PLAN_MODE_INSTRUCTION).toContain('Do not call tools');
  });

  it('makes model criticism explicitly advisory to deterministic verification', () => {
    expect(CRITIC_JUDGMENT_SYSTEM_PROMPT).toContain('Deterministic verification alone');
    expect(CRITIC_JUDGMENT_SYSTEM_PROMPT).toContain('never proof of technical correctness');
  });
});

describe('QUESTION_MODE_INSTRUCTION', () => {
  it('routes questions to the editor through ask_user, never plain text', () => {
    expect(QUESTION_MODE_INSTRUCTION).toContain('ask_user');
    expect(QUESTION_MODE_INSTRUCTION).toContain('only ask_user can collect the decision');
    expect(QUESTION_MODE_INSTRUCTION).toContain('answer the editor directly');
  });

  it('owns evidence-backed answers without implying edits', () => {
    expect(QUESTION_MODE_INSTRUCTION).toContain('distinguish observed facts');
    expect(QUESTION_MODE_INSTRUCTION).toContain('insufficient');
    expect(QUESTION_MODE_INSTRUCTION).toContain('do not propose or imply a timeline change');
  });
});

describe('questionModeInstruction — looking is part of answering', () => {
  it('tells a sighted model to LOOK before it says it cannot tell', () => {
    // The regression: asked "how many people are on screen at 13.3s", the model read the
    // base contract's "say when the evidence is insufficient", judged the timeline summary
    // insufficient (it is — a summary cannot see), and said so with get_frame and
    // search_visual sitting unused in its tool list.
    const sighted = questionModeInstruction({ canSeeFrames: true });
    expect(sighted).toContain('You can SEE this footage');
    expect(sighted).toContain('get_frame');
    expect(sighted).toContain('search_visual');
    expect(sighted).toContain('honest answer only once you have looked');
    // The read-only contract is still the base of it.
    expect(sighted).toContain('do not propose or imply a timeline change');
  });

  it('says nothing about looking to a model that cannot see', () => {
    // Telling a text-only model to look instructs it to call a tool it was never offered.
    expect(questionModeInstruction()).toBe(QUESTION_MODE_INSTRUCTION);
    expect(questionModeInstruction({ canSeeFrames: false })).toBe(QUESTION_MODE_INSTRUCTION);
  });
});

describe('wire-prompt responsibilities', () => {
  it('sends every inspection request to the read-only route, imperative or not', () => {
    // "look into the frame" was classified `edit`, which offers 78 tools, spends the full
    // agent contract, and — because a run that applies nothing cannot pass verification
    // (ADR 0081) — settles as a red `failed` for a question that was answered correctly.
    const prompt = classifierSystemPrompt();
    expect(prompt).toContain('Looking at footage changes nothing');
    expect(prompt).toContain('inspect, identify, count, describe');
    expect(prompt).toContain('an imperative that');
  });

  it('routes without planning, and offers no route that no longer exists', () => {
    const prompt = classifierSystemPrompt();
    expect(prompt).toContain('"route": "chitchat" | "question" | "edit"');
    expect(prompt).toContain('do not plan edits');
    // Analysis-dependent work is still named — it just belongs to `edit` now, so the
    // model is told the agent gathers the evidence rather than that another route does.
    expect(prompt).toContain('beat/music synchronization');
    // Naming a retired route here would invite the model to return one the parser
    // rejects, costing a call to learn nothing. Both retired routes are checked.
    expect(prompt).not.toContain('recipe');
    expect(prompt).not.toContain('planned_edit');
  });
});

describe('agentActionRecoveryBlock', () => {
  it('is absent in normal turns and makes a recovery turn action-bound', () => {
    expect(agentActionRecoveryBlock(false)).toBe('');
    const block = agentActionRecoveryBlock(true);
    expect(block).toContain('ACTION RECOVERY');
    expect(block).toContain('Fresh reads and analysis are withheld');
    expect(block).toContain('mutation');
    expect(block).toContain('ask_user');
    expect(block).toContain('Do not claim the editing request is complete');
    // The turn's premise is that the run already HAS its evidence. Telling it to act
    // while withholding the only tool that returns what it gathered is why a real run
    // built forty-six clips on asset durations it inferred from clip-id suffixes.
    expect(block).toContain('recall_evidence');
  });

  it('states no cause that is false for either trigger', () => {
    // Fires for memo-only repeats AND for research-budget exhaustion, whose reads were
    // genuinely novel. Asserting the last turn re-read known data would be a false
    // premise in the second case, and a model given one can reasonably reject it.
    const block = agentActionRecoveryBlock(true);
    expect(block).not.toContain('already present');
    expect(block).not.toContain('only requested information');
  });
});

describe('agentModeInstruction — the visual self-check paragraph', () => {
  it('is present only for a run whose model can actually read an image', () => {
    // Telling a text-only model to look at a frame instructs it to call a tool it is not
    // offered — it either invents the call or apologises for not having it.
    expect(agentModeInstruction({ canSeeFrames: true })).toContain('LOOK AT YOUR WORK');
    expect(agentModeInstruction({ canSeeFrames: false })).not.toContain('get_frame');
    expect(agentModeInstruction()).not.toContain('get_frame');
  });

  it('bounds the looking, so a run does not become a slideshow', () => {
    // Each frame costs real context, and most of them settle nothing.
    const contract = agentModeInstruction({ canSeeFrames: true });
    expect(contract).toContain('one frame per call');
    expect(contract).toMatch(/sparing|deliberate/i);
  });

  it('still refuses to let a visual claim rest on timeline state alone', () => {
    for (const contract of [
      agentModeInstruction({ canSeeFrames: true }),
      agentModeInstruction({ canSeeFrames: false }),
    ]) {
      expect(contract).toContain('visually unreviewed');
    }
  });
});
