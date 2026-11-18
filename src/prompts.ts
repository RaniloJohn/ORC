import type { Assignment, CheckResult, PlanTask, Verdict, WorkOrder } from './types.ts';

const JSON_ONLY = 'Reply with only the JSON object. No prose before or after it.';

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - max} characters omitted ...]\n\n${text.slice(-half)}`;
}

const PLAN_SHAPE = `{"tasks": [{"id": "T1", "title": "short title", "summary": "what this task delivers"}], "assumptions": ["each choice you made where the request left room"]}`;

/** The marker that tells the code a message carries files the lead must be able to open. */
export const ATTACHED = 'ATTACHED FILES';

export function attachmentsText(paths: string[]): string {
  if (!paths.length) return '';
  return `\n\n${ATTACHED} from the user (open them with your Read tool; images, PDFs and text all work):\n` +
    paths.map((p) => `- ${p}`).join('\n') +
    `\nThe executor can read these too. When one matters for a task, name its full path in that task's work order and say what to take from it.`;
}

export function planPrompt(request: string, canAsk: boolean, attachments: string[] = []): string {
  const asking = canAsk
    ? `Before you plan, decide what the request leaves open. Asking is cheap; guessing wrong is
expensive. Unless this is a small, self-contained change, ask about every decision with real
consequences that the request does not settle: scope (what is in and what is out), the stack or
libraries, look and feel, data, accounts or hosting, and what to do with existing code. Do not
turn those into assumptions. Ask only what neither the request nor the repository answers, and at
most 6 questions; offer the likely options in each question so the user can answer quickly. To
ask, reply with:
{"questions": ["...", "..."]}
The user's answers will come back to you and you will plan then.

If nothing needs asking, reply with the plan:`
    : `Nobody is available to answer questions in this run. Where the request leaves something
open, make the most reasonable choice and record it in "assumptions". Reply with the plan:`;

  return `You are planning work on this repository. You do not write code in this step. A separate
executor model will implement each task from your written instructions, and you will review its
work afterwards.

The request:
${request}${attachmentsText(attachments)}

Inspect the repository with your read tools first.

${asking}
${PLAN_SHAPE}

Planning rules:
- Use as few tasks as the work honestly needs. A small request is one task. Never more than 8.
- Each task must be checkable on its own once it is done.
- Order them so each task builds only on the ones before it.

${JSON_ONLY}`;
}

/** A new request on a run whose plan is finished: the lead plans only the new work, from memory. */
export function followUpPrompt(request: string, finished: string, canAsk: boolean, attachments: string[] = []): string {
  return `Every task of the plan above is finished and in the user's folder. The user now asks for more:

${request}${attachmentsText(attachments)}

${finished ? `What the finished tasks built:\n${finished}\n\n` : ''}Plan only this new work, as new tasks that build on what exists. Plan from what you already
know; open a file only when you cannot decide something without it.
${canAsk ? 'If something essential is unclear, ask first with {"questions": [...]} (at most 4). Otherwise reply with the plan:' : 'Nobody can answer questions now; record your choices in "assumptions". Reply with the plan:'}
${PLAN_SHAPE}

Use as few tasks as the work honestly needs; a small request is one task. Never more than 8.

${JSON_ONLY}`;
}

function qaText(questions: string[], answers: string[]): string {
  return questions
    .map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${answers[i]?.trim() || '(no answer given: use your judgement and record it as an assumption)'}`)
    .join('\n\n');
}

export function planAnswersPrompt(questions: string[], answers: string[], mayAskAgain: boolean): string {
  return `The user answered your questions:

${qaText(questions, answers)}

${mayAskAgain
    ? 'If an answer raised something essential you still cannot decide, you may ask once more with {"questions": [...]}. Otherwise reply with the plan:'
    : 'No more questions can be asked. Reply with the plan now, recording any remaining choices in "assumptions":'}
${PLAN_SHAPE}

${JSON_ONLY}`;
}

/** The plan as the user sees it when asked to approve it. */
export function planReviewText(tasks: { title: string; summary: string }[], assumptions: string[]): string {
  const lines = tasks.map((t, i) => `${i + 1}. ${t.title}: ${t.summary}`);
  const assumed = assumptions.length
    ? `\n\nDecided without asking you:\n${assumptions.map((a) => `- ${a}`).join('\n')}`
    : '';
  return `Here is the plan.\n\n${lines.join('\n')}${assumed}\n\nApprove it to start the work, or say what to change.`;
}

export function planRevisionPrompt(feedback: string): string {
  return `The user reviewed your plan and wants changes:

${feedback}

Revise the plan and the assumptions to match. If their reply raises something essential you cannot
decide, ask with {"questions": [...]}; otherwise reply with the revised plan:
${PLAN_SHAPE}

${JSON_ONLY}`;
}

/** What the lead needs to know about the executor before instructing or judging it. */
export function executorSetupText(o: { minutes: number; workers: string; canRunCommands: boolean; open?: boolean }): string {
  const team = o.open
    ? `OPEN-ENDED RUN. The executor is one Hydrogen session (${o.workers || OPEN_MODEL}) that does every task of this plan in the same conversation, so it remembers the project and its own earlier work. It may ask to split a task among its own sub-agents; you approve or change that split before any sub-agent starts. Nobody reviews its work before the user does, so your work order is the only guidance it gets: make it complete and exact.`
    : o.workers
    ? `The executor is a set of Hydrogen workers (${o.workers}). orc starts one worker per assignment in your work order, all at the same time. Each worker owns only its assignment's files, sees its own instructions plus the task's goal, steps and acceptance criteria, and cannot talk to the others. After a failed review, only the workers that own a file named in your issues are run again, so name the file on every issue.`
    : 'The executor, Argon, writes the code itself.';
  const commands = o.canRunCommands
    ? 'It can run commands (installs, builds, tests) in the project.'
    : 'It CANNOT run any command: no installs, builds, tests or scripts, only reading and writing files. So never require it to run something or to paste command output; put such checks in "verify_commands" (orc runs them only if the user trusts them) and judge the rest by reading the code.';
  return `ABOUT THE EXECUTOR
${team} ${commands} It has about ${o.minutes} minutes per attempt.`;
}

export function workOrderPrompt(
  task: PlanTask,
  index: number,
  total: number,
  executorMinutes = 45,
  setup = '',
  withWorkers = false,
  finished = '',
): string {
  return `${setup ? `${setup}

` : ''}Write the work order for task ${index + 1} of ${total}: "${task.title}".
Summary: ${task.summary}

${finished ? `What the finished tasks built:
${finished}

` : ''}Write it from what you already know: the plan, our conversation and the finished work above.
Do not re-read code to write it. The executor opens only the files it changes and the files you
name, and does not explore the project, so name every file it must read for context (the types,
functions and interfaces it calls) and give exact names and signatures where you know them.
Open a file only when you cannot decide something without it.
The executor sees only this work order, not our conversation, so carry into it everything the
user told you that bears on this task. Write it so a capable developer with no context could
carry it out without guessing:
- "goal": what must be true when the task is finished.
- "files_in_scope": paths the executor may create or change.
- "files_off_limits": paths it must not touch.
- "steps": ordered, concrete instructions. Name functions, files and behaviour exactly.
  The executor has about ${executorMinutes} minutes per attempt and loses anything unfinished, so size the work:
  no more than roughly 8 files or 1,500 new lines per task, with large modules split into
  several files. Order the steps so each one leaves a file complete before the next starts.
- "acceptance_criteria": statements you will check the result against in review.
- "verify_commands": shell commands that prove it works (tests, build, lint). Empty if none exist.${withWorkers ? `
- "assignments": how to split files_in_scope among the Hydrogen workers. They run at the same time
  and cannot talk to each other, so each needs self-contained instructions. Every file in
  files_in_scope belongs to exactly one assignment. Use at most 4 assignments; keep tightly
  coupled files in the same one; a small task can be a single assignment. In each "instructions",
  say what to write in those files and give the exact names, signatures and types of everything
  it uses from, or provides to, the other assignments.` : ''}

${JSON_ONLY}
{"goal": "", "files_in_scope": [], "files_off_limits": [], "steps": [], "acceptance_criteria": [], "verify_commands": []${withWorkers ? ', "assignments": [{"files": [], "instructions": ""}]' : ''}}`;
}

function workOrderText(wo: WorkOrder): string {
  const list = (items: string[], empty: string) =>
    items.length ? items.map((s, i) => `${i + 1}. ${s}`).join('\n') : empty;
  return `GOAL
${wo.goal}

FILES YOU MAY CHANGE
${list(wo.files_in_scope, 'Any file the goal requires.')}

FILES YOU MUST NOT TOUCH
${list(wo.files_off_limits, 'None listed.')}

STEPS
${list(wo.steps, '')}

ACCEPTANCE CRITERIA
${list(wo.acceptance_criteria, '')}`;
}

function issueList(issues: Verdict['issues']): string {
  return issues.length
    ? issues
        .map((it, i) => `${i + 1}. ${it.file ? `${it.file}: ` : ''}${it.problem}${it.required_fix ? `\n   Required fix: ${it.required_fix}` : ''}`)
        .join('\n')
    : 'See the instruction above.';
}

const samePath = (a: string, b: string): boolean =>
  a.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase() === b.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/** The issues that name one of these files. */
export function issuesFor(issues: Verdict['issues'], files: string[]): Verdict['issues'] {
  return issues.filter((it) => it.file && files.some((f) => samePath(f, it.file)));
}

/** One Hydrogen worker's instructions: its own files, with the whole task for context. */
export function workerPrompt(
  wo: WorkOrder,
  mine: Assignment,
  all: Assignment[],
  attempt: number,
  previous?: Verdict,
): string {
  const others = all.filter((a) => a !== mine).flatMap((a) => a.files);
  const own = `You are one of ${all.length} workers writing this task at the same time. You own ONLY these files:
${mine.files.map((f) => `- ${f}`).join('\n')}
${others.length ? `Other workers are writing these files right now; do not create, edit or delete them:\n${others.map((f) => `- ${f}`).join('\n')}\n` : ''}Use the names, signatures and types below exactly, so your files fit theirs.

YOUR INSTRUCTIONS
${mine.instructions || 'Write your files as the steps below describe.'}`;
  const retry =
    attempt > 1 && previous
      ? `

This is attempt ${attempt}. The previous attempt is still in the working folder and was rejected by
the lead. Fix your files in place; do not start over unless told to.

LEAD'S REVISED INSTRUCTIONS
(These take priority wherever they differ from the rest. Act only on what concerns your files.)
${previous.next_instruction}

ISSUES IN YOUR FILES
${issueList(issuesFor(previous.issues, mine.files))}`
      : '';
  return `${EXECUTOR_RULES}

${own}${retry}

THE WHOLE TASK (for context; do only your part)
${workOrderText(wo)}`;
}

/**
 * A retry sent into the worker's own earlier conversation: it already has the rules, its
 * instructions and the task, so it only needs the review.
 */
export function workerContinuePrompt(mine: Assignment, attempt: number, previous: Verdict): string {
  return `The lead reviewed the result and rejected it. This is attempt ${attempt}. Your files are in the
working folder as you left them (other workers may have changed theirs). Fix your files in place;
do not start over unless told to. You still own ONLY these files:
${mine.files.map((f) => `- ${f}`).join('\n')}

LEAD'S REVISED INSTRUCTIONS
(These take priority wherever they differ from before. Act only on what concerns your files.)
${previous.next_instruction}

ISSUES IN YOUR FILES
${issueList(issuesFor(previous.issues, mine.files))}

You already read your files earlier in this conversation: do not read them again or review the
project. Go straight to the fixes; open a file again only if an edit fails because it changed.
When you are done, reply with a short report: what you changed and anything you could not do.`;
}

const EXECUTOR_RULES = `You are the executor on this repository. Carry out the instructions below by editing
files in the current folder. Do not commit, do not change branches, and stay inside the listed
files. When you are done, reply with a short report: what you changed and anything you could
not do.

Work in small pieces. Your session has a time limit, and anything you are still writing when it
runs out is lost. Write one file at a time and keep each file under about 300 lines; split a
large module into several smaller files. Never try to produce a whole feature in one write.
Your only job is to write the code. The lead has already done the research, the design and
the planning, and will review your work. So:
- Do not write a plan, task list or design document, and do not enter plan mode
  (never call enter_plan_mode). Start editing files as soon as you have read what you need.
- Do not research alternatives or change the design, stack or file layout. Follow the
  instructions as written. If something in them is unclear or seems wrong, take the most
  literal reading, carry on, and say so in your report; the lead will decide.
- Read only the files you are about to change and the files the instructions name, each once.
  Do not explore, audit or review the rest of the project, and do not re-read your own edits to
  double-check them: the lead reviews the result. Spend your time writing.`;

/** The Hydrogen model an open-ended run uses when no worker model is chosen. */
export const OPEN_MODEL = 'gemini-4-hydrogen-high';

const OPEN_RULES = `You are the developer on this repository. A lead has planned the work and gives you one task
at a time. Carry out each task by editing files in the current folder. Do not commit and do not
change branches.

Nobody reviews your work before the user sees it, so finish every task completely and make it
work. Follow the instructions as written; where they are unclear, make the sensible choice and
say so in your report. Work in small pieces: write one file at a time and
keep each file under about 300 lines. Read only what you need, once; do not audit the project.
When the task is done, reply with a short report: what you changed and anything left undone.`;

/** The rule every open-ended task prompt carries: sub-agents only after the lead approves them. */
const SUBAGENT_RULE = `SUB-AGENTS NEED THE LEAD'S APPROVAL. If you will do this task yourself, just do it. If you want
to use sub-agents (invoke_subagent or swarm), do not start any and do not edit any files yet:
reply with only this JSON and stop. The lead will answer with what it approves.
{"subagents": [{"role": "short name", "files": ["paths this sub-agent owns"], "job": "what it does"}], "why": "one sentence"}`;

/** One task of an open-ended run. `continuing`: sent into the session that did the earlier tasks. */
export function openTaskPrompt(wo: WorkOrder, index: number, total: number, continuing: boolean): string {
  const head = continuing
    ? `Next: task ${index + 1} of ${total}. You already know the project and your earlier work from this
conversation; do not re-read files you have read unless you are about to change them.`
    : `${OPEN_RULES}

Task ${index + 1} of ${total}.`;
  return `${head}

${SUBAGENT_RULE}

${workOrderText(wo)}`;
}

export interface SubagentPart {
  role: string;
  files: string[];
  job: string;
}

/** Hydrogen's request to use sub-agents, or undefined when its reply is not one. */
export function subagentRequest(value: unknown): { subagents: SubagentPart[]; why: string } | undefined {
  const v = value as { subagents?: unknown; why?: unknown } | null;
  if (!v || !Array.isArray(v.subagents) || v.subagents.length === 0) return undefined;
  const parts = v.subagents.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      role: String(o.role ?? 'sub-agent'),
      files: Array.isArray(o.files) ? o.files.map(String) : [],
      job: String(o.job ?? ''),
    };
  });
  return { subagents: parts, why: String(v.why ?? '') };
}

const partList = (parts: SubagentPart[]): string =>
  parts.map((p, i) => `${i + 1}. ${p.role}: ${p.job}${p.files.length ? ` (files: ${p.files.join(', ')})` : ''}`).join('\n');

/** Asks the lead to approve Hydrogen's sub-agent split. */
export function subagentApprovalPrompt(index: number, title: string, req: { subagents: SubagentPart[]; why: string }): string {
  return `Hydrogen, the executor of this open-ended run, wants to split task ${index + 1} ("${title}") among
sub-agents before it starts. Nothing has been changed yet.

${partList(req.subagents)}
Its reason: ${req.why || '(none given)'}

Approve only if the parts are truly independent (no file in two parts, no part needs another's
output to start) and splitting saves real time. Otherwise reject it and Hydrogen does the task
alone. You may change the split. Decide from what you already know; do not open files.

${JSON_ONLY}
{"approved": true, "subagents": [{"role": "", "files": [], "job": ""}], "note": "anything Hydrogen should know"}`;
}

export interface SubagentDecision {
  approved: boolean;
  subagents: SubagentPart[];
  note: string;
}

export function parseSubagentDecision(value: unknown): SubagentDecision {
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.approved !== 'boolean') throw new Error('"approved" must be true or false');
  const parts = v.approved ? subagentRequest(v)?.subagents ?? [] : [];
  return { approved: v.approved && parts.length > 0, subagents: parts, note: String(v.note ?? '') };
}

/** The lead's answer, sent back into Hydrogen's conversation. */
export function subagentGoPrompt(d: SubagentDecision): string {
  const note = d.note.trim() ? `
The lead adds: ${d.note.trim()}` : '';
  return d.approved
    ? `The lead approved these sub-agents. Start exactly these and no others, each with only its own files
and job, and give each the parts of the task it needs. When they finish, make sure their work fits
together and finish the task yourself.
${partList(d.subagents)}${note}

When the task is done, reply with a short report: what was changed and anything left undone.`
    : `The lead did not approve sub-agents. Do the task yourself now, without any sub-agents.${note}

When the task is done, reply with a short report: what you changed and anything left undone.`;
}

export function executorPrompt(wo: WorkOrder, attempt: number, previous?: Verdict): string {
  const header = EXECUTOR_RULES;
  if (attempt === 1 || !previous) {
    return `${header}\n\n${workOrderText(wo)}`;
  }
  const issues = issueList(previous.issues);
  return `${header}

This is attempt ${attempt}. Your previous attempt is still in the working folder and was
rejected by the lead, who has rewritten the instructions for you. Fix the work in place; do not
start over unless the instructions say so.

LEAD'S REVISED INSTRUCTIONS
(These take priority wherever they differ from the original work order.)
${previous.next_instruction}

ISSUES FOUND IN YOUR LAST ATTEMPT
${issues}

ORIGINAL WORK ORDER
${workOrderText(wo)}`;
}

function checksText(checks: CheckResult[]): string {
  if (checks.length === 0) return 'No verification commands were run.';
  return checks
    .map((c) => `$ ${c.command}\n${c.ok ? 'PASSED' : `FAILED (exit ${c.exitCode})`}\n${clip(c.output, 4000)}`)
    .join('\n\n');
}

export interface ReviewInput {
  label: string;
  report: string;
  diff: string;
  /** True when the diff covers only what changed since the previous review. */
  sinceLastReview: boolean;
  checks: CheckResult[];
}

function verdictShape(canAsk: boolean): string {
  const questions = canAsk
    ? `"questions": on a fail, anything only the user can decide before the retry is written: the
  requirement turned out to be ambiguous, or the result exposed a choice that is the user's to
  make. If you ask, leave "next_instruction" empty; the answers come back to you and you write
  it then. Do not ask about things you can judge yourself. Empty when there is nothing to ask.`
    : `"questions": always empty in this run; nobody is available to answer.`;
  return `How to fill the reply:
- "verdict": "pass" only if every acceptance criterion is met and nothing off-limits was
  touched. A failed verification command is always a fail.
- "issues": each specific defect, with the file and the fix you require.
- ${questions}
- "next_instruction": on a fail, you are re-prompting the executor. Write the complete revised
  brief for its next attempt: what to keep, what to change, and exactly how, in enough detail
  to act on without seeing this review. Do not just repeat the issues. Empty on a pass.

${JSON_ONLY}
{"verdict": "pass" or "fail", "summary": "one or two sentences", "issues": [{"file": "", "problem": "", "required_fix": ""}], "questions": [], "next_instruction": ""}`;
}

function evidence(input: ReviewInput): string {
  return `EXECUTOR'S REPORT
${clip(input.report || '(empty)', 6000)}

VERIFICATION
${checksText(input.checks)}

${input.sinceLastReview ? 'DIFF SINCE YOUR LAST REVIEW (the rest of this task you have already seen)' : 'DIFF AGAINST THE START OF THIS TASK'}
${input.diff.trim() ? clip(input.diff, 60000) : '(no changes were made)'}`;
}

export function reviewPrompt(wo: WorkOrder, input: ReviewInput, canAsk: boolean, setup = ''): string {
  return `${setup ? `${setup}

` : ''}You are reviewing work you did not write. An executor model was given the work order below
and has finished ${input.label}. Judge the result strictly against the acceptance criteria.
You have no file tools: judge from the diff, the checks and what you remember of the code from
earlier reviews in this conversation.

${workOrderText(wo)}

${evidence(input)}

${verdictShape(canAsk)}`;
}

export function reReviewPrompt(input: ReviewInput, canAsk: boolean, setup = ''): string {
  return `${setup ? `${setup}

` : ''}The executor has finished ${input.label}, working from your revised instructions. Review
it against the same acceptance criteria, as adjusted by anything the user has told you since,
and check that the issues you raised are actually fixed.

${evidence(input)}

${verdictShape(canAsk)}`;
}

export function reviewAnswersPrompt(questions: string[], answers: string[]): string {
  return `The user answered your questions:

${qaText(questions, answers)}

Now give your final verdict for this attempt. It is still a fail; write the complete
"next_instruction" for the executor so that it reflects what the user wants, and leave
"questions" empty.

${JSON_ONLY}
{"verdict": "fail", "summary": "", "issues": [{"file": "", "problem": "", "required_fix": ""}], "questions": [], "next_instruction": ""}`;
}

export function escalationPrompt(wo: WorkOrder, history: Verdict[]): string {
  const past = history
    .map((v, i) => `Attempt ${i + 1}: ${v.summary}\n${v.issues.map((it) => `- ${it.file ? `${it.file}: ` : ''}${it.problem}`).join('\n')}${v.next_instruction ? `\nInstruction given for the next attempt: ${clip(v.next_instruction, 1500)}` : ''}`)
    .join('\n\n');
  return `The executor model failed this task ${history.length} times, so you are taking over and doing
it yourself. Its last attempt is in the working folder: keep what is right, fix or replace what
is wrong. Edit the files directly. Do not commit.

${workOrderText(wo)}

WHAT WENT WRONG IN EACH ATTEMPT
(The instructions below include what the user asked for along the way; honour them.)
${past}

When you are done, reply with a short report of what you changed.`;
}
