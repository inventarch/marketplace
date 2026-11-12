// The repository method gate (decision public-method-report-gate): it runs
// the ceiling and exit-evidence reports, prints what they found, and never
// blocks. The reports run as child processes against a stand-in CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { observationId, observationRecord, planId, subjectRow, taskId, taskRecord, workCli } from './helpers/work-cli.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PLUGIN, 'scripts', 'method-gate.mjs');
const OPEN_DECISION = 'work-system/definition/decision/d-open';
const CURRENT = 'rev-current';

// t-beyond rests on t-first, which rests on an open decision: beyond the
// ceiling. t-bare is closed with no observation; t-evidenced has a current
// success and t-exempt an exemption.
function findings(t, extra = {}) {
  const records = {
    [OPEN_DECISION]: { identity: OPEN_DECISION, discriminator: 'decision', digest: 'd', sections: [{ name: 'work', fields: [{ key: 'status', value: { kind: 'scalar', text: 'open' } }] }], edges: [] },
    [taskId('t-first')]: taskRecord('t-first', { digest: CURRENT, requires: [OPEN_DECISION] }),
    [taskId('t-beyond')]: taskRecord('t-beyond', { digest: CURRENT, requires: [taskId('t-first')] }),
    [taskId('t-evidenced')]: taskRecord('t-evidenced', { digest: CURRENT }),
    [taskId('t-exempt')]: taskRecord('t-exempt', { digest: CURRENT }),
    [observationId('o-pass')]: observationRecord('o-pass', { verdict: 'success', subjectRevision: CURRENT }),
    [observationId('o-exempt')]: observationRecord('o-exempt', { basis: 'nothing-to-run' }),
  };
  const directed = {
    [taskId('t-evidenced')]: [subjectRow(taskId('t-evidenced'), observationId('o-pass'))],
    [taskId('t-exempt')]: [subjectRow(taskId('t-exempt'), observationId('o-exempt'))],
  };
  return workCli(t, { records, directed, ...extra });
}

const gate = (cli, args = []) => spawnSync(process.execPath, [SCRIPT, '--root', cli.root, ...args], { env: cli.env, encoding: 'utf8' });

test('findings in both rules exit 0, print a report-only header and list both rules', t => {
  const ran = gate(findings(t));
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^Method gate \(report only: it never blocks; exit 0 means it ran, not that the work is clear\)/);
  assert.match(ran.stdout, /ceiling: 1 beyond the ceiling, 1 first layer \(information\), 2 clear/);
  assert.match(ran.stdout, /exit-evidence: 2 finding\(s\) over 4 closed task\(s\): 0 refused, 0 stale, 2 no evidence, 0 inconclusive; 1 evidenced, 1 exempt/);
  assert.match(ran.stdout, /exempt \(author's declaration, not verified\): task\/t-exempt/);
  assert.match(ran.stdout, /2 of 2 rules evaluated\n$/);
  assert.equal(ran.stderr, '', 'nothing is on stderr when every rule was evaluated');
});

test('the JSON names its format and version, and counts both rules', t => {
  const report = JSON.parse(gate(findings(t), ['--json']).stdout);
  assert.equal(report.format, 'inventarch.method-gate');
  assert.equal(report.version, 1);
  assert.equal(report.advisory, true);
  assert.equal(report.evaluated, 2);
  assert.deepEqual(report.notEvaluated, []);
  assert.deepEqual(report.rules.map(r => r.rule), ['ceiling', 'exit-evidence']);
  assert.equal(report.rules[0].counts.beyondCeiling, 1);
  assert.equal(report.rules[1].counts.findings, 2);
  assert.deepEqual(report.rules[1].exempt, [taskId('t-exempt')]);
});

test('a missing CLI leaves both rules not evaluated and says nothing was checked, on stdout and stderr, still exit 0', t => {
  const cli = findings(t);
  const env = { ...cli.env, IA_CLI_PATH: join(cli.dir, 'absent.js') };
  const ran = spawnSync(process.execPath, [SCRIPT, '--root', cli.root], { env, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /CEILING: NOT EVALUATED: .*IA-CORE-CLI-MISSING/);
  assert.match(ran.stdout, /EXIT-EVIDENCE: NOT EVALUATED: /);
  assert.match(ran.stdout, /0 of 2 rules evaluated: nothing was checked/);
  assert.match(ran.stderr, /0 of 2 rules evaluated: ceiling, exit-evidence NOT EVALUATED; nothing was checked/);
  const json = JSON.parse(spawnSync(process.execPath, [SCRIPT, '--root', cli.root, '--json'], { env, encoding: 'utf8' }).stdout);
  assert.equal(json.evaluated, 0);
  assert.equal(json.rules[0].counts, null, 'a rule nothing evaluated has no counts, not zero counts');
  assert.equal(json.rules[1].counts, null);
  assert.deepEqual(json.notEvaluated, ['ceiling', 'exit-evidence']);
  assert.match(json.rules[0].reason, /IA-CORE-CLI-MISSING/);
});

test('a refused workspace reads both rules not evaluated with the error codes, runs no report, and the workflow warning pattern matches', t => {
  const cli = findings(t, { refused: ['IA-LANG-DISCRIMINATOR-UNREGISTERED', 'IA-LANG-DUPLICATE-IDENTITY'] });
  const ran = gate(cli);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /CEILING: NOT EVALUATED: workspace not admitted: IA-LANG-DISCRIMINATOR-UNREGISTERED, IA-LANG-DUPLICATE-IDENTITY, run ia validate/);
  assert.match(ran.stdout, /EXIT-EVIDENCE: NOT EVALUATED: workspace not admitted/);
  assert.match(ran.stdout, /0 of 2 rules evaluated: nothing was checked/);
  assert.match(ran.stderr, /0 of 2 rules evaluated: ceiling, exit-evidence NOT EVALUATED; nothing was checked/);
  assert.match(ran.stdout, /NOT EVALUATED|UNKNOWN|task\(s\) unknown/, 'the workflow grep pattern fires');
  assert.deepEqual(cli.calls().map(c => c[0]), ['validate'], 'no report ran against a refused workspace');
  const report = JSON.parse(gate(cli, ['--json']).stdout);
  assert.deepEqual(report.admission, { status: 'refused', errors: ['IA-LANG-DISCRIMINATOR-UNREGISTERED', 'IA-LANG-DUPLICATE-IDENTITY'] });
  assert.equal(report.evaluated, 0);
  assert.equal(report.rules[1].counts, null);
});

test('an admitted workspace runs the reports and the JSON says so', t => {
  const report = JSON.parse(gate(findings(t), ['--json']).stdout);
  assert.deepEqual(report.admission, { status: 'admitted', errors: [] });
  assert.equal(report.evaluated, 2);
});

test('a validate that cannot run leaves both rules not evaluated and says to run ia validate', t => {
  const cli = findings(t, { slow: ['validate'] });
  const ran = gate(cli, ['--budget', '1', '--json']);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const report = JSON.parse(ran.stdout);
  assert.equal(report.admission.status, 'unavailable');
  assert.equal(report.evaluated, 0);
  assert.match(report.rules[0].reason, /workspace not admitted: ia validate did not answer .*run ia validate/);
});

test('any status but admitted reads both rules not evaluated and runs no report', t => {
  const cli = findings(t, { validateStatus: 'partial' });
  const ran = gate(cli, ['--json']);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const report = JSON.parse(ran.stdout);
  assert.deepEqual(report.admission, { status: 'partial', errors: [] });
  assert.equal(report.evaluated, 0);
  assert.match(report.rules[0].reason, /workspace not admitted: ia validate reported status partial, run ia validate/);
  assert.deepEqual(cli.calls().map(c => c[0]), ['validate']);
});

test('a validate that outlasts the budget reads not evaluated with a timeout of at least 1 s, never 0 s', t => {
  const cli = findings(t, { slow: ['validate'] });
  const report = JSON.parse(gate(cli, ['--budget', '1', '--json']).stdout);
  assert.equal(report.admission.status, 'unavailable');
  assert.match(report.rules[0].reason, /ia validate did not answer \(timed out after 1 s\)/);
});

const REAL_CLI = process.env.IA_CORE_TEST_CLI;

test('real CLI: the gate reads the shape of ia validate: an admitted workspace runs the reports and a refused one reads not evaluated (opt-in: IA_CORE_TEST_CLI)', { skip: !REAL_CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli dist/main.js' }, t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-gate-e2e-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, IA_CLI_PATH: REAL_CLI, IA_NO_HANDOFF: '1' };
  const init = spawnSync(process.execPath, [REAL_CLI, 'init', root, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8', env });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const raw = spawnSync(process.execPath, [REAL_CLI, 'validate', '--root', root, '--json'], { encoding: 'utf8', env });
  const shape = JSON.parse(raw.stdout);
  assert.equal(typeof shape.status, 'string', 'validate --json has a string status');
  assert.ok(Array.isArray(shape.findings), 'and a findings array');
  const admitted = JSON.parse(spawnSync(process.execPath, [SCRIPT, '--root', root, '--json'], { env, encoding: 'utf8' }).stdout);
  assert.equal(admitted.admission.status, 'admitted', JSON.stringify(shape.findings).slice(0, 1500));
  writeFileSync(join(root, '.ia', 'src', 'broken.ia'), '#! ia 1.0\n\n@workspace broken-twin\n  meaning\n    says "A second workspace with the same name."\n    answers "Does the gate refuse?"\n  composition\n    systems [@system workspace-system]\n    sources [".ia/src @authored"]\n\n@workspace broken-twin\n  meaning\n    says "Again."\n    answers "Again?"\n  composition\n    systems [@system workspace-system]\n    sources [".ia/src @authored"]\n');
  const refused = JSON.parse(spawnSync(process.execPath, [SCRIPT, '--root', root, '--json'], { env, encoding: 'utf8' }).stdout);
  assert.equal(refused.admission.status, 'refused');
  assert.ok(refused.admission.errors.length > 0, 'the refusal names error codes');
  assert.equal(refused.evaluated, 0);
  assert.match(refused.rules[0].reason, /^workspace not admitted: IA-[A-Z-]+/);
});

test('two --plan values run each rule once per plan', t => {
  const cli = findings(t, { plans: { [planId('a')]: [taskId('t-first')], [planId('b')]: [taskId('t-beyond')] } });
  const ran = gate(cli, ['--plan', planId('a'), '--plan', planId('b'), '--json']);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const seats = cli.calls().filter(c => c[0] === 'next').map(c => c[c.indexOf('--seat') + 1]).sort();
  assert.deepEqual(seats, [planId('a'), planId('a'), planId('b'), planId('b')]);
  const report = JSON.parse(ran.stdout);
  assert.equal(report.rules[0].runs.length, 2);
  assert.equal(report.rules[1].runs.length, 2);
  assert.equal(report.rules[0].counts.beyondCeiling, 1);
});

test('an ambiguous plan set reads not evaluated, with the remedy', t => {
  const cli = findings(t, { ambiguous: [planId('a'), planId('b')], plans: { [planId('a')]: [], [planId('b')]: [] } });
  const ran = gate(cli);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /CEILING: NOT EVALUATED: ia next refused: 2 admitted @plan records .*; pass --plan for each plan of the workspace/);
  assert.match(ran.stdout, /EXIT-EVIDENCE: NOT EVALUATED: .*pass --plan for each plan of the workspace/);
  assert.match(ran.stdout, /0 of 2 rules evaluated: nothing was checked/);
  assert.match(ran.stderr, /nothing was checked/);
  const withPlans = gate(cli, ['--plan', planId('a'), '--plan', planId('b')]);
  assert.match(withPlans.stdout, /2 of 2 rules evaluated/);
});

test('--strict, an unknown option and a missing value exit 2', t => {
  const cli = findings(t);
  const strict = gate(cli, ['--strict']);
  assert.equal(strict.status, 2);
  assert.match(strict.stderr, /--strict is not supported: this gate only reports and never blocks/);
  assert.equal(gate(cli, ['--bogus']).status, 2);
  assert.equal(gate(cli, ['--plan']).status, 2);
  assert.equal(gate(cli, ['--budget', '0']).status, 2);
});

test('a --root that is not a directory exits 2', t => {
  const cli = findings(t);
  const ran = spawnSync(process.execPath, [SCRIPT, '--root', join(cli.dir, 'no-such-folder')], { env: cli.env, encoding: 'utf8' });
  assert.equal(ran.status, 2);
  assert.match(ran.stderr, /is not a directory/);
});

test('outside a workspace both rules read not evaluated, exit 0', t => {
  const cli = findings(t);
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-gate-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const ran = spawnSync(process.execPath, [SCRIPT, '--root', outside], { env: cli.env, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /CEILING: NOT EVALUATED: no IA workspace/);
  assert.match(ran.stdout, /0 of 2 rules evaluated: nothing was checked/);
});

test('a --budget that runs out while a run is going cuts it off and reads it not evaluated, never failed', t => {
  const cli = findings(t, { slow: ['next'] });
  const started = Date.now();
  const ran = gate(cli, ['--budget', '1', '--json']);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.ok(Date.now() - started < 12000, 'the sleeping stand-in was cut off, not waited for');
  const report = JSON.parse(ran.stdout);
  assert.equal(report.evaluated, 0);
  for (const rule of report.rules) assert.match(rule.reason, /timed out after 1 s/);
});

test('a task whose evidence cannot be read counts as unknown on the last line, in the JSON, and on stderr', t => {
  const cli = findings(t, { failing: [observationId('o-pass')] });
  const ran = gate(cli);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /2 of 2 rules evaluated, 1 task\(s\) unknown\n$/);
  assert.match(ran.stdout, /1 UNKNOWN \(not evaluated\)/);
  assert.match(ran.stderr, /2 of 2 rules evaluated, 1 task\(s\) unknown/);
  const report = JSON.parse(gate(cli, ['--json']).stdout);
  assert.equal(report.unknownTasks, 1);
  assert.equal(report.rules[0].unknown, 0);
  assert.equal(report.rules[1].unknown, 1);
});

test('a task listed under two plans is counted once in the totals', t => {
  const cli = findings(t, { plans: { [planId('a')]: [taskId('t-first'), taskId('t-beyond')], [planId('b')]: [taskId('t-beyond')] } });
  const report = JSON.parse(gate(cli, ['--plan', planId('a'), '--plan', planId('b'), '--json']).stdout);
  assert.equal(report.rules[0].counts.beyondCeiling, 1);
  assert.equal(report.rules[0].counts.firstLayer, 1);
  assert.equal(report.rules[1].counts.findings, 2);
  assert.equal(report.rules[1].counts.closed, 2);
});
