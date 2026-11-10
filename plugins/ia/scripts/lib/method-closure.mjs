// Complete immutable envelopes for explicitly qualified executor profiles.
// Node profiles pin reviewed imports, subprocess selection and exact module
// bytes; an arbitrary inventory never upgrades a program into a profile.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { inspectMethodGraph } from './closure-native.mjs';
import { attestRuntime } from './closure-runtime.mjs';
import { sourcesDigest } from './kit.mjs';
import { runIa } from './cli.mjs';
import { canonicalMethod as canonical, safeMethodPath } from './method-json.mjs';
import { executorFileRoles, executorProfile, qualifyNodeExecutor, validateExecutor, validateExecutorNative } from './closure-executors.mjs';
import { acquireClosureLock } from './closure-lock.mjs';

const FORMAT = 'inventarch.method-closure/1';
const LIMITS = { files: 10000, total: 128 * 1024 * 1024, file: 16 * 1024 * 1024, checks: 256, capabilities: 512 };
const HEX = /^[a-f0-9]{64}$/;
const sha = data => createHash('sha256').update(data).digest('hex');
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = (message, code = 'IA-CORE-CLOSURE-INTEGRITY') => { throw Object.assign(new Error(message), { code }); };
const unsupported = message => fail(message, 'IA-CORE-CLOSURE-UNSUPPORTED');
const store = supplied => resolve(supplied ?? join(homedir(), '.ia', 'method-closures-v1'));

function safe(path) {
  if (!safeMethodPath(path)) fail('Unsafe closure relative path');
  return path;
}
function regularRoot(root) {
  let current = resolve(root);
  for (;;) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Closure directory is aliased or not regular');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function binaryBytes(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.file) fail('Native archive is not a bounded regular file');
  const bytes = readFileSync(path);
  if (bytes.length > LIMITS.file) fail('Native archive exceeded resource bounds');
  return bytes;
}
function textBytes(path, normalize) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.file) fail('Closure file is not bounded regular text');
  const bytes = readFileSync(path);
  if (bytes.length > LIMITS.file) fail('Closure file exceeded resource limit');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('Closure file is not UTF-8'); }
  if (text.includes('\0')) fail('Closure file contains NUL');
  return normalize ? Buffer.from(text.replace(/\r\n?/g, '\n')) : bytes;
}
function capture(root, { normalize = false, excludeRuntime = false, excludeHistory = false } = {}) {
  regularRoot(root);
  const files = [], folded = new Set();
  let total = 0;
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = safe(relative(root, path).replace(/\\/g, '/'));
      if (excludeRuntime && ['.ia/distributions', '.ia/work', '.ia/.iadb'].includes(rel)) continue;
      // A kit's release history is not part of the method it executes.
      if (excludeHistory && (rel === 'releases.json' || rel === 'releases')) continue;
      const key = rel.normalize('NFC').toLowerCase();
      if (folded.has(key)) fail('Closure paths collide after Unicode/case normalization');
      folded.add(key);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail('Closure symlinks are unsupported');
      if (stat.isDirectory()) { visit(path); continue; }
      const data = rel === 'native/language.ia.tgz' ? binaryBytes(path) : textBytes(path, normalize);
      total += data.length;
      if (files.length >= LIMITS.files || total > LIMITS.total) fail('Closure resource bound exceeded');
      files.push({ path: rel, bytes: data.length, sha256: sha(data), data });
    }
  }
  visit(root);
  return files.sort((a, b) => order(a.path, b.path));
}
const inventory = rows => rows.map(({ data, ...row }) => row);
function validateManifest(manifest, digest) {
  if (manifest.format !== FORMAT) unsupported('Unknown method closure format');
  if (!HEX.test(digest) || manifest.closureSha256 !== digest) fail('Closure identity differs');
  const { closureSha256, ...body } = manifest;
  if (sha(canonical(body)) !== closureSha256) fail('Closure envelope digest differs');
  if (!manifest.kit?.id || !manifest.kit.version || !manifest.distributionRoots?.length || !Array.isArray(manifest.packagedWorkspaces) || !Array.isArray(manifest.systems)) fail('Incomplete method closure');
  if (manifest.native?.cliVersion !== '3.6.0' || manifest.native.languageId !== 'inventarch/language' || manifest.native.languageVersion !== '3.2.0') unsupported('Unsupported native cohort');
  for (const value of [manifest.native.languageArchiveSha256, manifest.release?.archiveSha256, manifest.release?.manifestSha256, manifest.release?.sourcesSha256]) if (!HEX.test(value ?? '')) fail('Invalid release digest');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.release.sourceCommit ?? '') || !manifest.release.sourceRepository) fail('Invalid release provenance');
  if (!Array.isArray(manifest.files) || manifest.files.length > LIMITS.files || !Array.isArray(manifest.checks) || manifest.checks.length > LIMITS.checks || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > LIMITS.capabilities) fail('Closure inventory limit or shape refused');
  let total = 0, last = '';
  const folded = new Set();
  for (const file of manifest.files) {
    safe(file.path);
    if (file.path <= last || folded.has(file.path.normalize('NFC').toLowerCase()) || !HEX.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > LIMITS.file || !['source', 'asset', 'sidecar', 'runner', 'helper'].includes(file.role)) fail('Invalid retained file inventory');
    last = file.path;
    folded.add(file.path.normalize('NFC').toLowerCase());
    total += file.bytes;
  }
  if (total > LIMITS.total) fail('Closure total resource limit');
  for (const check of manifest.checks) validateExecutor(check);
}

function verifyPayload(root, manifest) {
  const actual = inventory(capture(root));
  if (canonical(actual) !== canonical(manifest.files.map(({ role, ...row }) => row))) fail('Retained payload differs from closure inventory');
  if (!manifest.files.some(row => row.path === 'native/language.ia.tgz' && row.sha256 === manifest.native.languageArchiveSha256)) fail('Retained offline language archive is missing');
  const kitRoot = join(root, 'kit'), descriptor = JSON.parse(textBytes(join(kitRoot, '.ia/release.json'), false));
  if (descriptor.id !== manifest.kit.id || descriptor.version !== manifest.kit.version || descriptor.source?.repository !== manifest.release.sourceRepository || descriptor.source?.commit !== manifest.release.sourceCommit || sourcesDigest(kitRoot) !== manifest.release.sourcesSha256) fail('Retained sources differ from release provenance');
  const graph = JSON.parse(textBytes(join(root, 'graph.json'), false).toString('utf8'));
  for (const key of ['distributionRoots', 'packagedWorkspaces', 'systems', 'capabilities']) if (canonical(graph[key]) !== canonical(manifest[key])) fail(`Retained native graph differs: ${key}`);
  if (!HEX.test(graph.revision ?? '') || !Array.isArray(graph.records) || !Array.isArray(graph.findings)) fail('Incomplete retained native graph');
  const identities = new Set(), paths = new Set(manifest.files.map(row => row.path));
  for (const record of graph.records) {
    if (typeof record.identity !== 'string' || identities.has(record.identity) || !HEX.test(record.digest ?? '') || !safeMethodPath(record.source?.path) || !paths.has(record.source.path)) fail('Invalid retained native record membership');
    identities.add(record.identity);
  }
  for (const identity of manifest.distributionRoots) if (!identities.has(identity)) fail('Retained native root missing');
  const checks = new Set();
  for (const check of manifest.checks) {
    if (checks.has(check.record) || !graph.records.some(row => row.identity === check.record && row.discriminator === 'check' && row.name === check.id)) fail('Runner/native-check join differs');
    checks.add(check.record);
    validateExecutorNative(check, graph.records.find(row => row.identity === check.record));
    for (const dependency of check.dependencies ?? []) if (!manifest.files.some(row => row.path === dependency.path && row.sha256 === dependency.sha256 && ['runner', 'helper'].includes(row.role))) fail('Runner dependency is not retained');
  }
  for (const capability of manifest.capabilities) if (capability.mode === 'executable') for (const identity of capability.checks) if (!checks.has(identity)) fail('Required executable check has no retained runner');
  return graph;
}

// Integrity-only storage reader. A digest is not native admission. Runtime
// resolution and execution must use loadQualifiedMethodClosure below.
export function loadMethodClosure(digest, { storeRoot } = {}) {
  if (!HEX.test(digest ?? '')) fail('Invalid method closure digest');
  const directory = join(store(storeRoot), digest), path = join(directory, 'manifest.json');
  if (!existsSync(path)) fail('Retained method closure is missing; restore exact content or explicitly rebind', 'IA-CORE-CLOSURE-MISSING');
  regularRoot(directory);
  let manifest;
  try { manifest = JSON.parse(textBytes(path, false).toString('utf8')); } catch (error) { if (error.code) throw error; fail('Invalid closure manifest JSON'); }
  validateManifest(manifest, digest);
  const root = join(directory, 'payload'), graph = verifyPayload(root, manifest);
  return { manifest, root, graph };
}

// Reconstruct semantics from retained source, never self-consistent graph JSON.
// No mutable current kit or producer source participates in this verification.
export async function loadQualifiedMethodClosure(digest, { storeRoot, cli } = {}) {
  const closure = loadMethodClosure(digest, { storeRoot });
  const runtime = await attestRuntime(cli);
  if (canonical(runtime.identity) !== canonical(closure.manifest.runtimeIdentity)) fail('Retained method runtime differs from selected runtime');
  if (closure.manifest.native.languageArchiveSha256 !== runtime.identity.nativeLanguageArchive) fail('Retained language differs from attested runtime cohort');
  const lock = JSON.parse(textBytes(join(closure.root, 'kit/.ia/distributions.lock.json'), false));
  if (lock.packages?.length !== 1 || lock.packages[0].id !== 'inventarch/language' || lock.packages[0].version !== closure.manifest.native.languageVersion || lock.packages[0].archive !== runtime.identity.nativeLanguageArchive) unsupported('Only the exact offline bundled language selection is supported');
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'method-readmission-'));
  try {
    const kitRoot = join(scratch, 'kit');
    for (const file of closure.manifest.files.filter(row => row.path.startsWith('kit/'))) {
      const target = join(scratch, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, textBytes(join(closure.root, file.path), false), { flag: 'wx', mode: 0o600 });
    }
    // Supply only the retained, attested language archive to offline restore.
    const archive = closure.manifest.native.languageArchiveSha256;
    const languageDirectory = join(kitRoot, '.ia/distributions/cache');
    mkdirSync(languageDirectory, { recursive: true });
    writeFileSync(join(languageDirectory, `${archive}.ia.tgz`), binaryBytes(join(closure.root, 'native/language.ia.tgz')), { flag: 'wx', mode: 0o600 });
    const restored = runIa(kitRoot, ['restore', '--offline', '--apply', '--yes'], { cli, timeoutMs: 120000 });
    if (restored.code !== 0) fail('Retained offline native restoration refused');
    const descriptor = JSON.parse(textBytes(join(kitRoot, '.ia/release.json'), false));
    const { packDistribution } = await runtime.importNative('@inventarch/distribution/pack');
    const packed = packDistribution(kitRoot, descriptor);
    if (packed.archiveDigest !== closure.manifest.release.archiveSha256 || packed.manifestDigest !== closure.manifest.release.manifestSha256) fail('Retained native release differs from recorded archive or manifest');
    const workspaceContracts = Object.fromEntries(closure.manifest.packagedWorkspaces.map(row => [row.identity, { workKind: row.workKind, boundaryEvidence: row.boundaryEvidence }]));
    const capabilityContracts = Object.fromEntries(closure.manifest.capabilities.map(row => [row.identity, { mode: row.mode }]));
    const graph = await inspectMethodGraph({ root: kitRoot, descriptor, nativeManifest: packed.manifest, importNative: runtime.importNative, workspaceContracts, capabilityContracts });
    for (const record of graph.records) record.source.path = `kit/${safe(record.source.path)}`;
    for (const capability of graph.capabilities) capability.sourcePath = `kit/${safe(capability.sourcePath)}`;
    if (canonical(graph) !== canonical(closure.graph)) fail('Retained graph differs from admitted native sources');
    const sidecarPath = join(kitRoot, 'checks.json');
    const sidecar = existsSync(sidecarPath) ? JSON.parse(textBytes(sidecarPath, false)) : { format: 1, checks: {} };
    if (sidecar.format !== 1 || canonical(Object.keys(sidecar.checks ?? {}).sort()) !== canonical(closure.manifest.checks.map(row => row.id).sort())) fail('Retained runner inventory differs');
    for (const check of closure.manifest.checks) {
      const runner = sidecar.checks[check.id];
      const expected = check.executable === 'node' ? executorProfile(check.profile) : { argv: ['${IA}', ...check.argv], cwd: check.cwd, arguments: check.argumentSchema };
      if (canonical(runner.argv) !== canonical(expected.argv) || runner.cwd !== expected.cwd || canonical(runner.arguments ?? null) !== canonical(expected.arguments ?? null)) fail('Retained runner differs from qualified invocation');
      validateExecutorNative(check, graph.records.find(row => row.identity === check.record));
    }
    const after = loadMethodClosure(digest, { storeRoot });
    if (canonical(after.manifest) !== canonical(closure.manifest)) fail('Retained closure changed during native readmission');
    return { ...closure, graph };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// Qualification names native records and fixes execution; it cannot create a
// native check or turn a workspace script into immutable kit code.
function qualifyChecks(kitRoot, graph, contracts, payloadRoot) {
  const path = join(kitRoot, 'checks.json');
  const sidecar = existsSync(path) ? JSON.parse(textBytes(path, false).toString('utf8')) : { format: 1, checks: {} };
  if (sidecar.format !== 1 || !sidecar.checks || typeof sidecar.checks !== 'object' || Array.isArray(sidecar.checks)) fail('Invalid checks sidecar');
  const checks = Object.entries(sidecar.checks).map(([name, runner]) => {
    const record = graph.records.find(row => row.discriminator === 'check' && row.name === name);
    if (!record) fail(`Runner has no admitted native check: ${name}`);
    const contract = contracts[record.identity];
    if (!contract) unsupported(`Check lacks explicit executor qualification: ${record.identity}`);
    if (contract.executable === 'node') return qualifyNodeExecutor({ name, record: record.identity, nativeRecord: record, runner, contract, kitRoot, payloadRoot });
    if (contract.executable !== 'native-cli' || runner.argv[0] !== '${IA}' || canonical(runner.argv.slice(1)) !== canonical(contract.argv) || runner.cwd !== 'workspace' || contract.cwd !== runner.cwd || contract.argumentSchema !== null) unsupported(`Check does not match the qualified fixed native validation invocation: ${record.identity}`);
    const timeoutSeconds = contract.timeoutSeconds;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) fail('Check timeout exceeds bounds');
    return { id: name, record: record.identity, executable: 'native-cli', script: null, argv: [...contract.argv], cwd: runner.cwd, timeoutSeconds, argumentSchema: null };
  }).sort((a, b) => order(a.record, b.record));
  for (const identity of Object.keys(contracts)) if (!checks.some(row => row.record === identity)) fail(`Qualification names an undeclared runner: ${identity}`);
  for (const capability of graph.capabilities.filter(row => row.mode === 'executable')) for (const identity of capability.checks) if (!checks.some(row => row.record === identity)) fail(`Required native check has no qualified runner: ${identity}`, 'IA-CORE-CHECK-UNAVAILABLE');
  return checks;
}

export async function createMethodClosure({ kit, cli, workspaceContracts = {}, capabilityContracts = {}, executionContracts = {}, storeRoot, validateBeforePublish }) {
  const runtime = await attestRuntime(cli);
  const source = capture(kit.dir, { normalize: true, excludeRuntime: true, excludeHistory: true });
  const destination = store(storeRoot);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  regularRoot(destination);
  const staging = mkdtempSync(join(destination, '.staging-'));
  let lock;
  try {
    const root = join(staging, 'payload'), kitRoot = join(root, 'kit');
    for (const row of source) {
      const path = join(kitRoot, row.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, row.data, { flag: 'wx', mode: 0o600 });
    }
    const descriptor = JSON.parse(readFileSync(join(kitRoot, '.ia/release.json'), 'utf8'));
    const release = kit.latest;
    if (!release || descriptor.id !== kit.id || descriptor.version !== release.version || release.sources !== sourcesDigest(kitRoot)) fail('Current sources cannot reproduce the declared historical release');
    // Restore exclusively from the exact bundled, attested language archive.
    const languagePath = join(dirname(dirname(resolve(cli.main ?? cli.argv[1]))), 'assets', 'base', `${runtime.identity.nativeLanguageArchive}.ia.tgz`);
    const languageBytes = binaryBytes(languagePath);
    if (sha(languageBytes) !== runtime.identity.nativeLanguageArchive) fail('Bundled language archive differs');
    const lockData = JSON.parse(readFileSync(join(kitRoot, '.ia/distributions.lock.json'), 'utf8'));
    if (lockData.packages?.length !== 1 || lockData.packages[0].id !== 'inventarch/language' || lockData.packages[0].archive !== runtime.identity.nativeLanguageArchive) unsupported('Only the exact offline bundled language selection is supported');
    const restored = runIa(kitRoot, ['restore', '--offline', '--apply', '--yes'], { cli, timeoutMs: 120000 });
    if (restored.code !== 0) fail('Offline native restoration refused');
    const readable = kitRoot;
    const { packDistribution } = await runtime.importNative('@inventarch/distribution/pack');
    const packed = packDistribution(readable, descriptor);
    if (packed.archiveDigest !== release.archive || packed.manifestDigest !== release.manifest) fail('Native archive or manifest differs from the recorded release');
    const graph = await inspectMethodGraph({ root: readable, descriptor, nativeManifest: packed.manifest, importNative: runtime.importNative, workspaceContracts, capabilityContracts });
    // Keep the original plugin-relative layout for reviewed runners importing
    // helpers outside their kit. Native graph source references stay under kit/.
    if (Object.values(executionContracts).some(row => row.executable === 'node')) {
      const kitName = descriptor.id.split('/').at(-1).replace(/-kit$/, '');
      if (!/^[a-z0-9-]+$/.test(kitName)) fail('Unsafe execution kit name');
      for (const row of source) {
        const path = join(root, 'plugin', 'config', 'kits', kitName, row.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, row.data, { flag: 'wx', mode: 0o600 });
      }
    }
    const checks = qualifyChecks(kitRoot, graph, executionContracts, root);
    for (const record of graph.records) record.source.path = `kit/${safe(record.source.path)}`;
    for (const capability of graph.capabilities) capability.sourcePath = `kit/${safe(capability.sourcePath)}`;
    // Remove only generated runtime directories inside this invocation's staging root.
    for (const name of ['distributions', 'work', '.iadb']) {
      const generated = join(kitRoot, '.ia', name);
      if (existsSync(generated)) rmSync(generated, { recursive: true, force: true });
    }
    mkdirSync(join(root, 'native'), { recursive: true });
    writeFileSync(join(root, 'native/language.ia.tgz'), languageBytes, { flag: 'wx', mode: 0o600 });
    const graphBytes = Buffer.from(canonical(graph) + '\n');
    if (graphBytes.length > LIMITS.file) fail('Native graph exceeds retained file limit');
    writeFileSync(join(root, 'graph.json'), graphBytes, { flag: 'wx', mode: 0o600 });
    const pluginManifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../.claude-plugin/plugin.json', import.meta.url)), 'utf8'));
    const roles = executorFileRoles(checks);
    const files = inventory(capture(root)).map(row => ({ ...row, role: roles.get(row.path) ?? (row.path.startsWith('kit/.ia/src/') ? 'source' : row.path.endsWith('.json') && row.path !== 'graph.json' ? 'sidecar' : 'asset') }));
    const body = {
      format: FORMAT, kit: { id: descriptor.id, version: descriptor.version }, plugin: { id: pluginManifest.name, version: pluginManifest.version },
      distributionRoots: graph.distributionRoots, packagedWorkspaces: graph.packagedWorkspaces, systems: graph.systems,
      release: { archiveSha256: packed.archiveDigest, manifestSha256: packed.manifestDigest, sourcesSha256: release.sources, sourceRepository: descriptor.source?.repository, sourceCommit: descriptor.source?.commit },
      native: { cliVersion: '3.6.0', languageId: 'inventarch/language', languageVersion: '3.2.0', languageArchiveSha256: runtime.identity.nativeLanguageArchive },
      runtimeIdentity: runtime.identity, files, checks, capabilities: graph.capabilities,
    };
    const digest = sha(canonical(body)), manifest = { ...body, closureSha256: digest };
    validateManifest(manifest, digest);
    writeFileSync(join(staging, 'manifest.json'), canonical(manifest) + '\n', { flag: 'wx', mode: 0o600 });
    if (canonical(inventory(capture(kit.dir, { normalize: true, excludeRuntime: true, excludeHistory: true }))) !== canonical(inventory(source))) fail('Method sources changed during closure construction');
    // Validate the staged payload with the same checks used for every later read.
    verifyPayload(root, manifest);
    if (validateBeforePublish !== undefined) {
      if (typeof validateBeforePublish !== 'function') fail('Invalid publication validation callback');
      await validateBeforePublish({ manifest, root, graph });
      validateManifest(manifest, digest);
      verifyPayload(root, manifest);
    }
    const target = join(destination, digest);
    if (existsSync(target)) return loadMethodClosure(digest, { storeRoot: destination });
    lock = acquireClosureLock(join(destination, `${digest}.lock`), { stagingPaths: [staging] });
    if (existsSync(target)) return loadMethodClosure(digest, { storeRoot: destination });
    renameSync(staging, target);
    return loadMethodClosure(digest, { storeRoot: destination });
  } finally {
    lock?.release();
    // staging was created by this invocation beneath the explicitly resolved store.
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
