#!/usr/bin/env node
// Apache-2.0
// Public-kit punt envelope validator, resolver and verifier.
//   node scripts/punt.mjs validate --envelope <file>
//   node scripts/punt.mjs resolve  --envelope <file> [--root <repo>] [--project <p> --task <t> [--run <r>]] [--pin|--no-pin] [--rebind] [--cli <main.js>]
//   node scripts/punt.mjs verify   --envelope <file> [--root <repo>] [--receipts <file>] [--out <file>] [--run-kit-checks] [--cli <main.js>] [--project <p> --task <t>]
//
// Validates PublicPuntEnvelopeV1 payloads against the allowlist of public kit
// ids, enforces single-hash subjectSha256 parity with subjectLabel, resolves
// through scripts/resolve.mjs with fallbackUnbound to
// inventarch/ia-method-kit#method-operate on IA-CORE-NO-WORKSPACE or
// IA-CORE-NO-METHOD, runs shell-free repoVerificationCommands under an
// allowlisted environment, verifies declaredKitChecks receipts and emits
// WitnessedPuntReceiptV1 JSON.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWindowsPackageManager } from './lib/cli.mjs';
import { childEnv } from './lib/hygiene.mjs';
import { parseArgs, printJson, refuse, UsageError } from './lib/workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVE_SCRIPT = join(HERE, 'resolve.mjs');
const CHECK_SCRIPT = join(HERE, 'check.mjs');

export const PUBLIC_PUNT_FORMAT = 'public-punt-envelope-1';
export const WITNESSED_RECEIPT_FORMAT = 'witnessed-punt-receipt-1';

export const PUBLIC_KIT_IDS = Object.freeze(new Set([
  'inventarch/ia-method-kit',
  'inventarch/ia-kb-kit',
  'inventarch/ia-authoring-kit',
  'inventarch/ia-approval-kit',
  'inventarch/ia-repo-kit',
  'inventarch/ia-slack-base-kit',
  'inventarch/ia-design-base-kit',
  'inventarch/ia-product-base-kit',
]));

export const DEFAULT_FALLBACK_UNBOUND = Object.freeze({
  kit: 'inventarch/ia-method-kit',
  capability: 'method-operate',
});

const ENTRIES = new Set(['work', 'delivery', 'knowledge']);
const CHECK_NAME = /^[a-z0-9][a-z0-9-]*$/;
const KIT_REF_PATTERN = /\b[a-z0-9-]+\/ia-[a-z0-9-]+-kit\b/gi;
const FALLBACK_ERROR_CODES = new Set(['IA-CORE-NO-WORKSPACE', 'IA-CORE-NO-METHOD']);
const DEFAULT_CMD_TIMEOUT_SECONDS = 300;
const MAX_CMD_TIMEOUT_SECONDS = 3600;
const MAX_BUFFER = 8 * 1024 * 1024;

export class PuntError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export function sha256Prefixed(text) {
  return `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

export function computeSubjectSha256(subjectLabel) {
  if (typeof subjectLabel !== 'string' || !subjectLabel.trim()) {
    throw new PuntError('subjectLabel must be a non-empty string', 'IA-PUNT-INVALID-ENVELOPE');
  }
  return sha256Prefixed(subjectLabel);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertPublicKitId(kitId, fieldName) {
  if (typeof kitId !== 'string' || !kitId.trim()) {
    throw new PuntError(`${fieldName} must be a non-empty kit id string`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (!PUBLIC_KIT_IDS.has(kitId)) {
    throw new PuntError(`${fieldName} names non-public kit ${kitId}; only allowlisted public kits are admitted`, 'IA-PUNT-CUSTODY-LEAK');
  }
}

function assertRelativeSubpath(subpath, fieldName) {
  if (typeof subpath !== 'string' || !subpath.trim()) {
    throw new PuntError(`${fieldName} must be a non-empty relative path`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (isAbsolute(subpath) || /^[a-zA-Z]:[\\/]/.test(subpath)) {
    throw new PuntError(`${fieldName} must not be an absolute path: ${subpath}`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  const segments = subpath.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new PuntError(`${fieldName} must not traverse above root: ${subpath}`, 'IA-PUNT-INVALID-ENVELOPE');
  }
}

function normalizeVerificationCommand(item, index) {
  if (Array.isArray(item)) {
    if (!item.length || !item.every(a => typeof a === 'string' && a.length > 0)) {
      throw new PuntError(`repoVerificationCommands[${index}] must be a non-empty string argv array`, 'IA-PUNT-INVALID-ENVELOPE');
    }
    return { name: `command-${index + 1}`, argv: [...item], cwd: null, timeoutSeconds: DEFAULT_CMD_TIMEOUT_SECONDS };
  }
  if (isPlainObject(item)) {
    if (!Array.isArray(item.argv) || !item.argv.length || !item.argv.every(a => typeof a === 'string' && a.length > 0)) {
      throw new PuntError(`repoVerificationCommands[${index}].argv must be a non-empty string array`, 'IA-PUNT-INVALID-ENVELOPE');
    }
    if (item.cwd !== undefined && item.cwd !== null) {
      assertRelativeSubpath(item.cwd, `repoVerificationCommands[${index}].cwd`);
    }
    let timeoutSeconds = DEFAULT_CMD_TIMEOUT_SECONDS;
    if (item.timeoutSeconds !== undefined) {
      if (!Number.isInteger(item.timeoutSeconds) || item.timeoutSeconds < 1 || item.timeoutSeconds > MAX_CMD_TIMEOUT_SECONDS) {
        throw new PuntError(`repoVerificationCommands[${index}].timeoutSeconds must be an integer between 1 and ${MAX_CMD_TIMEOUT_SECONDS}`, 'IA-PUNT-INVALID-ENVELOPE');
      }
      timeoutSeconds = item.timeoutSeconds;
    }
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `command-${index + 1}`;
    return { name, argv: [...item.argv], cwd: item.cwd ?? null, timeoutSeconds };
  }
  throw new PuntError(`repoVerificationCommands[${index}] must be an argv array or { argv } object`, 'IA-PUNT-INVALID-ENVELOPE');
}

export function validatePublicPuntEnvelope(raw) {
  if (!isPlainObject(raw)) {
    throw new PuntError('PublicPuntEnvelopeV1 must be a JSON object', 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (raw.format !== PUBLIC_PUNT_FORMAT) {
    throw new PuntError(`envelope.format must be "${PUBLIC_PUNT_FORMAT}"`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (typeof raw.envelopeId !== 'string' || !raw.envelopeId.trim()) {
    throw new PuntError('envelope.envelopeId must be a non-empty string', 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (!ENTRIES.has(raw.entry)) {
    throw new PuntError(`envelope.entry must be one of work, delivery, knowledge`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (typeof raw.activity !== 'string' || !raw.activity.trim()) {
    throw new PuntError('envelope.activity must be a non-empty string', 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (typeof raw.subjectLabel !== 'string' || !raw.subjectLabel.trim()) {
    throw new PuntError('envelope.subjectLabel must be a non-empty string', 'IA-PUNT-INVALID-ENVELOPE');
  }
  const expectedSha = computeSubjectSha256(raw.subjectLabel);
  if (raw.subjectSha256 !== expectedSha) {
    throw new PuntError(`envelope.subjectSha256 does not match sha256(subjectLabel): expected ${expectedSha}`, 'IA-PUNT-SUBJECT-MISMATCH');
  }

  // Enforce public-kit allowlist on explicit kit fields.
  if (raw.kit !== undefined && raw.kit !== null) {
    assertPublicKitId(raw.kit, 'envelope.kit');
  }
  if (Array.isArray(raw.kits)) {
    for (let i = 0; i < raw.kits.length; i++) {
      assertPublicKitId(raw.kits[i], `envelope.kits[${i}]`);
    }
  }

  let fallbackUnbound = { ...DEFAULT_FALLBACK_UNBOUND };
  if (raw.fallbackUnbound !== undefined && raw.fallbackUnbound !== null) {
    if (!isPlainObject(raw.fallbackUnbound)) {
      throw new PuntError('envelope.fallbackUnbound must be an object', 'IA-PUNT-INVALID-ENVELOPE');
    }
    assertPublicKitId(raw.fallbackUnbound.kit, 'envelope.fallbackUnbound.kit');
    if (typeof raw.fallbackUnbound.capability !== 'string' || !raw.fallbackUnbound.capability.trim()) {
      throw new PuntError('envelope.fallbackUnbound.capability must be a non-empty string', 'IA-PUNT-INVALID-ENVELOPE');
    }
    fallbackUnbound = {
      kit: raw.fallbackUnbound.kit,
      capability: raw.fallbackUnbound.capability.trim(),
      ...(typeof raw.fallbackUnbound.profile === 'string' && raw.fallbackUnbound.profile.trim()
        ? { profile: raw.fallbackUnbound.profile.trim() }
        : {}),
    };
  }

  // Scan the entire serialized envelope for any non-public ia-*-kit reference.
  const serialized = JSON.stringify(raw);
  const matches = serialized.match(KIT_REF_PATTERN) ?? [];
  for (const match of matches) {
    if (!PUBLIC_KIT_IDS.has(match.toLowerCase())) {
      throw new PuntError(`envelope references non-public kit id ${match}`, 'IA-PUNT-CUSTODY-LEAK');
    }
  }

  // Validate declaredKitChecks.
  const declaredKitChecks = [];
  if (raw.declaredKitChecks !== undefined) {
    if (!Array.isArray(raw.declaredKitChecks)) {
      throw new PuntError('envelope.declaredKitChecks must be an array of check names', 'IA-PUNT-INVALID-ENVELOPE');
    }
    for (let i = 0; i < raw.declaredKitChecks.length; i++) {
      const checkName = raw.declaredKitChecks[i];
      if (typeof checkName !== 'string' || !CHECK_NAME.test(checkName)) {
        throw new PuntError(`envelope.declaredKitChecks[${i}] must match ${CHECK_NAME}`, 'IA-PUNT-INVALID-ENVELOPE');
      }
      declaredKitChecks.push(checkName);
    }
  }

  // Validate repoVerificationCommands.
  const repoVerificationCommands = [];
  if (raw.repoVerificationCommands !== undefined) {
    if (!Array.isArray(raw.repoVerificationCommands)) {
      throw new PuntError('envelope.repoVerificationCommands must be an array', 'IA-PUNT-INVALID-ENVELOPE');
    }
    for (let i = 0; i < raw.repoVerificationCommands.length; i++) {
      repoVerificationCommands.push(normalizeVerificationCommand(raw.repoVerificationCommands[i], i));
    }
  }

  if (raw.writePaths !== undefined) {
    if (!Array.isArray(raw.writePaths)) {
      throw new PuntError('envelope.writePaths must be an array of relative paths', 'IA-PUNT-INVALID-ENVELOPE');
    }
    for (let i = 0; i < raw.writePaths.length; i++) {
      assertRelativeSubpath(raw.writePaths[i], `envelope.writePaths[${i}]`);
    }
  }

  return {
    format: raw.format,
    envelopeId: raw.envelopeId.trim(),
    entry: raw.entry,
    activity: raw.activity.trim(),
    subjectLabel: raw.subjectLabel,
    subjectSha256: expectedSha,
    kit: raw.kit ?? null,
    capability: typeof raw.capability === 'string' && raw.capability.trim() ? raw.capability.trim() : null,
    profile: typeof raw.profile === 'string' && raw.profile.trim() ? raw.profile.trim() : null,
    seat: typeof raw.seat === 'string' && raw.seat.trim() ? raw.seat.trim() : null,
    shape: typeof raw.shape === 'string' && raw.shape.trim() ? raw.shape.trim() : null,
    phase: typeof raw.phase === 'string' && raw.phase.trim() ? raw.phase.trim() : null,
    fallbackUnbound,
    declaredKitChecks,
    repoVerificationCommands,
  };
}

function readJsonFile(filePath, label) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    throw new UsageError(`${label} could not be read (${filePath}): ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new UsageError(`${label} must be a regular non-symlink file: ${filePath}`);
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new PuntError(`${label} is not valid JSON: ${error.message}`, 'IA-PUNT-INVALID-JSON');
  }
}

function invokeResolve(args, env) {
  const ran = spawnSync(process.execPath, [RESOLVE_SCRIPT, ...args], {
    env,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
  });
  if (ran.error) {
    throw new PuntError(`resolve.mjs failed to start: ${ran.error.message}`, 'IA-PUNT-RESOLVE-FAILED');
  }
  let parsed = null;
  if (ran.stdout && ran.stdout.trim()) {
    try {
      parsed = JSON.parse(ran.stdout);
    } catch {
      parsed = null;
    }
  }
  return { status: ran.status ?? 1, parsed, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
}

export function resolvePuntEnvelope(envelope, options = {}) {
  const validated = validatePublicPuntEnvelope(envelope);
  const rootDir = resolve(options.root ?? process.cwd());
  const env = childEnv(process.env);

  const baseArgs = [
    '--entry', validated.entry,
    '--activity', validated.activity,
    '--subject', validated.subjectSha256,
    '--root', rootDir,
  ];
  if (validated.seat) baseArgs.push('--seat', validated.seat);
  if (validated.shape) baseArgs.push('--shape', validated.shape);
  if (validated.phase) baseArgs.push('--phase', validated.phase);
  if (options.project) baseArgs.push('--project', options.project);
  if (options.task) baseArgs.push('--task', options.task);
  if (options.run) baseArgs.push('--run', options.run);
  if (options.pin) baseArgs.push('--pin');
  if (options['no-pin']) baseArgs.push('--no-pin');
  if (options.rebind) baseArgs.push('--rebind');
  if (options.cli) baseArgs.push('--cli', options.cli);

  const primary = invokeResolve(baseArgs, env);
  if (primary.status === 0 && primary.parsed) {
    return {
      ok: true,
      mode: 'bound',
      envelopeId: validated.envelopeId,
      subjectLabel: validated.subjectLabel,
      subjectSha256: validated.subjectSha256,
      packet: primary.parsed,
    };
  }

  const errorCode = primary.parsed?.error?.code ?? null;
  if (!FALLBACK_ERROR_CODES.has(errorCode)) {
    const message = primary.parsed?.error?.message ?? (primary.stderr.trim() || `resolve.mjs exited ${primary.status}`);
    throw new PuntError(message, errorCode ?? 'IA-PUNT-RESOLVE-FAILED');
  }

  // Fallback to fallbackUnbound outside any IA workspace so resolve.mjs
  // accepts --kit and --capability even when the target repo is an IA
  // workspace that lacks a binding for this key (IA-CORE-NO-METHOD).
  const scratchRoot = mkdtempSync(join(tmpdir(), 'ia-punt-unbound-'));
  try {
    const fallbackArgs = [
      '--entry', validated.entry,
      '--activity', validated.activity,
      '--subject', validated.subjectSha256,
      '--root', scratchRoot,
      '--kit', validated.fallbackUnbound.kit,
      '--capability', validated.fallbackUnbound.capability,
    ];
    if (validated.fallbackUnbound.profile) fallbackArgs.push('--profile', validated.fallbackUnbound.profile);
    if (validated.shape) fallbackArgs.push('--shape', validated.shape);
    if (validated.phase) fallbackArgs.push('--phase', validated.phase);
    if (options.cli) fallbackArgs.push('--cli', options.cli);

    const fallback = invokeResolve(fallbackArgs, env);
    if (fallback.status !== 0 || !fallback.parsed) {
      const message = fallback.parsed?.error?.message ?? (fallback.stderr.trim() || `fallback resolve.mjs exited ${fallback.status}`);
      throw new PuntError(`fallbackUnbound failed: ${message}`, fallback.parsed?.error?.code ?? 'IA-PUNT-FALLBACK-FAILED');
    }
    return {
      ok: true,
      mode: 'fallback-unbound',
      fallbackReason: errorCode,
      fallback: validated.fallbackUnbound,
      envelopeId: validated.envelopeId,
      subjectLabel: validated.subjectLabel,
      subjectSha256: validated.subjectSha256,
      packet: fallback.parsed,
    };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

export function runRepoVerificationCommands(commands, rootDir) {
  const canonicalRoot = realpathSync.native(resolve(rootDir));
  const env = childEnv(process.env);
  const results = [];

  for (const cmd of commands) {
    const targetCwd = cmd.cwd ? resolve(canonicalRoot, cmd.cwd) : canonicalRoot;
    const rel = relative(canonicalRoot, targetCwd);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new PuntError(`command ${cmd.name} cwd escapes root: ${cmd.cwd}`, 'IA-PUNT-INVALID-ENVELOPE');
    }
    const resolvedArgv = resolveWindowsPackageManager(cmd.argv, { platform: process.platform, env, execPath: process.execPath });
    const started = Date.now();
    const ran = spawnSync(resolvedArgv[0], resolvedArgv.slice(1), {
      cwd: targetCwd,
      env,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: cmd.timeoutSeconds * 1000,
      maxBuffer: MAX_BUFFER,
    });
    const durationMs = Date.now() - started;
    const timedOut = Boolean(ran.error && ran.error.code === 'ETIMEDOUT');
    const spawnError = ran.error && !timedOut ? ran.error.message : null;
    const stdout = ran.stdout ?? '';
    const stderr = ran.stderr ?? '';
    const exitCode = ran.status;
    const ok = exitCode === 0 && !timedOut && !spawnError;
    results.push({
      name: cmd.name,
      argv: cmd.argv,
      cwd: cmd.cwd ?? '.',
      exitCode,
      timedOut,
      spawnError,
      ok,
      durationMs,
      stdoutSha256: sha256Prefixed(stdout),
      stderrSha256: sha256Prefixed(stderr),
    });
  }
  return results;
}

function indexReceipts(rawReceipts) {
  const byName = new Map();
  if (Array.isArray(rawReceipts)) {
    for (const item of rawReceipts) {
      if (isPlainObject(item) && typeof item.check === 'string') {
        byName.set(item.check, item);
      }
    }
    return byName;
  }
  if (isPlainObject(rawReceipts)) {
    if (Array.isArray(rawReceipts.checks)) {
      return indexReceipts(rawReceipts.checks);
    }
    for (const [key, value] of Object.entries(rawReceipts)) {
      if (isPlainObject(value)) {
        byName.set(typeof value.check === 'string' ? value.check : key, value);
      }
    }
  }
  return byName;
}

function runDeclaredKitCheck(checkName, rootDir, options = {}) {
  const env = childEnv(process.env);
  const args = [CHECK_SCRIPT, checkName, '--root', resolve(rootDir)];
  if (options.cli) args.push('--cli', options.cli);
  if (options.project) args.push('--project', options.project);
  if (options.task) args.push('--task', options.task);
  const ran = spawnSync(process.execPath, args, {
    env,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  let parsed = null;
  if (ran.stdout && ran.stdout.trim()) {
    try {
      parsed = JSON.parse(ran.stdout);
    } catch {
      parsed = null;
    }
  }
  return { status: ran.status ?? 3, parsed };
}

export function verifyDeclaredKitChecks(declaredKitChecks, { receipts = null, runKitChecks = false, rootDir = process.cwd(), cli = null, project = null, task = null } = {}) {
  const indexed = receipts ? indexReceipts(receipts) : new Map();
  const results = [];

  for (const checkName of declaredKitChecks) {
    let receipt = indexed.get(checkName) ?? null;
    if (!receipt && runKitChecks) {
      const ran = runDeclaredKitCheck(checkName, rootDir, { cli, project, task });
      receipt = ran.parsed;
    }
    if (!receipt || !isPlainObject(receipt)) {
      results.push({ check: checkName, status: 'missing', ok: false, exitCode: null, complete: false, kit: null });
      continue;
    }
    const exitCode = typeof receipt.exitCode === 'number' ? receipt.exitCode : null;
    const complete = receipt.output?.complete === true;
    const ok = receipt.check === checkName && exitCode === 0 && complete;
    results.push({
      check: checkName,
      status: ok ? 'passed' : 'failed',
      ok,
      exitCode,
      complete,
      kit: typeof receipt.kit === 'string' ? receipt.kit : null,
      stdoutSha256: receipt.output?.stdout?.sha256 ?? null,
      stderrSha256: receipt.output?.stderr?.sha256 ?? null,
    });
  }
  return results;
}

export function buildWitnessedReceipt(validatedEnvelope, { declaredKitCheckResults, repoCommandResults, verifiedAt = new Date().toISOString() }) {
  const ok = declaredKitCheckResults.every(r => r.ok) && repoCommandResults.every(r => r.ok);
  const body = {
    format: WITNESSED_RECEIPT_FORMAT,
    envelopeId: validatedEnvelope.envelopeId,
    subjectLabel: validatedEnvelope.subjectLabel,
    subjectSha256: validatedEnvelope.subjectSha256,
    ok,
    verifiedAt,
    declaredKitChecks: declaredKitCheckResults,
    repoVerificationCommands: repoCommandResults,
  };
  return {
    ...body,
    receiptSha256: sha256Prefixed(JSON.stringify(body)),
  };
}

function writeFileAtomic(targetPath, content) {
  const resolved = resolve(targetPath);
  const parent = dirname(resolved);
  mkdirSync(parent, { recursive: true });
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new PuntError(`refusing to write through symlink: ${resolved}`, 'IA-PUNT-UNSAFE-PATH');
  }
  const tempPath = join(parent, `.punt-receipt.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, resolved);
  } catch (error) {
    try { rmSync(tempPath, { force: true }); } catch { /* ignore cleanup error */ }
    throw error;
  }
}

export function verifyPuntEnvelope(envelope, options = {}) {
  const validated = validatePublicPuntEnvelope(envelope);
  const rootDir = resolve(options.root ?? process.cwd());
  const rawReceipts = options.receiptsFile ? readJsonFile(options.receiptsFile, '--receipts') : (options.receipts ?? null);
  const repoCommandResults = runRepoVerificationCommands(validated.repoVerificationCommands, rootDir);
  const declaredKitCheckResults = verifyDeclaredKitChecks(validated.declaredKitChecks, {
    receipts: rawReceipts,
    runKitChecks: Boolean(options.runKitChecks),
    rootDir,
    cli: options.cli ?? null,
    project: options.project ?? null,
    task: options.task ?? null,
  });
  const receipt = buildWitnessedReceipt(validated, { declaredKitCheckResults, repoCommandResults });
  if (options.out) {
    writeFileAtomic(options.out, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
}

const SPEC = {
  envelope: 'value',
  root: 'value',
  project: 'value',
  task: 'value',
  run: 'value',
  pin: 'flag',
  'no-pin': 'flag',
  rebind: 'flag',
  cli: 'value',
  receipts: 'value',
  out: 'value',
  'run-kit-checks': 'flag',
};

async function main() {
  const { options, rest } = parseArgs(process.argv.slice(2), SPEC, { positionals: 1 });
  const command = rest[0];
  if (!command || !['validate', 'resolve', 'verify'].includes(command)) {
    throw new UsageError('punt.mjs needs a subcommand: validate, resolve or verify');
  }
  if (!options.envelope) {
    throw new UsageError(`punt.mjs ${command} needs --envelope <file>`);
  }
  const rawEnvelope = readJsonFile(options.envelope, '--envelope');

  if (command === 'validate') {
    const validated = validatePublicPuntEnvelope(rawEnvelope);
    printJson({
      ok: true,
      format: validated.format,
      envelopeId: validated.envelopeId,
      entry: validated.entry,
      activity: validated.activity,
      subjectLabel: validated.subjectLabel,
      subjectSha256: validated.subjectSha256,
      fallbackUnbound: validated.fallbackUnbound,
      declaredKitChecks: validated.declaredKitChecks,
      repoVerificationCommandCount: validated.repoVerificationCommands.length,
    });
    return;
  }

  if (command === 'resolve') {
    const result = resolvePuntEnvelope(rawEnvelope, options);
    printJson(result);
    return;
  }

  if (command === 'verify') {
    const receipt = verifyPuntEnvelope(rawEnvelope, {
      root: options.root,
      receiptsFile: options.receipts,
      out: options.out,
      runKitChecks: Boolean(options['run-kit-checks']),
      cli: options.cli,
      project: options.project,
      task: options.task,
    });
    printJson(receipt);
    process.exit(receipt.ok ? 0 : 3);
  }
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    await main();
  } catch (error) {
    process.exit(refuse(error));
  }
}
