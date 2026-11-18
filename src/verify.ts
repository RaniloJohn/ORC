import { run, tail } from './proc.ts';
import type { CheckResult, VerifyFn } from './types.ts';

/** Runs each verification command in the worktree. No model is involved in the result. */
export function shellVerify(timeoutMs: number): VerifyFn {
  return async (commands, cwd) => {
    const results: CheckResult[] = [];
    for (const command of commands) {
      const res = await run(command, [], { cwd, shell: true, timeoutMs });
      const output = tail(`${res.stdout}\n${res.stderr}`, 6000);
      results.push({
        command,
        ok: res.code === 0 && !res.timedOut,
        exitCode: res.code,
        output: res.timedOut ? `${output}\n[timed out]` : output,
      });
    }
    return results;
  };
}
