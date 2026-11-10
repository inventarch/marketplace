import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

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
    const result = await screen(f.options); assert.equal(result.status, 'not-evaluated');
    const codes = { missing: 'INPUT_UNAVAILABLE', unpinned: 'INPUT_PIN', 'wrong-pin': 'INPUT_PIN', scope: 'INPUT_SCOPE' };
    assert.equal(result.code, codes[mode] ?? 'REGISTRY_INVALID');
  });
}
test('registry in actual public checkout is not evaluated even when snapshot is elsewhere', async t => {
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
    if (mode === 'changed') writeFileSync(join(f.root, 'design.md'), 'B public example.\n');
    if (mode === 'size') { f.manifest.files[0].bytes += 1; f.repin(); }
    if (mode === 'traversal') {
      writeFileSync(join(f.dir, 'outside.md'), 'A public example.\n');
      f.manifest.files.push({ ...f.manifest.files[0], path: '../outside.md' }); f.repin();
    }
    if (mode === 'case-collision') { f.manifest.files.push({ ...f.manifest.files[0], path: 'DESIGN.md' }); f.repin(); }
    if (mode === 'json-as-text') {
      const actual = fixture(t, { 'case.json': '{"text":"public"}' });
      assert.equal((await screen(actual.options)).status, 'passed');
      actual.manifest.files[0].mediaType = 'text'; actual.repin();
      assert.equal((await screen(actual.options)).code, 'PAYLOAD_MANIFEST'); return;
    }
    const result = await screen(f.options); assert.equal(result.status, 'refused');
    if (['traversal', 'case-collision'].includes(mode)) assert.equal(result.code, 'PAYLOAD_MANIFEST');
    if (['size', 'changed'].includes(mode)) assert.equal(result.code, 'PAYLOAD_DRIFT');
    if (['extra', 'missing'].includes(mode)) assert.equal(result.code, 'PAYLOAD_COVERAGE');
  });
}
test('unavailable manifest never passes', async t => {
  const f = fixture(t); delete f.options.manifestSha256;
  assert.equal((await screen(f.options)).status, 'not-evaluated');
});
test('wrong manifest pin is not evaluated', async t => {
  const f = fixture(t); f.options.manifestSha256 = '0'.repeat(64);
  assert.equal((await screen(f.options)).code, 'INPUT_PIN');
});
test('actual public root must be explicit and valid', async t => {
  const f = fixture(t); delete f.options.publicRoot;
  assert.equal((await screen(f.options)).status, 'not-evaluated');
  f.options.publicRoot = join(f.dir, 'missing-root');
  assert.equal((await screen(f.options)).status, 'not-evaluated');
});
for (const key of ['registryPath', 'manifestPath']) test(`${key} hardlinks and checkout aliases are rejected`, async t => {
  const f = fixture(t); const checkout = join(f.dir, 'checkout'); mkdirSync(checkout);
  f.options.publicRoot = checkout;
  const inside = join(checkout, 'input.json'); linkSync(f.options[key], inside);
  assert.equal((await screen(f.options)).code, 'INPUT_CUSTODY');
  rmSync(inside); writeFileSync(inside, readFileSync(f.options[key]));
  const alias = join(f.dir, 'checkout-alias'); symlinkSync(checkout, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.options[key] = join(alias, 'input.json');
  assert.equal((await screen(f.options)).code, 'INPUT_CUSTODY');
});
test('duplicate normalized registry values are not evaluated', async t => {
  const f = fixture(t); f.registry.entries.push({ id: 'other', value: 'PRIVATE-ALPHA-WORKSPACE' }); f.repin();
  assert.equal((await screen(f.options)).status, 'not-evaluated');
});
test('malformed UTF-8 and duplicate manifest members are not evaluated', async t => {
  const f = fixture(t);
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from(json(f.manifest).replace('"format": 1', '"format": 0, "format": 1'))]) {
    writeFileSync(f.options.manifestPath, bytes); f.options.manifestSha256 = sha(bytes);
    assert.equal((await screen(f.options)).status, 'not-evaluated');
  }
});
test('per-file, total and count limits leave oversized payloads not evaluated', async t => {
  const full = 'x'.repeat(4 * 1024 * 1024);
  const boundary = fixture(t, { 'at-limit.md': full });
  assert.equal((await screen(boundary.options)).status, 'passed');
  for (const files of [
    { 'too-big.md': full + 'x' },
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`part-${i}.md`, full])),
    Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`part-${i}.md`, 'x'])),
  ]) {
    const f = fixture(t, files); assert.equal((await screen(f.options)).code, 'PAYLOAD_LIMIT');
  }
});
test('input document limits are checked before parsing', async t => {
  for (const [key, pin, code] of [['registryPath', 'registrySha256', 'REGISTRY_LIMIT'], ['manifestPath', 'manifestSha256', 'MANIFEST_LIMIT']]) {
    const f = fixture(t); const bytes = json({ format: 1, scope: 'x'.repeat(4 * 1024 * 1024) });
    writeFileSync(f.options[key], bytes); f.options[pin] = sha(bytes);
    assert.equal((await screen(f.options)).code, code);
  }
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
test('empty manifests and unrepresented directories cannot pass', async t => {
  const empty = fixture(t, {}); assert.equal((await screen(empty.options)).code, 'MANIFEST_INVALID');
  const f = fixture(t); mkdirSync(join(f.root, 'unrepresented'));
  assert.equal((await screen(f.options)).code, 'PAYLOAD_COVERAGE');
});
test('literal profile does not claim markup rendering or soft-line joining', async t => {
  for (const bytes of ['&#x70;rivate-alpha-workspace', 'private-alpha-\nworkspace', 'const value = "\\u0070rivate-alpha-workspace";']) {
    const f = fixture(t, { 'design.md': bytes });
    assert.equal((await screen(f.options)).status, 'passed'); // Semantic review remains mandatory.
  }
});

test('manifest file-directory clashes and directory case aliases refuse portably', async t => {
  for (const paths of [['Docs.md', 'docs.md/x.md'], ['docs.md/x.md', 'Docs.md'], ['Docs/a.md', 'docs/b.md'], ['docs/b.md', 'Docs/a.md']]) {
    const f = fixture(t); f.manifest.files.push(...paths.map(path => ({ ...f.manifest.files[0], path }))); f.repin();
    assert.equal((await screen(f.options)).code, 'PAYLOAD_MANIFEST');
  }
  const valid = fixture(t, { 'Docs/a.md': 'first', 'Docs/b.md': 'second' });
  assert.equal((await screen(valid.options)).code, 'CLEAN');
});
test('unsupported files prevent a complete result even alongside a match', async t => {
  const f = fixture(t, { 'a.md': 'private-alpha-workspace', 'z.bin': 'uninterpreted' });
  assert.equal((await screen(f.options)).status, 'not-evaluated');
});
for (const path of ['CON.md', 'CONIN$.md', 'CONOUT$.md', 'COM¹.md', 'LPT².md', 'trailing .md.', 'a\\b.md', 'C:/file.md', 'a//b.md', 'control\u0001.md', 'a?.md', 'a*.md', 'a|b.md', 'a<b.md', 'a>b.md', 'a"b.md']) {
  test(`portable path constraint ${JSON.stringify(path)}`, async t => {
    const f = fixture(t); f.manifest.files.push({ ...f.manifest.files[0], path }); f.repin();
    assert.equal((await screen(f.options)).code, 'PAYLOAD_MANIFEST');
  });
}
test('input changes during reading remain not evaluated; payload changes refuse', async t => {
  assert.ok(existsSync(tool), 'screening must be implemented');
  await import(tool.href);
  for (const target of ['registry', 'payload']) {
    const f = fixture(t), original = fs.lstatSync;
    const selected = target === 'registry' ? f.options.registryPath : join(f.root, 'design.md');
    let observations = 0;
    t.mock.method(fs, 'lstatSync', function(path, ...args) {
      if (path === selected && ++observations === (target === 'registry' ? 2 : 3)) {
        const future = new Date(Date.now() + 30000); fs.utimesSync(selected, future, future);
      }
      return original.call(this, path, ...args);
    });
    syncBuiltinESMExports();
    try {
      const result = await screen(f.options);
      assert.equal(result.status, target === 'registry' ? 'not-evaluated' : 'refused');
      assert.equal(result.code, target === 'registry' ? 'INPUT_UNAVAILABLE' : 'PAYLOAD_DRIFT');
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
});
test('CLI redacts private details and returns the tri-state exit', async t => {
  const f = fixture(t, { 'design.md': 'private-alpha-workspace' });
  assert.ok(existsSync(tool), 'screening CLI must be implemented');
  const args = cliArgs(f.options);
  const result = spawnSync(process.execPath, [fileURLToPath(tool), ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).status, 'refused');
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ['code', 'coverage', 'manifestSha256', 'status']);
  assert.ok(!result.stdout.includes('private-alpha-workspace')); assert.ok(!result.stdout.includes(f.options.registrySha256)); assert.equal(result.stderr, '');
});
const cliArgs = options => ['--root', options.root, '--public-root', options.publicRoot, '--registry', options.registryPath, '--registry-sha256', options.registrySha256, '--manifest', options.manifestPath, '--manifest-sha256', options.manifestSha256];
test('CLI clean/unavailable/usage outcomes disclose only the safe schema', async t => {
  const f = fixture(t); assert.ok(existsSync(tool), 'screening CLI must be implemented');
  const run = args => spawnSync(process.execPath, [fileURLToPath(tool), ...args], { encoding: 'utf8', windowsHide: true });
  const clean = run(cliArgs(f.options)); assert.equal(clean.status, 0);
  f.options.registryPath = join(f.dir, 'private-sensitive-path.json');
  const missing = run(cliArgs(f.options)); assert.equal(missing.status, 2);
  for (const result of [clean, missing]) {
    assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ['code', 'coverage', 'manifestSha256', 'status']);
    assert.equal(result.stderr, ''); assert.ok(!result.stdout.includes(f.dir)); assert.ok(!result.stdout.includes('private-sensitive'));
  }
  for (const args of [[], [...cliArgs(f.options), '--unknown'], [...cliArgs(f.options), 'constructor', 'inert'], [...cliArgs(f.options), '--root', f.root]]) {
    const result = run(args); assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^usage:/); assert.ok(!result.stderr.includes(f.dir));
  }
});

test('CLI runs through a linked directory and emits real screening evidence', async t => {
  const f = fixture(t), alias = join(f.dir, 'tool-directory');
  symlinkSync(fileURLToPath(new URL('../tools/', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [options, status] of [[f.options, 0], [{ ...f.options, registryPath: join(f.dir, 'missing.json') }, 2]]) {
    const result = spawnSync(process.execPath, [join(alias, 'check-identities.mjs'), ...cliArgs(options)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, status); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, status === 0 ? 'passed' : 'not-evaluated');
  }
});

test('API imports from a stdin host without trying to run the CLI', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: `const { screenPublication } = await import(${JSON.stringify(tool.href)}); process.stdout.write(screenPublication({}).code);`,
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0); assert.equal(result.stderr, ''); assert.equal(result.stdout, 'ROOT_INVALID');
});

test('all manifest row shapes are checked before publication path policy', async t => {
  const f = fixture(t); f.manifest.files[0].path = '../escape.md';
  f.manifest.files.push({ ...f.manifest.files[0], path: 'second.md', extra: true }); f.repin();
  const result = await screen(f.options);
  assert.equal(result.status, 'not-evaluated'); assert.equal(result.code, 'MANIFEST_INVALID');
});

test('non-string manifest path and mediaType are malformed shape', async t => {
  for (const key of ['path', 'mediaType']) {
    const f = fixture(t); f.manifest.files[0][key] = 5; f.repin();
    const result = await screen(f.options);
    assert.equal(result.status, 'not-evaluated'); assert.equal(result.code, 'MANIFEST_INVALID');
  }
});

test('inputs inside the snapshot fail custody before parsing', async t => {
  for (const key of ['registryPath', 'manifestPath']) {
    const f = fixture(t); const inside = join(f.root, 'input.json'); writeFileSync(inside, readFileSync(f.options[key])); f.options[key] = inside;
    assert.equal((await screen(f.options)).code, 'INPUT_CUSTODY');
  }
});

test('large valid JSON strings retain decoded identity matching without regex stack exhaustion', async t => {
  const bytes = '{"value":"' + 'x'.repeat(3 * 1024 * 1024) + '\\u0070rivate-alpha-workspace"}';
  const f = fixture(t, { 'large.json': bytes });
  assert.equal((await screen(f.options)).code, 'IDENTITY_MATCH');
});

test('registry entry count, lengths and duplicate IDs enforce their boundaries', async t => {
  for (const entries of [
    Array.from({ length: 257 }, (_, i) => ({ id: `entry-${i}`, value: `identity-${i}` })),
    [{ id: 'long', value: 'x'.repeat(1025) }],
    [{ id: 'short', value: 'abc' }],
    [{ id: 'same', value: 'value-one' }, { id: 'same', value: 'value-two' }],
  ]) {
    const f = fixture(t); f.registry.entries = entries; f.repin();
    assert.equal((await screen(f.options)).code, 'REGISTRY_INVALID');
  }
  const f = fixture(t); f.registry.entries = [{ id: 'boundary', value: 'x'.repeat(1024) }]; f.repin();
  assert.equal((await screen(f.options)).code, 'CLEAN');
});

test('JSON nesting and directory counts are bounded', async t => {
  const nested = '['.repeat(65) + '0' + ']'.repeat(65);
  const payload = fixture(t, { 'deep.json': nested });
  assert.equal((await screen(payload.options)).code, 'PAYLOAD_FORMAT');
  const input = fixture(t); const bytes = json(JSON.parse(nested));
  writeFileSync(input.options.registryPath, bytes); input.options.registrySha256 = sha(bytes);
  assert.equal((await screen(input.options)).code, 'REGISTRY_INVALID');
  const f = fixture(t);
  for (let i = 0; i < 1025; i++) mkdirSync(join(f.root, `directory-${i}`));
  assert.equal((await screen(f.options)).code, 'PAYLOAD_LIMIT');
});

test('findings beyond the reporting limit never produce a partial pass', async t => {
  const entries = Array.from({ length: 256 }, (_, i) => ({ id: `entry-${i}`, value: `identity-${i}-end` }));
  const f = fixture(t, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`file-${i}.md`, entries.map(entry => entry.value).join(' ')])));
  f.registry.entries = entries; f.repin();
  const result = await screen(f.options);
  assert.equal(result.status, 'not-evaluated'); assert.equal(result.code, 'PAYLOAD_LIMIT'); assert.deepEqual(result.findings, []);
});
