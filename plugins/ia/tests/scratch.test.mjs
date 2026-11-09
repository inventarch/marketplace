// lib/scratch.mjs (task core-architecture-scripts), ported from
// inventarch-architecture's tests/workspace-toolchain.test.mjs: the copy keeps
// explicit adopted source trees and ignores quoted prose; a nested destination,
// traversal and links are refused; artifact formats; capture runs in the copy
// and leaves the workspace's own snapshot alone; resolveIa answers with the
// core's resolver (a found install, a descriptor passed through) and refuses a
// CLI below 3.x. How the core finds a CLI is tests/cli.test.mjs's.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyWorkspace, invokeIa, readArtifact, resolveIa, scratchArtifact } from '../scripts/lib/scratch.mjs';
import * as kitScratch from '../config/kits/ia-authoring/scripts/lib/scratch.mjs';
import { sandbox } from './helpers/fixtures.mjs';

function fixture(t) {
  const parent = sandbox(t, 'ia-core-scratch-test-');
  const root = join(parent, 'source'), scratch = join(parent, 'copy');
  mkdirSync(join(root, '.ia', 'src'), { recursive: true });
  mkdirSync(scratch);
  writeFileSync(join(root, '.ia', 'src', 'workspace.ia'), '#! ia 1.0\n@workspace fixture\n');
  return { parent, root, scratch };
}

// A stand-in CLI that answers only `capture`, writing the snapshot into the root it is given.
const CAPTURE_CLI = [
  "import fs from 'node:fs'; import path from 'node:path';",
  "const a = process.argv.slice(2), root = a[a.indexOf('--root') + 1];",
  "if (a[0] !== 'capture') { console.error('only capture is expected, got ' + a[0]); process.exit(2); }",
  "const file = path.join(root, '.ia/work/snapshot/current.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ format: 'ia-snapshot-1', records: [], counts: { errors: 0, notEvaluated: 2 } }));",
].join('\n');

function installCli(dir, version) {
  const pkg = join(dir, 'node_modules', '@inventarch', 'cli');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version, bin: 'bin/ia.mjs' }));
  writeFileSync(join(pkg, 'bin', 'ia.mjs'), CAPTURE_CLI);
  return pkg;
}

function withoutCliEnv(t) {
  const saved = { IA_CLI_PATH: process.env.IA_CLI_PATH, IA_METHOD_CLI: process.env.IA_METHOD_CLI };
  delete process.env.IA_CLI_PATH; delete process.env.IA_METHOD_CLI;
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });
}

test('the copy keeps explicit adopted source trees and their pins, and ignores quoted prose', t => {
  const { root, scratch } = fixture(t);
  mkdirSync(join(root, 'vendor', 'public', '.ia', 'src'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'public', '.ia', 'src', 'a.ia'), '#! ia 1.0\n');
  const binding = { version: 1, adopted: [{ id: 'public', path: 'vendor/public', revision: 'a'.repeat(64) }] };
  writeFileSync(join(root, '.ia', 'workspace.json'), JSON.stringify(binding));
  writeFileSync(join(root, '.ia', 'src', 'prose.ia'), '#! ia 1.0\n@spec prose\n  meaning\n    says "missing-root @authored"\n');
  mkdirSync(join(root, '.ia', 'work'), { recursive: true });
  writeFileSync(join(root, '.ia', 'work', 'state.json'), '{}');
  const result = copyWorkspace(root, scratch);
  assert.deepEqual(result.sourceRoots, ['vendor/public']);
  assert.deepEqual(JSON.parse(readFileSync(join(scratch, '.ia', 'workspace.json'), 'utf8')), binding);
  assert.ok(existsSync(join(scratch, 'vendor', 'public', '.ia', 'src', 'a.ia')));
  assert.ok(!existsSync(join(scratch, '.ia', 'work')), '.ia/work is never copied');
});

test('a nested destination and a traversing binding are refused before anything is copied', t => {
  const { root, scratch } = fixture(t);
  const nested = join(root, 'nested');
  mkdirSync(nested);
  assert.throws(() => copyWorkspace(root, nested), /disjoint/);
  assert.deepEqual(readdirSync(nested), []);
  writeFileSync(join(root, '.ia', 'workspace.json'), JSON.stringify({ version: 1, adopted: [{ id: 'bad', path: '../outside', revision: 'a'.repeat(64) }] }));
  assert.throws(() => copyWorkspace(root, scratch), /traversal/);
});

test('links and junctions, in the sources or on an adopted path, are refused rather than followed', t => {
  const { root, scratch } = fixture(t);
  const target = join(root, 'real');
  mkdirSync(join(target, 'public', '.ia', 'src'), { recursive: true });
  writeFileSync(join(target, 'record.ia'), '#! ia 1.0\n');
  try { symlinkSync(target, join(root, '.ia', 'src', 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('fixture link privilege unavailable'); return; }
    throw error;
  }
  assert.throws(() => copyWorkspace(root, scratch), /links or junctions/);
  rmSync(join(root, '.ia', 'src', 'alias'));
  symlinkSync(target, join(root, 'vendor-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(root, '.ia', 'workspace.json'), JSON.stringify({ version: 1, adopted: [{ id: 'public', path: 'vendor-alias/public', revision: 'a'.repeat(64) }] }));
  assert.throws(() => copyWorkspace(root, scratch), /link\/junction alias/);
});

test('artifact formats: a capture snapshot and the older compiled shape, never records-only JSON', t => {
  const { parent } = fixture(t);
  const file = join(parent, 'artifact.json');
  writeFileSync(file, JSON.stringify({ formatVersion: 1, artifact: 'ia.compiled.v1', records: [] }));
  assert.equal(readArtifact(file).format, 'ia.compiled.v1');
  writeFileSync(file, JSON.stringify({ format: 'ia-snapshot-1', records: [] }));
  assert.equal(readArtifact(file).format, 'ia-snapshot-1');
  writeFileSync(file, JSON.stringify({ records: [] }));
  assert.throws(() => readArtifact(file), /unsupported/);
});

test('capture runs in the scratch copy, which is removed, and the workspace\'s own snapshot is left alone', t => {
  const { parent, root } = fixture(t);
  const cli = join(parent, 'capture-cli.mjs');
  writeFileSync(cli, CAPTURE_CLI);
  mkdirSync(join(root, '.ia', 'work', 'snapshot'), { recursive: true });
  const live = join(root, '.ia', 'work', 'snapshot', 'current.json');
  writeFileSync(live, 'unchanged live snapshot');
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('ia-core-scratch-')).length;
  const result = scratchArtifact(root, cli);
  assert.equal(result.profile, 'capture');
  assert.equal(result.artifact.counts.notEvaluated, 2);
  assert.equal(result.admissionErrors, 0);
  assert.equal(readFileSync(live, 'utf8'), 'unchanged live snapshot');
  assert.ok(readdirSync(tmpdir()).filter(n => n.startsWith('ia-core-scratch-')).length <= before, 'the copy is removed');
});

test('resolveIa uses the core resolver: the repository\'s install, a descriptor passed through, and a CLI below 3.x refused', t => {
  withoutCliEnv(t);
  const { parent, root } = fixture(t);
  mkdirSync(join(parent, '.git'));
  const pkg = installCli(parent, '3.3.0');
  const ia = resolveIa(root, undefined, { quiet: true });
  assert.deepEqual(ia, { argv: [process.execPath, join(pkg, 'bin', 'ia.mjs')], version: '3.3.0', source: pkg });
  assert.equal(resolveIa(tmpdir(), ia), ia, 'a scratch copy has no node_modules, so the descriptor resolved first is reused');
  assert.equal(scratchArtifact(root, ia).profile, 'capture');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version: '2.0.0', bin: 'bin/ia.mjs' }));
  assert.throws(() => resolveIa(root, undefined, { quiet: true }), /IA 2\.x is not supported/);
  assert.throws(() => resolveIa(root, join(pkg, 'bin', 'ia.mjs'), { quiet: true }), /IA 2\.x is not supported/, 'an explicit entry reads its version too');
});

test('IA_CLI_NO_NPX, the plugin resolver\'s switch, still turns the npx fallback off', t => {
  withoutCliEnv(t);
  const { parent, root } = fixture(t);
  mkdirSync(join(parent, '.git'));
  const saved = process.env.IA_CLI_NO_NPX;
  process.env.IA_CLI_NO_NPX = '1';
  t.after(() => { if (saved === undefined) delete process.env.IA_CLI_NO_NPX; else process.env.IA_CLI_NO_NPX = saved; });
  assert.throws(() => resolveIa(root, undefined, { quiet: true }), e => e.code === 'IA-CORE-CLI-MISSING' && /no IA CLI resolved for .* \(npx disabled by IA_CLI_NO_NPX\)/.test(e.message));
});

test('a broken workspace install keeps its own reason, never the no-CLI wording', t => {
  withoutCliEnv(t);
  const { parent, root } = fixture(t);
  mkdirSync(join(parent, '.git'));
  const pkg = installCli(parent, '3.3.0');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@someone/else', version: '3.3.0', bin: 'bin/ia.mjs' }));
  assert.throws(() => resolveIa(root, undefined, { quiet: true }), e => e.code === 'IA-CORE-CLI-MISSING' && /names @someone\/else, not @inventarch\/cli/.test(e.message) && !/no IA CLI resolved/.test(e.message));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version: '3.3.0', bin: 'bin/gone.mjs' }));
  assert.throws(() => resolveIa(root, undefined, { quiet: true }), e => /has no entry .*gone\.mjs/.test(e.message));
});

// public-cli-3-6-0-handoff: the core's and the ia-authoring kit's invokeIa both start the CLI they resolved with
// IA_NO_HANDOFF=1, also when the caller passes its own environment.
test('invokeIa of the core and of the ia-authoring kit starts the CLI with IA_NO_HANDOFF=1', t => {
  const dir = sandbox(t);
  const fake = join(dir, 'fake-ia.mjs');
  writeFileSync(fake, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), handoff: process.env.IA_NO_HANDOFF ?? null, marker: process.env.IA_TEST_MARKER ?? null }));");
  const cli = { argv: [process.execPath, fake], version: '3.6.0', source: 'test' };
  for (const [name, invoke] of [['core', invokeIa], ['ia-authoring kit', kitScratch.invokeIa]]) {
    assert.deepEqual(JSON.parse(invoke(cli, ['capture'])), { args: ['capture'], handoff: '1', marker: null }, name);
    assert.deepEqual(JSON.parse(invoke(cli, ['capture'], { env: { ...process.env, IA_TEST_MARKER: 'kept', IA_NO_HANDOFF: '0' } })), { args: ['capture'], handoff: '1', marker: 'kept' }, `${name}: a caller's env keeps its names, never a hand-off`);
  }
});
