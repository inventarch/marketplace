import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveCli, runIa } from '../scripts/lib/cli.mjs';
import { envFor, run, sandbox } from './helpers/fixtures.mjs';

const CLI = process.env.IA_CORE_TEST_CLI;
const KIT = fileURLToPath(new URL('../config/kits/ia-kb/', import.meta.url));
function fixture(t) {
  const dir = sandbox(t, 'ia-method-native-');
  const kitsDir = join(dir, 'kits'), kit = join(kitsDir, 'ia-kb');
  cpSync(KIT, kit, { recursive: true });
  const cli = resolveCli(dir, { cliPath: CLI });
  assert.equal(cli.version, '3.8.0');
  // A repository whose lock really installs the kit: a workspace of its own (`ia init`), then `kit.mjs add --apply` (the remedy the
  // installation guard names), which installs the kit's recorded release with this CLI.
  const repo = join(dir, 'consumer');
  const made = spawnSync(process.execPath, [CLI, 'init', repo, '--apply', '--yes', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const runRoot = join(dir, 'run');
  const env = envFor({ cli: CLI, kitsDir, temp: join(dir, 'temp'), runRoot });
  const installed = run('kit.mjs', ['add', 'inventarch/ia-kb-kit', repo, '--apply'], env);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.ok(JSON.parse(readFileSync(join(repo, '.ia', 'distributions.lock.json'), 'utf8')).packages.some(row => row.id === 'inventarch/ia-kb-kit'), 'the lock installs the kit');
  const bind = capability => writeFileSync(join(repo, '.ia', 'bindings.json'), JSON.stringify({ format: 1, bindings: { 'knowledge.check': { kit: 'inventarch/ia-kb-kit', capability } } }));
  const resolve = () => run('resolve.mjs', ['--entry', 'knowledge', '--activity', 'check', '--root', repo], env);
  return { kit, runRoot, bind, resolve };
}

test('MI-T04 native missing capability refuses without pin', { skip: !CLI }, t => {
  const f = fixture(t);
  f.bind('does-not-exist');
  const bad = f.resolve();
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.equal(bad.json.error.code, 'IA-CORE-CAPABILITY-UNAVAILABLE');
  assert.equal(existsSync(join(f.runRoot, 'binding.json')), false);
  f.bind('kb-check');
  const good = f.resolve();
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.ok(good.json.instructions.length);
});

test('MI-T05 native missing required runner refuses without pin', { skip: !CLI }, t => {
  const f = fixture(t);
  f.bind('kb-check');
  const file = join(f.kit, 'checks.json'), original = readFileSync(file);
  writeFileSync(file, JSON.stringify({ format: 1, checks: {} }));
  const bad = f.resolve();
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.equal(bad.json.error.code, 'IA-CORE-CHECK-UNAVAILABLE');
  assert.equal(existsSync(join(f.runRoot, 'binding.json')), false);
  writeFileSync(file, original);
  const good = f.resolve();
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.ok(good.json.evidence.required.length);
});
