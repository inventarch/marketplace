// Resolves and runs the IA CLI, in the order the catalogue's AGENTS.md and
// docs/adding-plugins.md set: an explicit path (the --cli option, then
// IA_CLI_PATH; IA_METHOD_CLI is still honoured for callers of the method
// plugin), then the repository's own pinned install (walking up from the root
// to the nearest .git, never above it), then the exact published version
// through npx. Never an `ia` on PATH, never a source checkout, and never a
// shell: on Windows npx is npm's npx-cli.js run by node, because cmd.exe would
// expand %VAR% and mangle quoted arguments.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// The CLI the kits' releases were packed with; adoption needs exactly this one.
export const PINNED = '3.8.0';

export class CliError extends Error {
  constructor(message, code = 'IA-CORE-CLI') { super(message); this.code = code; }
}

// The folders searched for an installed package: root, then each parent up to
// the first one holding .git (a folder, or a worktree's file). Outside any
// repository only root itself is searched.
export function searchFolders(root) {
  const start = resolve(root);
  const folders = [];
  for (let dir = start; ;) {
    folders.push(dir);
    if (existsSync(join(dir, '.git'))) return folders;
    const parent = dirname(dir);
    if (parent === dir || folders.length >= 64) return [start];
    dir = parent;
  }
}

// The repository's own install: the first node_modules/@inventarch/cli on the
// way up, which must be that package and must carry its entry; an install
// that is not is refused rather than skipped, so a broken install is never
// silently replaced by npx.
function installed(root) {
  for (const dir of searchFolders(root)) {
    const pkgFile = join(dir, 'node_modules', '@inventarch', 'cli', 'package.json');
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    if (pkg.name !== '@inventarch/cli') throw new CliError(`${pkgFile} names ${pkg.name ?? 'no package'}, not @inventarch/cli: reinstall @inventarch/cli@${PINNED} or set IA_CLI_PATH`, 'IA-CORE-CLI-MISSING');
    // From 3.8.0 `bin` is the hand-off launcher (dist/bin.js); `main` is the CLI itself, and the qualified runtime admits only it.
    const entry = typeof pkg.main === 'string' ? pkg.main : typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.ia ?? 'dist/main.js';
    const main = join(dirname(pkgFile), entry);
    if (!existsSync(main)) throw new CliError(`the installed @inventarch/cli ${pkg.version ?? ''} has no entry ${main}: reinstall it or set IA_CLI_PATH`, 'IA-CORE-CLI-MISSING');
    return { argv: [process.execPath, main], version: pkg.version, source: dirname(pkgFile) };
  }
  return undefined;
}

// npm's npx entry point next to the running node: node_modules/npm on
// Windows, lib/node_modules/npm on POSIX installs.
export function npxCli(execPath = process.execPath) {
  const home = dirname(execPath);
  return [join(home, 'node_modules', 'npm', 'bin', 'npx-cli.js'), join(home, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')].find(p => existsSync(p));
}

// An explicit entry: its version from the @inventarch/cli package.json beside
// it or one folder up (dist/main.js), so a version floor is never skipped
// for want of a version.
function explicit(path, source) {
  const main = resolve(path);
  if (!existsSync(main)) throw new CliError(`${source} points at ${main}, which does not exist`, 'IA-CORE-CLI-MISSING');
  const pkg = [join(dirname(main), 'package.json'), join(dirname(main), '..', 'package.json')].map(file => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)).find(p => p?.name === '@inventarch/cli' && p.version);
  return { argv: [process.execPath, main], version: pkg?.version, source };
}

// Returns { argv, version, source }: argv is the command that runs `ia`.
// Options: cliPath (the --cli option), env, platform, allowNpx (false skips the
// npx fallback and refuses instead, as a hook with a time budget needs).
export function resolveCli(root, { cliPath, env = process.env, platform = process.platform, allowNpx = true } = {}) {
  if (cliPath) return explicit(cliPath, '--cli');
  if (env.IA_CLI_PATH) return explicit(env.IA_CLI_PATH, 'IA_CLI_PATH');
  if (env.IA_METHOD_CLI) return explicit(env.IA_METHOD_CLI, 'IA_METHOD_CLI');
  const local = installed(root);
  if (local) return local;
  if (!allowNpx || env.IA_CORE_NO_NPX || env.IA_METHOD_NO_NPX) throw new CliError(`no @inventarch/cli is installed in this repository and the npx fallback is off (set IA_CLI_PATH, or install @inventarch/cli@${PINNED})`, 'IA-CORE-CLI-MISSING');
  // -p names the exact package and -- keeps npm's options apart from the CLI's.
  const tail = ['-y', '-p', `@inventarch/cli@${PINNED}`, '--', 'ia'];
  const script = npxCli();
  if (script) return { argv: [process.execPath, script, ...tail], version: PINNED, source: 'npx' };
  if (platform === 'win32') throw new CliError(`npm's npx-cli.js is not next to ${process.execPath}; install @inventarch/cli@${PINNED} in the repository or set IA_CLI_PATH`, 'IA-CORE-CLI-MISSING');
  return { argv: ['npx', ...tail], version: PINNED, source: 'npx' };
}

// Runs `ia <args> --root <root>`; with json, appends --json and parses stdout.
// IA_NO_HANDOFF=1 keeps the chosen CLI the one that runs: from 3.6.0 the CLI
// otherwise hands its command to the repository's installed CLI (decision
// public-cli-3-6-0-handoff).
export function runIa(root, args, { json = true, cli, timeoutMs = 180_000 } = {}) {
  const resolved = cli ?? resolveCli(root);
  const [command, ...prefix] = resolved.argv;
  const argv = [...prefix, ...args, '--root', root, ...(json ? ['--json'] : [])];
  const ran = spawnSync(command, argv, { cwd: root, env: { ...process.env, IA_NO_HANDOFF: '1' }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (ran.error) throw new CliError(`ia ${args[0]} did not run: ${ran.error.message}`);
  const result = { code: ran.status, stdout: ran.stdout, stderr: ran.stderr, cli: resolved };
  if (json) {
    try { result.json = JSON.parse(ran.stdout); } catch { result.json = undefined; }
  }
  return result;
}
