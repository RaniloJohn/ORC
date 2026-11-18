import { DEFAULTS } from './config.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { EFFORTS } from './agents/claude.ts';
import { attachmentsText } from './prompts.ts';
import { agyExecutor } from './agents/agy.ts';
import { claudeLead } from './agents/claude.ts';
import { loadConfig } from './config.ts';
import { applyRun, createWorkspace, hasWorkspace, isDirty, openWorkspace, prepareRepo, repoRoot, reviveWorkspace, snapshot } from './git.ts';
import { reopenFailed, runOrchestration } from './machine.ts';
import { createLog, listRuns, readArtifact, readState } from './runlog.ts';
import type { AskUser, Config, Log, OrcEvent, RunState, Workspace } from './types.ts';
import { shellVerify } from './verify.ts';

/** What a run was started with, saved so a resume continues it the same way. */
export interface RunSettings {
  cfg: Config;
  /** Bring passed work into the folder automatically. */
  applyOnPass: boolean;
}

/** How the caller (terminal or GUI) takes part in a run. */
export interface RunHooks {
  /** Answers the lead's questions. Leave out for unattended runs. */
  askUser?: AskUser;
  onEvent?: (event: OrcEvent) => void;
  /** One-off remarks before the run starts, such as "set up version tracking". */
  onNote?: (text: string) => void;
  /** Aborting this stops the run; it ends as paused and can be resumed. */
  signal?: AbortSignal;
}

export interface StartInput extends RunHooks {
  folder: string;
  request: string;
  overrides?: Partial<Config>;
  leadModels?: Config['leadModels'];
  /** In a repository the user manages, also merge passed work. */
  merge?: boolean;
  /** Pictures and files that go with the request. */
  attachments?: Attachment[];
}

export interface ResumeInput extends RunHooks {
  folder: string;
  /** Defaults to the most recent run that can be continued. */
  runId?: string;
  /** Continue with a different lead model than the run was started with. */
  leadModel?: string;
  leadEffort?: string;
}

/**
 * Where the work ended up.
 * applied: it is in the folder. conflict: passed, but the folder changed meanwhile, so it
 * stays on its branch. on_branch: passed, left on its branch by choice. paused: stopped
 * partway and resumable. not_passed: failed even after escalation.
 */
export type Outcome = 'applied' | 'conflict' | 'on_branch' | 'paused' | 'not_passed';

export interface RunResult {
  state: RunState;
  outcome: Outcome;
}

export interface RunHandle {
  runId: string;
  repo: string;
  logDir: string;
  /** The live settings object: changing the lead model here takes effect on the lead's next call. */
  settings: RunSettings;
  done: Promise<RunResult>;
}

const MODEL_NAME = /^[\w.\-[\]]+$/;

/** The model every lead role uses right now, or the per-role mix if they differ. */
export function currentLeadModel(settings: RunSettings): string {
  const { leadModel, leadModels } = settings.cfg;
  const used = new Set(
    (['architect', 'reviewer', 'escalation'] as const).map((role) => leadModels[role] ?? leadModel),
  );
  return used.size === 1 ? [...used][0] : leadModel;
}

export function readSettings(repo: string, runId: string): RunSettings | undefined {
  const saved = readArtifact(repo, runId, 'settings.json');
  return saved ? (JSON.parse(saved) as RunSettings) : undefined;
}

export interface RunOptions {
  leadModel: string;
  leadEffort: string;
  executorSkipPermissions: boolean;
  /** How long one Argon attempt may run before agy stops it. */
  executorMinutes: number;
  /** Model of Argon's Hydrogen workers; empty when Argon writes the code itself. */
  executorWorkers: string;
  /** false: no lead takeover; the executor gets more rounds instead. */
  takeover: boolean;
  /** closed: the lead reviews every task. open: one Hydrogen session does it all, unreviewed. */
  mode: 'closed' | 'open';
}

export const EXECUTOR_MINUTES = [20, 30, 45, 60, 90, 120, 180];

/** Models Argon's workers can run on. */
export const WORKER_MODELS = ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh'];

/** The choices a person can change on a run: lead model, thinking level, command access. */
export function currentOptions(settings: RunSettings): RunOptions {
  return {
    leadModel: currentLeadModel(settings),
    leadEffort: settings.cfg.leadEffort ?? '',
    executorSkipPermissions: settings.cfg.executorSkipPermissions === true,
    executorMinutes: Math.round((settings.cfg.executorTimeoutMs || DEFAULTS.executorTimeoutMs) / 60000),
    executorWorkers: settings.cfg.executorWorkers ?? DEFAULTS.executorWorkers ?? '',
    takeover: settings.cfg.takeover !== false,
    mode: settings.cfg.mode === 'open' ? 'open' : 'closed',
  };
}

/**
 * Changes a run's options. Pass the live settings of a run in progress to change it on the
 * fly (it applies from the next model call); the choice is also saved for a later resume.
 */
export function updateRunOptions(
  repo: string,
  runId: string,
  change: Partial<RunOptions>,
  live?: RunSettings,
): RunSettings {
  const settings = live ?? readSettings(repo, runId);
  if (!settings) throw new Error(`run ${runId} has no saved settings, so it cannot be changed`);
  if (change.leadModel !== undefined) {
    if (!MODEL_NAME.test(change.leadModel)) throw new Error(`"${change.leadModel}" is not a valid model name`);
    settings.cfg.leadModel = change.leadModel;
    settings.cfg.leadModels = {};
  }
  if (change.leadEffort !== undefined) {
    if (change.leadEffort && !EFFORTS.includes(change.leadEffort)) {
      throw new Error(`"${change.leadEffort}" is not a thinking level`);
    }
    if (change.leadEffort) settings.cfg.leadEffort = change.leadEffort;
    else delete settings.cfg.leadEffort;
  }
  if (change.executorSkipPermissions !== undefined) {
    settings.cfg.executorSkipPermissions = change.executorSkipPermissions;
  }
  if (change.executorMinutes !== undefined) {
    const minutes = Number(change.executorMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) {
      throw new Error('the time limit must be between 5 and 240 minutes');
    }
    settings.cfg.executorTimeoutMs = minutes * 60 * 1000;
  }
  if (change.executorWorkers !== undefined) {
    if (change.executorWorkers && !WORKER_MODELS.includes(change.executorWorkers)) {
      throw new Error(`"${change.executorWorkers}" is not a worker model`);
    }
    settings.cfg.executorWorkers = change.executorWorkers;
  }
  if (change.takeover !== undefined) settings.cfg.takeover = change.takeover;
  if (change.mode !== undefined) {
    if (change.mode !== 'closed' && change.mode !== 'open') throw new Error(`"${change.mode}" is not a mode`);
    settings.cfg.mode = change.mode;
  }
  createLog(repo, runId).saveArtifact('settings.json', JSON.stringify(settings, null, 2));
  return settings;
}

/** A file the user attached, as received from the page or read from disk. */
export interface Attachment {
  name: string;
  data: Buffer;
}

const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;

export const attachDirOf = (logDir: string): string => join(logDir, 'attachments');

/** Saves attachments in the run's folder and returns their full paths. */
function saveAttachments(logDir: string, files: Attachment[], prefix = ''): string[] {
  if (!files.length) return [];
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_TOTAL) throw new Error('attachments are limited to 50 MB in total');
  const dir = attachDirOf(logDir);
  mkdirSync(dir, { recursive: true });
  return files.map((f, i) => {
    if (f.data.length > MAX_FILE) throw new Error(`${f.name} is larger than 20 MB`);
    const clean = basename(f.name).replace(/[^\w.\- ]+/g, '_').slice(-120) || `file${i + 1}`;
    let path = join(dir, prefix + clean);
    for (let n = 2; existsSync(path); n++) path = join(dir, `${prefix}${n}-${clean}`);
    writeFileSync(path, f.data);
    return path;
  });
}

/** Leaves a message for the lead. It reaches the lead on its next call, or when the run continues. */
export function postNote(repo: string, runId: string, text: string, files: Attachment[] = []): void {
  let note = text.trim();
  if (!note && !files.length) throw new Error('the message is empty');
  if (note.length > 4000) throw new Error('keep the message under 4000 characters');
  const log = createLog(repo, runId);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(8, 14);
  const paths = saveAttachments(log.dir, files, `msg${stamp}-`);
  if (paths.length) note = `${note || 'See the attached files.'}${attachmentsText(paths)}`;
  const file = join(log.dir, 'inbox.json');
  const queued: string[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  queued.push(note);
  writeFileSync(file, JSON.stringify(queued));
  log.emit({ type: 'user_note', text: note });
}

/** Asks whichever orc window is running this run to stop it. */
export function requestStop(repo: string, runId: string): void {
  writeFileSync(join(createLog(repo, runId).dir, 'stop.request'), new Date().toISOString());
}

/** True, once, when a stop was requested for this run. */
export function takeStopRequest(repo: string, runId: string): boolean {
  const file = join(createLog(repo, runId).dir, 'stop.request');
  if (!existsSync(file)) return false;
  try {
    unlinkSync(file);
  } catch {
    // already taken
  }
  return true;
}

/** Takes every queued message, so each is delivered once. */
function takeNotes(logDir: string): string[] {
  const file = join(logDir, 'inbox.json');
  if (!existsSync(file)) return [];
  const taken = `${file}.${process.pid}.taking`;
  try {
    renameSync(file, taken);
    const notes = JSON.parse(readFileSync(taken, 'utf8'));
    unlinkSync(taken);
    return Array.isArray(notes) ? notes.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Switches the lead model for a run, for all lead roles. Pass the live settings of a run
 * in progress to change it on the fly; the choice is also saved for any later resume.
 */
export function setLeadModel(repo: string, runId: string, model: string, live?: RunSettings): RunSettings {
  if (!MODEL_NAME.test(model)) throw new Error(`"${model}" is not a valid model name`);
  const settings = live ?? readSettings(repo, runId);
  if (!settings) throw new Error(`run ${runId} has no saved settings, so its model cannot be changed`);
  settings.cfg.leadModel = model;
  settings.cfg.leadModels = {};
  createLog(repo, runId).saveArtifact('settings.json', JSON.stringify(settings, null, 2));
  return settings;
}

export function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function isAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const isResumable = (s: RunState): boolean =>
  s.status === 'paused' || s.status === 'error' || (s.status === 'running' && !isAlive(s.pid));

/**
 * Claims a run for this process, so it can never be driven twice at once (two drivers would
 * run every attempt twice in the same folder). The claim ends with the run, or with the process.
 */
function claimRun(logDir: string): void {
  assertFree(logDir);
  writeFileSync(join(logDir, 'driver.lock'), String(process.pid));
}

/** Refuses when a live process is already driving this run, in this window or another. */
function assertFree(logDir: string): void {
  const file = join(logDir, 'driver.lock');
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, 'utf8'));
  // This process counts too: a second Continue in the same orc window must be refused as well.
  if (pid && (pid === process.pid || isAlive(pid))) throw new Error('this run is already being worked on; it can only run once at a time');
}

function releaseRun(logDir: string): void {
  try {
    const file = join(logDir, 'driver.lock');
    if (existsSync(file) && Number(readFileSync(file, 'utf8')) === process.pid) unlinkSync(file);
  } catch {
    // a lock left behind is harmless: its process is gone, so the next claim takes it over
  }
}

async function drive(
  repo: string,
  runId: string,
  request: string,
  settings: RunSettings,
  workspace: Workspace,
  log: Log,
  hooks: RunHooks,
  resume?: RunState,
  attachments: string[] = [],
): Promise<RunResult> {
  try {
    return await driveClaimed(repo, runId, request, settings, workspace, log, hooks, resume, attachments);
  } finally {
    releaseRun(log.dir);
  }
}

async function driveClaimed(
  repo: string,
  runId: string,
  request: string,
  settings: RunSettings,
  workspace: Workspace,
  log: Log,
  hooks: RunHooks,
  resume?: RunState,
  attachments: string[] = [],
): Promise<RunResult> {
  mkdirSync(attachDirOf(log.dir), { recursive: true });
  const state = await runOrchestration({
    runId,
    request,
    cfg: settings.cfg,
    lead: claudeLead(settings.cfg),
    executor: agyExecutor(settings.cfg),
    workspace,
    verify: shellVerify(settings.cfg.verifyTimeoutMs),
    log,
    askUser: hooks.askUser,
    signal: hooks.signal,
    inbox: () => takeNotes(log.dir),
    refresh: () => {
      const saved = readSettings(repo, runId);
      if (saved) Object.assign(settings.cfg, saved.cfg);
    },
    attachDir: attachDirOf(log.dir),
    attachments,
    resume,
  });

  let outcome: Outcome;
  if (state.status === 'paused') outcome = 'paused';
  else if (state.status !== 'passed') outcome = 'not_passed';
  else if (!settings.applyOnPass) outcome = 'on_branch';
  else outcome = (await applyRun(repo, workspace)) ? 'applied' : 'conflict';
  log.emit({ type: 'outcome', outcome, repo, branch: state.branch });
  return { state, outcome };
}

/** Prepares the folder and starts a new run. Resolves as soon as the run is under way. */
export async function startRun(input: StartInput): Promise<RunHandle> {
  const request = input.request.trim();
  if (!request) throw new Error('say what you want built');

  const info = await prepareRepo(resolve(input.folder));
  const repo = info.root;
  const cfg = loadConfig(repo, input.overrides ?? {});
  if (input.leadModels) cfg.leadModels = { ...cfg.leadModels, ...input.leadModels };

  const runId = newRunId();
  if (info.created) {
    input.onNote?.('set up version tracking in this folder (a hidden .git folder) so every attempt can be checkpointed');
  }
  if (info.managed) {
    await snapshot(repo, runId);
  } else if (await isDirty(repo)) {
    input.onNote?.('the repository has uncommitted changes; the run starts from the last commit and will not see them');
  }

  const workspace = await createWorkspace(repo, runId);
  const settings: RunSettings = { cfg, applyOnPass: info.managed || input.merge === true };
  const log = createLog(repo, runId, input.onEvent);
  log.saveArtifact('settings.json', JSON.stringify(settings, null, 2));
  const attached = saveAttachments(log.dir, input.attachments ?? []);
  return {
    runId,
    repo,
    logDir: log.dir,
    settings,
    done: (claimRun(log.dir), drive(repo, runId, request, settings, workspace, log, input, undefined, attached)),
  };
}

/** Continues a run that stopped partway. */
export async function resumeRun(input: ResumeInput): Promise<RunHandle> {
  const repo = await repoRoot(resolve(input.folder));
  const id = input.runId ?? listRuns(repo).filter(isResumable).at(-1)?.id;
  if (!id) throw new Error('there is no paused run to continue here');

  const state = readState(repo, id);
  if (!state) throw new Error(`no run "${id}" in ${repo}`);
  const lockDir = createLog(repo, id).dir;
  claimRun(lockDir);
  try {
    return await resumeClaimed(input, repo, id, state);
  } catch (err) {
    releaseRun(lockDir);
    throw err;
  }
}

async function resumeClaimed(input: ResumeInput, repo: string, id: string, state: RunState): Promise<RunHandle> {
  if (state.status === 'running' && isAlive(state.pid)) {
    throw new Error(`run ${id} is still going in another window; let it finish or stop it there first`);
  }
  if (!isResumable(state)) {
    throw new Error(`run ${id} already ended as "${state.status}", so there is nothing to continue`);
  }
  if (!readSettings(repo, id)) {
    throw new Error(`run ${id} was started by an older version of orc and cannot be continued; start it again`);
  }
  // Continuing is the moment to change the lead, for instance away from a model that failed.
  const change: Partial<RunOptions> = {};
  if (input.leadModel) change.leadModel = input.leadModel;
  if (input.leadEffort !== undefined) change.leadEffort = input.leadEffort;
  const settings = Object.keys(change).length ? updateRunOptions(repo, id, change) : readSettings(repo, id)!;

  // A run that took a new request after it finished works on a fresh copy of the folder, which a
  // continue recreates if it is gone; any other run needs the copy it was working in.
  const workspace =
    !hasWorkspace(repo, id, state.worktree) && (state.followUp || state.followUps?.length)
      ? await reviveWorkspace(repo, id, state.worktree)
      : openWorkspace(repo, id, state.worktree);
  state.worktree = workspace.dir;
  const log = createLog(repo, id, input.onEvent);
  return {
    runId: id,
    repo,
    logDir: log.dir,
    settings,
    done: drive(repo, id, state.request, settings, workspace, log, input, state),
  };
}

/**
 * Reopens the task a run stopped on and continues the run. The task keeps its instructions,
 * its review conversation and all work committed so far; the executor gets a fresh set of
 * attempts, and the lead may take over again after them. `checks` replaces the commands orc
 * runs itself before each review (an empty list runs none).
 */
export async function retryRun(input: ResumeInput & { checks?: string[] }): Promise<RunHandle> {
  const repo = await repoRoot(resolve(input.folder));
  const id = input.runId ?? '';
  const state = readState(repo, id);
  if (!state) throw new Error(`no run "${id}" in ${repo}`);
  assertFree(createLog(repo, id).dir);
  if (state.status !== 'needs_human') throw new Error(`run ${id} is "${state.status}", not stopped on a failed step`);
  const failed = state.tasks.filter((t) => t.status === 'failed');
  if (!failed.length) throw new Error(`run ${id} has no failed step to retry`);
  const settings = readSettings(repo, id);
  if (!settings) throw new Error(`run ${id} was started by an older version of orc and cannot be continued; start it again`);

  if (input.checks) {
    settings.cfg.verifyCommands = input.checks.map((c) => c.trim()).filter(Boolean);
    createLog(repo, id).saveArtifact('settings.json', JSON.stringify(settings, null, 2));
  }
  reopenFailed(state);
  createLog(repo, id).saveState(state);
  return resumeRun({ ...input, folder: repo, runId: id });
}

/**
 * Gives a finished run a new request. The lead plans it in the same conversation, so it
 * remembers the project, and the new tasks run like the first ones. The run's work is already
 * in the folder, so it starts from the folder as it is now.
 */
export async function followUpRun(input: ResumeInput & { request: string; files?: Attachment[] }): Promise<RunHandle> {
  const request = input.request.trim();
  if (!request) throw new Error('say what you want next');
  const repo = await repoRoot(resolve(input.folder));
  const id = input.runId ?? '';
  const state = readState(repo, id);
  if (!state) throw new Error(`no run "${id}" in ${repo}`);
  assertFree(createLog(repo, id).dir);
  if (state.status !== 'passed') throw new Error(`run ${id} is "${state.status}"; a new request can only follow a finished run`);
  if (!state.plan) throw new Error(`run ${id} has no plan to build on`);
  if (!readSettings(repo, id)) throw new Error(`run ${id} was started by an older version of orc and cannot be continued; start a new run`);

  const info = await prepareRepo(repo);
  if (info.managed) await snapshot(repo, id);
  else if (await isDirty(repo)) input.onNote?.('the repository has uncommitted changes; the new work starts from the last commit and will not see them');
  state.worktree = (await reviveWorkspace(repo, id, state.worktree)).dir;

  const log = createLog(repo, id);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(8, 14);
  const paths = saveAttachments(log.dir, input.files ?? [], `req${stamp}-`);
  state.attachments = [...(state.attachments ?? []), ...paths];
  state.followUpAttachmentsFrom = state.attachments.length - paths.length;
  state.followUp = request;
  state.status = 'paused';
  delete state.finishedAt;
  delete state.error;
  log.saveState(state);
  log.emit({ type: 'followup', request });
  return resumeRun({ ...input, folder: repo, runId: id });
}

/** Marks a run as paused when its process is about to die (Ctrl+C, window closed). */
export function markPaused(repo: string, runId: string, reason: string): void {
  const state = readState(repo, runId);
  if (!state || state.status !== 'running') return;
  state.status = 'paused';
  state.error = reason;
  delete state.pid;
  createLog(repo, runId).saveState(state);
}
