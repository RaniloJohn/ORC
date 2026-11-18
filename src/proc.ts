import { spawn, spawnSync } from 'node:child_process';

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The caller's stop signal fired and the process was killed. */
  stopped: boolean;
}

/** The message every stopped call fails with, so callers can tell a stop from a fault. */
export const STOPPED = 'stopped by you';

export interface ProcOptions {
  cwd: string;
  stdin?: string;
  /** Needed for .cmd shims (npm-installed CLIs) and for user shell commands. */
  shell?: boolean;
  timeoutMs?: number;
  /** Called with each complete line of stdout as it arrives, for live progress. */
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Runs a process to completion and captures its output.
 * With shell: true the args are joined unquoted, so callers must pass only
 * fixed flags there and send anything free-form through stdin.
 */
export function run(command: string, args: string[], opts: ProcOptions): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = opts.shell
      ? spawn([command, ...args].join(' '), { cwd: opts.cwd, shell: true, windowsHide: true })
      : spawn(command, args, { cwd: opts.cwd, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopped = false;
    const onAbort = (): void => {
      stopped = true;
      killTree(child.pid);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : undefined;

    let pending = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (!opts.onLine) return;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        try {
          opts.onLine(line);
        } catch {
          // progress reporting must never break the run
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`could not start "${command}": ${err.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, stopped });
    });

    child.stdin.on('error', () => {
      // the process may exit before reading stdin; the close handler reports the outcome
    });
    child.stdin.end(opts.stdin ?? '');
  });
}

export function tail(text: string, max = 1500): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `...${trimmed.slice(-max)}`;
}
