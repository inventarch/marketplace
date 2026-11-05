#!/usr/bin/env node
// Maintainer tool: the @inventarch/public-kits npm package (contracts C7 and
// C7b, decision public-kits-package), generated in packages/public-kits/ from
// the kits the core bundles (plugins/ia/config/kits/*) and kits/index.json, so
// it cannot drift from them.
//   node tools/kit.mjs package --check [--built]   the committed package.json is the claim the bundled kits make,
//                                                  and the built files, when present (required with --built), are theirs
//   node tools/kit.mjs package --write             rewrite package.json's ia.kits from the bundled kits, then build
//   node tools/kit.mjs package --build             build the files, refusing a stale package.json (the publish workflow)
// package.json is committed: its version is the maintainer's (strict semver,
// bumped whenever a carried kit release changes; tools/consistency.py --base
// checks that), and every other byte is generated. Its ia.kits names each
// carried kit's id, latest version, IA archive and manifest sha256, sources
// digest and folder. The built files are gitignored and reproducible:
//   index.json                         kits/index.json
//   kits/<folder>/                     plugins/ia/config/kits/<folder>/, byte for byte
//   archives/<archive>.ia.tgz          the kit's recorded release, packed again with the pinned CLI (packRelease refuses
//                                      any other bytes)
//   archives/<archive>.distribution.json   that archive's manifest (its distribution.json), whose sha256 is ia.kits manifest
//   LICENSE, NOTICE                    the repository's
// npm is transport only (C7b): the IA engine expands each kit from its archive.
// Runtime sidecars are declared assets, so an archive alone supplies the
// binding, delivery and check metadata a bare door needs. Kit folders and
// release history remain for folder consumers. Exit 0 on success, 1 on drift
// or a refusal, 2 on bad usage.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { kitFiles } from './bundle-kits.mjs';
import { resolveCli } from '../plugins/ia/scripts/lib/cli.mjs';
import { findKit, packDependencies, packRelease, readReleases, sourcesDigest } from '../plugins/ia/scripts/lib/kit.mjs';

export const PACKAGE_DIR = 'packages/public-kits';
export const PACKAGE_NAME = '@inventarch/public-kits';
const BUNDLED = 'plugins/ia/config/kits';
const COPIED = { 'index.json': 'kits/index.json', LICENSE: 'LICENSE', NOTICE: 'NOTICE' };
const BUILT = ['index.json', 'kits', 'archives', 'LICENSE', 'NOTICE'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const USAGE = 'usage: node tools/kit.mjs package (--check [--built] | --write | --build)\n';

export class PackageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageError';
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => JSON.stringify(value, null, 2) + '\n';

// The kits the core bundles, in folder order: [{ folder, dir, kit, latest }].
export function bundledKits(root) {
  const base = join(root, BUNDLED);
  return readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(base, e.name, 'releases.json'))).map(e => e.name).sort().map(folder => {
    const dir = join(base, folder);
    const index = readReleases(dir);
    const version = index.latest ?? index.releases.at(-1)?.version;
    const latest = index.releases.find(r => r.version === version);
    if (!latest) throw new PackageError(`${BUNDLED}/${folder}: releases.json records no latest release`);
    return { folder, dir, kit: index.kit, latest };
  });
}

// What package.json's ia.kits claims: one row per bundled kit, from its latest
// release row, refusing a kit whose bytes are not that release.
export function packageClaim(root) {
  return bundledKits(root).map(({ folder, dir, kit, latest }) => {
    const descriptor = JSON.parse(readFileSync(join(dir, '.ia/release.json'), 'utf8'));
    for (const name of ['bindings.json', 'delivery.json', 'checks.json', 'onwrite.json', 'handlers.json']) {
      if (existsSync(join(dir, name)) && !descriptor.assets?.some(asset => asset.path === name))
        throw new PackageError(`${BUNDLED}/${folder}: ${name} must be a declared release asset so installed kits retain it`);
    }
    const sources = sourcesDigest(dir);
    if (sources !== latest.sources) throw new PackageError(`${BUNDLED}/${folder} is not its recorded release ${latest.version}: its sources digest is ${sources}, the release records ${latest.sources}`);
    if (!/^[a-f0-9]{64}$/.test(latest.archive ?? '') || !/^[a-f0-9]{64}$/.test(latest.manifest ?? '')) throw new PackageError(`${BUNDLED}/${folder}: release ${latest.version} records no archive and manifest sha256`);
    return { id: kit, version: latest.version, archive: latest.archive, manifest: latest.manifest, sources, folder };
  });
}

// The package.json the repository should hold, for a version.
export function packageManifest(root, version) {
  return {
    name: PACKAGE_NAME,
    version,
    description: 'The public InventArch method kits as one package: each kit\'s IA archive and manifest, with its folder, for an IA engine to expand (contract C7b).',
    license: 'Apache-2.0',
    repository: { type: 'git', url: 'git+https://github.com/inventarch/marketplace.git', directory: PACKAGE_DIR },
    files: ['index.json', 'kits', 'archives', 'NOTICE'],
    ia: { format: 1, kits: packageClaim(root) },
  };
}

function committed(root) {
  const path = join(root, PACKAGE_DIR, 'package.json');
  if (!existsSync(path)) return null;
  try { return { text: readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), json: JSON.parse(readFileSync(path, 'utf8')) }; } catch (error) { throw new PackageError(`${PACKAGE_DIR}/package.json is not JSON: ${error.message}`); }
}

// Problems with the committed package.json: [] when it is the claim.
export function manifestProblems(root) {
  const current = committed(root);
  if (!current) return [`${PACKAGE_DIR}/package.json is missing; run node tools/kit.mjs package --write`];
  const version = current.json.version;
  if (typeof version !== 'string' || !SEMVER.test(version)) return [`${PACKAGE_DIR}/package.json: version ${JSON.stringify(version)} is not strict semver`];
  const problems = [];
  for (const key of ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies', 'exports', 'bin', 'main', 'private']) {
    if (current.json[key] !== undefined) problems.push(`${PACKAGE_DIR}/package.json declares ${key}; the package has no scripts, dependencies, entry points or exports and is published`);
  }
  if (current.text !== text(packageManifest(root, version))) problems.push(`${PACKAGE_DIR}/package.json is not the claim the bundled kits make (ia.kits, or a generated field, differs); run node tools/kit.mjs package --write, and bump its version when a carried release changed`);
  return problems;
}

// The archive's manifest: its distribution.json bytes.
export function archiveManifest(bytes) {
  const tar = gunzipSync(bytes);
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every(b => b === 0)) break;
    const field = (offset, length) => { const raw = header.subarray(offset, offset + length); const end = raw.indexOf(0); return raw.subarray(0, end < 0 ? length : end).toString('utf8'); };
    const name = (field(345, 155) ? `${field(345, 155)}/` : '') + field(0, 100);
    const size = Number.parseInt(field(124, 12), 8);
    if (name === 'distribution.json') return Buffer.from(tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new PackageError('the archive holds no distribution.json');
}

const anyBuilt = root => BUILT.some(name => existsSync(join(root, PACKAGE_DIR, name)));

// Problems with the built files: [] when every one is what the sources give.
export function builtProblems(root, { required = false } = {}) {
  const pkg = join(root, PACKAGE_DIR);
  if (!anyBuilt(root)) return required ? [`${PACKAGE_DIR} is not built; run node tools/kit.mjs package --build`] : [];
  const problems = [];
  for (const [to, from] of Object.entries(COPIED)) {
    if (!existsSync(join(pkg, to))) problems.push(`${PACKAGE_DIR}/${to} is missing`);
    else if (!readFileSync(join(pkg, to)).equals(readFileSync(join(root, from)))) problems.push(`${PACKAGE_DIR}/${to} is not ${from}`);
  }
  let claim;
  try { claim = packageClaim(root); } catch (error) { return [...problems, error.message]; }
  const folders = existsSync(join(pkg, 'kits')) ? readdirSync(join(pkg, 'kits')).sort() : [];
  const extraFolders = folders.filter(f => !claim.some(k => k.folder === f));
  if (extraFolders.length) problems.push(`${PACKAGE_DIR}/kits holds ${extraFolders.join(', ')}, which no bundled kit is`);
  const archives = existsSync(join(pkg, 'archives')) ? readdirSync(join(pkg, 'archives')).sort() : [];
  const expected = claim.flatMap(k => [`${k.archive}.ia.tgz`, `${k.archive}.distribution.json`]);
  const extraArchives = archives.filter(a => !expected.includes(a));
  if (extraArchives.length) problems.push(`${PACKAGE_DIR}/archives holds ${extraArchives.join(', ')}, which no carried release is`);
  for (const k of claim) {
    const source = join(root, BUNDLED, k.folder);
    const target = join(pkg, 'kits', k.folder);
    const want = kitFiles(source), have = new Set(kitFiles(target));
    const missing = want.filter(p => !have.has(p)), extra = [...have].filter(p => !want.includes(p));
    const differ = want.filter(p => have.has(p) && !readFileSync(join(source, p)).equals(readFileSync(join(target, p))));
    if (missing.length + extra.length + differ.length) problems.push(`${PACKAGE_DIR}/kits/${k.folder} is not ${BUNDLED}/${k.folder}: missing ${missing.join(' ') || 'none'}, extra ${extra.join(' ') || 'none'}, differ ${differ.join(' ') || 'none'}`);
    const archivePath = join(pkg, 'archives', `${k.archive}.ia.tgz`);
    const manifestPath = join(pkg, 'archives', `${k.archive}.distribution.json`);
    if (!existsSync(archivePath)) { problems.push(`${PACKAGE_DIR}/archives/${k.archive}.ia.tgz (${k.id} ${k.version}) is missing`); continue; }
    const bytes = readFileSync(archivePath);
    if (sha256(bytes) !== k.archive) { problems.push(`${PACKAGE_DIR}/archives/${k.archive}.ia.tgz is not ${k.id} ${k.version}: its sha256 is ${sha256(bytes)}`); continue; }
    let inner;
    try { inner = archiveManifest(bytes); } catch (error) { problems.push(`${PACKAGE_DIR}/archives/${k.archive}.ia.tgz: ${error.message}`); continue; }
    if (sha256(inner) !== k.manifest) problems.push(`${PACKAGE_DIR}/archives/${k.archive}.ia.tgz: its manifest's sha256 is ${sha256(inner)}, the release records ${k.manifest}`);
    if (!existsSync(manifestPath)) problems.push(`${PACKAGE_DIR}/archives/${k.archive}.distribution.json is missing`);
    else if (!readFileSync(manifestPath).equals(inner)) problems.push(`${PACKAGE_DIR}/archives/${k.archive}.distribution.json is not the archive's manifest`);
  }
  return problems;
}

// Writes the built files: copies, kit folders, and each recorded release packed
// again with the pinned CLI. Refuses a stale package.json first.
export function build(root, { cli = resolveCli(root), out = () => {} } = {}) {
  const stale = manifestProblems(root);
  if (stale.length) throw new PackageError(stale.join('\n'));
  const pkg = join(root, PACKAGE_DIR);
  for (const name of BUILT) rmSync(join(pkg, name), { recursive: true, force: true });
  for (const [to, from] of Object.entries(COPIED)) copyFileSync(join(root, from), join(pkg, to));
  mkdirSync(join(pkg, 'archives'), { recursive: true });
  for (const k of packageClaim(root)) {
    const source = join(root, BUNDLED, k.folder);
    for (const rel of kitFiles(source)) {
      mkdirSync(dirname(join(pkg, 'kits', k.folder, rel)), { recursive: true });
      copyFileSync(join(source, rel), join(pkg, 'kits', k.folder, rel));
    }
    const kit = findKit(k.folder, join(root, BUNDLED));
    const deps = packDependencies(kit, cli);
    let built;
    try {
      built = packRelease(kit, kit.latest, cli, { vendor: deps.flatMap(d => [d.built.archive, d.built.base.path]) });
      const bytes = readFileSync(built.archive);
      const inner = archiveManifest(bytes);
      if (sha256(inner) !== k.manifest) throw new PackageError(`${k.id} ${k.version} packs to its recorded archive, but its manifest's sha256 is ${sha256(inner)}, not the recorded ${k.manifest}`);
      writeFileSync(join(pkg, 'archives', `${k.archive}.ia.tgz`), bytes);
      writeFileSync(join(pkg, 'archives', `${k.archive}.distribution.json`), inner);
      out(`${k.id} ${k.version}: archives/${k.archive}.ia.tgz (${statSync(built.archive).size} bytes), manifest ${k.manifest}\n`);
    } finally {
      built?.cleanup();
      for (const d of deps) d.built.cleanup();
    }
  }
  const problems = builtProblems(root, { required: true });
  if (problems.length) throw new PackageError(problems.join('\n'));
}

export function packageMain(argv, root, out = t => process.stdout.write(t), err = t => process.stderr.write(t)) {
  const mode = argv[0];
  if (!['--check', '--write', '--build'].includes(mode) || argv.length > 2 || (argv.length === 2 && !(mode === '--check' && argv[1] === '--built'))) { err(USAGE); return 2; }
  try {
    if (mode === '--check') {
      const problems = [...manifestProblems(root), ...builtProblems(root, { required: argv[1] === '--built' })];
      for (const line of problems) err(`${line}\n`);
      if (problems.length) return 1;
      const kits = committed(root).json.ia.kits;
      out(`${PACKAGE_DIR}/package.json (${PACKAGE_NAME}@${committed(root).json.version}) claims ${kits.map(k => `${k.id} ${k.version}`).join(', ')}${anyBuilt(root) ? ', and its built files match' : ''}\n`);
      return 0;
    }
    if (mode === '--write') {
      const current = committed(root);
      const version = typeof current?.json.version === 'string' && SEMVER.test(current.json.version) ? current.json.version : '1.0.0';
      const want = text(packageManifest(root, version));
      mkdirSync(join(root, PACKAGE_DIR), { recursive: true });
      if (current?.text !== want) writeFileSync(join(root, PACKAGE_DIR, 'package.json'), want);
      out(`${PACKAGE_DIR}/package.json ${current?.text === want ? 'unchanged' : 'written'} (version ${version}${current && current.text !== want ? '; bump it if a carried release changed' : ''})\n`);
    }
    build(root, { out });
    out(`${PACKAGE_DIR} built\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof PackageError) && !error.code) throw error;
    err(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = packageMain(process.argv.slice(2), fileURLToPath(new URL('../', import.meta.url)));
