// kit.mjs bind --install (decisions public-cli-3-6-0-bind and public-cli-3-6-0-install-route): a binding to a kit the
// lock does not install is refused; --install installs the kit first. A kit the public-kits package carries goes
// through `ia install --package <name>@<version> --apply --yes` (seeding a language-only lock and restoring it when the
// workspace has none); any other kit goes through adopt. Everything runs against the stand-in CLI: no network, no npm.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { installForBind, kitInstallation } from '../scripts/lib/kit.mjs';
import { cliCalls, envFor, fakeCli, makeKit, makeRepo, run, sandbox } from './helpers/fixtures.mjs';

const PACKAGE = '@inventarch/public-kits@1.0.1';
const LANGUAGE = { id: 'inventarch/language', version: '3.2.0', archive: 'b'.repeat(64) };
const languageLock = () => ({ engine: '0.1.1', formatVersion: 1, packages: [LANGUAGE], requests: [{ id: 'inventarch/language', range: '^3.2.0' }] });

// A plugin that carries two kits (the package's), a package manifest naming 1.0.1, and a stand-in CLI that answers
// install --package for those two. `install` and the restore* options choose how the stand-in misbehaves.
function setup(t, cliOptions = {}, { manifest = { package: '@inventarch/public-kits', version: '1.0.1' } } = {}) {
  const dir = sandbox(t, 'ia-core-bindinstall-');
  const kitsDir = join(dir, 'kits'), home = join(dir, 'ia-home');
  mkdirSync(home, { recursive: true });
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', capability: 'alpha-operate' });
  const beta = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit', capability: 'beta-operate' });
  writeFileSync(join(alpha.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'work.*': { capability: 'alpha-operate' } } }) + '\n');
  const packageKits = [alpha, beta].map(k => ({ id: k.id, version: k.version, archive: k.archive }));
  const cli = fakeCli(dir, '3.6.0', { packageKits, ...cliOptions });
  const manifestPath = join(dir, 'public-kits.json');
  if (manifest !== null) writeFileSync(manifestPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  const env = { ...envFor({ cli, kitsDir, temp: dir, extra: { IA_CORE_PUBLIC_KITS: manifestPath } }), IA_HOME: home };
  delete env.IA_CORE_NO_HOME_KITS;
  return { dir, kitsDir, home, alpha, beta, cli, env, manifestPath, calls: () => cliCalls(cli), kit: (...args) => run('kit.mjs', args, env) };
}

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const lockOf = repo => read(join(repo, '.ia', 'distributions.lock.json'));
const bindingsPath = repo => join(repo, '.ia', 'bindings.json');

test('without a lock, --install seeds a language-only lock, restores it, installs the package and binds the keys', t => {
  const s = setup(t);
  const repo = makeRepo(join(s.dir, 'repo'));
  const applied = s.kit('bind', s.alpha.id, repo, '--install', '--apply');
  assert.equal(applied.status, 0, applied.stdout);
  assert.deepEqual(applied.json.added, ['work.*']);
  assert.equal(applied.json.install.route, 'package');
  assert.equal(applied.json.install.package, PACKAGE);
  assert.equal(applied.json.install.seeded, true);
  assert.deepEqual(applied.json.install.added.map(a => a.kit).sort(), [s.alpha.id, s.beta.id], 'the package installs all of its kits');
  assert.deepEqual(s.calls().map(c => c.slice(0, 2)), [['restore', '--apply'], ['install', '--package']], 'restore, then install, nothing else');
  assert.deepEqual(s.calls()[1].slice(0, 5), ['install', '--package', PACKAGE, '--apply', '--yes']);
  const lock = lockOf(repo);
  assert.deepEqual(lock.packages.map(p => p.id), ['inventarch/language'], 'the seeded lock held only the language base');
  assert.deepEqual(lock.requests, [{ id: 'inventarch/language', range: '^3.2.0' }]);
  assert.equal(lock.entries[0].kind, 'package');
  assert.deepEqual(kitInstallation(repo, s.alpha.id)?.via, 'entry');
  const bound = read(bindingsPath(repo)).bindings['work.*'];
  assert.equal((Array.isArray(bound) ? bound[0] : bound).kit, s.alpha.id);
});

test('--install on a preview runs nothing and writes nothing, and lists the commands it would run', t => {
  const s = setup(t);
  const repo = makeRepo(join(s.dir, 'repo'));
  const preview = s.kit('bind', s.alpha.id, repo, '--install');
  assert.equal(preview.status, 0, preview.stdout);
  assert.equal(preview.json.applied, false);
  assert.deepEqual(preview.json.wouldAdd, ['work.*']);
  assert.deepEqual(preview.json.install.commands, ['ia restore --apply --yes', `ia install --package ${PACKAGE} --apply --yes`]);
  assert.deepEqual(s.calls(), [], 'no CLI call');
  assert.equal(existsSync(join(repo, '.ia', 'distributions.lock.json')), false);
  assert.equal(existsSync(bindingsPath(repo)), false);
  // With a lock already, there is nothing to seed or restore.
  const locked = makeRepo(join(s.dir, 'locked'), { lock: languageLock() });
  assert.deepEqual(s.kit('bind', s.alpha.id, locked, '--install').json.install.commands, [`ia install --package ${PACKAGE} --apply --yes`]);
  assert.deepEqual(s.calls(), []);
});

test('--install with no workspace refuses on a preview and on --apply, and runs nothing', t => {
  const s = setup(t);
  for (const args of [['--install'], ['--install', '--apply'], ['--install', '--key', 'work.plan', '--capability', 'alpha-operate']]) {
    const refused = s.kit('bind', s.alpha.id, join(s.dir, 'nowhere'), ...args);
    assert.equal(refused.status, 1, refused.stdout);
    assert.equal(refused.json.error.code, 'IA-CORE-KIT-NOT-INSTALLED');
    assert.match(refused.json.error.message, /run ia init first/);
  }
  assert.deepEqual(s.calls(), []);
});

test('a second --install finds the kit installed and makes no CLI call', t => {
  const s = setup(t);
  const repo = makeRepo(join(s.dir, 'repo'));
  assert.equal(s.kit('bind', s.alpha.id, repo, '--install', '--apply').status, 0);
  const before = s.calls().length;
  const lockBefore = readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8');
  const again = s.kit('bind', s.alpha.id, repo, '--install', '--apply');
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.json.install.already, true);
  assert.deepEqual(again.json.added, [], 'the keys are bound already');
  assert.equal(s.calls().length, before);
  assert.equal(readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8'), lockBefore);
  // The other carried kit came with the package: binding it needs no install.
  const other = s.kit('bind', s.beta.id, repo, '--install', '--apply');
  assert.equal(other.json.install.already, true);
  assert.equal(s.calls().length, before);
});

test('a failing restore leaves nothing behind: no lock, no generation, no bindings', t => {
  const s = setup(t, { restoreUnavailable: true });
  const repo = makeRepo(join(s.dir, 'repo'));
  const refused = s.kit('bind', s.alpha.id, repo, '--install', '--apply');
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json.error.code, 'IA-DIST-ARTIFACT-UNAVAILABLE');
  assert.deepEqual(s.calls().map(c => c[0]), ['restore']);
  assert.equal(existsSync(join(repo, '.ia', 'distributions.lock.json')), false);
  assert.equal(existsSync(join(repo, '.ia', 'distributions')), false);
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('a restore that succeeds and an install that refuses restores the snapshot: the seeded lock and generation are removed', t => {
  const s = setup(t, { install: 'refuse' });
  const repo = makeRepo(join(s.dir, 'repo'));
  const refused = s.kit('bind', s.alpha.id, repo, '--install', '--apply');
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json.error.code, 'IA-DIST-CONFLICT');
  assert.deepEqual(s.calls().map(c => c[0]), ['restore', 'install']);
  assert.equal(existsSync(join(repo, '.ia', 'distributions.lock.json')), false, 'the seeded lock is gone');
  assert.equal(existsSync(join(repo, '.ia', 'distributions')), false, 'the generation the restore wrote is gone');
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('an existing lock is never seeded over: the CLI judges it, and a refusal leaves its bytes as they were', t => {
  const s = setup(t, { install: 'refuse' });
  const repo = makeRepo(join(s.dir, 'repo'), { lock: languageLock() });
  mkdirSync(join(repo, '.ia', 'distributions'), { recursive: true });
  writeFileSync(join(repo, '.ia', 'distributions', 'active.json'), '{"generation":4}');
  const lockBefore = readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8');
  const refused = s.kit('bind', s.alpha.id, repo, '--install', '--apply');
  assert.equal(refused.json.error.code, 'IA-DIST-CONFLICT', refused.stdout);
  assert.match(refused.json.error.message, /ia inspect/, "the conflict comes with a hint");
  assert.doesNotMatch(refused.json.error.message, /upgrade/);
  assert.deepEqual(s.calls().map(c => c[0]), ['install'], 'no restore: nothing was seeded');
  assert.equal(readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8'), lockBefore);
  assert.equal(readFileSync(join(repo, '.ia', 'distributions', 'active.json'), 'utf8'), '{"generation":4}');
});

test('a package that is not published yet is refused with the retry hint, and the snapshot is restored', t => {
  const s = setup(t, { install: 'notfound' });
  const repo = makeRepo(join(s.dir, 'repo'));
  const refused = s.kit('bind', s.alpha.id, repo, '--install', '--apply');
  assert.equal(refused.json.error.code, 'IA-CLI-KITS-PACKAGE-UNAVAILABLE', refused.stdout);
  assert.match(refused.json.error.message, new RegExp(`if ${PACKAGE} is not published yet, retry after the release publishes it; npm must be on PATH and the registry reachable`, 'i'));
  assert.equal(existsSync(join(repo, '.ia', 'distributions.lock.json')), false);
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('a direct package row for a kit the package carries is refused before any CLI call, naming kit.mjs add', t => {
  const s = setup(t);
  const lock = { ...languageLock(), packages: [LANGUAGE, { id: s.beta.id, version: '0.1.0', archive: s.beta.archive }] };
  const repo = makeRepo(join(s.dir, 'repo'), { lock });
  const lockBefore = readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8');
  for (const args of [['--install'], ['--install', '--apply']]) {
    const refused = s.kit('bind', s.alpha.id, repo, ...args);
    assert.equal(refused.status, 1, refused.stdout);
    assert.equal(refused.json.error.code, 'IA-CORE-INSTALL-CONFLICT');
    const message = refused.json.error.message;
    assert.match(message, new RegExp(`install ${s.alpha.id} the direct way instead, as the lock's other kits are, with kit\\.mjs add ${s.alpha.id} --apply`));
    assert.doesNotMatch(message, /ia remove/);
    assert.doesNotMatch(message, /upgrade/);
  }
  assert.deepEqual(s.calls(), []);
  assert.equal(readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8'), lockBefore);
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('bind without --install over a direct package row names kit.mjs add, not bind --install', t => {
  const s = setup(t);
  const lock = { ...languageLock(), packages: [LANGUAGE, { id: s.beta.id, version: '0.1.0', archive: s.beta.archive }] };
  const repo = makeRepo(join(s.dir, 'repo'), { lock });
  const refused = s.kit('bind', s.alpha.id, repo, '--apply');
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json.error.code, 'IA-CORE-KIT-NOT-INSTALLED');
  assert.match(refused.json.error.message, new RegExp(`kit\\.mjs add ${s.alpha.id} --apply`));
  assert.doesNotMatch(refused.json.error.message, /--install/);
  assert.deepEqual(s.calls(), []);
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('an install that does not exit on its own is uncertain: nothing is removed', t => {
  const s = setup(t, { install: 'hang' });
  const repo = makeRepo(join(s.dir, 'repo'));
  const env = { ...process.env, ...s.env };
  const kit = { id: s.alpha.id, origin: 'plugin', latest: null };
  const cli = { argv: [process.execPath, s.cli], version: '3.6.0', source: 'test' };
  assert.throws(() => installForBind(repo, kit, { apply: true, cli, env, installTimeoutMs: 1500 }), error => {
    assert.equal(error.code, 'IA-CORE-INSTALL-UNCERTAIN');
    assert.match(error.message, /ia install did not exit on its own/);
    return true;
  });
  assert.deepEqual(s.calls().map(c => c[0]), ['restore', 'install']);
  assert.equal(existsSync(join(repo, '.ia', 'distributions.lock.json')), true, 'the seeded lock stays for inspection');
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('an install that reports success without a row from the package entry is uncertain, not bound', t => {
  const s = setup(t, { install: 'norow' });
  const repo = makeRepo(join(s.dir, 'repo'));
  const refused = s.kit('bind', s.alpha.id, repo, '--install', '--apply');
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json.error.code, 'IA-CORE-INSTALL-UNCERTAIN');
  assert.match(refused.json.error.message, /does not install .* through the package entry/);
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('a kit the package does not carry goes through adopt, never through install --package', t => {
  const s = setup(t);
  const gamma = makeKit(join(s.home, 'kits', 'gamma'), { folder: '0.1.0', id: 'inventarch/gamma-kit', capability: 'gamma-operate' });
  assert.equal(gamma.version, '0.1.0');
  const repo = makeRepo(join(s.dir, 'repo'), { lock: languageLock() });
  const preview = s.kit('bind', 'inventarch/gamma-kit', repo, '--install');
  assert.equal(preview.status, 0, preview.stdout);
  assert.equal(preview.json.install.route, 'adopt');
  assert.match(preview.json.install.commands[0], /^ia install inventarch\/gamma-kit@0\.1\.0 --catalog vendor\/ia\/catalog\.json --apply --yes$/);
  assert.deepEqual(s.calls(), []);
  // Applying packs through the stand-in, which cannot pack: the refusal comes from adopt, and no package install ran.
  const applied = s.kit('bind', 'inventarch/gamma-kit', repo, '--install', '--apply');
  assert.equal(applied.status, 1, applied.stdout);
  assert.ok(!s.calls().some(c => c.includes('--package')), 'no ia install --package');
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('a missing or malformed package manifest sends a carried kit down the add route and never crashes', t => {
  for (const manifest of [null, '{ not json', '[]', { package: '@inventarch/public-kits' }]) {
    const s = setup(t, {}, { manifest });
    const repo = makeRepo(join(s.dir, 'repo'), { lock: languageLock() });
    const refused = s.kit('bind', s.alpha.id, repo);
    assert.equal(refused.json.error.code, 'IA-CORE-KIT-NOT-INSTALLED', refused.stdout);
    assert.match(refused.json.error.message, new RegExp(`run kit\\.mjs add ${s.alpha.id} --apply \\(or ia install ${s.alpha.id}\\)`));
    const preview = s.kit('bind', s.alpha.id, repo, '--install');
    assert.equal(preview.status, 0, preview.stdout);
    assert.equal(preview.json.install.route, 'adopt');
    assert.deepEqual(s.calls(), []);
  }
});

test('bind --key validates before installing: a bad key or capability refuses with no CLI call and nothing written', t => {
  const s = setup(t);
  const repo = makeRepo(join(s.dir, 'repo'));
  for (const args of [['--key', 'bad', '--capability', 'nope'], ['--key', 'work.plan', '--capability', 'nope'], ['--key', 'work.plan', '--capability', 'alpha-operate', '--profile', 'ghost'], ['--key', 'work.plan']]) {
    const refused = s.kit('bind', s.alpha.id, repo, ...args, '--install', '--apply');
    assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  }
  assert.deepEqual(s.calls(), []);
  assert.equal(existsSync(join(repo, '.ia', 'distributions.lock.json')), false);
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('an install that exits nonzero after the lock changed is uncertain: nothing is removed', t => {
  const s = setup(t, { install: 'mutatefail' });
  const repo = makeRepo(join(s.dir, 'repo'));
  const refused = s.kit('bind', s.alpha.id, repo, '--install', '--apply');
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json.error.code, 'IA-CORE-INSTALL-UNCERTAIN');
  assert.match(refused.json.error.message, /after the lock or the active generation changed/);
  assert.equal(lockOf(repo).entries[0].name, 'x', 'the changed lock stays as the CLI left it');
  assert.equal(existsSync(bindingsPath(repo)), false);
});

test('a CLI that cannot start ran nothing: the seeded lock is rolled back, with "could not start"', t => {
  const s = setup(t);
  const repo = makeRepo(join(s.dir, 'repo'));
  const kit = { id: s.alpha.id, origin: 'plugin', latest: null };
  const cli = { argv: [join(s.dir, 'no-such-executable')], version: '3.6.0', source: 'test' };
  assert.throws(() => installForBind(repo, kit, { apply: true, cli, env: { ...process.env, ...s.env } }), error => {
    assert.equal(error.code, 'IA-CORE-INSTALL-REFUSED');
    assert.match(error.message, /could not start/);
    return true;
  });
  assert.equal(existsSync(join(repo, '.ia', 'distributions.lock.json')), false, 'the seed is gone');
});
