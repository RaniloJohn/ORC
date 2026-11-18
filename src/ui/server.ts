import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../config.ts';
import { repoRoot } from '../git.ts';
import { STOPPED } from '../proc.ts';
import { WORKER_MODELS, currentOptions, isResumable, markPaused, postNote, readSettings, followUpRun, requestStop, resumeRun, retryRun, startRun, takeStopRequest, updateRunOptions } from '../runner.ts';
import type { Attachment, RunHandle, RunSettings } from '../runner.ts';
import { listRuns, readEvents, readState } from '../runlog.ts';
import type { AskUser, Config } from '../types.ts';

const PAGE = fileURLToPath(new URL('./page.html', import.meta.url));

/** A question the lead has asked that the page has not answered yet. */
interface PendingQuestion {
  stage: string;
  questions: string[];
  resolve: (answers: string[]) => void;
  reject: (err: Error) => void;
}

/** A run this server process is driving right now. */
interface ActiveRun {
  repo: string;
  runId: string;
  controller: AbortController;
  pending?: PendingQuestion;
  notes: string[];
  /** The settings object the run is reading from, so a model switch applies at once. */
  settings?: RunSettings;
}

const active = new Map<string, ActiveRun>();
const keyOf = (repo: string, runId: string): string => `${resolve(repo).toLowerCase()}|${runId}`;

// Recently used project folders, kept outside any project (and outside the home folder,
// which on some machines is itself a repository).
const dataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), '.config'), 'orc');
const recentFile = join(dataDir, 'recent.json');

function readRecent(): string[] {
  try {
    const list = JSON.parse(readFileSync(recentFile, 'utf8'));
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && existsSync(p)) : [];
  } catch {
    return [];
  }
}

function rememberFolder(folder: string): void {
  const list = [folder, ...readRecent().filter((p) => p.toLowerCase() !== folder.toLowerCase())].slice(0, 8);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(recentFile, JSON.stringify(list, null, 2));
}

/** Lists the sub-folders of a path, for the page's folder picker. An empty path lists drives. */
function listDirs(path: string): { path: string; parent: string | null; dirs: string[] } {
  if (!path) {
    if (process.platform !== 'win32') return listDirs('/');
    const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'
      .split('')
      .map((letter) => `${letter}:\\`)
      .filter((drive) => existsSync(drive));
    return { path: '', parent: null, dirs: drives };
  }
  const full = resolve(path);
  const dirs: string[] = [];
  for (const name of readdirSync(full)) {
    if (name.startsWith('.') || name.startsWith('$') || name === 'node_modules') continue;
    try {
      if (statSync(join(full, name)).isDirectory()) dirs.push(name);
    } catch {
      // unreadable entries (system folders, broken links) are simply not offered
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  const isRoot = parse(full).root === full;
  return { path: full, parent: isRoot ? (process.platform === 'win32' ? '' : null) : dirname(full), dirs };
}

/** Starts or resumes a run and wires its questions and stop button to the page. */
async function launch(
  begin: (hooks: { askUser: AskUser; onNote: (t: string) => void; signal: AbortSignal }) => Promise<RunHandle>,
): Promise<{ runId: string; repo: string; notes: string[] }> {
  const controller = new AbortController();
  const run: ActiveRun = { repo: '', runId: '', controller, notes: [] };

  const askUser: AskUser = (stage, questions) =>
    new Promise<string[]>((resolveAnswers, reject) => {
      run.pending = { stage, questions, resolve: resolveAnswers, reject };
    });

  const handle = await begin({ askUser, onNote: (t) => run.notes.push(t), signal: controller.signal });
  rememberFolder(handle.repo);
  run.repo = handle.repo;
  run.runId = handle.runId;
  run.settings = handle.settings;
  const key = keyOf(run.repo, run.runId);
  active.set(key, run);
  handle.done
    .catch(() => {
      // a crash outside the loop: the saved state already reflects the last finished step
      markPaused(run.repo, run.runId, 'the run stopped unexpectedly');
    })
    .finally(() => active.delete(key));
  return { runId: run.runId, repo: run.repo, notes: run.notes };
}

function stopRun(run: ActiveRun): void {
  run.controller.abort();
  // If the lead is waiting on the user, no model process is running to be killed,
  // so the wait itself has to be broken.
  run.pending?.reject(new Error(STOPPED));
  run.pending = undefined;
}

/** Files arrive from the page as { name, data } with the data base64-encoded. */
function decodeFiles(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((f, i) => ({
    name: String(f?.name ?? `file${i + 1}`),
    data: Buffer.from(String(f?.data ?? ''), 'base64'),
  }));
}

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 75_000_000) throw new Error('request too large (attachments are limited to 50 MB)');
  }
  return raw ? (JSON.parse(raw) as Record<string, any>) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function api(path: string, method: string, query: URLSearchParams, req: IncomingMessage): Promise<unknown> {
  if (method === 'GET' && path === '/api/home') {
    return {
      recent: readRecent(),
      defaults: { leadModel: DEFAULTS.leadModel, executorModel: DEFAULTS.executorModel, maxAttempts: DEFAULTS.maxAttempts },
    };
  }

  if (method === 'GET' && path === '/api/dirs') {
    return listDirs(query.get('path') ?? '');
  }

  if (method === 'GET' && path === '/api/runs') {
    const folder = query.get('folder') ?? '';
    if (!folder || !existsSync(folder)) return { repo: null, runs: [] };
    let repo: string;
    try {
      repo = await repoRoot(resolve(folder));
    } catch {
      return { repo: null, runs: [] }; // a folder orc has not worked in yet
    }
    // A folder inside some larger repository (a home folder, say) has no runs of its own.
    if (resolve(folder).toLowerCase() !== repo.toLowerCase()) return { repo: null, runs: [] };
    const runs = listRuns(repo)
      .reverse()
      .map((s) => ({
        id: s.id,
        request: s.request,
        status: s.status === 'running' && !active.has(keyOf(repo, s.id)) && isResumable(s) ? 'paused' : s.status,
        done: s.tasks.filter((t) => t.status === 'passed').length,
        total: s.tasks.length,
        startedAt: s.startedAt,
      }));
    return { repo, runs };
  }

  if (method === 'GET' && path === '/api/run') {
    const repo = query.get('repo') ?? '';
    const id = query.get('id') ?? '';
    const from = Number(query.get('from') ?? 0);
    const state = readState(repo, id);
    if (!state) throw new Error(`no run "${id}" here`);
    const events = readEvents(repo, id);
    const run = active.get(keyOf(repo, id));
    // A run marked running that this server is not driving (and whose process is gone) was interrupted.
    const status = state.status === 'running' && !run && isResumable(state) ? 'paused' : state.status;
    const settings = run?.settings ?? readSettings(repo, id);
    return {
      options: settings ? currentOptions(settings) : null,
      events: events.slice(from),
      total: events.length,
      state: { ...state, status },
      live: Boolean(run),
      pending: run?.pending ? { stage: run.pending.stage, questions: run.pending.questions } : null,
      notes: run?.notes ?? [],
    };
  }

  if (method !== 'POST') throw new Error('not found');
  const body = await readBody(req);

  if (path === '/api/start') {
    const folder = String(body.folder ?? '').trim();
    if (!folder) throw new Error('choose a project folder first');
    if (!existsSync(folder)) throw new Error(`the folder ${folder} does not exist`);
    const overrides: Partial<Config> = {};
    const checks = String(body.verify ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (checks.length) overrides.verifyCommands = checks;
    if (body.leadModel) overrides.leadModel = String(body.leadModel);
    if (body.maxAttempts) overrides.maxAttempts = Number(body.maxAttempts);
    if (body.leadEffort) overrides.leadEffort = String(body.leadEffort);
    if (body.allowCommands === true) overrides.executorSkipPermissions = true;
    if (body.confirmPlan === false) overrides.confirmPlan = false;
    if (body.takeover === false) overrides.takeover = false;
    if (body.mode === 'open' || body.mode === 'closed') overrides.mode = body.mode;
    if (body.executorMinutes) {
      const minutes = Number(body.executorMinutes);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw new Error('the time limit must be between 5 and 240 minutes');
      overrides.executorTimeoutMs = minutes * 60 * 1000;
    }
    if (typeof body.executorWorkers === 'string') {
      if (body.executorWorkers && !WORKER_MODELS.includes(body.executorWorkers)) throw new Error(`"${body.executorWorkers}" is not a worker model`);
      overrides.executorWorkers = body.executorWorkers;
    }
    const started = await launch((hooks) =>
      startRun({ folder, request: String(body.request ?? ''), overrides, attachments: decodeFiles(body.files), ...hooks }),
    );
    rememberFolder(started.repo);
    return started;
  }

  for (const p of ['/api/resume', '/api/retry', '/api/followup']) {
    if (path === p && active.has(keyOf(String(body.repo ?? ''), String(body.id ?? '')))) {
      throw new Error('this run is already being worked on; it can only run once at a time');
    }
  }

  if (path === '/api/resume') {
    const repo = String(body.repo ?? '');
    return launch((hooks) => resumeRun({ folder: repo, runId: String(body.id ?? ''), ...hooks }));
  }

  if (path === '/api/project') {
    const folder = String(body.folder ?? '').trim();
    if (!folder || !existsSync(folder)) throw new Error(`the folder ${folder} does not exist`);
    rememberFolder(folder);
    return { ok: true };
  }

  if (path === '/api/followup') {
    const repo = String(body.repo ?? '');
    return launch((hooks) =>
      followUpRun({ folder: repo, runId: String(body.id ?? ''), request: String(body.text ?? ''), files: decodeFiles(body.files), ...hooks }),
    );
  }

  if (path === '/api/retry') {
    const repo = String(body.repo ?? '');
    const checks = typeof body.checks === 'string' ? body.checks.split('\n').map((l) => l.trim()).filter(Boolean) : undefined;
    return launch((hooks) => retryRun({ folder: repo, runId: String(body.id ?? ''), checks, ...hooks }));
  }

  const run = active.get(keyOf(String(body.repo ?? ''), String(body.id ?? '')));

  if (path === '/api/options' || path === '/api/note') {
    const repo = String(body.repo ?? '');
    const id = String(body.id ?? '');
    const state = readState(repo, id);
    if (!state) throw new Error(`no run "${id}" here`);
    // A run marked running whose process is alive is being driven by another orc window;
    // messages and option changes still reach it through the run's folder.
    const drivenElsewhere = !run && state.status === 'running' && !isResumable(state);
    if (!run && !drivenElsewhere && !isResumable(state) && state.status !== 'needs_human' && state.status !== 'passed') throw new Error('this run has ended, so it can no longer be changed');
    if (path === '/api/note') {
      const text = String(body.text ?? '');
      const files = decodeFiles(body.files);
      // While the lead waits on questions, a message would sit unread until its next step,
      // which never comes. So a message sent then is the answer.
      if (run?.pending && text.trim()) {
        const pending = run.pending;
        run.pending = undefined;
        pending.resolve(pending.questions.map((_, i) => (i === 0 ? text : 'See my first answer.')));
        if (files.length) postNote(repo, id, 'Files for my answer above.', files);
        return { ok: true, live: true, answered: true };
      }
      postNote(repo, id, text, files);
      return { ok: true, live: Boolean(run) };
    }
    const change: Record<string, unknown> = {};
    if (typeof body.leadModel === 'string') change.leadModel = body.leadModel;
    if (typeof body.leadEffort === 'string') change.leadEffort = body.leadEffort;
    if (typeof body.executorSkipPermissions === 'boolean') change.executorSkipPermissions = body.executorSkipPermissions;
    if (body.executorMinutes !== undefined) change.executorMinutes = Number(body.executorMinutes);
    if (typeof body.executorWorkers === 'string') change.executorWorkers = body.executorWorkers;
    if (typeof body.takeover === 'boolean') change.takeover = body.takeover;
    if (typeof body.mode === 'string') change.mode = body.mode;
    const settings = updateRunOptions(repo, id, change, run?.settings);
    return { options: currentOptions(settings), live: Boolean(run) };
  }

  if (path === '/api/answer') {
    if (!run?.pending) throw new Error('this run is not waiting for an answer');
    const answers = Array.isArray(body.answers) ? body.answers.map((a: unknown) => String(a ?? '')) : [];
    const pending = run.pending;
    run.pending = undefined;
    pending.resolve(pending.questions.map((_, i) => answers[i] ?? ''));
    return { ok: true };
  }

  if (path === '/api/stop') {
    if (run) {
      stopRun(run);
      return { ok: true };
    }
    const repo = String(body.repo ?? '');
    const id = String(body.id ?? '');
    const state = readState(repo, id);
    if (!state || state.status !== 'running' || isResumable(state)) throw new Error('this run is not going right now');
    requestStop(repo, id);
    return { ok: true, elsewhere: true };
  }

  throw new Error('not found');
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // the address is printed as well, so a failed launch is not fatal
  }
}

export interface UiOptions {
  port?: number;
  open?: boolean;
}

/**
 * Serves the GUI on this machine only. The page costs no model tokens: it shows the
 * run log orc already writes and passes the user's answers back.
 */
export async function startUi(opts: UiOptions = {}): Promise<string> {
  // A second orc window would quietly take the next port and confuse which page drives a run,
  // so if orc is already open, just bring up that page instead.
  if (!opts.port) {
    try {
      // Several may be open (orc moves to the next port when one is taken); open the newest.
      const found: string[] = [];
      for (let p = 47517; p < 47528; p++) {
        try {
          const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(700) });
          if (res.ok && (await res.text()).includes('<title>orc</title>')) found.push(`http://127.0.0.1:${p}/`);
        } catch {
          // nothing on this port
        }
      }
      if (found.length) {
        const url = found[found.length - 1];
        console.log(`orc is already open at ${url} in another window. Opening that page.`);
        if (found.length > 1) console.log(`Other orc windows are also open (${found.slice(0, -1).join(', ')}); close the ones you don't use.`);
        console.log('(If you just updated orc, close those windows first, then start orc again.)');
        if (opts.open !== false) openBrowser(url);
        process.exit(0);
      }
    } catch {
      // nothing there: carry on and start
    }
  }

  // The token stops other pages open in the browser from driving this server.
  const token = randomBytes(18).toString('hex');
  let port = opts.port ?? 47517;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const host = String(req.headers.host ?? '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return send(res, 403, { error: 'forbidden' });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const html = readFileSync(PAGE, 'utf8').replace('__ORC_TOKEN__', token);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (req.headers['x-orc-token'] !== token) return send(res, 403, { error: 'forbidden' });
      send(res, 200, await api(url.pathname, req.method ?? 'GET', url.searchParams, req));
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
  });

  // Windows reserves blocks of ports for Hyper-V and WSL (EACCES), and they move after a
  // reboot, so without an explicit --port orc tries a few and then lets Windows pick one.
  await new Promise<void>((ready, fail) => {
    let tries = 0;
    server.on('error', (err: NodeJS.ErrnoException) => {
      const blocked = err.code === 'EADDRINUSE' || err.code === 'EACCES';
      if (blocked && !opts.port && tries < 10) {
        tries += 1;
        port = tries < 10 ? port + 1 : 0;
        server.listen(port, '127.0.0.1');
      } else if (err.code === 'EACCES') {
        fail(new Error(`Windows does not allow port ${port} (it is reserved). Leave out --port, or pick another.`));
      } else {
        fail(new Error(err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message));
      }
    });
    server.on('listening', () => {
      const address = server.address();
      if (address && typeof address === 'object') port = address.port;
      ready();
    });
    server.listen(port, '127.0.0.1');
  });

  // One bad request or a fault inside a run must not take the whole GUI down with it.
  const survive = (kind: string) => (err: unknown): void => {
    const text = `${new Date().toISOString()} ${kind}: ${(err as Error)?.stack ?? String(err)}\n`;
    console.error(text);
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(join(dataDir, 'ui-errors.log'), text);
    } catch {
      // logging is best effort
    }
  };
  process.on('uncaughtException', survive('uncaught exception'));
  process.on('unhandledRejection', survive('unhandled rejection'));

  // Closing the window or pressing Ctrl+C must not leave runs looking alive.
  // Stop requests can come from any orc window, through the run's folder.
  setInterval(() => {
    for (const run of active.values()) {
      if (run.runId && takeStopRequest(run.repo, run.runId)) stopRun(run);
    }
  }, 2000).unref();

  const shutdown = (): void => {
    for (const run of active.values()) {
      stopRun(run);
      markPaused(run.repo, run.runId, 'the orc window was closed');
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  const url = `http://127.0.0.1:${port}/`;
  console.log(`orc is open at ${url}`);
  console.log('Keep this window open while you use it. Close it, or press Ctrl+C, to stop.');
  if (opts.open !== false) openBrowser(url);
  return url;
}
