// The operations behind scripts/kit.mjs (decision public-kit-lookup): list,
// add, bind, upgrade, repin, rebind and check. Each returns one JSON-ready
// value; each write validates first and happens only with apply, so every
// verb previews by default.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES, readBindings, writeBindings } from './binding.mjs';
import { adopt, declaredAssets, findKit, homeKitsDir, installedKits, KitError, kitBindings, kitChecks, kitDelivery, kitDependencies, listKits, readDescriptor, readReleases, releaseRecords, sourcesDigest } from './kit.mjs';
import { kitHandlers } from './handlers.mjs';
import { kitTrust } from './trust.mjs';
import { isVersion } from './releases.mjs';
import { kitUpdate, pinRootFor, readPin } from './pin.mjs';
import { readMethodPin } from './method-pin.mjs';
import { kitRecordNames } from './records.mjs';
import { findWorkspace, UsageError } from './workspace.mjs';

const KEY = new RegExp(`^(?:${ENTRIES.join('|')})\\.(?:[a-z][a-z0-9-]*|\\*)$`);
const same = (a, b) => a.kit === b.kit && a.capability === b.capability && (a.profile ?? null) === (b.profile ?? null);
const empty = () => ({ bindings: {}, precedence: [], defaults: {} });

// A binding key as a person reads it: work.brainstorm is ia-work:brainstorm, work.* is ia-work.
export const surfacedName = key => {
  const [lane, activity] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
  return activity === '*' ? `ia-${lane}` : `ia-${lane}:${activity}`;
};

export function workspaceRoot(given) {
  const root = findWorkspace(given ?? process.cwd());
  if (!root) throw new UsageError(`${given ?? process.cwd()} is not inside an IA workspace (no .ia/src at or above it)`);
  return root;
}

// Every kit the core can resolve, with what it offers.
export function listOp() {
  return {
    home: homeKitsDir(),
    kits: listKits().map(k => {
      const { recommend, unbound } = kitBindings(k);
      return {
        folder: k.folder, id: k.id, origin: k.origin, version: k.version ?? null,
        latest: k.latest ? { version: k.latest.version, archive: k.latest.archive, cli: k.latest.cli } : null,
        versions: k.releases.map(r => r.version), checks: Object.keys(kitChecks(k).checks).sort(),
        whole: kitDelivery(k).whole, offers: Object.keys(recommend).sort(), unbound,
        // How the keys the kit offers read to a person: the binding key re-spelled, ia-<lane>:<activity>, whichever
        // kit supplies it; a lane's entry (<lane>.*) reads ia-<lane> (decision public-plugin-ia).
        surfaced: Object.keys(recommend).sort().map(surfacedName),
      };
    }),
  };
}

// The problems that keep a kit folder from being installed or trusted: its
// release index, its latest release against its sources and records, and
// sidecars that name records the kit does not have.
export function kitProblems(kit) {
  const problems = [];
  let index;
  try { index = readReleases(kit.dir); } catch (error) { return [error.message]; }
  const latest = kit.latest;
  if (!latest) return ['records no release'];
  let descriptor = {};
  try { descriptor = readDescriptor(kit.dir); } catch (error) { problems.push(error.message); }
  if (!isVersion(descriptor.version)) problems.push(`.ia/release.json version ${JSON.stringify(descriptor.version)} is not a semver version`);
  if (descriptor.id && descriptor.id !== index.kit) problems.push(`.ia/release.json id ${descriptor.id} is not the release index's ${index.kit}`);
  if (descriptor.version !== latest.version) problems.push(`.ia/release.json version ${descriptor.version} is not the latest release ${latest.version}`);
  if (latest.sources !== sourcesDigest(kit.dir)) problems.push(`the sources are not release ${latest.version} (sources digest differs)`);
  try {
    const recorded = JSON.stringify(releaseRecords(kit.dir, latest));
    if (recorded !== JSON.stringify(kitRecordNames(kit.dir))) problems.push(`release ${latest.version} lists other records than the sources`);
  } catch (error) { problems.push(error.message); }
  for (const [name, read] of [['bindings.json', kitBindings], ['delivery.json', kitDelivery], ['checks.json', kitChecks]]) {
    try {
      const { undeclared } = read(kit);
      if (undeclared.length) problems.push(`${name} names what is not a record of the kit: ${undeclared.join(', ')}`);
    } catch (error) { problems.push(error.message); }
  }
  // Every script a handlers.json runs ships with the kit: it is a declared asset, so it is packed and digested.
  try {
    const handlers = kitHandlers(kit);
    let assets = [];
    try { assets = declaredAssets(kit.dir).map(a => a.rel); } catch { /* reported by the sources digest */ }
    const runs = [...new Set(Object.values(handlers).flat().map(h => h.run).filter(Boolean))];
    const undeclared = runs.filter(run => !assets.includes(run));
    if (undeclared.length) problems.push(`handlers.json runs scripts that are not declared assets in .ia/release.json: ${undeclared.join(', ')}`);
  } catch (error) { problems.push(error.message); }
  return problems;
}

export function checkOp(ref) {
  const kits = ref ? [findKit(ref)] : listKits();
  // trust says whether the kit may run code here (decision public-kit-trust); an untrusted kit is not a problem.
  const rows = kits.map(k => { const trust = kitTrust(k); return { kit: k.id, origin: k.origin, version: k.latest?.version ?? null, problems: kitProblems(k), runsCode: trust.trusted, ...(trust.trusted ? {} : { untrusted: trust.reason }) }; });
  return { status: rows.every(r => r.problems.length === 0) ? 'passed' : 'refused', kits: rows };
}

// A kit folder from --from: the folder itself, or an archive tar extracts
// into a temporary folder (cleanup() removes it).
function source(from) {
  const path = resolve(from);
  if (!existsSync(path)) throw new UsageError(`--from ${from} does not exist`);
  if (statSync(path).isDirectory()) return { dir: path, origin: 'source', cleanup: () => {} };
  if (!/\.(?:tgz|tar\.gz|tar)$/i.test(path)) throw new UsageError(`--from takes a kit folder or a .tgz, .tar.gz or .tar archive of one: ${from}`);
  const work = mkdtempSync(join(realpathSync(tmpdir()), 'inventarch-kit-add-'));
  // Run in the archive's folder and name it relatively: GNU tar (Git for Windows' is first on many PATHs) reads "C:" in an absolute path as a remote host.
  const ran = spawnSync('tar', ['-xf', basename(path), '-C', work], { cwd: dirname(path), encoding: 'utf8', shell: false });
  if (ran.status !== 0) { rmSync(work, { recursive: true, force: true }); throw new KitError(`tar could not extract ${from}: ${(ran.stderr || ran.error?.message || '').trim()}`, 'IA-CORE-KIT-ARCHIVE'); }
  const entries = readdirSync(work);
  const dir = existsSync(join(work, 'releases.json')) ? work : entries.length === 1 && existsSync(join(work, entries[0], 'releases.json')) ? join(work, entries[0]) : null;
  if (!dir) { rmSync(work, { recursive: true, force: true }); throw new KitError(`${from} holds no kit (no releases.json at its root or in its one folder)`, 'IA-CORE-KIT-ARCHIVE'); }
  return { dir, origin: 'archive', cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

// What an install leaves out of a kit folder: its node_modules, .git and the
// generated .ia/distributions and .ia/work.
const NOT_INSTALLED = /[\\/](?:node_modules|\.git|\.ia[\\/](?:distributions|work))$/;

// A kit installs only as regular files and folders: a link would point the
// installed kit (its handlers, its records) outside its own folder.
function assertRegularTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (NOT_INSTALLED.test(path)) continue;
    if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) throw new KitError(`${path} is a link or another kind of entry; a kit installs only regular files and folders`, 'IA-CORE-KIT-INVALID');
    if (entry.isDirectory()) assertRegularTree(path);
  }
}

// The home folder of a kit id: inventarch/<name>-kit installs as <name>.
function homeFolder(id) {
  const folder = String(id ?? '').split('/').at(-1).replace(/-kit$/, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(folder)) throw new KitError(`kit id ${id} does not give a folder name`, 'IA-CORE-KIT-INVALID');
  return folder;
}

// <IA home>/kits/<folder>/<version>, refused unless the version is strict
// semver and the folder resolves to exactly that place inside the home.
export function installTarget(home, folder, version) {
  if (!isVersion(version)) throw new KitError(`kit version ${JSON.stringify(version)} is not a semver version; nothing is installed`, 'IA-CORE-KIT-INVALID');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(folder ?? '')) throw new KitError(`kit folder ${JSON.stringify(folder)} is not a plain folder name; nothing is installed`, 'IA-CORE-KIT-INVALID');
  const root = resolve(home);
  const target = resolve(root, folder, version);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).join('/') !== `${folder}/${version}`) throw new KitError(`${target} is not inside the IA home kit folder ${root}; nothing is installed`, 'IA-CORE-KIT-INVALID');
  return target;
}

// One kit's place in the home, checked before anything is written: its
// problems, its folders' entries and what already sits at its target.
function installPlan(kit, home, { checked = false } = {}) {
  const problems = checked ? [] : kitProblems(kit);
  if (problems.length) throw Object.assign(new KitError(`${kit.dir} is not an installable kit: ${problems.join('; ')}`, 'IA-CORE-KIT-INVALID'), { problems });
  const descriptor = readDescriptor(kit.dir);
  assertRegularTree(kit.dir);
  const target = installTarget(home, homeFolder(descriptor.id ?? kit.id), descriptor.version);
  let already = false;
  if (existsSync(target)) {
    if (sourcesDigest(target) !== kit.latest.sources) throw new KitError(`${target} already holds other bytes for ${kit.id} ${descriptor.version}; an installed version is never overwritten`, 'IA-CORE-KIT-CONFLICT');
    already = true;
  }
  return { kit, version: descriptor.version, target, already };
}

function install({ kit, target }) {
  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.installing-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(kit.dir, staging, { recursive: true, filter: p => !NOT_INSTALLED.test(p) });
  renameSync(staging, target);
}

// Installs a kit folder into <IA home>/kits/<folder>/<version>/ once it
// validates; an installed version is never overwritten. A dependency found
// only next to the kit in a source tree is installed alongside it, first: an
// installed kit looks for its dependencies among the plugin's kits and the
// home's (C3), not next to the folder it came from. `alongside` lists them.
export function addFromOp(from, { apply = false, home = homeKitsDir() } = {}) {
  if (!home) throw new KitError('the IA home kit folder is turned off here (IA_CORE_NO_HOME_KITS, or IA_CORE_KITS_DIR without IA_HOME)', 'IA-CORE-KIT-HOME');
  const src = source(from);
  try {
    const releases = readReleases(src.dir);
    const latest = (releases.latest ? releases.releases.find(r => r.version === releases.latest) : releases.releases.at(-1)) ?? null;
    const descriptor = readDescriptor(src.dir);
    const folder = homeFolder(descriptor.id ?? releases.kit);
    const kit = { folder, dir: src.dir, id: releases.kit, version: descriptor.version, latest, releases: releases.releases, origin: src.origin };
    const problems = kitProblems(kit);
    if (problems.length) throw Object.assign(new KitError(`${from} is not an installable kit: ${problems.join('; ')}`, 'IA-CORE-KIT-INVALID'), { problems });
    // A kit that depends on other kits installs only once they are found (C3): carried, in the IA home, or next to it.
    const found = kitDependencies(kit);
    const dependencies = found.map(d => ({ kit: d.id, version: d.latest.version, archive: d.latest.archive, origin: d.origin }));
    const plans = [...found.filter(d => d.origin === 'source').map(d => installPlan(d, home)), installPlan(kit, home, { checked: true })];
    const self = plans.at(-1);
    const alongside = plans.slice(0, -1);
    const row = p => ({ kit: p.kit.id, version: p.version, target: p.target, ...(p.already ? { already: true } : apply ? { installed: true } : { wouldInstall: true }) });
    const applied = apply && plans.some(plan => !plan.already);
    if (apply) for (const plan of plans) if (!plan.already) install(plan);
    const result = { kit: kit.id, version: self.version, target: self.target, dependencies, alongside: alongside.map(row) };
    if (self.already) return { ...result, already: true, applied };
    if (!apply) return { ...result, wouldInstall: true, applied: false };
    return { ...result, installed: true, applied: true };
  } finally { src.cleanup(); }
}

// Installs a kit's latest release into an IA workspace (ia install through adopt).
export function addOp(ref, repo, { apply = false } = {}) {
  const kit = findKit(ref);
  const problems = kitProblems(kit);
  if (problems.length) throw Object.assign(new KitError(`${kit.id} does not validate: ${problems.join('; ')}`, 'IA-CORE-KIT-INVALID'), { problems });
  const result = adopt(workspaceRoot(repo), kit, { dry: !apply });
  return { ...result, applied: apply, next: { bind: `kit.mjs bind ${kit.id}` } };
}

// Recommends a kit's keys, or sets one key, in the repository's bindings.
export function bindOp(ref, repo, { apply = false, key, capability, profile } = {}) {
  const kit = findKit(ref);
  const { recommend, unbound, undeclared } = kitBindings(kit);
  const root = apply ? workspaceRoot(repo) : findWorkspace(repo ?? process.cwd());
  const data = root ? readBindings(root) ?? empty() : null;
  if (key || capability) {
    if (!key || !capability) throw new UsageError('bind --key needs --capability (and --capability needs --key)');
    if (!KEY.test(key)) throw new UsageError(`a key is <entry>.<activity> or <entry>.*, with the entry one of ${ENTRIES.join(', ')}: ${key}`);
    const names = kitRecordNames(kit.dir);
    if (!names.some(r => r.word === 'capability' && r.name === capability)) throw new KitError(`${kit.id} has no capability ${capability}`, 'IA-CORE-BIND-UNDECLARED');
    if (profile && !names.some(r => r.word === 'agent-profile' && r.name === profile)) throw new KitError(`${kit.id} has no agent-profile ${profile}`, 'IA-CORE-BIND-UNDECLARED');
    const binding = { kit: kit.id, capability, ...(profile ? { profile } : {}) };
    let path = null;
    if (apply) { data.bindings[key] = [binding]; path = writeBindings(root, data); }
    return { root, kit: kit.id, key, binding, previous: data?.bindings[key] ?? null, path, applied: apply };
  }
  const added = [], already = [], kept = [];
  for (const [k, binding] of Object.entries(recommend)) {
    const current = data?.bindings[k] ?? [];
    if (!current.length) added.push(k);
    else if (current.length === 1 && same(current[0], binding)) already.push(k);
    else kept.push({ key: k, bound: current });
  }
  let path = null;
  if (apply && added.length) {
    for (const k of added) data.bindings[k] = [recommend[k]];
    path = writeBindings(root, data);
  }
  return { root, kit: kit.id, recommend, unbound, undeclared, [apply ? 'added' : 'wouldAdd']: added, already, kept, path, applied: apply };
}

// Moves keys bound to one kit to another; refuses a capability or profile the
// target kit does not have.
export function rebindOp(fromRef, toRef, repo, { keys, apply = false } = {}) {
  const root = workspaceRoot(repo);
  const data = readBindings(root);
  if (!data) throw new KitError(`${root} has no .ia/bindings.json to rebind`, 'IA-CORE-BINDINGS-MISSING');
  const target = findKit(toRef);
  const names = kitRecordNames(target.dir);
  const has = (word, name) => names.some(r => r.word === word && r.name === name);
  const from = (() => { try { return findKit(fromRef).id; } catch { return fromRef; } })();
  const wanted = keys ? new Set(keys) : null;
  const moved = [], refused = [];
  for (const [key, list] of Object.entries(data.bindings)) {
    if (wanted && !wanted.has(key)) continue;
    const next = list.map(b => {
      if (b.kit !== from) return b;
      if (!has('capability', b.capability) || (b.profile && !has('agent-profile', b.profile))) { refused.push({ key, capability: b.capability, profile: b.profile ?? null }); return b; }
      moved.push(key);
      return { ...b, kit: target.id };
    });
    data.bindings[key] = next;
  }
  for (const [entry, b] of Object.entries(data.defaults ?? {})) {
    if (b.kit === from && !wanted && has('capability', b.capability)) { data.defaults[entry] = { ...b, kit: target.id }; moved.push(`defaults.${entry}`); }
  }
  data.precedence = (data.precedence ?? []).map(id => (id === from ? target.id : id)).filter((id, i, all) => all.indexOf(id) === i);
  if (wanted) for (const key of wanted) if (!Object.hasOwn(data.bindings, key)) refused.push({ key, reason: 'not bound in this repository' });
  if (refused.length) return { root, from, to: target.id, moved: [], refused, applied: false };
  let path = null;
  if (apply && moved.length) path = writeBindings(root, data);
  return { root, from, to: target.id, [apply ? 'moved' : 'wouldMove']: moved, refused, path, applied: apply && moved.length > 0 };
}

// Installed kits against the latest release each carries; adopts the newer.
export function upgradeOp(ref, repo, { apply = false } = {}) {
  const root = workspaceRoot(repo);
  const installed = installedKits(root);
  const targets = ref ? [findKit(ref)] : installed.map(i => { try { return findKit(i.id); } catch { return null; } }).filter(Boolean);
  const plan = targets.map(kit => {
    const current = installed.find(i => i.id === kit.id) ?? null;
    return { kit: kit.id, installed: current ? { version: current.version, archive: current.archive } : null, latest: kit.latest ? { version: kit.latest.version, archive: kit.latest.archive } : null, behind: Boolean(kit.latest && current?.archive !== kit.latest.archive), dir: kit.dir };
  });
  const results = [];
  if (apply) for (const row of plan.filter(r => r.behind)) results.push(adopt(root, findKit(row.kit)));
  return { root, plan: plan.map(({ dir, ...r }) => r), [apply ? 'upgraded' : 'wouldUpgrade']: apply ? results.map(r => ({ kit: r.kit, version: r.version })) : plan.filter(r => r.behind).map(r => r.kit), next: { repin: 'kit.mjs repin --project <p> --task <t>', rebind: 'kit.mjs bind <kit> (new keys)' }, applied: apply };
}

// A task's pin against the kits now available: which keys would move. With
// apply, a format 3 pin is moved key by key through resolve.mjs --rebind, which
// writes each new revision and keeps the history; a format 4 method pin is
// reported and moved by resolve.mjs --qualified --rebind.
export function repinOp(repo, { project, task, apply = false, env = process.env } = {}) {
  const root = workspaceRoot(repo);
  const pinRoot = pinRootFor({ env, project, task });
  if (!pinRoot) throw new UsageError('repin needs --project and --task (or IA_CORE_RUN_ROOT)');
  const method = (() => { try { return readMethodPin(pinRoot); } catch { return null; } })();
  if (method) {
    const keys = Object.entries(method.keys).map(([key, row]) => ({ key, kit: row.kit }));
    return { root, pinRoot, format: 4, revision: method.revision, keys, applied: false, next: 'node scripts/resolve.mjs --qualified --rebind --preview-rebind ... previews the closure move, then without --preview-rebind writes it' };
  }
  const pin = readPin(pinRoot, root);
  if (!pin) return { root, pinRoot, pin: null, affected: [], applied: false };
  const affected = [];
  for (const [key, row] of Object.entries(pin.keys)) {
    let available = null;
    try { available = findKit(row.kit).latest; } catch { /* a kit no longer carried stays pinned */ }
    const update = kitUpdate(pin.kits[row.kit], available);
    if (update) affected.push({ key, kit: row.kit, ...update });
  }
  if (!apply || !affected.length) return { root, pinRoot, format: 3, revision: pin.revision, affected, applied: false };
  const script = fileURLToPath(new URL('../resolve.mjs', import.meta.url));
  const moved = [];
  for (const row of affected) {
    const [entry, activity] = row.key.split('.');
    if (activity === '*') continue;
    const ran = spawnSync(process.execPath, [script, '--entry', entry, '--activity', activity, '--root', root, '--project', project, '--task', task, '--rebind', '--json'], { encoding: 'utf8', env, timeout: 120000 });
    moved.push({ key: row.key, status: ran.status, error: ran.status === 0 ? null : (ran.stdout || ran.stderr).trim().slice(0, 400) });
  }
  return { root, pinRoot, format: 3, affected, moved, applied: true };
}

