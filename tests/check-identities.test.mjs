import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const tool = new URL('../tools/check-identities.mjs', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
async function screen(options) {
  assert.ok(existsSync(tool), 'publisher identity screening must be implemented');
  return (await import(tool.href)).screenPublication(options);
}
function fixture(t, files = { 'design.md': 'A public example.\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'publication-identities-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'payload'); mkdirSync(root);
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, text);
  }
  const registry = { format: 1, scope: 'synthetic-publication', entries: [{ id: 'private-example', value: 'private-alpha-workspace' }] };
  const manifest = { format: 1, scope: registry.scope, files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes), mediaType: path.endsWith('.json') ? 'json' : 'text' })) };
  const registryPath = join(dir, 'registry.json'), manifestPath = join(dir, 'manifest.json');
  const options = { root, publicRoot: root, registryPath, manifestPath };
  const repin = () => {
    writeFileSync(registryPath, json(registry)); writeFileSync(manifestPath, json(manifest));
    options.registrySha256 = sha(readFileSync(registryPath)); options.manifestSha256 = sha(readFileSync(manifestPath));
  };
  repin(); return { dir, root, registry, manifest, options, repin };
}
test('complete exact clean payload passes with attributable coverage', async t => {
  const f = fixture(t); const result = await screen(f.options);
  assert.equal(result.status, 'passed'); assert.equal(result.code, 'CLEAN');
  assert.deepEqual(result.coverage, { files: 1, bytes: 18 });
  assert.equal(result.manifestSha256, f.options.manifestSha256);
  assert.equal(result.registrySha256, f.options.registrySha256);
  assert.deepEqual(result.findings, []);
});
for (const [name, files] of Object.entries({
  raw: { 'design.md': 'PRIVATE-ALPHA-WORKSPACE' },
  path: { 'private-alpha-workspace.md': 'safe' },
  'escaped JSON value': { 'case.json': '{"value":"\\u0070rivate-alpha-workspace"}' },
  'escaped JSON key': { 'case.json': '{"\\u0070rivate-alpha-workspace":true}' },
  'overwritten JSON value': { 'case.json': '{"value":"\\u0070rivate-alpha-workspace","value":"safe"}' },
})) test(`refuses identity in ${name}`, async t => {
  const f = fixture(t, files); const result = await screen(f.options);
  assert.equal(result.status, 'refused'); assert.equal(result.code, 'IDENTITY_MATCH');
  assert.ok(result.findings.some(item => item.entryId === 'private-example'));
});
for (const mode of ['missing', 'empty', 'malformed', 'unpinned', 'wrong-pin', 'self-approved', 'scope', 'duplicate-key']) {
  test(`registry ${mode} is not evaluated`, async t => {
    const f = fixture(t);
    if (mode === 'missing') rmSync(f.options.registryPath);
    if (mode === 'empty') { f.registry.entries = []; f.repin(); }
    if (mode === 'malformed') { writeFileSync(f.options.registryPath, '{}'); f.options.registrySha256 = sha('{}'); }
    if (mode === 'unpinned') delete f.options.registrySha256;
    if (mode === 'wrong-pin') f.options.registrySha256 = '0'.repeat(64);
    if (mode === 'self-approved') { f.registry.approved = true; f.repin(); }
    if (mode === 'scope') { f.manifest.scope = 'other-domain'; f.repin(); }
    if (mode === 'duplicate-key') { const bytes = json(f.registry).replace('"format": 1', '"format": 0, "format": 1'); writeFileSync(f.options.registryPath, bytes); f.options.registrySha256 = sha(bytes); }
    const result = await screen(f.options); assert.equal(result.status, 'not-evaluated'); assert.notEqual(result.code, 'CLEAN');
  });
}
test('registry in actual public checkout refuses even when snapshot is elsewhere', async t => {
  const f = fixture(t); const checkout = join(f.dir, 'public-checkout'); mkdirSync(checkout);
  const contained = join(checkout, 'private.json'); writeFileSync(contained, readFileSync(f.options.registryPath));
  const result = await screen({ ...f.options, publicRoot: checkout, registryPath: contained });
  assert.equal(result.status, 'not-evaluated'); assert.equal(result.code, 'INPUT_CUSTODY');
});
for (const mode of ['extra', 'missing', 'changed', 'size', 'traversal', 'case-collision', 'json-as-text']) {
  test(`payload ${mode} refuses`, async t => {
    const f = fixture(t);
    if (mode === 'extra') writeFileSync(join(f.root, '.hidden.md'), 'private-alpha-workspace');
    if (mode === 'missing') rmSync(join(f.root, 'design.md'));
    if (mode === 'changed') writeFileSync(join(f.root, 'design.md'), 'changed');
    if (mode === 'size') { f.manifest.files[0].bytes += 1; f.repin(); }
    if (mode === 'traversal') { f.manifest.files[0].path = '../design.md'; f.repin(); }
    if (mode === 'case-collision') { f.manifest.files.push({ ...f.manifest.files[0], path: 'DESIGN.md' }); f.repin(); }
    if (mode === 'json-as-text') { f.manifest.files[0].path = 'case.json'; f.repin(); }
    const result = await screen(f.options); assert.equal(result.status, 'refused');
  });
}
test('unavailable manifest never passes', async t => {
  const f = fixture(t); delete f.options.manifestSha256;
  assert.equal((await screen(f.options)).status, 'not-evaluated');
});
for (const [name, bytes] of [['malformed UTF-8', Buffer.from([0xc3, 0x28])], ['NUL', Buffer.from([65, 0, 66])]]) {
  test(`${name} payload is not evaluated`, async t => {
    const f = fixture(t, { 'design.md': bytes });
    assert.equal((await screen(f.options)).status, 'not-evaluated');
  });
}
test('unsupported archives and invalid JSON remain unassessed', async t => {
  for (const files of [{ 'bundle.tgz': 'inert bytes' }, { 'case.json': '{invalid}' }]) {
    const f = fixture(t, files); assert.equal((await screen(f.options)).status, 'not-evaluated');
  }
});
test('hard-linked payload file refuses', async t => {
  const f = fixture(t); const outside = join(f.dir, 'outside.md'); writeFileSync(outside, 'A public example.\n');
  rmSync(join(f.root, 'design.md')); linkSync(outside, join(f.root, 'design.md'));
  const result = await screen(f.options); assert.equal(result.status, 'refused'); assert.equal(result.code, 'PAYLOAD_ALIAS');
});
test('directory junction/symlink refuses rather than traversing', async t => {
  const f = fixture(t); const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'hidden.md'), 'private-alpha-workspace');
  symlinkSync(outside, join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await screen(f.options); assert.equal(result.status, 'refused'); assert.equal(result.code, 'PAYLOAD_ALIAS');
});
test('matching normalizes composed Unicode and locator slashes', async t => {
  const f = fixture(t, { 'design.md': 'PRIVATE\\CAFE\u0301' }); f.registry.entries[0].value = 'private/café'; f.repin();
  assert.equal((await screen(f.options)).code, 'IDENTITY_MATCH');
});
test('CLI redacts private details and returns the tri-state exit', async t => {
  const f = fixture(t, { 'design.md': 'private-alpha-workspace' });
  assert.ok(existsSync(tool), 'screening CLI must be implemented');
  const args = ['--root', f.root, '--registry', f.options.registryPath, '--registry-sha256', f.options.registrySha256, '--manifest', f.options.manifestPath, '--manifest-sha256', f.options.manifestSha256];
  const result = spawnSync(process.execPath, [tool.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).status, 'refused');
  assert.ok(!result.stdout.includes('private-alpha-workspace')); assert.ok(!result.stdout.includes(f.options.registrySha256)); assert.equal(result.stderr, '');
});
