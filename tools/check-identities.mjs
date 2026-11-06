#!/usr/bin/env node
// Publisher maintainer tool. All input is inert; registry acceptance is external.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE = 4 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const EXTENSIONS = new Set(['.md', '.txt', '.ia', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.yml', '.yaml', '.html', '.css', '.svg']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = value => value.normalize('NFC').toLowerCase().normalize('NFC').replaceAll('\\', '/');
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const text = value => typeof value === 'string' && value.trim().length > 0;
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const REFUSALS = new Set(['PAYLOAD_MANIFEST', 'PAYLOAD_ALIAS', 'PAYLOAD_COVERAGE', 'PAYLOAD_DRIFT', 'IDENTITY_MATCH']);
class ScreeningError extends Error {
  constructor(code) { super(code); this.status = REFUSALS.has(code) ? 'refused' : 'not-evaluated'; this.code = code; }
}
const unavailable = code => { throw new ScreeningError(code); };
const refuse = unavailable;
function contained(parent, child) {
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const rel = relative(fold(parent), fold(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !/^(?:[A-Za-z]:|[/\\])/.test(rel));
}
function sameFile(a, b) {
  return ['dev', 'ino', 'size', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]) && b.isFile() && !b.isSymbolicLink();
}
function readStable(path, before, code) {
  try {
    const bytes = readFileSync(path), after = lstatSync(path);
    if (!sameFile(before, after)) refuse(code);
    return bytes;
  } catch (error) {
    if (error instanceof ScreeningError) throw error;
    unavailable(code === 'PAYLOAD_DRIFT' ? 'PAYLOAD_UNAVAILABLE' : 'INPUT_UNAVAILABLE');
  }
}
function boundedJson(source) {
  let depth = 0, quoted = false, escaped = false;
  for (const char of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') { if (++depth > 64) throw new Error('depth'); }
    else if (char === ']' || char === '}') depth--;
  }
  return JSON.parse(source);
}
function externalDocument(path, roots) {
  if (!text(path)) unavailable('INPUT_UNAVAILABLE');
  try {
    const stat = lstatSync(path), actual = realpathSync.native(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || roots.some(root => contained(root, actual))) unavailable('INPUT_CUSTODY');
    return { path, stat };
  } catch (error) {
    if (error instanceof ScreeningError) throw error;
    unavailable('INPUT_UNAVAILABLE');
  }
}
function pinnedDocument(input, pin, kind) {
  if (!HASH.test(pin ?? '')) unavailable('INPUT_PIN');
  if (input.stat.size > MAX_FILE) unavailable(kind + '_LIMIT');
  const bytes = readStable(input.path, input.stat, 'INPUT_UNAVAILABLE');
  if (sha(bytes) !== pin) unavailable('INPUT_PIN');
  try {
    const source = decode(bytes), value = boundedJson(source);
    if (JSON.stringify(value, null, 2) + '\n' !== source.replace(/\r\n/g, '\n')) throw new Error('representation');
    return value;
  } catch { unavailable(kind + '_INVALID'); }
}
function portable(path) {
  if (!text(path) || path.length > 2048 || /[\\:<>"|?*\p{Cc}\p{Cf}]/u.test(path)) return false;
  const segments = path.split('/');
  return segments.length <= 64 && segments.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}
function jsonStrings(source) {
  const strings = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '"') continue;
    const start = i++;
    for (; i < source.length; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === '"') break;
    }
    strings.push(normalize(JSON.parse(source.slice(start, i + 1))));
  }
  return strings;
}

export function screenPublication(options) {
  const result = { status: 'not-evaluated', code: 'ROOT_INVALID', manifestSha256: null, registrySha256: null, coverage: { files: 0, bytes: 0 }, findings: [] };
  try {
    if (!options || !text(options.root) || !text(options.publicRoot)) unavailable('ROOT_INVALID');
    let root, publicRoot;
    try {
      if (!lstatSync(options.root).isDirectory() || lstatSync(options.root).isSymbolicLink() || !lstatSync(options.publicRoot).isDirectory()) unavailable('ROOT_INVALID');
      root = realpathSync.native(options.root); publicRoot = realpathSync.native(options.publicRoot);
    } catch { unavailable('ROOT_INVALID'); }
    // Check both external locations before loading either document.
    const registryInput = externalDocument(options.registryPath, [root, publicRoot]);
    const manifestInput = externalDocument(options.manifestPath, [root, publicRoot]);
    const registry = pinnedDocument(registryInput, options.registrySha256, 'REGISTRY');
    if (!keys(registry, ['format', 'scope', 'entries']) || registry.format !== 1 || !text(registry.scope) || !Array.isArray(registry.entries) || registry.entries.length < 1 || registry.entries.length > 256) unavailable('REGISTRY_INVALID');
    const ids = new Set(), values = new Set();
    for (const entry of registry.entries) {
      if (!keys(entry, ['id', 'value']) || !text(entry.id) || !text(entry.value)) unavailable('REGISTRY_INVALID');
      const value = normalize(entry.value), count = [...value].length;
      if (count < 4 || count > 1024 || ids.has(entry.id) || values.has(value)) unavailable('REGISTRY_INVALID');
      ids.add(entry.id); values.add(value);
    }
    result.registrySha256 = options.registrySha256;
    const manifest = pinnedDocument(manifestInput, options.manifestSha256, 'MANIFEST');
    if (!keys(manifest, ['format', 'scope', 'files']) || manifest.format !== 1 || !text(manifest.scope) || !Array.isArray(manifest.files) || manifest.files.length < 1) unavailable('MANIFEST_INVALID');
    result.manifestSha256 = options.manifestSha256;
    if (manifest.scope !== registry.scope) unavailable('INPUT_SCOPE');
    if (manifest.files.length > 1024) unavailable('PAYLOAD_LIMIT');
    const paths = new Set(); let declaredBytes = 0;
    for (const file of manifest.files) {
      if (!keys(file, ['path', 'sha256', 'bytes', 'mediaType']) || typeof file.path !== 'string' || typeof file.mediaType !== 'string' || !HASH.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0) unavailable('MANIFEST_INVALID');
    }
    for (const file of manifest.files) {
      if (!portable(file.path) || paths.has(normalize(file.path)) || !['text', 'json'].includes(file.mediaType) || (extname(file.path).toLowerCase() === '.json' && file.mediaType !== 'json')) refuse('PAYLOAD_MANIFEST');
      paths.add(normalize(file.path)); declaredBytes += file.bytes;
      if (file.bytes > MAX_FILE || declaredBytes > MAX_TOTAL) unavailable('PAYLOAD_LIMIT');
    }
    const observed = [], directories = [], pending = [''];
    while (pending.length) {
      const dir = pending.pop();
      let children;
      try { children = readdirSync(join(root, dir)).sort(); } catch { unavailable('PAYLOAD_UNAVAILABLE'); }
      for (const child of children) {
        const path = dir ? `${dir}/${child}` : child;
        if (!portable(path)) refuse('PAYLOAD_MANIFEST');
        let stat;
        try { stat = lstatSync(join(root, path)); } catch { unavailable('PAYLOAD_UNAVAILABLE'); }
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) refuse('PAYLOAD_ALIAS');
        if (stat.isDirectory()) {
          directories.push(path); pending.push(path);
          if (directories.length > 1024) unavailable('PAYLOAD_LIMIT');
        } else if (stat.isFile()) {
          observed.push(path); if (observed.length > 1024) unavailable('PAYLOAD_LIMIT');
        } else unavailable('PAYLOAD_FORMAT');
      }
    }
    const expected = manifest.files.map(file => file.path).sort();
    if (JSON.stringify(observed.sort()) !== JSON.stringify(expected) || directories.some(dir => !expected.some(path => path.startsWith(dir + '/')))) refuse('PAYLOAD_COVERAGE');
    const findings = [];
    const entries = registry.entries.map(entry => ({ ...entry, normalized: normalize(entry.value) }));
    for (const file of [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      const path = join(root, file.path); let before;
      try { before = lstatSync(path); } catch { unavailable('PAYLOAD_UNAVAILABLE'); }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) refuse('PAYLOAD_ALIAS');
      if (before.size !== file.bytes) refuse('PAYLOAD_DRIFT');
      const bytes = readStable(path, before, 'PAYLOAD_DRIFT');
      if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) refuse('PAYLOAD_DRIFT');
      if (!EXTENSIONS.has(extname(file.path).toLowerCase())) unavailable('PAYLOAD_FORMAT');
      let source, strings = [];
      try {
        source = decode(bytes); if (source.includes('\0')) throw new Error('NUL');
        if (file.mediaType === 'json') {
          boundedJson(source);
          // Inspect every lexical string, including values overwritten by duplicate keys.
          strings = jsonStrings(source);
        }
      } catch { unavailable('PAYLOAD_FORMAT'); }
      result.coverage.files++; result.coverage.bytes += bytes.length;
      const normalizedPath = normalize(file.path), normalizedSource = normalize(source);
      for (const entry of entries) {
        const surfaces = [];
        if (normalizedPath.includes(entry.normalized)) surfaces.push('path');
        if (normalizedSource.includes(entry.normalized)) surfaces.push('text');
        if (strings.some(value => value.includes(entry.normalized))) surfaces.push('json-string');
        for (const surface of surfaces) {
          findings.push({ entryId: entry.id, value: entry.value, path: file.path, surface });
          if (findings.length > 4096) unavailable('PAYLOAD_LIMIT');
        }
      }
    }
    result.findings = findings;
    result.status = findings.length ? 'refused' : 'passed';
    result.code = findings.length ? 'IDENTITY_MATCH' : 'CLEAN';
    return result;
  } catch (error) {
    result.status = error instanceof ScreeningError ? error.status : 'not-evaluated';
    result.code = error instanceof ScreeningError ? error.code : 'INTERNAL_ERROR';
    result.findings = [];
    return result;
  }
}

const FLAGS = { '--root': 'root', '--public-root': 'publicRoot', '--registry': 'registryPath', '--registry-sha256': 'registrySha256', '--manifest': 'manifestPath', '--manifest-sha256': 'manifestSha256' };
export function main(argv, out = value => process.stdout.write(value), err = value => process.stderr.write(value)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = Object.hasOwn(FLAGS, argv[i]) ? FLAGS[argv[i]] : undefined;
    if (!key || Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      err('usage: check-identities --root <snapshot> --public-root <checkout> --registry <file> --registry-sha256 <hash> --manifest <file> --manifest-sha256 <hash>\n'); return 2;
    }
    options[key] = argv[i + 1];
  }
  if (Object.keys(options).length !== Object.keys(FLAGS).length) {
    err('usage: check-identities --root <snapshot> --public-root <checkout> --registry <file> --registry-sha256 <hash> --manifest <file> --manifest-sha256 <hash>\n'); return 2;
  }
  const result = screenPublication(options);
  out(JSON.stringify({ status: result.status, code: result.code, coverage: result.coverage, manifestSha256: result.manifestSha256 }) + '\n');
  return result.status === 'passed' ? 0 : result.status === 'refused' ? 1 : 2;
}
function isMain() {
  if (!process.argv[1] || process.argv[1] === '-') return false;
  try {
    const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
    return fold(realpathSync.native(resolve(process.argv[1]))) === fold(realpathSync.native(fileURLToPath(import.meta.url)));
  } catch { return false; }
}
if (isMain()) process.exitCode = main(process.argv.slice(2));
