#!/usr/bin/env node
// Apache-2.0
// Antigravity local swarm plan.json sync helper.
//   node scripts/agy-swarm-sync.mjs --swarm-dir <dir> [--plan-json <file>]
//
// Reads a SwarmControlViewV1 (or direct plan) JSON payload from --plan-json or
// stdin, validates goal.title (4-8 words), goal.line (<=12 words), tasks, and
// threads (1-6 items), and atomically writes <swarmDir>/plan.json via a
// same-directory temporary file + rename. Requires an explicit --swarm-dir and
// refuses any path containing a builtin directory segment.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printJson, refuse, UsageError } from './lib/workspace.mjs';

export const MIN_GOAL_TITLE_WORDS = 4;
export const MAX_GOAL_TITLE_WORDS = 8;
export const MAX_GOAL_LINE_WORDS = 12;
export const MIN_THREADS = 1;
export const MAX_THREADS = 6;

export class SwarmSyncError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function countWords(text) {
  if (typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function assertSafeSwarmDir(swarmDir) {
  if (typeof swarmDir !== 'string' || !swarmDir.trim()) {
    throw new UsageError('agy-swarm-sync.mjs requires an explicit --swarm-dir <dir>');
  }
  const resolved = resolve(swarmDir);
  const checkSegments = (p) => {
    const segments = p.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
    if (segments.includes('builtin')) {
      throw new SwarmSyncError('refusing to write inside a builtin directory', 'IA-SWARM-SYNC-BUILTIN-REFUSED');
    }
  };
  checkSegments(resolved);
  // Walk each existing component from deepest existing ancestor up to refuse symlinks and resolved builtin targets.
  const parts = resolved.split(/[\\/]/).filter(Boolean);
  let probe = resolved.startsWith('/') ? '/' : parts[0] + sep;
  const startIdx = resolved.startsWith('/') ? 0 : 1;
  for (let i = startIdx; i < parts.length; i++) {
    probe = join(probe, parts[i]);
    if (!existsSync(probe)) break;
    const stat = lstatSync(probe);
    if (stat.isSymbolicLink()) {
      throw new SwarmSyncError('--swarm-dir path must not traverse a symlink', 'IA-SWARM-SYNC-UNSAFE-DIR');
    }
    checkSegments(realpathSync(probe));
  }
  if (existsSync(resolved) && !lstatSync(resolved).isDirectory()) {
    throw new SwarmSyncError('--swarm-dir must be a non-symlink directory', 'IA-SWARM-SYNC-UNSAFE-DIR');
  }
  return resolved;
}

export function extractPlanSource(payload) {
  if (!isPlainObject(payload)) {
    throw new SwarmSyncError('input payload must be a JSON object', 'IA-SWARM-SYNC-INVALID-PLAN');
  }
  if (isPlainObject(payload.plan)) return payload.plan;
  if (isPlainObject(payload.overview)) return payload.overview;
  return payload;
}

export function validateSwarmPlan(payload) {
  const source = extractPlanSource(payload);

  if (!isPlainObject(source.goal)) {
    throw new SwarmSyncError('plan.goal must be an object with title and line', 'IA-SWARM-SYNC-INVALID-PLAN');
  }
  const title = typeof source.goal.title === 'string' ? source.goal.title.trim() : '';
  const titleWords = countWords(title);
  if (titleWords < MIN_GOAL_TITLE_WORDS || titleWords > MAX_GOAL_TITLE_WORDS) {
    throw new SwarmSyncError(`plan.goal.title must have ${MIN_GOAL_TITLE_WORDS} to ${MAX_GOAL_TITLE_WORDS} words (got ${titleWords})`, 'IA-SWARM-SYNC-INVALID-PLAN');
  }

  const line = typeof source.goal.line === 'string' ? source.goal.line.trim() : '';
  const lineWords = countWords(line);
  if (lineWords < 1 || lineWords > MAX_GOAL_LINE_WORDS) {
    throw new SwarmSyncError(`plan.goal.line must have 1 to ${MAX_GOAL_LINE_WORDS} words (got ${lineWords})`, 'IA-SWARM-SYNC-INVALID-PLAN');
  }

  let tasks;
  if (isPlainObject(source.tasks)) {
    tasks = {};
    for (const [workerName, label] of Object.entries(source.tasks)) {
      if (!workerName.trim() || typeof label !== 'string' || !label.trim()) {
        throw new SwarmSyncError(`plan.tasks["${workerName}"] must have a non-empty worker name and label`, 'IA-SWARM-SYNC-INVALID-PLAN');
      }
      tasks[workerName.trim()] = label.trim();
    }
  } else if (Array.isArray(source.checkpoints) || Array.isArray(source.roster)) {
    tasks = {};
    if (Array.isArray(source.checkpoints)) {
      for (const cp of source.checkpoints) {
        if (isPlainObject(cp) && typeof cp.id === 'string' && cp.id.trim() && typeof cp.title === 'string' && cp.title.trim()) {
          tasks[cp.id.trim()] = cp.title.trim();
        }
      }
    }
    if (Array.isArray(source.roster)) {
      for (const member of source.roster) {
        if (isPlainObject(member) && typeof member.name === 'string' && member.name.trim()) {
          const name = member.name.trim();
          const role = typeof member.role === 'string' && member.role.trim() ? member.role.trim() : name;
          if (!tasks[name]) tasks[name] = role;
        }
      }
    }
  } else {
    throw new SwarmSyncError('plan.tasks must be an object mapping worker names to short labels (or provide SwarmControlViewV1 checkpoints/roster)', 'IA-SWARM-SYNC-INVALID-PLAN');
  }

  if (!Array.isArray(source.threads) || source.threads.length < MIN_THREADS || source.threads.length > MAX_THREADS) {
    throw new SwarmSyncError(`plan.threads must contain ${MIN_THREADS} to ${MAX_THREADS} items`, 'IA-SWARM-SYNC-INVALID-PLAN');
  }
  const seenIds = new Set();
  const threads = [];
  for (let i = 0; i < source.threads.length; i++) {
    const item = source.threads[i];
    if (!isPlainObject(item)) {
      throw new SwarmSyncError(`plan.threads[${i}] must be an object`, 'IA-SWARM-SYNC-INVALID-PLAN');
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const threadTitle = typeof item.title === 'string' ? item.title.trim() : '';
    const threadGoal = typeof item.goal === 'string' ? item.goal.trim() : '';
    if (!id || !threadTitle || !threadGoal) {
      throw new SwarmSyncError(`plan.threads[${i}] requires non-empty id, title and goal`, 'IA-SWARM-SYNC-INVALID-PLAN');
    }
    if (seenIds.has(id)) {
      throw new SwarmSyncError(`duplicate thread id: ${id}`, 'IA-SWARM-SYNC-INVALID-PLAN');
    }
    seenIds.add(id);
    if (!Array.isArray(item.tasks) || item.tasks.length === 0 || !item.tasks.every(t => typeof t === 'string' && t.trim().length > 0)) {
      throw new SwarmSyncError(`plan.threads[${i}].tasks must be a non-empty array of worker names`, 'IA-SWARM-SYNC-INVALID-PLAN');
    }
    threads.push({
      id,
      title: threadTitle,
      goal: threadGoal,
      tasks: item.tasks.map(t => t.trim()),
    });
  }

  return {
    goal: { title, line },
    tasks,
    threads,
  };
}

export function syncSwarmPlan({ swarmDir, payload }) {
  const dir = assertSafeSwarmDir(swarmDir);
  const plan = validateSwarmPlan(payload);
  mkdirSync(dir, { recursive: true });
  const targetPath = join(dir, 'plan.json');
  if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
    throw new SwarmSyncError(`refusing to overwrite symlink: ${targetPath}`, 'IA-SWARM-SYNC-UNSAFE-PATH');
  }
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  const tempPath = join(dir, `.plan.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, targetPath);
  } catch (error) {
    try { rmSync(tempPath, { force: true }); } catch { /* ignore cleanup error */ }
    throw error;
  }
  const sha256 = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
  return {
    ok: true,
    path: targetPath.split(sep).join('/'),
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256,
    goal: plan.goal,
    taskCount: Object.keys(plan.tasks).length,
    threadCount: plan.threads.length,
  };
}

function readInputJson(planJsonPath) {
  let rawText;
  if (planJsonPath && planJsonPath !== '-') {
    let stat;
    try {
      stat = lstatSync(planJsonPath);
    } catch (error) {
      throw new UsageError(`--plan-json could not be read (${planJsonPath}): ${error.message}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new UsageError(`--plan-json must be a regular non-symlink file: ${planJsonPath}`);
    }
    rawText = readFileSync(planJsonPath, 'utf8');
  } else {
    rawText = readFileSync(0, 'utf8');
  }
  if (!rawText.trim()) {
    throw new UsageError('agy-swarm-sync.mjs received empty JSON input');
  }
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new SwarmSyncError(`input is not valid JSON: ${error.message}`, 'IA-SWARM-SYNC-INVALID-JSON');
  }
}

const SPEC = {
  'swarm-dir': 'value',
  'plan-json': 'value',
};

async function main() {
  const { options } = parseArgs(process.argv.slice(2), SPEC, { positionals: 0 });
  if (!options['swarm-dir']) {
    throw new UsageError('agy-swarm-sync.mjs requires --swarm-dir <dir>');
  }
  const payload = readInputJson(options['plan-json']);
  const result = syncSwarmPlan({ swarmDir: options['swarm-dir'], payload });
  printJson(result);
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    await main();
  } catch (error) {
    process.exit(refuse(error));
  }
}
