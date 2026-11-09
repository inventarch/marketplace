// Kits: listing, lookup by id or folder, the checks a kit declares (only
// those that are @check records), the capabilities it declares whole
// (delivery.json), the bindings it recommends and what it resolves outside a
// workspace (bindings.json), its on-write checks (onwrite.json), the sources
// digest, kit.mjs root restoring
// once into a private per-user folder (also under concurrent callers), status,
// kit.mjs's usage refusals, and adopt's refusals. Every
// kit here is built at runtime; the real kits ship under config/kits and get
// their own release tests (T3).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { adopt, findKit, kitBindings, kitChecks, kitDelivery, KitError, kitOnWrite, listKits, packRelease, sourcesDigest } from '../scripts/lib/kit.mjs';
import { kitRecordNames } from '../scripts/lib/records.mjs';
import { envFor, fakeCli, makeKit, makeRepo, run, sandbox, SCRIPTS } from './helpers/fixtures.mjs';

function kits(t) {
  const dir = sandbox(t, 'ia-core-kit-');
  const kitsDir = join(dir, 'kits');
  const a = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', checks: ['alpha-gate', 'alpha-fail'], undeclaredCheck: 'not-a-record' });
  const b = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit', version: '0.2.0', profile: null, checks: [] });
  return { dir, kitsDir, a, b, env: envFor({ cli: fakeCli(dir), kitsDir, temp: join(dir, 'temp') }) };
}

test('listKits and findKit see every kit folder with a releases.json, by id or folder', t => {
  const { kitsDir, a, b } = kits(t);
  const listed = listKits(kitsDir);
  assert.deepEqual(listed.map(k => [k.folder, k.id, k.version, k.latest.version]), [['alpha', a.id, '0.1.0', '0.1.0'], ['beta', b.id, '0.2.0', '0.2.0']]);
  assert.equal(findKit(a.id, kitsDir).folder, 'alpha');
  assert.equal(findKit('beta', kitsDir).id, b.id);
  assert.throws(() => findKit('inventarch/none-kit', kitsDir), e => e instanceof KitError && e.code === 'IA-CORE-KIT-UNKNOWN' && e.message.includes(a.id));
  assert.deepEqual(listKits(join(kitsDir, 'absent')), []);
});

test('kitChecks admits only checks that are @check records of the kit, with their fixed argv', t => {
  const { kitsDir, a, b } = kits(t);
  const { checks, undeclared } = kitChecks(findKit(a.id, kitsDir));
  assert.deepEqual(Object.keys(checks).sort(), ['alpha-fail', 'alpha-gate']);
  assert.deepEqual(undeclared, ['not-a-record']);
  assert.deepEqual(checks['alpha-gate'].argv, ['${NODE}', '${KIT}/check-ok.mjs']);
  assert.equal(checks['alpha-gate'].record, 'compliance-system/check/gate/alpha-gate');
  assert.deepEqual(kitChecks(findKit(b.id, kitsDir)), { checks: {}, undeclared: [] });
  assert.deepEqual(kitRecordNames(a.dir).filter(r => r.word === 'check').map(r => r.name), ['alpha-fail', 'alpha-gate']);
  writeFileSync(join(a.dir, 'checks.json'), JSON.stringify({ format: 1, checks: { 'alpha-gate': { argv: [] } } }));
  assert.throws(() => kitChecks(findKit(a.id, kitsDir)), e => e instanceof KitError && /non-empty argv/.test(e.message));
});

test('sourcesDigest ignores CRLF line endings and the distributions folder, and sees a content change', t => {
  const { kitsDir, a } = kits(t);
  const before = sourcesDigest(a.dir);
  const file = join(a.dir, '.ia', 'src', 'workspace.ia');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(sourcesDigest(a.dir), before);
  writeFileSync(file, readFileSync(file, 'utf8') + '\n');
  assert.notEqual(sourcesDigest(a.dir), before);
  assert.notEqual(sourcesDigest(a.dir), sourcesDigest(findKit('beta', kitsDir).dir));
});

test('kitDelivery reads the capabilities a kit declares whole, drops names that are not capabilities, and the sources digest covers the file', t => {
  const { kitsDir, a, b } = kits(t);
  assert.deepEqual(kitDelivery(findKit(b.id, kitsDir)), { whole: [], undeclared: [] }, 'no delivery.json declares nothing whole');
  const before = sourcesDigest(a.dir);
  writeFileSync(join(a.dir, 'delivery.json'), JSON.stringify({ format: 1, whole: [a.capability, 'alpha-gate', 'not-a-record'] }));
  assert.deepEqual(kitDelivery(findKit(a.id, kitsDir)), { whole: [a.capability], undeclared: ['alpha-gate', 'not-a-record'] }, 'only @capability records count; a check is not one');
  const declared = sourcesDigest(a.dir);
  assert.notEqual(declared, before, 'adding delivery.json changes the sources');
  writeFileSync(join(a.dir, 'delivery.json'), JSON.stringify({ format: 1, whole: [a.capability] }));
  assert.notEqual(sourcesDigest(a.dir), declared, 'editing it changes them again');
  for (const bad of [{ format: 2, whole: [] }, { format: 1 }, { format: 1, whole: 'fake-operate' }, { format: 1, whole: [''] }]) {
    writeFileSync(join(a.dir, 'delivery.json'), JSON.stringify(bad));
    assert.throws(() => kitDelivery(findKit(a.id, kitsDir)), e => e instanceof KitError && /delivery\.json is malformed/.test(e.message), JSON.stringify(bad));
  }
});

test('kitBindings reads the keys a kit recommends and its unbound list, drops names that are not its records, and the sources digest covers the file', t => {
  const { kitsDir, a, b } = kits(t);
  assert.deepEqual(kitBindings(findKit(b.id, kitsDir)), { recommend: {}, unbound: null, undeclared: [] }, 'no bindings.json recommends nothing and leaves unbound open');
  const before = sourcesDigest(a.dir);
  writeFileSync(join(a.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'delivery.design': { capability: a.capability }, 'work.*': { capability: a.capability, profile: a.profile }, 'knowledge.find': { capability: 'not-a-record' }, 'knowledge.read': { capability: a.capability, profile: 'nobody' } }, unbound: [a.capability, 'alpha-gate'] }));
  assert.deepEqual(kitBindings(findKit(a.id, kitsDir)), {
    recommend: { 'delivery.design': { kit: a.id, capability: a.capability }, 'work.*': { kit: a.id, capability: a.capability, profile: a.profile } },
    unbound: [a.capability],
    undeclared: ['knowledge.find', 'knowledge.read', 'alpha-gate'],
  }, 'a capability or profile that is not a record of the kit is dropped; a check is not a capability');
  assert.notEqual(sourcesDigest(a.dir), before, 'adding bindings.json changes the sources');
  for (const bad of [{ format: 2, recommend: {} }, { format: 1 }, { format: 1, recommend: [] }, { format: 1, recommend: {}, unbound: 'x' }, { format: 1, recommend: { 'design.x': { capability: a.capability } } }, { format: 1, recommend: { 'work.task': a.capability } }, { format: 1, recommend: { 'work.Task': { capability: a.capability } } }]) {
    writeFileSync(join(a.dir, 'bindings.json'), JSON.stringify(bad));
    assert.throws(() => kitBindings(findKit(a.id, kitsDir)), e => e instanceof KitError && /bindings\.json/.test(e.message), JSON.stringify(bad));
  }
});

test('kitOnWrite reads the on-write checks a kit declares with their defaults, refuses a malformed entry, and the sources digest covers the file', t => {
  const { kitsDir, a } = kits(t);
  assert.deepEqual(kitOnWrite(findKit(a.id, kitsDir)), []);
  const before = sourcesDigest(a.dir);
  writeFileSync(join(a.dir, 'onwrite.json'), JSON.stringify({ format: 1, onWrite: [{ name: 'card', extensions: ['.MD'], marker: 'design.index.md', argv: ['${NODE}', '${KIT}/check-ok.mjs'] }, { name: 'any', extensions: ['.ia'], maxDepth: 0, argv: ['${NODE}', '-e', '0'], timeout: 5 }] }));
  assert.deepEqual(kitOnWrite(findKit(a.id, kitsDir)), [
    { name: 'card', extensions: ['.md'], marker: 'design.index.md', maxDepth: 12, argv: ['${NODE}', '${KIT}/check-ok.mjs'], timeout: 20 },
    { name: 'any', extensions: ['.ia'], marker: null, maxDepth: 0, argv: ['${NODE}', '-e', '0'], timeout: 5 },
  ]);
  assert.notEqual(sourcesDigest(a.dir), before);
  const entry = { name: 'card', extensions: ['.md'], argv: ['${NODE}'] };
  for (const bad of [{ format: 1 }, { format: 1, onWrite: [{ ...entry, name: 'Card' }] }, { format: 1, onWrite: [{ ...entry, extensions: ['md'] }] }, { format: 1, onWrite: [{ ...entry, marker: 'a/b.md' }] }, { format: 1, onWrite: [{ ...entry, argv: [] }] }, { format: 1, onWrite: [{ ...entry, timeout: 30 }] }, { format: 1, onWrite: [{ ...entry, maxDepth: -1 }] }, { format: 1, onWrite: [{ ...entry, argv: ['${IA}', 'capture'] }] }, { format: 1, onWrite: [{ ...entry, argv: ['${NODE}', '${WORKSPACE}/x.mjs'] }] }]) {
    writeFileSync(join(a.dir, 'onwrite.json'), JSON.stringify(bad));
    assert.throws(() => kitOnWrite(findKit(a.id, kitsDir)), e => e instanceof KitError && /onwrite\.json/.test(e.message), JSON.stringify(bad));
  }
});

test('kit.mjs list shows the keys each kit recommends and its unbound list', t => {
  const { a, b, env } = kits(t);
  writeFileSync(join(a.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'work.task': { capability: a.capability }, 'delivery.design': { capability: a.capability } }, unbound: [a.capability] }));
  const list = run('kit.mjs', ['list'], env);
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.deepEqual(list.json.kits.map(k => [k.id, k.offers, k.unbound]), [[a.id, ['delivery.design', 'work.task'], [a.capability]], [b.id, [], null]]);
});

test('kit.mjs list, root and status; root restores once into a private per-user folder and reuses it', t => {
  const { dir, a, b, env } = kits(t);
  const list = run('kit.mjs', ['list'], env);
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.deepEqual(list.json.kits.map(k => [k.id, k.checks]), [[a.id, ['alpha-fail', 'alpha-gate']], [b.id, []]]);
  const first = run('kit.mjs', ['root', a.id], env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const { root } = first.json;
  assert.ok(root.startsWith(join(dir, 'temp')), root);
  assert.ok(root.includes('kit-alpha-'));
  assert.ok(existsSync(join(root, '.ia', 'distributions', 'active.json')));
  assert.ok(existsSync(join(root, '.ia', 'src', 'workspace.ia')));
  assert.equal(run('kit.mjs', ['root', 'alpha'], env).json.root, root);
  assert.notEqual(run('kit.mjs', ['root', b.id], env).json.root, root);
  assert.deepEqual(readdirSync(join(root, '..')).filter(n => n.startsWith('tmp-')), []);
  const repo = makeRepo(join(dir, 'repo'), { lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: a.id, version: '0.1.0', archive: a.archive }] } });
  const status = run('kit.mjs', ['status', a.id, repo], env);
  assert.deepEqual(status.json, { root: repo, kit: a.id, installed: { version: '0.1.0', archive: a.archive }, latest: { version: '0.1.0', archive: a.archive }, current: true });
  assert.equal(run('kit.mjs', ['status', b.id, repo], env).json.installed, null);
  assert.equal(run('kit.mjs', ['root', 'inventarch/none-kit'], env).status, 1);
});

// A release packed with CLI 3.x locks a 3.x language base, which an older major cannot restore: root says so and
// names the pin, instead of passing on the restore's registry refusal.
test('kit.mjs root refuses a CLI of an older major than the one the release was packed with', t => {
  const { dir, a, kitsDir } = kits(t);
  const old = run('kit.mjs', ['root', a.id], envFor({ cli: fakeCli(join(dir, 'old'), '2.0.0'), kitsDir, temp: join(dir, 'temp') }));
  assert.equal(old.status, 1, old.stdout + old.stderr);
  assert.equal(old.json.error.code, 'IA-CORE-CLI-UNSUPPORTED');
  assert.match(old.json.error.message, /packed with @inventarch\/cli 3.6.0/);
  assert.match(old.json.error.message, /resolves 2\.0\.0/);
  assert.deepEqual(readdirSync(join(dir, 'temp')).filter(n => n.startsWith('inventarch-core-')).flatMap(n => readdirSync(join(dir, 'temp', n))), [], 'nothing is restored');
  const same = run('kit.mjs', ['root', a.id], envFor({ cli: fakeCli(join(dir, 'same'), '3.0.0'), kitsDir, temp: join(dir, 'temp') }));
  assert.equal(same.status, 0, same.stdout + same.stderr);
});

// Within a major a CLI restores only the language base it ships (CLI 3.6.0, 3.5.0, 3.4.0 and 3.3.0 ship language 3.2.0, 3.2.2 ships 3.1.2),
// and asks a registry for any other, which refuses as unavailable or, from the default registry, as no longer listing
// that base: root turns either refusal into the pin to use.
test('kit.mjs root refuses a CLI of the same major that does not ship the language base the kit locks', t => {
  const { dir, a, kitsDir } = kits(t);
  for (const refusal of ['restoreUnavailable', 'restoreDelisted']) {
    const other = run('kit.mjs', ['root', a.id], envFor({ cli: fakeCli(join(dir, refusal), '3.2.2', { [refusal]: true }), kitsDir, temp: join(dir, 'temp') }));
    assert.equal(other.status, 1, other.stdout + other.stderr);
    assert.equal(other.json.error.code, 'IA-CORE-CLI-UNSUPPORTED', refusal);
    assert.match(other.json.error.message, /locks inventarch\/language 3\.2\.0, which this repository's CLI does not ship/);
    assert.match(other.json.error.message, /resolves 3\.2\.2/);
    assert.match(other.json.error.message, /Pin @inventarch\/cli 3.6.0/);
    assert.deepEqual(readdirSync(join(dir, 'temp')).filter(n => n.startsWith('inventarch-core-')).flatMap(n => readdirSync(join(dir, 'temp', n))), [], 'no partial copy is left');
  }
  // With the CLI the release was packed with, the base is one it ships, so either refusal is a real missing artifact:
  // it is reported as the restore's own failure, never as advice to pin the version already running. So is a conflict
  // that is not the registry delisting the base, whatever the CLI.
  for (const [version, refusal, code] of [['3.6.0', 'restoreUnavailable', 'IA-DIST-ARTIFACT-UNAVAILABLE'], ['3.6.0', 'restoreDelisted', 'IA-DIST-CONFLICT'], ['3.2.2', 'restoreConflict', 'IA-DIST-CONFLICT']]) {
    const reported = run('kit.mjs', ['root', a.id], envFor({ cli: fakeCli(join(dir, `${refusal}-${version}`), version, { [refusal]: true }), kitsDir, temp: join(dir, 'temp') }));
    assert.equal(reported.status, 1, reported.stdout + reported.stderr);
    assert.equal(reported.json.error.code, 'IA-CORE-KIT', `${refusal} with ${version}`);
    assert.match(reported.json.error.message, new RegExp(`ia restore of the kit workspace failed: .*${code}`));
  }
});

// From #36's read-root tests: every usage error exits 2 before anything runs.
test('kit.mjs refuses unknown commands, unknown flags, missing and extra arguments with exit 2', t => {
  const { dir, a, env } = kits(t);
  const notWorkspace = join(dir, 'temp');
  for (const args of [[], ['bogus'], ['root'], ['root', a.id, 'extra'], ['status'], ['status', a.id, notWorkspace, 'extra'], ['adopt', a.id], ['adopt', a.id, notWorkspace, '--force'], ['list', 'extra'], ['root', a.id, '--dry-run']]) {
    const refused = run('kit.mjs', args, env);
    assert.equal(refused.status, 2, `kit.mjs ${args.join(' ')}: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /^usage: kit\.mjs /);
  }
});

// From #36's read-root tests: a CLI whose restore writes the active marker
// after a delay, as ia restore does at its end, so the callers overlap.
test('concurrent kit.mjs root calls all return the same complete copy and leave no temporary folder', async t => {
  const { dir, kitsDir, a } = kits(t);
  const slow = join(dir, 'slow-ia.mjs');
  writeFileSync(slow, [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const args = process.argv.slice(2);',
    "const root = args[args.indexOf('--root') + 1];",
    "if (args[0] === 'restore') {",
    '  await new Promise(r => setTimeout(r, 150));',
    "  mkdirSync(join(root, '.ia', 'distributions'), { recursive: true });",
    "  writeFileSync(join(root, '.ia', 'distributions', 'active.json'), '{}');",
    "  process.stdout.write('{\"status\":\"restored\"}');",
    '} else process.exit(2);',
    '',
  ].join(String.fromCharCode(10)));
  const env = envFor({ cli: slow, kitsDir, temp: join(dir, 'temp') });
  const one = () => new Promise(done => {
    const child = spawn(process.execPath, [join(SCRIPTS, 'kit.mjs'), 'root', a.id], { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => done({ code, out }));
  });
  const results = await Promise.all(Array.from({ length: 6 }, one));
  for (const r of results) assert.equal(r.code, 0, r.out);
  const roots = new Set(results.map(r => JSON.parse(r.out).root));
  assert.equal(roots.size, 1);
  const [root] = roots;
  assert.ok(existsSync(join(root, '.ia', 'distributions', 'active.json')));
  assert.ok(existsSync(join(root, '.ia', 'src', 'workspace.ia')));
  assert.deepEqual(readdirSync(join(root, '..')).filter(n => n.startsWith('tmp-')), []);
});

test('adopt refuses a folder that is not an IA workspace, and packRelease refuses another CLI version', t => {
  const { dir, kitsDir, a } = kits(t);
  const kit = findKit(a.id, kitsDir);
  assert.throws(() => adopt(join(dir, 'temp'), kit, { cli: { argv: [process.execPath, 'none'], version: '2.0.0' } }), e => e instanceof KitError && /not an IA workspace/.test(e.message));
  assert.throws(() => packRelease(kit, kit.latest, { argv: [process.execPath, 'none'], version: '9.9.9' }), e => e instanceof KitError && /would not reproduce/.test(e.message));
  const dry = run('kit.mjs', ['adopt', a.id, join(dir, 'temp'), '--dry-run'], envFor({ cli: fakeCli(dir), kitsDir, temp: join(dir, 'temp') }));
  assert.equal(dry.status, 1);
  assert.match(dry.json.error.message, /not an IA workspace/);
});

test('kitChecks reads an optional per-check timeout in seconds, defaults it to 600 and refuses a non-positive or non-integer one', t => {
  const { kitsDir, a } = kits(t);
  const write = timeout => writeFileSync(join(a.dir, 'checks.json'), JSON.stringify({ format: 1, checks: { 'alpha-gate': { argv: ['${NODE}'], ...(timeout === undefined ? {} : { timeout }) } } }));
  write();
  assert.equal(kitChecks(findKit(a.id, kitsDir)).checks['alpha-gate'].timeout, 600);
  write(21600);
  assert.equal(kitChecks(findKit(a.id, kitsDir)).checks['alpha-gate'].timeout, 21600);
  for (const bad of [0, -1, 1.5, '60']) {
    write(bad);
    assert.throws(() => kitChecks(findKit(a.id, kitsDir)), e => e instanceof KitError && /timeout/.test(e.message), String(bad));
  }
});
