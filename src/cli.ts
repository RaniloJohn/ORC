import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { repoRoot } from './git.ts';
import { markPaused, resumeRun, startRun } from './runner.ts';
import type { RunHandle, RunHooks } from './runner.ts';
import { listRuns, readEvents } from './runlog.ts';
import type { AskUser, Config, OrcEvent, PlanLimits, RoleUsage } from './types.ts';
import { startUi } from './ui/server.ts';

const HELP = `orc - a lead Claude model plans and reviews, Gemini (agy) executes

Usage
  orc ui                          Open the GUI in your browser (start, watch, answer, resume)
  orc run "<request>" [options]   Plan, execute, review, and retry until it passes
  orc resume [run-id]             Continue a run that paused (limit hit, error, Ctrl+C);
                                  add --lead-model <model> to continue with a different lead
  orc status [--repo <path>]      List runs in a project folder
  orc log <run-id> [--repo <path>] Replay a run's events

Options for run
  --repo <path>             Project folder (default: current folder). It needs no
                            setup: orc handles version tracking itself
  --merge                   In a git repository you manage yourself, also bring
                            passed work into your current branch
  --verify "<command>"      Check to run after every attempt; repeat for several
  --max-attempts <n>        Executor attempts before the lead takes over (default 3)
  --lead-model <model>      Claude model for all lead roles (default opus;
                            e.g. claude-fable-5-2, sonnet)
  --lead-effort <level>     Lead thinking level: low, medium, high, xhigh, max
  --attach <file>           A picture or file that goes with the request; repeat for several
  --architect-model <model> Override for planning and work orders only
  --reviewer-model <model>  Override for reviews only
  --escalation-model <model> Override for the take-over only
  --executor-model <model>  agy model (default gemini-pro-orchestrator-g1-pro)
  --trust-lead-commands     Also run the check commands the lead proposes
  --executor-full-access    Let the executor run any tool without asking
  --no-questions            Unattended: the lead decides for itself and lists its
                            assumptions instead of asking you
  --no-plan-check           Start work as soon as the plan is ready, without asking you
  --executor-minutes <n>    How long one Argon attempt may run (default 45, up to 240)
  --mode <closed|open>      closed (default): Opus reviews every task and sends it back until
                            it passes. open: Opus only writes the instructions; one Hydrogen
                            session (the --workers model, default gemini-4-hydrogen-high)
                            does every task with no review, and you check the result
  --workers <model|off>     Hydrogen workers write the code instead of Argon, one per file
                            group that the lead assigns, all at once (e.g.
                            gemini-4-hydrogen-high). Default off: Argon writes it

Options for ui
  --port <n>                Port for the local page (default 47517, or the next free one)
  --no-open                 Do not open the browser automatically

The same settings can live in orc.config.json in the project folder.`;

interface Args {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set([
  'trust-lead-commands',
  'executor-full-access',
  'no-questions',
  'no-plan-check',
  'merge',
  'no-open',
  'help',
]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, ['true']);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

const one = (args: Args, name: string): string | undefined => args.flags.get(name)?.at(-1);

const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function usageLine(usage: Record<string, RoleUsage>): string {
  const lead: RoleUsage = { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  for (const role of ['architect', 'reviewer', 'escalation']) {
    const u = usage[role];
    if (!u) continue;
    lead.calls += u.calls;
    lead.inputTokens += u.inputTokens;
    lead.cachedTokens += u.cachedTokens ?? 0;
    lead.outputTokens += u.outputTokens;
  }
  const ex = usage.executor ?? { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  const part = (name: string, u: RoleUsage) =>
    `${name.padEnd(9)} ${u.calls} calls   ${k(u.inputTokens)} in (+${k(u.cachedTokens ?? 0)} cached)   ${k(u.outputTokens)} out`;
  return `usage     ${part('lead', lead)}\n          ${part('executor', ex)}`;
}

let replaying = false;
const PAD = '              ';
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
};
const clock = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// While a model is thinking nothing is printed, so a heartbeat shows the run is alive.
let lastOutputAt = Date.now();
let stepStartedAt = Date.now();
let waitingForUser = false;
function startHeartbeat(): void {
  const timer = setInterval(() => {
    if (waitingForUser || Date.now() - lastOutputAt < 30000) return;
    const secs = Math.round((Date.now() - stepStartedAt) / 1000);
    const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    console.log(`${PAD}· still working (${elapsed} on this step)`);
    lastOutputAt = Date.now();
  }, 5000);
  timer.unref();
}

/** Asks each question on the terminal and waits for a typed answer. */
const askOnTerminal: AskUser = async (stage, questions) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answers: string[] = [];
  waitingForUser = true;
  console.log(
    stage === 'plan approval'
      ? '  (press Enter to approve and start, or type what to change)'
      : '  (answer each one and press Enter; just Enter lets the lead decide)',
  );
  try {
    for (let i = 0; i < questions.length; i++) {
      answers.push((await rl.question(`  answer ${i + 1} of ${questions.length}> `)).trim());
    }
  } finally {
    rl.close();
    waitingForUser = false;
  }
  return answers;
};

/** Turns one event into the line the terminal shows. Also used to replay old runs. */
function render(e: OrcEvent): string | undefined {
  const label = String(e.label ?? '').padEnd(10);
  switch (e.type) {
    case 'run_started':
      return `[run ${e.id}] branch ${e.branch}\n            ${e.worktree}`;
    case 'resumed': {
      const where = e.planned
        ? `${e.done} of ${e.total} tasks already done`
        : 'it stopped before the plan was finished, so planning starts again';
      return `\n[run ${e.id}] continuing: ${where}`;
    }
    case 'paused': {
      if (e.stopped) return '\npaused    Stopped. Everything finished so far is saved.';
      const future = typeof e.resetsAt === 'number' && e.resetsAt * 1000 > Date.now();
      const when = future ? ` Claude's 5-hour limit resets around ${clock(e.resetsAt as number)}.` : '';
      return e.limit
        ? `\npaused    A usage limit was reached.${when}\n          ${oneLine(String(e.message), 300)}`
        : `\npaused    The run stopped on an error and can be continued.\n          ${oneLine(String(e.message), 400)}`;
    }
    case 'plan_ready': {
      const tasks = e.tasks as string[];
      const assumptions = (e.assumptions as string[] | undefined) ?? [];
      return (
        `[architect] plan ready: ${tasks.length} task${tasks.length === 1 ? '' : 's'}\n` +
        tasks.map((t, i) => `            ${i + 1}. ${t}`).join('\n') +
        (assumptions.length
          ? `\n            assumed:\n${assumptions.map((a) => `            - ${a}`).join('\n')}`
          : '')
      );
    }
    case 'plan_approved':
      return '  approved    work starts now';
    case 'questions': {
      if (e.stage === 'plan approval') return `\n[check the plan]\n${(e.questions as string[])[0]}`;
      const questions = e.questions as string[];
      return `\n[lead asks] ${e.stage}\n` + questions.map((q, i) => `  ${i + 1}. ${q}`).join('\n');
    }
    case 'answers': {
      // Shown only when replaying a past run; live, the user has just typed them.
      if (!replaying) return undefined;
      return (e.answers as string[]).map((a, i) => `  answer ${i + 1}> ${a}`).join('\n');
    }
    case 'task_started':
      return `\n[task ${(e.index as number) + 1}/${e.total}] ${e.title}`;
    case 'working':
      return `  ${String(e.who).padEnd(10)}  ${e.what}...`;
    case 'activity':
      return `${PAD}· ${e.who}: ${e.text}`;
    case 'work_order': {
      if (!Array.isArray(e.steps)) return `  work order  ${e.steps} steps, ${e.criteria} acceptance criteria`;
      const steps = e.steps as string[];
      const criteria = e.criteria as string[];
      return [
        `  work order  ${oneLine(String(e.goal), 300)}`,
        `${PAD}steps for the executor:`,
        ...steps.map((s, i) => `${PAD}  ${i + 1}. ${oneLine(s, 220)}`),
        `${PAD}it passes review only if:`,
        ...criteria.map((c) => `${PAD}  - ${oneLine(c, 220)}`),
      ].join('\n');
    }
    case 'attempt_empty': {
      const blocked = (e.blocked as string[] | undefined) ?? [];
      return `  attempt ${e.attempt}   executor changed nothing (${e.run} of ${e.max}); not counted` +
        (blocked.length ? `\n${PAD}it was not allowed to run: ${blocked.join('; ')}` : '');
    }
    case 'task_reset':
      return `
[task ${(e.index as number) + 1}] ${oneLine(String(e.reason), 400)}`;
    case 'executor_ended_early':
      return `  attempt ${e.attempt}   executor stopped early: ${e.reason}`;
    case 'user_note':
      return `\n[you]       ${oneLine(String(e.text), 400)}`;
    case 'attempt_started':
      return `\n  attempt ${e.attempt}/${e.max}  executor (Gemini) is working...`;
    case 'changes': {
      if (!Array.isArray(e.files)) return `  ${label}  ${e.files} file${e.files === 1 ? '' : 's'} changed`;
      const files = e.files as string[];
      const shown = files.slice(0, 15).map((f) => `${PAD}  ${f}`);
      if (files.length > 15) shown.push(`${PAD}  ... and ${files.length - 15} more`);
      const report = String(e.report ?? '').trim();
      return [
        `  ${label}  ${files.length} file${files.length === 1 ? '' : 's'} changed${files.length ? ':' : ''}`,
        ...shown,
        ...(report ? [`${PAD}executor's report: ${oneLine(report, 500)}`] : []),
      ].join('\n');
    }
    case 'verify_done': {
      const failed = e.failed as string[];
      if (e.ran === 0) return `  ${label}  verify: no checks configured`;
      return failed.length
        ? `  ${label}  verify: FAIL (${failed.join('; ')})`
        : `  ${label}  verify: ${e.ran} check${e.ran === 1 ? '' : 's'} ok`;
    }
    case 'review_done': {
      if (e.verdict === 'pass') return `  ${label}  review: PASS  ${e.summary}`;
      if (!Array.isArray(e.issues)) {
        return `  ${label}  review: FAIL  ${e.issues} issue${e.issues === 1 ? '' : 's'} - ${e.summary}`;
      }
      const issues = e.issues as { file: string; problem: string }[];
      const next = String(e.nextInstruction ?? '').trim();
      return [
        `  ${label}  review: FAIL  ${e.summary}`,
        ...issues.map((it, i) => `${PAD}  ${i + 1}. ${it.file ? `${it.file}: ` : ''}${oneLine(it.problem, 260)}`),
        ...(next ? [`${PAD}the lead's new instructions for the next attempt:`, `${PAD}  ${oneLine(next, 700)}`] : []),
      ].join('\n');
    }
    case 'escalation_started':
      return `  escalating  executor failed ${e.after} attempts; the lead is doing it itself...`;
    case 'task_passed':
      return `  passed      commit ${String(e.commit).slice(0, 7)}${e.escalated ? ' (by the lead)' : ''}`;
    case 'task_failed':
      return `  FAILED      even after escalation: ${e.summary}`;
    case 'error':
      return `\nerror       ${e.message}`;
    case 'run_finished': {
      const limits = e.planLimits as PlanLimits | undefined;
      const pct = (n: number | undefined) => (typeof n === 'number' ? `${Math.round(n * 100)}%` : 'unknown');
      const plan = limits
        ? `\nClaude plan  ${pct(limits.fiveHour)} of the 5-hour limit used, ${pct(limits.sevenDay)} of the weekly limit`
        : '';
      return `\nresult    ${e.status}\n${usageLine(e.usage as Record<string, RoleUsage>)}${plan}`;
    }
    case 'outcome':
      switch (e.outcome) {
        case 'applied':
          return `\nThe finished work is now in ${e.repo}`;
        case 'conflict':
          return `\nThe work passed but could not be brought into ${e.repo} automatically, because the folder changed during the run.\nIt is safe on branch ${e.branch}.`;
        case 'on_branch':
          return `\nThe work is on branch ${e.branch}. To bring it into your current branch:\n  git merge ${e.branch}`;
        case 'paused':
          return '\nNothing is lost: finished steps are saved and your folder was not changed.\nTo continue from where it stopped:\n  orc resume';
        default:
          return `\nYour folder was not changed. The partial work is kept aside on branch ${e.branch}.`;
      }
    default:
      return undefined;
  }
}

function print(e: OrcEvent): void {
  const line = render(e);
  if (line === undefined) return;
  console.log(line);
  lastOutputAt = Date.now();
  if (e.type !== 'activity') stepStartedAt = Date.now();
}

/** The terminal's side of a run: printing, answering questions, and Ctrl+C. */
function terminalHooks(args: Args): RunHooks {
  // Questions need someone at the keyboard; piped or scheduled runs go unattended.
  const interactive = !args.flags.has('no-questions') && process.stdin.isTTY === true;
  if (!interactive && !args.flags.has('no-questions')) {
    console.log('note      no terminal attached, so the lead will not ask questions; it will list its assumptions instead');
  }
  return {
    onEvent: print,
    onNote: (text) => console.log(`note      ${text}`),
    askUser: interactive ? askOnTerminal : undefined,
  };
}

async function follow(handle: RunHandle): Promise<number> {
  process.on('SIGINT', () => {
    markPaused(handle.repo, handle.runId, 'stopped with Ctrl+C');
    console.log('\n\npaused    Stopped. Everything finished so far is saved.\n          To continue:  orc resume');
    process.exit(130);
  });
  startHeartbeat();
  const { state } = await handle.done;
  return state.status === 'passed' ? 0 : 1;
}

async function cmdRun(args: Args): Promise<number> {
  const request = args.positional.slice(1).join(' ').trim();
  if (!request) throw new Error('give the request in quotes: orc run "what to build"');

  const overrides: Partial<Config> = {};
  const verify = args.flags.get('verify');
  if (verify) overrides.verifyCommands = verify;
  if (one(args, 'max-attempts')) overrides.maxAttempts = Number(one(args, 'max-attempts'));
  if (one(args, 'lead-model')) overrides.leadModel = one(args, 'lead-model');
  if (one(args, 'lead-effort')) overrides.leadEffort = one(args, 'lead-effort');
  if (one(args, 'executor-model')) overrides.executorModel = one(args, 'executor-model');
  if (args.flags.has('trust-lead-commands')) overrides.allowArchitectCommands = true;
  if (args.flags.has('executor-full-access')) overrides.executorSkipPermissions = true;
  if (args.flags.has('no-plan-check')) overrides.confirmPlan = false;
  if (one(args, 'executor-minutes')) overrides.executorTimeoutMs = Number(one(args, 'executor-minutes')) * 60 * 1000;
  if (one(args, 'mode')) overrides.mode = one(args, 'mode') as Config['mode'];
  if (args.flags.has('workers')) overrides.executorWorkers = one(args, 'workers') === 'off' ? '' : one(args, 'workers');

  const leadModels: Config['leadModels'] = {};
  for (const role of ['architect', 'reviewer', 'escalation'] as const) {
    const model = one(args, `${role}-model`);
    if (model) leadModels[role] = model;
  }

  const attachments = (args.flags.get('attach') ?? []).map((file) => ({
    name: basename(file),
    data: readFileSync(resolve(file)),
  }));
  const handle = await startRun({
    folder: one(args, 'repo') ?? '.',
    request,
    attachments,
    overrides,
    leadModels,
    merge: args.flags.has('merge'),
    ...terminalHooks(args),
  });
  return follow(handle);
}

async function cmdResume(args: Args): Promise<number> {
  const handle = await resumeRun({
    folder: one(args, 'repo') ?? '.',
    runId: args.positional[1],
    leadModel: one(args, 'lead-model'),
    leadEffort: one(args, 'lead-effort'),
    ...terminalHooks(args),
  });
  return follow(handle);
}

async function cmdStatus(args: Args): Promise<number> {
  const repo = await repoRoot(resolve(one(args, 'repo') ?? '.'));
  const runs = listRuns(repo);
  if (runs.length === 0) {
    console.log('No runs in this folder yet.');
    return 0;
  }
  for (const run of runs) {
    const done = run.tasks.filter((t) => t.status === 'passed').length;
    console.log(`${run.id}  ${run.status.padEnd(11)}  ${done}/${run.tasks.length} tasks  ${run.request.slice(0, 60)}`);
  }
  return 0;
}

async function cmdLog(args: Args): Promise<number> {
  const id = args.positional[1];
  if (!id) throw new Error('give a run id: orc log <run-id>  (see "orc status")');
  const repo = await repoRoot(resolve(one(args, 'repo') ?? '.'));
  const events = readEvents(repo, id);
  if (events.length === 0) throw new Error(`no run "${id}" in ${repo}`);
  replaying = true;
  events.forEach(print);
  return 0;
}

async function cmdUi(args: Args): Promise<number> {
  const port = one(args, 'port') ? Number(one(args, 'port')) : undefined;
  await startUi({ port, open: !args.flags.has('no-open') });
  // The server keeps the process alive until the window is closed or Ctrl+C is pressed.
  return new Promise<number>(() => {});
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  if (!command || command === 'help' || args.flags.has('help')) {
    console.log(HELP);
    return 0;
  }
  if (command === 'ui') return cmdUi(args);
  if (command === 'run') return cmdRun(args);
  if (command === 'resume') return cmdResume(args);
  if (command === 'status') return cmdStatus(args);
  if (command === 'log') return cmdLog(args);
  throw new Error(`unknown command "${command}". Run "orc help".`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`orc: ${(err as Error).message}`);
    process.exit(2);
  },
);
