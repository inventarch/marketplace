// Method kits ship as text sources under config/kits/<folder>/, never as
// archives: the catalogue admits only reviewable text. Each kit folder holds
// .ia/release.json (its id and version), .ia/src (the records),
// .ia/distributions.lock.json (the language base it pins), releases.json (the
// recorded releases with their archive and sources digests) and optionally
// checks.json (the fixed argv of each @check the checker runner may run),
// delivery.json (the capabilities the resolver delivers whole), bindings.json
// (the bindings it recommends and the capabilities it resolves outside a
// workspace), onwrite.json (the checks the core's PostToolUse hook runs) and
// handlers.json (the session, prompt, tool and stop handlers the core's hooks
// run, lib/handlers.mjs). A kit may depend on other kits: .ia/release.json
// dependencies other than inventarch/language name a kit id and range, and
// adopt and readRoot vendor that kit's recorded release beside it (C3,
// kitDependencies).
// Files that .ia/release.json declares under "assets" (documentation, scripts)
// sit beside .ia/: they are packed with the kit, and the recorded `sources`
// digest covers .ia/, the declared assets and those four sidecars.
// Three uses:
// - listKits / findKit: what the plugin carries.
// - readRoot: a restored copy of one kit's workspace in a per-user temp
//   folder, so an agent can read it with `ia position --root` in any
//   repository, adopted or not. Nothing is written into the install folder.
// - adopt: packs the sources with the pinned CLI, accepts the archive only
//   when it hashes to the recorded release, vendors it with the language base
//   the kit's lock pins, and installs it into an IA workspace.
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES } from './binding.mjs';
import { PINNED, resolveCli, runIa } from './cli.mjs';
import { kitRecordNames } from './records.mjs';
import { checkFile, checkIndex, checkRows, compareVersions, expandDocument, FORMAT as RELEASES_FORMAT } from './releases.mjs';
import { iaHome } from './home.mjs';

export const DEFAULT_KITS_DIR = fileURLToPath(new URL('../../config/kits/', import.meta.url));
// IA_CORE_KITS_DIR points the plugin at another kit folder (the tests build
// kits at runtime); shipped use never sets it.
export const kitsDir = (env = process.env) => (env.IA_CORE_KITS_DIR ? resolve(env.IA_CORE_KITS_DIR) : DEFAULT_KITS_DIR);

export class KitError extends Error {
  constructor(message, code = 'IA-CORE-KIT', extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const TEXT = /\.(?:ia|json|md|mjs|txt)$/i;
const NUL = String.fromCharCode(0);

function walk(dir) {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new KitError(`method content must be regular files and directories: ${path}`, 'IA-CORE-CLOSURE-INTEGRITY');
    return entry.isDirectory() ? walk(path) : [path];
  });
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// A Windows checkout may hand the sources over with CRLF line endings; the
// release was packed from LF bytes, so copies are normalized first.
function normalize(dir) {
  for (const path of walk(dir)) {
    if (!TEXT.test(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (text.includes('\r\n')) writeFileSync(path, text.replace(/\r\n/g, '\n'));
  }
}

// The files a kit declares beside .ia/: each .ia/release.json assets[].path,
// sorted by path. A path that is absolute, escapes the kit or names no file is
// a KitError. Returns [{ rel, abs }] with forward-slash relative paths.
export function declaredAssets(kitDir) {
  const descriptorPath = join(kitDir, '.ia', 'release.json');
  if (!existsSync(descriptorPath)) return [];
  const assets = JSON.parse(readFileSync(descriptorPath, 'utf8')).assets ?? [];
  const root = resolve(kitDir);
  return assets.map(a => a?.path).sort().map(path => {
    if (typeof path !== 'string' || path === '') throw new KitError(`${descriptorPath}: an asset needs a path`);
    const abs = resolve(root, path);
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new KitError(`declared asset ${path} is absolute or leaves the kit`);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new KitError(`declared asset ${path} is missing from ${kitDir}`);
    return { rel, abs };
  });
}

// One digest over a kit's sources (paths and LF-normalized bytes): .ia/, then
// the declared assets sorted by path, then each sidecar (SIDECARS) that exists.
// It keys the restored read copy, and each release records it, so a plain test
// can tell when the sources no longer are the recorded release.
export const SIDECARS = ['checks.json', 'delivery.json', 'bindings.json', 'onwrite.json', 'handlers.json'];
export function sourcesDigest(kitDir) {
  const hash = createHash('sha256');
  const ia = join(kitDir, '.ia');
  const feed = (rel, path) => {
    hash.update(rel + NUL);
    const bytes = readFileSync(path);
    hash.update(TEXT.test(path) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes);
    hash.update(NUL);
  };
  for (const path of walk(ia).filter(p => !relative(ia, p).startsWith('distributions') && !relative(ia, p).startsWith('work'))) {
    feed(relative(kitDir, path).replace(/\\/g, '/'), path);
  }
  for (const { rel, abs } of declaredAssets(kitDir)) feed(rel, abs);
  for (const name of SIDECARS) if (existsSync(join(kitDir, name))) feed(name, join(kitDir, name));
  return hash.digest('hex');
}

// Conservative execution fingerprint: all carried kit files and core runner/helper
// bytes, including files a sidecar invokes but a release forgot to declare.
// This is a fail-closed drift guard, not a qualified transitive closure.
export function implementationDigest(kit, plugin = kit.pluginDir ?? fileURLToPath(new URL('../..', import.meta.url))) {
  const hash = createHash('sha256');
  for (const [label, root] of [['kit', kit.dir], ['scripts', join(plugin, 'scripts')]]) {
    for (const file of walk(root)) {
      const path = relative(root, file).replace(/\\/g, '/');
      if (path.startsWith('.ia/distributions/') || path.startsWith('.ia/work/')) continue;
      // Release history is not execution: appending a release must not break every pin.
      if (label === 'kit' && (path === 'releases.json' || path.startsWith('releases/'))) continue;
      hash.update(label + '/' + path + NUL).update(readFileSync(file)).update(NUL);
    }
  }
  return hash.digest('hex');
}

// The kit's release index: format 1 (every row embeds its records) or format
// 2 (each row names releases/<version>.json in place of its records). Either
// way the rows carry version, archive, manifest, sources, language and cli,
// and every version is strict semver (releases.mjs checkRows): a version names
// a per-version file and an install folder, so it never holds a path.
export function readReleases(kitDir) {
  const path = join(kitDir, 'releases.json');
  if (!existsSync(path)) throw new KitError(`${kitDir} carries no releases.json`);
  const releases = JSON.parse(readFileSync(path, 'utf8'));
  if (!releases.kit || !Array.isArray(releases.releases)) throw new KitError(`${path} is malformed`);
  if (releases.format !== undefined && releases.format !== RELEASES_FORMAT) throw new KitError(`${path} has format ${releases.format}; this core reads formats 1 and ${RELEASES_FORMAT}`);
  try {
    if (releases.format === RELEASES_FORMAT) checkIndex(releases); else checkRows(releases.releases);
  } catch (error) { throw new KitError(`${path}: ${error.message}`); }
  return releases;
}

// One release's record names: its embedded records (format 1) or its
// per-version file (format 2), checked against the row.
export function releaseRecords(kitDir, release) {
  if (Array.isArray(release?.records)) return release.records;
  const index = readReleases(kitDir);
  const row = index.releases.find(r => r.version === release?.version && r.archive === release?.archive);
  if (!row || typeof row.file !== 'string') throw new KitError(`${kitDir} records no release ${release?.version} with archive ${release?.archive}`);
  const path = join(kitDir, row.file);
  if (!existsSync(path)) throw new KitError(`${kitDir} lacks ${row.file}`);
  try { return checkFile(index, row, JSON.parse(readFileSync(path, 'utf8'))).records; } catch (error) { throw new KitError(error.message); }
}

// The whole history as format 1 (format 1 passes through unchanged).
export function expandReleases(kitDir) {
  try { return expandDocument(readReleases(kitDir), rel => JSON.parse(readFileSync(join(kitDir, rel), 'utf8'))); } catch (error) {
    throw error instanceof KitError ? error : new KitError(error.message);
  }
}

export function readDescriptor(kitDir) {
  const path = join(kitDir, '.ia', 'release.json');
  if (!existsSync(path)) throw new KitError(`${kitDir} carries no .ia/release.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// One flat folder of kits: one per subfolder that holds a releases.json.
// Each entry: folder, dir, id, version (the descriptor's), latest (the
// index's latest release, or the last recorded one, or null), releases, origin.
function folderKits(dir, origin = 'plugin') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().filter(name => existsSync(join(dir, name, 'releases.json'))).map(folder => kitAt(join(dir, folder), folder, origin));
}

function kitAt(kitDir, folder, origin) {
  const releases = readReleases(kitDir);
  const descriptor = existsSync(join(kitDir, '.ia', 'release.json')) ? readDescriptor(kitDir) : {};
  const latest = (releases.latest ? releases.releases.find(r => r.version === releases.latest) : releases.releases.at(-1)) ?? null;
  return { folder, dir: kitDir, id: releases.kit, version: descriptor.version, latest, releases: releases.releases, origin };
}

// The IA home's kit folder, <IA home>/kits, where kit.mjs add installs a kit
// as <IA home>/kits/<folder>/<version>/ (decision public-kit-lookup). It is
// looked in by default; when a test points the plugin at another kit folder
// (IA_CORE_KITS_DIR), only when IA_HOME is set too, so a test never reads the
// person's own home. IA_CORE_NO_HOME_KITS=1 turns it off.
export function homeKitsDir(env = process.env) {
  if (env.IA_CORE_NO_HOME_KITS === '1' || (env.IA_CORE_KITS_DIR && !env.IA_HOME)) return null;
  try { return join(iaHome(env), 'kits'); } catch { return null; }
}

// The kits installed in the IA home: for each <folder>, every <version>
// subfolder that holds a kit whose descriptor names that version, newest first.
export function homeKits(dir = homeKitsDir()) {
  if (!dir || !existsSync(dir)) return [];
  const found = [];
  for (const folder of readdirSync(dir).sort()) {
    const base = join(dir, folder);
    if (!statSync(base).isDirectory()) continue;
    const versions = readdirSync(base).filter(v => existsSync(join(base, v, 'releases.json'))).sort((x, y) => compareVersions(y, x));
    for (const version of versions) {
      const kit = kitAt(join(base, version), folder, 'home');
      if (kit.version !== version) continue; // a folder whose descriptor disagrees with its name is ignored
      found.push(kit);
    }
  }
  return found;
}

// The kits the core can resolve. With an explicit folder: that folder only.
// Otherwise the plugin's own config/kits first, then the IA home's newest
// installed version of each kit the plugin does not carry (by id).
export function listKits(dir) {
  if (dir !== undefined) return folderKits(dir);
  const carried = folderKits(kitsDir());
  const ids = new Set(carried.map(k => k.id));
  const fromHome = [];
  for (const kit of homeKits()) if (!ids.has(kit.id)) { ids.add(kit.id); fromHome.push(kit); }
  return [...carried, ...fromHome];
}

// A kit by id (inventarch/<name>-kit) or by folder.
export function findKit(ref, dir) {
  const kits = listKits(dir);
  const kit = kits.find(k => k.id === ref) ?? kits.find(k => k.folder === ref);
  if (!kit) throw new KitError(`no kit ${ref} is carried by this plugin or installed in the IA home; known: ${kits.map(k => k.id).join(', ') || 'none'}`, 'IA-CORE-KIT-UNKNOWN');
  return kit;
}

// The canonical id of a kit reference: the id of the carried kit findKit resolves it to (an id or a folder alias),
// or the reference itself when no carried kit answers it.
export function canonicalKitId(ref) {
  try { return findKit(ref).id; } catch { return ref; }
}

// Does a version satisfy a dependency range? Exact versions, ^, ~, >= and *.
// A caret on 0.x keeps the minor (^0.1.0 is >=0.1.0 <0.2.0).
export function satisfies(version, range) {
  const parse = v => (/^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim()) ?? []).slice(1).map(Number);
  const v = parse(version);
  if (v.length !== 3) return false;
  const text = String(range ?? '').trim();
  if (text === '*' || text === '') return true;
  const op = /^(\^|~|>=|=)?\s*(.*)$/.exec(text);
  const r = parse(op[2]);
  if (r.length !== 3) return false;
  const atLeast = compareVersions(version, r.join('.')) >= 0;
  switch (op[1]) {
    case '^': return atLeast && (r[0] > 0 ? v[0] === r[0] : r[1] > 0 ? v[0] === 0 && v[1] === r[1] : v[0] === 0 && v[1] === 0 && v[2] === r[2]);
    case '~': return atLeast && v[0] === r[0] && v[1] === r[1];
    case '>=': return atLeast;
    default: return compareVersions(version, r.join('.')) === 0;
  }
}

// A kit's direct kit dependencies from its .ia/release.json: every entry
// other than the language base, as [{ id, range }].
export function declaredDependencies(kitDir) {
  let descriptor;
  try { descriptor = readDescriptor(kitDir); } catch { return []; }
  return (descriptor.dependencies ?? []).filter(d => d?.id && d.id !== 'inventarch/language').map(d => ({ id: d.id, range: d.range ?? '*' }));
}

// Kits in one folder, tolerating folders that are not kits.
function quietFolderKits(dir, origin) {
  if (!dir || !existsSync(dir)) return [];
  const found = [];
  for (const folder of readdirSync(dir).sort()) {
    if (!existsSync(join(dir, folder, 'releases.json'))) continue;
    try { found.push(kitAt(join(dir, folder), folder, origin)); } catch { /* not a readable kit */ }
  }
  return found;
}

// Where a dependency is looked for (contract C3), in order: the kits this
// plugin carries, the kits installed in the IA home (every version, newest
// first), then the dependency's own folder next to the depending kit (a source
// tree such as app kits/). The first whose latest release satisfies the range wins.
// A kit installed in the home finds its dependencies among the home's kits:
// kit.mjs add installs a dependency it found next to the kit alongside it.
export function findDependency(dep, kit) {
  let home = [];
  try { home = homeKits(); } catch { /* an unreadable home holds nothing */ }
  // An archive's extracted folder has no neighbours to look in, and next to a
  // home kit sit only its own other versions.
  const beside = kit.origin === 'archive' || kit.origin === 'home' ? [] : quietFolderKits(dirname(kit.dir), 'source');
  const candidates = [...quietFolderKits(kitsDir(), 'plugin'), ...home, ...beside];
  const named = candidates.filter(k => k.id === dep.id);
  const match = named.find(k => k.latest && satisfies(k.latest.version, dep.range));
  if (!match) {
    const seen = [...new Set(named.map(k => `${k.latest?.version ?? 'unreleased'} (${k.origin})`))];
    throw new KitError(`kit ${kit.id} depends on ${dep.id} ${dep.range}, which ${seen.length ? `is found only as ${seen.join(', ')}` : 'is not carried by this plugin, installed in the IA home or next to the kit'}. Add it first: kit.mjs add --from <its folder or archive>`, 'IA-CORE-KIT-DEPENDENCY');
  }
  return match;
}

// Every kit a kit depends on, transitively, dependencies first, each once.
// A cycle, or two ranges no one release satisfies, is a KitError.
export function kitDependencies(kit, trail = [kit.id]) {
  const order = [];
  for (const dep of declaredDependencies(kit.dir)) {
    if (trail.includes(dep.id)) throw new KitError(`kit dependency cycle: ${[...trail, dep.id].join(' -> ')}`, 'IA-CORE-KIT-DEPENDENCY');
    const found = findDependency(dep, kit);
    for (const inner of [...kitDependencies(found, [...trail, dep.id]), found]) {
      const prior = order.find(k => k.id === inner.id);
      if (!prior) order.push(inner);
      else if (prior.latest?.archive !== inner.latest?.archive) throw new KitError(`kit ${kit.id} needs two releases of ${inner.id}: ${prior.latest?.version} and ${inner.latest?.version}`, 'IA-CORE-KIT-DEPENDENCY');
    }
  }
  return order;
}

// Packs every dependency of a kit (dependencies first), each with the ones
// before it vendored, and refuses one whose sources do not pack to its
// recorded release. Returns [{ kit, built }]; the caller cleans up.
export function packDependencies(kit, cli) {
  const builds = [];
  try {
    for (const dep of kitDependencies(kit)) builds.push({ kit: dep, built: packRelease(dep, dep.latest, cli, { vendor: vendorArchives(builds) }) });
    return builds;
  } catch (error) {
    for (const { built } of builds) built.cleanup();
    throw error;
  }
}

// The checks a kit's checker runner may run: config/kits/<folder>/checks.json,
// { format: 1, checks: { <name>: { argv: [...], cwd?: "workspace"|"kit"|"plugin", record?: <identity>, timeout?: <seconds, a positive integer, default 600> } } }.
// A name must also be a @check record in the kit's sources; one that is not
// is dropped and reported in `undeclared`.
export function kitChecks(kit) {
  const path = join(kit.dir, 'checks.json');
  if (!existsSync(path)) return { checks: {}, undeclared: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.format !== 1 || typeof parsed.checks !== 'object' || parsed.checks === null || Array.isArray(parsed.checks)) throw new KitError(`${path} is malformed (format 1 with a checks object)`);
  const declared = new Set(kitRecordNames(kit.dir).filter(r => r.word === 'check').map(r => r.name));
  const checks = {}, undeclared = [];
  for (const [name, spec] of Object.entries(parsed.checks)) {
    if (!declared.has(name)) { undeclared.push(name); continue; }
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv.every(a => typeof a === 'string')) throw new KitError(`${path}: check ${name} needs a non-empty argv of strings`);
    if (spec.timeout !== undefined && !(Number.isInteger(spec.timeout) && spec.timeout > 0)) throw new KitError(`${path}: check ${name} needs a timeout that is a positive integer of seconds`);
    checks[name] = { argv: spec.argv, cwd: spec.cwd ?? 'workspace', record: spec.record ?? `compliance-system/check/gate/${name}`, timeout: spec.timeout ?? 600, arguments: spec.arguments };
  }
  return { checks, undeclared };
}

// How a kit wants its capabilities delivered: config/kits/<folder>/delivery.json,
// { format: 1, whole: [<capability name>, ...] }. A capability listed in
// `whole` is a procedure: the resolver delivers every cell of its playbooks
// whatever `ia position` returns at the seat.
// A name that is not a @capability record of the kit is dropped and reported
// in `undeclared`. Without the file no capability is declared whole.
export function kitDelivery(kit) {
  const path = join(kit.dir, 'delivery.json');
  if (!existsSync(path)) return { whole: [], undeclared: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.format !== 1 || !Array.isArray(parsed.whole) || !parsed.whole.every(n => typeof n === 'string' && n !== '')) throw new KitError(`${path} is malformed (format 1 with a whole list of capability names)`);
  const declared = new Set(kitRecordNames(kit.dir).filter(r => r.word === 'capability').map(r => r.name));
  const whole = [], undeclared = [];
  for (const name of parsed.whole) (declared.has(name) ? whole : undeclared).push(name);
  return { whole, undeclared };
}

// What a kit recommends a repository bind, and what it resolves outside a
// workspace: config/kits/<folder>/bindings.json,
// { format: 1, recommend: { "<entry>.<activity>": { capability, profile? } }, unbound?: [<capability name>, ...] }.
// The core applies nothing by itself: bind.mjs recommend shows the keys and
// writes them only on --apply. A
// key or an unbound name whose capability (or profile) is not a record of the
// kit is dropped and reported in `undeclared`. `unbound` is null when the kit
// declares no list, so every capability may be resolved outside a workspace,
// as before the file existed.
export function kitBindings(kit) {
  const path = join(kit.dir, 'bindings.json');
  if (!existsSync(path)) return { recommend: {}, unbound: null, undeclared: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const keyPattern = new RegExp(`^(?:${ENTRIES.join('|')})\\.(?:[a-z][a-z0-9-]*|\\*)$`);
  const plainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (parsed.format !== 1 || !plainObject(parsed.recommend) || (parsed.unbound !== undefined && !(Array.isArray(parsed.unbound) && parsed.unbound.every(n => typeof n === 'string' && n !== '')))) throw new KitError(`${path} is malformed (format 1 with a recommend object and an optional unbound list of capability names)`);
  const names = kitRecordNames(kit.dir);
  const capabilities = new Set(names.filter(r => r.word === 'capability').map(r => r.name));
  const profiles = new Set(names.filter(r => r.word === 'agent-profile').map(r => r.name));
  const recommend = {}, undeclared = [];
  for (const [key, value] of Object.entries(parsed.recommend)) {
    if (!keyPattern.test(key) || !plainObject(value) || typeof value.capability !== 'string' || (value.profile !== undefined && typeof value.profile !== 'string')) throw new KitError(`${path}: ${key} needs an <entry>.<activity> key (entry ${ENTRIES.join(', ')}) and { capability, profile? }`);
    if (!capabilities.has(value.capability) || (value.profile && !profiles.has(value.profile))) { undeclared.push(key); continue; }
    recommend[key] = { kit: kit.id, capability: value.capability, ...(value.profile ? { profile: value.profile } : {}) };
  }
  let unbound = null;
  if (parsed.unbound) {
    unbound = [];
    for (const name of parsed.unbound) (capabilities.has(name) ? unbound : undeclared).push(name);
  }
  return { recommend, unbound, undeclared };
}

// The checks the core's PostToolUse hook (scripts/on-write.mjs) runs after a
// write: config/kits/<folder>/onwrite.json,
// { format: 1, onWrite: [ { name, extensions: [".md", ...], marker?, maxDepth?, argv: [...], timeout? } ] }.
// A written file matches an entry when its name ends in one of the extensions
// (compared case-insensitively) and, with a marker, a file of that name sits
// in its folder or one of the maxDepth (default 12) folders above it. argv
// takes ${NODE}, ${KIT} and ${PLUGIN} as check.mjs does; the hook payload goes
// to its stdin and it answers as a hook would. timeout is in seconds (default
// 20, at most 25, within the hook's own 30).
export function kitOnWrite(kit) {
  const path = join(kit.dir, 'onwrite.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.format !== 1 || !Array.isArray(parsed.onWrite)) throw new KitError(`${path} is malformed (format 1 with an onWrite list)`);
  return parsed.onWrite.map((entry, i) => {
    const where = `${path}: onWrite[${i}]`;
    if (typeof entry?.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) throw new KitError(`${where} needs a name (lowercase letters, digits and hyphens)`);
    if (!Array.isArray(entry.extensions) || !entry.extensions.length || !entry.extensions.every(e => typeof e === 'string' && /^\.[A-Za-z0-9]+$/.test(e))) throw new KitError(`${where} needs extensions such as [".md"]`);
    if (entry.marker !== undefined && (typeof entry.marker !== 'string' || !/^[^/\\]+$/.test(entry.marker))) throw new KitError(`${where}: marker is a file name, not a path`);
    if (entry.maxDepth !== undefined && !(Number.isInteger(entry.maxDepth) && entry.maxDepth >= 0 && entry.maxDepth <= 64)) throw new KitError(`${where}: maxDepth is an integer from 0 to 64`);
    if (!Array.isArray(entry.argv) || !entry.argv.length || !entry.argv.every(a => typeof a === 'string')) throw new KitError(`${where} needs a non-empty argv of strings`);
    const unknown = entry.argv.flatMap(a => [...a.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1])).filter(t => !['NODE', 'KIT', 'PLUGIN'].includes(t));
    if (unknown.length) throw new KitError(`${where}: argv takes only \${NODE}, \${KIT} and \${PLUGIN}, not ${unknown.map(t => `\${${t}}`).join(', ')}`);
    if (entry.timeout !== undefined && !(Number.isInteger(entry.timeout) && entry.timeout > 0 && entry.timeout <= 25)) throw new KitError(`${where}: timeout is a whole number of seconds from 1 to 25`);
    return { name: entry.name, extensions: entry.extensions.map(e => e.toLowerCase()), marker: entry.marker ?? null, maxDepth: entry.maxDepth ?? 12, argv: entry.argv, timeout: entry.timeout ?? 20 };
  });
}

// A CLI restores offline only the language bases it carries; for any other base
// it asks a registry, which refuses with IA-DIST-ARTIFACT-UNAVAILABLE or, where
// the default registry answers with its listing, IA-DIST-CONFLICT "Registry no
// longer lists the locked release: inventarch/language@<version>". From 3.7.0 a
// CLI carries every published 3.x base (3.8.0: 3.0.0 to 3.3.0), so it restores
// any 3.x kit. An older CLI carries one base only: 3.3.0 to 3.6.0 carry
// inventarch/language 3.2.0, and 3.2.2 carries 3.1.2, so each restores only a
// kit locked on its own base; adopt still needs the packing CLI to reproduce
// the archive. When the repository's CLI is a known version other than the one
// the release was packed with, that refusal names the CLI to pin; with that
// CLI, or an unknown one, the artifact is really missing and the refusal is
// reported as it is.
const baseUnavailable = json => json?.code === 'IA-DIST-ARTIFACT-UNAVAILABLE'
  || (json?.code === 'IA-DIST-CONFLICT' && /no longer lists the locked release: inventarch\/language@/.test(json.message ?? ''));
function restore(work, cli, kit, catalog) {
  const restored = runIa(work, ['restore', '--apply', '--yes', ...(catalog ? ['--catalog', catalog] : [])], { cli });
  if (restored.code === 0) return;
  const packed = /^@inventarch\/cli (\S+)$/.exec(kit.latest?.cli ?? '')?.[1];
  if (baseUnavailable(restored.json) && packed && cli.version && cli.version !== packed) {
    const language = readLock(work)?.packages?.find(p => p.id === 'inventarch/language');
    throw new KitError(`kit ${kit.id} ${kit.latest?.version ?? kit.version} locks inventarch/language ${language?.version ?? 'an unknown version'}, which this repository's CLI does not carry: it resolves ${cli.version ?? 'an unknown version'} (${cli.source}), and a CLI restores offline only the language bases it carries. Pin @inventarch/cli ${packed}, or set IA_CLI_PATH to it`, 'IA-CORE-CLI-UNSUPPORTED');
  }
  throw new KitError(`ia restore of the kit workspace failed: ${restored.stderr.trim() || restored.stdout.trim()}`);
}

// The folder that holds this user's restored copies: private to the user, and
// refused when someone else owns it (a shared POSIX /tmp).
export function userCache(base) {
  // Only the OS-selected default is producer-owned; supplied aliases stay refused.
  base = base === undefined ? realpathSync(tmpdir()) : resolve(base);
  for (let at = base; ; at = dirname(at)) {
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new KitError('Aliased or non-directory cache parent');
    if (at === dirname(at)) break;
  }
  const who = (typeof process.getuid === 'function' ? String(process.getuid()) : userInfo().username).replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = join(base, `inventarch-core-${who}`);
  const prior = lstatSync(dir, { throwIfNoEntry: false });
  if (prior && (!prior.isDirectory() || prior.isSymbolicLink())) throw new KitError('Aliased or non-directory cache');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (typeof process.getuid === 'function' && statSync(dir).uid !== process.getuid()) throw new KitError(`${dir} belongs to another user; set TMPDIR to a private folder`);
  return dir;
}

const complete = dir => existsSync(join(dir, '.ia', 'distributions', 'active.json'));

// A kit can be read only with a CLI of the major its latest release was packed
// with, or a later one: a 3.x release locks a 3.x language base, which an older
// CLI cannot restore (it would ask a registry for it). A CLI of unknown version
// is let through. Within the major, restore() refuses a CLI that does not
// carry the kit's language base.
function supported(kit, cli) {
  const packed = /^@inventarch\/cli ((\d+)\.\S*)$/.exec(kit.latest?.cli ?? '');
  const major = Number(/^(\d+)\./.exec(cli.version ?? '')?.[1]);
  if (packed && Number.isInteger(major) && major < Number(packed[2])) throw new KitError(`kit ${kit.id} ${kit.latest.version} was packed with @inventarch/cli ${packed[1]}, whose language base this repository's CLI cannot restore: it resolves ${cli.version} (${cli.source}). Pin @inventarch/cli ${PINNED}, or set IA_CLI_PATH to it`, 'IA-CORE-CLI-UNSUPPORTED');
}

// The folder to pass as --root to read one kit. Restoring is offline: the CLI
// carries the language base the kit's lock pins. Concurrent callers each
// restore into their own folder and the first rename wins; a complete copy is
// never removed.
function readSourceDigest(root, normalized = false) {
  const hash = createHash('sha256');
  const ia = join(root, '.ia');
  for (const file of walk(ia)) {
    const path = relative(ia, file).replace(/\\/g, '/');
    if (path.startsWith('distributions/') || path.startsWith('work/')) continue;
    const bytes = readFileSync(file);
    hash.update(path + NUL).update(normalized && TEXT.test(file) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes).update(NUL);
  }
  return hash.digest('hex');
}

export function readRoot(kit, { cli, base } = {}) {
  const resolved = cli ?? resolveCli(process.cwd());
  supported(kit, resolved);
  const cache = userCache(base);
  const target = join(cache, `kit-${basename(kit.folder)}-${createHash('sha256').update(sourcesDigest(kit.dir)).update(readSourceDigest(kit.dir, true)).digest('hex')}`);
  const verify = () => {
    if (readSourceDigest(target) !== readSourceDigest(kit.dir, true)) throw new KitError(`restored method sources were altered at ${target}`, 'IA-CORE-CLOSURE-INTEGRITY');
    for (const { rel, abs } of declaredAssets(kit.dir)) {
      const expected = readFileSync(abs);
      const bytes = TEXT.test(abs) ? Buffer.from(expected.toString('utf8').replace(/\r\n/g, '\n')) : expected;
      if (!existsSync(join(target, rel)) || !readFileSync(join(target, rel)).equals(bytes)) throw new KitError(`restored method asset was altered: ${rel}`, 'IA-CORE-CLOSURE-INTEGRITY');
    }
    return target;
  };
  if (complete(target)) return verify();
  // A kit that depends on other kits restores with their recorded releases
  // vendored beside it (C3): each is packed from its own sources, which must
  // reproduce that release, so this needs the CLI that packed them.
  const deps = kitDependencies(kit).length ? packDependencies(kit, resolved) : [];
  const work = mkdtempSync(join(cache, 'tmp-'));
  try {
    cpSync(join(kit.dir, '.ia'), join(work, '.ia'), { recursive: true });
    for (const { rel, abs } of declaredAssets(kit.dir)) {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      copyFileSync(abs, join(work, rel));
    }
    normalize(work);
    restore(work, resolved, kit, vendorInto(work, vendorArchives(deps)));
    if (existsSync(target) && !complete(target)) rmSync(target, { recursive: true, force: true });
    try { renameSync(work, target); } catch (error) {
      if (complete(target)) return verify();
      throw new KitError(`could not place the restored kit at ${target}: ${error.message}`);
    }
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
    for (const { built } of deps) built.cleanup();
  }
}

// Copies archives into <work>/vendor and lists them in vendor/catalog.json;
// returns that catalog's path relative to work, or undefined for none.
function vendorInto(work, archives) {
  if (!archives.length) return undefined;
  mkdirSync(join(work, 'vendor'), { recursive: true });
  const names = [];
  for (const path of archives) {
    const name = basename(path);
    if (names.includes(name)) continue;
    copyFileSync(path, join(work, 'vendor', name));
    names.push(name);
  }
  writeFileSync(join(work, 'vendor', 'catalog.json'), JSON.stringify(names.map(n => ({ path: `vendor/${n}`, withdrawn: false })), null, 2) + '\n');
  return 'vendor/catalog.json';
}

// The archives a dependency build vendors: each dependency's archive and the language base it restored.
const vendorArchives = builds => builds.flatMap(({ built }) => [built.archive, built.base.path]);

// Packs a temporary copy of a kit; returns the archive path, its digest, the
// manifest digest and version ia pack reported, the language base the restore
// cached, and a cleanup. vendor: archive paths the copy's restore may use (the
// recorded releases of the kits it depends on, and their language base).
export function buildKit(kit, cli, { vendor = [] } = {}) {
  const work = mkdtempSync(join(realpathSync(tmpdir()), 'inventarch-core-pack-'));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  try {
    cpSync(join(kit.dir, '.ia'), join(work, '.ia'), { recursive: true });
    for (const { rel, abs } of declaredAssets(kit.dir)) {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      copyFileSync(abs, join(work, rel));
    }
    normalize(work);
    restore(work, cli, kit, vendorInto(work, vendor));
    const packed = runIa(work, ['pack', '--descriptor', '.ia/release.json', '--force'], { cli });
    if (packed.json?.status !== 'packed') throw new KitError(`ia pack of the kit failed: ${JSON.stringify(packed.json ?? packed.stderr.trim())}`);
    const archive = join(work, '.ia', 'work', 'dist', `${packed.json.archive}.ia.tgz`);
    if (!existsSync(archive) || sha256File(archive) !== packed.json.archive) throw new KitError('ia pack reported an archive it did not write');
    const language = (JSON.parse(readFileSync(join(work, '.ia', 'distributions.lock.json'), 'utf8')).packages ?? []).find(p => p.id === 'inventarch/language');
    const basePath = language && join(work, '.ia', 'distributions', 'cache', `${language.archive}.ia.tgz`);
    if (!basePath || !existsSync(basePath) || sha256File(basePath) !== language.archive) throw new KitError('ia restore did not cache the language base the kit pins');
    return { archive, digest: packed.json.archive, manifest: packed.json.manifestDigest, version: packed.json.manifest?.version, base: { archive: language.archive, path: basePath }, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Builds one recorded release and refuses unless the archive is that release.
export function packRelease(kit, release, cli, { vendor = [] } = {}) {
  const packedWith = /^@inventarch\/cli (\S+)$/.exec(release.cli ?? '')?.[1];
  if (!packedWith) throw new KitError(`kit release ${release.version} does not name the CLI it was packed with`);
  if (cli.version !== packedWith) throw new KitError(`kit ${kit.id} ${release.version} was packed with @inventarch/cli ${packedWith}, and this repository resolves ${cli.version ?? 'an unknown version'}: the archive would not reproduce. Pin @inventarch/cli ${packedWith}, or set IA_CLI_PATH to it`);
  const built = buildKit(kit, cli, { vendor });
  if (built.digest !== release.archive) {
    built.cleanup();
    throw new KitError(`the ${kit.id} sources pack to ${built.digest}, but release ${release.version} is ${release.archive}: the sources in this plugin are not the released kit`);
  }
  return built;
}

function writeLf(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.replace(/\r\n/g, '\n'));
}

// The lock of the IA workspace at root, or undefined.
export function readLock(root) {
  const lockPath = join(root, '.ia', 'distributions.lock.json');
  if (!existsSync(lockPath)) return undefined;
  return JSON.parse(readFileSync(lockPath, 'utf8'));
}

// The kit rows of the lock: its `packages` rows, then the kit rows of every package
// carrier in `entries` (kind: 'package'), which the engine installs as ordinary
// releases. Each is { via: 'package' | 'entry', row }.
function lockedKitRows(root) {
  const lock = readLock(root);
  const rows = (lock?.packages ?? []).map(row => ({ via: 'package', row }));
  for (const entry of Array.isArray(lock?.entries) ? lock.entries : []) {
    if (entry?.kind !== 'package' || !Array.isArray(entry.kits)) continue;
    for (const row of entry.kits) if (row && typeof row.id === 'string') rows.push({ via: 'entry', row });
  }
  return rows;
}

// The installed kit, if any: the lock's row for the kit's id, from `packages` or from
// a package carrier's `entries`.
export function installedKit(root, kitId) {
  return lockedKitRows(root).find(({ row }) => row.id === kitId)?.row;
}

// Every installed package other than the language base: the kits a workspace carries.
export function installedKits(root) {
  return lockedKitRows(root).filter(({ row }) => row.id !== 'inventarch/language').map(({ row }) => ({ id: row.id, version: row.version, archive: row.archive }));
}

// The lock's row for the kit and where it came from, or null when no row names it.
export function kitInstallation(root, kitId) {
  const id = canonicalKitId(kitId);
  const found = lockedKitRows(root).find(({ row }) => row.id === id);
  return found ? { via: found.via, version: found.row.version, archive: found.row.archive ?? null } : null;
}

// Presence: a repository-bound method runs a kit only while the repository's own lock
// installs it. Any row naming the kit counts, at any version and archive: a task pin
// runs its own retained bytes, which may be older than the version the lock now
// installs. A kit no row names refuses before anything is retained or run, and
// nothing answers for it from another copy.
// A folder alias names the kit it resolves to, as findKit reads it; an unknown reference stays as given. An
// unreadable or corrupt lock propagates from here as its own error, never as not-installed.
export function requireKitInstalled(root, kit) {
  const id = canonicalKitId(kit.id);
  if (kitInstallation(root, id) === null) throw new KitError(`kit ${id} is bound by this repository but its lock does not install it; ${installRemedy(id, process.env, root)}, then resolve again`, 'IA-CORE-KIT-NOT-INSTALLED', { kit: id });
}

// The public-kits package the core installs the kits it carries from (decision
// public-cli-3-6-0-install-route): config/public-kits.json holds its name and
// version only; the kits it carries are the ones the plugin carries. IA_CORE_PUBLIC_KITS points at
// another file (the tests build one at runtime); it is read only when IA_CORE_KITS_DIR is set too, and
// shipped use sets neither. A missing or malformed file is null, never an error.
export const PUBLIC_KITS_FILE = fileURLToPath(new URL('../../config/public-kits.json', import.meta.url));
export function publicKitsPackage(env = process.env) {
  try {
    const data = JSON.parse(readFileSync(env.IA_CORE_PUBLIC_KITS && env.IA_CORE_KITS_DIR ? resolve(env.IA_CORE_PUBLIC_KITS) : PUBLIC_KITS_FILE, 'utf8'));
    if (typeof data?.package !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(data.package)) return null;
    if (typeof data.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.version)) return null;
    return { name: data.package, version: data.version, spec: `${data.package}@${data.version}` };
  } catch { return null; }
}

// The kit ids the package carries: the kits in this plugin's own kit folder.
function packageKitIds(env = process.env) {
  try { return new Set(listKits(kitsDir(env)).map(k => k.id)); } catch { return new Set(); }
}

// Does the public-kits package carry the kit? Needs a readable manifest and the kit among the plugin's own.
export function packageCarries(kitId, env = process.env) {
  return publicKitsPackage(env) !== null && packageKitIds(env).has(canonicalKitId(kitId));
}

// The kits the package carries that the lock installs as direct `packages` rows. Such a row sits ahead of the package
// entry, so bind --install refuses while one exists. Never throws.
export function shadowingRows(root, env = process.env) {
  try {
    const carried = packageKitIds(env);
    return (readLock(root)?.packages ?? []).filter(p => p?.id !== LANGUAGE_ID && carried.has(p?.id)).map(p => p.id);
  } catch { return []; }
}

// How a kit gets installed: 'package' (bind --install through the public-kits package) or 'add' (kit.mjs add), for a kit
// the package does not carry, with no manifest, or while a direct row shadows the package entry. Never throws.
export function installRoute(kitId, root = null, env = process.env) {
  try {
    if (!packageCarries(kitId, env)) return 'add';
    return root && shadowingRows(root, env).length ? 'add' : 'package';
  } catch { return 'add'; }
}

// How to install a kit a repository needs, in words. Never throws.
export function installRemedy(kitId, env = process.env, root = null) {
  const pkg = publicKitsPackage(env);
  if (pkg && installRoute(kitId, root, env) === 'package') return `run kit.mjs bind ${kitId} --install --apply (or ia install --package ${pkg.spec} --apply --yes)`;
  return `run kit.mjs add ${kitId} --apply (or ia install ${kitId})`;
}

const LANGUAGE_ID = 'inventarch/language';
// Installs a kit into the IA workspace at root so a binding to it can run (kit.mjs bind --install).
// - The kit is installed already (any lock row names it): nothing runs, { already: true }.
// - The public-kits package carries it: with no lock, seed a language-only lock from a carried kit's own and
//   `ia restore`; then `ia install --package <package>@<version> --apply --yes`, which installs every kit the package
//   carries; the kit must then be installed through the package entry. A lock that already holds a `packages` row for a
//   kit the package carries is refused first (that row would shadow the entry); an existing lock is never seeded over.
// - Any other kit: adopt, the same as kit.mjs add.
// Without apply nothing runs or is written: the result lists the commands. A definite CLI refusal restores the lock and
// the active generation as they were (and removes a lock and generation this call seeded); a command that did not exit
// on its own, or an exit that changed nothing we can account for, refuses IA-CORE-INSTALL-UNCERTAIN and removes nothing.
export function installForBind(root, kit, { apply = false, cli, env = process.env, installTimeoutMs } = {}) {
  const id = canonicalKitId(kit.id);
  if (kitInstallation(root, id) !== null) return { kit: id, already: true, route: 'installed', added: [], commands: [], applied: false };
  const pkg = publicKitsPackage(env);
  if (!pkg || !packageKitIds(env).has(id)) {
    const release = kit.latest;
    if (!apply) return { kit: id, already: false, route: 'adopt', added: [], commands: [`ia install ${id}${release ? `@${release.version}` : ''} --catalog vendor/ia/catalog.json --apply --yes`], applied: false };
    const done = adopt(root, kit, { cli, installTimeoutMs });
    return { kit: id, already: Boolean(done.already), route: 'adopt', added: done.already ? [] : [{ kit: id, version: done.version }], commands: done.requests ?? [], applied: true };
  }
  const lock = readLock(root);
  if (lock) {
    const shadow = shadowingRows(root, env);
    if (shadow.length) throw new KitError(`the lock already installs ${shadow.join(', ')} as a direct package, which the entry for ${pkg.spec} would shadow; install ${id} the direct way instead, as the lock's other kits are, with kit.mjs add ${id} --apply, then bind ${id} --apply`, 'IA-CORE-INSTALL-CONFLICT', { kit: id });
  }
  const seed = lock ? null : seedLock(env);
  const commands = [...(seed ? ['ia restore --apply --yes'] : []), `ia install --package ${pkg.spec} --apply --yes`];
  if (!apply) return { kit: id, already: false, route: 'package', package: pkg.spec, seeded: Boolean(seed), added: [], commands, applied: false };
  const lockPath = join(root, '.ia', 'distributions.lock.json'), generations = join(root, '.ia', 'distributions'), activePath = join(generations, 'active.json');
  const read = path => (existsSync(path) ? readFileSync(path) : null);
  const lockBefore = read(lockPath), activeBefore = read(activePath), generationsBefore = existsSync(generations);
  const before = installedKits(root);
  const resolved = cli ?? resolveCli(root);
  const timeout = installTimeoutMs ? { timeoutMs: installTimeoutMs } : {};
  const rollback = () => {
    if (lockBefore === null) rmSync(lockPath, { force: true }); else writeFileSync(lockPath, lockBefore);
    if (activeBefore === null) rmSync(activePath, { force: true }); else writeFileSync(activePath, activeBefore);
    if (!generationsBefore) rmSync(generations, { recursive: true, force: true });
  };
  const uncertain = (command, why) => new KitError(`installation outcome is uncertain: ${command} ${why}. Nothing was removed. Wait for it to finish, then inspect the native installation (kit.mjs status ${id}) before running bind ${id} --install again.`, 'IA-CORE-INSTALL-UNCERTAIN', { kit: id });
  // The lock and the active generation as bytes: a step that exits nonzero is a definite refusal only if neither moved.
  const state = () => JSON.stringify([read(lockPath), read(activePath)].map(b => (b ? b.toString('base64') : null)));
  // One CLI step. A command that could not start ran nothing, so the files are restored; one that did not exit on its own,
  // or exited nonzero after the lock or the generation moved, may have committed: uncertain, and nothing is removed.
  const step = (label, args) => {
    const snapshot = state();
    let ran;
    try { ran = runIa(root, args, { cli: resolved, ...timeout }); } catch (error) {
      if (/\b(?:ENOENT|EACCES|EPERM)\b/.test(error.message)) {
        rollback();
        throw new KitError(`ia ${args[0]} could not start: ${error.message}. Nothing was changed.`, 'IA-CORE-INSTALL-REFUSED', { kit: id });
      }
      throw Object.assign(uncertain(`ia ${args[0]}`, `did not exit on its own (${error.message})`), { cause: error });
    }
    if (ran.code === 0) return ran;
    const code = ran.json?.code ?? ran.json?.findings?.[0]?.code ?? null;
    const detail = ran.json?.message ?? JSON.stringify(ran.json?.findings?.slice(0, 3) ?? ran.json ?? ran.stderr.trim());
    const unpublished = code === 'IA-CLI-KITS-PACKAGE-UNAVAILABLE' || /\b(?:E404|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|not found|unavailable)\b/i.test(`${detail} ${ran.stderr ?? ''}`);
    const hint = label === 'install' && unpublished ? ` If ${pkg.spec} is not published yet, retry after the release publishes it; npm must be on PATH and the registry reachable.` : code === 'IA-DIST-CONFLICT' ? ' The lock holds a package this install cannot reconcile; inspect it with ia inspect.' : '';
    if (ran.code === null || state() !== snapshot) throw uncertain(`ia ${args[0]}`, ran.code === null ? 'did not exit on its own' : `exited ${ran.code}${code ? ` (${code})` : ''} after the lock or the active generation changed`);
    rollback();
    throw new KitError(`ia ${args[0]} refused${code ? ` (${code})` : ''}: ${detail}.${hint}`, code ?? 'IA-CORE-INSTALL-REFUSED', { kit: id });
  };
  if (seed) {
    writeLf(lockPath, JSON.stringify(seed) + '\n');
    step('restore', ['restore', '--apply', '--yes']);
  }
  const ran = step('install', ['install', '--package', pkg.spec, '--apply', '--yes']);
  const status = ran.json?.applied?.status ?? ran.json?.status;
  const row = kitInstallation(root, id);
  if (row?.via !== 'entry') throw new KitError(`ia install --package ${pkg.spec} ${status === 'installed' ? 'reported installed' : 'exited 0'} but the lock does not install ${id} through the package entry (${row ? `it is installed from the ${row.via} rows` : 'no row names it'}); the package may not carry it. Inspect .ia/distributions.lock.json before running bind ${id} --install again.`, 'IA-CORE-INSTALL-UNCERTAIN', { kit: id });
  const known = new Set(before.map(k => k.id));
  return { kit: id, already: false, route: 'package', package: pkg.spec, seeded: Boolean(seed), added: installedKits(root).filter(k => !known.has(k.id)).map(k => ({ kit: k.id, version: k.version })), commands, applied: true };
}

// The language-only lock a workspace with none starts from: a carried kit's own, filtered to the language base, as
// tools/check-language.mjs builds it. Null when no carried kit pins the base (the CLI then judges the empty workspace).
function seedLock(env) {
  for (const kit of listKits(kitsDir(env))) {
    const lock = readLock(kit.dir);
    const packages = (lock?.packages ?? []).filter(p => p?.id === LANGUAGE_ID);
    if (packages.length === 1) return { ...lock, packages, requests: (lock.requests ?? []).filter(r => r?.id === LANGUAGE_ID) };
  }
  throw new KitError('no kit this plugin carries pins the language base, so there is no lock to start the install from; run ia init, then ia install --package yourself', 'IA-CORE-INSTALL-REFUSED');
}

// Identity: true only when the lock's row for the kit carries exactly this version
// and archive. Never throws: a lock that cannot be read or parsed matches nothing.
export function kitInstallMatches(root, kit) {
  try {
    const row = kitInstallation(root, kit.id);
    return row !== null && row.version === kit.version && row.archive === (kit.archive ?? null);
  } catch { return false; }
}

// Installs a kit's latest recorded release into the IA workspace at root.
// Writes vendor/ia/<kit>.ia.tgz, vendor/ia/<base>.ia.tgz, vendor/ia/catalog.json
// and, through ia install, .ia/distributions.lock.json. A kit that depends on
// other kits (C3) has each dependency's recorded release packed, checked and
// vendored beside it, so ia install --catalog resolves them; the result lists
// them under dependencies. A vendored archive
// whose bytes do not match its name is replaced. The result names the other
// core kits a language-base move upgrades with it (upgraded) and the exact
// install requests (requests), on a dry run too.
export function adopt(target, kit, { cli, dry = false, installTimeoutMs } = {}) {
  const root = resolve(target);
  if (!existsSync(join(root, '.ia', 'src'))) throw new KitError(`${root} is not an IA workspace (no .ia/src). Initialise it first: ia init --host none --apply --yes`);
  const release = kit.latest;
  if (!release) throw new KitError(`this plugin build carries no release of ${kit.id}`);
  const resolved = cli ?? resolveCli(root);
  const current = installedKit(root, kit.id);
  if (current?.archive === release.archive) return { root, kit: kit.id, version: release.version, archive: release.archive, written: [], upgraded: [], dependencies: [], requests: [], already: true };
  const lock = readLock(root);
  const language = (lock?.packages ?? []).find(p => p.id === 'inventarch/language');
  const baseLock = readLock(kit.dir)?.packages.find(p => p.id === 'inventarch/language');
  const moving = language && baseLock && language.archive !== baseLock.archive;
  const upgrades = [kit];
  // Existing core kits on the old language must move in the same native
  // transaction. Only migrate archives this catalogue actually published;
  // unknown/forked packages keep their requests and native resolution judges
  // their compatibility. Never silently replace one with our own version.
  if (moving) for (const sibling of listKits(dirname(kit.dir))) {
    const installed = lock.packages.find(p => p.id === sibling.id);
    if (sibling.id !== kit.id && installed && installed.archive !== sibling.latest?.archive && sibling.releases.some(r => r.archive === installed.archive)) upgrades.push(sibling);
  }
  // install repins positional requests together, preserving every other
  // direct request. There is no intermediate removal of an installed kit.
  const requests = upgrades.map(k => `${k.id}@${k.latest.version}`);
  // The kits the upgrades depend on, each once, dependencies first.
  const dependencies = [];
  for (const entry of upgrades) for (const dep of kitDependencies(entry)) if (!dependencies.some(d => d.id === dep.id) && !upgrades.some(u => u.id === dep.id)) dependencies.push(dep);
  const dependencyRows = dependencies.map(d => ({ kit: d.id, version: d.latest.version, archive: d.latest.archive, origin: d.origin }));
  if (moving) requests.push(`inventarch/language@${readDescriptor(kit.dir).dependencies.find(d => d.id === 'inventarch/language').range}`);
  const upgraded = upgrades.slice(1).map(k => ({ kit: k.id, version: k.latest.version, archive: k.latest.archive }));
  const builds = [];
  const written = [];
  const before = new Map(), createdDirectories = [];
  const installationPaths = ['distributions.lock.json', 'distributions/active.json'].map(p => join(root, '.ia', p));
  const installationBytes = () => installationPaths.map(p => existsSync(p) ? readFileSync(p).toString('base64') : null);
  const installationBefore = installationBytes();
  let installing = false, exited = false;
  try {
    const depBuilds = [];
    for (const dep of dependencies) depBuilds.push({ kit: dep, built: packRelease(dep, dep.latest, resolved, { vendor: vendorArchives(depBuilds) }) });
    builds.push(...depBuilds);
    for (const entry of upgrades) builds.push({ kit: entry, built: packRelease(entry, entry.latest, resolved, { vendor: vendorArchives(depBuilds) }) });
    const { base } = builds[0].built;
    if (builds.some(b => b.built.base.archive !== base.archive)) throw new KitError(depBuilds.length ? 'the kit and the kits it depends on do not share one language base' : 'core kit upgrades do not share one language base');
    const vendor = join(root, 'vendor', 'ia');
    const copies = [...builds.map(({ kit: entry, built }) => [built.archive, join(vendor, `${entry.latest.archive}.ia.tgz`), entry.latest.archive]), [base.path, join(vendor, `${base.archive}.ia.tgz`), base.archive]];
    const catalogPath = join(vendor, 'catalog.json');
    // Adopt writes, and on a refusal restores or removes, only real folders and
    // regular files: a link here would send those writes, and the rollback's
    // removals, somewhere adopt did not choose.
    const stats = new Map([dirname(vendor), vendor, ...copies.map(c => c[1]), catalogPath].map(p => [p, lstatSync(p, { throwIfNoEntry: false })]));
    for (const [path, stat] of stats) {
      const folder = path === vendor || path === dirname(vendor);
      if (stat && (folder ? !stat.isDirectory() : !stat.isFile())) throw new KitError(`${path} is not a regular ${folder ? 'folder' : 'file'} (a link or another kind of entry); adopt writes only real folders and files under vendor/ia. Replace it, then adopt again`);
    }
    const catalog = stats.get(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : [];
    for (const archive of [...dependencies.map(k => k.latest.archive), ...upgrades.map(k => k.latest.archive), base.archive]) {
      const path = `vendor/ia/${archive}.ia.tgz`;
      if (!catalog.some(e => e.path === path)) catalog.push({ path, withdrawn: false });
    }
    if (dry) return { root, kit: kit.id, version: release.version, archive: release.archive, written: [...copies.map(c => c[1]), catalogPath, join(root, '.ia', 'distributions.lock.json')], upgraded, dependencies: dependencyRows, requests, dry: true };
    // The native installer owns lock/generation atomicity. Roll back our
    // vendor writes if resolution, admission or application refuses.
    for (const path of [...copies.map(c => c[1]), catalogPath]) before.set(path, stats.get(path) ? readFileSync(path) : undefined);
    for (const dir of [dirname(vendor), vendor]) if (!stats.get(dir)) { mkdirSync(dir); createdDirectories.push(dir); }
    for (const [from, to, digest] of copies) {
      if (existsSync(to) && sha256File(to) === digest) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      written.push(to);
    }
    writeLf(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    written.push(catalogPath);
    installing = true;
    const ran = runIa(root, ['install', ...requests, '--catalog', 'vendor/ia/catalog.json', '--apply', '--yes'], { cli: resolved, ...(installTimeoutMs ? { timeoutMs: installTimeoutMs } : {}) });
    exited = ran.code !== null;
    if (ran.code !== 0 || (ran.json?.applied?.status ?? ran.json?.status) !== 'installed') {
      const findings = ran.json?.findings ?? [];
      // Packages from elsewhere that pin the old base block the move; name them.
      const blockers = moving && findings.some(f => f?.code === 'IA-DIST-CONFLICT') ? lock.packages.filter(p => p.id !== 'inventarch/language' && !upgrades.some(k => k.id === p.id) && (p.dependencies ?? []).includes('inventarch/language')).map(p => p.id) : [];
      const hint = blockers.length ? ` ${blockers.join(', ')} still ${blockers.length === 1 ? 'depends' : 'depend'} on the old language base and ${blockers.length === 1 ? 'is not one' : 'are not'} of this catalogue's core kits: upgrade or remove ${blockers.length === 1 ? 'it' : 'them'} first, then adopt again (a kit another plugin installed moves with that plugin's own adopt: remove the core kits it names, run that adopt, then adopt this kit again).` : '';
      throw new KitError(`ia install refused the kit: ${JSON.stringify(ran.json?.findings?.slice(0, 3) ?? ran.json ?? ran.stderr.trim())}.${hint}`);
    }
    for (const entry of upgrades) if (installedKit(root, entry.id)?.archive !== entry.latest.archive) throw new KitError(`after install the lock does not pin ${entry.latest.archive}`);
    for (const dep of dependencies) if (!installedKit(root, dep.id)) throw new KitError(`after install the lock does not carry ${dep.id}, which ${kit.id} depends on`);
    written.push(join(root, '.ia', 'distributions.lock.json'));
    return { root, kit: kit.id, version: release.version, archive: release.archive, written, upgraded, dependencies: dependencyRows, requests };
  } catch (error) {
    // A timeout, lost JSON or post-apply nonzero exit may follow a native
    // commit. Never delete archives beneath that generation. An unreadable
    // state is uncertain too; preserve recovery material and say so. An
    // install that did not exit on its own (a timeout or a signal) may still
    // be running: through npx on Windows a timeout kills npx, not the ia it
    // started, so the lock can change after this comparison.
    let unchanged = false;
    try { unchanged = JSON.stringify(installationBytes()) === JSON.stringify(installationBefore); } catch {}
    if (installing && !exited) throw new KitError(`installation outcome is uncertain; ia install did not exit on its own and may still commit. Vendor archives and catalog were retained. Wait for it to finish, then inspect the native installation and run kit status before retrying. ${error.message}`, 'IA-CORE-INSTALL-UNCERTAIN');
    if (before.size && !unchanged) throw new KitError(`installation outcome is uncertain; lock or active generation changed. Vendor archives and catalog were retained. Inspect the native installation and run kit status before retrying. ${error.message}`, 'IA-CORE-INSTALL-UNCERTAIN');
    for (const [path, bytes] of before) {
      if (bytes === undefined) rmSync(path, { force: true }); else writeFileSync(path, bytes);
    }
    for (const dir of createdDirectories.reverse()) if (readdirSync(dir).length === 0) rmdirSync(dir);
    throw error;
  } finally { for (const { built } of builds) built.cleanup(); }
}

// A pin is usable only while the complete carried source/sidecar digest and
// selected native release still match it. Historical release metadata is not
// historical bytes: refuse drift rather than relabel current instructions.
export function assertPinnedKit(kit, pinned, installed = null) {
  if (!pinned || !/^[a-f0-9]{64}$/.test(pinned.sources ?? '')) throw new KitError(`kit ${kit.id} has no verifiable source pin; explicitly rebind it`, 'IA-CORE-PIN-UNAVAILABLE');
  const current = { version: kit.latest?.version ?? kit.version ?? null, archive: kit.latest?.archive ?? null, sources: sourcesDigest(kit.dir) };
  if (current.version !== pinned.version || current.archive !== (pinned.archive ?? null) || current.sources !== pinned.sources) throw new KitError(`kit ${kit.id} no longer matches its pinned release and source bytes; restore the exact release or explicitly rebind`, 'IA-CORE-PIN-UNAVAILABLE');
  if (!pinned.implementation || pinned.implementation !== implementationDigest(kit)) throw new KitError(`kit ${kit.id} runner/helper bytes are not verified against this pin; restore the exact implementation or explicitly rebind`, 'IA-CORE-PIN-UNAVAILABLE');
  if (installed && (installed.version !== pinned.version || (installed.archive ?? null) !== (pinned.archive ?? null))) throw new KitError(`installed kit ${kit.id} differs from the pinned method; restore the exact installation or explicitly rebind`, 'IA-CORE-PIN-UNAVAILABLE');
}
