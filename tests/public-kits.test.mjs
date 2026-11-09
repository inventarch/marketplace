// The @inventarch/public-kits package (tools/public-kits.mjs, decision
// public-kits-package): its committed package.json is the claim the bundled
// kits make, and its built files are theirs. Building packs every recorded
// release again, so that case runs only with IA_CORE_TEST_CLI set to the
// pinned @inventarch/cli dist/main.js (as the native lane does).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReleases, sourcesDigest } from '../plugins/ia/scripts/lib/kit.mjs';
import { archiveManifest, build, builtProblems, manifestProblems, packageClaim, packageMain, PACKAGE_DIR, PLUGIN_CONFIG } from '../tools/public-kits.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = process.env.IA_CORE_TEST_CLI;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// A copy of what the package is generated from.
function copy(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'public-kits-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const rel of ['plugins/ia/config/kits', 'plugins/ia/config/public-kits.json', 'kits/index.json', 'LICENSE', 'NOTICE', `${PACKAGE_DIR}/package.json`, `${PACKAGE_DIR}/README.md`]) cpSync(join(ROOT, rel), join(dir, rel), { recursive: true });
  return dir;
}
const run = (root, ...argv) => { let out = '', err = ''; const status = packageMain(argv, root, t => { out += t; }, t => { err += t; }); return { status, out, err }; };

test('the committed package.json is the bundled kits\' claim: latest release, archive, manifest, sources and folder', () => {
  assert.deepEqual(manifestProblems(ROOT), []);
  const pkg = JSON.parse(readFileSync(join(ROOT, PACKAGE_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@inventarch/public-kits');
  assert.equal(pkg.license, 'Apache-2.0');
  for (const key of ['scripts', 'dependencies', 'exports', 'bin', 'main', 'private']) assert.equal(pkg[key], undefined, key);
  assert.deepEqual(pkg.files, ['index.json', 'kits', 'archives', 'NOTICE']);
  assert.equal(pkg.ia.format, 1);
  assert.deepEqual(pkg.ia.kits.map(k => k.folder), ['ia-authoring', 'ia-kb', 'ia-method']);
  for (const row of pkg.ia.kits) {
    const dir = join(ROOT, 'plugins/ia/config/kits', row.folder);
    const index = readReleases(dir);
    const latest = index.releases.find(r => r.version === index.latest);
    assert.deepEqual(row, { id: index.kit, version: latest.version, archive: latest.archive, manifest: latest.manifest, sources: sourcesDigest(dir), folder: row.folder });
  }
});

test('package --check refuses a stale claim, a changed field and a declared script', t => {
  const root = copy(t);
  assert.equal(run(root, '--check').status, 0);
  const path = join(root, PACKAGE_DIR, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const write = value => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  write({ ...pkg, ia: { ...pkg.ia, kits: pkg.ia.kits.map((k, i) => (i ? k : { ...k, manifest: '0'.repeat(64) })) } });
  assert.match(run(root, '--check').err, /is not the claim the bundled kits make/);
  write({ ...pkg, scripts: { postinstall: 'node x.js' } });
  assert.match(run(root, '--check').err, /declares scripts/);
  write({ ...pkg, version: '1.0' });
  assert.match(run(root, '--check').err, /is not strict semver/);
  write(pkg);
  // A bundled kit whose bytes are not its recorded release makes no claim.
  writeFileSync(join(root, 'plugins/ia/config/kits/ia-kb/.ia/release.json'), readFileSync(join(root, 'plugins/ia/config/kits/ia-kb/.ia/release.json'), 'utf8') + '\n');
  assert.throws(() => packageClaim(root), /ia-kb is not its recorded release/);
  assert.equal(run(root, '--check').status, 1);
});

test('the core config/public-kits.json is the package name and version, and package --check refuses drift or a missing file', t => {
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, PLUGIN_CONFIG), 'utf8')), { package: '@inventarch/public-kits', version: JSON.parse(readFileSync(join(ROOT, PACKAGE_DIR, 'package.json'), 'utf8')).version });
  const root = copy(t);
  const path = join(root, PLUGIN_CONFIG);
  assert.equal(run(root, '--check').status, 0);
  writeFileSync(path, JSON.stringify({ package: '@inventarch/public-kits', version: '9.9.9' }, null, 2) + '\n');
  assert.match(run(root, '--check').err, /public-kits\.json is not @inventarch\/public-kits@1\.0\.\d+/);
  writeFileSync(path, JSON.stringify({ package: '@inventarch/public-kits', version: JSON.parse(readFileSync(join(root, PACKAGE_DIR, 'package.json'), 'utf8')).version, kits: {} }, null, 2) + '\n');
  assert.equal(run(root, '--check').status, 1, 'a field beyond the package and version is drift');
  rmSync(path);
  assert.match(run(root, '--check').err, /public-kits\.json is missing/);
});

test('package --check refuses runtime sidecars omitted from release assets', t => {
  const root = copy(t);
  const path = join(root, 'plugins/ia/config/kits/ia-method/.ia/release.json');
  const descriptor = JSON.parse(readFileSync(path, 'utf8'));
  descriptor.assets = descriptor.assets.filter(asset => asset.path !== 'bindings.json');
  writeFileSync(path, JSON.stringify(descriptor));
  assert.throws(() => packageClaim(root), /bindings.json must be a declared release asset/);
});

test('package --write keeps the maintainer\'s version and rewrites only the generated fields', t => {
  const root = copy(t);
  const path = join(root, PACKAGE_DIR, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...pkg, version: '1.2.3', description: 'hand-edited', ia: { format: 1, kits: [] } }, null, 2) + '\n');
  // Without a CLI the build refuses after the claim is written; the claim is what this case checks.
  const saved = { path: process.env.IA_CLI_PATH, npx: process.env.IA_CORE_NO_NPX };
  delete process.env.IA_CLI_PATH;
  process.env.IA_CORE_NO_NPX = '1';
  t.after(() => { for (const [k, v] of [['IA_CLI_PATH', saved.path], ['IA_CORE_NO_NPX', saved.npx]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const result = run(root, '--write');
  assert.equal(result.status, 1);
  assert.match(result.err, /IA-CORE-CLI-MISSING/);
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.version, '1.2.3');
  assert.deepEqual(written.ia.kits, pkg.ia.kits);
  assert.equal(written.description, pkg.description);
  assert.match(result.out, /package\.json written \(version 1\.2\.3; bump it if a carried release changed\)/);
});

test('built files are checked when present, and required with --built', t => {
  const root = copy(t);
  assert.match(run(root, '--check', '--built').err, /is not built; run node tools\/kit\.mjs package --build/);
  const pkg = join(root, PACKAGE_DIR);
  cpSync(join(root, 'kits/index.json'), join(pkg, 'index.json'));
  const problems = builtProblems(root).join('\n');
  assert.match(problems, /LICENSE is missing/);
  assert.match(problems, /kits\/ia-kb is not plugins\/ia\/config\/kits\/ia-kb: missing /);
  assert.match(problems, /archives\/[0-9a-f]{64}\.ia\.tgz \(inventarch\/ia-kb-kit [0-9.]+\) is missing/);
  assert.equal(run(root, '--check').status, 1);
  assert.equal(run(root, '--bogus').status, 2);
});

test('package --build packs every recorded release; its archives and manifests carry the recorded digests', { skip: !CLI && 'set IA_CORE_TEST_CLI to the pinned @inventarch/cli dist/main.js', timeout: 600_000 }, t => {
  const root = copy(t);
  const saved = process.env.IA_CLI_PATH;
  process.env.IA_CLI_PATH = CLI;
  t.after(() => { if (saved === undefined) delete process.env.IA_CLI_PATH; else process.env.IA_CLI_PATH = saved; });
  build(root);
  assert.deepEqual(builtProblems(root, { required: true }), []);
  const pkg = join(root, PACKAGE_DIR);
  for (const k of packageClaim(root)) {
    const bytes = readFileSync(join(pkg, 'archives', `${k.archive}.ia.tgz`));
    assert.equal(sha256(bytes), k.archive, `${k.id} archive`);
    assert.equal(sha256(readFileSync(join(pkg, 'archives', `${k.archive}.distribution.json`))), k.manifest, `${k.id} manifest`);
    assert.equal(sha256(archiveManifest(bytes)), k.manifest);
    const files = JSON.parse(archiveManifest(bytes)).files;
    for (const sidecar of ['bindings.json', 'delivery.json'])
      assert.ok(files.some(file => file.path === sidecar && file.role === 'asset'), `${k.id} retains ${sidecar}`);
  }
  const [first] = packageClaim(root);
  const manifest = join(pkg, 'archives', `${first.archive}.distribution.json`);
  writeFileSync(manifest, readFileSync(manifest, 'utf8') + ' ');
  assert.match(builtProblems(root).join('\n'), /distribution\.json is not the archive's manifest/);
  const archive = join(pkg, 'archives', `${first.archive}.ia.tgz`);
  const bytes = readFileSync(archive);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(archive, bytes);
  assert.match(builtProblems(root).join('\n'), new RegExp(`${first.archive}\\.ia\\.tgz is not ${first.id.replace('/', '\\/')}`));
  mkdirSync(join(pkg, 'archives', 'stray'));
  assert.match(builtProblems(root).join('\n'), /archives holds stray/);
});
