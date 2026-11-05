import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { installedKit, installedKits, kitInstallMatches, kitInstallation, requireKitInstalled } from '../scripts/lib/kit.mjs';
import { envFor, fakeCli, makeKit, makeRepo, recordSources, run, sandbox } from './helpers/fixtures.mjs';

// Which kits a repository's own lock installs: presence is one question, identity another.
const KIT = 'inventarch/ia-kb-kit';
const ARCHIVE = 'd'.repeat(64), OTHER = 'e'.repeat(64);
const base = { id: 'inventarch/language', version: '3.2.0', archive: 'b'.repeat(64) };
const carrier = kits => ({ kind: 'package', name: '@inventarch/public-kits', version: '1.0.0', integrity: 'sha512-' + 'E'.repeat(86) + '==', kits });
const repoWith = (t, lock) => makeRepo(join(sandbox(t, 'ia-install-guard-'), 'repo'), lock === undefined ? {} : { lock });
const codeOf = action => { try { action(); } catch (error) { return error.code ?? `other:${error.message}`; } return undefined; };

test('a packages row installs', t => {
  const repo = repoWith(t, { packages: [base, { id: KIT, version: '0.9.0', archive: ARCHIVE }] });
  assert.doesNotThrow(() => requireKitInstalled(repo, { id: KIT }));
  assert.deepEqual(kitInstallation(repo, KIT), { via: 'package', version: '0.9.0', archive: ARCHIVE });
  assert.equal(installedKit(repo, KIT).archive, ARCHIVE);
});

test('an entries package carrier row naming the kit installs', t => {
  const repo = repoWith(t, { packages: [base], entries: [carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }])] });
  assert.doesNotThrow(() => requireKitInstalled(repo, { id: KIT }));
  assert.deepEqual(kitInstallation(repo, KIT), { via: 'entry', version: '0.9.0', archive: ARCHIVE });
  assert.equal(installedKit(repo, KIT).id, KIT, 'installedKit returns the entries row too');
  assert.deepEqual(installedKits(repo).map(k => k.id), [KIT], 'installedKits lists carrier kits and leaves out the base');
});

test('presence ignores the archive: an entries row with another archive for the id still counts as installed', t => {
  const repo = repoWith(t, { packages: [base], entries: [carrier([{ id: KIT, version: '0.9.0', archive: OTHER }])] });
  assert.doesNotThrow(() => requireKitInstalled(repo, { id: KIT }));
});

test('installed at another version than the one resolved is still installed (the retained pin keeps running)', t => {
  const repo = repoWith(t, { packages: [base, { id: KIT, version: '1.2.0', archive: ARCHIVE }] });
  assert.doesNotThrow(() => requireKitInstalled(repo, { id: KIT }));
});

test('kitInstallMatches is false for another archive or version and true for the row\'s own', t => {
  const repo = repoWith(t, { packages: [base, { id: KIT, version: '0.9.0', archive: ARCHIVE }] });
  assert.equal(kitInstallMatches(repo, { id: KIT, version: '0.9.0', archive: ARCHIVE }), true);
  assert.equal(kitInstallMatches(repo, { id: KIT, version: '0.9.0', archive: OTHER }), false);
  assert.equal(kitInstallMatches(repo, { id: KIT, version: '0.8.0', archive: ARCHIVE }), false);
  assert.equal(kitInstallMatches(repo, { id: 'inventarch/none', version: '0.9.0', archive: ARCHIVE }), false);
  const viaEntry = repoWith(t, { packages: [base], entries: [carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }])] });
  assert.equal(kitInstallMatches(viaEntry, { id: KIT, version: '0.9.0', archive: ARCHIVE }), true);
  assert.equal(kitInstallMatches(viaEntry, { id: KIT, version: '0.9.0', archive: OTHER }), false);
});

test('a row for another kit, or a carrier row that is not a package carrier, does not install it', t => {
  const other = repoWith(t, { packages: [base, { id: 'inventarch/other-kit', version: '0.9.0', archive: ARCHIVE }] });
  assert.equal(codeOf(() => requireKitInstalled(other, { id: KIT })), 'IA-CORE-KIT-NOT-INSTALLED');
  const file = repoWith(t, { packages: [base], entries: [{ ...carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }]), kind: 'file' }] });
  assert.equal(codeOf(() => requireKitInstalled(file, { id: KIT })), 'IA-CORE-KIT-NOT-INSTALLED');
});

test('no lock at all is not installed', t => {
  const repo = repoWith(t);
  assert.equal(codeOf(() => requireKitInstalled(repo, { id: KIT })), 'IA-CORE-KIT-NOT-INSTALLED');
  assert.equal(kitInstallation(repo, KIT), null);
});

test('a lock that does not parse refuses as corrupt, not as not-installed, and matches nothing', t => {
  const repo = repoWith(t);
  writeLock(repo, '{ not json');
  assert.throws(() => requireKitInstalled(repo, { id: KIT }), SyntaxError);
  assert.equal(kitInstallMatches(repo, { id: KIT, version: '0.9.0', archive: ARCHIVE }), false, 'the identity predicate never throws');
});

test('a lock that cannot be read refuses as its own I/O error, not as not-installed, and matches nothing', t => {
  const repo = repoWith(t);
  // A folder where the lock file belongs: it exists, and reading it fails (EISDIR).
  mkdirSync(join(repo, '.ia', 'distributions.lock.json'));
  assert.throws(() => requireKitInstalled(repo, { id: KIT }), error => error.code === 'EISDIR' && error.code !== 'IA-CORE-KIT-NOT-INSTALLED');
  assert.equal(kitInstallMatches(repo, { id: KIT, version: '0.9.0', archive: ARCHIVE }), false);
});

test('the error code is IA-CORE-KIT-NOT-INSTALLED and not IA-CORE-PIN-UNAVAILABLE, and the message names the kit and the remedy', t => {
  const repo = repoWith(t, { packages: [base] });
  assert.throws(() => requireKitInstalled(repo, { id: KIT }), error => {
    assert.equal(error.code, 'IA-CORE-KIT-NOT-INSTALLED');
    assert.notEqual(error.code, 'IA-CORE-PIN-UNAVAILABLE');
    assert.equal(error.kit, KIT, 'the refusal carries the kit as a field');
    assert.equal(error.message, `kit ${KIT} is bound by this repository but its lock does not install it; run ia install ${KIT} (or kit.mjs add ${KIT}), then resolve again`);
    return true;
  });
});
function writeLock(repo, text) { writeFileSync(join(repo, '.ia', 'distributions.lock.json'), text); }

// ---------------------------------------------------------------------------
// Bound execution: resolve.mjs and check.mjs, ordinary and qualified routes.
// ---------------------------------------------------------------------------
const NOT_INSTALLED = 'IA-CORE-KIT-NOT-INSTALLED';

// Every file under the roots, by path and content hash.
function snapshot(...roots) {
  const seen = {};
  const walk = path => {
    if (!existsSync(path)) { seen[path] = 'absent'; return; }
    if (statSync(path).isDirectory()) { seen[path] = 'dir'; for (const name of readdirSync(path)) walk(join(path, name)); return; }
    seen[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
  };
  for (const root of roots) walk(root);
  return seen;
}

// One repository that binds work.task to a carried kit. `lock` builds the
// lock the repository has (none by default); `carried: false` leaves the kit
// out of the plugin's folder and puts it in the IA home only. Every child
// process the stand-in CLI or the kit's check script starts appends to the
// spawn log.
function fixture(t, { lock, carried = true, bindings = true } = {}) {
  const dir = sandbox(t, 'ia-install-guard-run-'), kitsDir = join(dir, 'kits'), home = join(dir, 'home'), spawnLog = join(dir, 'spawned.log');
  mkdirSync(kitsDir, { recursive: true });
  const kit = carried ? makeKit(kitsDir) : makeKit(join(home, 'kits', 'fake'), { folder: '0.1.0' });
  writeFileSync(join(kit.dir, 'check-ok.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(spawnLog)}, 'check ran\\n');\nprocess.stdout.write('check ' + process.env.IA_CORE_CHECK + ' ran in ' + process.cwd() + '\\n');\n`);
  recordSources(kit.dir);
  const repo = makeRepo(join(dir, 'repo'), { ...(bindings ? { bindings: { format: 1, bindings: { 'work.task': { kit: kit.id, capability: kit.capability } } } } : {}), lock: lock ? lock(kit) : null });
  const cli = fakeCli(dir);
  writeFileSync(cli, `import { appendFileSync as spawnedLog } from 'node:fs';\nspawnedLog(${JSON.stringify(spawnLog)}, process.argv.slice(2).join(' ') + '\\n');\n` + readFileSync(cli, 'utf8'));
  const runRoot = join(dir, 'run'), temp = join(dir, 'temp');
  const env = envFor({ cli, kitsDir, temp, runRoot, extra: { IA_HOME: home } });
  const resolve = (extra = [], over = {}) => run('resolve.mjs', ['--entry', 'work', '--activity', 'task', '--root', repo, ...extra], { ...env, ...over });
  const check = (extra = [], over = {}) => run('check.mjs', ['fake-gate', '--root', repo, ...extra], { ...env, ...over });
  const roots = [repo, runRoot, temp, home];
  const lockPath = join(repo, '.ia', 'distributions.lock.json');
  const setLock = value => writeFileSync(lockPath, JSON.stringify(value) + '\n');
  return { dir, kit, repo, runRoot, temp, home, env, cli, spawnLog, resolve, check, roots, setLock, snapshot: () => snapshot(...roots), spawned: () => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8') : '') };
}
const packagesLock = (version = '0.1.0') => kit => ({ packages: [{ ...base }, { id: kit.id, version, archive: kit.archive }] });
const entriesLock = kit => ({ packages: [{ ...base }], entries: [carrier([{ id: kit.id, version: kit.version, archive: kit.archive }])] });
const unrelatedLock = () => ({ packages: [{ ...base }, { id: 'inventarch/other-kit', version: '1.0.0', archive: 'f'.repeat(64) }] });
// A preload that logs every child_process call the script itself makes to the spawn log, so a route that starts a
// process of its own (not only through the stand-in CLI or a kit script) shows up.
const RECORDER = `import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  cp[name] = function (...args) { appendFileSync(process.env.IA_TEST_SPAWN_LOG, 'child_process.' + name + '\\n'); return original.apply(this, args); };
}
syncBuiltinESMExports();
`;
const recording = f => {
  const preload = join(f.dir, 'record-child-processes.mjs');
  writeFileSync(preload, RECORDER);
  return { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, IA_TEST_SPAWN_LOG: f.spawnLog };
};
const NO_CLI = f => ({ IA_CLI_PATH: join(f.dir, 'no-such-cli', 'main.js'), ...recording(f) });

test('the child-process recorder logs a spawn the script makes', t => {
  const f = fixture(t, { lock: unrelatedLock });
  writeFileSync(join(f.dir, 'spawns.mjs'), "import { spawnSync } from 'node:child_process'; spawnSync(process.execPath, ['-e', '0']);");
  const ran = spawnSync(process.execPath, [join(f.dir, 'spawns.mjs')], { env: { ...f.env, ...recording(f) }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(f.spawned(), /child_process\.spawnSync/);
});

function assertRefused(f, ran, what) {
  assert.equal(ran.status, 1, `${what}: ${ran.stdout}${ran.stderr}`);
  assert.equal(ran.json?.error?.code, NOT_INSTALLED, `${what}: ${ran.stdout}`);
  assert.ok(ran.json.error.message.includes(f.kit.id), 'the refusal names the kit');
  assert.equal(ran.json.error.kit, f.kit.id, `${what}: the emitted refusal carries the kit as a field`);
}

test('resolve refuses a bound kit with no lock row and writes nothing', t => {
  const f = fixture(t, { lock: unrelatedLock });
  const before = f.snapshot();
  assertRefused(f, f.resolve(['--pin']), 'resolve');
  assert.deepEqual(f.snapshot(), before, 'no retained closure, no pin, nothing written in the repository, the run root, the temp folder or the IA home');
  assert.equal(f.spawned(), '', 'no kit script and no CLI process started');
  assert.equal(existsSync(join(f.temp, 'closures')), false);
  assert.equal(existsSync(join(f.runRoot, 'binding.json')), false);
});

test('resolve refuses when the repository has no lock at all', t => {
  const f = fixture(t);
  const before = f.snapshot();
  assertRefused(f, f.resolve(['--pin']), 'resolve');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.spawned(), '');
});

test('check refuses separately from resolve', t => {
  const f = fixture(t, { lock: unrelatedLock });
  const before = f.snapshot();
  assertRefused(f, f.check(), 'check');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.spawned(), '', 'the check script never started');
});

test('qualified resolve refuses a bound, uninstalled kit before any runtime work', t => {
  const f = fixture(t, { lock: unrelatedLock });
  const before = f.snapshot();
  // The CLI path and the qualification file do not exist: a refusal that comes first is the guard's.
  const ran = f.resolve(['--qualified', '--qualification', join(f.dir, 'missing-qualification.json'), '--pin'], NO_CLI(f));
  assertRefused(f, ran, 'qualified resolve');
  assert.deepEqual(f.snapshot(), before, 'no method-closures-v1 store entry, no pin, nothing else');
  assert.equal(existsSync(join(f.home, 'method-closures-v1')), false);
  assert.equal(f.spawned(), '', 'no child process of any kind, recorded at the child_process API');
});

test('qualified check refuses a bound, uninstalled kit before reading the input', t => {
  const f = fixture(t, { lock: unrelatedLock });
  const missing = join(f.dir, 'no-such-input.json');
  const before = f.snapshot();
  // Bound by the repository's bindings (the task holds no pin yet).
  assertRefused(f, f.check(['--qualified-input', missing, '--activity', 'work.task'], NO_CLI(f)), 'qualified check, bound by bindings');
  assert.deepEqual(f.snapshot(), before, 'the refusal writes nothing');
  assert.equal(f.spawned(), '');
  // Bound by a format 4 pin the task already holds.
  mkdirSync(f.runRoot, { recursive: true });
  writeFileSync(join(f.runRoot, 'binding.json'), JSON.stringify({ format: 4, revision: 1, supersedes: null, workspace: { identity: 'workspace-system/definition/workspace/repo', revision: 'a'.repeat(64) }, kits: { [f.kit.id]: { id: f.kit.id, version: f.kit.version, closureSha256: 'b'.repeat(64) } }, keys: { 'work.task': { kit: f.kit.id, capability: 'agent-composition-system/definition/capability/fake-operate', profile: null } }, task: null }));
  const pinned = f.snapshot();
  assertRefused(f, f.check(['--qualified-input', missing, '--activity', 'work.task'], NO_CLI(f)), 'qualified check, bound by a pin');
  assert.deepEqual(f.snapshot(), pinned, 'the refusal writes nothing');
  assert.equal(f.spawned(), '', 'no child process of any kind, recorded at the child_process API');
});

test('qualified resolve and qualified check go past the guard when the lock installs the kit (a complete qualified run needs a cohort-backed native workspace this fixture cannot be, so each stops at its own named refusal)', t => {
  const f = fixture(t, { lock: packagesLock() });
  // The CLI is resolved (and so is attested) only after the guard: the stand-in CLI exists but is no qualified cohort.
  const attested = f.resolve(['--qualified', '--qualification', join(f.dir, 'missing-qualification.json')]);
  assert.equal(attested.json?.error?.code, 'IA-CORE-RUNTIME-UNQUALIFIED', attested.stdout + attested.stderr);
  assert.equal(attested.status, 1);
  const missingCli = f.resolve(['--qualified', '--qualification', join(f.dir, 'missing-qualification.json')], NO_CLI(f));
  assert.equal(missingCli.json?.error?.code, 'IA-CORE-CLI-MISSING', missingCli.stdout + missingCli.stderr);
  // The input is read only after the guard: it does not exist, and that is the refusal.
  const checked = f.check(['--qualified-input', join(f.dir, 'no-such-input.json'), '--activity', 'work.task'], NO_CLI(f));
  assert.equal(checked.json?.error?.code, 'ENOENT', checked.stdout + checked.stderr);
  assert.equal(checked.status, 1);
});

test('a binding written with a folder alias is guarded as the canonical kit it names (bind.mjs set, then check --kit and resolve)', t => {
  const f = fixture(t, { lock: unrelatedLock, bindings: false });
  const alias = f.kit.dir.slice(f.kit.dir.lastIndexOf(sep) + 1);
  assert.equal(alias, 'fake', 'the kit folder, which findKit also accepts');
  const bound = run('bind.mjs', ['set', 'work.task', alias, f.kit.capability, f.repo], f.env);
  assert.equal(bound.status, 0, bound.stdout + bound.stderr);
  assert.equal([JSON.parse(readFileSync(join(f.repo, '.ia', 'bindings.json'), 'utf8')).bindings['work.task']].flat()[0].kit, alias, 'the binding keeps the alias as written');
  const before = f.snapshot();
  assertRefused(f, f.check(['--kit', alias]), 'check --kit <alias>');
  assertRefused(f, f.check(['--kit', f.kit.id]), 'check --kit <id>');
  assertRefused(f, f.check(), 'check by bindings');
  assertRefused(f, f.resolve(['--pin']), 'resolve');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.spawned(), '');
  // The lock installs the canonical kit: the alias binding now runs.
  f.setLock(packagesLock()(f.kit));
  assert.equal(f.check(['--kit', alias]).status, 0);
  assert.equal(f.resolve(['--pin']).status, 0);
});

test('V1 a kit that exists only as an IA-home copy refuses with no fallback', t => {
  const f = fixture(t, { carried: false, lock: unrelatedLock });
  assert.ok(existsSync(join(f.home, 'kits', 'fake', '0.1.0', 'releases.json')), 'the IA home holds the kit');
  const before = f.snapshot();
  const resolved = f.resolve(['--pin']), checked = f.check();
  assertRefused(f, resolved, 'resolve');
  assertRefused(f, checked, 'check');
  assert.equal(resolved.json.instructions, undefined, 'no packet');
  assert.equal(checked.json.exitCode, undefined, 'no receipt');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.spawned(), '');
});

test('V2 an npm carrier entries row installs: resolve and check execute', t => {
  const f = fixture(t, { lock: entriesLock });
  const resolved = f.resolve(['--pin']);
  assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
  const checked = f.check();
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(f.spawned(), /check ran/);
});

test('V3 a packages row installs', t => {
  const f = fixture(t, { lock: packagesLock() });
  const resolved = f.resolve(['--pin']);
  assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
  const checked = f.check();
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test('a pinned key refuses when the lock no longer installs its kit', t => {
  const f = fixture(t, { lock: packagesLock() });
  assert.equal(f.resolve(['--pin']).status, 0);
  const pin = readFileSync(join(f.runRoot, 'binding.json'));
  f.setLock(unrelatedLock());
  const before = f.snapshot();
  assertRefused(f, f.resolve(['--pin']), 'pinned resolve');
  assertRefused(f, f.resolve(['--pin', '--rebind']), 'rebind');
  assertRefused(f, f.check(), 'pinned check');
  assert.deepEqual(f.snapshot(), before, 'no fallback to the retained copy, and nothing written');
  assert.deepEqual(readFileSync(join(f.runRoot, 'binding.json')), pin);
});

test('a pin older than the installed version still runs from its retained bytes', t => {
  const f = fixture(t, { lock: packagesLock('0.1.0') });
  assert.equal(f.resolve(['--pin']).status, 0);
  f.setLock(packagesLock('9.9.9')(f.kit));
  const resolved = f.resolve(['--pin']);
  assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
  const checked = f.check();
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test('an unrelated field change does not turn a refusal into a pass', t => {
  const f = fixture(t, { lock: packagesLock() });
  assert.equal(f.resolve(['--pin']).status, 0);
  const path = join(f.runRoot, 'binding.json'), pin = JSON.parse(readFileSync(path, 'utf8'));
  pin.kits[f.kit.id].implementation = '0'.repeat(64);
  writeFileSync(path, JSON.stringify(pin));
  f.setLock(unrelatedLock());
  const resolved = f.resolve(['--pin']), checked = f.check();
  assertRefused(f, resolved, 'resolve');
  assertRefused(f, checked, 'check');
  assert.notEqual(resolved.json.error.code, 'IA-CORE-PIN-UNAVAILABLE');
});

test('V4 the unbound route resolves with no lock row and executes nothing', t => {
  const f = fixture(t);
  const outside = join(f.dir, 'outside');
  mkdirSync(outside);
  const unbound = run('resolve.mjs', ['--entry', 'work', '--activity', 'task', '--root', outside, '--kit', f.kit.id, '--capability', f.kit.capability], { ...f.env, IA_CORE_RUN_ROOT: '' });
  assert.equal(unbound.status, 0, unbound.stdout + unbound.stderr);
  assert.equal(unbound.json.binding.via, 'unbound');
  assert.doesNotMatch(f.spawned(), /check ran/);
  const inside = f.resolve(['--kit', f.kit.id, '--capability', f.kit.capability], { IA_CORE_RUN_ROOT: '' });
  assert.equal(inside.json.error.code, 'IA-CORE-UNBOUND-IN-WORKSPACE', 'inside a workspace --kit is still refused, as before');
});

test('--kit with no binding in a workspace still runs (the plugin-only route)', t => {
  const f = fixture(t, { bindings: false });
  const checked = f.check(['--kit', f.kit.id]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(f.spawned(), /check ran/);
});

test('--kit naming a bound, uninstalled kit refuses', t => {
  const f = fixture(t, { lock: unrelatedLock });
  const before = f.snapshot();
  assertRefused(f, f.check(['--kit', f.kit.id]), 'check --kit');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.spawned(), '');
});

test('check refuses when any carried kit the bindings name is not installed, not only the one that declares the check', t => {
  const f = fixture(t, { lock: packagesLock() });
  makeKit(join(f.dir, 'kits'), { folder: 'second', id: 'inventarch/second-kit', capability: 'x', playbook: 'x', checks: [] });
  writeFileSync(join(f.repo, '.ia', 'bindings.json'), JSON.stringify({ format: 1, bindings: { 'work.task': { kit: f.kit.id, capability: f.kit.capability }, 'knowledge.find': { kit: 'inventarch/second-kit', capability: 'x' } } }));
  const ran = f.check();
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.equal(ran.json.error.code, NOT_INSTALLED);
  assert.ok(ran.json.error.message.includes('inventarch/second-kit'));
  assert.equal(f.spawned(), '');
});
