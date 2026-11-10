// The exit-evidence report (principle method-claims-within-evidence, decision
// public-method-report-gate). Each case is named after a clause of the
// principle or of the report's own position table. The script runs here
// against a stand-in CLI that answers `ia next` and `ia inspect` from
// fixtures, so those cases are told the shape of the CLI's output; the two
// real-CLI cases below (IA_CORE_TEST_CLI, which the native lane sets) are the
// ones that show the shape and the digest are the real ones.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describe, exitEvidenceReport, NOTHING_TO_RUN, observationFromInspect, taskFromInspect } from '../scripts/lib/exit-evidence.mjs';
import { exitRow, observationId, observationRecord, row, subjectRow, taskId, taskRecord, workCli } from './helpers/work-cli.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PLUGIN, 'scripts', 'exit-evidence.mjs');
const CURRENT = 'rev-current';

// Builds a stand-in CLI from task specs: { name, status, obs: [{ name, via, ...observation fields }] }.
function cliFor(t, specs, { failing = [], plans, slow = [] } = {}) {
  const records = {};
  const directed = {};
  for (const spec of specs) {
    records[taskId(spec.name)] = taskRecord(spec.name, { status: spec.status ?? 'closed', digest: CURRENT });
    directed[taskId(spec.name)] = [];
    for (const o of spec.obs ?? []) {
      records[observationId(o.name)] = observationRecord(o.name, o);
      directed[taskId(spec.name)].push((o.via === 'exit' ? exitRow : subjectRow)(taskId(spec.name), observationId(o.name)));
    }
  }
  return workCli(t, { records, directed, failing, plans, slow });
}

const run = (cli, args) => spawnSync(process.execPath, [SCRIPT, '--root', cli.root, ...args], { env: cli.env, encoding: 'utf8' });
const only = (cli, name, extra = []) => run(cli, ['--task', taskId(name), ...extra]);
const firstLine = ran => ran.stdout.split('\n')[0];
const positionOf = (cli, name) => JSON.parse(only(cli, name, ['--json']).stdout).tasks[0];

test('a current success is evidenced, through evidence.subject; --task exits 0', t => {
  const cli = cliFor(t, [{ name: 't-ok', obs: [{ name: 'o-ok', verdict: 'success', subjectRevision: CURRENT }] }]);
  const ran = only(cli, 't-ok');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(firstLine(ran), /^EVIDENCED: task\/t-ok: a current success \(observation\/o-ok\)/);
  const entry = positionOf(cli, 't-ok');
  assert.equal(entry.position, 'evidenced');
  assert.equal(entry.finding, false);
});

test('a current success is evidenced through work.exit-evidence alone', t => {
  const cli = cliFor(t, [{ name: 't-exit', obs: [{ name: 'o-exit', via: 'exit', verdict: 'success', subjectRevision: CURRENT }] }]);
  assert.equal(positionOf(cli, 't-exit').position, 'evidenced');
});

test('a closed task with no observation is a finding, and exit 0 does not hide it: the first line says NO EVIDENCE', t => {
  const cli = cliFor(t, [{ name: 't-none' }]);
  const ran = only(cli, 't-none');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(firstLine(ran), /^NO EVIDENCE: task\/t-none: closed with no observation that holds a verdict/);
  const report = JSON.parse(only(cli, 't-none', ['--json']).stdout);
  assert.equal(report.counts.noEvidence, 1);
  assert.equal(report.tasks[0].finding, true);
});

test('a failed run outweighs a passing one on the same revision: a success and a refusal read refused', t => {
  const cli = cliFor(t, [{ name: 't-refuted', obs: [{ name: 'o-pass', verdict: 'success', subjectRevision: CURRENT }, { name: 'o-fail', verdict: 'refusal', subjectRevision: CURRENT }] }]);
  const ran = only(cli, 't-refuted');
  assert.equal(ran.status, 0);
  assert.match(firstLine(ran), /^REFUSED: task\/t-refuted: a current refusal \(observation\/o-fail\) outweighs any success/);
  assert.equal(positionOf(cli, 't-refuted').finding, true);
});

test('a verdict that is neither success nor refusal reads inconclusive, not evidenced', t => {
  const cli = cliFor(t, [{ name: 't-unsure', obs: [{ name: 'o-unsure', verdict: 'inconclusive', subjectRevision: CURRENT }] }]);
  assert.match(firstLine(only(cli, 't-unsure')), /^INCONCLUSIVE: /);
  assert.equal(positionOf(cli, 't-unsure').position, 'inconclusive');
});

test('a verdict covers only its revision: a success at another revision is stale and the report names the current digest', t => {
  const cli = cliFor(t, [{ name: 't-old', obs: [{ name: 'o-old', verdict: 'success', subjectRevision: 'rev-before' }] }]);
  const ran = only(cli, 't-old');
  assert.match(firstLine(ran), /^STALE: task\/t-old: .*o-old is for another revision.*current digest is rev-current/);
  assert.equal(positionOf(cli, 't-old').digest, CURRENT);
});

test('an observation with no verdict reads no evidence', t => {
  const cli = cliFor(t, [{ name: 't-mute', obs: [{ name: 'o-mute', subjectRevision: CURRENT }] }]);
  assert.equal(positionOf(cli, 't-mute').position, 'no-evidence');
});

test('a success that records no revision reads stale and says so', t => {
  const cli = cliFor(t, [{ name: 't-bare', obs: [{ name: 'o-bare', verdict: 'success' }] }]);
  const ran = only(cli, 't-bare');
  assert.match(firstLine(ran), /^STALE: task\/t-bare: .*o-bare records no revision/);
  assert.equal(positionOf(cli, 't-bare').finding, true);
});

test('a refusal that records no revision is not current: the task is not refused, and the refusal is listed', t => {
  const cli = cliFor(t, [{ name: 't-bare-refusal', obs: [{ name: 'o-bare-refusal', verdict: 'refusal' }] }]);
  const entry = positionOf(cli, 't-bare-refusal');
  assert.notEqual(entry.position, 'refused');
  assert.equal(entry.position, 'no-evidence');
  assert.match(entry.information.join('\n'), /o-bare-refusal is a refusal with no revision recorded/);
  assert.match(only(cli, 't-bare-refusal').stdout, /note: .*no revision recorded/);
  const other = cliFor(t, [{ name: 't-old-refusal', obs: [{ name: 'o-old-refusal', verdict: 'refusal', subjectRevision: 'rev-before' }] }]);
  assert.equal(positionOf(other, 't-old-refusal').position, 'no-evidence');
  assert.match(positionOf(other, 't-old-refusal').information.join('\n'), /at another revision/);
});

test('an exemption is listed and is not a finding, a stale exemption still exempts, and a current refusal beats it', t => {
  const cli = cliFor(t, [
    { name: 't-exempt', obs: [{ name: 'o-exempt', basis: NOTHING_TO_RUN }] },
    { name: 't-exempt-old', obs: [{ name: 'o-exempt-old', basis: NOTHING_TO_RUN, verdict: 'success', subjectRevision: 'rev-before' }] },
    { name: 't-exempt-refuted', obs: [{ name: 'o-exempt-2', basis: NOTHING_TO_RUN }, { name: 'o-fail', verdict: 'refusal', subjectRevision: CURRENT }] },
  ]);
  const exempt = positionOf(cli, 't-exempt');
  assert.equal(exempt.position, 'exempt');
  assert.equal(exempt.finding, false);
  assert.deepEqual(exempt.exemptBy, [observationId('o-exempt')]);
  assert.equal(positionOf(cli, 't-exempt-old').position, 'exempt');
  assert.equal(positionOf(cli, 't-exempt-refuted').position, 'refused');
  const listing = run(cli, []);
  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /Exempt \(author's declaration, not verified\): task\/t-exempt, task\/t-exempt-old/);
  assert.match(firstLine(only(cli, 't-exempt')), /^EXEMPT: task\/t-exempt: declared nothing to run by observation\/o-exempt \(the author's declaration, not verified; not a finding\)/);
});

test('tasks that are not closed are only counted, never evaluated', t => {
  const cli = cliFor(t, [{ name: 't-open', status: 'open' }, { name: 't-held', status: 'held' }, { name: 't-closed' }]);
  const listing = run(cli, []);
  assert.equal(listing.status, 0);
  assert.doesNotMatch(listing.stdout, /t-open|t-held/);
  const counts = JSON.parse(run(cli, ['--json']).stdout).counts;
  assert.equal(counts.notClosed, 2);
  assert.equal(counts.closed, 1);
  assert.match(firstLine(only(cli, 't-open')), /^NOT CLOSED: task\/t-open: status open; not evaluated/);
  assert.equal(only(cli, 't-open').status, 0);
});

test('an environment failure leaves the claim unrun: an unreadable observation reads unknown, --task exits 2, and a current refusal still stands beside it', t => {
  const unread = observationId('o-unread');
  const cli = cliFor(t, [
    { name: 't-unknown', obs: [{ name: 'o-unread', verdict: 'success', subjectRevision: CURRENT }, { name: 'o-pass', verdict: 'success', subjectRevision: CURRENT }] },
    { name: 't-refuted-unread', obs: [{ name: 'o-unread', verdict: 'success', subjectRevision: CURRENT }, { name: 'o-fail', verdict: 'refusal', subjectRevision: CURRENT }] },
  ], { failing: [unread] });
  const ran = only(cli, 't-unknown');
  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(firstLine(ran), /^UNKNOWN \(NOT EVALUATED\): task\/t-unknown: could not read observation\/o-unread: do not treat it as evidenced/);
  const entry = JSON.parse(only(cli, 't-unknown', ['--json']).stdout).tasks[0];
  assert.equal(entry.evaluated, false);
  assert.deepEqual(entry.unreadable, [unread]);
  assert.equal(entry.finding, false);
  assert.equal(positionOf(cli, 't-refuted-unread').position, 'refused');
  const listing = run(cli, []);
  assert.equal(listing.status, 0, 'the listing is a report: unknown is counted, not a usage error');
  assert.match(listing.stdout, /1 UNKNOWN \(not evaluated\)/);
});

test('a read that times out leaves its task unknown instead of aborting the report', t => {
  const slow = observationId('o-slow');
  const cli = cliFor(t, [
    { name: 't-slow', obs: [{ name: 'o-slow', verdict: 'success', subjectRevision: CURRENT }] },
    { name: 't-fine', obs: [{ name: 'o-fine', verdict: 'success', subjectRevision: CURRENT }] },
  ], { slow: [slow] });
  const env = { ...cli.env, IA_CORE_METHOD_READ_TIMEOUT_MS: '400' };
  const listing = spawnSync(process.execPath, [SCRIPT, '--root', cli.root, '--json'], { env, encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stdout + listing.stderr);
  const byName = name => JSON.parse(listing.stdout).tasks.find(x => x.identity.endsWith('/' + name));
  assert.equal(byName('t-slow').position, 'unknown');
  assert.deepEqual(byName('t-slow').unreadable, [slow]);
  assert.equal(byName('t-fine').position, 'evidenced');
  const only = spawnSync(process.execPath, [SCRIPT, '--root', cli.root, '--task', taskId('t-slow')], { env, encoding: 'utf8' });
  assert.equal(only.status, 2);
  assert.match(firstLine(only), /^UNKNOWN \(NOT EVALUATED\): task\/t-slow: could not read observation\/o-slow/);
});

test('refusals exit 2: a task not admitted, not a task, a missing CLI, an unknown option and --strict', t => {
  const cli = cliFor(t, [{ name: 't1' }]);
  const missing = only(cli, 'absent');
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /could not be read or is not an admitted record/);
  const notTask = workCli(t, { records: { [observationId('o1')]: observationRecord('o1', { verdict: 'success' }) } });
  const wrong = run(notTask, ['--task', observationId('o1')]);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stdout, /is not a @task/);
  const noCli = spawnSync(process.execPath, [SCRIPT, '--root', cli.root], { env: { ...cli.env, IA_CLI_PATH: join(cli.dir, 'absent.js') }, encoding: 'utf8' });
  assert.equal(noCli.status, 2);
  assert.match(noCli.stdout, /IA-CORE-CLI-MISSING/);
  assert.equal(run(cli, ['--bogus']).status, 2);
  const strict = run(cli, ['--strict']);
  assert.equal(strict.status, 2);
  assert.match(strict.stderr, /--strict is not supported/);
});

test('the readers keep only the task\'s own depth 1 rows for the two fields and directions, observations only, deduplicated', () => {
  const task = taskId('t');
  const o1 = observationId('o1');
  const record = taskRecord('t', { digest: 'dg' });
  const node = taskFromInspect(record, [
    subjectRow(task, o1),
    exitRow(task, o1),
    exitRow(task, observationId('o2')),
    subjectRow(task, observationId('deep'), { depth: 2 }),
    subjectRow(task, observationId('other-task-row'), { identity: taskId('another') }),
    row(task, observationId('wrong-field'), { field: 'work.milestone', direction: 'out' }),
    exitRow(task, observationId('wrong-direction'), { direction: 'in' }),
    subjectRow(task, observationId('wrong-direction-2'), { direction: 'out' }),
    subjectRow(task, 'work-system/definition/task/not-an-observation'),
  ]);
  assert.deepEqual(node, { word: 'task', status: 'closed', digest: 'dg', observations: [o1, observationId('o2')] });
  assert.deepEqual(observationFromInspect(observationRecord('o', { verdict: 'refusal', subjectRevision: 'x', basis: NOTHING_TO_RUN })), { word: 'observation', verdict: 'refusal', subjectRevision: 'x', basis: NOTHING_TO_RUN });
  assert.deepEqual(observationFromInspect(observationRecord('o')), { word: 'observation', verdict: undefined, subjectRevision: undefined, basis: 'inference' });
});

test('every position reaches the reader as its capitalised name on the first line', () => {
  const graph = {
    [taskId('a')]: { word: 'task', status: 'closed', digest: 'd', observations: [observationId('s')] },
    [observationId('s')]: { word: 'observation', verdict: 'success', subjectRevision: 'd' },
    [taskId('b')]: { word: 'task', status: 'closed', digest: 'd', observations: [] },
    [taskId('c')]: null,
  };
  const report = exitEvidenceReport(graph, [taskId('a'), taskId('b'), taskId('c')]);
  assert.deepEqual(report.tasks.map(entry => describe(entry).split(':')[0]), ['EVIDENCED', 'NO EVIDENCE', 'UNKNOWN (NOT EVALUATED)']);
  assert.equal(report.counts.unknown, 1);
  assert.equal(report.counts.findings, 1);
});

test('the report reads each task with its edges and each observation without them', t => {
  const cli = cliFor(t, [{ name: 't-ok', obs: [{ name: 'o-ok', verdict: 'success', subjectRevision: CURRENT }] }]);
  assert.equal(run(cli, []).status, 0);
  const calls = cli.calls().filter(c => c[0] === 'inspect');
  assert.ok(calls.some(c => c[1] === taskId('t-ok') && c.includes('--edges') && c.includes('both')));
  const observation = calls.find(c => c[1] === observationId('o-ok'));
  assert.deepEqual(observation.slice(2, 4), ['--depth', '0']);
});

test('the JSON names its format and version, and is advisory', t => {
  const cli = cliFor(t, [{ name: 't-none' }]);
  const report = JSON.parse(run(cli, ['--json']).stdout);
  assert.equal(report.format, 'inventarch.exit-evidence');
  assert.equal(report.version, 1);
  assert.equal(report.rule, 'exit-evidence');
  assert.equal(report.advisory, true);
});

const CLI = process.env.IA_CORE_TEST_CLI;
const SKIP = !CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli dist/main.js';

function observation(name, subject, { verdict, revision, basis = 'inference', named = true }) {
  return `@observation ${name}
  meaning
    says "A recorded result for ${subject}."
    answers "What was observed about ${subject}?"
  evidence
    origin check
    actor "exit-evidence test"
    observed-at "2026-11-09T00:00:00Z"
    captured-at "2026-11-09T00:00:00Z"
    workspace "fixture"
    locator "${subject}"
    revision "unversioned"
    bundle ".ia/learning/observations/${name}.json"
    digest "${'0'.repeat(64)}"
    availability unavailable${named ? `
    subject @task ${subject}` : ''}${revision ? `\n    subject-revision "${revision}"` : ''}${verdict ? `\n    verdict ${verdict}` : ''}
  interpretation
    applies "The named task at the named revision only."
    limits "A fixture result; nothing was executed."
    reason "Fixture for the report."
    basis ${basis}
  retention
    status retained
`;
}

function task(name, status, extra = '') {
  return `@task ${name}
  meaning
    says "Task ${name}."
  work
    title "Task ${name}"
    status ${status}
    milestone @milestone m${extra}
`;
}

const WORK = (edit = '', route = false) => `#! ia 1.0

@plan p
  meaning
    says "Plan."
  work
    title "Plan"
    status open

@milestone m
  meaning
    says "Milestone."
  work
    title "Milestone"
    status open
    plan @plan p
    exit "Done."

${task('t-ok', 'closed', edit)}
${task('t-none', 'closed')}
${task('t-refuted', 'closed')}
${task('t-exempt', 'closed')}
${task('t-open', 'open')}${route ? `\n${task('t-route', 'closed', '\n    exit-evidence @observation o-route')}\n${task('t-bare-refusal', 'closed')}` : ''}`;

// Sets up a workspace with the ia-method kit adopted and the work records
// written, and returns what the cases need to read it.
async function realWorkspace(t) {
  const { runIa, resolveCli } = await import('../scripts/lib/cli.mjs');
  const { adopt, DEFAULT_KITS_DIR, findKit } = await import('../scripts/lib/kit.mjs');
  const kit = findKit('ia-method', DEFAULT_KITS_DIR);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-exit-evidence-e2e-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = resolveCli(root, { env: { IA_CLI_PATH: CLI } });
  const init = spawnSync(process.execPath, [CLI, 'init', root, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8', env: { ...process.env, IA_NO_HANDOFF: '1' } });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.ok(adopt(root, kit, { cli }).written.length > 0);
  const work = join(root, '.ia', 'src', 'work.ia');
  const evidence = join(root, '.ia', 'src', 'evidence.ia');
  const digestOf = name => {
    const ran = runIa(root, ['inspect', `work-system/definition/task/${name}`, '--depth', '0'], { cli });
    return ran.json.records[0].digest;
  };
  const report = (...args) => {
    const ran = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json', ...args], { env: { ...process.env, IA_CLI_PATH: CLI }, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    const parsed = JSON.parse(ran.stdout);
    return name => parsed.tasks.find(x => x.identity.endsWith('/' + name));
  };
  const admitted = () => {
    const ran = runIa(root, ['validate'], { cli });
    assert.equal(ran.json?.status, 'admitted', ran.stdout.slice(0, 2000) + ran.stderr);
  };
  return { root, cli, work, evidence, digestOf, report, admitted, runIa };
}

test('real CLI: each position is read from records the CLI admits, and a success written with the digest ia inspect reports reads evidenced (opt-in: IA_CORE_TEST_CLI)', { skip: SKIP }, async t => {
  const w = await realWorkspace(t);
  writeFileSync(w.work, WORK());
  w.admitted();
  const digest = w.digestOf('t-ok');
  const digestRefuted = w.digestOf('t-refuted');
  writeFileSync(w.evidence, `#! ia 1.0

${observation('o-ok', 't-ok', { verdict: 'success', revision: digest })}
${observation('o-refuted-pass', 't-refuted', { verdict: 'success', revision: digestRefuted })}
${observation('o-refuted-fail', 't-refuted', { verdict: 'refusal', revision: digestRefuted })}
${observation('o-exempt', 't-exempt', { basis: NOTHING_TO_RUN })}`);
  w.admitted();
  // The work.exit-evidence route: t-route names its observation and the observation does not name it back.
  // Writing the task first needs the observation to exist; the digest it carries is read afterwards.
  writeFileSync(w.work, WORK('', true));
  writeFileSync(w.evidence, `#! ia 1.0

${observation('o-route', 't-route', { verdict: 'success', named: false })}
${observation('o-bare-refusal', 't-bare-refusal', { verdict: 'refusal' })}`);
  w.admitted();
  const digestRoute = w.digestOf('t-route');
  writeFileSync(w.evidence, `#! ia 1.0

${observation('o-ok', 't-ok', { verdict: 'success', revision: digest })}
${observation('o-refuted-pass', 't-refuted', { verdict: 'success', revision: digestRefuted })}
${observation('o-refuted-fail', 't-refuted', { verdict: 'refusal', revision: digestRefuted })}
${observation('o-exempt', 't-exempt', { basis: NOTHING_TO_RUN })}
${observation('o-route', 't-route', { verdict: 'success', revision: digestRoute, named: false })}
${observation('o-bare-refusal', 't-bare-refusal', { verdict: 'refusal' })}`);
  w.admitted();
  const at = w.report();
  assert.equal(at('t-route').position, 'evidenced');
  assert.deepEqual(at('t-route').observations.map(o => o.identity.split('/').pop()), ['o-route']);
  assert.equal(at('t-bare-refusal').position, 'no-evidence');
  assert.match(at('t-bare-refusal').information.join(), /with no revision recorded/);
  assert.equal(at('t-ok').position, 'evidenced');
  assert.equal(at('t-none').position, 'no-evidence');
  assert.equal(at('t-refuted').position, 'refused');
  assert.equal(at('t-exempt').position, 'exempt');
  assert.equal(at('t-open').position, 'not-closed');
  // ia next reads the same records, and may read t-refuted differently: it
  // takes the first current success and has no refusal clause. The answer is
  // recorded, never asserted, so a fix in the CLI does not fail this case.
  const next = w.runIa(w.root, ['next'], { cli: w.cli });
  const nextView = (next.json?.view?.tasks ?? []).find(x => x.identity.endsWith('/t-refuted'));
  t.diagnostic(`ia next on t-refuted: ${JSON.stringify(nextView)}`);
});

test('real CLI: changing the task after the evidence was taken makes the success stale (opt-in: IA_CORE_TEST_CLI)', { skip: SKIP }, async t => {
  const w = await realWorkspace(t);
  writeFileSync(w.work, WORK());
  w.admitted();
  const digest = w.digestOf('t-ok');
  writeFileSync(w.evidence, `#! ia 1.0

${observation('o-ok', 't-ok', { verdict: 'success', revision: digest })}`);
  w.admitted();
  assert.equal(w.report()('t-ok').position, 'evidenced');
  writeFileSync(w.work, WORK('\n    ended "2026-11-09"'));
  w.admitted();
  assert.notEqual(w.digestOf('t-ok'), digest);
  const stale = w.report()('t-ok');
  assert.equal(stale.position, 'stale');
  assert.equal(stale.digest, w.digestOf('t-ok'));
});

test('the real-CLI cases are in the native inventory, so the native lane fails when they are skipped', () => {
  const inventory = JSON.parse(readFileSync(join(PLUGIN, '..', '..', 'tools', 'native-inventory.json'), 'utf8'));
  const names = inventory.cases.filter(c => c.file === 'plugins/ia/tests/exit-evidence.test.mjs').map(c => c.name);
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const realNames = [...source.matchAll(/^test\('(real CLI: [^']+?)'/gm)].map(m => m[1]);
  assert.equal(realNames.length, 2);
  assert.deepEqual([...names].sort(), [...realNames].sort());
});
