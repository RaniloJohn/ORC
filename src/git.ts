import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { run, tail } from './proc.ts';
import type { Workspace } from './types.ts';

async function git(cwd: string, args: string[], okCodes: number[] = [0]): Promise<{ code: number | null; out: string }> {
  const res = await run('git', args, { cwd });
  if (!okCodes.includes(res.code ?? -1)) {
    throw new Error(`git ${args[0]} failed: ${tail(res.stderr || res.stdout, 600)}`);
  }
  return { code: res.code, out: res.stdout.trim() };
}

const IDENTITY = ['-c', 'user.name=orc', '-c', 'user.email=orc@localhost'];

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Finds the repository a folder belongs to, for commands that only read past runs. */
export async function repoRoot(path: string): Promise<string> {
  const res = existsSync(path)
    ? await run('git', ['rev-parse', '--show-toplevel'], { cwd: path })
    : { code: 1, stdout: '' };
  if (res.code !== 0) throw new Error(`there are no orc runs in ${path}`);
  return resolve(res.stdout.trim());
}

export interface RepoInfo {
  root: string;
  /** orc set this folder's git up itself, so it also commits and merges on the user's behalf. */
  managed: boolean;
  /** The repository was created just now. */
  created: boolean;
}

/**
 * Makes a folder ready for a run. A folder with no git gets a repository of its own,
 * marked as managed by orc, so the user never has to run a git command. A repository
 * the user already keeps is left exactly as it is.
 */
export async function prepareRepo(path: string): Promise<RepoInfo> {
  if (!existsSync(path)) throw new Error(`the folder ${path} does not exist`);
  const target = resolve(path);
  if (samePath(target, homedir())) {
    throw new Error(
      `${target} is your home folder, not a project. Go to the project folder first ` +
        '(in Command Prompt: cd /d D:\\Projects\\YourProject) or add --repo <folder>.',
    );
  }

  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: target });
  let root = top.code === 0 ? resolve(top.stdout.trim()) : undefined;
  if (root && !samePath(root, target)) {
    // The folder sits inside a larger repository. Use that repository only if it really
    // tracks this folder; a home folder that happens to be a repository, or an unrelated
    // parent, must not be picked up by accident.
    const tracked = await run('git', ['ls-files', '--', '.'], { cwd: target });
    if (samePath(root, homedir()) || tracked.stdout.trim() === '') root = undefined;
  }

  let created = false;
  if (!root) {
    await git(target, ['init', '-q']);
    await git(target, ['config', 'orc.managed', 'true']);
    root = target;
    created = true;
  }

  const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root });
  if (head.code !== 0) {
    // A repository with no commits has no history of the user's to respect, so orc adopts it.
    await git(root, ['config', 'orc.managed', 'true']);
    await excludeOrchestratorDir(root);
    await git(root, ['add', '-A']);
    await git(root, [...IDENTITY, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'orc: starting point']);
  }
  const flag = await run('git', ['config', '--get', 'orc.managed'], { cwd: root });
  const managed = flag.stdout.trim() === 'true';
  return { root, managed, created };
}

/** In a managed folder, records the user's current files so the run starts from them. */
export async function snapshot(repo: string, runId: string): Promise<boolean> {
  await excludeOrchestratorDir(repo);
  await git(repo, ['add', '-A']);
  const staged = await git(repo, ['diff', '--cached', '--quiet'], [0, 1]);
  if (staged.code !== 1) return false;
  await git(repo, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', `orc: your files before run ${runId}`]);
  return true;
}

/**
 * Brings a passed run's work into the folder. Fast-forward only: if the folder has moved on
 * in a way that conflicts, nothing is changed and the caller tells the user.
 */
export async function applyRun(repo: string, ws: Workspace): Promise<boolean> {
  const merged = await run('git', ['merge', '--ff-only', '-q', ws.branch], { cwd: repo });
  if (merged.code !== 0) return false;
  // The worktree has served its purpose; the branch and the run record stay.
  await run('git', ['worktree', 'remove', '--force', ws.dir], { cwd: repo });
  return true;
}

export async function isDirty(repo: string): Promise<boolean> {
  return (await git(repo, ['status', '--porcelain'])).out !== '';
}

/** Keeps .orchestrator/ out of the user's git status without editing their .gitignore. */
async function excludeOrchestratorDir(repo: string): Promise<void> {
  let common = (await git(repo, ['rev-parse', '--git-common-dir'])).out;
  if (!isAbsolute(common)) common = join(repo, common);
  const file = join(common, 'info', 'exclude');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!current.split(/\r?\n/).includes('.orchestrator/')) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${current.endsWith('\n') || current === '' ? '' : '\n'}.orchestrator/\n`);
  }
}

/**
 * Gives the run its own worktree and branch, so nothing touches the user's
 * checked-out files or main branch until they merge it themselves.
 */
export async function createWorkspace(repo: string, runId: string): Promise<Workspace> {
  await excludeOrchestratorDir(repo);
  const dir = join(repo, '.orchestrator', 'worktrees', runId);
  const branch = `orc/${runId}`;
  mkdirSync(dirname(dir), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  return workspaceAt(dir, branch);
}

/** Reopens the worktree of an earlier run so it can be continued. */
/** True when the run still has a real working copy (a folder git removed can be left behind empty). */
export function hasWorkspace(repo: string, runId: string, at?: string): boolean {
  return existsSync(join(at || join(repo, '.orchestrator', 'worktrees', runId), '.git'));
}

export function openWorkspace(repo: string, runId: string, at?: string): Workspace {
  const dir = at || join(repo, '.orchestrator', 'worktrees', runId);
  if (!hasWorkspace(repo, runId, dir)) {
    throw new Error(`the working copy for run ${runId} is gone, so it cannot be continued`);
  }
  return workspaceAt(dir, `orc/${runId}`);
}

/**
 * Gives a finished run a working copy again, for a new request. Its work is already in the
 * folder, so the copy starts from the folder's latest commit, including anything the user
 * changed since.
 */
export async function reviveWorkspace(repo: string, runId: string, at?: string): Promise<Workspace> {
  if (at && hasWorkspace(repo, runId, at)) return openWorkspace(repo, runId, at);
  const home = join(repo, '.orchestrator', 'worktrees', runId);
  if (hasWorkspace(repo, runId, home)) return openWorkspace(repo, runId, home);
  // Whatever is left in the folder is not a working copy: an empty folder goes, anything else is
  // set aside. If another program holds it open, the copy goes in a new folder instead.
  let dir = home;
  for (let n = 2; existsSync(dir); n++) {
    try {
      rmdirSync(dir);
    } catch {
      try {
        renameSync(dir, `${dir}.old-${Date.now()}`);
      } catch {
        dir = `${home}-${n}`;
      }
    }
  }
  await excludeOrchestratorDir(repo);
  await git(repo, ['worktree', 'prune']);
  mkdirSync(dirname(dir), { recursive: true });
  await git(repo, ['worktree', 'add', '-B', `orc/${runId}`, dir, 'HEAD']);
  return workspaceAt(dir, `orc/${runId}`);
}

function workspaceAt(dir: string, branch: string): Workspace {
  return {
    async reset() {
      await git(dir, ['reset', '--hard', '-q', 'HEAD']);
      await git(dir, ['clean', '-fdq']);
    },
    dir,
    branch,
    async head() {
      return (await git(dir, ['rev-parse', 'HEAD'])).out;
    },
    async checkpoint(message) {
      await git(dir, ['add', '-A']);
      const staged = await git(dir, ['diff', '--cached', '--quiet'], [0, 1]);
      if (staged.code === 1) {
        await git(dir, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', message]);
      }
      return (await git(dir, ['rev-parse', 'HEAD'])).out;
    },
    async diff(base) {
      return (await git(dir, ['diff', base, 'HEAD'])).out;
    },
    async changedFiles(base) {
      const out = (await git(dir, ['diff', '--name-only', base, 'HEAD'])).out;
      return out ? out.split(/\r?\n/) : [];
    },
    async read(path) {
      const file = resolve(dir, path);
      if (!file.startsWith(resolve(dir)) || !existsSync(file)) return null;
      try {
        const text = readFileSync(file, 'utf8');
        return text.includes('\u0000') ? null : text;
      } catch {
        return null;
      }
    },
  };
}
