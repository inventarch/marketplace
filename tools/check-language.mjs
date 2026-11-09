// IA language admission with the pinned CLI (decision public-local-gates). Every kit under plugins/ (a folder whose
// .ia holds a distributions.lock.json) and this repository's own .ia/src are copied to scratch folders, restored and
// validated by the @inventarch/cli that sources.lock.json pins: never the `ia` on PATH. The repository's records
// restore with the kits' language-only lock (tools/consistency.py keeps every kit lock on the pinned language).
// The CLI is --cli <dist/main.js>, else IA_CLI_PATH, else the root's node_modules (npm ci at the root installs it).
// Exit 0 when every root is admitted, 1 when any is refused, 2 when the CLI is missing or not the pinned version.
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LANGUAGE = 'inventarch/language';
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const root = resolve(option('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const posix = path => path.split('\\').join('/');

function refuse(message) {
  console.error('Language check could not run: ' + message);
  process.exit(2);
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { refuse(`cannot read ${file}: ${error.message}`); }
}

const pinned = readJson(join(root, 'sources.lock.json')).released?.cli;
if (!pinned) refuse('sources.lock.json records no released.cli');
const entry = resolve(option('--cli') || process.env.IA_CLI_PATH || join(root, 'node_modules', '@inventarch', 'cli', 'dist', 'main.js'));
if (!existsSync(entry)) refuse(`no @inventarch/cli at ${entry}; run npm ci at the repository root, or pass --cli <dist/main.js>`);
let pkg;
for (let dir = dirname(entry); !pkg; dir = dirname(dir)) {
  if (existsSync(join(dir, 'package.json'))) pkg = readJson(join(dir, 'package.json'));
  else if (dirname(dir) === dir) refuse(`no package.json above ${entry}`);
}
if (pkg.name !== '@inventarch/cli' || pkg.version !== pinned) refuse(`${entry} is ${pkg.name} ${pkg.version}; sources.lock.json pins ${pinned}`);

// Kits: plugins/**/.ia/distributions.lock.json outside tests and installed state.
function kits(dir, found = []) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (!item.isDirectory() || ['node_modules', 'tests', 'distributions'].includes(item.name)) continue;
    const path = join(dir, item.name);
    if (item.name === '.ia' && existsSync(join(path, 'distributions.lock.json'))) found.push(dirname(path));
    else kits(path, found);
  }
  return found;
}
const kitRoots = existsSync(join(root, 'plugins')) ? kits(join(root, 'plugins')).sort() : [];
if (!kitRoots.length) refuse('no kit under plugins/ holds a language lock to restore the repository\'s records with');
const template = readJson(join(kitRoots[0], '.ia', 'distributions.lock.json'));
const languageLock = {
  ...template,
  packages: (template.packages ?? []).filter(p => p.id === LANGUAGE),
  requests: (template.requests ?? []).filter(r => r.id === LANGUAGE),
};
if (languageLock.packages.length !== 1) refuse(`${join(kitRoots[0], '.ia', 'distributions.lock.json')} locks no single ${LANGUAGE}`);

function ia(workspace, home, verb) {
  return new Promise(done => {
    execFile(process.execPath, [entry, ...verb, '--root', workspace, '--json'],
      { cwd: workspace, encoding: 'utf8', env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' }, maxBuffer: 64 * 1024 * 1024, timeout: 180_000, windowsHide: true },
      (error, stdout, stderr) => {
        let json;
        try { json = JSON.parse(stdout); } catch { json = undefined; }
        done({ code: error ? error.code ?? 1 : 0, json, text: (stdout || stderr || String(error ?? '')).slice(0, 2000) });
      });
  });
}

// Each root gets its own scratch workspace and IA_HOME beside it (IA refuses a workspace inside its home).
async function admit(name, prepare) {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-language-')));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  try {
    mkdirSync(home, { recursive: true });
    prepare(workspace);
    const restored = await ia(workspace, home, ['restore', '--apply', '--yes']);
    if (restored.json?.applied?.status !== 'installed') {
      return { root: name, status: 'refused', errors: 1, warnings: 0, findings: [{ code: restored.json?.code ?? 'restore', message: restored.json?.message ?? restored.text }] };
    }
    const validated = await ia(workspace, home, ['validate']);
    const counts = validated.json?.counts ?? {};
    const findings = (validated.json?.findings ?? []).filter(f => f.severity === 'error');
    const admitted = validated.json?.status === 'admitted' && counts.errors === 0;
    return { root: name, status: admitted ? 'admitted' : 'refused', errors: counts.errors ?? (findings.length || (admitted ? 0 : 1)),
      warnings: counts.warnings ?? 0, findings: admitted ? [] : findings.length ? findings : [{ code: 'validate', message: validated.text }] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const copyIa = (from, to) => cpSync(from, to, { recursive: true, filter: source => !/[\\/]\.ia[\\/]distributions$/.test(source) });
const jobs = [
  () => admit('.ia/src', workspace => {
    cpSync(join(root, '.ia', 'src'), join(workspace, '.ia', 'src'), { recursive: true });
    writeFileSync(join(workspace, '.ia', 'distributions.lock.json'), JSON.stringify(languageLock));
  }),
  ...kitRoots.map(kit => () => admit(posix(relative(root, kit)), workspace => {
    copyIa(join(kit, '.ia'), join(workspace, '.ia'));
    for (const part of ['assets', 'releases.json', 'releases']) if (existsSync(join(kit, part))) cpSync(join(kit, part), join(workspace, part), { recursive: true });
  })),
];

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs.length, Math.max(1, Math.min(4, availableParallelism()))) }, async () => {
  while (next < jobs.length) {
    const at = next++;
    results[at] = await jobs[at]();
  }
}));

const refused = results.filter(r => r.status !== 'admitted');
for (const result of refused) {
  console.error(`${result.root}: refused`);
  for (const f of result.findings.slice(0, 5)) console.error(`  ${f.code} ${f.path ? posix(f.path) + ':' + (f.line ?? '') + ' ' : ''}${String(f.message ?? '').slice(0, 300)}`);
}
console.log(JSON.stringify({ status: refused.length ? 'refused' : 'admitted', cli: pinned,
  roots: results.map(({ root: name, status, errors, warnings }) => ({ root: name, status, errors, warnings })) }, null, 1));
process.exitCode = refused.length ? 1 : 0;
