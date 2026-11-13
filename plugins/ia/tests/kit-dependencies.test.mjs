// Kit dependencies (contract C3, decision public-kit-dependencies): a kit
// whose .ia/release.json depends on another kit resolves that kit carried by
// the plugin, installed in the IA home or next to it, and adoption and the
// restored read root vendor its recorded release with ia install --catalog.
// The two-kit fixture is tests/helpers/kit-pair.mjs (fx-app depends on
// fx-base). The lookups run in every gate; packing, restoring and installing
// with the real CLI are opt-in: IA_CORE_TEST_CLI=<@inventarch/cli dist/main.js>.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { adopt, findKit, kitDependencies, readRoot, satisfies } from '../scripts/lib/kit.mjs';
import { resolveCli, runIa } from '../scripts/lib/cli.mjs';
import { addFromOp } from '../scripts/lib/kit-ops.mjs';
import { sandbox } from './helpers/fixtures.mjs';
import { APP_ID, BASE_ID, recordPair, writePair } from './helpers/kit-pair.mjs';

const CLI = process.env.IA_CORE_TEST_CLI;
const SKIP = !CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli 3.8.0 dist/main.js';

// Points the core at an empty plugin kit folder and, when given, an IA home.
function isolate(t, dir, home) {
  const saved = { kits: process.env.IA_CORE_KITS_DIR, home: process.env.IA_HOME };
  mkdirSync(join(dir, 'plugin-kits'), { recursive: true });
  process.env.IA_CORE_KITS_DIR = join(dir, 'plugin-kits');
  if (home) process.env.IA_HOME = home; else delete process.env.IA_HOME;
  t.after(() => {
    for (const [name, value] of [['IA_CORE_KITS_DIR', saved.kits], ['IA_HOME', saved.home]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

test('a dependency range admits the releases it names', () => {
  for (const [version, range, expected] of [
    ['0.1.0', '^0.1.0', true], ['0.1.7', '^0.1.0', true], ['0.2.0', '^0.1.0', false], ['0.0.9', '^0.1.0', false],
    ['1.4.2', '^1.2.0', true], ['2.0.0', '^1.2.0', false], ['0.1.3', '~0.1.0', true], ['0.2.0', '~0.1.0', false],
    ['3.0.0', '>=2.0.0', true], ['0.1.0', '0.1.0', true], ['0.1.1', '0.1.0', false], ['9.9.9', '*', true], ['not', '^0.1.0', false],
  ]) assert.equal(satisfies(version, range), expected, `${version} against ${range}`);
});

test('a kit finds its dependency next to it in a source tree, and refuses when it is missing or out of range', t => {
  const dir = sandbox(t, 'ia-core-deps-');
  isolate(t, dir);
  const pair = writePair(dir);
  const app = findKit(APP_ID, pair.kits);
  assert.deepEqual(kitDependencies(app).map(k => [k.id, k.latest.version, k.origin]), [[BASE_ID, '0.1.0', 'source']]);
  // Out of range: the only fx-base is 0.1.0, and fx-app now asks for ^0.2.0.
  const descriptor = join(pair.app, '.ia', 'release.json');
  const original = readFileSync(descriptor, 'utf8');
  writeFileSync(descriptor, original.replace('"range": "^0.1.0"', '"range": "^0.2.0"'));
  assert.throws(() => kitDependencies(findKit(APP_ID, pair.kits)), e => e.code === 'IA-CORE-KIT-DEPENDENCY' && /found only as 0\.1\.0 \(source\)/.test(e.message));
  writeFileSync(descriptor, original);
  // Missing: fx-app alone in another folder, with nothing carried or installed.
  cpSync(pair.app, join(dir, 'alone', 'fx-app'), { recursive: true });
  assert.throws(() => kitDependencies(findKit(APP_ID, join(dir, 'alone'))), e => e.code === 'IA-CORE-KIT-DEPENDENCY' && /add --from/.test(e.message));
});

test('a dependency cycle is refused', t => {
  const dir = sandbox(t, 'ia-core-deps-');
  isolate(t, dir);
  const pair = writePair(dir);
  const descriptor = join(pair.base, '.ia', 'release.json');
  const parsed = JSON.parse(readFileSync(descriptor, 'utf8'));
  parsed.dependencies.unshift({ id: APP_ID, range: '^0.1.0', systems: ['fx-app'] });
  writeFileSync(descriptor, JSON.stringify(parsed, null, 2));
  assert.throws(() => kitDependencies(findKit(APP_ID, pair.kits)), e => e.code === 'IA-CORE-KIT-DEPENDENCY' && /cycle: inventarch\/fx-app-kit -> inventarch\/fx-base-kit -> inventarch\/fx-app-kit/.test(e.message));
});

test('add --from installs a kit into the IA home only once its dependency is found, and names it', t => {
  const dir = sandbox(t, 'ia-core-deps-');
  const home = join(dir, 'home');
  isolate(t, dir, home);
  const pair = writePair(dir);
  // fx-app copied alone: its dependency is neither beside it nor in the home yet.
  const alone = join(dir, 'alone', 'fx-app');
  cpSync(pair.app, alone, { recursive: true });
  assert.throws(() => addFromOp(alone, { apply: true }), e => e.code === 'IA-CORE-KIT-DEPENDENCY' && e.message.includes(BASE_ID));
  const base = addFromOp(pair.base, { apply: true });
  assert.equal(base.installed, true);
  assert.deepEqual(base.dependencies, []);
  const preview = addFromOp(alone);
  assert.equal(preview.wouldInstall, true);
  assert.deepEqual(preview.dependencies.map(d => [d.kit, d.version, d.origin]), [[BASE_ID, '0.1.0', 'home']]);
  const app = addFromOp(alone, { apply: true });
  assert.equal(app.installed, true);
  assert.equal(app.target, join(home, 'kits', 'fx-app', '0.1.0'));
  // Installed in the home, fx-app finds fx-base there too.
  assert.deepEqual(kitDependencies(findKit(APP_ID)).map(k => [k.id, k.origin]), [[BASE_ID, 'home']]);
});

test('add --from of a kit whose dependency sits next to it in a source tree installs the dependency alongside, so the installed kit resolves it', t => {
  const dir = sandbox(t, 'ia-core-deps-');
  const home = join(dir, 'home');
  isolate(t, dir, home);
  const pair = writePair(dir);
  const preview = addFromOp(pair.app);
  assert.equal(preview.wouldInstall, true);
  assert.deepEqual(preview.dependencies.map(d => [d.kit, d.origin]), [[BASE_ID, 'source']]);
  assert.deepEqual(preview.alongside, [{ kit: BASE_ID, version: '0.1.0', target: join(home, 'kits', 'fx-base', '0.1.0'), wouldInstall: true }]);
  assert.equal(existsSync(join(home, 'kits')), false, 'a preview writes nothing');
  const app = addFromOp(pair.app, { apply: true });
  assert.equal(app.installed, true);
  assert.deepEqual(app.alongside.map(a => [a.kit, a.installed]), [[BASE_ID, true]]);
  // The reviewer's probe: the installed kit, not its source, resolves its dependency from the home.
  const installed = findKit(APP_ID);
  assert.equal(installed.origin, 'home');
  assert.equal(installed.dir, join(home, 'kits', 'fx-app', '0.1.0'));
  assert.deepEqual(kitDependencies(installed).map(k => [k.id, k.origin, k.dir]), [[BASE_ID, 'home', join(home, 'kits', 'fx-base', '0.1.0')]]);
  // Again: fx-app is already there, fx-base is now found in the home, and nothing is written.
  const again = addFromOp(pair.app, { apply: true });
  assert.deepEqual([again.already, again.applied, again.alongside, again.dependencies.map(d => d.origin)], [true, false, [], ['home']]);
});

test('real CLI: fx-app restores and adopts with fx-base vendored, and the lock pins both releases (opt-in: IA_CORE_TEST_CLI)', { skip: SKIP }, t => {
  const dir = sandbox(t, 'ia-core-deps-');
  isolate(t, dir);
  const cli = resolveCli(dir, { env: { IA_CLI_PATH: CLI } });
  assert.equal(cli.version, '3.8.0');
  const pair = recordPair(dir, cli);
  assert.deepEqual(pair.lock.packages.map(p => p.id).sort(), [BASE_ID, 'inventarch/language']);
  const app = findKit(APP_ID, pair.kits);

  // The read root: restored with fx-base's recorded release in its catalog; the position admits fx-app's seat.
  const root = readRoot(app, { cli, base: join(dir, 'cache') });
  const position = runIa(root, ['position'], { cli });
  assert.equal(position.json?.ok, true, position.stdout + position.stderr);
  assert.equal(position.json.body.seat.identity, 'workspace-system/definition/workspace/fx-app-kit');

  // Adoption into a fresh workspace: the preview names the dependency, the install pins both releases.
  const repo = join(dir, 'repo');
  const init = spawnSync(process.execPath, [CLI, 'init', repo, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const preview = adopt(repo, app, { cli, dry: true });
  assert.deepEqual(preview.dependencies.map(d => [d.kit, d.archive]), [[BASE_ID, pair.baseArchive]]);
  assert.deepEqual(preview.requests, [`${APP_ID}@0.1.0`]);
  const adopted = adopt(repo, app, { cli });
  assert.deepEqual(adopted.dependencies.map(d => d.kit), [BASE_ID]);
  const lock = JSON.parse(readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8'));
  const pinned = Object.fromEntries(lock.packages.map(p => [p.id, p.archive]));
  assert.equal(pinned[APP_ID], pair.appArchive);
  assert.equal(pinned[BASE_ID], pair.baseArchive);
  const catalog = JSON.parse(readFileSync(join(repo, 'vendor', 'ia', 'catalog.json'), 'utf8')).map(e => e.path);
  assert.ok(catalog.includes(`vendor/ia/${pair.baseArchive}.ia.tgz`), 'the dependency is vendored');

  // Without its dependency fx-app adopts nothing: adopt refuses before any write.
  const lone = join(dir, 'lone');
  cpSync(pair.app, join(lone, 'fx-app'), { recursive: true });
  const other = join(dir, 'other');
  assert.equal(spawnSync(process.execPath, [CLI, 'init', other, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 180_000 }).status, 0);
  assert.throws(() => adopt(other, findKit(APP_ID, lone), { cli }), e => e.code === 'IA-CORE-KIT-DEPENDENCY');
});
