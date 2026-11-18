import { extractJson, parsePlan, parsePlanReply, parseVerdict, parseWorkOrder } from './json.ts';
import {
  escalationPrompt,
  executorPrompt,
  followUpPrompt,
  planAnswersPrompt,
  planPrompt,
  planReviewText,
  planRevisionPrompt,
  reReviewPrompt,
  reviewAnswersPrompt,
  reviewPrompt,
  workOrderPrompt,
  ATTACHED,
  executorSetupText,
  issuesFor,
  workerContinuePrompt,
  workerPrompt,
  openTaskPrompt,
  OPEN_MODEL,
  parseSubagentDecision,
  subagentApprovalPrompt,
  subagentGoPrompt,
  subagentRequest,
} from './prompts.ts';
import type {
  AgentResult,
  AskUser,
  Config,
  Executor,
  Lead,
  LeadRequest,
  Log,
  Plan,
  Role,
  RunState,
  Verdict,
  VerifyFn,
  WorkerRun,
  WorkOrder,
  Workspace,
} from './types.ts';

export interface Deps {
  runId: string;
  request: string;
  cfg: Config;
  lead: Lead;
  executor: Executor;
  workspace: Workspace;
  verify: VerifyFn;
  log: Log;
  /** Present when a person is there to answer the lead's questions. */
  askUser?: AskUser;
  /** The saved state of an interrupted run, to continue it instead of starting over. */
  resume?: RunState;
  /** Aborting this stops the run at once; it ends as paused. */
  signal?: AbortSignal;
  /** Returns messages the user has sent since the last call, and forgets them. */
  inbox?: () => string[];
  /** Re-reads the run's saved options, so a change made in any orc window applies at the next step. */
  refresh?: () => void;
  /** Files the user attached to the request (full paths). */
  attachments?: string[];
  /** Folder holding the user's attachments; the lead and the executor may read it. */
  attachDir?: string;
}

/** An executor run that changed no files is not counted; after this many in a row the run pauses. */
export const MAX_EMPTY_RUNS = 3;

/** How many times the user may send the plan back for changes before work starts anyway. */
const MAX_PLAN_REVISIONS = 5;

/** An empty reply, or a plain yes, approves the plan. */
export function approves(reply: string): boolean {
  return /^\s*(|ok(ay)?|yes|y|yep|sure|go( ahead)?|start( it)?|approve[d]?|looks good|lgtm|fine|good)[.!\s]*$/i.test(reply);
}

/** How many times the lead may come back with questions before it has to plan. */
const MAX_PLAN_QUESTION_ROUNDS = 2;
/** Budget for the full text of changed files attached to a review. */

/**
 * Makes a run that stopped on a failed task continuable again: the task keeps its instructions,
 * history, review conversation and committed work, and gets a fresh set of executor attempts.
 */
/**
 * The formatter runs that would make a run's format checks pass, derived from those checks:
 * `cargo fmt ... --check` becomes `cargo fmt --all`, `prettier --check` becomes `prettier --write`.
 */
export function formatFixes(commands: string[]): string[] {
  const fixes = commands.flatMap((c) => {
    if (/\bcargo\s+fmt\b/.test(c) && /--check\b/.test(c)) return ['cargo fmt --all'];
    if (/\bprettier\b/.test(c) && /--check\b/.test(c)) return [c.replace(/--check\b/, '--write')];
    return [];
  });
  return [...new Set(fixes)];
}

/** With takeovers off, how many rounds of attempts a task gets before the user decides. */
const MAX_ROUNDS = 4;

export function reopenFailed(state: RunState): void {
  for (const t of state.tasks) {
    if (t.status !== 'failed') continue;
    t.status = 'pending';
    t.escalated = false;
    t.retries = (t.retries ?? 0) + 1;
    t.retryFrom = t.history?.length ?? 0;
    delete t.escalationJudged;
    delete t.escalationSession;
    delete t.pending;
  }
  state.status = 'paused';
  delete state.finishedAt;
  delete state.error;
}

/** One conversation with the lead model, resumed on every call so context carries over. */
class Session {
  lead: Lead;
  role: LeadRequest['role'];
  cwd: string;
  tools: LeadRequest['tools'];
  track: (role: Role, res: AgentResult) => void;
  activity: (text: string) => void;
  /** Called whenever the conversation id is known, so it can be saved for a later resume. */
  onId: (id: string) => void;
  id: string | undefined;
  signal: AbortSignal | undefined;
  /** All the user's messages so far; each conversation is shown the ones it has not seen. */
  notes: () => string[] = () => [];
  before: () => void = () => {};
  seen = 0;
  addDirs: string[] = [];
  /** The next call branches off id into a new conversation instead of continuing it. */
  fork = false;

  constructor(
    lead: Lead,
    role: LeadRequest['role'],
    cwd: string,
    tools: LeadRequest['tools'],
    track: (role: Role, res: AgentResult) => void,
    activity: (text: string) => void,
    id?: string,
    onId: (id: string) => void = () => {},
  ) {
    this.lead = lead;
    this.role = role;
    this.cwd = cwd;
    this.tools = tools;
    this.track = track;
    this.activity = activity;
    this.id = id;
    this.onId = onId;
  }

  async ask(prompt: string): Promise<AgentResult> {
    this.before();
    const all = this.notes();
    const fresh = all.slice(this.seen);
    this.seen = all.length;
    if (fresh.length) {
      prompt =
        `MESSAGE FROM THE USER, sent while the run was going. Take it into account from now on, ` +
        `including in any instructions you write for the executor:\n${fresh.map((n) => `- ${n}`).join('\n')}\n\n${prompt}`;
    }
    const res = await this.lead.ask({
      role: this.role,
      prompt,
      cwd: this.cwd,
      sessionId: this.id,
      fork: this.fork,
      // Save the conversation the moment it starts: a step cut off by a time limit or a restart
      // is then continued, with everything it already read, instead of started over.
      onSession: (id) => {
        if (id === this.id) return;
        this.id = id;
        this.fork = false;
        this.onId(id);
      },
      // A message with files needs at least read access, even in a review that has no tools.
      tools: fresh.some((n) => n.includes(ATTACHED)) && this.tools === 'none' ? 'read' : this.tools,
      addDirs: this.addDirs,
      onActivity: this.activity,
      signal: this.signal,
    });
    if (res.sessionId && res.sessionId !== this.id) {
      this.id = res.sessionId;
      this.onId(res.sessionId);
    }
    this.fork = false;
    this.track(this.role, res);
    return res;
  }

  /** Asks for a JSON reply and re-asks once, in the same conversation, if it cannot be used. */
  async askJson<T>(prompt: string, parse: (value: unknown) => T): Promise<T> {
    const first = await this.ask(prompt);
    try {
      return parse(extractJson(first.text));
    } catch (err) {
      const retry = await this.ask(
        `Your last reply could not be used: ${(err as Error).message}. ` +
          'Reply again with only the JSON object in the requested shape.',
      );
      return parse(extractJson(retry.text));
    }
  }
}

function fallbackInstruction(verdict: Verdict): string {
  const issues = verdict.issues.map((it) => `- ${it.file ? `${it.file}: ` : ''}${it.problem}${it.required_fix ? ` Fix: ${it.required_fix}` : ''}`);
  return `Fix the following and leave everything else as it is:\n${issues.join('\n') || `- ${verdict.summary}`}`;
}

/** True when an error looks like a usage or rate limit rather than a real fault. */
export function looksLikeLimit(message: string): boolean {
  return /rate.?limit|usage limit|limit reached|quota|exhausted|too many requests|\b429\b|overloaded/i.test(message);
}

/**
 * The closed loop. The code decides who goes next and counts the attempts;
 * the models only ever produce questions, a plan, a work order, changes, or a verdict.
 *
 *   plan (the lead may ask the user first)
 *   for each task:
 *     work order -> [execute -> verify -> review] x maxAttempts
 *       on a fail the lead rewrites the executor's instructions, asking the user if needed
 *     -> escalate (the lead does it) -> verify -> review -> stop for a human if still failing
 *
 * Every finished step is written to the run's state, and every finished piece of work is
 * committed in the worktree. If anything stops the run (a usage limit, an error, Ctrl+C),
 * it ends as "paused" and a later call with `resume` carries on from the last finished step.
 */
/**
 * The Hydrogen workers for one attempt: every assignment the first time, then only those that own
 * a file the lead named in its issues (all of them when it named none).
 */
export function workerRuns(
  wo: WorkOrder,
  attempt: number,
  previous: Verdict | undefined,
  note = '',
  sessions: Record<string, string> = {},
): WorkerRun[] {
  const all = wo.assignments?.length ? wo.assignments : [{ files: wo.files_in_scope, instructions: '' }];
  let chosen = all;
  if (attempt > 1 && previous) {
    const flagged = all.filter((a) => issuesFor(previous.issues, a.files).length > 0);
    if (flagged.length) chosen = flagged;
  }
  return chosen.map((a) => {
    const n = all.indexOf(a) + 1;
    const first = a.files[0] ?? 'its files';
    const key = a.files.join('|');
    const fresh = workerPrompt(wo, a, all, attempt, previous) + note;
    // A worker that has been on this assignment before continues its own conversation, so it
    // keeps what it already read instead of reading the code again.
    const sessionId = attempt > 1 && previous ? sessions[key] : undefined;
    return {
      label: `worker ${n} (${first}${a.files.length > 1 ? ` +${a.files.length - 1}` : ''})`,
      prompt: sessionId ? workerContinuePrompt(a, attempt, previous!) + note : fresh,
      key,
      sessionId,
      freshPrompt: fresh,
    };
  });
}

export async function runOrchestration(d: Deps): Promise<RunState> {
  const { cfg, log, workspace: ws } = d;
  // Read at each use: the user can change these settings while the run is going.
  const setup = (): string =>
    executorSetupText({
      minutes: Math.round(cfg.executorTimeoutMs / 60000),
      workers: cfg.executorWorkers ?? '',
      canRunCommands: cfg.executorSkipPermissions,
      open: cfg.mode === 'open',
    });
  const canAsk = d.askUser !== undefined;
  const state: RunState = d.resume ?? {
    id: d.runId,
    request: d.request,
    status: 'running',
    branch: ws.branch,
    worktree: ws.dir,
    tasks: [],
    usage: {},
    startedAt: new Date().toISOString(),
    attachments: d.attachments ?? [],
  };
  state.status = 'running';
  state.pid = process.pid;
  delete state.error;
  delete state.finishedAt;
  const save = (): void => log.saveState(state);
  save(); // so the run is visible to "orc status" and the GUI from its first moment

  const track = (role: Role, res: AgentResult): void => {
    const u = (state.usage[role] ??= { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
    u.calls += 1;
    u.inputTokens += res.inputTokens;
    u.cachedTokens += res.cachedTokens;
    u.outputTokens += res.outputTokens;
    if (res.model) u.model = res.model;
    if (res.planLimits) state.planLimits = res.planLimits;
    save();
  };

  const leadDirs = d.attachDir ? [d.attachDir] : [];

  /** Collects anything the user has sent and returns every message so far. */
  const notes = (): string[] => {
    const fresh = d.inbox?.() ?? [];
    if (fresh.length) {
      (state.userNotes ??= []).push(...fresh);
      save();
      log.emit({ type: 'note_delivered', count: fresh.length });
    }
    return state.userNotes ?? [];
  };

  /** Live progress: what a model is doing right now. */
  const activity = (who: 'lead' | 'executor') => (text: string): void => {
    log.emit({ type: 'activity', who, text });
  };
  /** Announces a step that will take a while, so the terminal is never silently waiting. */
  const working = (who: 'lead' | 'executor', what: string): void => {
    log.emit({ type: 'working', who, what });
  };

  async function consultUser(stage: string, questions: string[]): Promise<string[]> {
    log.emit({ type: 'questions', stage, questions });
    const answers = await d.askUser!(stage, questions);
    log.emit({ type: 'answers', stage, questions, answers });
    return answers;
  }

  async function makePlan(architect: Session): Promise<Plan> {
    working('lead', 'reading the project and working out a plan');
    return askPlan(architect, planPrompt(state.request, canAsk, state.attachments ?? []));
  }

  /** Asks for a plan, letting the lead put questions to the user first. */
  async function askPlan(architect: Session, first: string): Promise<Plan> {
    let reply = await architect.askJson(first, parsePlanReply);
    for (let round = 1; 'questions' in reply; round++) {
      if (!canAsk || round > MAX_PLAN_QUESTION_ROUNDS) {
        // It was told to plan and asked again anyway: insist once, strictly.
        return architect.askJson(planAnswersPrompt([], [], false), parsePlan);
      }
      const answers = await consultUser('planning', reply.questions);
      working('lead', 'planning from your answers');
      reply = await architect.askJson(
        planAnswersPrompt(reply.questions, answers, round < MAX_PLAN_QUESTION_ROUNDS),
        parsePlanReply,
      );
    }
    return reply;
  }

  function setPlan(plan: Plan): void {
    state.plan = plan;
    state.tasks = plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: 'pending',
      attempts: 0,
      escalated: false,
    }));
    save();
    log.saveArtifact('plan.json', JSON.stringify(plan, null, 2));
    log.emit({ type: 'plan_ready', tasks: plan.tasks.map((t) => t.title), assumptions: plan.assumptions });
  }

  /**
   * A request made after the plan was finished: the lead plans the new work in the same
   * conversation, so it remembers the project, and the new tasks are added to this run.
   */
  async function planFollowUp(architect: Session, request: string): Promise<void> {
    const from = state.tasks.length;
    working('lead', 'planning your new request');
    const asked = state.attachments?.length ? state.attachments.slice(state.followUpAttachmentsFrom ?? state.attachments.length) : [];
    let added = await askPlan(architect, followUpPrompt(request, finishedText(from), canAsk, asked));
    const ids = new Set(state.plan!.tasks.map((t) => t.id));
    const append = (p: Plan): void => {
      const tasks = p.tasks.map((t, i) => ({ ...t, id: ids.has(t.id) ? `F${from + i + 1}` : t.id }));
      state.plan!.tasks = [...state.plan!.tasks.slice(0, from), ...tasks];
      state.plan!.assumptions = [...state.plan!.assumptions, ...p.assumptions];
      state.tasks = [
        ...state.tasks.slice(0, from),
        ...tasks.map((t) => ({ id: t.id, title: t.title, status: 'pending' as const, attempts: 0, escalated: false })),
      ];
      save();
      log.saveArtifact('plan.json', JSON.stringify(state.plan, null, 2));
      log.emit({ type: 'plan_ready', tasks: state.plan!.tasks.map((t) => t.title), assumptions: p.assumptions, from });
    };
    append(added);
    if (canAsk && cfg.confirmPlan !== false) {
      for (let round = 1; ; round++) {
        const [reply = ''] = await consultUser('plan approval', [planReviewText(added.tasks, added.assumptions)]);
        if (approves(reply) || round > MAX_PLAN_REVISIONS) break;
        working('lead', 'revising the plan from your reply');
        added = await askPlan(architect, planRevisionPrompt(reply));
        append(added);
      }
      log.emit({ type: 'plan_approved' });
    }
    (state.followUps ??= []).push(request);
    delete state.followUp;
    delete state.followUpAttachmentsFrom;
    save();
  }

  /** Shows the plan to the user and revises it until they approve. Nothing is built before that. */
  async function approvePlan(architect: Session): Promise<void> {
    const untouched = state.tasks.every((t) => t.status === 'pending' && !t.workOrder);
    if (state.planApproved || !canAsk || cfg.confirmPlan === false || !untouched) {
      if (!state.planApproved) {
        state.planApproved = true;
        save();
      }
      return;
    }
    for (let round = 1; ; round++) {
      const plan = state.plan!;
      const [reply = ''] = await consultUser('plan approval', [planReviewText(plan.tasks, plan.assumptions)]);
      if (approves(reply) || round > MAX_PLAN_REVISIONS) break;
      working('lead', 'revising the plan from your reply');
      let revised = await architect.askJson(planRevisionPrompt(reply), parsePlanReply);
      if ('questions' in revised) {
        const answers = await consultUser('planning', revised.questions);
        working('lead', 'revising the plan from your answers');
        revised = await architect.askJson(planAnswersPrompt(revised.questions, answers, false), parsePlan);
      }
      setPlan(revised);
    }
    state.planApproved = true;
    save();
    log.emit({ type: 'plan_approved' });
  }

  /** What the finished tasks built, so the lead writes instructions from memory instead of re-reading. */
  function finishedText(upTo: number): string {
    const done = state.tasks.slice(0, upTo).filter((t) => t.status === 'passed');
    if (!done.length) return '';
    return done
      .map((t) => {
        const last = t.history?.[t.history.length - 1];
        const files = t.files?.length ? `\n  Files: ${t.files.join(', ')}` : '';
        return `- ${t.title}${last?.summary ? `: ${last.summary}` : ''}${files}`;
      })
      .join('\n');
  }

  async function runTask(architect: Session, plan: Plan, index: number): Promise<boolean> {
    const task = plan.tasks[index];
    const ts = state.tasks[index];
    if (ts.status === 'passed') return true;
    if (ts.status === 'failed') return false;

    const tag = `task${index + 1}`;
    ts.status = 'running';
    log.emit({ type: 'task_started', index, total: plan.tasks.length, title: task.title });

    if (!ts.workOrder) {
      working('lead', 'writing the instructions for the executor');
      const order = await architect.askJson(workOrderPrompt(task, index, plan.tasks.length, Math.round(cfg.executorTimeoutMs / 60000), setup(), Boolean(cfg.executorWorkers) && cfg.mode !== 'open', finishedText(index)), parseWorkOrder);
      ts.workOrder = order;
      ts.base = await ws.head();
      ts.history = [];
      save();
      log.saveArtifact(`${tag}-work-order.json`, JSON.stringify(order, null, 2));
      log.emit({
        type: 'work_order',
        index,
        goal: order.goal,
        steps: order.steps,
        criteria: order.acceptance_criteria,
        file: `${tag}-work-order.json`,
      });
    }
    const wo = ts.workOrder;
    const base = ts.base!;
    const history = (ts.history ??= []);

    const commands = [
      ...new Set([...cfg.verifyCommands, ...(cfg.allowArchitectCommands ? wo.verify_commands : [])]),
    ];
    if (cfg.mode === 'open') return runOpenTask(architect, index, wo, commands);

    // A fresh conversation per task, so the reviewer judges the result rather than
    // defending the instruction, and remembers its own earlier findings across attempts.
    // It has no tools: the app hands it the diff, the changed files and the check results,
    // so each review is a single request.
    // One review conversation for the whole run, so the reviewer remembers the code it has
    // already seen and only needs each change. A run reviewed per task carries on from the
    // latest task's conversation.
    state.reviewerSession ??= [...state.tasks].reverse().find((t) => t.reviewerSession)?.reviewerSession;
    const reviewer = new Session(d.lead, 'reviewer', ws.dir, 'none', track, activity('lead'), ts.reviewerSession ?? state.reviewerSession, (id) => {
      ts.reviewerSession = id;
      state.reviewerSession = id;
      save();
    });
    reviewer.signal = d.signal;
    reviewer.notes = notes;
    reviewer.before = () => d.refresh?.();
    reviewer.addDirs = leadDirs;

    /**
     * Checkpoint, verify, review. Used for executor attempts and for the escalation alike.
     * `mayAsk` is true when the lead may put questions to the user before it rewrites
     * the executor's instructions.
     */
    async function judge(label: string, fileTag: string, report: string, mayAsk: boolean): Promise<Verdict> {
      // Formatting is mechanical: orc fixes it itself instead of failing the work over it.
      const fixes = formatFixes(commands);
      if (fixes.length) {
        working('executor', `formatting the code: ${fixes.join('; ')}`);
        await d.verify(fixes, ws.dir);
      }
      ts.commit = await ws.checkpoint(`orc: ${task.title} (${label})`);
      // From here the work is safe in a commit; if the run stops before the verdict,
      // a resume reviews this same work instead of redoing it.
      ts.pending = { label, fileTag, report };
      save();

      // The reviewer remembers what it reviewed before, so it gets only what changed since.
      const since = history.length && ts.reviewed ? ts.reviewed : base;
      const diff = await ws.diff(since);
      const files = await ws.changedFiles(base);
      ts.files = files;
      log.saveArtifact(`${tag}-${fileTag}.diff`, diff);
      log.emit({ type: 'changes', index, label, files, report: report.trim().slice(0, 700) });

      if (commands.length > 0) working('executor', `running your checks: ${commands.join('; ')}`);
      const checks = await d.verify(commands, ws.dir);
      const failed = checks.filter((c) => !c.ok);
      log.emit({
        type: 'verify_done',
        index,
        label,
        ran: checks.length,
        failed: failed.map((c) => c.command),
      });

      const input = { label, report, diff, sinceLastReview: since !== base, checks };
      working('lead', 'reviewing the result against the acceptance criteria');
      let verdict = await reviewer.askJson(
        history.length === 0 ? reviewPrompt(wo, input, mayAsk, setup()) : reReviewPrompt(input, mayAsk, setup()),
        parseVerdict,
      );

      // The lead wants the user's say before it rewrites the instructions.
      if (verdict.verdict === 'fail' && verdict.questions.length > 0 && mayAsk) {
        const questions = verdict.questions;
        const answers = await consultUser(`${task.title}, ${label}`, questions);
        working('lead', 'rewriting the instructions from your answers');
        const revised = await reviewer.askJson(reviewAnswersPrompt(questions, answers), parseVerdict);
        verdict = { ...revised, verdict: 'fail', questions: [] };
      }
      verdict.questions = [];
      if (verdict.verdict === 'fail' && verdict.next_instruction.trim() === '') {
        verdict.next_instruction = fallbackInstruction(verdict);
      }

      // A failed check can never pass, whatever the reviewer says.
      if (verdict.verdict === 'pass' && failed.length > 0) {
        verdict.verdict = 'fail';
        verdict.summary = `Overruled: ${failed.length} verification command(s) failed. ${verdict.summary}`;
        for (const c of failed) {
          verdict.issues.push({ file: '', problem: `Command failed: ${c.command}`, required_fix: 'Make it pass.' });
        }
        verdict.next_instruction =
          `These verification commands still fail; fix the code until they pass:\n` +
          failed.map((c) => `$ ${c.command}\n${c.output}`).join('\n\n');
      }

      history.push(verdict);
      ts.reviewed = ts.commit;
      delete ts.pending;
      if (label === 'escalation') ts.escalationJudged = true;
      save();
      log.saveArtifact(`${tag}-${fileTag}-verdict.json`, JSON.stringify(verdict, null, 2));
      log.emit({
        type: 'review_done',
        index,
        label,
        verdict: verdict.verdict,
        issues: verdict.issues,
        summary: verdict.summary,
        nextInstruction: verdict.verdict === 'fail' ? verdict.next_instruction : '',
        file: `${tag}-${fileTag}-verdict.json`,
      });
      return verdict;
    }

    const pass = (): boolean => {
      ts.status = 'passed';
      log.emit({ type: 'task_passed', index, commit: ts.commit, escalated: ts.escalated });
      save();
      return true;
    };
    const giveUp = (summary: string): boolean => {
      ts.status = 'failed';
      log.emit({ type: 'task_failed', index, summary });
      save();
      return false;
    };

    // Work that was committed but not yet reviewed when an earlier run stopped.
    if (ts.pending) {
      const p = ts.pending;
      const wasEscalation = p.label === 'escalation';
      const verdict = await judge(p.label, p.fileTag, p.report, canAsk && !wasEscalation);
      if (verdict.verdict === 'pass') return pass();
      if (wasEscalation) return giveUp(verdict.summary);
    }

    // The history holds one verdict per judged attempt, so its length is the attempt count.
    let emptyRuns = 0;
    let lastBlocked: string[] = [];
    let lastEnded: string | undefined;
    // After the user retries a failed task, the executor gets a fresh set of attempts; the
    // numbering carries on so earlier attempts' files are kept.
    const firstAttempt = ts.retryFrom ?? 0;
    while (!ts.escalated && history.length - firstAttempt < cfg.maxAttempts) {
      const attempt = history.length + 1;
      ts.attempts = attempt;
      save();
      log.emit({ type: 'attempt_started', index, attempt, max: firstAttempt + cfg.maxAttempts, retry: emptyRuns });
      const previous = history[history.length - 1];
      const emptyNote =
        emptyRuns > 0
          ? `

NOTE: your previous run ended without changing any files` +
            (lastBlocked.length ? `, because you tried to run commands you are not allowed to run (${lastBlocked.join('; ')})` : '') +
            (lastEnded ? `, because ${lastEnded}` : '') +
            '. This time, do the work by creating and editing the files, one small file at a time.'
          : '';
      const prompt = executorPrompt(wo, attempt, previous) + emptyNote;
      d.refresh?.();
      const workers = cfg.executorWorkers ? workerRuns(wo, attempt, previous, emptyNote, ts.workerSessions) : undefined;
      if (workers) {
        log.emit({ type: 'workers_started', index, attempt, workers: workers.map((w) => w.label) });
      }
      const before = await ws.head();
      const result = await d.executor.run({
        prompt,
        workers,
        cwd: ws.dir,
        runDir: log.dir,
        attachDir: d.attachDir,
        onActivity: activity('executor'),
        signal: d.signal,
      });
      track('executor', result);
      if (result.sessions) {
        ts.workerSessions = { ...ts.workerSessions, ...result.sessions };
        save();
      }
      if (result.endedEarly) {
        log.emit({ type: 'executor_ended_early', index, attempt, reason: result.endedEarly });
      }

      // An executor run that changed nothing is not an attempt: no review, no count.
      const after = await ws.checkpoint(`orc: ${task.title} (attempt ${attempt})`);
      if (after === before) {
        emptyRuns += 1;
        lastBlocked = result.blocked ?? [];
        lastEnded = result.endedEarly;
        log.emit({
          type: 'attempt_empty',
          index,
          attempt,
          run: emptyRuns,
          max: MAX_EMPTY_RUNS,
          blocked: lastBlocked,
          report: result.text.trim().slice(0, 500),
        });
        if (emptyRuns >= MAX_EMPTY_RUNS) {
          throw new Error(
            lastBlocked.length && !cfg.executorSkipPermissions
              ? `Argon stopped without changing any files ${emptyRuns} times in a row because it was not allowed to run commands (${lastBlocked.join('; ')}). Turn on "Let Argon run commands" for this run, then continue. No attempt was used up.`
              : `${cfg.executorWorkers ? 'The Hydrogen workers' : 'Argon'} finished ${emptyRuns} times in a row without changing any files. No attempt was used up; continue to try again.`,
          );
        }
        continue;
      }
      emptyRuns = 0;
      const report = result.endedEarly
        ? `${result.text.trim()}\n\n[orc: this run did not finish: ${result.endedEarly}. Judge what was written; the next attempt continues from it.]`.trim()
        : result.text;
      const verdict = await judge(`attempt ${attempt}`, `attempt${attempt}`, report, canAsk);
      if (verdict.verdict === 'pass') return pass();
    }

    if (ts.escalationJudged) return giveUp(history[history.length - 1]?.summary ?? '');

    // Takeovers are off: the executor gets another round of attempts, with the reviewer's latest
    // instructions, instead of the lead doing the work. After MAX_ROUNDS the user decides.
    if (cfg.takeover === false) {
      const round = ts.rounds ?? 1;
      if (round >= MAX_ROUNDS) return giveUp(`${round} rounds of attempts did not pass: ${history[history.length - 1]?.summary ?? ''}`);
      ts.rounds = round + 1;
      ts.retryFrom = history.length;
      ts.status = 'pending';
      save();
      log.emit({ type: 'round_started', index, round: round + 1, max: MAX_ROUNDS });
      return runTask(architect, plan, index);
    }

    // The executor used all its attempts: the lead does the work itself, once.
    ts.escalated = true;
    save();
    log.emit({ type: 'escalation_started', index, after: cfg.maxAttempts });
    // The takeover branches off this task's review conversation, which has already seen the
    // work order, every attempt and its own verdicts, so it does not read it all again. Its own
    // conversation is saved, so a restart continues it rather than starting over.
    const resumed = Boolean(ts.escalationSession);
    const takeover = new Session(d.lead, 'escalation', ws.dir, 'write', track, activity('lead'), ts.escalationSession ?? ts.reviewerSession, (id) => {
      ts.escalationSession = id;
      save();
    });
    takeover.fork = !resumed && Boolean(ts.reviewerSession);
    takeover.signal = d.signal;
    takeover.notes = notes;
    takeover.before = () => d.refresh?.();
    takeover.addDirs = leadDirs;
    const report = await takeover.ask(
      resumed
        ? 'orc was restarted while you were taking over this task, and edits you had not finished were discarded. You have already read the files you need; re-check only the ones you were editing, finish the work, and reply with a short report of what you changed.'
        : `${takeover.fork ? 'You reviewed this task above. Now you have write access: ' : ''}${escalationPrompt(wo, history)}`,
    );
    // Nothing follows a failed escalation but handing over, so there is nothing to ask about.
    const verdict = await judge('escalation', ts.retries ? `escalation-retry${ts.retries}` : 'escalation', report.text, false);
    return verdict.verdict === 'pass' ? pass() : giveUp(verdict.summary);
  }

  /**
   * Open-ended mode: one Hydrogen session does the task, continuing the conversation that did the
   * earlier ones, and nothing is reviewed. The user's checks still run, and their result is
   * reported, but they do not send the work back: the user reviews the output.
   */
  async function runOpenTask(architect: Session, index: number, wo: WorkOrder, commands: string[]): Promise<boolean> {
    const task = state.plan!.tasks[index];
    const ts = state.tasks[index];
    const tag = `task${index + 1}`;
    const history = (ts.history ??= []);
    const total = state.plan!.tasks.length;
    let report = ts.pending?.report;
    if (report === undefined) {
      let emptyRuns = 0;
      for (;;) {
        ts.attempts = 1;
        save();
        log.emit({ type: 'attempt_started', index, attempt: 1, max: 1, retry: emptyRuns });
        const note = emptyRuns
          ? `

NOTE: your previous run ended without changing any files. This time, do the work by creating and editing the files.`
          : '';
        d.refresh?.();
        const fullPrompt = openTaskPrompt(wo, index, total, false) + note;
        const hydrogen = async (prompt: string, fresh: string): Promise<AgentResult> => {
          const r = await d.executor.run({
            prompt,
            freshPrompt: fresh,
            sessionId: state.executorSession,
            model: cfg.executorWorkers || OPEN_MODEL,
            cwd: ws.dir,
            runDir: log.dir,
            attachDir: d.attachDir,
            onActivity: activity('executor'),
            signal: d.signal,
          });
          track('executor', r);
          if (r.sessionId) state.executorSession = r.sessionId;
          save();
          if (r.endedEarly) log.emit({ type: 'executor_ended_early', index, attempt: 1, reason: r.endedEarly });
          return r;
        };
        const before = await ws.head();
        let result = await hydrogen(openTaskPrompt(wo, index, total, Boolean(state.executorSession)) + note, fullPrompt);
        let after = await ws.checkpoint(`orc: ${task.title}`);
        if (after === before) {
          // Hydrogen stopped before editing to ask for sub-agents: the lead approves or changes the
          // split, then Hydrogen carries on in the same conversation with exactly what was approved.
          let request: ReturnType<typeof subagentRequest>;
          try {
            request = subagentRequest(extractJson(result.text));
          } catch {
            request = undefined;
          }
          if (request) {
            log.emit({ type: 'subagents_requested', index, subagents: request.subagents, why: request.why });
            working('lead', `checking Hydrogen's request for ${request.subagents.length} sub-agent${request.subagents.length === 1 ? '' : 's'}`);
            const decision = await architect.askJson(subagentApprovalPrompt(index, task.title, request), parseSubagentDecision);
            log.emit({ type: 'subagents_decided', index, approved: decision.approved, subagents: decision.subagents, note: decision.note });
            const go = subagentGoPrompt(decision);
            result = await hydrogen(go, `${fullPrompt}

${go}`);
            after = await ws.checkpoint(`orc: ${task.title}`);
          }
        }
        if (after !== before) {
          report = result.endedEarly ? `${result.text.trim()}

[orc: this run did not finish: ${result.endedEarly}.]`.trim() : result.text;
          ts.pending = { label: 'attempt 1', fileTag: 'attempt1', report };
          save();
          break;
        }
        emptyRuns += 1;
        log.emit({ type: 'attempt_empty', index, attempt: 1, run: emptyRuns, max: MAX_EMPTY_RUNS, blocked: result.blocked ?? [], report: result.text.trim().slice(0, 500) });
        if (emptyRuns >= MAX_EMPTY_RUNS) {
          throw new Error(`Hydrogen finished ${emptyRuns} times in a row without changing any files. Continue to try again.`);
        }
      }
    }

    const fixes = formatFixes(commands);
    if (fixes.length) {
      working('executor', `formatting the code: ${fixes.join('; ')}`);
      await d.verify(fixes, ws.dir);
      await ws.checkpoint(`orc: ${task.title} (formatting)`);
    }
    ts.commit = await ws.head();
    const files = await ws.changedFiles(ts.base!);
    ts.files = files;
    log.saveArtifact(`${tag}-attempt1.diff`, await ws.diff(ts.base!));
    log.emit({ type: 'changes', index, label: 'attempt 1', files, report: (report ?? '').trim().slice(0, 700) });
    if (commands.length) working('executor', `running your checks: ${commands.join('; ')}`);
    const checks = await d.verify(commands, ws.dir);
    const failed = checks.filter((c) => !c.ok).map((c) => c.command);
    log.emit({ type: 'verify_done', index, label: 'attempt 1', ran: checks.length, failed });
    const verdict: Verdict = {
      verdict: 'pass',
      summary: `Not reviewed (open-ended run): check it yourself.${failed.length ? ` These checks failed: ${failed.join('; ')}.` : ''} ${(report ?? '').trim().split(/\r?\n/)[0].slice(0, 300)}`.trim(),
      issues: [],
      questions: [],
      next_instruction: '',
    };
    history.push(verdict);
    delete ts.pending;
    ts.status = 'passed';
    save();
    log.emit({ type: 'review_done', index, label: 'attempt 1', verdict: 'pass', issues: [], summary: verdict.summary, nextInstruction: '', unreviewed: true });
    log.emit({ type: 'task_passed', index, commit: ts.commit, escalated: false, unreviewed: true });
    return true;
  }

  try {
    if (d.resume) {
      // Anything not committed is the half-done work of the step that was interrupted.
      await ws.reset();
      // A run stopped before its plan was done plans afresh, in a new conversation, so the
      // lead asks its questions again instead of assuming they went unanswered.
      if (!state.plan) delete state.architectSession;
      const done = state.tasks.filter((t) => t.status === 'passed').length;
      log.emit({ type: 'resumed', id: state.id, done, total: state.tasks.length, planned: Boolean(state.plan) });
    } else {
      log.emit({ type: 'run_started', id: state.id, request: state.request, branch: ws.branch, worktree: ws.dir });
    }

    const architect = new Session(d.lead, 'architect', ws.dir, 'read', track, activity('lead'), state.architectSession, (id) => {
      state.architectSession = id;
      save();
    });
    architect.signal = d.signal;
    architect.notes = notes;
    architect.before = () => d.refresh?.();
    architect.addDirs = leadDirs;

    if (!state.plan) setPlan(await makePlan(architect));
    await approvePlan(architect);
    if (state.followUp) await planFollowUp(architect, state.followUp);
    const plan = state.plan!;

    for (let i = 0; i < plan.tasks.length; i++) {
      if (!(await runTask(architect, plan, i))) {
        state.status = 'needs_human';
        break;
      }
    }
    if (state.status === 'running') state.status = 'passed';
  } catch (err) {
    // Nothing is lost: finished steps are saved and finished work is committed.
    state.status = 'paused';
    state.error = (err as Error).message;
    log.emit({
      type: 'paused',
      id: state.id,
      message: state.error,
      stopped: d.signal?.aborted === true,
      limit: looksLikeLimit(state.error),
      resetsAt: state.planLimits?.resetsAt,
    });
  }

  delete state.pid;
  if (state.status !== 'paused') state.finishedAt = new Date().toISOString();
  log.emit({ type: 'run_finished', status: state.status, usage: state.usage, planLimits: state.planLimits });
  save();
  return state;
}
