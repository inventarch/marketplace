#!/usr/bin/env node
// The repository method gate, report only (decision public-method-report-gate):
//   node scripts/method-gate.mjs [--root <repo>] [--plan <identity>]... [--budget <seconds>] [--json]
// Runs the two method reports over a workspace's work records, the ceiling
// (ceiling.mjs) and the exit evidence of closed tasks (exit-evidence.mjs),
// and prints what each found. It never blocks: it exits 0 whether it found
// something, found nothing, or could not evaluate a rule, so exit 0 means
// only that it ran. Read the line that says how many rules were evaluated: a
// run that evaluated none checked nothing. A rule it could not evaluate is
// printed in capitals and is `evaluated: false` in the JSON.
//
// Exit 2 only for bad usage: an unknown option, a --root that is not a
// directory, and --strict, which is refused because this gate has no blocking
// mode yet and an ignored flag would let a skipped check stand for a pass.
//
// --plan repeats, one run of each rule per plan; with none the gate runs each
// rule once, and a workspace with several plans then reads not evaluated
// (the CLI refuses to choose one), so pass --plan for each. There is no plan
// discovery. The children run as separate processes, because ceiling.mjs
// exits the process; they inherit the environment, with IA_NO_HANDOFF=1, so
// an npm or proxy setting the npx fallback needs still reaches them.
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChild } from './lib/hygiene.mjs';
import { findWorkspace } from './lib/workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES = [
  { rule: 'ceiling', script: join(HERE, 'ceiling.mjs') },
  { rule: 'exit-evidence', script: join(HERE, 'exit-evidence.mjs') },
];
const CHILD_TIMEOUT_MS = 600_000;
const CHILD_CAP = 16 * 1024 * 1024;
const USAGE = 'usage: method-gate.mjs [--root <repo>] [--plan <identity>]... [--budget <seconds>] [--json]';

function usage(message) {
  process.stderr.write(`${message ? message + '\n' : ''}${USAGE}\n`);
  process.exit(2);
}

function parse(argv) {
  const out = { root: '.', plans: [], budget: 1800, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict') usage('--strict is not supported: this gate only reports and never blocks');
    else if (arg === '--json') out.json = true;
    else if (arg === '--root' || arg === '--plan' || arg === '--budget') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
      i++;
      if (arg === '--root') out.root = value;
      else if (arg === '--plan') out.plans.push(value);
      else {
        out.budget = Number(value);
        if (!Number.isFinite(out.budget) || out.budget <= 0) usage('--budget needs a positive number of seconds');
      }
    } else usage(`unknown option ${arg}`);
  }
  return out;
}

const options = parse(process.argv.slice(2));
const root = resolve(options.root);
if (!existsSync(root) || !statSync(root).isDirectory()) usage(`--root ${root} is not a directory`);

const started = Date.now();
const remaining = () => options.budget * 1000 - (Date.now() - started);

// One child report as { evaluated, reason?, report? }: anything but a clean
// report reads as not evaluated, with the reason.
async function runRule({ script }, plan) {
  const left = remaining();
  if (left <= 0) return { evaluated: false, reason: `the ${options.budget} s budget was spent before this run started` };
  const argv = [process.execPath, script, '--root', root, '--json', ...(plan ? ['--plan', plan] : [])];
  const ran = await runChild({ argv, cwd: root, env: { ...process.env, IA_NO_HANDOFF: '1' }, timeoutMs: Math.min(CHILD_TIMEOUT_MS, left), cap: CHILD_CAP });
  if (ran.timedOut) return { evaluated: false, reason: `timed out after ${Math.round(Math.min(CHILD_TIMEOUT_MS, left) / 1000)} s` };
  if (ran.error) return { evaluated: false, reason: `did not run: ${ran.error.message}` };
  let json;
  try { json = JSON.parse(ran.stdout); } catch { json = undefined; }
  if (json?.error) return { evaluated: false, reason: json.error };
  if (ran.status !== 0 || !Array.isArray(json?.tasks)) return { evaluated: false, reason: (ran.stderr.trim() || `exit ${ran.status}, no report`).split('\n')[0] };
  return { evaluated: true, report: json };
}

async function evaluate() {
  const workspace = findWorkspace(root);
  const plans = options.plans.length ? options.plans : [undefined];
  const results = [];
  for (const entry of RULES) results.push({ rule: entry.rule, runs: [] });
  if (!workspace) {
    for (const result of results) result.runs.push({ plan: null, evaluated: false, reason: `no IA workspace (.ia/src) at or above ${root}` });
  } else {
    // The two rules read the same records and write nothing, so they run
    // together; the plans follow one another.
    for (const plan of plans) {
      const runs = await Promise.all(RULES.map(entry => runRule(entry, plan)));
      runs.forEach((run, i) => {
        const note = !run.evaluated && !plan && /ia next refused/.test(run.reason) ? `${run.reason}; pass --plan for each plan of the workspace` : run.reason;
        results[i].runs.push({ plan: plan ?? null, ...run, ...(note ? { reason: note } : {}) });
      });
    }
  }
  for (const result of results) {
    result.evaluated = result.runs.every(r => r.evaluated);
    const reasons = result.runs.filter(r => !r.evaluated).map(r => `${r.plan ? `plan ${r.plan}: ` : ''}${r.reason}`);
    if (reasons.length) result.reason = reasons.join('; ');
    // Counted from the tasks, each once by identity, so a task that two plans
    // both list is not counted twice. A rule no run evaluated has no counts.
    const done = result.runs.filter(r => r.evaluated);
    const tasks = [...new Map(done.flatMap(r => r.report.tasks).map(t => [t.identity, t])).values()];
    const at = (...positions) => tasks.filter(t => positions.includes(t.position)).length;
    if (!done.length) result.counts = null;
    else if (result.rule === 'ceiling') {
      result.counts = { beyondCeiling: at('beyond-ceiling'), firstLayer: at('first-layer'), clear: at('clear'), unknown: at('unknown') };
    } else {
      result.counts = {
        findings: tasks.filter(t => t.finding).length, refused: at('refused'), stale: at('stale'), noEvidence: at('no-evidence'), inconclusive: at('inconclusive'),
        exempt: at('exempt'), evidenced: at('evidenced'), unknown: at('unknown'), closed: tasks.filter(t => t.status === 'closed').length, notClosed: at('not-closed'),
      };
      result.exempt = tasks.filter(t => t.position === 'exempt').map(t => t.identity);
    }
    // Tasks a rule could not judge: the rule ran, but not over them.
    result.unknown = result.counts?.unknown ?? 0;
  }
  return results;
}

const results = await evaluate();
const evaluated = results.filter(r => r.evaluated).length;
const notEvaluated = results.filter(r => !r.evaluated).map(r => r.rule);
const unknownTasks = results.reduce((n, r) => n + r.unknown, 0);
const unknownNote = unknownTasks ? `, ${unknownTasks} task(s) unknown` : '';

function lines() {
  const out = ['Method gate (report only: it never blocks; exit 0 means it ran, not that the work is clear)', `root: ${root}`];
  for (const result of results) {
    const c = result.counts;
    if (!result.evaluated) out.push(`${result.rule.toUpperCase()}: NOT EVALUATED: ${result.reason}`);
    const done = result.runs.filter(r => r.evaluated);
    if (!done.length) continue;
    const scope = result.runs.length > 1 || result.runs[0].plan ? ` (${done.length} of ${result.runs.length} plan run(s))` : '';
    if (result.rule === 'ceiling') {
      out.push(`ceiling${scope}: ${c.beyondCeiling} beyond the ceiling, ${c.firstLayer} first layer (information), ${c.clear} clear${c.unknown ? `, ${c.unknown} UNKNOWN (not evaluated)` : ''}`);
    } else {
      out.push(`exit-evidence${scope}: ${c.findings} finding(s) over ${c.closed} closed task(s): ${c.refused} refused, ${c.stale} stale, ${c.noEvidence} no evidence, ${c.inconclusive} inconclusive; ${c.evidenced} evidenced, ${c.exempt} exempt${c.unknown ? `, ${c.unknown} UNKNOWN (not evaluated)` : ''}`);
      if (result.exempt.length) out.push(`  exempt (author's declaration, not verified): ${result.exempt.map(i => i.split('/').slice(-2).join('/')).join(', ')}`);
    }
  }
  out.push(`${evaluated} of ${results.length} rules evaluated${unknownNote}${evaluated === 0 ? ': nothing was checked' : notEvaluated.length ? `: ${notEvaluated.join(', ')} NOT EVALUATED` : ''}`);
  return out;
}

if (options.json) {
  process.stdout.write(JSON.stringify({ format: 'inventarch.method-gate', version: 1, root, advisory: true, evaluated, notEvaluated, unknownTasks, rules: results.map(({ rule, evaluated: ok, reason, counts, unknown, exempt, runs }) => ({ rule, evaluated: ok, ...(reason ? { reason } : {}), counts, unknown, ...(exempt ? { exempt } : {}), runs })) }, null, 2) + '\n');
} else {
  process.stdout.write(lines().join('\n') + '\n');
}
if (notEvaluated.length) process.stderr.write(`${evaluated} of ${results.length} rules evaluated${unknownNote}: ${notEvaluated.join(', ')} NOT EVALUATED${evaluated === 0 ? '; nothing was checked' : ''}\n`);
else if (unknownTasks) process.stderr.write(`${evaluated} of ${results.length} rules evaluated${unknownNote}\n`);
process.exitCode = 0;
