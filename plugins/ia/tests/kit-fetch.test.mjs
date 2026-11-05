// scripts/kit-fetch.mjs (decision public-account-connector): a kit archive the account connector offered is
// downloaded only over https, written only when its bytes hash to the offered SHA-256, never echoes the signed
// URL, and cleans up after itself. The install itself is kit.mjs add --from, covered by kit-ops.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { cleanFetched, expectedDigest, fetchKit, MAX_BYTES } from '../scripts/kit-fetch.mjs';
import { kitRecordNames } from '../scripts/lib/records.mjs';
import { sourcesDigest } from '../scripts/lib/kit.mjs';
import { envFor, fakeCli, makeKit, run, sandbox } from './helpers/fixtures.mjs';

const bytes = Buffer.from('not really a tarball, only bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const URL_SECRET = 'https://downloads.example.invalid/kit.tgz?X-Signature=SECRET-SIGNATURE';
const reply = (body = bytes, init = {}) => async () => new Response(body, { status: 200, ...init });
const entry = (over = {}) => ({ id: 'inventarch/some-kit', version: '1.2.0', url: URL_SECRET, archive: digest, ...over });

test('a download whose bytes hash to the offered digest is written as <id>-<version>.tgz in its own folder', async t => {
  const tmp = join(sandbox(t), 'temp');
  const out = await fetchKit(entry({ archive: `sha256:${digest.toUpperCase()}` }), { fetchImpl: reply(), tmp });
  assert.equal(out.sha256, digest);
  assert.equal(out.bytes, bytes.length);
  assert.equal(basename(out.file), 'inventarch-some-kit-1.2.0.tgz');
  assert.match(basename(dirname(out.file)), /^ia-kit-fetch-/);
  assert.deepEqual(readFileSync(out.file), bytes);
});

test('a digest mismatch writes nothing and says so without the URL', async t => {
  const tmp = join(sandbox(t), 'temp');
  await assert.rejects(fetchKit(entry({ archive: 'a'.repeat(64) }), { fetchImpl: reply(), tmp }), error => {
    assert.equal(error.code, 'IA-CORE-KIT-FETCH-DIGEST');
    assert.match(error.message, /nothing was written/);
    assert.doesNotMatch(error.message, /SECRET-SIGNATURE/);
    return true;
  });
  assert.deepEqual(readdirSync(tmp), []);
});

test('only https URLs, well-formed digests, ok responses and bounded sizes are accepted', async t => {
  const tmp = join(sandbox(t), 'temp');
  await assert.rejects(fetchKit(entry({ url: 'http://example.invalid/k.tgz' }), { fetchImpl: reply(), tmp }), /must be https/);
  await assert.rejects(fetchKit(entry({ url: 'not a url' }), { fetchImpl: reply(), tmp }), /not a URL/);
  assert.throws(() => expectedDigest('abc'), /64 hex digits/);
  assert.throws(() => expectedDigest(undefined), /64 hex digits/);
  assert.equal(expectedDigest(`SHA256:${digest}`), digest);
  await assert.rejects(fetchKit(entry(), { fetchImpl: async () => new Response('', { status: 403 }), tmp }), /HTTP 403.*expired/);
  await assert.rejects(fetchKit(entry(), { fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, tmp }), error => {
    assert.match(error.message, /ENOTFOUND/);
    assert.doesNotMatch(error.message, /SECRET-SIGNATURE/);
    return true;
  });
  await assert.rejects(fetchKit(entry(), { fetchImpl: reply(bytes, { headers: { 'content-length': String(MAX_BYTES + 1) } }), tmp }), /over \d+ bytes/);
  assert.deepEqual(readdirSync(tmp), [], 'every refusal left nothing behind');
});

test('clean removes a download and its folder, and refuses any other path', async t => {
  const tmp = join(sandbox(t), 'temp');
  const { file } = await fetchKit(entry(), { fetchImpl: reply(), tmp });
  assert.deepEqual(cleanFetched(file, { tmp }), { removed: true });
  assert.equal(existsSync(dirname(file)), false);
  assert.deepEqual(cleanFetched(file, { tmp }), { removed: false }, 'already gone');
  assert.throws(() => cleanFetched(join(tmp, 'x.tgz'), { tmp }), /not a download of this script/);
});

test('the command line reads the entry from stdin, prints no URL, and refuses bad input', t => {
  const dir = sandbox(t);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: join(dir, 'temp'), TMP: join(dir, 'temp'), TMPDIR: join(dir, 'temp') };
  assert.equal(run('kit-fetch.mjs', ['get'], env, { input: '' }).status, 2);
  assert.equal(run('kit-fetch.mjs', [], env).status, 2);
  const insecure = run('kit-fetch.mjs', ['get'], env, { input: JSON.stringify(entry({ url: 'http://example.invalid/SECRET-SIGNATURE' })) });
  assert.equal(insecure.status, 1);
  assert.equal(insecure.json.error.code, 'IA-CORE-KIT-FETCH-ARGS');
  assert.doesNotMatch(insecure.stdout + insecure.stderr, /SECRET-SIGNATURE/);
  const badDigest = run('kit-fetch.mjs', ['get'], env, { input: JSON.stringify(entry({ archive: 'zz' })) });
  assert.equal(badDigest.status, 1);
  assert.deepEqual(readdirSync(join(dir, 'temp')), []);
});

// A kit folder, released the way kit-ops.test does, packed to a .tgz: the shape kit.mjs add --from takes.
function releasedKit(dir) {
  const kit = makeKit(dir, { folder: 'delta', id: 'inventarch/delta-kit', version: '2.0.0' });
  const index = JSON.parse(readFileSync(join(kit.dir, 'releases.json'), 'utf8'));
  const [row] = index.releases;
  const { records, ...rest } = row;
  mkdirSync(join(kit.dir, 'releases'), { recursive: true });
  writeFileSync(join(kit.dir, 'releases', `${row.version}.json`), JSON.stringify({ format: 2, kit: index.kit, version: row.version, archive: row.archive, records: kitRecordNames(kit.dir) }));
  writeFileSync(join(kit.dir, 'releases.json'), JSON.stringify({ format: 2, kit: index.kit, latest: row.version, releases: [{ ...rest, sources: sourcesDigest(kit.dir), file: `releases/${row.version}.json` }] }));
  return kit;
}

test('a fetched archive installs through the existing kit.mjs add --from, and clean removes it', async t => {
  const dir = sandbox(t, 'ia-core-fetch-');
  const kit = releasedKit(join(dir, 'incoming'));
  const tarball = join(dir, 'delta.tgz');
  const packed = spawnSync('tar', ['-czf', 'delta.tgz', '-C', 'incoming/delta', '.'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr);
  const body = readFileSync(tarball);
  const tmp = join(dir, 'temp');
  const fetched = await fetchKit({ id: 'inventarch/delta-kit', version: '2.0.0', url: URL_SECRET, archive: createHash('sha256').update(body).digest('hex') }, { fetchImpl: reply(body), tmp });
  const home = join(dir, 'ia-home');
  mkdirSync(home, { recursive: true });
  const env = { ...envFor({ cli: fakeCli(dir), kitsDir: join(dir, 'kits'), temp: dir }), IA_HOME: home };
  delete env.IA_CORE_NO_HOME_KITS;
  const preview = run('kit.mjs', ['add', '--from', fetched.file], env);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(preview.json.wouldInstall, true);
  const applied = run('kit.mjs', ['add', '--from', fetched.file, '--apply'], env);
  assert.equal(applied.json.installed, true, applied.stdout + applied.stderr);
  assert.ok(existsSync(join(home, 'kits', 'delta', '2.0.0', 'releases.json')));
  assert.deepEqual(cleanFetched(fetched.file, { tmp }), { removed: true });
  assert.deepEqual(readdirSync(tmp), []);
});
