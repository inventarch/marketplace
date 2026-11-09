// inventarch/ia-kb-kit's decision lifecycle checker, the declared check kb-check-decisions.
// IA's decision schema (work-system decision.schema.ia) lets work.status be open, made, superseded or withdrawn, and
// leaves a decision's decider, choice and rationale optional. A KB accepts a decision only when it is made with them,
// and keeps that acceptance when a successor supersedes it. Through the
// command given as its arguments (the core's checker runner passes ${IA}, the CLI it resolves), this runs ia validate
// on the workspace it runs in and judges nothing unless IA admits it, then reads its admitted records with ia records
// and reports each of the workspace's own decisions (provenance workspace) that is
//   decision-made-needs-acceptance        made without a non-empty decider, choice or rationale;
//   decision-superseded-needs-acceptance  superseded without them;
//   decision-superseded-needs-successor   superseded with no @decision superseding it, by the successor's own
//                                         supersedes or the replaced decision's superseded-by.
// Open and withdrawn decisions are not checked. The accepted revision (decision.effective-revision, the
// snapshot revision a decision takes effect from) is not required yet: no current decision records one. Requiring it
// is a follow-up.
//   node check-decisions.mjs <the command that runs ia ...>      from the workspace root
// Prints { format, revision, decisions, findings } and exits 0 with no finding, 1 with one. When the workspace cannot
// be judged (no command, no .ia/src here, a workspace ia validate does not admit, records the CLI does not return) it
// prints nothing on stdout and exits 2: not evaluated, never a pass.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'ia.kb.decision-lifecycle.v1';
// What a made decision names, in the order of the schema's fields.
export const ACCEPTANCE = ['decision.decider', 'decision.choice', 'decision.rationale'];
// The CLI's environment: IA_NO_HANDOFF=1 keeps the given command the CLI that runs, since from IA 3.6.0 a CLI otherwise
// hands its command to the repository's installed one.
const handoffOff = () => ({ ...process.env, IA_NO_HANDOFF: '1' });

// The text of one section field, such as work.status, of a record as ia records returns it.
function text(record, path) {
  const [section, key] = path.split('.');
  return record.sections?.find(s => s.name === section)?.fields?.find(f => f.key === key)?.value?.text;
}
const listed = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const byIdentity = (a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);

// The report on one admitted snapshot ({ revision, records }), its findings in identity order.
export function checkDecisions(snapshot) {
  const decisions = (snapshot.records ?? []).filter(r => r.discriminator === 'decision');
  const known = new Set(decisions.map(d => d.identity));
  // ia records resolves an edge's target only within the record's own file: an edge into another file keeps target
  // null and its reference as written. That reference is resolved here as IA keys records: the word and an identity
  // exactly, the name lowercased.
  const byReference = new Map(decisions.map(d => [`@${d.discriminator} ${d.name}`, d.identity]));
  const counterpart = ({ target, reference }) => target
    ?? (reference?.kind === 'identity' ? reference.identity : byReference.get(`@${reference?.discriminator} ${String(reference?.name ?? '').toLowerCase()}`));
  // The decisions some decision supersedes. Either end may write the edge: the successor's supersedes is out, the
  // replaced decision's superseded-by is in; a counterpart that is no decision of the snapshot names no successor.
  const replaced = new Set();
  for (const decision of decisions) {
    for (const edge of decision.edges ?? []) {
      if (edge.predicate !== 'supersede') continue;
      const other = counterpart(edge);
      if (!known.has(other) || other === decision.identity) continue;
      if (edge.direction === 'out') replaced.add(other);
      else if (edge.direction === 'in') replaced.add(decision.identity);
    }
  }
  const own = decisions.filter(d => d.provenance === 'workspace').sort(byIdentity);
  const findings = [];
  for (const decision of own) {
    const status = text(decision, 'work.status');
    if (status !== 'made' && status !== 'superseded') continue;
    const record = `@decision ${decision.name}`;
    const at = { record, path: decision.source?.path, line: decision.source?.line };
    const missing = ACCEPTANCE.filter(path => !(text(decision, path) ?? '').trim());
    if (missing.length) {
      const code = status === 'made' ? 'decision-made-needs-acceptance' : 'decision-superseded-needs-acceptance';
      findings.push({ code, ...at, message: `${record} is ${status} without ${listed(missing)}` });
    }
    if (status === 'superseded' && !replaced.has(decision.identity)) {
      findings.push({ code: 'decision-superseded-needs-successor', ...at, message: `${record} is superseded, but no @decision supersedes it` });
    }
  }
  return { format: FORMAT, revision: snapshot.revision, decisions: own.length, findings };
}

// Why the CLI gave no usable answer: the spawn error, the refusal's code and message, an ok answer that exited
// non-zero or holds no records, or what the CLI printed.
function refusal(ran, reply) {
  if (ran.error) return ran.error.message;
  if (typeof reply?.message === 'string') return reply.code && !reply.message.startsWith(reply.code) ? `${reply.code}: ${reply.message}` : reply.message;
  if (reply?.ok === true) return ran.status !== 0 ? `it answered ok but exited ${ran.status}` : 'its answer holds no records';
  return (ran.stderr || ran.stdout || '').trim() || `exit ${ran.status}`;
}

// Whether ia validate admits the workspace at `root`, read by `command`. ia records answers a workspace IA refuses as
// well, but leaves out the records validation refuses, so a decision IA refuses would read as no decision: a refused
// workspace is never judged. It asks for errors only: --json lists at most 50 findings, which warnings could fill.
function readAdmission(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'validate', '--root', root, '--severity', 'error', '--json'], { cwd: root, env: handoffOff(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  let reply;
  try { reply = JSON.parse(ran.stdout); } catch { reply = undefined; }
  if (reply?.status === 'admitted') return;
  if (reply?.status === 'refused') {
    const errors = reply.counts?.errors;
    const first = (reply.findings ?? []).find(f => f.severity === 'error');
    const named = first ? `, the first ${first.code}: ${first.message}` : '';
    throw new Error(`ia validate refused the workspace with ${errors} error${errors === 1 ? '' : 's'}${named}; a workspace IA refuses is not judged`);
  }
  throw new Error(`ia validate did not admit the workspace: ${refusal(ran, reply)}`);
}

// The admitted snapshot of the workspace at `root`, read by `command`, the words that run the IA CLI.
function readRecords(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'records', '--root', root, '--params', '{}'], { cwd: root, env: handoffOff(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  let reply;
  try { reply = JSON.parse(ran.stdout); } catch { reply = undefined; }
  if (!ran.error && ran.status === 0 && reply?.ok === true && Array.isArray(reply.result?.records)) return reply.result;
  throw new Error(`ia records did not return the admitted records: ${refusal(ran, reply)}`);
}

function main(command) {
  if (!command.length) throw new Error('usage: node check-decisions.mjs <the command that runs ia, such as node <path to @inventarch/cli>/dist/main.js>, from the workspace root');
  // ia records reads whatever folder it is given, so a folder without .ia/src would read as a workspace with no decisions.
  const root = process.cwd();
  if (!existsSync(join(root, '.ia', 'src'))) throw new Error(`${root} is not a workspace root (it has no .ia/src); run the check from the root of the workspace under check`);
  readAdmission(command, root);
  const report = checkDecisions(readRecords(command, root));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.findings.length ? 1 : 0;
}

// Compared as real paths: a script reached through a link would otherwise skip main() and exit 0 having checked nothing.
function samePath(a, b) {
  const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
if (process.argv[1] !== undefined && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`kb-check-decisions: ${error.message}\n`);
    process.exitCode = 2;
  }
}
