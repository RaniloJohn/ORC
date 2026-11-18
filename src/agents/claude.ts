import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, STOPPED, tail } from '../proc.ts';
import type { AgentResult, Config, Lead, PlanLimits } from '../types.ts';

const ESCALATION_TIMEOUT_MS = 45 * 60 * 1000;

const TOOLS = {
  none: '""',
  read: 'Read,Grep,Glob',
  write: 'Read,Grep,Glob,Edit,Write',
};

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const SYSTEM_PROMPT_FILE = fileURLToPath(new URL('../lead-system-prompt.txt', import.meta.url));

function shortPath(path: unknown, cwd: string): string {
  if (typeof path !== 'string' || !path) return 'a file';
  const rel = relative(cwd, path);
  // The user's attachments live outside the project; name them by file rather than full path.
  const attached = /[\\/]attachments[\\/]([^\\/]+)$/.exec(path);
  if (rel.startsWith('..') && attached) return `attached file ${attached[1].replace(/^msg\d+-/, '')}`;
  return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : path;
}

/**
 * The model that did the work. Claude Code also lists a small helper model it uses for
 * housekeeping, so the one that wrote the most output is the lead.
 */
function mainModel(modelUsage: Record<string, any> | undefined): string | undefined {
  let best: string | undefined;
  let most = -1;
  for (const [name, use] of Object.entries(modelUsage ?? {})) {
    const out = Number(use?.outputTokens ?? 0);
    if (out > most) {
      most = out;
      best = name;
    }
  }
  return best;
}

/** One line describing a tool call, in words a person watching the run can follow. */
function describeTool(name: string, input: Record<string, any>, cwd: string): string {
  switch (name) {
    case 'Read':
      return `reading ${shortPath(input.file_path, cwd)}`;
    case 'Grep':
      return `searching for "${String(input.pattern ?? '').slice(0, 60)}"`;
    case 'Glob':
      return `listing files matching ${input.pattern ?? '*'}`;
    case 'Edit':
      return `editing ${shortPath(input.file_path, cwd)}`;
    case 'Write':
      return `writing ${shortPath(input.file_path, cwd)}`;
    default:
      return `using ${name}`;
  }
}

/**
 * The lead Claude model (Opus, Fable, or any other) through the installed Claude Code CLI
 * in headless mode, on the signed-in plan. The prompt goes in on stdin, so only fixed
 * flags ever reach the shell.
 *
 * The session is deliberately stripped: no MCP connectors, no skills, and a short system
 * prompt of our own. Measured on a trivial prompt, the default setup sent about 112k
 * tokens of context per request; stripped, it is under 4k.
 *
 * Output is streamed as JSON lines so each tool call can be shown as it happens.
 */
export function claudeLead(cfg: Config): Lead {
  return {
    async ask(req): Promise<AgentResult> {
      const model = cfg.leadModels[req.role] ?? cfg.leadModel;
      if (!/^[\w.\-[\]]+$/.test(model)) throw new Error(`"${model}" is not a valid model name`);
      const who = `lead (${model}, ${req.role})`;

      const args = [
        '-p',
        '--model', model,
        '--output-format', 'stream-json',
        '--verbose',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--system-prompt-file', `"${SYSTEM_PROMPT_FILE}"`,
        '--tools', TOOLS[req.tools],
      ];
      for (const dir of req.addDirs ?? []) args.push('--add-dir', `"${dir}"`);
      if (cfg.leadEffort) {
        if (!EFFORTS.includes(cfg.leadEffort)) throw new Error(`"${cfg.leadEffort}" is not a thinking level`);
        args.push('--effort', cfg.leadEffort);
      }
      if (req.tools === 'write') args.push('--permission-mode', 'acceptEdits');
      if (req.sessionId) args.push('--resume', req.sessionId);
      if (req.sessionId && req.fork) args.push('--fork-session');

      let out: Record<string, any> | undefined;
      let planLimits: PlanLimits | undefined;
      const res = await run('claude', args, {
        cwd: req.cwd,
        stdin: req.prompt,
        shell: true,
        // Taking over a task means writing a whole task's fixes, so it gets far longer than a plan or review.
        timeoutMs: req.role === 'escalation' ? Math.max(cfg.leadTimeoutMs, ESCALATION_TIMEOUT_MS) : cfg.leadTimeoutMs,
        signal: req.signal,
        onLine(line) {
          if (!line.trim().startsWith('{')) return;
          const msg = JSON.parse(line) as Record<string, any>;
          // Known from the first line, so the conversation can be saved before a cut-off loses it.
          if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') req.onSession?.(msg.session_id);
          if (msg.type === 'result') {
            out = msg;
          } else if (msg.type === 'assistant') {
            for (const block of msg.message?.content ?? []) {
              if (block.type === 'tool_use') req.onActivity?.(describeTool(block.name, block.input ?? {}, req.cwd));
            }
          } else if (msg.type === 'rate_limit_event') {
            const w = msg.rate_limit_info?.unifiedWindows ?? {};
            planLimits = {
              fiveHour: w.five_hour?.utilization,
              sevenDay: w.seven_day?.utilization,
              resetsAt: w.five_hour?.resetsAt ?? msg.rate_limit_info?.resetsAt,
            };
          }
        },
      });
      if (res.stopped) throw new Error(STOPPED);
      if (res.timedOut) throw new Error(`${who} timed out`);

      if (!out) {
        // The result is normally the last line; fall back to scanning in case it was not newline-terminated.
        for (const line of res.stdout.split('\n').reverse()) {
          try {
            const msg = JSON.parse(line);
            if (msg?.type === 'result') {
              out = msg;
              break;
            }
          } catch {
            // not a JSON line
          }
        }
      }
      if (!out) {
        throw new Error(`${who} returned no result (exit ${res.code}): ${tail(res.stderr || res.stdout)}`);
      }
      if (out.is_error || res.code !== 0) {
        throw new Error(`${who} failed: ${tail(String(out.result ?? res.stderr))}`);
      }

      const u = out.usage ?? {};
      return {
        text: String(out.result ?? ''),
        sessionId: typeof out.session_id === 'string' ? out.session_id : undefined,
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cachedTokens: u.cache_read_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        planLimits,
        model: mainModel(out.modelUsage),
      };
    },
  };
}
