#!/usr/bin/env node
// Apache-2.0
// Public-kit punt envelope validator, resolver and verifier.
//   node scripts/punt.mjs validate --envelope <file>
//   node scripts/punt.mjs resolve  --envelope <file> [--root <repo>] [--project <p> --task <t> [--run <r>]] [--pin|--no-pin] [--rebind] [--cli <main.js>]
//   node scripts/punt.mjs verify   --envelope <file> [--root <repo>] [--receipts <file>] [--out <file>] [--execute-repo-commands] [--run-kit-checks] [--cli <main.js>] [--project <p> --task <t>]
//
// Validates PublicPuntEnvelopeV1 payloads against the allowlist of public kit
// ids, enforces single-hash subjectSha256 parity with subjectLabel, resolves
// through scripts/resolve.mjs with fallbackUnbound to
// inventarch/ia-method-kit#method-operate on IA-CORE-NO-WORKSPACE only,
// previews (or with --execute-repo-commands executes) shell-free
// repoVerificationCommands under an allowlisted environment, verifies
// declaredKitChecks receipts and emits WitnessedPuntReceiptV1 JSON.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWindowsPackageManager } from './lib/cli.mjs';
import { childEnv, runChild } from './lib/hygiene.mjs';
import { parseArgs, printJson, refuse, UsageError } from './lib/workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVE_SCRIPT = join(HERE, 'resolve.mjs');
const CHECK_SCRIPT = join(HERE, 'check.mjs');

export const PUBLIC_PUNT_FORMAT = 'inventarch.public-punt-envelope/1';
export const WITNESSED_RECEIPT_FORMAT = 'inventarch.witnessed-punt-receipt/1';

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

const LANES = new Set(['ia:work', 'ia:delivery', 'ia:knowledge']);
const ROUTING_MODES = new Set(['punt-local', 'punt-desk', 'punt-ide', 'punt-claude-sub', 'punt-codex']);
const CHECK_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const CANDIDATE_KIT_PATTERN = /\b(?:inventarch\/[a-z0-9._-]+|ia-[a-z0-9._-]+)\b/gi;
const URL_PATTERN = /(?:https?:\/\/|git@)[^\s"'`<>()]+/gi;
const FALLBACK_ERROR_CODES = new Set(['IA-CORE-NO-WORKSPACE']);
const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
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

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function sha256Prefixed(text) {
  return `sha256:${sha256Hex(text)}`;
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
  const trimmed = kitId.trim();
  if (!PUBLIC_KIT_IDS.has(trimmed)) {
    throw new PuntError(`${fieldName} does not reference an allowlisted public kit`, 'IA-PUNT-CUSTODY-LEAK');
  }
  return trimmed;
}

function assertRelativeSubpath(subpath, fieldName) {
  if (typeof subpath !== 'string' || !subpath.trim()) {
    throw new PuntError(`${fieldName} must be a non-empty relative path`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (isAbsolute(subpath) || /^[a-zA-Z]:[\\/]/.test(subpath) || subpath.includes('\\')) {
    throw new PuntError(`${fieldName} must be a relative POSIX path`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  const segments = subpath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new PuntError(`${fieldName} must not contain traversal segments`, 'IA-PUNT-INVALID-ENVELOPE');
  }
}

function isRestrictedKitCandidate(candidate) {
  const lower = candidate.toLowerCase();
  if (lower.endsWith('.git') || lower === 'ia-apps' || lower === 'inventarch/ia-apps') return false;
  const normalized = lower.includes('/') ? lower : `inventarch/${lower}`;
  const withKitSuffix = normalized.endsWith('-kit') ? normalized : `${normalized}-kit`;
  return !PUBLIC_KIT_IDS.has(normalized) && !PUBLIC_KIT_IDS.has(withKitSuffix);
}

function scanStringsForCustodyLeaks(value) {
  if (typeof value === 'string') {
    const scrubbed = value.replace(URL_PATTERN, ' ');
    for (const match of scrubbed.matchAll(CANDIDATE_KIT_PATTERN)) {
      if (isRestrictedKitCandidate(match[0])) {
        throw new PuntError('envelope references a non-public kit identifier', 'IA-PUNT-CUSTODY-LEAK');
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanStringsForCustodyLeaks(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) scanStringsForCustodyLeaks(entry);
  }
}

function normalizeVerificationCommand(item, index) {
  if (!isPlainObject(item)) {
    throw new PuntError(`repoVerificationCommands[${index}] must be an object`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : '';
  if (!id) {
    throw new PuntError(`repoVerificationCommands[${index}].id must be a non-empty string`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (!Array.isArray(item.argv) || !item.argv.length || !item.argv.every((a) => typeof a === 'string' && a.length > 0)) {
    throw new PuntError(`repoVerificationCommands[${index}].argv must be a non-empty string array`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  const bin = item.argv[0].split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (SHELL_BINARIES.has(bin)) {
    throw new PuntError(`repoVerificationCommands[${index}] must not invoke a shell binary`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (item.cwd !== undefined && item.cwd !== null) {
    assertRelativeSubpath(item.cwd, `repoVerificationCommands[${index}].cwd`);
  }
  let timeoutSeconds = DEFAULT_CMD_TIMEOUT_SECONDS;
  if (item.timeoutSeconds !== undefined) {
    if (!Number.isInteger(item.timeoutSeconds) || item.timeoutSeconds < 5 || item.timeoutSeconds > MAX_CMD_TIMEOUT_SECONDS) {
      throw new PuntError(`repoVerificationCommands[${index}].timeoutSeconds must be between 5 and ${MAX_CMD_TIMEOUT_SECONDS}`, 'IA-PUNT-INVALID-ENVELOPE');
    }
    timeoutSeconds = item.timeoutSeconds;
  }
  return { id, argv: [...item.argv], cwd: item.cwd ?? null, timeoutSeconds };
}

export function validatePublicPuntEnvelope(raw) {
  if (!isPlainObject(raw)) {
    throw new PuntError('PublicPuntEnvelopeV1 must be a JSON object', 'IA-PUNT-INVALID-ENVELOPE');
  }
  scanStringsForCustodyLeaks(raw);
  if (raw.schema !== PUBLIC_PUNT_FORMAT) {
    throw new PuntError(`envelope.schema must be "${PUBLIC_PUNT_FORMAT}"`, 'IA-PUNT-INVALID-ENVELOPE');
  }
  for (const field of ['assignmentId', 'attemptId', 'leaseExpiresAt', 'instructionsMarkdown', 'contentDigest']) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) {
      throw new PuntError(`envelope.${field} must be a non-empty string`, 'IA-PUNT-INVALID-ENVELOPE');
    }
  }
  if (!Number.isInteger(raw.fence) || raw.fence <= 0) {
    throw new PuntError('envelope.fence must be a positive integer', 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (!Number.isInteger(raw.heartbeatSeconds) || raw.heartbeatSeconds < 5 || raw.heartbeatSeconds > 300) {
    throw new PuntError('envelope.heartbeatSeconds must be an integer between 5 and 300', 'IA-PUNT-INVALID-ENVELOPE');
  }

  if (!isPlainObject(raw.run) || typeof raw.run.runId !== 'string' || !raw.run.runId.trim() || typeof raw.run.checkpointId !== 'string' || !raw.run.checkpointId.trim()) {
    throw new PuntError('envelope.run requires non-empty runId and checkpointId', 'IA-PUNT-INVALID-ENVELOPE');
  }

  if (!isPlainObject(raw.routing) || !ROUTING_MODES.has(raw.routing.mode) || !LANES.has(raw.routing.lane) || typeof raw.routing.activityKey !== 'string' || !raw.routing.activityKey.trim()) {
    throw new PuntError('envelope.routing requires valid mode, lane, and activityKey', 'IA-PUNT-INVALID-ENVELOPE');
  }
  if (raw.routing.workerRole && raw.routing.reviewerRole && raw.routing.workerRole.trim().toLowerCase() === raw.routing.reviewerRole.trim().toLowerCase()) {
    throw new PuntError('envelope.routing reviewerRole must differ from workerRole', 'IA-PUNT-INVALID-ENVELOPE');
  }
  const entry = raw.routing.lane.slice(3);

  if (!isPlainObject(raw.publicMethod)) {
    throw new PuntError('envelope.publicMethod must be an object', 'IA-PUNT-INVALID-ENVELOPE');
  }
  const kit = assertPublicKitId(raw.publicMethod.kit, 'envelope.publicMethod.kit');
  if (typeof raw.publicMethod.capability !== 'string' || !raw.publicMethod.capability.trim()) {
    throw new PuntError('envelope.publicMethod.capability must be a non-empty string', 'IA-PUNT-INVALID-ENVELOPE');
  }
  const subjectLabel = raw.publicMethod.subjectLabel;
  if (typeof subjectLabel !== 'string' || !subjectLabel.trim()) {
    throw new PuntError('envelope.publicMethod.subjectLabel must be a non-empty string', 'IA-PUNT-INVALID-ENVELOPE');
  }
  const expectedSha = computeSubjectSha256(subjectLabel);
  if (raw.publicMethod.subjectSha256 !== expectedSha) {
    throw new PuntError('envelope.publicMethod.subjectSha256 does not match subjectLabel', 'IA-PUNT-SUBJECT-MISMATCH');
  }
  if (!isPlainObject(raw.publicMethod.fallbackUnbound)) {
    throw new PuntError('envelope.publicMethod.fallbackUnbound must be an object', 'IA-PUNT-INVALID-ENVELOPE');
  }
  const fallbackKit = assertPublicKitId(raw.publicMethod.fallbackUnbound.kit, 'envelope.publicMethod.fallbackUnbound.kit');
  if (typeof raw.publicMethod.fallbackUnbound.capability !== 'string' || !raw.publicMethod.fallbackUnbound.capability.trim()) {
    throw new PuntError('envelope.publicMethod.fallbackUnbound.capability must be a non-empty string', 'IA-PUNT-INVALID-ENVELOPE');
  }
  const fallbackUnbound = {
    kit: fallbackKit,
    capability: raw.publicMethod.fallbackUnbound.capability.trim(),
  };

  if (!isPlainObject(raw.repositoryTarget) || typeof raw.repositoryTarget.repositoryUrl !== 'string' || !raw.repositoryTarget.repositoryUrl.trim() || typeof raw.repositoryTarget.baseCommit !== 'string' || !Array.isArray(raw.repositoryTarget.writePaths)) {
    throw new PuntError('envelope.repositoryTarget requires repositoryUrl, baseCommit, and writePaths', 'IA-PUNT-INVALID-ENVELOPE');
  }
  for (let i = 0; i < raw.repositoryTarget.writePaths.length; i++) {
    assertRelativeSubpath(raw.repositoryTarget.writePaths[i], `envelope.repositoryTarget.writePaths[${i}]`);
  }

  const declaredKitChecks = [];
  if (raw.declaredKitChecks !== undefined) {
    if (!Array.isArray(raw.declaredKitChecks)) {
      throw new PuntError('envelope.declaredKitChecks must be an array', 'IA-PUNT-INVALID-ENVELOPE');
    }
    for (let i = 0; i < raw.declaredKitChecks.length; i++) {
      const item = raw.declaredKitChecks[i];
      if (!isPlainObject(item) || typeof item.check !== 'string' || !CHECK_NAME.test(item.check)) {
        throw new PuntError(`envelope.declaredKitChecks[${i}] must be { kit, check }`, 'IA-PUNT-INVALID-ENVELOPE');
      }
      const checkKit = assertPublicKitId(item.kit, `envelope.declaredKitChecks[${i}].kit`);
      declaredKitChecks.push({ kit: checkKit, check: item.check, required: item.required !== false });
    }
  }

  const repoVerificationCommands = [];
  if (raw.repoVerificationCommands !== undefined) {
    if (!Array.isArray(raw.repoVerificationCommands)) {
      throw new PuntError('envelope.repoVerificationCommands must be an array', 'IA-PUNT-INVALID-ENVELOPE');
    }
    for (let i = 0; i < raw.repoVerificationCommands.length; i++) {
      repoVerificationCommands.push(normalizeVerificationCommand(raw.repoVerificationCommands[i], i));
    }
  }

  if (!isPlainObject(raw.limits) || !Number.isInteger(raw.limits.maxDurationSeconds) || raw.limits.maxDurationSeconds <= 0) {
    throw new PuntError('envelope.limits.maxDurationSeconds must be a positive integer', 'IA-PUNT-INVALID-ENVELOPE');
  }

  return {
    schema: raw.schema,
    assignmentId: raw.assignmentId.trim(),
    attemptId: raw.attemptId.trim(),
    fence: raw.fence,
    leaseExpiresAt: raw.leaseExpiresAt.trim(),
    heartbeatSeconds: raw.heartbeatSeconds,
    run: { ...raw.run },
    routing: { ...raw.routing },
    entry,
    activity: raw.routing.activityKey.trim(),
    publicMethod: {
      kit,
      capability: raw.publicMethod.capability.trim(),
      subjectLabel,
      subjectSha256: expectedSha,
      fallbackUnbound,
    },
    repositoryTarget: { ...raw.repositoryTarget },
    declaredKitChecks,
    repoVerificationCommands,
    instructionsMarkdown: raw.instructionsMarkdown,
    limits: { ...raw.limits },
    contentDigest: raw.contentDigest.trim(),
  };
}

function readJsonFile(filePath, label) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new UsageError(`${label} could not be read`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new UsageError(`${label} must be a regular non-symlink file`);
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    throw new PuntError(`${label} is not valid JSON`, 'IA-PUNT-INVALID-JSON');
  }
}

function assertSafeRepoCwd(rootDir, subCwd) {
  const canonicalRoot = realpathSync.native(resolve(rootDir));
  if (!subCwd) return canonicalRoot;
  assertRelativeSubpath(subCwd, 'cwd');
  let probe = canonicalRoot;
  for (const part of subCwd.split('/')) {
    probe = join(probe, part);
    let stat;
    try {
      stat = lstatSync(probe);
    } catch {
      throw new PuntError('repoVerificationCommand cwd does not exist', 'IA-PUNT-INVALID-ENVELOPE');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PuntError('repoVerificationCommand cwd must traverse real directories only', 'IA-PUNT-UNSAFE-PATH');
    }
  }
  const canonicalCwd = realpathSync.native(probe);
  const rel = relative(canonicalRoot, canonicalCwd);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PuntError('repoVerificationCommand cwd escapes repository root', 'IA-PUNT-UNSAFE-PATH');
  }
  return canonicalCwd;
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
    throw new PuntError('resolve failed to start', 'IA-PUNT-RESOLVE-FAILED');
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

function verifyResolvedMethodMatch(packet, expected) {
  const resolvedKit = packet?.closure?.kit;
  if (typeof resolvedKit === 'string' && resolvedKit !== expected.kit) {
    throw new PuntError(`resolved kit "${resolvedKit}" does not match expected "${expected.kit}"`, 'IA-PUNT-KIT-MISMATCH');
  }
  const resolvedCap = packet?.closure?.capability ?? packet?.scope?.capability;
  if (typeof resolvedCap === 'string' && resolvedCap !== expected.capability) {
    throw new PuntError(`resolved capability "${resolvedCap}" does not match expected "${expected.capability}"`, 'IA-PUNT-CAPABILITY-MISMATCH');
  }
}

export function resolvePuntEnvelope(envelope, options = {}) {
  const validated = validatePublicPuntEnvelope(envelope);
  const rootDir = resolve(options.root ?? process.cwd());
  const env = childEnv(process.env);

  const baseArgs = [
    '--entry', validated.entry,
    '--activity', validated.activity,
    '--subject', validated.publicMethod.subjectSha256,
    '--root', rootDir,
  ];
  if (options.project) baseArgs.push('--project', options.project);
  if (options.task) baseArgs.push('--task', options.task);
  if (options.run) baseArgs.push('--run', options.run);
  if (options.pin) baseArgs.push('--pin');
  if (options['no-pin']) baseArgs.push('--no-pin');
  if (options.rebind) baseArgs.push('--rebind');
  if (options.cli) baseArgs.push('--cli', options.cli);

  const primary = invokeResolve(baseArgs, env);
  if (primary.status === 0 && primary.parsed) {
    verifyResolvedMethodMatch(primary.parsed, validated.publicMethod);
    return {
      ok: true,
      mode: 'bound',
      assignmentId: validated.assignmentId,
      subjectLabel: validated.publicMethod.subjectLabel,
      subjectSha256: validated.publicMethod.subjectSha256,
      packet: primary.parsed,
    };
  }

  const errorCode = primary.parsed?.error?.code ?? null;
  if (!FALLBACK_ERROR_CODES.has(errorCode)) {
    const message = primary.parsed?.error?.message ?? 'resolve failed cleanly';
    throw new PuntError(message, errorCode ?? 'IA-PUNT-RESOLVE-FAILED');
  }

  const scratchRoot = mkdtempSync(join(tmpdir(), 'ia-punt-unbound-'));
  try {
    const fallbackArgs = [
      '--entry', validated.entry,
      '--activity', validated.activity,
      '--subject', validated.publicMethod.subjectSha256,
      '--root', scratchRoot,
      '--kit', validated.publicMethod.fallbackUnbound.kit,
      '--capability', validated.publicMethod.fallbackUnbound.capability,
    ];
    if (options.cli) fallbackArgs.push('--cli', options.cli);

    const fallback = invokeResolve(fallbackArgs, env);
    if (fallback.status !== 0 || !fallback.parsed) {
      const message = fallback.parsed?.error?.message ?? 'fallbackUnbound resolve failed';
      throw new PuntError(`fallbackUnbound failed: ${message}`, fallback.parsed?.error?.code ?? 'IA-PUNT-FALLBACK-FAILED');
    }
    verifyResolvedMethodMatch(fallback.parsed, validated.publicMethod.fallbackUnbound);
    return {
      ok: true,
      mode: 'fallback-unbound',
      fallbackReason: errorCode,
      fallback: validated.publicMethod.fallbackUnbound,
      assignmentId: validated.assignmentId,
      subjectLabel: validated.publicMethod.subjectLabel,
      subjectSha256: validated.publicMethod.subjectSha256,
      packet: fallback.parsed,
    };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

export async function runRepoVerificationCommands(commands, rootDir, { execute = false } = {}) {
  const canonicalRoot = realpathSync.native(resolve(rootDir));
  const env = childEnv(process.env);
  const results = [];

  for (const cmd of commands) {
    if (!execute) {
      results.push({
        id: cmd.id,
        passed: false,
        exitCode: 1,
        previewed: true,
        logDigest: sha256Hex('preview-not-executed'),
      });
      continue;
    }
    const targetCwd = assertSafeRepoCwd(canonicalRoot, cmd.cwd);
    const resolvedArgv = resolveWindowsPackageManager(cmd.argv, { platform: process.platform, env, execPath: process.execPath });
    const started = Date.now();
    const ran = await runChild({
      argv: resolvedArgv,
      cwd: targetCwd,
      env,
      timeoutMs: cmd.timeoutSeconds * 1000,
    });
    const durationMs = Date.now() - started;
    const exitCode = typeof ran.status === 'number' ? ran.status : ran.timedOut ? 124 : 1;
    const passed = exitCode === 0 && !ran.timedOut && !ran.error;
    results.push({
      id: cmd.id,
      passed,
      exitCode,
      previewed: false,
      durationMs,
      logDigest: sha256Hex(`${ran.stdout}\n${ran.stderr}`),
    });
  }
  return results;
}

function indexReceipts(rawReceipts) {
  const byKey = new Map();
  const byCheck = new Map();
  if (Array.isArray(rawReceipts)) {
    for (const item of rawReceipts) {
      if (isPlainObject(item) && typeof item.check === 'string') {
        if (typeof item.kit === 'string') byKey.set(`${item.kit}#${item.check}`, item);
        byCheck.set(item.check, item);
      }
    }
    return { byKey, byCheck };
  }
  if (isPlainObject(rawReceipts) && Array.isArray(rawReceipts.checks)) {
    return indexReceipts(rawReceipts.checks);
  }
  return { byKey, byCheck };
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
  const { byKey, byCheck } = receipts ? indexReceipts(receipts) : { byKey: new Map(), byCheck: new Map() };
  const results = [];

  for (const decl of declaredKitChecks) {
    let receipt = byKey.get(`${decl.kit}#${decl.check}`) ?? byCheck.get(decl.check) ?? null;
    let imported = Boolean(receipt);
    if (!receipt && runKitChecks) {
      const ran = runDeclaredKitCheck(decl.check, rootDir, { cli, project, task });
      receipt = ran.parsed;
      imported = false;
    }
    if (!receipt || !isPlainObject(receipt)) {
      results.push({
        kit: decl.kit,
        check: decl.check,
        passed: false,
        exitCode: 3,
        complete: false,
        logDigest: sha256Hex('missing'),
        imported: false,
      });
      continue;
    }
    const exitCode = typeof receipt.exitCode === 'number' ? receipt.exitCode : 3;
    const complete = receipt.output?.complete === true || receipt.complete === true;
    const kitMatches = receipt.kit === decl.kit;
    const passed = receipt.check === decl.check && kitMatches && exitCode === 0 && complete;
    const logSeed = JSON.stringify({
      stdout: receipt.output?.stdout?.sha256 ?? receipt.stdoutSha256 ?? '',
      stderr: receipt.output?.stderr?.sha256 ?? receipt.stderrSha256 ?? '',
    });
    const rawLogDigest = typeof receipt.logDigest === 'string'
      ? receipt.logDigest.replace(/^sha256:/, '')
      : '';
    results.push({
      kit: decl.kit,
      check: decl.check,
      passed,
      exitCode,
      complete,
      logDigest: /^[a-f0-9]{64}$/.test(rawLogDigest)
        ? rawLogDigest
        : sha256Hex(logSeed),
      imported,
    });
  }
  return results;
}

export function buildWitnessedReceipt(
  validatedEnvelope,
  {
    declaredKitCheckResults,
    repoCommandResults,
    executor = {
      principalId: 'local-runner',
      sessionId: `exec-${randomUUID()}`,
      role: validatedEnvelope.routing.workerRole ?? 'worker',
      hostKind: 'antigravity',
    },
    checkerPrincipalId = 'punt-checker',
    checkerSessionId = `checker-${randomUUID()}`,
    extraWitnesses = [],
    git = undefined,
    completedAt = new Date().toISOString(),
  },
) {
  if (checkerPrincipalId === executor.principalId || checkerSessionId === executor.sessionId) {
    throw new PuntError('checker witness cannot share principalId or sessionId with executor', 'IA-PUNT-SELF-REVIEW-REFUSED');
  }

  const anyPreviewed = repoCommandResults.some((r) => r.previewed === true);
  const allRepoPassed = repoCommandResults.every((r) => r.passed);
  const allRequiredKitPassed = declaredKitCheckResults.every((r, idx) => {
    const decl = validatedEnvelope.declaredKitChecks[idx];
    return decl?.required === false ? true : r.passed;
  });
  const hasChecks = declaredKitCheckResults.length + repoCommandResults.length > 0;
  const passedAll = hasChecks && !anyPreviewed && allRepoPassed && allRequiredKitPassed;
  const status = anyPreviewed ? 'blocked' : passedAll ? 'succeeded' : 'failed';

  const wireKitChecks = declaredKitCheckResults.map(({ kit, check, passed, exitCode, complete, logDigest }) => ({
    kit,
    check,
    passed,
    exitCode,
    complete,
    logDigest,
  }));
  const wireRepoResults = repoCommandResults.map(({ id, passed, exitCode, logDigest, durationMs }) => ({
    id,
    passed,
    exitCode,
    logDigest,
    ...(durationMs !== undefined ? { durationMs } : {}),
  }));

  const checkerDigest = sha256Hex(JSON.stringify({ wireKitChecks, wireRepoResults }));
  const checkerWitness = {
    role: 'checker',
    principalId: checkerPrincipalId,
    sessionId: checkerSessionId,
    verdict: passedAll ? 'approved' : 'rejected',
    digest: checkerDigest,
    at: completedAt,
  };

  const body = {
    schema: WITNESSED_RECEIPT_FORMAT,
    assignmentId: validatedEnvelope.assignmentId,
    attemptId: validatedEnvelope.attemptId,
    fence: validatedEnvelope.fence,
    status,
    completedAt,
    executor,
    ...(git ? { git } : {}),
    declaredKitCheckResults: wireKitChecks,
    repoVerificationResults: wireRepoResults,
    witnesses: [checkerWitness, ...extraWitnesses],
    summary: anyPreviewed
      ? 'Repo commands previewed only (--execute-repo-commands not set); status blocked.'
      : `Verified ${wireRepoResults.length} repo command(s) and ${wireKitChecks.length} declared kit check(s): ${status}.`,
  };
  return {
    ...body,
    receiptDigest: sha256Hex(JSON.stringify(body)),
  };
}

function writeFileAtomic(targetPath, content) {
  const resolved = resolve(targetPath);
  const parent = dirname(resolved);
  mkdirSync(parent, { recursive: true });
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new PuntError('refusing to write through symlink', 'IA-PUNT-UNSAFE-PATH');
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

export async function verifyPuntEnvelope(envelope, options = {}) {
  const validated = validatePublicPuntEnvelope(envelope);
  const rootDir = resolve(options.root ?? process.cwd());
  const rawReceipts = options.receiptsFile ? readJsonFile(options.receiptsFile, '--receipts') : (options.receipts ?? null);
  const repoCommandResults = await runRepoVerificationCommands(validated.repoVerificationCommands, rootDir, {
    execute: Boolean(options.executeRepoCommands),
  });
  const declaredKitCheckResults = verifyDeclaredKitChecks(validated.declaredKitChecks, {
    receipts: rawReceipts,
    runKitChecks: Boolean(options.runKitChecks),
    rootDir,
    cli: options.cli ?? null,
    project: options.project ?? null,
    task: options.task ?? null,
  });
  const receipt = buildWitnessedReceipt(validated, {
    declaredKitCheckResults,
    repoCommandResults,
    ...(options.executor ? { executor: options.executor } : {}),
    ...(options.checkerPrincipalId ? { checkerPrincipalId: options.checkerPrincipalId } : {}),
    ...(options.checkerSessionId ? { checkerSessionId: options.checkerSessionId } : {}),
  });
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
  'execute-repo-commands': 'flag',
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
      schema: validated.schema,
      assignmentId: validated.assignmentId,
      attemptId: validated.attemptId,
      fence: validated.fence,
      entry: validated.entry,
      activity: validated.activity,
      publicMethod: validated.publicMethod,
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
    const receipt = await verifyPuntEnvelope(rawEnvelope, {
      root: options.root,
      receiptsFile: options.receipts,
      out: options.out,
      runKitChecks: Boolean(options['run-kit-checks']),
      executeRepoCommands: Boolean(options['execute-repo-commands']),
      cli: options.cli,
      project: options.project,
      task: options.task,
    });
    printJson(receipt);
    process.exit(receipt.status === 'succeeded' ? 0 : 3);
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
