import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkShards, inspectCli, readShardReports, reconcile, verifyReports } from '../tools/run-native-tests.mjs';
const required = [{ id: 'required', file: 'fixture.mjs', name: 'native fixture', mode: 'native', platforms: ['linux', 'win32', 'darwin'] }];
const pass = { file: 'fixture.mjs', name: 'native fixture', status: 'pass' };
test('MI-T08 required native inventory rejects missing, duplicate, skipped and todo cases', () => {
  assert.equal(reconcile(required, [pass])[0].status, 'pass');
  assert.equal(reconcile(required, [])[0].status, 'missing-or-duplicate');
  assert.equal(reconcile(required, [pass, pass])[0].status, 'missing-or-duplicate');
  for (const flag of ['skip', 'todo']) { const result = reconcile(required, [{ ...pass, [flag]: 'not available' }])[0]; assert.equal(result.status, 'skip'); assert.equal(result.executed, false); }
  assert.equal(reconcile(required, [{ ...pass, status: 'fail' }])[0].status, 'fail');
  assert.throws(() => reconcile([...required, ...required], []), /duplicate inventory/);
});
test('MI-T08 required native lane rejects absent and wrong CLI', () => {
  assert.throws(() => inspectCli(undefined), /IA_CORE_TEST_CLI is required/);
  const dir = mkdtempSync(join(tmpdir(), 'native-wrong-cli-'));
  try { mkdirSync(join(dir, 'dist')); writeFileSync(join(dir, 'dist/main.js'), 'throw new Error("must not execute wrong version")'); writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version: '3.1.1' })); assert.throws(() => inspectCli(join(dir, 'dist/main.js')), /required native CLI version/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test('the native runner runs when invoked through a symlinked path', t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-linked-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const linked = join(dir, 'tools'); symlinkSync(fileURLToPath(new URL('../tools/', import.meta.url)), linked, 'junction');
  const env = { ...process.env }; delete env.IA_CORE_TEST_CLI;
  const ran = spawnSync(process.execPath, [join(linked, 'run-native-tests.mjs')], { encoding: 'utf8', env });
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /IA_CORE_TEST_CLI is required/);
});
const sharded = { shards: 2, cases: [{ id: 'a', shard: 1 }, { id: 'b', shard: 2 }, { id: 'c', shard: 2 }] };
const shardReport = (shard, results, extra = {}) => ({ format: 'inventarch.native-report/1', platform: 'win32', node: 'v22.22.0', cli: { entrySha256: 'c' }, sourceRevision: 'r', sourceBefore: 's', sourceAfter: 's', workingTreeDiffSha256: 'w', inventorySha256: 'i', shard, shards: 2, infrastructureFailures: [], results: results.map(id => ({ id, status: 'pass', executed: true })), ...extra });
test('native shards: every case names a shard and every shard has a case', () => {
  assert.doesNotThrow(() => checkShards(sharded));
  assert.throws(() => checkShards({ ...sharded, cases: [...sharded.cases, { id: 'd' }] }), /case d needs a shard in 1\.\.2/);
  assert.throws(() => checkShards({ ...sharded, cases: [{ id: 'a', shard: 3 }, ...sharded.cases] }), /case a needs a shard/);
  assert.throws(() => checkShards({ shards: 3, cases: sharded.cases }), /shard 3 has no case/);
  assert.throws(() => checkShards({ cases: sharded.cases }), /inventory\.shards must be a positive integer/);
});
test('native shards: the reports verify only as one complete passing run of the inventory', () => {
  const good = [shardReport(1, ['a']), shardReport(2, ['b', 'c'])];
  assert.deepEqual(verifyReports(sharded, 'i', good), []);
  assert.match(verifyReports(sharded, 'i', [good[0]]).join('\n'), /shards reported \[1\], expected 1\.\.2/);
  assert.match(verifyReports(sharded, 'i', [good[0], shardReport(2, ['b'])]).join('\n'), /c: reported 0 times/);
  assert.match(verifyReports(sharded, 'i', [shardReport(1, ['a', 'b']), good[1]]).join('\n'), /b: reported 2 times/);
  assert.match(verifyReports(sharded, 'i', [good[0], shardReport(2, ['b', 'c'], { sourceRevision: 'x' })]).join('\n'), /sourceRevision differs/);
  assert.match(verifyReports(sharded, 'i', [good[0], shardReport(2, ['b', 'c'], { cli: { entrySha256: 'x' } })]).join('\n'), /CLI differs/);
  assert.match(verifyReports(sharded, 'other', good).join('\n'), /ran another inventory/);
  assert.match(verifyReports(sharded, 'i', [good[0], { ...shardReport(2, ['b', 'c']), results: [{ id: 'b', status: 'pass', executed: true }, { id: 'c', status: 'fail', executed: true }] }]).join('\n'), /c: fail/);
  assert.match(verifyReports(sharded, 'i', [good[0], shardReport(2, ['b', 'c'], { infrastructureFailures: ['missing test file: x'] })]).join('\n'), /shard 2: missing test file: x/);
  assert.match(verifyReports(sharded, 'i', [good[0], shardReport(2, ['b', 'c', 'z'])]).join('\n'), /z: not in the inventory/);
});
test('native shards: --plan prints the inventory shard list for a workflow matrix', () => {
  const ran = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/run-native-tests.mjs', import.meta.url)), '--plan'], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const shards = JSON.parse(ran.stdout.trim().replace(/^shards=/, ''));
  assert.deepEqual(shards, Array.from({ length: shards.length }, (_, i) => i + 1));
  assert.ok(shards.length >= 1);
});

test('native artifact layouts retain all reports and all coverage failures', t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writeReport = (folder, report) => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'native-report.json'), JSON.stringify(report));
    writeFileSync(join(folder, 'native-events.jsonl'), '{}\n');
  };
  const one = { shards: 1, cases: [{ id: 'a', shard: 1 }] };
  const flat = join(dir, 'flat');
  writeReport(flat, shardReport(1, ['a'], { shards: 1 }));
  assert.deepEqual(verifyReports(one, 'i', readShardReports([flat])), []);
  const nested = join(dir, 'nested');
  writeReport(join(nested, 'shard-1'), shardReport(1, ['a']));
  writeReport(join(nested, 'shard-2'), shardReport(2, ['b', 'c']));
  assert.deepEqual(verifyReports(sharded, 'i', readShardReports([nested])), []);
  assert.deepEqual(verifyReports(sharded, 'i', readShardReports([join(nested, 'shard-1'), join(nested, 'shard-2')])), []);
  const empty = join(dir, 'empty'); mkdirSync(empty);
  assert.match(verifyReports(one, 'i', readShardReports([empty])).join('\n'), /shards reported \[\]/);
  assert.match(verifyReports(sharded, 'i', readShardReports([join(nested, 'shard-1')])).join('\n'), /c: reported 0 times/);
  writeReport(nested, shardReport(1, ['a']));
  assert.match(verifyReports(sharded, 'i', readShardReports([nested])).join('\n'), /a: reported 2 times/);
  rmSync(join(nested, 'native-report.json'));
  writeReport(join(nested, 'shard-2'), shardReport(2, ['b', 'c'], { sourceRevision: 'other' }));
  assert.match(verifyReports(sharded, 'i', readShardReports([nested])).join('\n'), /sourceRevision differs/);
});
