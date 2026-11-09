// CLI resolution: --cli, then IA_CLI_PATH (IA_METHOD_CLI as a fallback), then
// the repository's pinned install (never above its .git), then exactly the
// pinned version through npm's npx, run by node without a shell; never an
// `ia` on PATH, and no shipped file runs one.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliError, npxCli, PINNED, resolveCli, runIa, searchFolders } from '../scripts/lib/cli.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const TAIL = ['-y', '-p', `@inventarch/cli@${PINNED}`, '--', 'ia'];

function tree(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function installCli(dir, version) {
  const pkg = join(dir, 'node_modules', '@inventarch', 'cli');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version, bin: { ia: 'dist/main.js' } }));
  writeFileSync(join(pkg, 'dist', 'main.js'), '');
  return join(pkg, 'dist', 'main.js');
}

test('--cli wins over IA_CLI_PATH, IA_CLI_PATH over IA_METHOD_CLI, a relative path resolves, and a missing path is refused', t => {
  const dir = tree(t);
  const a = installCli(join(dir, 'a'), '3.1.1');
  const b = installCli(join(dir, 'b'), '2.0.1');
  assert.equal(resolveCli(dir, { cliPath: a, env: { IA_CLI_PATH: b } }).source, '--cli');
  const viaEnv = resolveCli(dir, { env: { IA_CLI_PATH: relative(process.cwd(), b), IA_METHOD_CLI: a } });
  assert.equal(viaEnv.source, 'IA_CLI_PATH');
  assert.equal(viaEnv.version, '2.0.1');
  assert.equal(viaEnv.argv[1], b);
  assert.equal(viaEnv.argv[0], process.execPath);
  assert.equal(resolveCli(dir, { env: { IA_METHOD_CLI: a } }).source, 'IA_METHOD_CLI');
  assert.throws(() => resolveCli(dir, { env: { IA_CLI_PATH: join(dir, 'absent.js') } }), e => e instanceof CliError && e.code === 'IA-CORE-CLI-MISSING');
});

test('an install that is not @inventarch/cli, or has no entry, is refused, never replaced by npx; an explicit entry reads its version beside it or one folder up', t => {
  const dir = tree(t);
  mkdirSync(join(dir, '.git'), { recursive: true });
  const main = installCli(dir, '3.1.1');
  const pkgFile = join(dir, 'node_modules', '@inventarch', 'cli', 'package.json');
  writeFileSync(pkgFile, JSON.stringify({ name: 'not-the-cli', version: '3.1.1', bin: { ia: 'dist/main.js' } }));
  assert.throws(() => resolveCli(dir, { env: {} }), e => e instanceof CliError && e.code === 'IA-CORE-CLI-MISSING' && /not-the-cli, not @inventarch\/cli/.test(e.message));
  writeFileSync(pkgFile, JSON.stringify({ name: '@inventarch/cli', version: '3.1.1', bin: { ia: 'dist/absent.js' } }));
  assert.throws(() => resolveCli(dir, { env: {} }), e => e instanceof CliError && e.code === 'IA-CORE-CLI-MISSING' && /has no entry/.test(e.message));
  // An entry with its own package.json beside it, and one whose package.json is one folder up.
  const flat = join(dir, 'flat');
  mkdirSync(flat);
  writeFileSync(join(flat, 'main.js'), '');
  writeFileSync(join(flat, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version: '3.1.1' }));
  assert.equal(resolveCli(dir, { env: { IA_CLI_PATH: join(flat, 'main.js') } }).version, '3.1.1');
  assert.equal(resolveCli(dir, { env: { IA_CLI_PATH: main } }).version, '3.1.1');
  // Another package's package.json gives no version.
  writeFileSync(join(flat, 'package.json'), JSON.stringify({ name: 'something-else', version: '9.9.9' }));
  assert.equal(resolveCli(dir, { env: { IA_CLI_PATH: join(flat, 'main.js') } }).version, undefined);
});

test('an install with main dist/main.js and bin.ia dist/bin.js (3.6.0) runs main, not the hand-off launcher', t => {
  const dir = tree(t);
  mkdirSync(join(dir, '.git'));
  const pkg = join(dir, 'node_modules', '@inventarch', 'cli');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version: PINNED, main: './dist/main.js', bin: { ia: './dist/bin.js' } }));
  writeFileSync(join(pkg, 'dist', 'main.js'), '');
  writeFileSync(join(pkg, 'dist', 'bin.js'), '');
  const local = resolveCli(dir, { env: {} });
  assert.equal(local.argv[0], process.execPath);
  assert.equal(local.argv[1], join(pkg, 'dist', 'main.js'));
  assert.equal(local.version, PINNED);
});

test('the repository install is found from a subfolder, and nothing above .git is searched', t => {
  const outer = tree(t);
  installCli(outer, '9.9.9');
  const repo = join(outer, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const sub = join(repo, 'packages', 'a');
  mkdirSync(sub, { recursive: true });
  assert.deepEqual(searchFolders(sub), [sub, join(repo, 'packages'), repo]);
  assert.equal(resolveCli(sub, { env: {} }).source, 'npx');
  installCli(repo, '3.1.1');
  const local = resolveCli(sub, { env: {} });
  assert.equal(local.version, '3.1.1');
  assert.equal(local.argv[0], process.execPath);
});

test('without an install it runs exactly the pinned version through the npx-cli.js next to node, unless npx is off', t => {
  const dir = tree(t);
  mkdirSync(join(dir, '.git'));
  const cli = resolveCli(dir, { env: {} });
  assert.deepEqual(cli.argv.slice(-TAIL.length), TAIL);
  if (npxCli()) assert.deepEqual(cli.argv.slice(0, 2), [process.execPath, npxCli()]);
  assert.throws(() => resolveCli(dir, { env: { IA_CORE_NO_NPX: '1' } }), e => e.code === 'IA-CORE-CLI-MISSING');
  assert.throws(() => resolveCli(dir, { env: {}, allowNpx: false }), e => e.code === 'IA-CORE-CLI-MISSING');
});

test('an ia on PATH is never resolved, with or without an install', t => {
  const dir = tree(t);
  mkdirSync(join(dir, '.git'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const name of ['ia', 'ia.cmd', 'ia.exe']) writeFileSync(join(bin, name), '');
  if (process.platform !== 'win32') chmodSync(join(bin, 'ia'), 0o755);
  const env = { PATH: bin + delimiter + (process.env.PATH ?? ''), Path: bin + delimiter + (process.env.Path ?? '') };
  const viaNpx = resolveCli(dir, { env });
  assert.notEqual(viaNpx.argv[0], 'ia');
  assert.ok(!viaNpx.argv[0].startsWith(bin), 'resolved into the PATH folder');
  assert.ok(viaNpx.argv[0] === process.execPath || viaNpx.argv[0] === 'npx');
  installCli(dir, '3.1.1');
  const viaInstall = resolveCli(dir, { env });
  assert.equal(viaInstall.argv[0], process.execPath);
  assert.ok(!viaInstall.argv.some(a => a === 'ia' || a.startsWith(bin)));
});

test('npxCli finds npm next to node on Windows and POSIX layouts', t => {
  const dir = tree(t);
  const win = join(dir, 'win');
  mkdirSync(join(win, 'node_modules', 'npm', 'bin'), { recursive: true });
  writeFileSync(join(win, 'node_modules', 'npm', 'bin', 'npx-cli.js'), '');
  assert.equal(npxCli(join(win, 'node.exe')), join(win, 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  const posix = join(dir, 'posix');
  mkdirSync(join(posix, 'bin'), { recursive: true });
  mkdirSync(join(posix, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
  writeFileSync(join(posix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), '');
  assert.equal(npxCli(join(posix, 'bin', 'node')), join(posix, 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  assert.equal(npxCli(join(dir, 'nowhere', 'node')), undefined);
});

const walk = dir => readdirSync(dir).flatMap(n => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

test('no shipped core file runs an ia on PATH, an unpinned CLI through npx, or a shell', () => {
  // The core's own files; each kit under config/kits/<kit>/ has its own tests, and its assets quote other material.
  const kits = join(PLUGIN, 'config', 'kits');
  const shipped = walk(PLUGIN).filter(f => /\.(md|mjs|json)$/.test(f) && !f.startsWith(join(PLUGIN, 'tests')) && !f.includes('node_modules') && (!f.startsWith(kits) || f === join(kits, 'README.md')));
  assert.ok(shipped.length > 10);
  for (const file of shipped) {
    const body = readFileSync(file, 'utf8');
    assert.doesNotMatch(body, /npx\s+(?:--no\s+)?ia\b/, `${file} runs ia through npx`);
    assert.doesNotMatch(body, /(?:npx|npm install)[^\n]*@inventarch\/cli(?!@(?:\d+\.\d+\.\d+|\$\{PINNED\}|<version>))/, `${file} installs or runs @inventarch/cli without an exact version`);
    assert.doesNotMatch(body, /(?:spawn|exec)\w*\(\s*'ia'/, `${file} runs an ia on PATH`);
    assert.doesNotMatch(body, /shell:\s*true/, `${file} spawns through a shell`);
    assert.ok(!body.includes('\r'), `${file} has CR bytes`);
  }
});

// public-cli-3-6-0-handoff: the CLI runIa chose is the one that runs. A fake CLI never hands off, so this proves only
// the child's argv and environment; the real hand-off path is judged by the native suite on 3.6.0.
test('runIa runs the IA_CLI_PATH entry with IA_NO_HANDOFF=1 while the repository installs another @inventarch/cli', t => {
  const dir = tree(t);
  mkdirSync(join(dir, '.git'));
  installCli(dir, '3.5.0');
  const chosen = installCli(join(dir, 'chosen'), PINNED);
  writeFileSync(chosen, "process.stdout.write(JSON.stringify({ entry: process.argv[1], args: process.argv.slice(2), handoff: process.env.IA_NO_HANDOFF ?? null }));");
  const saved = process.env.IA_CLI_PATH;
  process.env.IA_CLI_PATH = chosen;
  t.after(() => { if (saved === undefined) delete process.env.IA_CLI_PATH; else process.env.IA_CLI_PATH = saved; });
  const ran = runIa(dir, ['validate']);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.cli.source, 'IA_CLI_PATH');
  assert.equal(ran.cli.version, PINNED);
  assert.equal(realpathSync.native(ran.json.entry), realpathSync.native(chosen));
  assert.deepEqual(ran.json.args, ['validate', '--root', dir, '--json']);
  assert.equal(ran.json.handoff, '1');
});
