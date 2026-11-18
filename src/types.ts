// Shared shapes. Plain interfaces only: the app runs on Node's built-in type stripping.

export interface PlanTask {
  id: string;
  title: string;
  summary: string;
}

export interface Plan {
  tasks: PlanTask[];
  /** What the lead decided on its own where the request left room. Shown to the user. */
  assumptions: string[];
}

/** The lead's reply at planning time: either questions for the user, or the plan. */
export type PlanReply = { questions: string[] } | Plan;

/**
 * Puts the lead's questions to the user and returns one answer per question.
 * Absent when nobody is there to answer (unattended runs).
 */
export type AskUser = (stage: string, questions: string[]) => Promise<string[]>;

export interface WorkOrder {
  goal: string;
  files_in_scope: string[];
  files_off_limits: string[];
  steps: string[];
  acceptance_criteria: string[];
  verify_commands: string[];
  /** With Hydrogen workers: how the lead split the files among them, one worker per entry. */
  assignments?: Assignment[];
}

export interface Assignment {
  /** The files this worker owns. No file belongs to two workers. */
  files: string[];
  /** What this worker writes, including the exact names and types it shares with the others. */
  instructions: string;
}

export interface Issue {
  file: string;
  problem: string;
  required_fix: string;
}

export interface Verdict {
  verdict: 'pass' | 'fail';
  summary: string;
  issues: Issue[];
  /** On a fail: things only the user can decide, asked before the retry is written. */
  questions: string[];
  /** On a fail: the lead's complete, rewritten instruction for the next attempt. */
  next_instruction: string;
}

export type Role = 'architect' | 'reviewer' | 'escalation' | 'executor';

export interface AgentResult {
  text: string;
  sessionId?: string;
  /** Tokens sent fresh (including ones written to the cache). */
  inputTokens: number;
  /** Tokens re-read from the cache, which cost far less than fresh ones. */
  cachedTokens: number;
  outputTokens: number;
  /** Share of the Claude plan's limits used so far (0 to 1), when the CLI reports it. */
  planLimits?: PlanLimits;
  /** The model that actually answered, as the CLI reports it. */
  model?: string;
  /** Commands the executor tried to run but was not allowed to. */
  blocked?: string[];
  /** Set when the executor's run ended early (a time limit or an error) rather than finishing. */
  endedEarly?: string;
  /** Hydrogen workers' conversations, by assignment key, to continue on the next attempt. */
  sessions?: Record<string, string>;
}

export interface PlanLimits {
  fiveHour?: number;
  sevenDay?: number;
  /** When the 5-hour window resets, in seconds since 1970. */
  resetsAt?: number;
}

export interface LeadRequest {
  /** Called with a short description each time the model does something visible. */
  onActivity?: (text: string) => void;
  /** Aborting this kills the model process; the call then fails with "stopped". */
  signal?: AbortSignal;
  role: 'architect' | 'reviewer' | 'escalation';
  prompt: string;
  cwd: string;
  sessionId?: string;
  /** Branch a new conversation off sessionId instead of continuing it. */
  fork?: boolean;
  /** Called as soon as the conversation id is known, before the reply. */
  onSession?: (id: string) => void;
  /** Extra folders the lead may read, such as the user's attachments. */
  addDirs?: string[];
  /**
   * none: answers from the prompt alone (reviews). read: may inspect files (planning).
   * write: may edit files (escalation only).
   */
  tools: 'none' | 'read' | 'write';
}

/** The lead Claude model: plans, writes work orders, reviews, and takes over on escalation. */
export interface Lead {
  ask(req: LeadRequest): Promise<AgentResult>;
}

export interface ExecutorRequest {
  /** Folder with the user's attachments, readable by the executor. */
  attachDir?: string;
  onActivity?: (text: string) => void;
  signal?: AbortSignal;
  prompt: string;
  cwd: string;
  /** Folder for oversized prompts that have to be passed as a file. */
  runDir: string;
  /** With Hydrogen workers on: one prompt per worker, all run at the same time. */
  workers?: WorkerRun[];
  /** agy model for a single session; defaults to the configured executor model. */
  model?: string;
  /** Continue this agy conversation instead of starting a new one. */
  sessionId?: string;
  /** The full prompt, for a fresh start if sessionId cannot be continued. */
  freshPrompt?: string;
}

export interface WorkerRun {
  label: string;
  prompt: string;
  /** Identifies the worker's assignment across attempts, so its conversation can be continued. */
  key?: string;
  /** The worker's conversation from an earlier attempt; `prompt` then holds only what is new. */
  sessionId?: string;
  /** The full prompt, for a fresh start if the earlier conversation cannot be continued. */
  freshPrompt?: string;
}

/** Gemini via agy: carries out a work order inside the worktree. */
export interface Executor {
  run(req: ExecutorRequest): Promise<AgentResult>;
}

export interface Workspace {
  dir: string;
  branch: string;
  head(): Promise<string>;
  /** Stages and commits everything; returns the resulting HEAD. */
  checkpoint(message: string): Promise<string>;
  diff(base: string): Promise<string>;
  changedFiles(base: string): Promise<string[]>;
  /** Text of a file in the worktree, or null if it is missing or not readable as text. */
  read(path: string): Promise<string | null>;
  /** Throws away anything not yet checkpointed: the half-done edits of an interrupted step. */
  reset(): Promise<void>;
}

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export type VerifyFn = (commands: string[], cwd: string) => Promise<CheckResult[]>;

export interface Config {
  /** Any Claude model the claude CLI accepts: an alias such as "opus" or a full ID such as "claude-fable-5-2". */
  leadModel: string;
  /** Optional per-role override, e.g. { "architect": "claude-fable-5-2", "reviewer": "opus" }. */
  leadModels: Partial<Record<'architect' | 'reviewer' | 'escalation', string>>;
  /** Thinking level for the lead (low, medium, high, xhigh, max). Unset: the model's default. */
  leadEffort?: string;
  executorModel: string;
  maxAttempts: number;
  /** Commands you trust, run after every attempt. */
  verifyCommands: string[];
  /** Show the plan to the user and wait for approval before any work starts. */
  confirmPlan: boolean;
  /** Also run the commands the lead proposes in the work order. Off by default. */
  allowArchitectCommands: boolean;
  /** Let the executor run any tool without asking. Off by default. */
  executorSkipPermissions: boolean;
  leadTimeoutMs: number;
  executorTimeoutMs: number;
  /**
   * Who writes the code. Empty: Argon. A Hydrogen model: orc starts one Hydrogen worker per
   * assignment in the lead's work order, all at the same time, with no Argon and no agy swarm.
   */
  executorWorkers?: string;
  /**
   * closed (default): every task is reviewed by the lead and retried until it passes.
   * open: the lead only writes the instructions; one Hydrogen session does every task, with no
   * review, and the user checks the result.
   */
  mode?: 'closed' | 'open';
  /** false: when the executor uses up its attempts, it gets another round instead of the lead taking over. */
  takeover?: boolean;
  verifyTimeoutMs: number;
}

export interface RoleUsage {
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** The model that answered this role's most recent call. */
  model?: string;
}

export interface TaskState {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  attempts: number;
  escalated: boolean;
  commit?: string;

  // Everything below exists so an interrupted run can pick up where it stopped.
  workOrder?: WorkOrder;
  /** Commit the task started from; diffs for review are taken against it. */
  base?: string;
  /** Every verdict so far, in order: one per executor attempt, then the escalation's. */
  history?: Verdict[];
  reviewerSession?: string;
  /** Commit the reviewer last judged; later reviews get only the changes since. */
  reviewed?: string;
  /** Files this task changed, for the lead's summary of finished work. */
  files?: string[];
  /** The lead's takeover conversation, kept so a restart picks it up instead of starting over. */
  escalationSession?: string;
  /** Work that was checkpointed but not yet reviewed when the run stopped. */
  pending?: { label: string; fileTag: string; report: string };
  escalationJudged?: boolean;
  /** How many times the user retried this task after it failed. */
  retries?: number;
  /** Length of the history when the latest retry began; attempts are counted from here. */
  retryFrom?: number;
  /** Each Hydrogen worker's agy conversation for this task, by assignment, continued on retries. */
  workerSessions?: Record<string, string>;
  /** Rounds of attempts this task has had (more than one only when takeovers are off). */
  rounds?: number;
}

export interface RunState {
  id: string;
  request: string;
  /** paused: stopped partway (limit, error, or Ctrl+C) and can be continued with "orc resume". */
  status: 'running' | 'paused' | 'passed' | 'needs_human' | 'error';
  branch: string;
  worktree: string;
  /** Process running this run, so a second window cannot resume it while it is live. */
  pid?: number;
  plan?: Plan;
  architectSession?: string;
  /** A request made after the plan was finished, waiting to be planned. */
  followUp?: string;
  /** Index into attachments where the files sent with that request begin. */
  followUpAttachmentsFrom?: number;
  /** Requests made after the first plan was finished, in order. */
  followUps?: string[];
  /** Open-ended mode: the one Hydrogen conversation that does every task, continued across tasks. */
  executorSession?: string;
  /** The review conversation shared by all tasks. */
  reviewerSession?: string;
  /** Messages the user sent to the lead during the run, in order. */
  userNotes?: string[];
  /** Full paths of files the user attached to the request. */
  attachments?: string[];
  /** The user has approved the plan (or approval was not needed). */
  planApproved?: boolean;
  tasks: TaskState[];
  usage: Record<string, RoleUsage>;
  planLimits?: PlanLimits;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface OrcEvent {
  type: string;
  ts?: string;
  [key: string]: unknown;
}

export interface Log {
  dir: string;
  emit(event: OrcEvent): void;
  saveState(state: RunState): void;
  saveArtifact(name: string, content: string): void;
}
