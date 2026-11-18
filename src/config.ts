import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './types.ts';

export const DEFAULTS: Config = {
  leadModel: 'opus',
  leadModels: {},
  executorModel: 'gemini-pro-orchestrator-g1-pro',
  maxAttempts: 3,
  verifyCommands: [],
  confirmPlan: true,
  allowArchitectCommands: false,
  executorSkipPermissions: false,
  leadTimeoutMs: 15 * 60 * 1000,
  executorTimeoutMs: 45 * 60 * 1000,
  executorWorkers: '',
  mode: 'closed',
  verifyTimeoutMs: 10 * 60 * 1000,
};

/** Defaults, then orc.config.json in the target repo, then command-line overrides. */
export function loadConfig(repo: string, overrides: Partial<Config>): Config {
  const file = join(repo, 'orc.config.json');
  let fromFile: Partial<Config> = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
    } catch (err) {
      throw new Error(`orc.config.json is not valid JSON: ${(err as Error).message}`);
    }
  }
  const cfg: Config = { ...DEFAULTS, ...fromFile, ...overrides };
  if (!Number.isInteger(cfg.maxAttempts) || cfg.maxAttempts < 1) {
    throw new Error('maxAttempts must be a whole number of at least 1');
  }
  if (cfg.mode !== 'closed' && cfg.mode !== 'open') throw new Error('mode must be "closed" or "open"');
  return cfg;
}
