import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.ts';
import { extractJson, parseVerdict } from '../src/json.ts';
import { formatFixes, reopenFailed, runOrchestration } from '../src/machine.ts';
import type {
  AgentResult,
  CheckResult,
  Config,
  ExecutorRequest,
  LeadRequest,
  Log,
  OrcEvent,
  RunState,
  Workspace,
} from '../src/types.ts';

const reply = (text: string, sessionId?: string): AgentResult => ({
  text,
  sessionId,
  inputTokens: 10,
  cachedTokens: 3,
  outputTokens: 5,
});

const PLAN_ONE = JSON.stringify({ tasks: [{ id: 'T1', title: 'Add feature', summary: 'does it' }] });
const PLAN_TWO = JSON.stringify({
  tasks: [
    { id: 'T1', title: 'First', summary: 'one' },
    { id: 'T2', title: 'Second', summary: 'two' },
  ],
});
const WORK_ORDER = JSON.stringify({
  goal: 'Make it work',
  files_in_scope: ['a.js'],
  files_off_limits: [],
  steps: ['Edit a.js'],
  acceptance_criteria: ['a.js works'],
  verify_commands: ['npm test'],
});
const PASS = JSON.stringify({ verdict: 'pass', summary: 'good', issues: [], next_instruction: '' });
const ASK_PLAN = JSON.stringify({ questions: ['Which database?', 'Keep the old API?'] });
const FAIL_WITH_QUESTION = JSON.stringify({
  verdict: 'fail',
  summary: 'unclear requirement',
  issues: [{ file: 'a.js', problem: 'ambiguous behaviour', required_fix: '' }],
  questions: ['Should empty input throw or return empty?'],
  next_instruction: '',
});
const fail = (n: number): string =>
  JSON.stringify({
    verdict: 'fail',
    summary: `bad ${n}`,
    issues: [{ file: 'a.js', problem: `problem ${n}`, required_fix: 'fix it' }],
    next_instruction: `FIX-INSTRUCTION-${n}`,
  });

interface Harness {
  leadCalls: LeadRequest[];
  executorCalls: ExecutorRequest[];
  events: OrcEvent[];
  commits: string[];
  asked: { stage: string; questions: string[] }[];
  resets: string[];
  refreshes: number[];
  run(): ReturnType<typeof runOrchestration>;
}

function harness(opts: {
  plan?: string;
  /** Architect replies before it starts returning work orders. Defaults to just the plan. */
  architect?: string[];
  /** When set, a user is "present" and gives these answers to every question. */
  answer?: string;
  /** Saved state of an earlier, interrupted run to continue. */
  resume?: RunState;
  /** Make the executor crash on this call number (1-based), as a limit or outage would. */
  executorFailsOn?: number;
  /** The first N executor runs change no files. */
  emptyRuns?: number;
  /** Commands those empty runs report as blocked. */
  blocked?: string[];
  /** Messages the user sends, delivered on the first inbox check. */
  notes?: string[];
  attachments?: string[];
  /** The first N executor runs end early (as a timeout would), after writing files. */
  endEarly?: number;
  /** Replies to the plan check, in order; once used up, the plan is approved. */
  approvals?: string[];
  /** Reviewer replies, consumed in order across the whole run. */
  reviews: string[];
  checks?: (call: number) => CheckResult[];
  cfg?: Partial<Config>;
  /** Conversation id the executor reports. */
  executorSession?: string;
  /** What the executor replies, in order; then "done". */
  executorReplies?: string[];
}): Harness {
  const leadCalls: LeadRequest[] = [];
  const executorCalls: ExecutorRequest[] = [];
  const events: OrcEvent[] = [];
  const commits: string[] = [];
  const reviews = [...opts.reviews];
  const architect = [...(opts.architect ?? [opts.plan ?? PLAN_ONE])];
  const asked: { stage: string; questions: string[] }[] = [];
  const resets: string[] = [];
  const inboxNotes = [...(opts.notes ?? [])];
  const approvals = [...(opts.approvals ?? [])];
  const refreshes: number[] = [];
  const verifyRuns: string[][] = [];
  let executorRuns = 0;
  let executorCalled = 0;
  let changedSinceCheckpoint = false;
  let verifyCalls = 0;

  const workspace: Workspace = {
    dir: '/fake/worktree',
    branch: 'orc/test',
    head: async () => `sha${commits.length}`,
    // Like git: a checkpoint only makes a commit when something changed since the last one.
    checkpoint: async (message) => {
      if (changedSinceCheckpoint) commits.push(message);
      changedSinceCheckpoint = false;
      return `sha${commits.length}`;
    },
    diff: async () => 'diff --git a/a.js b/a.js\n+changed',
    changedFiles: async () => ['a.js'],
    read: async () => 'FULL-FILE-CONTENT',
    reset: async () => void resets.push('reset'),
  };
  const log: Log = {
    dir: '/fake/run',
    emit: (e) => void events.push(e),
    saveState: () => {},
    saveArtifact: () => {},
  };

  return {
    leadCalls,
    executorCalls,
    events,
    commits,
    asked,
    resets,
    refreshes,
    verifyRuns,
    run: () =>
      runOrchestration({
        runId: 'test',
        request: 'do the thing',
        cfg: { ...DEFAULTS, ...opts.cfg },
        // A real resume reads the state back from disk, so hand over a copy, not the live object.
        resume: opts.resume ? (JSON.parse(JSON.stringify(opts.resume)) as RunState) : undefined,
        workspace,
        log,
        verify: async (cmds: string[]) => (verifyRuns.push(cmds), opts.checks?.(++verifyCalls) ?? []),
        inbox: () => (inboxNotes.length ? inboxNotes.splice(0) : []),
        attachments: opts.attachments,
        attachDir: '/fake/run/attachments',
        refresh: () => void refreshes.push(executorCalls.length),
        askUser:
          opts.answer === undefined
            ? undefined
            : async (stage, questions) => {
                asked.push({ stage, questions });
                if (stage === 'plan approval') return [approvals.shift() ?? ''];
                return questions.map(() => opts.answer!);
              },
        lead: {
          async ask(req) {
            leadCalls.push(req);
            if (req.role === 'architect') {
              return reply(architect.shift() ?? WORK_ORDER, 'arch-session');
            }
            if (req.role === 'escalation') {
              changedSinceCheckpoint = true;
              return reply('I fixed it myself', 'esc-session');
            }
            const next = reviews.shift();
            if (next === undefined) throw new Error('test ran out of reviewer replies');
            return reply(next, `rev-session`);
          },
        },
        executor: {
          async run(req) {
            if (++executorRuns === opts.executorFailsOn) throw new Error('429 rate limit reached');
            executorCalls.push(req);
            const empty = ++executorCalled <= (opts.emptyRuns ?? 0);
            changedSinceCheckpoint = !empty;
            const early = executorCalled <= (opts.endEarly ?? 0) ? 'it ran out of time (20 minutes) before finishing' : undefined;
            return { ...reply(opts.executorReplies?.[executorCalled - 1] ?? 'done', opts.executorSession), blocked: empty ? (opts.blocked ?? []) : [], endedEarly: early };
          },
        },
      }),
  };
}

const byRole = (h: Harness, role: string) => h.leadCalls.filter((c) => c.role === role);

test('passes on the first attempt: one executor call, no escalation', async () => {
  const h = harness({ reviews: [PASS] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.executorCalls.length, 1);
  assert.equal(byRole(h, 'escalation').length, 0);
  assert.equal(state.tasks[0].attempts, 1);
  assert.equal(state.tasks[0].escalated, false);
});

test('fails twice then passes: the reviewer\'s instruction reaches the next attempt', async () => {
  const h = harness({ reviews: [fail(1), fail(2), PASS] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.executorCalls.length, 3);
  assert.ok(!h.executorCalls[0].prompt.includes('FIX-INSTRUCTION'));
  assert.ok(h.executorCalls[1].prompt.includes('FIX-INSTRUCTION-1'));
  assert.ok(h.executorCalls[2].prompt.includes('FIX-INSTRUCTION-2'));
  assert.equal(byRole(h, 'escalation').length, 0);
});

test('three failed attempts escalate to the lead, and the executor is not called a fourth time', async () => {
  const h = harness({ reviews: [fail(1), fail(2), fail(3), PASS] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.executorCalls.length, 3);
  const esc = byRole(h, 'escalation');
  assert.equal(esc.length, 1);
  assert.equal(esc[0].tools, 'write');
  assert.ok(esc[0].prompt.includes('problem 3'), 'escalation sees the attempt history');
  assert.equal(state.tasks[0].escalated, true);
  // It branches off the review conversation instead of reading everything again, and is saved.
  assert.equal(esc[0].sessionId, 'rev-session');
  assert.equal(esc[0].fork, true);
  assert.equal(state.tasks[0].escalationSession, 'esc-session');
});

test('a failed escalation stops the run for a human and skips later tasks', async () => {
  const h = harness({ plan: PLAN_TWO, reviews: [fail(1), fail(2), fail(3), fail(4)] });
  const state = await h.run();
  assert.equal(state.status, 'needs_human');
  assert.equal(state.tasks[0].status, 'failed');
  assert.equal(state.tasks[1].status, 'pending');
  assert.equal(h.executorCalls.length, 3);
});

test('a failed step can be retried: fresh attempts, same instructions and review conversation, later tasks run', async () => {
  const first = harness({ plan: PLAN_TWO, reviews: [fail(1), fail(2), fail(3), fail(4)] });
  const stopped = await first.run();
  assert.equal(stopped.status, 'needs_human');

  const order = JSON.stringify(stopped.tasks[0].workOrder);
  reopenFailed(stopped);
  assert.equal(stopped.status, 'paused');
  const second = harness({ plan: PLAN_TWO, reviews: [fail(5), PASS, PASS], resume: stopped });
  const done = await second.run();
  assert.equal(done.status, 'passed');
  assert.equal(second.executorCalls.length, 3, 'two attempts on the retried step, one on the next');
  assert.equal(byRole(second, 'escalation').length, 0);
  assert.equal(JSON.stringify(done.tasks[0].workOrder), order, 'the retried step keeps its instructions');
  assert.equal(byRole(second, 'reviewer')[0].sessionId, 'rev-session', 'the review conversation is continued');
  assert.deepEqual(done.tasks.map((t) => t.attempts), [6, 1]);
  assert.equal(done.tasks[0].retries, 1);
});

test('a retried step can be taken over again by the lead after its fresh attempts', async () => {
  const first = harness({ reviews: [fail(1), fail(2), fail(3), fail(4)] });
  const stopped = await first.run();
  reopenFailed(stopped);
  const second = harness({ reviews: [fail(5), fail(6), fail(7), PASS], resume: stopped });
  const done = await second.run();
  assert.equal(done.status, 'passed');
  assert.equal(second.executorCalls.length, 3);
  const esc = byRole(second, 'escalation');
  assert.equal(esc.length, 1);
  assert.equal(esc[0].fork, true, 'a new takeover branches off the review conversation');
});

test('one review conversation for the whole run; each task still gets its own attempt budget', async () => {
  const h = harness({ plan: PLAN_TWO, reviews: [fail(1), PASS, PASS] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.deepEqual(state.tasks.map((t) => t.attempts), [2, 1]);
  const reviews = byRole(h, 'reviewer');
  assert.equal(reviews[0].sessionId, undefined, 'the first review starts the conversation');
  assert.equal(reviews[1].sessionId, 'rev-session', 'the re-review resumes it');
  assert.equal(reviews[2].sessionId, 'rev-session', 'task 2 is reviewed in the same conversation');
  assert.equal(state.reviewerSession, 'rev-session');
});

test('the lead writes later instructions from a summary of finished work, not by re-reading', async () => {
  const h = harness({ plan: PLAN_TWO, reviews: [PASS, PASS] });
  await h.run();
  const orders = byRole(h, 'architect').filter((r) => r.prompt.includes('Write the work order'));
  assert.ok(!orders[0].prompt.includes('What the finished tasks built'));
  assert.ok(orders[1].prompt.includes('What the finished tasks built'));
  assert.ok(orders[1].prompt.includes('Do not re-read code'));
});

test('only the escalation may write; the architect reads and the reviewer has no tools', async () => {
  const h = harness({ reviews: [fail(1), fail(2), fail(3), PASS] });
  await h.run();
  const expected = { architect: 'read', reviewer: 'none', escalation: 'write' };
  for (const call of h.leadCalls) assert.equal(call.tools, expected[call.role]);
});

test('reviews carry the diff, not full files; a re-review gets only the changes since the last one', async () => {
  const h = harness({ reviews: [fail(1), PASS] });
  await h.run();
  const reviews = byRole(h, 'reviewer');
  assert.ok(!reviews[0].prompt.includes('FULL-FILE-CONTENT'));
  assert.ok(reviews[0].prompt.includes('DIFF AGAINST THE START OF THIS TASK'));
  assert.ok(reviews[1].prompt.includes('DIFF SINCE YOUR LAST REVIEW'));
});

test('the lead can ask the user before planning, and gets the answers', async () => {
  const h = harness({ architect: [ASK_PLAN, PLAN_ONE], reviews: [PASS], answer: 'Postgres' });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.asked.filter((a) => a.stage !== 'plan approval').length, 1);
  assert.deepEqual(h.asked.filter((a) => a.stage !== 'plan approval')[0].questions, ['Which database?', 'Keep the old API?']);
  const architect = byRole(h, 'architect');
  assert.ok(architect[1].prompt.includes('Which database?') && architect[1].prompt.includes('Postgres'));
  assert.equal(h.executorCalls.length, 1);
});

test('the lead cannot keep asking forever before planning', async () => {
  const h = harness({ architect: [ASK_PLAN, ASK_PLAN, ASK_PLAN, PLAN_ONE], reviews: [PASS], answer: 'x' });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.asked.filter((a) => a.stage !== 'plan approval').length, 2, 'two rounds of questions, then it must plan');
});

test('unattended runs tell the lead not to ask, and never call the user', async () => {
  const h = harness({ reviews: [FAIL_WITH_QUESTION, PASS] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.asked.length, 0);
  assert.ok(byRole(h, 'architect')[0].prompt.includes('Nobody is available'));
  assert.ok(h.executorCalls[1].prompt.includes('ambiguous behaviour'), 'falls back to the issues');
});

test('on a failed review the lead asks the user, then rewrites the retry from the answer', async () => {
  const h = harness({ reviews: [FAIL_WITH_QUESTION, fail(7), PASS], answer: 'return empty' });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.asked.filter((a) => a.stage !== 'plan approval').length, 1);
  assert.deepEqual(h.asked.filter((a) => a.stage !== 'plan approval')[0].questions, ['Should empty input throw or return empty?']);
  const reviews = byRole(h, 'reviewer');
  assert.ok(reviews[1].prompt.includes('return empty'), 'the answer goes back to the reviewer');
  assert.ok(h.executorCalls[1].prompt.includes('FIX-INSTRUCTION-7'), 'the rewritten instruction drives the retry');
  assert.equal(h.executorCalls.length, 2, 'asking a question does not use up an extra attempt');
});

test('a failing check overrules a reviewer pass', async () => {
  const bad: CheckResult = { command: 'npm test', ok: false, exitCode: 1, output: '1 failing' };
  const good: CheckResult = { command: 'npm test', ok: true, exitCode: 0, output: 'ok' };
  const h = harness({ reviews: [PASS, PASS], checks: (call) => [call === 1 ? bad : good] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.executorCalls.length, 2);
  assert.ok(h.executorCalls[1].prompt.includes('1 failing'));
});

test('an unusable reviewer reply is re-asked once in the same conversation', async () => {
  const h = harness({ reviews: ['Looks fine to me!', PASS] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(byRole(h, 'reviewer').length, 2);
  assert.equal(h.executorCalls.length, 1);
});

test('maxAttempts is configurable', async () => {
  const h = harness({ reviews: [fail(1), PASS], cfg: { maxAttempts: 1 } });
  const state = await h.run();
  assert.equal(h.executorCalls.length, 1);
  assert.equal(state.tasks[0].escalated, true);
});

test('an agent crash pauses the run instead of throwing', async () => {
  const h = harness({ reviews: [] });
  const state = await h.run();
  assert.equal(state.status, 'paused');
  assert.match(state.error ?? '', /ran out of reviewer replies/);
  assert.ok(h.events.some((e) => e.type === 'paused' && e.limit === false));
});

test('a limit hit mid-attempt pauses; resume redoes only that attempt, with the same instructions', async () => {
  const first = harness({ reviews: [fail(1)], executorFailsOn: 2 });
  const paused = await first.run();
  assert.equal(paused.status, 'paused');
  assert.ok(first.events.some((e) => e.type === 'paused' && e.limit === true), 'recognised as a limit');
  assert.equal(first.executorCalls.length, 1);

  const second = harness({ reviews: [PASS], resume: paused });
  const done = await second.run();
  assert.equal(done.status, 'passed');
  assert.equal(second.resets.length, 1, 'half-done edits are discarded first');
  assert.equal(byRole(second, 'architect').length, 0, 'no re-planning and no new work order');
  assert.equal(second.executorCalls.length, 1);
  assert.ok(second.executorCalls[0].prompt.includes('This is attempt 2'));
  assert.ok(second.executorCalls[0].prompt.includes('FIX-INSTRUCTION-1'));
  assert.equal(done.tasks[0].attempts, 2);
});

test('a stop during review resumes at the review, without running the executor again', async () => {
  const first = harness({ reviews: [fail(1)] }); // the second review call crashes
  const paused = await first.run();
  assert.equal(paused.status, 'paused');
  assert.equal(first.executorCalls.length, 2);
  assert.equal(paused.tasks[0].pending?.label, 'attempt 2');

  const second = harness({ reviews: [PASS], resume: paused });
  const done = await second.run();
  assert.equal(done.status, 'passed');
  assert.equal(second.executorCalls.length, 0);
  const review = byRole(second, 'reviewer');
  assert.equal(review.length, 1);
  assert.equal(review[0].sessionId, 'rev-session', 'the reviewer conversation is continued');
});

test('resume keeps the attempt count: one attempt left, then escalation', async () => {
  const first = harness({ reviews: [fail(1), fail(2)], executorFailsOn: 3 });
  const paused = await first.run();
  assert.equal(paused.status, 'paused');

  const second = harness({ reviews: [fail(3), PASS], resume: paused });
  const done = await second.run();
  assert.equal(done.status, 'passed');
  assert.equal(second.executorCalls.length, 1, 'only the third attempt remains');
  assert.equal(byRole(second, 'escalation').length, 1);
  assert.equal(done.tasks[0].escalated, true);
});

test('resume skips tasks that already passed', async () => {
  const first = harness({ plan: PLAN_TWO, reviews: [PASS], executorFailsOn: 2 });
  const paused = await first.run();
  assert.deepEqual(paused.tasks.map((t) => t.status), ['passed', 'running']);

  const second = harness({ reviews: [PASS], resume: paused });
  const done = await second.run();
  assert.equal(done.status, 'passed');
  assert.equal(second.executorCalls.length, 1);
  assert.equal(byRole(second, 'architect').length, 0, 'task 2 already had its work order');
});

test('usage keeps adding up across a pause', async () => {
  const first = harness({ reviews: [fail(1)], executorFailsOn: 2 });
  const paused = await first.run();
  const second = harness({ reviews: [PASS], resume: paused });
  const done = await second.run();
  assert.equal(done.usage.executor.calls, 2);
  assert.equal(done.usage.reviewer.calls, 2);
});

test('usage is counted per role', async () => {
  const h = harness({ reviews: [fail(1), PASS] });
  const state = await h.run();
  assert.equal(state.usage.architect.calls, 2);
  assert.equal(state.usage.reviewer.calls, 2);
  assert.equal(state.usage.executor.calls, 2);
  assert.equal(state.usage.executor.inputTokens, 20);
  assert.equal(state.usage.executor.cachedTokens, 6);
});

test('extractJson reads fenced and prose-wrapped objects', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 1}\n```\nDone.'), { a: 1 });
  assert.deepEqual(extractJson('Sure. {"a": {"b": 2}} Hope that helps'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'));
});

test('a fail verdict without a next instruction is rejected', () => {
  assert.throws(() => parseVerdict({ verdict: 'fail', summary: 'x', issues: [], next_instruction: '' }));
  assert.throws(() => parseVerdict({ verdict: 'maybe' }));
});

test('an executor run that changes nothing is not counted as an attempt', async () => {
  const h = harness({ reviews: [PASS], emptyRuns: 2 });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.executorCalls.length, 3, 'two empty runs, then a real one');
  assert.equal(byRole(h, 'reviewer').length, 1, 'empty runs are not reviewed');
  assert.equal(state.tasks[0].attempts, 1, 'still attempt 1');
  assert.equal(h.events.filter((e) => e.type === 'attempt_empty').length, 2);
  assert.ok(h.executorCalls[1].prompt.includes('ended without changing any files'));
});

test('three empty runs in a row pause the run without using an attempt', async () => {
  const h = harness({ reviews: [], emptyRuns: 3, blocked: ['node --version'] });
  const state = await h.run();
  assert.equal(state.status, 'paused');
  assert.match(state.error ?? '', /not allowed to run commands/);
  assert.equal(state.tasks[0].history?.length ?? 0, 0, 'no attempt recorded');
  assert.equal(byRole(h, 'escalation').length, 0, 'the lead does not take over');
});

test('empty runs never trigger the escalation, even with one attempt allowed', async () => {
  const h = harness({ reviews: [PASS], emptyRuns: 1, cfg: { maxAttempts: 1 } });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(byRole(h, 'escalation').length, 0);
});

test('a message from the user reaches the lead once, at its next call', async () => {
  const h = harness({ reviews: [PASS], notes: ['Use dark colours'] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  const architect = byRole(h, 'architect');
  assert.ok(architect[0].prompt.includes('Use dark colours'));
  assert.ok(!architect[1].prompt.includes('Use dark colours'), 'not repeated in the same conversation');
  assert.ok(byRole(h, 'reviewer')[0].prompt.includes('Use dark colours'), 'the reviewer is told too');
  assert.deepEqual(state.userNotes, ['Use dark colours']);
});

test('attached files are named to the lead, which can open the attachments folder', async () => {
  const h = harness({ reviews: [PASS], attachments: ['/fake/run/attachments/mockup.png'] });
  await h.run();
  const plan = byRole(h, 'architect')[0];
  assert.ok(plan.prompt.includes('/fake/run/attachments/mockup.png'));
  assert.deepEqual(plan.addDirs, ['/fake/run/attachments']);
  assert.equal(h.executorCalls[0].attachDir, '/fake/run/attachments');
});

test('a message with files gives the reviewer read access for that one call', async () => {
  const note = 'Match this colour\n\nATTACHED FILES from the user:\n- /fake/run/attachments/c.png';
  const h = harness({ reviews: [PASS], notes: [note] });
  await h.run();
  // The architect sees it first; a fresh reviewer conversation sees it too and needs to open it.
  const review = byRole(h, 'reviewer')[0];
  assert.ok(review.prompt.includes('c.png'));
  assert.equal(review.tools, 'read');
});

test('with someone present, the plan is shown for approval before any work starts', async () => {
  const h = harness({ reviews: [PASS], answer: 'x' });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  const check = h.asked.find((a) => a.stage === 'plan approval');
  assert.ok(check, 'the plan was shown');
  assert.ok(check.questions[0].includes('Add feature'));
  assert.equal(state.planApproved, true);
});

test('changes to the plan go back to the lead, and the revised plan is shown again', async () => {
  const h = harness({ architect: [PLAN_ONE, PLAN_TWO], reviews: [PASS, PASS], answer: 'x', approvals: ['Split it into two parts'] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.asked.filter((a) => a.stage === 'plan approval').length, 2);
  assert.ok(byRole(h, 'architect')[1].prompt.includes('Split it into two parts'));
  assert.deepEqual(state.tasks.map((t) => t.title), ['First', 'Second']);
  assert.equal(h.executorCalls.length, 2, 'work started only after approval');
});

test('unattended runs and runs with the check turned off do not wait for approval', async () => {
  const off = harness({ reviews: [PASS], answer: 'x', cfg: { confirmPlan: false } });
  await off.run();
  assert.equal(off.asked.filter((a) => a.stage === 'plan approval').length, 0);
  const unattended = harness({ reviews: [PASS] });
  assert.equal((await unattended.run()).status, 'passed');
});

test('a run already past planning is not asked to approve its plan again', async () => {
  const first = harness({ plan: PLAN_TWO, reviews: [PASS], executorFailsOn: 2, cfg: { confirmPlan: false } });
  const paused = await first.run();
  delete paused.planApproved;
  const second = harness({ reviews: [PASS], answer: 'x', resume: paused });
  await second.run();
  assert.equal(second.asked.filter((a) => a.stage === 'plan approval').length, 0);
});

test('a run that times out after writing files is reviewed, not thrown away', async () => {
  const h = harness({ reviews: [fail(1), PASS], endEarly: 1 });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.ok(byRole(h, 'reviewer')[0].prompt.includes('did not finish'), 'the reviewer is told it was cut short');
  assert.ok(h.events.some((e) => e.type === 'executor_ended_early'));
  assert.equal(state.tasks[0].attempts, 2);
});

test('a run that times out without writing anything is not counted', async () => {
  const h = harness({ reviews: [PASS], endEarly: 1, emptyRuns: 1 });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(state.tasks[0].attempts, 1);
  assert.ok(h.executorCalls[1].prompt.includes('ran out of time'));
});

test('saved option changes are re-read before every model call', async () => {
  const h = harness({ reviews: [fail(1), PASS] });
  await h.run();
  // two plan/work-order calls + two reviews + two executor runs
  assert.ok(h.refreshes.length >= 6, `re-read ${h.refreshes.length} times`);
});

test('Hydrogen workers: one per assignment, and a retry reruns only the flagged ones', async () => {
  const { workerRuns } = await import('../src/machine.ts');
  const wo = {
    goal: 'g', files_in_scope: ['a.rs', 'b.rs', 'c.rs'], files_off_limits: [], steps: ['s'], acceptance_criteria: ['ac'], verify_commands: [],
    assignments: [{ files: ['a.rs', 'b.rs'], instructions: 'write a and b; b exports fn b()' }, { files: ['c.rs'], instructions: 'write c; call b()' }],
  };
  const first = workerRuns(wo, 1, undefined);
  assert.deepEqual(first.map((w) => w.label), ['worker 1 (a.rs +1)', 'worker 2 (c.rs)']);
  assert.ok(first[0].prompt.includes('You own ONLY these files:\n- a.rs\n- b.rs'));
  assert.ok(first[0].prompt.includes('do not create, edit or delete them:\n- c.rs'));
  assert.match(first[1].prompt, /write c; call b\(\)/);
  const verdict = { verdict: 'fail' as const, summary: '', questions: [], next_instruction: 'fix c', issues: [{ file: './C.rs', problem: 'p', required_fix: 'f' }] };
  const retry = workerRuns(wo, 2, verdict);
  assert.deepEqual(retry.map((w) => w.label), ['worker 2 (c.rs)']);
  assert.ok(retry[0].prompt.includes('ISSUES IN YOUR FILES\n1. ./C.rs: p'));
  const unnamed = workerRuns(wo, 2, { ...verdict, issues: [{ file: '', problem: 'p', required_fix: '' }] });
  assert.equal(unnamed.length, 2);
  const plain = workerRuns({ ...wo, assignments: undefined }, 1, undefined);
  assert.equal(plain.length, 1);
  assert.equal(DEFAULTS.executorWorkers, '');
});

test('the page script parses', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/ui/page.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const code of scripts) assert.doesNotThrow(() => new Function(code));
});

test('format checks get a formatter run first; other checks do not', () => {
  assert.deepEqual(formatFixes(['cargo fmt --all -- --check', 'cargo test --workspace', 'npx prettier --check web']), ['cargo fmt --all', 'npx prettier --write web']);
  assert.deepEqual(formatFixes(['npm test']), []);
});

test('the formatter runs before the work is checkpointed and checked', async () => {
  const h = harness({ reviews: [PASS], cfg: { verifyCommands: ['cargo fmt --all -- --check'] } });
  await h.run();
  assert.deepEqual(h.verifyRuns, [['cargo fmt --all'], ['cargo fmt --all -- --check']]);
});

test('a finished run takes a new request: planned in the same conversation, added as new tasks', async () => {
  const first = harness({ reviews: [PASS] });
  const done = await first.run();
  assert.equal(done.status, 'passed');

  done.followUp = 'Make it deployable to Vercel';
  done.status = 'paused';
  const second = harness({ architect: [PLAN_ONE], reviews: [PASS], resume: done });
  const after = await second.run();
  assert.equal(after.status, 'passed');
  assert.equal(after.tasks.length, 2);
  assert.equal(after.tasks[0].status, 'passed');
  assert.equal(after.tasks[1].status, 'passed');
  assert.notEqual(after.tasks[1].id, after.tasks[0].id, 'task ids stay unique');
  const arch = byRole(second, 'architect');
  assert.ok(arch[0].prompt.includes('The user now asks for more'));
  assert.ok(arch[0].prompt.includes('Make it deployable to Vercel'));
  assert.equal(arch[0].sessionId, 'arch-session', 'the planner remembers the project');
  assert.equal(second.executorCalls.length, 1, 'the finished task is not redone');
  assert.deepEqual(after.followUps, ['Make it deployable to Vercel']);
  assert.equal(after.followUp, undefined);
});

test('with takeovers off, the workers get another round instead of the lead taking over', async () => {
  const h = harness({ reviews: [fail(1), fail(2), fail(3), fail(4), PASS], cfg: { takeover: false } });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.executorCalls.length, 5);
  assert.equal(byRole(h, 'escalation').length, 0);
  assert.equal(state.tasks[0].rounds, 2);
  assert.ok(h.executorCalls[3].prompt.includes('problem 3') || JSON.stringify(h.executorCalls[3]).includes('problem 3'), 'round 2 starts from the latest review');
});

test('with takeovers off, the run stops for the user after the last round', async () => {
  const h = harness({ reviews: Array.from({ length: 12 }, (_, i) => fail(i + 1)), cfg: { takeover: false } });
  const state = await h.run();
  assert.equal(state.status, 'needs_human');
  assert.equal(h.executorCalls.length, 12);
  assert.equal(byRole(h, 'escalation').length, 0);
});

test('a retried Hydrogen worker continues its own conversation with only the review', async () => {
  const { workerRuns } = await import('../src/machine.ts');
  const wo = {
    goal: 'g', files_in_scope: ['a.rs', 'c.rs'], files_off_limits: [], steps: ['s'], acceptance_criteria: ['ac'], verify_commands: [],
    assignments: [{ files: ['a.rs'], instructions: 'write a' }, { files: ['c.rs'], instructions: 'write c' }],
  };
  const first = workerRuns(wo, 1, undefined, '', {});
  assert.deepEqual(first.map((w) => w.key), ['a.rs', 'c.rs']);
  assert.equal(first[0].sessionId, undefined);
  const verdict = { verdict: 'fail' as const, summary: '', questions: [], next_instruction: 'fix c please', issues: [{ file: 'c.rs', problem: 'p', required_fix: 'f' }] };
  const retry = workerRuns(wo, 2, verdict, '', { 'c.rs': 'conv-c' });
  assert.equal(retry.length, 1);
  assert.equal(retry[0].sessionId, 'conv-c');
  assert.ok(retry[0].prompt.includes('fix c please'));
  assert.ok(!retry[0].prompt.includes('THE WHOLE TASK'), 'the task is not sent again');
  assert.ok(retry[0].freshPrompt!.includes('THE WHOLE TASK'), 'a fresh start still has everything');
  const noSession = workerRuns(wo, 2, verdict, '', {});
  assert.equal(noSession[0].sessionId, undefined);
  assert.ok(noSession[0].prompt.includes('THE WHOLE TASK'));
});

test('open-ended mode: one Hydrogen session does every task, nothing is reviewed', async () => {
  const h = harness({ plan: PLAN_TWO, reviews: [], executorSession: 'hydro-1', cfg: { mode: 'open', verifyCommands: ['npm test'] },
    checks: () => [{ command: 'npm test', ok: false, exitCode: 1, output: 'boom' }] });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(byRole(h, 'reviewer').length, 0);
  assert.equal(byRole(h, 'escalation').length, 0);
  assert.equal(h.executorCalls.length, 2);
  assert.equal(h.executorCalls[0].sessionId, undefined);
  assert.equal(h.executorCalls[0].model, 'gemini-4-hydrogen-high');
  assert.ok(h.executorCalls[0].prompt.includes('Nobody reviews your work'));
  // The second task continues the first one's conversation with only the new task.
  assert.equal(h.executorCalls[1].sessionId, 'hydro-1');
  assert.ok(h.executorCalls[1].prompt.startsWith('Next: task 2 of 2'));
  assert.ok(h.executorCalls[1].freshPrompt!.includes('Nobody reviews your work'));
  assert.ok(state.tasks.every((t) => t.status === 'passed'));
  // A failed check is reported to the user, not sent back.
  assert.match(state.tasks[0].history![0].summary, /Not reviewed.*npm test/);
  // The work order asks for no worker assignments and tells the lead there is no review.
  const wo = byRole(h, 'architect')[1].prompt;
  assert.ok(wo.includes('OPEN-ENDED RUN'));
  assert.ok(!wo.includes('assignments'));
});

test('open-ended mode uses the chosen Hydrogen model', async () => {
  const h = harness({ reviews: [], cfg: { mode: 'open', executorWorkers: 'gemini-4-hydrogen-low' } });
  await h.run();
  assert.equal(h.executorCalls[0].model, 'gemini-4-hydrogen-low');
  assert.equal(h.executorCalls[0].workers, undefined);
});

test('open-ended mode: work committed before a stop is not redone on resume', async () => {
  const first = harness({ reviews: [], cfg: { mode: 'open' } });
  const done = await first.run();
  const resume = JSON.parse(JSON.stringify(done)) as RunState;
  resume.status = 'paused';
  resume.tasks[0].status = 'running';
  resume.tasks[0].pending = { label: 'attempt 1', fileTag: 'attempt1', report: 'wrote it' };
  resume.tasks[0].history = [];
  const h = harness({ reviews: [], cfg: { mode: 'open' }, resume });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.equal(h.executorCalls.length, 0);
});

const SUBAGENT_ASK = JSON.stringify({ subagents: [{ role: 'ui', files: ['a.js'], job: 'the page' }, { role: 'api', files: ['b.js'], job: 'the server' }], why: 'independent' });

test('open-ended mode: Hydrogen asks for sub-agents, Opus approves, Hydrogen runs exactly those', async () => {
  const approval = JSON.stringify({ approved: true, subagents: [{ role: 'ui', files: ['a.js'], job: 'the page only' }], note: 'keep b.js yourself' });
  const h = harness({ architect: [PLAN_ONE, WORK_ORDER, approval], reviews: [], emptyRuns: 1, executorReplies: [SUBAGENT_ASK], executorSession: 'hydro-1', cfg: { mode: 'open' } });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.ok(h.executorCalls[0].prompt.includes("SUB-AGENTS NEED THE LEAD'S APPROVAL"));
  const asked = byRole(h, 'architect')[2].prompt;
  assert.ok(asked.includes('1. ui: the page (files: a.js)') && asked.includes('2. api: the server'));
  assert.equal(h.executorCalls.length, 2);
  assert.equal(h.executorCalls[1].sessionId, 'hydro-1');
  assert.ok(h.executorCalls[1].prompt.startsWith('The lead approved these sub-agents'));
  assert.ok(h.executorCalls[1].prompt.includes('1. ui: the page only'));
  assert.ok(!h.executorCalls[1].prompt.includes('api'));
  assert.ok(h.executorCalls[1].prompt.includes('keep b.js yourself'));
  assert.ok(h.events.some((e) => e.type === 'subagents_decided' && e.approved === true));
  assert.ok(!h.events.some((e) => e.type === 'attempt_empty'));
});

test('open-ended mode: when Opus rejects the sub-agents, Hydrogen does the task alone', async () => {
  const rejection = JSON.stringify({ approved: false, subagents: [], note: 'too coupled' });
  const h = harness({ architect: [PLAN_ONE, WORK_ORDER, rejection], reviews: [], emptyRuns: 1, executorReplies: [SUBAGENT_ASK], cfg: { mode: 'open' } });
  const state = await h.run();
  assert.equal(state.status, 'passed');
  assert.ok(h.executorCalls[1].prompt.startsWith('The lead did not approve sub-agents'));
  assert.ok(h.executorCalls[1].prompt.includes('too coupled'));
});

test('open-ended mode: no sub-agent request means no extra Opus call', async () => {
  const h = harness({ reviews: [], cfg: { mode: 'open' } });
  await h.run();
  assert.equal(byRole(h, 'architect').length, 2);
  assert.equal(h.executorCalls.length, 1);
});
