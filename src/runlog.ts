import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Log, OrcEvent, RunState } from './types.ts';

export function runsRoot(repo: string): string {
  return join(repo, '.orchestrator', 'runs');
}

/** Append-only event log plus a state snapshot, both under .orchestrator/runs/<id>/. */
export function createLog(repo: string, runId: string, listener?: (e: OrcEvent) => void): Log {
  const dir = join(runsRoot(repo), runId);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    emit(event) {
      const stamped = { ts: new Date().toISOString(), ...event };
      appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(stamped)}\n`);
      listener?.(stamped);
    },
    saveState(state) {
      writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
    },
    saveArtifact(name, content) {
      writeFileSync(join(dir, name), content);
    },
  };
}

export function listRuns(repo: string): RunState[] {
  const root = runsRoot(repo);
  if (!existsSync(root)) return [];
  const runs: RunState[] = [];
  for (const id of readdirSync(root).sort()) {
    const file = join(root, id, 'state.json');
    if (!existsSync(file)) continue;
    try {
      runs.push(JSON.parse(readFileSync(file, 'utf8')) as RunState);
    } catch {
      // a half-written state file is skipped rather than breaking the listing
    }
  }
  return runs;
}

export function readState(repo: string, runId: string): RunState | undefined {
  const file = join(runsRoot(repo), runId, 'state.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as RunState;
}

export function readArtifact(repo: string, runId: string, name: string): string | undefined {
  const file = join(runsRoot(repo), runId, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

export function readEvents(repo: string, runId: string): OrcEvent[] {
  const file = join(runsRoot(repo), runId, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as OrcEvent);
}
