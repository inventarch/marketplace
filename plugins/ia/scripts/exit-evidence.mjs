#!/usr/bin/env node
// The exit-evidence report over a workspace's work records:
//   node scripts/exit-evidence.mjs [--root <repo>] [--plan <identity>] [--task <identity>] [--json]
// Lists each closed task of the plan (ia next's plan, or --plan when the
// workspace has several) as evidenced, exempt, refused, inconclusive, stale,
// no evidence or unknown, from the @observation records that name it
// (principle method-claims-within-evidence; decision public-method-report-gate).
// It is advisory. Exit 0 whenever it produced a report, findings included:
// exit 0 does not mean evidenced, so read the first word of each line. With
// --task it reports that task (in any plan) and exits 2 when the task reads
// unknown, as ceiling.mjs does: exit 2 means unknown, never a finding and
// never clear. Exit 2 also on bad usage, when IA refuses or fails, and for a
// task that is not admitted or is not a task. Exit 1 is never used. --strict is
// refused (exit 2): this report never blocks, and an ignored flag would let a
// skipped check stand for a pass.
import { resolve } from 'node:path';
import { resolveCli, runIa } from './lib/cli.mjs';
import { describe, exitEvidenceReport, observationFromInspect, shortName, taskFromInspect } from './lib/exit-evidence.mjs';

const args = process.argv.slice(2);
const OPTIONS = new Set(['--root', '--plan', '--task']);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--strict') usage('--strict is not supported: this report is advisory and never blocks');
  if (OPTIONS.has(args[i])) { if (args[i + 1] === undefined || args[i + 1].startsWith('--')) usage(); i++; }
  else if (args[i] !== '--json') usage();
}
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(option('--root') ?? '.');
const plan = option('--plan');
const only = option('--task');
const asJson = args.includes('--json');
// One CLI read's time limit in milliseconds; the environment can shorten it (the tests do).
const READ_TIMEOUT_MS = Number(process.env.IA_CORE_METHOD_READ_TIMEOUT_MS) > 0 ? Number(process.env.IA_CORE_METHOD_READ_TIMEOUT_MS) : 180_000;

function usage(message) {
  process.stderr.write(`${message ? message + '\n' : ''}usage: exit-evidence.mjs [--root <repo>] [--plan <identity>] [--task <identity>] [--json]\n`);
  process.exit(2);
}

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }) + '\n');
  process.exit(2);
}

try {
  const cli = resolveCli(root);
  // A record that inspect does not return is null in the graph, so a task that
  // depends on it reads unknown instead of evidenced.
  const graph = {};
  // A read that fails to run or times out is the same as one that returns
  // nothing: the record is null, and the task reads unknown instead of the
  // whole report aborting.
  const read = args => {
    try { return runIa(root, args, { cli, timeoutMs: READ_TIMEOUT_MS }); } catch { return undefined; }
  };
  const loadTask = identity => {
    if (identity in graph) return graph[identity];
    const ran = read(['inspect', identity, '--edges', 'both']);
    const record = ran?.code === 0 ? ran.json?.records?.find(r => r.identity === identity) : undefined;
    graph[identity] = record ? taskFromInspect(record, ran.json.directed ?? []) : null;
    return graph[identity];
  };
  const loadObservation = identity => {
    if (identity in graph) return;
    const ran = read(['inspect', identity, '--depth', '0']);
    const record = ran?.code === 0 ? ran.json?.records?.find(r => r.identity === identity) : undefined;
    graph[identity] = record ? observationFromInspect(record) : null;
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
  if (only && !graph[only]) fail(`${only} could not be read or is not an admitted record in ${root}`);
  for (const id of taskIds) if (graph[id]?.status === 'closed') for (const observation of graph[id].observations) loadObservation(observation);

  const report = exitEvidenceReport(graph, taskIds);
  if (asJson) process.stdout.write(JSON.stringify({ format: 'inventarch.exit-evidence', version: 1, rule: 'exit-evidence', advisory: true, root, ...report }, null, 2) + '\n');
  else {
    const shown = only ? report.tasks : report.tasks.filter(t => t.position !== 'not-closed');
    for (const entry of shown) process.stdout.write(describe(entry) + '\n');
    const c = report.counts;
    process.stdout.write(`${report.tasks.length} task(s), ${c.closed} closed: ${c.evidenced} evidenced, ${c.exempt} exempt, ${c.refused} refused, ${c.inconclusive} inconclusive, ${c.stale} stale, ${c.noEvidence} no evidence, ${c.unknown} UNKNOWN (not evaluated); ${c.notClosed} not closed, not evaluated\n`);
    const exempt = report.tasks.filter(t => t.exemptBy.length && t.position === 'exempt');
    if (exempt.length) process.stdout.write(`Exempt (author's declaration, not verified): ${exempt.map(t => shortName(t.identity)).join(', ')}\n`);
    process.stdout.write('Advisory: exit 0 does not mean evidenced; read the position at the start of each line.\n');
  }
  if (only && report.tasks[0].position === 'unknown') process.exit(2);
} catch (error) {
  fail(`${error.code ?? error.name}: ${error.message}`);
}
