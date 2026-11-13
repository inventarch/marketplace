// A stand-in IA CLI for the method reports: it answers `ia validate`, `ia next` and
// `ia inspect` from fixtures in the shape the real CLI 3.8.0 reports them.
// Only the opt-in real-CLI cases show that the shape is the real one; the
// stand-in is what the other cases are told.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const taskId = name => `work-system/definition/task/${name}`;
export const observationId = name => `learning-system/definition/observation/${name}`;
export const planId = name => `work-system/definition/plan/${name}`;

const textField = (key, text, kind = 'scalar') => ({ key, value: { kind, text } });

// One `ia inspect` record for a task.
export function taskRecord(name, { status = 'closed', digest = `digest-of-${name}`, requires = [], cites = [] } = {}) {
  return {
    identity: taskId(name),
    discriminator: 'task',
    digest,
    sections: [{ name: 'work', fields: [textField('status', status)] }],
    edges: [
      ...requires.map(target => ({ predicate: 'require', direction: 'out', target })),
      ...cites.map(target => ({ predicate: 'cite', direction: 'out', target })),
    ],
  };
}

// One `ia inspect` record for an observation; a field left undefined is absent.
export function observationRecord(name, { verdict, subjectRevision, basis = 'inference' } = {}) {
  return {
    identity: observationId(name),
    discriminator: 'observation',
    digest: `digest-of-${name}`,
    sections: [
      { name: 'evidence', fields: [...(verdict ? [textField('verdict', verdict)] : []), ...(subjectRevision ? [textField('subject-revision', subjectRevision, 'string')] : [])] },
      { name: 'interpretation', fields: [textField('basis', basis)] },
    ],
    edges: [],
  };
}

// A field-ref row of `directed`, as ia inspect <task> --edges both reports it.
export function row(task, counterpart, { field, direction, depth = 1, identity = task } = {}) {
  return { identity, depth, kind: 'field-ref', derived: true, direction, field, counterpart, declaredOn: direction === 'in' ? counterpart : task, source: { path: '.ia/src/work.ia', line: 1 } };
}
export const subjectRow = (task, observation, overrides) => row(task, observation, { field: 'evidence.subject', direction: 'in', ...overrides });
export const exitRow = (task, observation, overrides) => row(task, observation, { field: 'work.exit-evidence', direction: 'out', ...overrides });

// Builds the stand-in CLI and returns { root, env, calls() }.
//   plans:     { <plan identity>: [task identity] }; with none, every task record is the one plan's.
//   records:   { <identity>: inspect record }
//   directed:  { <identity>: [rows] } returned only for --edges both
//   failing:   identities whose inspect exits 3
//   ambiguous: plan identities; `next` with no --seat refuses naming them
//   refused:   error codes; `validate` then answers status refused with those errors (exit 1), else admitted
//   validateStatus: any other status `validate` should answer (exit 0), such as partial
//   slow:      commands or identities whose answer takes 15 s, so a time limit cuts them off
// The gate runs the plugin's own scripts, so only the exit-evidence real-CLI
// cases pin the CLI's real output shape for both.
export function workCli(t, { plans, records, directed = {}, failing = [], ambiguous = [], slow = [], refused = [], validateStatus }) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-workcli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ plans, records, directed, failing, ambiguous, slow, refused, validateStatus }));
  writeFileSync(join(dir, 'calls.log'), '');
  const main = join(dir, 'main.mjs');
  writeFileSync(main, `import { appendFileSync, readFileSync } from 'node:fs';
const { plans, records, directed, failing, ambiguous, slow, refused, validateStatus } = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);
appendFileSync(new URL('./calls.log', import.meta.url), JSON.stringify(argv) + '\\n');
const [command, identity] = argv;
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (slow.includes(command) || slow.includes(identity)) await new Promise(resolve => setTimeout(resolve, 15000));
const out = value => process.stdout.write(JSON.stringify(value));
if (command === 'validate') {
  if (validateStatus) { out({ version: 1, status: validateStatus, counts: { errors: 0, warnings: 0 }, findings: [] }); process.exit(0); }
  if (refused.length) { out({ version: 1, status: 'refused', counts: { errors: refused.length, warnings: 0 }, findings: refused.map(code => ({ code, severity: 'error', message: 'refused' })) }); process.exit(1); }
  out({ version: 1, status: 'admitted', counts: { errors: 0, warnings: 2 }, findings: [{ code: 'IA-COMP-NOT-EVALUATED', severity: 'warning' }] });
} else if (command === 'next') {
  const seat = flag('--seat');
  if (!seat && ambiguous.length) { out({ version: 1, ok: false, code: 'IA-RUNTIME-NEXT-AMBIGUOUS', message: ambiguous.length + ' admitted @plan records at band 100 and no seat to choose one: ' + ambiguous.join(', '), next: 'Run "ia next --seat <plan>"' }); process.exit(1); }
  const ids = plans ? (seat ? plans[seat] : Object.values(plans).flat()) : Object.values(records).filter(r => r.discriminator === 'task').map(r => r.identity);
  out({ version: 1, ok: true, view: { tasks: (ids ?? []).map(id => ({ identity: id })) } });
} else if (command === 'inspect') {
  if (failing.includes(identity)) { out({ ok: false, code: 'IA-DB-SOURCE-UNAVAILABLE' }); process.exit(3); }
  const both = flag('--edges') === 'both';
  out({ version: 1, records: records[identity] ? [records[identity]] : [], directed: both ? (directed[identity] ?? []) : [] });
} else process.exit(2);
`);
  const root = join(dir, 'repo');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.ia', 'src'), { recursive: true });
  const env = { ...process.env, IA_CLI_PATH: main };
  delete env.IA_METHOD_CLI;
  const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, env, calls, dir, main };
}

