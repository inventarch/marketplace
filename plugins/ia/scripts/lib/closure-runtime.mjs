// Byte qualification precedes all native imports. Pins are generated from
// integrity-checked registry tarballs, never from the installation being judged.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const profilePath = fileURLToPath(new URL('../../config/qualified-runtime-3.8.0.json', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const fail = message => { const error = new Error(message); error.code = 'IA-CORE-RUNTIME-UNQUALIFIED'; throw error; };
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

function regular(path, limit) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('Runtime input is not a bounded regular file');
  return readFileSync(path);
}

function inventory(root) {
  const rows = [], folded = new Set();
  let bytes = 0;
  function visit(dir) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Runtime package directory is aliased');
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules') {
        if (dir !== root || lstatSync(join(dir, name)).isSymbolicLink()) fail('Nested runtime resolution shadow is unsupported');
        continue;
      }
      if (name.includes(':') || name.includes('\\')) fail('Unsafe runtime package path');
      const path = join(dir, name), rel = relative(root, path).replace(/\\/g, '/');
      const key = rel.normalize('NFC').toLowerCase();
      if (folded.has(key)) fail('Ambiguous runtime package path');
      folded.add(key);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) fail('Runtime package symlinks are unsupported');
      if (entry.isDirectory()) { visit(path); continue; }
      if (rows.length >= 20000 || bytes + entry.size > 256 * 1024 * 1024) fail('Runtime package resource limit');
      const data = regular(path, 32 * 1024 * 1024);
      bytes += data.length;
      rows.push({ path: rel, sha256: sha(data), bytes: data.length });
    }
  }
  visit(root);
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { sha256: sha(canonical(rows)), files: rows.length, bytes };
}

// This API must be called before importing native APIs in a fresh worker. A
// digest records the selected Node binary; it is not an OS/code-signing claim.
export async function attestRuntime(cli) {
  try {
    if (!/^v22\.22\.\d+$/.test(process.version)) fail('Runtime requires Node 22.22.x');
    if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.execArgv.some(a => /^-(?:r|C)/.test(a) || /^--(?:require|import|(?:experimental-)?loader|conditions|preserve-symlinks)(?:=|$)/.test(a))) fail('Ambient module injection is not qualified');
    const entry = resolve(cli?.main ?? cli?.argv?.[1] ?? '');
    if (!cli || cli.version !== '3.8.0' || (cli.argv && (cli.argv.length !== 2 || realpathSync(cli.argv[0]) !== realpathSync(process.execPath)))) fail('An exact local CLI 3.8.0 entry is required');
    const cliRoot = dirname(dirname(entry)), modules = dirname(dirname(cliRoot));
    if (entry !== join(cliRoot, 'dist', 'main.js') || cliRoot !== join(modules, '@inventarch', 'cli')) fail('CLI entry is not the qualified package entry');
    const profile = JSON.parse(regular(profilePath, 1024 * 1024));
    if (profile.format !== 'inventarch.runtime-cohort/1' || profile.node !== '22.22.x') fail('Unsupported runtime cohort profile');
    const checked = new Map();
    function resolvePackage(name, from) {
      if (!Object.hasOwn(profile.packages, name)) fail(`Unqualified dependency ${name}`);
      const req = createRequire(from);
      for (const folder of req.resolve.paths(name) ?? []) {
        if (!inside(modules, folder)) continue;
        const candidate = join(folder, ...name.split('/'));
        if (!existsSync(candidate)) continue;
        // Reject each intermediate directory, including node_modules and scopes.
        let current = modules;
        for (const part of relative(modules, candidate).split(/[\\/]/)) {
          if (lstatSync(current).isSymbolicLink()) fail('Runtime resolution traverses a symlink');
          current = join(current, part);
        }
        if (lstatSync(current).isSymbolicLink()) fail('Runtime package is a symlink');
        return candidate;
      }
      fail(`Missing local runtime dependency ${name}`);
    }
    function checkPackage(name, root) {
      if (checked.has(root)) return;
      const pin = profile.packages[name], actual = inventory(root);
      if (!pin || actual.sha256 !== pin.sha256 || actual.files !== pin.files || actual.bytes !== pin.bytes) fail(`Runtime package bytes differ: ${name}`);
      const pkg = JSON.parse(regular(join(root, 'package.json'), 1024 * 1024));
      if (pkg.name !== name || pkg.version !== pin.version || canonical(pkg.dependencies ?? {}) !== canonical(pin.dependencies)) fail(`Runtime metadata differs: ${name}`);
      checked.set(root, { name, ...actual });
      for (const dependency of Object.keys(pin.dependencies)) checkPackage(dependency, resolvePackage(dependency, join(root, 'package.json')));
    }
    if (resolvePackage('@inventarch/cli', entry) !== cliRoot) fail('CLI resolution is shadowed');
    checkPackage('@inventarch/cli', cliRoot);
    if (sha(regular(entry, 32 * 1024 * 1024)) !== profile.cliEntrySha256) fail('CLI entry differs');
    // The CLI carries every published language base; the cohort is qualified with the one the kits lock (the profile's).
    const carried = JSON.parse(regular(join(cliRoot, 'assets', 'bases.json'), 65536));
    const base = Array.isArray(carried) ? carried.find(row => canonical(row) === canonical(profile.language)) : null;
    if (!base) fail('Bundled language differs');
    const identity = {
      format: 'inventarch.runtime-identity/1', profileSha256: sha(canonical(profile)),
      cliVersion: '3.8.0', cliEntrySha256: profile.cliEntrySha256,
      nodeVersion: process.version, nodeBinarySha256: sha(regular(process.execPath, 256 * 1024 * 1024)),
      nativeLanguageVersion: base.version, nativeLanguageArchive: base.archive,
      packages: Object.entries(profile.packages).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, pin]) => ({ name, version: pin.version, sha256: pin.sha256, integrity: pin.integrity })),
    };
    return { identity, async importNative(specifier) {
      if (typeof specifier !== 'string' || !/^@inventarch\/[a-z][a-z0-9-]*(?:\/[a-z0-9/-]+)?$/.test(specifier)) fail('Only qualified native public exports can be imported');
      // Re-resolve every dependency edge as well as rehashing bytes: a newly
      // inserted nested dependency must not bypass the original attestation.
      checked.clear();
      checkPackage('@inventarch/cli', cliRoot);
      const name = specifier.split('/').slice(0, 2).join('/');
      const root = resolvePackage(name, entry);
      checkPackage(name, root);
      let target;
      try { target = createRequire(entry).resolve(specifier); } catch { fail(`Native public export is unavailable: ${specifier}`); }
      if (!inside(root, target) || !checked.has(root)) fail('Native export escaped the qualified package');
      regular(target, 32 * 1024 * 1024);
      return import(pathToFileURL(target).href);
    } };
  } catch (error) {
    if (error.code === 'IA-CORE-RUNTIME-UNQUALIFIED') throw error;
    fail(`Runtime attestation refused: ${error.message}`);
  }
}
