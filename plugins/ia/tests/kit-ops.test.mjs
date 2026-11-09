// The kit lookup and the user verbs of scripts/kit.mjs (decision
// public-kit-lookup): a kit is found in the plugin's kit folder first, then in
// <IA home>/kits/<kit>/<version>/ (newest version, plugin wins on an id);
// add --from validates a kit before installing it and never overwrites an
// installed version; bind, rebind and upgrade preview unless --apply; check
// reports a kit whose sources are not its latest release.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { sourcesDigest } from '../scripts/lib/kit.mjs';
import { installTarget } from '../scripts/lib/kit-ops.mjs';
import { kitRecordNames } from '../scripts/lib/records.mjs';
import { envFor, fakeCli, installLock, makeKit, makeRepo, run, sandbox } from './helpers/fixtures.mjs';

const first = value => (Array.isArray(value) ? value[0] : value);

// Makes a fake kit's latest release describe its sources, in format 2, as a packed release would.
function released(kit) {
  const index = JSON.parse(readFileSync(join(kit.dir, 'releases.json'), 'utf8'));
  const [row] = index.releases;
  const { records, ...rest } = row;
  const file = `releases/${row.version}.json`;
  mkdirSync(join(kit.dir, 'releases'), { recursive: true });
  writeFileSync(join(kit.dir, file), JSON.stringify({ format: 2, kit: index.kit, version: row.version, archive: row.archive, records: kitRecordNames(kit.dir) }, null, 2) + '\n');
  writeFileSync(join(kit.dir, 'releases.json'), JSON.stringify({ format: 2, kit: index.kit, latest: row.version, releases: [{ ...rest, sources: sourcesDigest(kit.dir), file }] }, null, 2) + '\n');
  return kit;
}

function setup(t) {
  const dir = sandbox(t, 'ia-core-kitops-');
  const kitsDir = join(dir, 'kits'), home = join(dir, 'ia-home');
  mkdirSync(home, { recursive: true });
  const env = { ...envFor({ cli: fakeCli(dir), kitsDir, temp: dir }), IA_HOME: home };
  delete env.IA_CORE_NO_HOME_KITS;
  return { dir, kitsDir, home, env, kit: (...args) => run('kit.mjs', args, env) };
}

test('a kit installed in the IA home is found after the plugin\'s own kits, newest version first, and the plugin wins on an id', t => {
  const s = setup(t);
  released(makeKit(s.kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' }));
  for (const version of ['0.1.0', '0.2.0']) released(makeKit(join(s.home, 'kits', 'beta'), { folder: version, id: 'inventarch/beta-kit', version }));
  released(makeKit(join(s.home, 'kits', 'alpha'), { folder: '0.9.0', id: 'inventarch/alpha-kit', version: '0.9.0' }));
  const listed = s.kit('list');
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const kits = Object.fromEntries(listed.json.kits.map(k => [k.id, k]));
  assert.deepEqual(Object.keys(kits), ['inventarch/alpha-kit', 'inventarch/beta-kit']);
  assert.equal(kits['inventarch/alpha-kit'].origin, 'plugin');
  assert.equal(kits['inventarch/alpha-kit'].version, '0.1.0', 'the carried copy wins over the home copy');
  assert.equal(kits['inventarch/beta-kit'].origin, 'home');
  assert.equal(kits['inventarch/beta-kit'].version, '0.2.0', 'the newest installed version');
  assert.deepEqual(kits['inventarch/alpha-kit'].surfaced, [], 'a kit that offers no key surfaces nothing');
  assert.equal(s.kit('check', 'inventarch/beta-kit').json.status, 'passed');
  // With IA_CORE_KITS_DIR and no IA_HOME, a test never reads a home.
  const env = { ...s.env };
  delete env.IA_HOME;
  assert.deepEqual(run('kit.mjs', ['list'], env).json.kits.map(k => k.id), ['inventarch/alpha-kit']);
});

test('add --from validates, previews, installs once into <IA home>/kits/<kit>/<version>/ and never overwrites', t => {
  const s = setup(t);
  const source = released(makeKit(join(s.dir, 'incoming'), { folder: 'gamma', id: 'inventarch/gamma-kit', version: '1.2.0' }));
  const preview = s.kit('add', '--from', source.dir);
  assert.equal(preview.status, 0, preview.stdout);
  assert.equal(preview.json.wouldInstall, true);
  const target = join(s.home, 'kits', 'gamma', '1.2.0');
  assert.equal(existsSync(target), false, 'a preview writes nothing');
  const applied = s.kit('add', '--from', source.dir, '--apply');
  assert.equal(applied.json.installed, true, applied.stdout);
  assert.ok(existsSync(join(target, 'releases.json')));
  assert.equal(s.kit('list').json.kits.find(k => k.id === 'inventarch/gamma-kit').origin, 'home');
  assert.equal(s.kit('add', '--from', source.dir, '--apply').json.already, true, 'the same bytes again are already installed');
  writeFileSync(join(source.dir, '.ia', 'src', 'workspace.ia'), readFileSync(join(source.dir, '.ia', 'src', 'workspace.ia'), 'utf8') + '\n');
  const drifted = s.kit('add', '--from', source.dir, '--apply');
  assert.equal(drifted.status, 1);
  assert.equal(drifted.json.error.code, 'IA-CORE-KIT-INVALID', 'sources that are not the latest release are refused before anything is written');
  const unreleased = makeKit(join(s.dir, 'raw'), { folder: 'delta', id: 'inventarch/delta-kit' });
  assert.match(s.kit('add', '--from', unreleased.dir).json.error.message, /sources digest differs|lists other records/);
});

// A crafted kit folder: its index, per-version file and descriptor all name `version`, and the sources digest is
// recomputed, so only the version itself can refuse it.
function crafted(kit, version) {
  const descriptorPath = join(kit.dir, '.ia', 'release.json');
  writeFileSync(descriptorPath, JSON.stringify({ ...JSON.parse(readFileSync(descriptorPath, 'utf8')), version }, null, 2) + '\n');
  const index = JSON.parse(readFileSync(join(kit.dir, 'releases.json'), 'utf8'));
  const [row] = index.releases;
  const file = `releases/${version}.json`;
  mkdirSync(join(kit.dir, file, '..'), { recursive: true });
  writeFileSync(join(kit.dir, file), JSON.stringify({ format: 2, kit: index.kit, version, archive: row.archive, records: kitRecordNames(kit.dir) }) + '\n');
  writeFileSync(join(kit.dir, 'releases.json'), JSON.stringify({ format: 2, kit: index.kit, latest: version, releases: [{ ...row, version, sources: sourcesDigest(kit.dir), file }] }) + '\n');
  return kit;
}

test('add --from refuses a release version that names a path, and writes nothing outside the IA home', t => {
  const s = setup(t);
  const escaped = '../../../escaped-kit';
  const kit = crafted(released(makeKit(join(s.dir, 'incoming'), { folder: 'evil', id: 'inventarch/evil-kit' })), escaped);
  for (const args of [['add', '--from', kit.dir], ['add', '--from', kit.dir, '--apply']]) {
    const refused = s.kit(...args);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.json.error.message, /release 0's version "\.\.\/\.\.\/\.\.\/escaped-kit" is not a semver version/);
  }
  assert.equal(existsSync(join(s.home, 'kits')), false);
  assert.equal(existsSync(join(s.home, '..', 'escaped-kit')), false, 'nothing lands where the version points');
  // A sound release index with a descriptor that names a path is refused too.
  const other = released(makeKit(join(s.dir, 'other'), { folder: 'odd', id: 'inventarch/odd-kit' }));
  const descriptorPath = join(other.dir, '.ia', 'release.json');
  writeFileSync(descriptorPath, JSON.stringify({ ...JSON.parse(readFileSync(descriptorPath, 'utf8')), version: escaped }, null, 2) + '\n');
  const odd = s.kit('add', '--from', other.dir, '--apply');
  assert.equal(odd.json.error.code, 'IA-CORE-KIT-INVALID', odd.stdout);
  assert.match(odd.json.error.message, /\.ia\/release\.json version "\.\.\/\.\.\/\.\.\/escaped-kit" is not a semver version/);
  assert.equal(existsSync(join(s.home, 'kits')), false);
});

test('an install target is <IA home>/kits/<folder>/<semver version> and nothing else', () => {
  const home = join('ia-home', 'kits');
  assert.equal(installTarget(home, 'gamma', '1.2.0'), resolve(home, 'gamma', '1.2.0'));
  for (const [folder, version] of [['gamma', '../../../escaped-kit'], ['gamma', '..'], ['gamma', '1.2'], ['..', '1.2.0'], ['../outside', '1.2.0'], ['gamma/../..', '1.2.0']]) {
    assert.throws(() => installTarget(home, folder, version), e => e.code === 'IA-CORE-KIT-INVALID', `${folder} ${version}`);
  }
});

test('add --from refuses a kit folder that holds a link, before anything is written', t => {
  const s = setup(t);
  const kit = released(makeKit(join(s.dir, 'incoming'), { folder: 'linked', id: 'inventarch/linked-kit' }));
  const outside = join(s.dir, 'outside');
  mkdirSync(outside);
  try { symlinkSync(outside, join(kit.dir, 'docs'), 'junction'); } catch (error) { return t.skip(`cannot create a folder link here: ${error.code}`); }
  const refused = s.kit('add', '--from', kit.dir, '--apply');
  assert.equal(refused.json.error.code, 'IA-CORE-KIT-INVALID', refused.stdout);
  assert.match(refused.json.error.message, /is a link or another kind of entry/);
  assert.equal(existsSync(join(s.home, 'kits')), false);
});

test('bind recommends a kit\'s keys and writes only with --apply; one key can be set and must name a record of the kit', t => {
  const s = setup(t);
  const alpha = released(makeKit(s.kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', capability: 'alpha-operate' }));
  writeFileSync(join(alpha.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'work.*': { capability: 'alpha-operate' } } }) + '\n');
  released(alpha);
  // A binding to a kit runs only while the lock installs it, so the repository's lock installs alpha (decision public-cli-3-6-0-bind).
  const repo = makeRepo(join(s.dir, 'repo'), { lock: installLock({ bindings: { 'work.*': { kit: alpha.id } } }) });
  assert.deepEqual(run('kit.mjs', ['list'], s.env).json.kits[0].surfaced, ['ia-work'], 'work.* reads ia-work');
  writeFileSync(join(alpha.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'work.*': { capability: 'alpha-operate' }, 'work.brainstorm': { capability: 'alpha-operate' } } }) + '\n');
  assert.deepEqual(run('kit.mjs', ['list'], s.env).json.kits[0].surfaced, ['ia-work', 'ia-work:brainstorm'], 'a binding key re-spelled, whichever kit supplies it');
  writeFileSync(join(alpha.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'work.*': { capability: 'alpha-operate' } } }) + '\n');
  released(alpha);
  const preview = run('kit.mjs', ['bind', alpha.id, repo], s.env);
  assert.deepEqual(preview.json.wouldAdd, ['work.*']);
  assert.equal(existsSync(join(repo, '.ia', 'bindings.json')), false);
  const applied = run('kit.mjs', ['bind', alpha.id, repo, '--apply'], s.env);
  assert.deepEqual(applied.json.added, ['work.*']);
  assert.deepEqual(first(JSON.parse(readFileSync(join(repo, '.ia', 'bindings.json'), 'utf8')).bindings['work.*']), { kit: alpha.id, capability: 'alpha-operate' });
  const refused = run('kit.mjs', ['bind', alpha.id, repo, '--key', 'work.plan', '--capability', 'missing', '--apply'], s.env);
  assert.equal(refused.json.error.code, 'IA-CORE-BIND-UNDECLARED');
  const one = run('kit.mjs', ['bind', alpha.id, repo, '--key', 'work.plan', '--capability', 'alpha-operate', '--apply'], s.env);
  assert.equal(one.json.applied, true, one.stdout);
});

test('bind refuses a kit the lock does not install, on a preview and on --apply, with a key or without, and writes nothing', t => {
  const s = setup(t);
  const alpha = released(makeKit(s.kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', capability: 'alpha-operate' }));
  writeFileSync(join(alpha.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'work.*': { capability: 'alpha-operate' } } }) + '\n');
  released(alpha);
  const repo = makeRepo(join(s.dir, 'repo'), { lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: 'inventarch/language', version: '3.2.0', archive: 'b'.repeat(64) }] } });
  const lockBefore = readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8');
  for (const args of [[], ['--apply'], ['--key', 'work.plan', '--capability', 'alpha-operate'], ['--key', 'work.plan', '--capability', 'alpha-operate', '--apply']]) {
    const refused = run('kit.mjs', ['bind', alpha.id, repo, ...args], s.env);
    assert.equal(refused.status, 1, refused.stdout);
    assert.equal(refused.json.error.code, 'IA-CORE-KIT-NOT-INSTALLED', refused.stdout);
    assert.equal(refused.json.error.kit, alpha.id);
    assert.match(refused.json.error.message, new RegExp(`run kit\\.mjs bind ${alpha.id} --install --apply`), 'the remedy names the install route');
    assert.equal(existsSync(join(repo, '.ia', 'bindings.json')), false, args.join(' '));
  }
  assert.equal(readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8'), lockBefore);
  // No workspace: refused as well, never a preview of keys that could not run.
  const none = run('kit.mjs', ['bind', alpha.id, join(s.dir, 'not-a-repo')], s.env);
  assert.equal(none.json.error.code, 'IA-CORE-KIT-NOT-INSTALLED', none.stdout);
  assert.match(none.json.error.message, /run ia init first/);
});

test('rebind moves keys to another kit only when the target has the capability, and previews unless --apply', t => {
  const s = setup(t);
  const old = released(makeKit(s.kitsDir, { folder: 'old', id: 'inventarch/old-kit', capability: 'shared-operate' }));
  const next = released(makeKit(s.kitsDir, { folder: 'new', id: 'inventarch/new-kit', capability: 'shared-operate' }));
  released(makeKit(s.kitsDir, { folder: 'other', id: 'inventarch/other-kit', capability: 'other-operate' }));
  const repo = makeRepo(join(s.dir, 'repo'), { bindings: { format: 1, bindings: { 'work.*': { kit: old.id, capability: 'shared-operate' }, 'work.plan': { kit: old.id, capability: 'shared-operate' } }, precedence: [old.id], defaults: {} } });
  const preview = run('kit.mjs', ['rebind', old.id, next.id, repo, '--keys', 'work.plan'], s.env);
  assert.deepEqual(preview.json.wouldMove, ['work.plan']);
  assert.equal(first(JSON.parse(readFileSync(join(repo, '.ia', 'bindings.json'), 'utf8')).bindings['work.plan']).kit, old.id);
  const applied = run('kit.mjs', ['rebind', old.id, next.id, repo, '--apply'], s.env);
  assert.deepEqual(applied.json.moved.sort(), ['work.*', 'work.plan']);
  const data = JSON.parse(readFileSync(join(repo, '.ia', 'bindings.json'), 'utf8'));
  assert.equal(first(data.bindings['work.*']).kit, next.id);
  assert.deepEqual(data.precedence, [next.id]);
  const refused = run('kit.mjs', ['rebind', next.id, 'inventarch/other-kit', repo, '--apply'], s.env);
  assert.equal(refused.json.applied, false);
  assert.equal(refused.json.refused.length, 2, 'the target has no shared-operate, so nothing moves');
});

test('upgrade lists installed kits behind their latest release and changes nothing without --apply', t => {
  const s = setup(t);
  const alpha = released(makeKit(s.kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', version: '0.2.0' }));
  const repo = makeRepo(join(s.dir, 'repo'), { lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: 'inventarch/language', version: '3.2.0', archive: 'a'.repeat(64) }, { id: alpha.id, version: '0.1.0', archive: 'e'.repeat(64) }] } });
  const lock = readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8');
  const out = run('kit.mjs', ['upgrade', repo], s.env);
  assert.equal(out.status, 0, out.stdout);
  assert.deepEqual(out.json.wouldUpgrade, [alpha.id]);
  assert.equal(out.json.plan[0].installed.version, '0.1.0');
  assert.equal(out.json.plan[0].latest.version, '0.2.0');
  assert.equal(readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8'), lock);
});

test('check refuses a kit whose sources drifted from its latest release, and repin needs a task', t => {
  const s = setup(t);
  const alpha = released(makeKit(s.kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' }));
  assert.equal(s.kit('check').json.status, 'passed');
  cpSync(join(alpha.dir, 'checks.json'), join(alpha.dir, 'checks.json.bak'));
  writeFileSync(join(alpha.dir, '.ia', 'src', 'systems', 'fake-system', 'system.ia'), '#! ia 1.0\n\n@system fake-system\n  meaning\n    says "Changed."\n');
  const drifted = s.kit('check');
  assert.equal(drifted.status, 1);
  assert.match(drifted.json.kits[0].problems.join(' '), /sources digest differs/);
  const repo = makeRepo(join(s.dir, 'repo'));
  assert.equal(run('kit.mjs', ['repin', repo], s.env).status, 2, 'repin without a task is a usage error');
});
