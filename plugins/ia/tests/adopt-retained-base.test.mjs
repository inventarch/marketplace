// Exercise actual CLI restore/pack/install from published archive fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveCli, runIa } from '../scripts/lib/cli.mjs';
import { adopt, findKit, readLock, sha256File } from '../scripts/lib/kit.mjs';
import { sandbox } from './helpers/fixtures.mjs';

const entry = resolve(process.env.IA_CORE_TEST_CLI ?? 'node_modules/@inventarch/cli/dist/main.js');
const basesPath = join(dirname(entry), '../assets/bases.json');

test('native adopt vendors the retained consumer base and restores from a fresh workspace', { skip: !existsSync(basesPath) && 'requires the pinned CLI assets' }, t => {
  const dir = sandbox(t, 'ia-retained-base-');
  const producer = findKit('ia-method');
  const base = readLock(producer.dir).packages[0];
  const bases = JSON.parse(readFileSync(basesPath, 'utf8'));
  const retained = bases.find(x => x.version === '3.2.1');
  assert.notEqual(retained.archive, base.archive);
  const row = { ...base, ...retained, location: `sha256:${retained.archive}` };
  const request = { id: row.id, range: row.version };
  const lock = { ...readLock(producer.dir), packages: [row], requests: [request] };
  const cli = resolveCli(dir, { cliPath: entry });
  const initial = join(dir, 'initial');
  const lockPath = '.ia/distributions.lock.json';
  const archive = `vendor/ia/${retained.archive}.ia.tgz`;
  const catalog = 'vendor/ia/catalog.json';
  mkdirSync(initial);
  const scaffold = spawnSync(process.execPath, [entry, 'init', initial, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(scaffold.status, 0, scaffold.stdout + scaffold.stderr);
  writeFileSync(join(initial, lockPath), JSON.stringify(lock));
  const init = runIa(initial, ['restore', '--offline', '--apply', '--yes'], { cli });
  assert.equal(init.code, 0, init.stdout + init.stderr);
  const bad = join(dir, 'bad');
  cpSync(initial, bad, { recursive: true });
  writeFileSync(join(bad, lockPath), JSON.stringify({ ...lock, packages: [{ ...row, manifest: '0'.repeat(64) }] }));
  const snapshot = [join(bad, lockPath), join(bad, '.ia/distributions/active.json')].map(sha256File);
  assert.throws(() => adopt(bad, producer, { cli }), { code: 'IA-CORE-RETAINED-BASE' });
  assert.equal(existsSync(join(bad, 'vendor')), false);
  assert.deepEqual([join(bad, lockPath), join(bad, '.ia/distributions/active.json')].map(sha256File), snapshot);
  const dry = adopt(initial, producer, { cli, dry: true });
  assert.ok(dry.written.includes(join(initial, archive)));
  assert.equal(existsSync(join(initial, 'vendor')), false);
  const result = adopt(initial, producer, { cli });
  assert.ok(result.written.includes(join(initial, archive)));
  assert.deepEqual(readLock(initial).packages.find(x => x.id === row.id), row);
  assert.deepEqual(readLock(initial).requests.find(x => x.id === row.id), request);
  assert.equal(sha256File(join(initial, archive)), retained.archive);
  assert.equal(sha256File(join(initial, `vendor/ia/${base.archive}.ia.tgz`)), base.archive);
  const catalogBefore = readFileSync(join(initial, catalog));
  assert.equal(JSON.parse(catalogBefore).filter(x => x.path === archive && !x.withdrawn).length, 1);
  assert.equal(adopt(initial, producer, { cli }).already, true);
  assert.deepEqual(readFileSync(join(initial, catalog)), catalogBefore);

  // A fresh client carrying the same CLI but not this base has no fallback
  // from its own assets. It can restore only after receiving the vendor tree.
  const preload = join(dir, 'without-retained-base.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.readFileSync;
fs.readFileSync=function(path,...args){
  const data=original.call(this,path,...args);
  if(String(path).replaceAll(String.fromCharCode(92), '/').endsWith('/assets/bases.json')){
    return JSON.stringify(JSON.parse(data).filter(row=>row.archive!==${JSON.stringify(retained.archive)}));
  }
  return data;
};
syncBuiltinESMExports();
`);
  const reader = { ...cli, argv: [process.execPath, '--import', pathToFileURL(preload).href, entry] };
  const corrupt = join(dir, 'corrupt');
  cpSync(bad, corrupt, { recursive: true });
  writeFileSync(join(corrupt, lockPath), JSON.stringify(lock));
  const cacheFile = join(corrupt, '.ia/distributions/cache', `${retained.archive}.ia.tgz`);
  writeFileSync(cacheFile, 'not the matching base');
  const beforeRefusal = [join(corrupt, lockPath), join(corrupt, '.ia/distributions/active.json'), cacheFile].map(sha256File);
  assert.throws(() => adopt(corrupt, producer, { cli: reader }), { code: 'IA-CORE-RETAINED-BASE' });
  assert.equal(existsSync(join(corrupt, 'vendor')), false);
  assert.deepEqual([join(corrupt, lockPath), join(corrupt, '.ia/distributions/active.json'), cacheFile].map(sha256File), beforeRefusal);


  // Model the earlier defect: exact kit, unchanged installed generation and
  // source/build vendor entries, but no retained consumer archive/catalog row.
  const legacy = join(dir, 'legacy');
  cpSync(initial, legacy, { recursive: true });
  rmSync(join(legacy, archive));
  const earlierCatalog = JSON.stringify(JSON.parse(catalogBefore).filter(x => x.path !== archive), null, 2) + '\n';
  writeFileSync(join(legacy, catalog), earlierCatalog);
  const state = root => [join(root, lockPath), join(root, '.ia/distributions/active.json')].map(sha256File);
  const beforeRepair = state(legacy);
  const noSource = join(dir, 'no-repair-source');
  cpSync(legacy, noSource, { recursive: true });
  rmSync(join(noSource, '.ia/distributions/cache', `${retained.archive}.ia.tgz`), { force: true });
  assert.throws(() => adopt(noSource, producer, { cli: reader }), { code: 'IA-CORE-RETAINED-BASE' });
  assert.deepEqual(state(noSource), beforeRepair);
  assert.equal(readFileSync(join(noSource, catalog), 'utf8'), earlierCatalog);
  assert.equal(existsSync(join(noSource, archive)), false);

  const preview = adopt(legacy, producer, { cli: reader, dry: true });
  assert.equal(preview.wouldRepairVendor, true);
  assert.deepEqual(preview.written, [join(legacy, archive), join(legacy, catalog)]);
  assert.equal(existsSync(join(legacy, archive)), false);
  assert.equal(readFileSync(join(legacy, catalog), 'utf8'), earlierCatalog);
  assert.deepEqual(state(legacy), beforeRepair);
  const repaired = adopt(legacy, producer, { cli: reader });
  assert.equal(repaired.already, true);
  assert.equal(repaired.vendorRepaired, true);
  assert.deepEqual(repaired.written, preview.written);
  assert.equal(sha256File(join(legacy, archive)), retained.archive);
  assert.deepEqual(readFileSync(join(legacy, catalog)), catalogBefore);
  assert.deepEqual(state(legacy), beforeRepair, 'repair must not reinstall or change the active generation');
  assert.deepEqual(adopt(legacy, producer, { cli: reader }).written, []);
  assert.deepEqual(readFileSync(join(legacy, catalog)), catalogBefore);

  const other = join(dir, 'other');
  mkdirSync(join(other, '.ia', 'src'), { recursive: true });
  cpSync(join(initial, '.ia/src'), join(other, '.ia/src'), { recursive: true });
  cpSync(join(initial, lockPath), join(other, lockPath));
  cpSync(join(legacy, 'vendor'), join(other, 'vendor'), { recursive: true });
  const home = join(dir, 'fresh-home');
  mkdirSync(home);
  const previous = process.env.IA_HOME;
  process.env.IA_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.IA_HOME; else process.env.IA_HOME = previous; });
  const missing = join(dir, 'retained-outside-vendor.ia.tgz');
  renameSync(join(other, archive), missing);
  const without = runIa(other, ['restore', '--catalog', catalog, '--apply', '--yes'], { cli: reader });
  assert.notEqual(without.code, 0, 'no bundled or warm-cache fallback can satisfy the exact lock');
  renameSync(missing, join(other, archive));
  const restored = runIa(other, ['restore', '--catalog', catalog, '--apply', '--yes'], { cli: reader });
  assert.equal(restored.code, 0, restored.stdout + restored.stderr);
  assert.equal(sha256File(join(other, '.ia/distributions/cache', `${retained.archive}.ia.tgz`)), retained.archive);
  assert.deepEqual(readLock(other), readLock(initial));
});
