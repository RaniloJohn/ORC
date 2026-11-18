import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { run, STOPPED, tail } from '../proc.ts';
import type { AgentResult, Config, Executor, ExecutorRequest } from '../types.ts';

// Windows caps a command line at about 32k characters; longer prompts go through a file.
const MAX_INLINE_PROMPT = 20000;

function shortPath(path: unknown, cwd: string): string {
  if (typeof path !== 'string' || !path) return '';
  const rel = relative(cwd, path);
  // The user's attachments live outside the project; name them by file rather than full path.
  const attached = /[\\/]attachments[\\/]([^\\/]+)$/.exec(path);
  if (rel.startsWith('..') && attached) return `attached file ${attached[1].replace(/^msg\d+-/, '')}`;
  return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : path;
}

/** One line describing an agy tool step, or undefined for steps not worth showing. */
export function describeStep(name: string, params: Record<string, any>, cwd: string): string | undefined {
  const path = shortPath(params.Path ?? params.path ?? params.TargetFile ?? params.AbsolutePath, cwd);
  const n = name.toLowerCase();
  if (n === 'exit_plan_mode') return 'finished planning its approach';
  if (n.includes('read') || n.includes('view')) return `reading ${path || 'a file'}`;
  if (n.includes('write') || n.includes('edit') || n.includes('replace') || n.includes('create')) {
    return `writing ${path || 'a file'}`;
  }
  if (n.includes('command') || n.includes('shell') || n.includes('terminal')) {
    const cmd = String(params.CommandLine ?? params.command ?? params.Command ?? '').slice(0, 80);
    return `running ${cmd || 'a command'}`;
  }
  if (n.includes('list') || n.includes('find') || n.includes('search') || n.includes('grep')) {
    return `looking through ${path || 'the project'}`;
  }
  return `using ${name}`;
}

const isUsageLimit = (text: string): boolean => /rate.?limit|quota|exhausted|too many requests|\b429\b/i.test(text);

/**
 * Gemini through the Antigravity CLI, on the signed-in Google account. Output is streamed as
 * JSON lines so each step can be shown as it happens. Argon writes the code by default; with
 * Hydrogen workers on, each worker is its own agy session on the Hydrogen model, all run at once.
 */
export function agyExecutor(cfg: Config): Executor {
  /** One agy session from prompt to result. */
  async function session(
    req: ExecutorRequest,
    model: string,
    rawPrompt: string,
    promptFile: string,
    onActivity?: (text: string) => void,
    sessionId?: string,
  ): Promise<AgentResult> {
    const args: string[] = [];
    if (sessionId) args.push('--conversation', sessionId);
    // Without full access, agy refuses every shell command in this mode and ends the
    // session on the first refusal, so the model must be told up front to only edit files.
    let prompt = cfg.executorSkipPermissions
      ? rawPrompt
      : `IMPORTANT: in this session you cannot run shell commands or use the terminal. Any attempt ends your session immediately and your work is lost. Only read, create and edit files. Do not try to install, build, run or test anything; just write the code.

${rawPrompt}`;
    if (prompt.length > MAX_INLINE_PROMPT) {
      const file = join(req.runDir, promptFile);
      writeFileSync(file, prompt);
      prompt = `Read the file at ${file} and carry out the instructions in it exactly.`;
      args.push('--add-dir', req.runDir);
    }
    if (req.attachDir && existsSync(req.attachDir) && readdirSync(req.attachDir).length) {
      args.push('--add-dir', req.attachDir);
    }
    const minutes = Math.max(1, Math.round(cfg.executorTimeoutMs / 60000));
    args.push(
      '-p', prompt,
      '--model', model,
      '--output-format', 'stream-json',
      '--print-timeout', `${minutes}m`,
      ...(cfg.executorSkipPermissions ? ['--dangerously-skip-permissions'] : ['--mode', 'accept-edits']),
    );

    let out: Record<string, any> | undefined;
    let spoken = '';
    let spokenStep = -1;
    const stepText = new Map<number, string>();
    const blocked: string[] = [];
    // agy is a real .exe, so no shell is involved and the prompt is passed as one argument.
    const res = await run('agy', args, {
      cwd: req.cwd,
      timeoutMs: cfg.executorTimeoutMs + 60000,
      signal: req.signal,
      onLine(line) {
        if (!line.trim().startsWith('{')) return;
        const msg = JSON.parse(line) as Record<string, any>;
        if (msg.event === 'result') {
          out = msg.result;
          return;
        }
        if (msg.event !== 'step_update') return;
        const step = msg.step_update ?? {};
        // The closing message arrives in pieces; keep it in case the result omits it.
        if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
          if (step.step_index !== spokenStep) {
            spokenStep = step.step_index;
            spoken = '';
          }
          spoken += step.text_delta;
        }
        if (step.step_type === 'tool' && step.state === 'ACTIVE') {
          const text = describeStep(String(step.tool_name ?? ''), step.tool_info?.parameters ?? {}, req.cwd);
          if (text) {
            stepText.set(step.step_index, text);
            onActivity?.(text);
          }
        }
        // Long thinking produces no tool steps, so say so; otherwise the run looks frozen.
        if (step.step_type === 'agent_response' && step.state === 'DONE' && Number(step.duration_seconds) >= 15) {
          const secs = Math.round(Number(step.duration_seconds));
          onActivity?.(`thought for ${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}`);
        }
        if (step.step_type === 'tool' && step.state === 'ERROR') {
          const name = String(step.tool_name ?? '').toLowerCase();
          if (name.includes('command') || name.includes('shell') || name.includes('terminal')) {
            const text = stepText.get(step.step_index) ?? 'running a command';
            blocked.push(text.replace(/^running /, ''));
            onActivity?.(`was not allowed: ${text}`);
          }
        }
      },
    });
    if (res.stopped) throw new Error(STOPPED);
    if (res.timedOut) throw new Error('executor (agy) timed out');

    if (!out) {
      for (const line of res.stdout.split('\n').reverse()) {
        try {
          const msg = JSON.parse(line);
          if (msg?.event === 'result') {
            out = msg.result;
            break;
          }
        } catch {
          // not a JSON line
        }
      }
    }
    if (!out) {
      throw new Error(`executor (agy) returned no result (exit ${res.code}): ${tail(res.stderr || res.stdout)}`);
    }
    let endedEarly: string | undefined;
    if (out.status !== 'SUCCESS') {
      const detail = tail(String(out.error ?? out.response ?? '') || res.stderr, 400);
      // A usage limit stops the run so it can be continued later; anything else is kept as an
      // unfinished attempt, so whatever was already written is reviewed rather than thrown away.
      if (isUsageLimit(detail)) throw new Error(`executor (agy) hit a usage limit: ${detail}`);
      const timedOut = /timeout|timed out/i.test(`${detail} ${res.stderr}`) || res.stdout.length > 0;
      endedEarly = timedOut && !detail
        ? `it ran out of time (${minutes} minutes) before finishing`
        : `agy ended the run early (${out.status}${detail ? `: ${detail}` : ''})`;
    }

    const u = out.usage ?? {};
    return {
      text: String(out.response ?? '').trim() || spoken.trim(),
      sessionId: typeof out.conversation_id === 'string' ? out.conversation_id : undefined,
      inputTokens: u.input_tokens ?? 0,
      cachedTokens: u.cache_read_tokens ?? 0,
      outputTokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0),
      model,
      blocked,
      endedEarly,
    };
  }

  return {
    async run(req): Promise<AgentResult> {
      const workers = cfg.executorWorkers && req.workers?.length ? req.workers : undefined;
      if (!workers) {
        const model = req.model || cfg.executorModel;
        if (!req.sessionId) return session(req, model, req.prompt, 'executor-prompt.md', req.onActivity);
        try {
          return await session(req, model, req.prompt, 'executor-prompt.md', req.onActivity, req.sessionId);
        } catch (err) {
          const message = (err as Error).message;
          if (message === STOPPED || isUsageLimit(message) || !req.freshPrompt) throw err;
          // The earlier conversation could not be continued: start afresh with the full prompt.
          req.onActivity?.('could not continue its earlier session, starting a new one');
          return session(req, model, req.freshPrompt, 'executor-prompt.md', req.onActivity);
        }
      }

      const model = cfg.executorWorkers as string;
      const settled = await Promise.allSettled(
        workers.map(async (w, i) => {
          const say = (text: string): void => req.onActivity?.(`${w.label}: ${text}`);
          if (!w.sessionId) return session(req, model, w.prompt, `worker${i + 1}-prompt.md`, say);
          try {
            return await session(req, model, w.prompt, `worker${i + 1}-prompt.md`, say, w.sessionId);
          } catch (err) {
            const message = (err as Error).message;
            if (message === STOPPED || isUsageLimit(message) || !w.freshPrompt) throw err;
            // The earlier conversation could not be continued: start this worker afresh.
            say('could not continue its earlier session, starting a new one');
            return session(req, model, w.freshPrompt, `worker${i + 1}-prompt.md`, say);
          }
        }),
      );
      const failures = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as Error] : []));
      // A stop or a usage limit ends the attempt for everyone; other failures are reported to the
      // lead along with whatever the remaining workers wrote.
      const fatal = failures.find((e) => e.message === STOPPED) ?? failures.find((e) => isUsageLimit(e.message));
      if (fatal) throw fatal;
      if (failures.length === workers.length) throw failures[0];

      const reports: string[] = [];
      const ended: string[] = [];
      const total = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
      const blocked: string[] = [];
      const sessions: Record<string, string> = {};
      settled.forEach((s, i) => {
        const label = workers[i].label;
        if (s.status === 'rejected') {
          reports.push(`${label}: did not finish (${(s.reason as Error).message})`);
          ended.push(`${label} failed`);
          return;
        }
        const r = s.value;
        if (workers[i].key && r.sessionId) sessions[workers[i].key!] = r.sessionId;
        reports.push(`${label}:\n${r.text || '(no report)'}`);
        if (r.endedEarly) ended.push(`${label}: ${r.endedEarly}`);
        total.inputTokens += r.inputTokens;
        total.cachedTokens += r.cachedTokens;
        total.outputTokens += r.outputTokens;
        blocked.push(...(r.blocked ?? []));
      });
      return {
        text: reports.join('\n\n'),
        ...total,
        model: `${model} ×${workers.length}`,
        blocked,
        sessions,
        endedEarly: ended.length ? ended.join('; ') : undefined,
      };
    },
  };
}
