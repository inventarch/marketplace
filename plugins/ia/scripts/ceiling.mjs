#!/usr/bin/env node
// The ceiling report over a workspace's work records:
//   node scripts/ceiling.mjs [--root <repo>] [--plan <identity>] [--task <identity>] [--json]
// Lists each task of the plan (ia next's plan, or --plan when the workspace has
// several) as clear, first layer (on a branch only), beyond the ceiling, or
// unknown (a record it depends on could not be read), with every provisional
// foundation it waits on. With --task, reports that task (in any plan) and
// exits 1 when it is beyond the ceiling and 2 when it is unknown, so it can
// gate starting work. Exit 2 also on bad usage or when IA refuses or fails;
// 0 otherwise.
import { resolve } from 'node:path';
import { ceilingReport, describe, nodeFromInspect } from './lib/ceiling.mjs';
import { resolveCli, runIa } from './lib/cli.mjs';

const args = process.argv.slice(2);
const OPTIONS = new Set(['--root', '--plan', '--task']);
for (let i = 0; i < args.length; i++) {
  if (OPTIONS.has(args[i])) { if (args[i + 1] === undefined || args[i + 1].startsWith('--')) usage(); i++; }
  else if (args[i] !== '--json') usage();
}
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(option('--root') ?? '.');
const plan = option('--plan');
const only = option('--task');
const asJson = args.includes('--json');
// One CLI read's time limit in milliseconds; the environment can shorten it (the method hooks do).
const READ_TIMEOUT_MS = Number(process.env.IA_CORE_METHOD_READ_TIMEOUT_MS) > 0 ? Number(process.env.IA_CORE_METHOD_READ_TIMEOUT_MS) : 180_000;

function usage() {
  process.stderr.write('usage: ceiling.mjs [--root <repo>] [--plan <identity>] [--task <identity>] [--json]\n');
  process.exit(2);
}

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }) + '\n');
  process.exit(2);
}

try {
  const cli = resolveCli(root);
  // A record that inspect does not return is null in the graph, so every task
  // that depends on it reports unknown instead of clear.
  const graph = {};
  const load = identity => {
    if (identity in graph) return graph[identity];
    const ran = runIa(root, ['inspect', identity], { cli, timeoutMs: READ_TIMEOUT_MS });
    const record = ran.code === 0 ? ran.json?.records?.find(r => r.identity === identity) : undefined;
    graph[identity] = record ? nodeFromInspect(record) : null;
    return graph[identity];
  };
  // Loads a task and everything its layer depends on: required decisions and
  // tasks (recursively), cited specs and the decisions grounding them.
  const loadTask = (identity, seen = new Set()) => {
    if (seen.has(identity)) return;
    seen.add(identity);
    const task = load(identity);
    if (!task) return;
    for (const target of task.requires) if (load(target)?.word === 'task') loadTask(target, seen);
    for (const target of task.cites) {
      const spec = load(target);
      if (spec?.word === 'spec') for (const ground of spec.groundedBy) load(ground);
    }
  };

  let taskIds;
  if (only) {
    taskIds = [only];
  } else {
    const next = runIa(root, ['next', ...(plan ? ['--seat', plan] : [])], { cli });
    if (!next.json?.ok) fail(`ia next refused: ${next.json?.message ?? next.stderr.trim()}${next.json?.next ? ` (next: ${next.json.next})` : ''}`);
    taskIds = next.json.view.tasks.map(t => t.identity);
  }
  for (const id of taskIds) loadTask(id);
  if (only && graph[only] && graph[only].word !== 'task') fail(`${only} is not a @task`);
  if (only && !graph[only]) fail(`${only} is not an admitted record in ${root}`);

  const report = ceilingReport(graph, taskIds);
  if (asJson) process.stdout.write(JSON.stringify({ root, ...report }, null, 2) + '\n');
  else {
    for (const entry of report.tasks) process.stdout.write(describe(entry) + '\n');
    const { clear, firstLayer, beyondCeiling, unknown } = report.counts;
    process.stdout.write(`${report.tasks.length} task(s): ${clear} clear, ${firstLayer} first layer, ${beyondCeiling} beyond the ceiling, ${unknown} unknown\n`);
  }
  if (only) process.exit({ 'beyond-ceiling': 1, unknown: 2 }[report.tasks[0].position] ?? 0);
} catch (error) {
  fail(`${error.code ?? error.name}: ${error.message}`);
}
