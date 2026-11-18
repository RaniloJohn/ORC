import type { Plan, PlanReply, Verdict, WorkOrder } from './types.ts';

/** Pulls the JSON object out of a model reply that may wrap it in prose or a code fence. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  throw new Error('no valid JSON object found in the reply');
}

function obj(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`"${name}" must be a${allowEmpty ? '' : ' non-empty'} string`);
  }
  return value;
}

function strList(value: unknown, name: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`"${name}" must be an array of strings`);
  }
  if (!allowEmpty && value.length === 0) throw new Error(`"${name}" must not be empty`);
  return value as string[];
}

const questionList = (value: unknown): string[] =>
  strList(value ?? [], 'questions').map((q) => q.trim()).filter(Boolean);

/** A planning reply is either questions for the user or the plan itself. */
export function parsePlanReply(value: unknown): PlanReply {
  const o = obj(value, 'reply');
  const questions = questionList(o.questions);
  if (questions.length > 0 && o.tasks === undefined) return { questions };
  return parsePlan(value);
}

export function parsePlan(value: unknown): Plan {
  const o = obj(value, 'plan');
  if (!Array.isArray(o.tasks) || o.tasks.length === 0) {
    throw new Error('"tasks" must be a non-empty array');
  }
  return {
    assumptions: strList(o.assumptions ?? [], 'assumptions'),
    tasks: o.tasks.map((raw, i) => {
      const t = obj(raw, `tasks[${i}]`);
      return {
        id: typeof t.id === 'string' && t.id ? t.id : `T${i + 1}`,
        title: str(t.title, `tasks[${i}].title`),
        summary: str(t.summary, `tasks[${i}].summary`),
      };
    }),
  };
}

export function parseWorkOrder(value: unknown): WorkOrder {
  const o = obj(value, 'work order');
  return {
    goal: str(o.goal, 'goal'),
    files_in_scope: strList(o.files_in_scope ?? [], 'files_in_scope'),
    files_off_limits: strList(o.files_off_limits ?? [], 'files_off_limits'),
    steps: strList(o.steps, 'steps', false),
    acceptance_criteria: strList(o.acceptance_criteria, 'acceptance_criteria', false),
    verify_commands: strList(o.verify_commands ?? [], 'verify_commands'),
    ...(Array.isArray(o.assignments) && o.assignments.length
      ? {
          assignments: o.assignments.map((raw, i) => {
            const a = obj(raw, `assignments[${i}]`);
            return {
              files: strList(a.files, `assignments[${i}].files`, false),
              instructions: str(a.instructions ?? '', `assignments[${i}].instructions`, true),
            };
          }),
        }
      : {}),
  };
}

export function parseVerdict(value: unknown): Verdict {
  const o = obj(value, 'verdict');
  if (o.verdict !== 'pass' && o.verdict !== 'fail') {
    throw new Error('"verdict" must be "pass" or "fail"');
  }
  const issues = Array.isArray(o.issues) ? o.issues : [];
  const parsed: Verdict = {
    verdict: o.verdict,
    summary: str(o.summary ?? '', 'summary', true),
    issues: issues.map((raw, i) => {
      const it = obj(raw, `issues[${i}]`);
      return {
        file: str(it.file ?? '', `issues[${i}].file`, true),
        problem: str(it.problem, `issues[${i}].problem`),
        required_fix: str(it.required_fix ?? '', `issues[${i}].required_fix`, true),
      };
    }),
    questions: questionList(o.questions),
    next_instruction: str(o.next_instruction ?? '', 'next_instruction', true),
  };
  if (parsed.verdict === 'pass') parsed.questions = [];
  // A fail must either say what to do next or ask the user what they want.
  if (parsed.verdict === 'fail' && parsed.next_instruction.trim() === '' && parsed.questions.length === 0) {
    throw new Error('a "fail" verdict needs a non-empty "next_instruction" or some "questions"');
  }
  return parsed;
}
