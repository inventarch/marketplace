import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { envFor, fakeCli, makeKit, makeRepo, recordSources, run, sandbox } from './helpers/fixtures.mjs';

// The repository binds the kit and, unless `installed: false`, its lock installs it (a bound kit the lock does not install is refused).
function fixture(t, { installed = true } = {}) {
  const dir = sandbox(t, 'ia-retained-method-'), kitsDir = join(dir, 'kits');
  const kit = makeKit(kitsDir);
  const bindings = { format: 1, bindings: { 'work.task': { kit: kit.id, capability: kit.capability } } };
  const repo = makeRepo(join(dir, 'repo'), { bindings, lock: installed ? { packages: [{ id: kit.id, version: kit.version, archive: kit.archive }] } : null });
  const runRoot = join(dir, 'run'), cli = fakeCli(dir);
  const env = envFor({ cli, kitsDir, temp: join(dir, 'temp'), runRoot });
  const resolve = (extra = []) => run('resolve.mjs', ['--entry', 'work', '--activity', 'task', '--root', repo, ...extra], env);
  const check = (extra = []) => run('check.mjs', ['fake-gate', '--root', repo, ...extra], env);
  return { dir, kitsDir, kit, repo, runRoot, env, resolve, check };
}

test('retained method survives same-version runner drift and removal of carried kit', t => {
  const f = fixture(t), first = f.resolve();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const originalPin = readFileSync(join(f.runRoot, 'binding.json'));
  writeFileSync(join(f.kit.dir, 'check-ok.mjs'), 'process.exit(71);');
  writeFileSync(join(f.kit.dir, 'checks.json'), JSON.stringify({ format: 1, checks: {} }));
  assert.equal(f.check().status, 0, 'checker uses retained declarations and script');
  rmSync(f.kit.dir, { recursive: true });
  const again = f.resolve();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(again.json.instructions, first.json.instructions);
  assert.equal(again.json.closure.retained, first.json.closure.retained);
  assert.equal(f.check(['--kit', f.kit.id]).status, 0, 'explicit kit cannot bypass or require current sources');
  assert.deepEqual(readFileSync(join(f.runRoot, 'binding.json')), originalPin);
});

test('retained ordinary runner keeps core identity and process supervision data', t => {
  const f = fixture(t);
  writeFileSync(join(f.kit.dir, 'check-ok.mjs'), `
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeMethodProcess } from '../../../scripts/lib/method-process.mjs';
const identity = JSON.parse(readFileSync(new URL('../../../.claude-plugin/plugin.json', import.meta.url)));
assert.equal(identity.name, 'ia');
const result = await executeMethodProcess({ argv: [process.execPath, '-e', 'process.stdout.write("retained-child")'], cwd: process.cwd(), directory: mkdtempSync(join(tmpdir(), 'retained-supervisor-')), timeoutSeconds: 10, env: process.env });
assert.equal(result.exitCode, 0);
assert.equal(result.timedOut, false);
assert.equal(result.terminationFailed, false);
`);
  const first = f.resolve();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const snapshot = join(f.env.IA_CORE_CLOSURES_DIR, first.json.closure.retained);
  const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json')));
  for (const path of ['.claude-plugin/plugin.json', 'config/qualified-process-tools.json', 'config/trusted-publishers.json']) assert.ok(manifest.files.some(file => file.path === path), path);
  rmSync(f.kit.dir, { recursive: true });
  const checked = f.check();
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const pin = readFileSync(join(f.runRoot, 'binding.json'));
  const profile = join(snapshot, 'payload/config/qualified-process-tools.json');
  const original = readFileSync(profile);
  writeFileSync(profile, '{}\n');
  assert.equal(f.check().json.error.code, 'IA-CORE-CLOSURE-INTEGRITY');
  writeFileSync(profile, original);
  assert.equal(f.check().status, 0);
  assert.deepEqual(readFileSync(join(f.runRoot, 'binding.json')), pin);
});

test('missing or modified retained method refuses without current-source fallback or pin writes', t => {
  const f = fixture(t), first = f.resolve();
  assert.equal(first.status, 0, first.stdout);
  const snapshot = join(f.env.IA_CORE_CLOSURES_DIR, first.json.closure.retained);
  const originalPin = readFileSync(join(f.runRoot, 'binding.json'));
  renameSync(snapshot, snapshot + '-away');
  assert.equal(f.resolve().json.error.code, 'IA-CORE-CLOSURE-MISSING');
  assert.equal(f.check().json.error.code, 'IA-CORE-CLOSURE-MISSING');
  renameSync(snapshot + '-away', snapshot);
  const helper = join(snapshot, 'payload', 'scripts', 'lib', 'workspace.mjs');
  const original = readFileSync(helper);
  writeFileSync(helper, Buffer.concat([original, Buffer.from('\n// changed helper\n')]));
  assert.equal(f.resolve().json.error.code, 'IA-CORE-CLOSURE-INTEGRITY');
  assert.equal(f.check().json.error.code, 'IA-CORE-CLOSURE-INTEGRITY');
  writeFileSync(helper, original);
  assert.equal(f.check().status, 0);
  assert.deepEqual(readFileSync(join(f.runRoot, 'binding.json')), originalPin);
});

test('installed workspace overrides cannot impersonate retained method instructions', t => {
  const f = fixture(t);
  const injected = JSON.parse(readFileSync(join(f.kit.dir, '.ia', 'fake-cli.json')));
  for (const cell of injected.position.cells) cell.text = 'IMPERSONATED METHOD';
  injected.inspect[f.kit.capId].sections = [];
  writeFileSync(join(f.repo, '.ia', 'fake-cli.json'), JSON.stringify(injected));
  const out = f.resolve();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(out.json.instructions.length);
  assert.ok(out.json.instructions.every(cell => !cell.text.includes('IMPERSONATED')));
  assert.notEqual(out.json.envelope.kitRoot, f.repo);
  assert.equal(out.json.scope.workspace.revision, injected.position.revision);
});

test('mandatory composition gaps refuse before pin publication', t => {
  for (const kind of ['profile', 'playbook', 'cell', 'check-record', 'runner', 'ambiguous-profile']) {
    const f = fixture(t), path = join(f.kit.dir, '.ia', 'fake-cli.json');
    const canned = JSON.parse(readFileSync(path));
    if (kind === 'profile') delete canned.inspect[f.kit.profileId];
    if (kind === 'playbook') delete canned.inspect[f.kit.playbookId];
    if (kind === 'cell') delete canned.read[Object.keys(canned.read)[0]];
    if (kind === 'check-record') delete canned.inspect['compliance-system/check/gate/fake-gate'];
    if (kind === 'runner') writeFileSync(join(f.kit.dir, 'checks.json'), '{"format":1,"checks":{}}');
    if (kind === 'ambiguous-profile') canned.inbound[f.kit.capId].push({ field: 'composition.capabilities', declaredOn: 'agent-composition-system/binding/agent-profile/other' });
    writeFileSync(path, JSON.stringify(canned));
    const out = f.resolve();
    assert.equal(out.status, 1, kind + ': ' + out.stdout);
    assert.equal(out.json.instructions, undefined);
    assert.equal(existsSync(join(f.runRoot, 'binding.json')), false, kind);
  }
});

test('changing explicit profile requires rebind even when capability and kit match', t => {
  const f = fixture(t), first = f.resolve();
  assert.equal(first.status, 0, first.stdout);
  const path = join(f.repo, '.ia', 'bindings.json'), binding = JSON.parse(readFileSync(path));
  binding.bindings['work.task'].profile = f.kit.profile;
  writeFileSync(path, JSON.stringify(binding));
  assert.equal(f.resolve().json.error.code, 'IA-CORE-REBIND-REQUIRED');
  const rebound = f.resolve(['--rebind']);
  assert.equal(rebound.status, 0, rebound.stdout);
  assert.equal(rebound.json.binding.revision, 2);
});


test('check-only native composition needs no playbook and never inherits unrelated position cells', t => {
  const f = fixture(t), path = join(f.kit.dir, '.ia', 'fake-cli.json');
  const canned = JSON.parse(readFileSync(path));
  const composition = canned.inspect[f.kit.capId].sections.find(section => section.name === 'composition');
  composition.fields = composition.fields.filter(field => field.key !== 'playbooks');
  for (const cell of canned.position.cells) cell.text = 'UNRELATED POSITION INSTRUCTION';
  writeFileSync(path, JSON.stringify(canned));
  recordSources(f.kit.dir);
  const good = f.resolve();
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.deepEqual(good.json.instructions, []);
  assert.deepEqual(good.json.evidence.required, ['fake-gate']);
  assert.equal(f.check().status, 0);
  writeFileSync(join(f.kit.dir, 'checks.json'), '{"format":1,"checks":{}}');
  const missing = f.resolve(['--rebind']);
  assert.equal(missing.status, 1, missing.stdout);
  assert.equal(missing.json.error.code, 'IA-CORE-CHECK-UNAVAILABLE');
  assert.equal(JSON.parse(readFileSync(join(f.runRoot, 'binding.json'))).revision, 1);
  composition.fields = [];
  writeFileSync(path, JSON.stringify(canned));
  const empty = f.resolve(['--rebind']);
  assert.equal(empty.json.error.code, 'IA-CORE-COMPOSITION-MISSING');
});


test('retained inventory globally sorts shared-prefix systems and file-directory names', t => {
  const f = fixture(t);
  for (const name of ['ia-method', 'ia-method-extra']) {
    const records = join(f.kit.dir, '.ia', 'src', 'systems', name, 'records');
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, 'note.ia'), `#! ia 1.0\n// ${name}\n`);
  }
  mkdirSync(join(f.kit.dir, 'resources'), { recursive: true });
  mkdirSync(join(f.kit.dir, 'resources', 'note'), { recursive: true });
  writeFileSync(join(f.kit.dir, 'resources', 'note', 'body.txt'), 'nested');
  writeFileSync(join(f.kit.dir, 'resources', 'note.txt'), 'sibling');
  recordSources(f.kit.dir);
  const first = f.resolve();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const snapshot = join(f.env.IA_CORE_CLOSURES_DIR, first.json.closure.retained);
  const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json')));
  const paths = manifest.files.map(entry => entry.path);
  assert.deepEqual(paths, [...paths].sort());
  const foundation = paths.findIndex(path => path.includes('/ia-method-extra/'));
  const method = paths.findIndex(path => path.includes('/ia-method/'));
  assert.ok(foundation >= 0 && foundation < method);
  assert.ok(paths.indexOf('config/kits/fake/resources/note.txt') < paths.indexOf('config/kits/fake/resources/note/body.txt'));
  const again = f.resolve();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.json.closure.retained, first.json.closure.retained);
  assert.equal(f.check().status, 0);
  writeFileSync(join(snapshot, 'payload', 'config', 'kits', 'fake', 'resources', 'note.txt'), 'altered');
  assert.equal(f.resolve().json.error.code, 'IA-CORE-CLOSURE-INTEGRITY');
});

test('the closures store honours IA_HOME when IA_CORE_CLOSURES_DIR is unset', t => {
  const f = fixture(t), home = join(f.dir, 'iahome'), env = { ...f.env, IA_HOME: home };
  delete env.IA_CORE_CLOSURES_DIR;
  const first = run('resolve.mjs', ['--entry', 'work', '--activity', 'task', '--root', f.repo], env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(join(home, 'method-closures-v1', first.json.closure.retained)));
  const relative = run('resolve.mjs', ['--entry', 'work', '--activity', 'task', '--root', f.repo], { ...env, IA_HOME: 'rel' });
  assert.notEqual(relative.status, 0);
});
