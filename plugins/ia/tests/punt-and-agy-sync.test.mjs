// Tests for plugins/ia/scripts/punt.mjs and plugins/ia/scripts/agy-swarm-sync.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeSubjectSha256,
  DEFAULT_FALLBACK_UNBOUND,
  PUBLIC_PUNT_FORMAT,
  validatePublicPuntEnvelope,
  WITNESSED_RECEIPT_FORMAT,
} from '../scripts/punt.mjs';
import { validateSwarmPlan } from '../scripts/agy-swarm-sync.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const PUNT_SCRIPT = join(HERE, '..', 'scripts', 'punt.mjs');
const AGY_SYNC_SCRIPT = join(HERE, '..', 'scripts', 'agy-swarm-sync.mjs');
const IA_CLI = join(REPO_ROOT, 'node_modules', '@inventarch', 'cli', 'dist', 'main.js');

function runScript(script, args, { input = undefined, cwd = REPO_ROOT, env = process.env } = {}) {
  const ran = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    input,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  let json = null;
  if (ran.stdout && ran.stdout.trim()) {
    try {
      json = JSON.parse(ran.stdout);
    } catch {
      json = null;
    }
  }
  return { status: ran.status, json, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
}

function makeEnvelope(overrides = {}) {
  const subjectLabel = overrides.subjectLabel ?? 'task:demo-slice--01';
  return {
    format: PUBLIC_PUNT_FORMAT,
    envelopeId: 'env-001',
    entry: 'delivery',
    activity: 'change',
    subjectLabel,
    subjectSha256: `sha256:${createHash('sha256').update(subjectLabel, 'utf8').digest('hex')}`,
    fallbackUnbound: { ...DEFAULT_FALLBACK_UNBOUND },
    declaredKitChecks: [],
    repoVerificationCommands: [],
    ...overrides,
  };
}

test('punt.mjs validates PublicPuntEnvelopeV1 and enforces single-hash subjectSha256 parity', () => {
  const env = makeEnvelope({ subjectLabel: 'work:slice-alpha' });
  const validated = validatePublicPuntEnvelope(env);
  assert.equal(validated.subjectSha256, computeSubjectSha256('work:slice-alpha'));
  assert.equal(validated.fallbackUnbound.kit, 'inventarch/ia-method-kit');
  assert.equal(validated.fallbackUnbound.capability, 'method-operate');

  // Mismatched subjectSha256 must fail closed.
  const badHash = makeEnvelope({
    subjectLabel: 'work:slice-alpha',
    subjectSha256: `sha256:${'0'.repeat(64)}`,
  });
  assert.throws(() => validatePublicPuntEnvelope(badHash), err => err.code === 'IA-PUNT-SUBJECT-MISMATCH');
});

test('punt.mjs rejects non-public kit ids in fields and embedded text', () => {
  const badKitField = makeEnvelope({ kit: 'inventarch/ia-proprietary-example-kit' });
  assert.throws(() => validatePublicPuntEnvelope(badKitField), err => err.code === 'IA-PUNT-CUSTODY-LEAK');

  const badFallback = makeEnvelope({
    fallbackUnbound: { kit: 'inventarch/ia-private-example-kit', capability: 'operate' },
  });
  assert.throws(() => validatePublicPuntEnvelope(badFallback), err => err.code === 'IA-PUNT-CUSTODY-LEAK');

  const embeddedPrivateKit = makeEnvelope({
    notes: 'never leak inventarch/ia-secret-example-kit in public envelopes',
  });
  assert.throws(() => validatePublicPuntEnvelope(embeddedPrivateKit), err => err.code === 'IA-PUNT-CUSTODY-LEAK');
});

test('punt.mjs resolve falls back to fallbackUnbound on IA-CORE-NO-WORKSPACE and IA-CORE-NO-METHOD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-punt-resolve-'));
  try {
    const nonWorkspaceDir = join(dir, 'plain-repo');
    mkdirSync(nonWorkspaceDir, { recursive: true });

    const envelopePath = join(dir, 'envelope.json');
    const envelope = makeEnvelope({
      entry: 'delivery',
      activity: 'change',
      subjectLabel: 'slice:unbound-check',
    });
    writeFileSync(envelopePath, JSON.stringify(envelope, null, 2), 'utf8');

    const cliArgs = existsSync(IA_CLI) ? ['--cli', IA_CLI] : [];
    const res1 = runScript(PUNT_SCRIPT, ['resolve', '--envelope', envelopePath, '--root', nonWorkspaceDir, ...cliArgs]);
    assert.equal(res1.status, 0, `expected exit 0, got ${res1.status}: ${res1.stdout} ${res1.stderr}`);
    assert.equal(res1.json.ok, true);
    assert.equal(res1.json.mode, 'fallback-unbound');
    assert.equal(res1.json.fallbackReason, 'IA-CORE-NO-WORKSPACE');
    assert.equal(res1.json.subjectSha256, envelope.subjectSha256);
    assert.equal(res1.json.packet.scope.subject, envelope.subjectSha256);
    assert.equal(res1.json.packet.closure.kit, 'inventarch/ia-method-kit');

    // Also verify IA-CORE-NO-METHOD inside an IA workspace with no bindings.
    const unboundWorkspaceDir = join(dir, 'ia-repo-no-bindings');
    mkdirSync(join(unboundWorkspaceDir, '.ia', 'src'), { recursive: true });
    const res2 = runScript(PUNT_SCRIPT, ['resolve', '--envelope', envelopePath, '--root', unboundWorkspaceDir, ...cliArgs]);
    assert.equal(res2.status, 0, `expected exit 0, got ${res2.status}: ${res2.stdout} ${res2.stderr}`);
    assert.equal(res2.json.ok, true);
    assert.equal(res2.json.mode, 'fallback-unbound');
    assert.equal(res2.json.fallbackReason, 'IA-CORE-NO-METHOD');
    assert.equal(res2.json.packet.scope.subject, envelope.subjectSha256);
    assert.equal(res2.json.packet.closure.kit, 'inventarch/ia-method-kit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('punt.mjs verify runs shell-free repoVerificationCommands with sanitized env and checks declaredKitChecks receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-punt-verify-'));
  try {
    const repoDir = join(dir, 'repo');
    mkdirSync(repoDir, { recursive: true });

    const envelopePath = join(dir, 'envelope.json');
    const receiptsPath = join(dir, 'receipts.json');
    const outPath = join(dir, 'witnessed-receipt.json');

    // Command verifies that shell metacharacters are passed literally (no shell)
    // and that secret env vars are stripped by childEnv.
    const envelope = makeEnvelope({
      declaredKitChecks: ['check-example'],
      repoVerificationCommands: [
        {
          name: 'echo-literal',
          argv: [
            process.execPath,
            '-e',
            'const arg = process.argv[1]; if (arg !== "a&&b" || process.env.TEST_SECRET_TOKEN) process.exit(4); process.stdout.write("verified-ok");',
            'a&&b',
          ],
        },
      ],
    });
    writeFileSync(envelopePath, JSON.stringify(envelope, null, 2), 'utf8');
    writeFileSync(receiptsPath, JSON.stringify([
      {
        check: 'check-example',
        kit: 'inventarch/ia-method-kit',
        exitCode: 0,
        output: {
          complete: true,
          stdout: { sha256: 'sha256:abc' },
          stderr: { sha256: 'sha256:def' },
        },
      },
    ], null, 2), 'utf8');

    const envWithSecret = { ...process.env, TEST_SECRET_TOKEN: 'must-not-leak' };
    const ran = runScript(
      PUNT_SCRIPT,
      ['verify', '--envelope', envelopePath, '--root', repoDir, '--receipts', receiptsPath, '--out', outPath],
      { env: envWithSecret },
    );
    assert.equal(ran.status, 0, `expected exit 0, got ${ran.status}: ${ran.stdout} ${ran.stderr}`);
    assert.equal(ran.json.format, WITNESSED_RECEIPT_FORMAT);
    assert.equal(ran.json.ok, true);
    assert.equal(ran.json.subjectSha256, envelope.subjectSha256);
    assert.equal(ran.json.declaredKitChecks.length, 1);
    assert.equal(ran.json.declaredKitChecks[0].ok, true);
    assert.equal(ran.json.repoVerificationCommands.length, 1);
    assert.equal(ran.json.repoVerificationCommands[0].ok, true);
    assert.match(ran.json.receiptSha256, /^sha256:[a-f0-9]{64}$/);

    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.deepEqual(written, ran.json);

    // Missing declaredKitChecks receipt must fail closed (exit 3).
    const missingReceipts = runScript(PUNT_SCRIPT, ['verify', '--envelope', envelopePath, '--root', repoDir]);
    assert.equal(missingReceipts.status, 3);
    assert.equal(missingReceipts.json.ok, false);
    assert.equal(missingReceipts.json.declaredKitChecks[0].status, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agy-swarm-sync.mjs validates SwarmControlViewV1 and atomically writes plan.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-agy-sync-'));
  try {
    const swarmDir = join(dir, 'swarm-state');
    const planInputPath = join(dir, 'control-view.json');
    const controlView = {
      format: 'swarm-control-view-1',
      goal: {
        title: 'Ship public punt and sync helpers',
        line: 'Validate public envelopes and sync Antigravity swarm plan files.',
      },
      tasks: {
        'worker-a': 'Implement punt helper',
        'worker-b': 'Implement swarm sync',
      },
      threads: [
        {
          id: 't-public-bridge',
          title: 'Public host bridges',
          goal: 'Deliver verified public punt and swarm sync scripts.',
          tasks: ['worker-a', 'worker-b'],
        },
      ],
    };
    writeFileSync(planInputPath, JSON.stringify(controlView, null, 2), 'utf8');

    const ran = runScript(AGY_SYNC_SCRIPT, ['--swarm-dir', swarmDir, '--plan-json', planInputPath]);
    assert.equal(ran.status, 0, `expected exit 0, got ${ran.status}: ${ran.stdout} ${ran.stderr}`);
    assert.equal(ran.json.ok, true);
    assert.equal(ran.json.taskCount, 2);
    assert.equal(ran.json.threadCount, 1);

    const planPath = join(swarmDir, 'plan.json');
    assert.equal(existsSync(planPath), true);
    const written = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.deepEqual(written, {
      goal: controlView.goal,
      tasks: controlView.tasks,
      threads: controlView.threads,
    });

    // No stray .tmp files left behind.
    const entries = readdirSync(swarmDir);
    assert.deepEqual(entries, ['plan.json']);

    // Stdin mode also works.
    const stdinRun = runScript(AGY_SYNC_SCRIPT, ['--swarm-dir', swarmDir], {
      input: JSON.stringify({
        goal: {
          title: 'Verify stdin swarm plan sync path',
          line: 'Confirm atomic overwrite from stdin JSON payload.',
        },
        tasks: { 'worker-c': 'Verify stdin' },
        threads: [
          { id: 't-stdin', title: 'Stdin sync', goal: 'Overwrite plan cleanly.', tasks: ['worker-c'] },
        ],
      }),
    });
    assert.equal(stdinRun.status, 0);
    const overwritten = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(overwritten.goal.title, 'Verify stdin swarm plan sync path');

    // Refuses builtin/ directory paths.
    const builtinAttempt = runScript(AGY_SYNC_SCRIPT, ['--swarm-dir', join(dir, 'builtin', 'swarm'), '--plan-json', planInputPath]);
    assert.equal(builtinAttempt.status, 1);
    assert.equal(builtinAttempt.json.error.code, 'IA-SWARM-SYNC-BUILTIN-REFUSED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agy-swarm-sync.mjs enforces goal word bounds and thread count bounds', () => {
  const base = {
    goal: { title: 'Four word swarm title', line: 'Short valid summary line.' },
    tasks: { w1: 'Slice one' },
    threads: [{ id: 't-1', title: 'One', goal: 'Finish slice one.', tasks: ['w1'] }],
  };
  assert.ok(validateSwarmPlan(base));

  // Title too short (3 words).
  assert.throws(
    () => validateSwarmPlan({ ...base, goal: { ...base.goal, title: 'Too short title' } }),
    err => err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
  // Title too long (9 words).
  assert.throws(
    () => validateSwarmPlan({ ...base, goal: { ...base.goal, title: 'One two three four five six seven eight nine' } }),
    err => err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
  // Line too long (13 words).
  assert.throws(
    () => validateSwarmPlan({ ...base, goal: { ...base.goal, line: 'one two three four five six seven eight nine ten eleven twelve thirteen' } }),
    err => err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
  // Zero threads.
  assert.throws(
    () => validateSwarmPlan({ ...base, threads: [] }),
    err => err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
  // Seven threads (> 6).
  assert.throws(
    () => validateSwarmPlan({
      ...base,
      threads: Array.from({ length: 7 }, (_, i) => ({ id: `t-${i}`, title: `T${i}`, goal: 'Goal.', tasks: ['w1'] })),
    }),
    err => err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
});
