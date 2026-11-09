// authored in inventarch/ia-authoring-kit 0.1.0: the kit's own scratch-capture helper; nothing in this kit resolves a path outside its folder.
// It copies a workspace's .ia and its adopted source roots to a temp folder and runs `ia capture` there, so nothing is
// written in the workspace. The CLI is resolved in this order: an explicit entry (--cli), IA_CLI_PATH (IA_METHOD_CLI is
// still honoured), the repository's own install of @inventarch/cli (walking up to the nearest .git), then exactly the
// pinned version through npx; never the `ia` on the PATH, never a shell. A CLI below 3.x is refused. IA_CLI_NO_NPX
// (or IA_CORE_NO_NPX) turns npx off. The pin below is the CLI this kit release was packed with.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// The CLI the kits' releases were packed with; adoption needs exactly this one.
export const PINNED = '3.6.0';

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
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.ia ?? 'dist/main.js';
    const main = join(dirname(pkgFile), bin);
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

export const MIN_MAJOR = 3;
const INSTALL_HINT = `install @inventarch/cli exactly in the workspace (npm install --save-dev --save-exact @inventarch/cli@${PINNED}) or pass --cli <entry> (or set IA_CLI_PATH); the \`ia\` on the PATH is never used`;
const SCRATCH_PREFIX = 'ia-core-scratch-';

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'source path escapes workspace');
}

// An adopted source root named in .ia/workspace.json: a portable relative path
// of real folders (no link or junction anywhere on the way) inside the workspace.
function boundDirectory(root, value) {
  assert(typeof value === 'string' && value && !isAbsolute(value) && !/^[A-Za-z]:|\\|\0/.test(value), 'source binding must use a portable relative path');
  assert(value.split('/').every(p => p && p !== '.' && p !== '..'), 'source binding contains traversal');
  let component = root;
  for (const part of value.split('/')) {
    component = join(component, part);
    const entry = lstatSync(component, { throwIfNoEntry: false });
    assert(entry?.isDirectory() && !entry.isSymbolicLink(), 'missing source component or link/junction alias: ' + value);
  }
  const selected = resolve(root, value);
  inside(root, selected);
  assert(statSync(selected, { throwIfNoEntry: false })?.isDirectory(), 'missing bound source tree: ' + value);
  inside(realpathSync(root), realpathSync(selected));
  return selected;
}

// Copies root's .ia (without .ia/work) and each adopted source root into
// scratch, which must be a separate folder. Links are refused rather than
// followed. Returns { sourceRoots, pins }.
export function copyWorkspace(root, scratch) {
  root = realpathSync(resolve(root));
  scratch = realpathSync(resolve(scratch));
  const overlaps = (a, b) => { const rel = relative(a, b); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };
  assert(!overlaps(root, scratch) && !overlaps(scratch, root), 'scratch and source must be disjoint directories');
  const work = join(root, '.ia', 'work');
  let copiedFiles = 0, copiedBytes = 0;
  const copy = (source, target) => cpSync(source, target, { recursive: true, filter: file => {
    const rel = relative(root, resolve(file));
    if (file === work || resolve(file).startsWith(work + sep)) return false;
    if (rel.split(sep).some(p => p === '.git' || p === 'node_modules')) return false;
    const entry = lstatSync(file);
    assert(!entry.isSymbolicLink(), 'source links or junctions require explicit native qualification');
    if (!entry.isDirectory()) {
      assert(entry.isFile() && entry.size <= 16 * 1024 * 1024, 'scratch input exceeds regular file bound');
      copiedFiles++; copiedBytes += entry.size;
      assert(copiedFiles <= 10000 && copiedBytes <= 128 * 1024 * 1024, 'scratch input exceeds aggregate bound');
    }
    inside(realpathSync(root), realpathSync(file));
    return true;
  } });
  assert(statSync(join(root, '.ia'), { throwIfNoEntry: false })?.isDirectory(), 'workspace has no .ia directory');
  copy(join(root, '.ia'), join(scratch, '.ia'));
  const bindingFile = join(root, '.ia', 'workspace.json');
  const binding = existsSync(bindingFile) ? JSON.parse(readFileSync(bindingFile, 'utf8')) : undefined;
  if (binding) assert.equal(binding.version, 1, 'unsupported workspace source-binding version');
  const adopted = binding?.adopted ?? [];
  assert(Array.isArray(adopted), 'adopted source bindings must be a list');
  const roots = new Set();
  for (const entry of adopted) {
    assert(entry && typeof entry.id === 'string' && /^[a-f0-9]{64}$/.test(entry.revision), 'source binding needs id and exact revision');
    const source = boundDirectory(root, entry.path);
    roots.add(entry.path);
    if (!source.startsWith(join(root, '.ia') + sep)) copy(source, resolve(scratch, entry.path));
  }
  // Source discovery is .ia plus explicit bindings: composition.sources is
  // parsed by the framework membership consumer, and quoted prose is never a
  // filesystem selector.
  return { sourceRoots: [...roots].sort(), pins: 'retained unchanged; target CLI verifies revisions' };
}

// The CLI for a workspace, as the core resolves it (lib/cli.mjs), refusing a
// known version below MIN_MAJOR. `explicit` is an entry path (--cli) or an
// already resolved descriptor, returned as it is. Resolve from the real
// workspace before copying it: a scratch copy leaves node_modules out.
// Prints "ia <version> from <source>" to stderr unless quiet.
// The messages keep the plugin's wording: the source names how the CLI was
// found (explicit entry <path>, IA_CLI_PATH, workspace install <package>,
// npx @inventarch/cli@${PINNED}).
export function resolveIa(root, explicit, { quiet = false } = {}) {
  if (explicit && typeof explicit === 'object' && Array.isArray(explicit.argv)) return explicit;
  const at = resolve(root ?? process.cwd());
  const env = process.env.IA_CLI_NO_NPX ? { ...process.env, IA_CORE_NO_NPX: process.env.IA_CLI_NO_NPX } : process.env;
  let ia;
  try { ia = resolveCli(at, { cliPath: explicit || undefined, env }); } catch (error) {
    // Only "nothing resolved" takes the plugin's wording; a broken install or
    // a missing explicit entry keeps the core's own reason.
    const nothing = /^no @inventarch\/cli is installed in this repository and the npx fallback is off|^npm's npx-cli\.js is not next to/.test(error.message);
    if (error.code !== 'IA-CORE-CLI-MISSING' || !nothing) throw error;
    const off = process.env.IA_CLI_NO_NPX ? 'npx disabled by IA_CLI_NO_NPX' : env.IA_CORE_NO_NPX ? 'npx disabled by IA_CORE_NO_NPX' : env.IA_METHOD_NO_NPX ? 'npx disabled by IA_METHOD_NO_NPX' : `no npx-cli.js beside ${process.execPath}`;
    throw new CliError(`no IA CLI resolved for ${at} (${off}): ${INSTALL_HINT}`, 'IA-CORE-CLI-MISSING');
  }
  const source = ia.source === '--cli' ? `explicit entry ${ia.argv.at(-1)}` : ia.source === 'npx' ? `npx @inventarch/cli@${PINNED}` : ['IA_CLI_PATH', 'IA_METHOD_CLI'].includes(ia.source) ? `${ia.source} ${ia.argv.at(-1)}` : `workspace install ${ia.source}`;
  const major = /^(\d+)\./.exec(ia.version ?? '')?.[1];
  assert(major === undefined || Number(major) >= MIN_MAJOR, `IA ${major}.x is not supported; ${source} is @inventarch/cli ${ia.version}. Use @inventarch/cli ${PINNED}: ${INSTALL_HINT}`);
  if (!quiet) process.stderr.write(`ia ${ia.version ?? 'unknown version'} from ${source}\n`);
  return ia;
}

// Runs the IA CLI without a shell and returns its stdout; a nonzero exit
// throws, with the output on the error (execFileSync's stdout and stderr).
// IA_NO_HANDOFF=1 keeps the resolved CLI the one that runs (from 3.6.0 the CLI
// otherwise hands its command to the repository's installed CLI).
export function invokeIa(cli, argv, options = {}) {
  const ia = resolveIa(process.cwd(), cli, { quiet: true });
  const [command, ...prefix] = ia.argv;
  return execFileSync(command, [...prefix, ...argv], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], ...options, env: { ...(options.env ?? process.env), IA_NO_HANDOFF: '1' } });
}

// Accepts the ia-snapshot-1 that `ia capture` writes, and the older
// ia.compiled.v1 shape that synthetic corpora and hand-supplied --artifact
// files still use.
export function readArtifact(file) {
  const artifact = JSON.parse(readFileSync(file, 'utf8'));
  const format = artifact.artifact === 'ia.compiled.v1' && artifact.formatVersion === 1 ? artifact.artifact
    : artifact.format === 'ia-snapshot-1' ? artifact.format : undefined;
  assert(format, 'unsupported IA artifact format');
  assert(Array.isArray(artifact.records), 'IA artifact has no records');
  return { ...artifact, format };
}

// Captures a scratch copy: `ia capture` writes .ia/work/snapshot/current.json
// inside the copy, and exits 1 on admission errors while still writing it.
// cli is a descriptor resolved from the real workspace (or an entry path).
export function compileScratch(scratch, cli) {
  const ia = resolveIa(scratch, cli), artifactPath = join(scratch, '.ia', 'work', 'snapshot', 'current.json');
  let stdout = '', failure;
  try { stdout = invokeIa(ia, ['capture', '--root', scratch, '--json']); } catch (error) {
    failure = error;
    stdout = String(error.stdout ?? '') + '\n' + String(error.stderr ?? error.message);
  }
  assert(existsSync(artifactPath), 'IA capture produced no snapshot: ' + stdout.slice(0, 400));
  const artifact = readArtifact(artifactPath);
  if (failure || artifact.counts?.errors) process.stderr.write('warning: admission errors present; this is not a clean closure\n');
  return { artifact, artifactPath, profile: 'capture', output: stdout, admissionErrors: artifact.counts?.errors ?? (failure ? 1 : 0) };
}

// Copies the workspace at root to a fresh temp folder, captures it there, and
// removes the copy: { artifact, profile, output, admissionErrors, closure }.
export function scratchArtifact(root, cli) {
  const ia = resolveIa(root, cli);
  const tempParent = realpathSync(tmpdir());
  const scratch = mkdtempSync(join(tempParent, SCRATCH_PREFIX));
  try {
    const closure = copyWorkspace(root, scratch), result = compileScratch(scratch, ia);
    return { ...result, closure, artifactPath: undefined };
  } finally {
    inside(tempParent, scratch);
    assert(basename(scratch).startsWith(SCRATCH_PREFIX), 'unexpected scratch cleanup target');
    rmSync(scratch, { recursive: true, force: true });
  }
}
