// Scratch capture for kit scripts that read a whole workspace (task
// core-architecture-scripts): copy a workspace's .ia and its adopted source
// roots to a temp folder and run `ia capture` there, so nothing is written in
// the workspace. Ported from inventarch-architecture's
// scripts/workspace-toolchain.mjs, with one change: the CLI is the core's
// (lib/cli.mjs resolveCli: --cli, then IA_CLI_PATH, then the repository's own
// install, then the pinned package through npx; never the PATH), so a kit
// script and the resolver always run the same IA. A CLI below 3.x is refused.
// What that change drops from the plugin's resolver: IA_CLI_VERSION (npx runs
// exactly the core's PINNED) and a TypeScript (.ts) entry run through tsx (the
// core runs only a built entry). IA_CLI_NO_NPX still turns npx off, as
// IA_CORE_NO_NPX does.
// A kit script imports it by its path under the core plugin
// (config/kits/<folder>/scripts/ -> ../../../../scripts/lib/scratch.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CliError, PINNED, resolveCli } from './cli.mjs';

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
